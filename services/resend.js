const { Resend } = require('resend');
require('dotenv').config();

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.RESEND_FROM_EMAIL || 'digest@lumaspy.ai';

async function sendWeeklyDigest(subscriber, topAds) {
  const adCards = topAds.map(ad => `
    <div style="border:1px solid #333;border-radius:8px;padding:16px;margin-bottom:16px;background:#111;">
      <p style="color:#ccc;font-size:14px;">${ad.brands?.brand_name || 'Unknown Brand'}</p>
      <p style="color:#fff;font-size:15px;">${truncate(ad.ad_text, 200)}</p>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <span style="background:#FF3CAC;color:#fff;padding:4px 10px;border-radius:20px;font-size:12px;">
          Score: ${ad.ad_analysis?.[0]?.competitive_score ?? '—'}/10
        </span>
        <span style="background:#222;color:#aaa;padding:4px 10px;border-radius:20px;font-size:12px;">
          ${ad.days_running} days running
        </span>
      </div>
    </div>
  `).join('');

  await resend.emails.send({
    from: FROM,
    to: subscriber.email,
    subject: '🌸 Your Weekly LumaSpy Ad Intelligence Digest',
    html: `
      <!DOCTYPE html>
      <html>
      <body style="background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:32px;">
        <div style="max-width:600px;margin:0 auto;">
          <h1 style="color:#FF3CAC;font-size:28px;margin-bottom:4px;">LumaSpy</h1>
          <p style="color:#888;font-size:13px;margin-bottom:32px;">Weekly Ad Intelligence Digest</p>

          <h2 style="color:#fff;font-size:20px;">Top ${topAds.length} Ads This Week</h2>
          <p style="color:#aaa;font-size:14px;margin-bottom:24px;">
            The highest-scoring competitor ads detected across your tracked brands.
          </p>

          ${adCards}

          <div style="margin-top:32px;padding-top:24px;border-top:1px solid #222;">
            <a href="${process.env.APP_URL}/dashboard.html"
               style="background:#FF3CAC;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">
              View Full Dashboard →
            </a>
          </div>

          <p style="color:#444;font-size:12px;margin-top:32px;">
            You're receiving this because you have a LumaSpy Pro subscription.<br>
            <a href="${process.env.APP_URL}/unsubscribe?email=${encodeURIComponent(subscriber.email)}" style="color:#666;">Unsubscribe</a>
          </p>
        </div>
      </body>
      </html>
    `
  });
}

async function sendWelcomeEmail(email, plan) {
  await resend.emails.send({
    from: FROM,
    to: email,
    subject: '✨ Welcome to LumaSpy — Your Ad Intelligence is Ready',
    html: `
      <!DOCTYPE html>
      <html>
      <body style="background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:32px;">
        <div style="max-width:600px;margin:0 auto;">
          <h1 style="color:#FF3CAC;font-size:28px;">Welcome to LumaSpy 🌸</h1>
          <p style="color:#fff;font-size:16px;">You're on the <strong style="color:#FF3CAC;">${plan.toUpperCase()}</strong> plan.</p>
          <p style="color:#aaa;">Start tracking your first competitor brand to see their active Facebook ads, AI scores, and generated copy variants.</p>
          <div style="margin-top:24px;">
            <a href="${process.env.APP_URL}/dashboard.html"
               style="background:#FF3CAC;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">
              Go to Dashboard →
            </a>
          </div>
        </div>
      </body>
      </html>
    `
  });
}

function truncate(str, n) {
  return str && str.length > n ? str.slice(0, n) + '…' : str || '';
}

module.exports = { sendWeeklyDigest, sendWelcomeEmail };
