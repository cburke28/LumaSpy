require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const brandsRoutes = require('./routes/brands');
const adsRoutes = require('./routes/ads');
const webhooksRoutes = require('./routes/webhooks');
const { sendWeeklyDigest } = require('./services/resend');
const supabase = require('./services/supabase');

const app = express();
const PORT = process.env.PORT || 3000;

// Stripe webhooks need raw body — mount BEFORE json middleware
app.use('/webhooks', webhooksRoutes);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, validate: { xForwardedForHeader: false } });
app.use('/api', apiLimiter);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/brands', brandsRoutes);
app.use('/api/ads', adsRoutes);

// Stripe checkout session creation
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
app.post('/api/create-checkout', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    mode: 'subscription',
    customer_email: email,
    line_items: [{ price: process.env.STRIPE_PRO_PRICE_ID, quantity: 1 }],
    subscription_data: { trial_period_days: 7 },
    success_url: `${process.env.APP_URL}/dashboard.html?upgraded=true`,
    cancel_url: `${process.env.APP_URL}/?cancelled=true`
  });

  res.json({ url: session.url });
});

// Manual trigger: send weekly digests to all pro subscribers
app.post('/api/admin/send-digests', async (req, res) => {
  const { secret } = req.body;
  if (secret !== process.env.SESSION_SECRET) return res.status(403).json({ error: 'Forbidden' });

  const { data: proSubs } = await supabase
    .from('subscribers')
    .select('*')
    .eq('plan', 'pro')
    .eq('status', 'active');

  let sent = 0;
  for (const sub of proSubs || []) {
    const { data: topAds } = await supabase
      .from('ads')
      .select('*, tracked_brands(brand_name), ad_analysis(*)')
      .eq('subscriber_id', sub.id)
      .order('first_seen', { ascending: false })
      .limit(5);

    if (topAds?.length) {
      try { await sendWeeklyDigest(sub, topAds); sent++; } catch (_) {}
    }
  }

  res.json({ sent });
});

// Health check
app.get('/api/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// Keepalive — ping self every 10 minutes to prevent Render free tier spindown
if (process.env.APP_URL && process.env.NODE_ENV === 'production') {
  const axios = require('axios');
  setInterval(() => {
    axios.get(`${process.env.APP_URL}/api/health`).catch(() => {});
  }, 10 * 60 * 1000);
}

// SPA fallback — serve dashboard for direct nav
app.get('/dashboard', (_, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

app.listen(PORT, () => {
  console.log(`LumaSpy running at http://localhost:${PORT}`);
});
