const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { scrapeAds } = require('../services/apify');
const { analyzeAd, generateCopyVariants } = require('../services/claude');

// Get ads for a subscriber (optionally filtered by brand)
router.get('/', async (req, res) => {
  const { subscriber_id, brand_id, limit = 50 } = req.query;
  if (!subscriber_id) return res.status(400).json({ error: 'subscriber_id required' });

  // Check free plan limits
  const { data: sub } = await supabase
    .from('subscribers')
    .select('plan')
    .eq('id', subscriber_id)
    .single();

  let query = supabase
    .from('ads')
    .select(`*, tracked_brands(brand_name, industry), ad_analysis(*)`)
    .eq('subscriber_id', subscriber_id)
    .order('first_seen', { ascending: false });

  if (brand_id) query = query.eq('brand_id', brand_id);

  if (sub?.plan === 'free') {
    query = query
      .gte('first_seen', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .limit(10);
  } else {
    query = query.limit(Number(limit));
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ads: data });
});

// Trigger a fresh scrape for a brand
router.post('/scrape', async (req, res) => {
  const { subscriber_id, brand_id } = req.body;
  if (!subscriber_id || !brand_id) {
    return res.status(400).json({ error: 'subscriber_id and brand_id required' });
  }

  const { data: brand } = await supabase
    .from('tracked_brands')
    .select('*')
    .eq('id', brand_id)
    .eq('subscriber_id', subscriber_id)
    .single();

  if (!brand) return res.status(404).json({ error: 'Brand not found' });

  res.json({ message: 'Scrape started', brand: brand.brand_name });

  // Run scrape async (don't block the response)
  runScrapeAndStore(brand, subscriber_id).catch(err => {
    console.error('Scrape failed:', err.message);
  });
});

async function runScrapeAndStore(brand, subscriber_id) {
  console.log(`[Store] Starting store for brand: ${brand.brand_name}`);
  const rawAds = await scrapeAds(brand.brand_name);
  console.log(`[Store] Got ${rawAds.length} ads to store`);

  let inserted = 0;
  let updated = 0;
  let errors = 0;

  for (const ad of rawAds) {
    const { data: existing } = await supabase
      .from('ads')
      .select('id')
      .eq('ad_id', ad.ad_id)
      .eq('brand_id', brand.id)
      .single();

    if (existing) {
      await supabase
        .from('ads')
        .update({ last_seen: new Date().toISOString(), still_active: true })
        .eq('id', existing.id);
      updated++;
      continue;
    }

    const { error } = await supabase.from('ads').insert({
      ...ad,
      brand_id: brand.id,
      subscriber_id
    });

    if (error) {
      console.error(`[Store] Insert error for ad ${ad.ad_id}:`, error.message);
      errors++;
    } else {
      inserted++;
    }
  }

  console.log(`[Store] Done — inserted: ${inserted}, updated: ${updated}, errors: ${errors}`);
}

// Get single ad with analysis
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('ads')
    .select(`*, tracked_brands(brand_name, industry), ad_analysis(*)`)
    .eq('id', req.params.id)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Ad not found' });
  res.json({ ad: data });
});

// Analyze an ad with Claude
router.post('/:id/analyze', async (req, res) => {
  const { subscriber_id } = req.body;

  const { data: sub } = await supabase
    .from('subscribers')
    .select('plan')
    .eq('id', subscriber_id)
    .single();

  if (sub?.plan !== 'pro') {
    return res.status(403).json({ error: 'AI analysis requires Pro plan', upgrade: true });
  }

  const { data: ad } = await supabase
    .from('ads')
    .select(`*, tracked_brands(brand_name, industry)`)
    .eq('id', req.params.id)
    .single();

  if (!ad) return res.status(404).json({ error: 'Ad not found' });

  // Check if already analyzed
  const { data: existing } = await supabase
    .from('ad_analysis')
    .select('*')
    .eq('ad_id', ad.id)
    .single();

  if (existing) return res.json({ analysis: existing });

  const result = await analyzeAd(
    ad.ad_text,
    ad.image_url,
    ad.tracked_brands?.brand_name,
    ad.tracked_brands?.industry
  );

  const { data: analysis, error } = await supabase
    .from('ad_analysis')
    .insert({
      ad_id: ad.id,
      hook_type: result.hook_type,
      creative_strategy: result.creative_strategy,
      key_messages: result.key_messages,
      competitive_score: result.competitive_score,
      why_it_works: result.why_it_works,
      generated_copy_1: result.generated_copy_1,
      generated_copy_2: result.generated_copy_2,
      generated_copy_3: result.generated_copy_3,
      analyzed_at: new Date().toISOString()
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ analysis });
});

// Generate copy variants
router.post('/:id/generate', async (req, res) => {
  const { subscriber_id, brand_voice } = req.body;

  const { data: sub } = await supabase
    .from('subscribers')
    .select('plan')
    .eq('id', subscriber_id)
    .single();

  if (sub?.plan !== 'pro') {
    return res.status(403).json({ error: 'Copy generation requires Pro plan', upgrade: true });
  }

  const { data: ad } = await supabase
    .from('ads')
    .select('ad_text')
    .eq('id', req.params.id)
    .single();

  if (!ad) return res.status(404).json({ error: 'Ad not found' });

  const result = await generateCopyVariants(ad.ad_text, brand_voice);
  res.json({ variants: result.variants });
});

module.exports = router;
