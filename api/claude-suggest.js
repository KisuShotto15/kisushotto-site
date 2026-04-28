import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { goalTitle, existingSteps } = req.body || {};
  if (!goalTitle) return res.status(400).json({ error: 'goalTitle required' });

  try {
    const existing = Array.isArray(existingSteps) && existingSteps.length
      ? `\nAlready planned: ${JSON.stringify(existingSteps)}`
      : '';

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `Break this goal into 5-7 concrete, actionable steps. Return ONLY a valid JSON array of strings, nothing else.\nGoal: "${goalTitle}"${existing}`
      }]
    });

    const text = msg.content[0].text;
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON array in response');

    const steps = JSON.parse(match[0]);
    res.json({ steps });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
