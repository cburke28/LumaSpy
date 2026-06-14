const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const supabase = require('../services/supabase');
const { sendWelcomeEmail } = require('../services/resend');

// Stripe webhook — must use raw body
router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const email = session.customer_details?.email;
      const customerId = session.customer;
      const subscriptionId = session.subscription;

      if (email) {
        const { data: sub } = await supabase
          .from('subscribers')
          .select('id')
          .eq('email', email.toLowerCase())
          .single();

        if (sub) {
          await supabase
            .from('subscribers')
            .update({
              stripe_customer_id: customerId,
              stripe_subscription_id: subscriptionId,
              plan: 'pro',
              status: 'active'
            })
            .eq('id', sub.id);
        } else {
          await supabase.from('subscribers').insert({
            email: email.toLowerCase(),
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            plan: 'pro',
            status: 'active'
          });
        }
        try { await sendWelcomeEmail(email, 'pro'); } catch (_) {}
      }
      break;
    }

    case 'customer.subscription.deleted':
    case 'customer.subscription.paused': {
      const sub = event.data.object;
      await supabase
        .from('subscribers')
        .update({ plan: 'free', status: 'cancelled' })
        .eq('stripe_subscription_id', sub.id);
      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const isActive = sub.status === 'active' || sub.status === 'trialing';
      await supabase
        .from('subscribers')
        .update({ status: isActive ? 'active' : 'cancelled' })
        .eq('stripe_subscription_id', sub.id);
      break;
    }
  }

  res.json({ received: true });
});

module.exports = router;
