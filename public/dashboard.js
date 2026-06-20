/* ─── State ──────────────────────────────────────────────────── */
let subscriber = null;
let brands = [];
let currentBrandId = null;

/* ─── Init ───────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  subscriber = JSON.parse(localStorage.getItem('ls_subscriber') || 'null');
  if (!subscriber) {
    window.location.href = '/?signin=1';
    return;
  }

  // Refresh subscriber state from server
  try {
    const res = await fetch(`/api/auth/me/${subscriber.id}`);
    if (res.ok) {
      const data = await res.json();
      subscriber = data.subscriber;
      localStorage.setItem('ls_subscriber', JSON.stringify(subscriber));
    }
  } catch (_) {}

  renderTopBar();
  await loadBrands();

  // Auto-select first brand if exists
  if (brands.length > 0) selectBrand(brands[0].id);

  // Handle ?upgraded=true from Stripe redirect
  const params = new URLSearchParams(window.location.search);
  if (params.get('upgraded')) {
    showToast('Welcome to Pro! Your trial has started. 🎉', 'success');
    history.replaceState({}, '', '/dashboard.html');
  }
});

/* ─── Top Bar ────────────────────────────────────────────────── */
function renderTopBar() {
  document.getElementById('user-email').textContent = subscriber.email;
  const badge = document.getElementById('plan-badge');
  badge.textContent = subscriber.plan.toUpperCase();
  badge.className = `badge badge-${subscriber.plan}`;

  if (subscriber.plan === 'free') {
    document.getElementById('upgrade-btn').style.display = 'inline-flex';
  }
}

/* ─── Brands ─────────────────────────────────────────────────── */
async function loadBrands() {
  const res = await fetch(`/api/brands?subscriber_id=${subscriber.id}`);
  const data = await res.json();
  brands = data.brands || [];
  renderBrandsList();
}

function renderBrandsList() {
  const list = document.getElementById('brands-list');

  if (brands.length === 0) {
    list.innerHTML = `<p style="padding:8px 16px;font-size:13px;color:var(--muted);">No brands yet</p>`;
    return;
  }

  list.innerHTML = brands.map(b => `
    <div class="sidebar-brand ${b.id === currentBrandId ? 'active' : ''}"
         onclick="selectBrand('${b.id}')" id="brand-item-${b.id}">
      <div>
        <div class="sidebar-brand-name">${esc(b.brand_name)}</div>
        <div class="sidebar-brand-sub">${esc(b.industry)}</div>
      </div>
      <button class="delete-brand-btn" onclick="deleteBrand(event,'${b.id}')" title="Remove brand">×</button>
    </div>
  `).join('');
}

async function selectBrand(brandId) {
  currentBrandId = brandId;
  const brand = brands.find(b => b.id === brandId);
  renderBrandsList();

  document.getElementById('topbar-title').textContent = brand?.brand_name || 'Ad Feed';
  document.getElementById('topbar-sub').textContent = `@${brand?.facebook_page_name}`;
  document.getElementById('refresh-btn').style.display = 'inline-flex';

  await loadAds(brandId);
}

async function deleteBrand(e, brandId) {
  e.stopPropagation();
  if (!confirm('Remove this brand? All its scraped ads will also be deleted.')) return;

  await fetch(`/api/brands/${brandId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscriber_id: subscriber.id })
  });

  brands = brands.filter(b => b.id !== brandId);
  if (currentBrandId === brandId) {
    currentBrandId = null;
    document.getElementById('ad-feed').innerHTML = emptyState('Select a brand', 'Click a brand in the sidebar to view their ads.');
    document.getElementById('refresh-btn').style.display = 'none';
  }
  renderBrandsList();
  showToast('Brand removed');
}

/* ─── Add Brand Modal ────────────────────────────────────────── */
function openAddBrand() {
  document.getElementById('add-brand-modal').classList.add('open');
  document.getElementById('brand-name-input').focus();
}
function closeAddBrand() {
  document.getElementById('add-brand-modal').classList.remove('open');
}
function closeAddBrandOutside(e) {
  if (e.target.id === 'add-brand-modal') closeAddBrand();
}

async function handleAddBrand(e) {
  e.preventDefault();
  const btn = document.getElementById('add-brand-submit');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Adding…';

  const body = {
    subscriber_id: subscriber.id,
    brand_name: document.getElementById('brand-name-input').value.trim(),
    facebook_page_name: document.getElementById('fb-page-input').value.trim().replace('@',''),
    industry: document.getElementById('industry-input').value
  };

  const res = await fetch('/api/brands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();

  if (!res.ok) {
    showToast(data.error, 'error');
    if (data.upgrade) showUpgradePrompt();
    btn.disabled = false;
    btn.textContent = 'Add Brand + Start Scraping →';
    return;
  }

  brands.push(data.brand);
  closeAddBrand();
  renderBrandsList();
  selectBrand(data.brand.id);

  // Kick off scrape and poll for completion
  showToast(`Tracking ${data.brand.brand_name}! Scraping ads now — takes ~2 min…`);
  startScrapeAndPoll(data.brand.id);
  btn.disabled = false;
  btn.textContent = 'Add Brand + Start Scraping →';
  document.getElementById('add-brand-form').reset();
}

/* ─── Scrape + Poll ──────────────────────────────────────────── */
async function startScrapeAndPoll(brandId) {
  // Step 1: tell server to start the scrape — server returns runId immediately
  let scrapeData;
  try {
    const res = await fetch('/api/ads/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriber_id: subscriber.id, brand_id: brandId })
    });
    scrapeData = await res.json();
    if (!res.ok || !scrapeData.runId) {
      showToast('Could not start scrape: ' + (scrapeData.error || 'unknown'), 'error');
      return;
    }
  } catch (err) {
    showToast('Server error starting scrape — please try again.', 'error');
    return;
  }

  const { runId, datasetId, apifyToken } = scrapeData;
  showToast('🔍 Scraping ads… takes about 30-60 seconds');

  // Step 2: browser polls Apify directly every 10s — no server needed
  let attempts = 0;
  const poll = setInterval(async () => {
    attempts++;
    if (attempts > 30) {
      clearInterval(poll);
      showToast('Scrape timed out — try again.', 'error');
      return;
    }

    try {
      const statusRes = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}?token=${apifyToken}`
      );
      const statusData = await statusRes.json();
      const status = statusData?.data?.status;

      if (status === 'SUCCEEDED') {
        clearInterval(poll);
        showToast('✅ Ads found! Saving to your dashboard…');

        // Step 3: send results to server to store in Supabase
        const completeRes = await fetch('/api/ads/scrape/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subscriber_id: subscriber.id,
            brand_id: brandId,
            run_id: runId,
            dataset_id: datasetId
          })
        });
        const completeData = await completeRes.json();
        showToast(`🌸 ${completeData.stored || 0} ads loaded!`);
        if (currentBrandId === brandId) loadAds(brandId);

      } else if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
        clearInterval(poll);
        showToast('Scrape failed — please try again.', 'error');
      }
    } catch (err) {
      // network blip — keep polling
    }
  }, 10000);
}

/* ─── Ads ────────────────────────────────────────────────────── */
async function loadAds(brandId) {
  const feed = document.getElementById('ad-feed');
  feed.innerHTML = skeletonCards(3);

  const res = await fetch(`/api/ads?subscriber_id=${subscriber.id}&brand_id=${brandId}`);
  const data = await res.json();
  const ads = data.ads || [];

  if (ads.length === 0) {
    feed.innerHTML = emptyState(
      'No ads found yet',
      'Ads are scraped in the background. Check back in a few minutes, or hit Refresh.'
    );
    return;
  }

  const isPro = subscriber.plan === 'pro';

  // Show upgrade bar for free users
  let upgradeHtml = '';
  if (!isPro) {
    upgradeHtml = `
      <div class="upgrade-bar">
        <p>👀 You're seeing <strong>5 of ${ads.length}+ ads</strong> found for this brand.
           Upgrade to unlock full history, AI scores &amp; copy generation.</p>
        <button class="btn btn-primary btn-sm" onclick="startUpgrade()">Upgrade to Pro →</button>
      </div>`;
  }

  const adCards = ads.map(ad => renderAdCard(ad)).join('');

  // Teaser section for free users
  const teaserHtml = !isPro ? renderTeaserSection() : '';

  feed.innerHTML = upgradeHtml + adCards + teaserHtml;
}

function refreshCurrentBrand() {
  if (currentBrandId) loadAds(currentBrandId);
}

/* ─── Ad Card ────────────────────────────────────────────────── */
function renderAdCard(ad) {
  const analysis = ad.ad_analysis?.[0];
  const score = analysis?.competitive_score;
  const brand = ad.tracked_brands;
  const hasMedia = ad.image_url || ad.video_url;
  const isPro = subscriber.plan === 'pro';

  const scoreHtml = score
    ? `<span class="badge ${scoreClass(score)}">${score}/10</span>`
    : (isPro ? `<span class="badge badge-free">Unanalyzed</span>` : '');

  const mediaHtml = hasMedia
    ? `<div class="ad-media">
        ${ad.video_url ? `<div class="video-badge">Video</div>` : ''}
        ${ad.image_url ? `<img src="${esc(ad.image_url)}" alt="Ad creative" loading="lazy" onerror="this.parentElement.innerHTML='<div class=ad-media-placeholder>🖼️</div>'" />` : '<div class="ad-media-placeholder">▶</div>'}
       </div>`
    : '';

  const fbLink = ad.link
    ? `<a href="${esc(ad.link)}" target="_blank" class="btn btn-ghost btn-sm">👁 View Ad →</a>`
    : '';

  const actionButtons = isPro
    ? `${fbLink}
       <button class="btn btn-ghost btn-sm" onclick="showAnalysis('${ad.id}')">🤖 See Analysis</button>
       <button class="btn btn-outline btn-sm" onclick="generateCopy('${ad.id}')">✍️ Generate My Version</button>`
    : `${fbLink}
       <button class="btn btn-ghost btn-sm" onclick="startUpgrade()" title="Pro feature">🔒 AI Score & Analysis</button>
       <button class="btn btn-outline btn-sm" onclick="startUpgrade()" title="Pro feature">🔒 Generate My Version</button>`;

  return `
    <div class="ad-card" id="adcard-${ad.id}">
      <div class="ad-card-inner">
        ${mediaHtml}
        <div class="ad-content">
          <div class="ad-meta">
            <span class="brand-tag">${esc(brand?.brand_name || 'Unknown')}</span>
            ${scoreHtml}
            <span class="days-badge">${ad.days_running || 0}d running</span>
            ${ad.still_active ? '<span class="badge badge-active">Active</span>' : ''}
            ${ad.cta ? `<span class="badge" style="background:var(--bg3);color:var(--muted);border:1px solid var(--border);">${esc(ad.cta)}</span>` : ''}
          </div>
          <p class="ad-text">${esc(ad.ad_text || '(No copy — visual/video ad)')}</p>
          <div class="ad-actions">${actionButtons}</div>
        </div>
      </div>
      <div class="analysis-panel" id="panel-${ad.id}"></div>
    </div>`;
}

/* ─── Pro Teaser ─────────────────────────────────────────────── */
function renderTeaserSection() {
  const fakeAds = [
    { score: 9, days: 47, text: 'The serum dermatologists are calling a breakthrough...' },
    { score: 8, days: 31, text: 'Finally — a moisturizer that works in 60 seconds flat.' },
    { score: 7, days: 22, text: 'Your skin called. It wants this.' },
  ];

  const fakeCards = fakeAds.map(a => `
    <div style="position:relative;filter:blur(3px);pointer-events:none;opacity:0.5;">
      <div class="ad-card">
        <div class="ad-card-inner">
          <div class="ad-content" style="padding:20px;">
            <div class="ad-meta">
              <span class="brand-tag">Competitor Brand</span>
              <span class="badge score-high">${a.score}/10</span>
              <span class="days-badge">${a.days}d running</span>
              <span class="badge badge-active">Active</span>
            </div>
            <p class="ad-text">${a.text}</p>
            <div class="ad-actions">
              <button class="btn btn-ghost btn-sm">🤖 See Analysis</button>
              <button class="btn btn-outline btn-sm">✍️ Generate My Version</button>
            </div>
          </div>
        </div>
      </div>
    </div>`).join('');

  return `
    <div style="position:relative;margin-top:8px;">
      ${fakeCards}
      <div style="
        position:absolute;inset:0;
        display:flex;flex-direction:column;
        align-items:center;justify-content:center;
        background:linear-gradient(to bottom, rgba(10,10,10,0) 0%, rgba(10,10,10,0.97) 40%);
        border-radius:20px;
        padding:40px 24px;
        text-align:center;
      ">
        <div style="font-size:36px;margin-bottom:12px;">🔒</div>
        <h3 style="font-size:22px;font-weight:800;margin-bottom:8px;">
          You're missing <span style="color:#FF3CAC;">dozens more ads</span>
        </h3>
        <p style="color:var(--muted);font-size:15px;max-width:400px;margin-bottom:24px;line-height:1.6;">
          Pro members see <strong style="color:white;">every ad</strong> this brand is running —
          with AI scores, full breakdowns, and instant copy generation.
        </p>
        <button class="btn btn-primary btn-lg" onclick="startUpgrade()">
          Unlock Everything — $49/mo →
        </button>
        <p style="color:var(--muted2);font-size:12px;margin-top:12px;">7-day free trial · Cancel anytime</p>
      </div>
    </div>`;
}

/* ─── Analysis ───────────────────────────────────────────────── */
async function showAnalysis(adId) {
  const modal = document.getElementById('analysis-modal');
  const content = document.getElementById('analysis-modal-content');
  modal.classList.add('open');
  content.innerHTML = `<div style="text-align:center;padding:40px;"><div class="spinner" style="margin:0 auto 16px;"></div><p style="color:var(--muted);">Analyzing with Claude AI…</p></div>`;

  const res = await fetch(`/api/ads/${adId}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscriber_id: subscriber.id })
  });
  const data = await res.json();

  if (!res.ok) {
    if (data.upgrade) {
      content.innerHTML = upgradeHtml();
    } else {
      content.innerHTML = `<p style="color:var(--red);">${esc(data.error)}</p>`;
    }
    return;
  }

  const a = data.analysis;
  content.innerHTML = `
    <h2 style="margin-bottom:4px;">Ad Analysis</h2>
    <p style="color:var(--muted);font-size:13px;margin-bottom:20px;">Powered by Claude AI</p>

    <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
      <span class="badge ${scoreClass(a.competitive_score)}" style="font-size:18px;padding:8px 18px;">
        ${a.competitive_score}/10
      </span>
      <div>
        <div style="font-weight:700;">Competitive Score</div>
        <div style="font-size:13px;color:var(--muted);">Hook: <strong style="color:var(--accent2);">${esc(a.hook_type)}</strong></div>
      </div>
    </div>

    <div class="analysis-grid">
      <div class="analysis-item">
        <label>Creative Strategy</label>
        <p>${esc(a.creative_strategy)}</p>
      </div>
      <div class="analysis-item">
        <label>Why It Works</label>
        <p>${esc(a.why_it_works)}</p>
      </div>
    </div>

    <div class="analysis-item" style="margin-bottom:20px;">
      <label>Key Messages</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;">
        ${(a.key_messages || []).map(m => `<span class="badge badge-free">${esc(m)}</span>`).join('')}
      </div>
    </div>

    <div class="copy-variants">
      <h4>Generated Copy Variants</h4>
      ${[a.generated_copy_1, a.generated_copy_2, a.generated_copy_3].map((c, i) => `
        <div class="copy-variant">
          <div class="copy-variant-num">Variant ${i + 1}</div>
          <p>${esc(c)}</p>
          <button class="copy-copy-btn" onclick="copyText(this, \`${escapeTpl(c)}\`)">Copy</button>
        </div>
      `).join('')}
    </div>`;
}

function closeAnalysis() { document.getElementById('analysis-modal').classList.remove('open'); }
function closeAnalysisOutside(e) { if (e.target.id === 'analysis-modal') closeAnalysis(); }

/* ─── Copy Generation ────────────────────────────────────────── */
async function generateCopy(adId) {
  const modal = document.getElementById('copy-modal');
  const content = document.getElementById('copy-modal-content');
  modal.classList.add('open');
  content.innerHTML = `<div style="text-align:center;padding:40px;"><div class="spinner" style="margin:0 auto 16px;"></div><p style="color:var(--muted);">Writing your variants…</p></div>`;

  const res = await fetch(`/api/ads/${adId}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscriber_id: subscriber.id })
  });
  const data = await res.json();

  if (!res.ok) {
    content.innerHTML = data.upgrade ? upgradeHtml() : `<p style="color:var(--red);">${esc(data.error)}</p>`;
    return;
  }

  content.innerHTML = (data.variants || []).map((v, i) => `
    <div class="copy-variant">
      <div class="copy-variant-num">Variant ${i + 1}</div>
      <p>${esc(v)}</p>
      <button class="copy-copy-btn" onclick="copyText(this, \`${escapeTpl(v)}\`)">Copy</button>
    </div>
  `).join('');
}

function closeCopy() { document.getElementById('copy-modal').classList.remove('open'); }
function closeCopyOutside(e) { if (e.target.id === 'copy-modal') closeCopy(); }

/* ─── Upgrade ────────────────────────────────────────────────── */
async function startUpgrade() {
  const res = await fetch('/api/create-checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: subscriber.email })
  });
  const data = await res.json();
  if (data.url) window.location.href = data.url;
}

function showUpgradePrompt() {
  showToast('Upgrade to Pro to unlock this feature.', 'error');
}

function upgradeHtml() {
  return `
    <div style="text-align:center;padding:40px 24px;">
      <div style="font-size:40px;margin-bottom:16px;">✨</div>
      <h3 style="margin-bottom:8px;">Pro Feature</h3>
      <p style="color:var(--muted);margin-bottom:24px;">AI analysis and copy generation require a Pro subscription.</p>
      <button class="btn btn-primary" onclick="startUpgrade()">Start 7-Day Free Trial →</button>
    </div>`;
}

/* ─── Helpers ────────────────────────────────────────────────── */
function scoreClass(score) {
  if (score >= 8) return 'score-high';
  if (score >= 5) return 'score-mid';
  return 'score-low';
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function escapeTpl(str) {
  return String(str || '').replace(/`/g,'\\`').replace(/\$/g,'\\$');
}

function emptyState(title, msg) {
  return `<div class="empty-state">
    <div class="empty-state-icon">📭</div>
    <h3>${title}</h3>
    <p>${msg}</p>
  </div>`;
}

function skeletonCards(n) {
  return Array(n).fill(0).map(() => `
    <div class="card" style="display:flex;gap:16px;padding:20px;">
      <div class="skeleton" style="width:180px;height:120px;flex-shrink:0;"></div>
      <div style="flex:1;display:flex;flex-direction:column;gap:10px;">
        <div class="skeleton" style="height:14px;width:30%;"></div>
        <div class="skeleton" style="height:12px;width:80%;"></div>
        <div class="skeleton" style="height:12px;width:65%;"></div>
        <div class="skeleton" style="height:12px;width:50%;"></div>
      </div>
    </div>`).join('');
}

async function copyText(btn, text) {
  await navigator.clipboard.writeText(text);
  btn.textContent = 'Copied!';
  setTimeout(() => btn.textContent = 'Copy', 2000);
}

function showToast(msg, type = 'success') {
  const c = document.getElementById('toasts');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 4500);
}
