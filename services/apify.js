const axios = require('axios');
require('dotenv').config();

const APIFY_BASE = 'https://api.apify.com/v2';
const TOKEN = process.env.APIFY_API_TOKEN;
const ACTOR_ID = 'brilliant_gum~facebook-ads-library-scraper';

// Step 1: Start a scrape run and return IDs immediately (non-blocking)
async function startScrape(searchQuery, maxAds = 30) {
  console.log(`[Apify] Starting scrape for: "${searchQuery}"`);
  const runRes = await axios.post(
    `${APIFY_BASE}/acts/${ACTOR_ID}/runs?token=${TOKEN}`,
    {
      searchTerms: [searchQuery],
      countries: ['US'],
      maxAds,
      adActiveStatus: 'ALL'
    }
  );
  const runId = runRes.data.data.id;
  const datasetId = runRes.data.data.defaultDatasetId;
  console.log(`[Apify] Run started: ${runId}`);
  return { runId, datasetId };
}

// Step 2: Check status and fetch results (called by client polling)
async function fetchResults(runId, datasetId) {
  const statusRes = await axios.get(
    `${APIFY_BASE}/actor-runs/${runId}?token=${TOKEN}`
  );
  const status = statusRes.data.data.status;
  console.log(`[Apify] Run ${runId} status: ${status}`);

  if (status !== 'SUCCEEDED') {
    return { status, ads: [] };
  }

  const itemsRes = await axios.get(
    `${APIFY_BASE}/datasets/${datasetId}/items?token=${TOKEN}&format=json&limit=50`
  );

  const items = itemsRes.data || [];
  console.log(`[Apify] Fetched ${items.length} raw items`);
  return { status, ads: normalizeAds(items) };
}

function normalizeAds(rawItems) {
  const ads = [];
  const seenIds = new Set();

  for (const item of rawItems) {
    const creatives = item.creatives?.length ? item.creatives : [{}];
    for (const creative of creatives) {
      const ad_id = `${item.adArchiveId}_${creative.cardIndex ?? 0}`;
      if (seenIds.has(ad_id)) continue;
      seenIds.add(ad_id);

      ads.push({
        ad_id,
        ad_text: creative.body || creative.title || creative.description || creative.caption || '',
        image_url: creative.imageUrls?.[0] || null,
        video_url: creative.videoUrl || null,
        cta: creative.ctaText || null,
        link: creative.destinationUrl || item.snapshotUrl || null,
        days_running: item.daysRunning || calcDaysRunning(item.adDeliveryStartTime),
        platform: (item.publisherPlatforms || ['facebook']).join(', '),
        first_seen: item.adDeliveryStartTime || new Date().toISOString(),
        last_seen: new Date().toISOString(),
        still_active: item.adActiveStatus === 'ACTIVE'
      });
    }
  }

  console.log(`[Apify] Normalized ${ads.length} ads from ${rawItems.length} raw items`);
  return ads;
}

function calcDaysRunning(startDate) {
  if (!startDate) return 0;
  const start = new Date(startDate);
  return Math.max(0, Math.floor((Date.now() - start) / (1000 * 60 * 60 * 24)));
}

module.exports = { startScrape, fetchResults };
