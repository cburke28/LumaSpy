# LumaSpy — Project Documentation

AI-powered Facebook ad intelligence tool for beauty and wellness brands.

## Architecture Overview

```
Browser (index.html / dashboard.html)
    │
    ▼
Express (server.js :3000)
    ├── /api/auth         → routes/auth.js
    ├── /api/brands       → routes/brands.js
    ├── /api/ads          → routes/ads.js
    ├── /api/create-checkout  (inline in server.js)
    └── /webhooks/stripe  → routes/webhooks.js
         │
         ├── services/supabase.js  (database)
         ├── services/claude.js    (AI analysis + copy)
         ├── services/apify.js     (Facebook ad scraping)
         └── services/resend.js    (email)
```

## File Structure

```
lumaspy/
  server.js              Main Express app, Stripe checkout, admin digest trigger
  /public
    index.html           Landing page (hero, benefits, pricing, email capture)
    dashboard.html       User dashboard (sidebar + ad feed)
    styles.css           All styles — dark theme, landing + dashboard
    dashboard.js         All dashboard client-side logic
  /routes
    auth.js              POST /register, POST /login, GET /me/:id
    brands.js            GET/POST/DELETE tracked_brands
    ads.js               GET ads, POST scrape, POST analyze, POST generate
    webhooks.js          Stripe webhook handler
  /services
    apify.js             Scrapes Facebook Ads Library via Apify actor
    claude.js            Ad analysis + copy generation via Claude API
    resend.js            Welcome email + weekly digest
    supabase.js          Supabase client (service role)
  .env.example           All required env vars with descriptions
  package.json
  CLAUDE.md              This file
```

## Environment Variables

| Variable | Description | Where to get it |
|---|---|---|
| `SUPABASE_URL` | Your project URL | Supabase dashboard → Settings → API |
| `SUPABASE_SERVICE_KEY` | Service role key (bypasses RLS) | Supabase dashboard → Settings → API |
| `SUPABASE_ANON_KEY` | Anon/public key | Supabase dashboard → Settings → API |
| `ANTHROPIC_API_KEY` | Claude API key | console.anthropic.com |
| `APIFY_API_TOKEN` | Apify personal API token | console.apify.com → Settings → Integrations |
| `APIFY_ACTOR_ID` | Actor to run for FB scraping | Default: `apify/facebook-ads-scraper` |
| `RESEND_API_KEY` | Resend email API key | resend.com → API Keys |
| `RESEND_FROM_EMAIL` | Verified sender email | Must be a verified domain in Resend |
| `STRIPE_SECRET_KEY` | Stripe secret key | dashboard.stripe.com → Developers → API Keys |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret | Stripe → Webhooks → your endpoint |
| `STRIPE_PRO_PRICE_ID` | Price ID for $49/mo plan | Stripe → Products → your Pro product |
| `PORT` | Server port (default 3000) | Set as needed |
| `APP_URL` | Full public URL of your app | e.g. `https://lumaspy.ai` or `http://localhost:3000` |
| `SESSION_SECRET` | Random string for admin endpoints | Generate with `openssl rand -hex 32` |

## Supabase Setup

Run this SQL in the Supabase SQL editor to create all tables:

```sql
-- Subscribers
create table subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  stripe_customer_id text,
  stripe_subscription_id text,
  plan text not null default 'free' check (plan in ('free','pro')),
  status text not null default 'active' check (status in ('active','cancelled')),
  created_at timestamptz default now()
);

-- Tracked brands
create table tracked_brands (
  id uuid primary key default gen_random_uuid(),
  subscriber_id uuid not null references subscribers(id) on delete cascade,
  brand_name text not null,
  facebook_page_name text not null,
  industry text default 'beauty',
  created_at timestamptz default now()
);

-- Ads
create table ads (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references tracked_brands(id) on delete cascade,
  subscriber_id uuid not null references subscribers(id) on delete cascade,
  ad_id text not null,
  ad_text text,
  image_url text,
  video_url text,
  cta text,
  link text,
  days_running integer default 0,
  platform text default 'facebook',
  first_seen timestamptz default now(),
  last_seen timestamptz default now(),
  still_active boolean default true,
  unique(ad_id, brand_id)
);

-- Ad analysis
create table ad_analysis (
  id uuid primary key default gen_random_uuid(),
  ad_id uuid not null references ads(id) on delete cascade,
  hook_type text,
  creative_strategy text,
  key_messages text[],
  competitive_score integer check (competitive_score between 1 and 10),
  why_it_works text,
  generated_copy_1 text,
  generated_copy_2 text,
  generated_copy_3 text,
  analyzed_at timestamptz default now(),
  unique(ad_id)
);

-- Useful indexes
create index on tracked_brands(subscriber_id);
create index on ads(brand_id);
create index on ads(subscriber_id);
create index on ads(first_seen desc);
create index on ad_analysis(ad_id);
```

## Service Connections

### Apify → Ads
`services/apify.js` calls the `apify/facebook-ads-scraper` actor with a brand's
Facebook page name. It polls until the run completes, then normalizes results
into the `ads` table schema. Scraping is triggered via `POST /api/ads/scrape`
and runs asynchronously (response returns immediately).

### Claude → Analysis
`services/claude.js` uses `claude-sonnet-4-6`. The `analyzeAd()` function accepts
ad copy + optional image URL and returns structured JSON: hook type, creative
strategy, key messages, competitive score (1–10), why it works, and 3 copy
variants. Analysis is cached in `ad_analysis` — an ad is only analyzed once.

### Stripe → Subscriptions
Checkout sessions are created at `POST /api/create-checkout`. Stripe sends
lifecycle events to `POST /webhooks/stripe`. The webhook handles:
- `checkout.session.completed` → upgrade subscriber to pro
- `customer.subscription.deleted/paused` → downgrade to free
- `customer.subscription.updated` → sync status

### Resend → Email
Two emails: `sendWelcomeEmail()` on signup/upgrade, `sendWeeklyDigest()` for
pro subscribers (triggered manually via `POST /api/admin/send-digests` with the
`SESSION_SECRET` or set up a cron job to call it weekly).

## Plan Limits

| Feature | Free | Pro |
|---|---|---|
| Tracked brands | 1 | Unlimited |
| Ad history | Last 7 days | Full |
| Ads visible | 10 max | Unlimited |
| AI analysis | ✗ | ✓ |
| Copy generation | ✗ | ✓ |
| Weekly digest | ✗ | ✓ |

## Running Locally

```bash
cd lumaspy
cp .env.example .env
# Fill in .env values
npm install
npm run dev
# Open http://localhost:3000
```

## Deployment Checklist

- [ ] Set all env vars on your host (Railway, Render, Fly.io, etc.)
- [ ] Run Supabase SQL to create tables
- [ ] Create Stripe product + price, copy `STRIPE_PRO_PRICE_ID`
- [ ] Register Stripe webhook pointing to `https://yourdomain.com/webhooks/stripe`
  - Events to enable: `checkout.session.completed`, `customer.subscription.deleted`,
    `customer.subscription.paused`, `customer.subscription.updated`
- [ ] Verify sender domain in Resend
- [ ] Set `APP_URL` to your production domain
- [ ] Set up a weekly cron to POST `/api/admin/send-digests` with your `SESSION_SECRET`
