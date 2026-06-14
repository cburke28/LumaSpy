const axios = require('axios');
require('dotenv').config();

const APIFY_BASE = 'https://api.apify.com/v2';
const TOKEN = process.env.APIFY_API_TOKEN;
// Uses brilliant_gum/facebook-ads-library-scraper — tested and confirmed working
const ACTOR_ID = 'brilliant_gum~facebook-ads-library-scraper';

async function scrapeAds(searchQuery, maxAds = 30) {
  console.log(`[Apify] Starting scrape for: "${searchQuery}"`);

  // Start the actor run
  const runRes = await axios.post(
    `${APIFY_BASE}/acts/${ACTOR_ID}/runs?token=${TOKEN}`,
    {
      searchQuery,
      country: 'US',
      maxResults: maxAds
    }
  );

  const runId = runRes.data.data.id;
  const datasetId = runRes.data.data.defaultDatasetId;
  console.log(`[Apify] Run started: ${runId}`);

  // Poll until finished (max 5 minutes, every 10s)
  for (let i = 0; i < 30; i++) {
    await sleep(10000);
    const statusRes = await axios.get(
      `${APIFY_BASE}/actor-runs/${runId}?token=${TOKEN}`
    );
    const status = statusRes.data.data.status;
    console.log(`[Apify] Run status: ${status} (attempt ${i + 1})`);

    if (status === 'SUCCEEDED') break;
    if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
      throw new Error(`Apify run ${status} for "${searchQuery}"`);
    }
  }

  // Fetch dataset items
  const itemsRes = await axios.get(
    `${APIFY_BASE}/datasets/${datasetId}/items?token=${TOKEN}&format=json&limit=${maxAds}`
  );

  const items = itemsRes.data || [];
  console.log(`[Apify] Got ${items.length} ads for "${searchQuery}"`);
  return normalizeAds(items);
}

function normalizeAds(rawItems) {
  const ads = [];

  for (const item of rawItems) {
    // Each item may have multiple creatives (carousel) — create one ad per creative
    const creatives = item.creatives?.length ? item.creatives : [{}];

    for (const creative of creatives) {
      ads.push({
        ad_id: `${item.adArchiveId}_${creative.cardIndex ?? 0}`,
        ad_text: creative.body || creative.description || '',
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

  // Deduplicate by ad_text to avoid flooding with carousel duplicates
  const seen = new Set();
  return ads.filter(ad => {
    const key = ad.ad_text?.trim().slice(0, 100);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function calcDaysRunning(startDate) {
  if (!startDate) return 0;
  const start = new Date(startDate);
  const now = new Date();
  return Math.max(0, Math.floor((now - start) / (1000 * 60 * 60 * 24)));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { scrapeAds };
