const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { sendWelcomeEmail } = require('../services/resend');

// Register / create free account
router.post('/register', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    console.log('Register attempt for:', email);

    const { data: existing, error: lookupError } = await supabase
      .from('subscribers')
      .select('id, email, plan, status')
      .eq('email', email.toLowerCase().trim())
      .single();

    console.log('Lookup result:', { existing, lookupError: lookupError?.message });

    if (existing) {
      return res.json({ subscriber: existing, isNew: false });
    }

    const { data, error } = await supabase
      .from('subscribers')
      .insert({ email: email.toLowerCase().trim(), plan: 'free', status: 'active' })
      .select()
      .single();

    console.log('Insert result:', { data, error: error?.message });

    if (error) return res.status(500).json({ error: error.message });

    try { await sendWelcomeEmail(data.email, 'free'); } catch (_) {}

    res.json({ subscriber: data, isNew: true });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get subscriber by email (login / lookup)
router.post('/login', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const { data, error } = await supabase
    .from('subscribers')
    .select('id, email, plan, status, created_at')
    .eq('email', email.toLowerCase().trim())
    .single();

  if (error || !data) return res.status(404).json({ error: 'Account not found' });
  res.json({ subscriber: data });
});

// Get subscriber by ID
router.get('/me/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('subscribers')
    .select('id, email, plan, status, created_at')
    .eq('id', req.params.id)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json({ subscriber: data });
});

module.exports = router;
