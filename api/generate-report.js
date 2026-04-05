const https = require('https');

module.exports = function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const key = process.env.CLAUDE_API_KEY;
  if (!key) { res.status(500).json({ error: 'No API key' }); return; }

  let rawBody = '';
  req.on('data', chunk => { rawBody += chunk; });
  req.on('end', () => {
    let prompt = '';
    try { prompt = JSON.parse(rawBody).prompt || ''; } catch(e) {}
    if (!prompt) { res.status(400).json({ error: 'No prompt', raw: rawBody }); return; }

    const payload = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      }
    };

    const apiReq = https.request(options, apiRes => {
      let data = '';
      apiRes.on('data', c => { data += c; });
      apiRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.content?.map(c => c.text || '').join('') || '';
          if (text) { res.status(200).json({ text }); }
          else { res.status(500).json({ error: 'Empty response', raw: data }); }
        } catch(e) {
          res.status(500).json({ error: 'Parse failed', raw: data.slice(0, 200) });
        }
      });
    });

    apiReq.on('error', e => { res.status(500).json({ error: e.message }); });
    apiReq.write(payload);
    apiReq.end();
  });
};
