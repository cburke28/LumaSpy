const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');

// List tracked brands for a subscriber
router.get('/', async (req, res) => {
  const { subscriber_id } = req.query;
  if (!subscriber_id) return res.status(400).json({ error: 'subscriber_id required' });

  const { data, error } = await supabase
    .from('tracked_brands')
    .select('*')
    .eq('subscriber_id', subscriber_id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ brands: data });
});

// Add a brand to track
router.post('/', async (req, res) => {
  const { subscriber_id, brand_name, facebook_page_name, industry } = req.body;
  if (!subscriber_id || !brand_name || !facebook_page_name) {
    return res.status(400).json({ error: 'subscriber_id, brand_name, and facebook_page_name required' });
  }

  // Enforce free plan limit (1 brand)
  const { data: sub } = await supabase
    .from('subscribers')
    .select('plan')
    .eq('id', subscriber_id)
    .single();

  if (sub?.plan === 'free') {
    const { count } = await supabase
      .from('tracked_brands')
      .select('id', { count: 'exact', head: true })
      .eq('subscriber_id', subscriber_id);

    if (count >= 1) {
      return res.status(403).json({
        error: 'Free plan limited to 1 brand. Upgrade to Pro for unlimited brands.',
        upgrade: true
      });
    }
  }

  const { data, error } = await supabase
    .from('tracked_brands')
    .insert({ subscriber_id, brand_name, facebook_page_name, industry: industry || 'beauty' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ brand: data });
});

// Delete a tracked brand
router.delete('/:id', async (req, res) => {
  const { subscriber_id } = req.body;
  const { error } = await supabase
    .from('tracked_brands')
    .delete()
    .eq('id', req.params.id)
    .eq('subscriber_id', subscriber_id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
