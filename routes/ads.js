const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { startScrape, fetchResults } = require('../services/apify');
const { analyzeAd, generateCopyVariants } = require('../services/claude');

// Get ads for a subscriber (optionally filtered by brand)
router.get('/', async (req, res) => {
  const { subscriber_id, brand_id, limit = 50 } = req.query;
  if (!subscriber_id) return res.status(400).json({ error: 'subscriber_id required' });

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
      .limit(5);
  } else {
    query = query.limit(Number(limit));
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ads: data });
});

// Step 1: Start a scrape and return the run ID immediately
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

  console.log(`[Scrape] Starting scrape for ${brand.brand_name}`);
  const { runId, datasetId } = await startScrape(brand.brand_name);
  console.log(`[Scrape] Run started: ${runId}`);

  // Save run info to brand so we can poll it later
  await supabase
    .from('tracked_brands')
    .update({ last_scrape_run_id: runId, last_scrape_dataset_id: datasetId })
    .eq('id', brand_id);

  // Return apifyToken so browser can poll Apify directly (avoids Render spindown)
  res.json({
    message: 'Scrape started',
    runId,
    datasetId,
    apifyToken: process.env.APIFY_API_TOKEN,
    brand: brand.brand_name
  });
});

// Debug: save from an existing completed dataset (no new scrape)
router.post('/scrape/debug', async (req, res) => {
  const { subscriber_id, brand_id, email, brand_name, dataset_id } = req.body;
  if (!dataset_id) return res.status(400).json({ error: 'dataset_id required' });

  let brand, resolvedSubscriberId;

  if (email && brand_name) {
    const { data: sub } = await supabase.from('subscribers').select('id').eq('email', email).single();
    if (!sub) return res.status(404).json({ error: 'Subscriber not found for email: ' + email });
    resolvedSubscriberId = sub.id;
    const { data: b } = await supabase.from('tracked_brands').select('*')
      .eq('subscriber_id', sub.id).ilike('brand_name', brand_name).single();
    if (!b) return res.status(404).json({ error: 'Brand not found: ' + brand_name });
    brand = b;
  } else if (subscriber_id && brand_id) {
    resolvedSubscriberId = subscriber_id;
    const { data: b } = await supabase.from('tracked_brands').select('*')
      .eq('id', brand_id).eq('subscriber_id', subscriber_id).single();
    if (!b) return res.status(404).json({ error: 'Brand not found' });
    brand = b;
  } else {
    return res.status(400).json({ error: 'Provide either (email + brand_name) or (subscriber_id + brand_id)' });
  }

  const axios = require('axios');
  const TOKEN = process.env.APIFY_API_TOKEN;
  const itemsRes = await axios.get(
    `https://api.apify.com/v2/datasets/${dataset_id}/items?token=${TOKEN}&format=json&limit=50`
  );
  const rawItems = itemsRes.data || [];
  console.log(`[Debug] Fetched ${rawItems.length} raw items from dataset ${dataset_id}`);
  console.log(`[Debug] Sample item keys:`, rawItems[0] ? Object.keys(rawItems[0]) : 'none');
  if (rawItems[0]?.creatives) console.log(`[Debug] Sample creative keys:`, Object.keys(rawItems[0].creatives[0] || {}));

  const { fetchResults } = require('../services/apify');
  // manually normalize so we can see counts
  let inserted = 0, errors = 0;
  for (const item of rawItems) {
    const creatives = item.creatives?.length ? item.creatives : [{}];
    for (const creative of creatives) {
      const ad_id = `${item.adArchiveId}_${creative.cardIndex ?? 0}`;
      const { data: existing } = await supabase.from('ads').select('id').eq('ad_id', ad_id).eq('brand_id', brand.id).single();
      if (existing) continue;
      const { error } = await supabase.from('ads').insert({
        ad_id,
        ad_text: creative.body || creative.title || creative.description || creative.caption || '',
        image_url: creative.imageUrls?.[0] || null,
        video_url: creative.videoUrl || null,
        cta: creative.ctaText || null,
        link: creative.destinationUrl || item.snapshotUrl || null,
        days_running: item.daysRunning || 0,
        platform: (item.publisherPlatforms || ['facebook']).join(', '),
        first_seen: item.adDeliveryStartTime || new Date().toISOString(),
        last_seen: new Date().toISOString(),
        still_active: item.adActiveStatus === 'ACTIVE',
        brand_id: brand.id,
        subscriber_id: resolvedSubscriberId
      });
      if (error) { console.error('[Debug] Insert error:', error.message); errors++; }
      else inserted++;
    }
  }

  res.json({ raw_items: rawItems.length, inserted, errors, sample_keys: rawItems[0] ? Object.keys(rawItems[0]) : [] });
});

// Step 2: Poll run status and store results when done
router.post('/scrape/complete', async (req, res) => {
  const { subscriber_id, brand_id, run_id, dataset_id } = req.body;
  if (!subscriber_id || !brand_id || !run_id || !dataset_id) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const { data: brand } = await supabase
    .from('tracked_brands')
    .select('*')
    .eq('id', brand_id)
    .eq('subscriber_id', subscriber_id)
    .single();

  if (!brand) return res.status(404).json({ error: 'Brand not found' });

  const { status, ads } = await fetchResults(run_id, dataset_id);
  console.log(`[Complete] Run ${run_id} status: ${status}, ads: ${ads.length}`);

  if (status !== 'SUCCEEDED') {
    return res.json({ status, stored: 0 });
  }

  let inserted = 0;
  let errors = 0;

  for (const ad of ads) {
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
      continue;
    }

    const { error } = await supabase.from('ads').insert({
      ...ad,
      brand_id: brand.id,
      subscriber_id
    });

    if (error) {
      console.error(`[Complete] Insert error:`, error.message);
      errors++;
    } else {
      inserted++;
    }
  }

  console.log(`[Complete] Stored ${inserted} ads, ${errors} errors`);
  res.json({ status: 'SUCCEEDED', stored: inserted, errors });
});

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
