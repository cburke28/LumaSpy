const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function analyzeAd(adText, imageUrl, brandName, industry) {
  const imageBlock = imageUrl
    ? [{ type: 'image', source: { type: 'url', url: imageUrl } }]
    : [];

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: `You are an expert direct-response copywriter and beauty/wellness brand strategist.
Analyze Facebook ads for beauty and wellness brands. Be specific, insightful, and actionable.
Always respond with valid JSON only — no markdown fences.`,
    messages: [
      {
        role: 'user',
        content: [
          ...imageBlock,
          {
            type: 'text',
            text: `Analyze this Facebook ad for ${brandName} (${industry} industry).

Ad copy:
"""
${adText}
"""

Return a JSON object with exactly these keys:
{
  "hook_type": "one of: question / bold_claim / story / pain_point / social_proof / curiosity / offer",
  "creative_strategy": "2-3 sentence description of the creative approach",
  "key_messages": ["message1", "message2", "message3"],
  "competitive_score": <integer 1-10>,
  "why_it_works": "2-3 sentences explaining the psychological / conversion principles at play",
  "generated_copy_1": "A full alternative ad copy variant (same product, different angle)",
  "generated_copy_2": "A second full alternative ad copy variant",
  "generated_copy_3": "A third full alternative ad copy variant"
}`
          }
        ]
      }
    ]
  });

  return JSON.parse(response.content[0].text);
}

async function generateCopyVariants(adText, brandVoice) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    messages: [
      {
        role: 'user',
        content: `You are a direct-response copywriter for beauty brands.

Original competitor ad:
"""
${adText}
"""

Brand voice notes: ${brandVoice || 'modern, clean, premium'}

Write 3 fresh ad copy variants inspired by this ad but rewritten for my brand.
Return JSON only: { "variants": ["copy1", "copy2", "copy3"] }`
      }
    ]
  });

  return JSON.parse(response.content[0].text);
}

module.exports = { analyzeAd, generateCopyVariants };
