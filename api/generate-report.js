module.exports = async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const key = process.env.CLAUDE_API_KEY;
  if (!key) { res.status(500).json({ error: 'No API key' }); return; }

  const prompt = req.body?.prompt;
  if (!prompt) { res.status(400).json({ error: 'No prompt', body: req.body }); return; }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await r.json();
    if (!r.ok) { res.status(r.status).json({ error: 'Claude error', details: data }); return; }

    const text = data.content?.map(c => c.text || '').join('') || '';
    res.status(200).json({ text });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
