// api/send-whatsapp.js
// Envoie un résumé du rapport sur WhatsApp via Twilio
// Variables Vercel requises : TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM

const https = require('https');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const SID   = process.env.TWILIO_ACCOUNT_SID   || req.body?.twilio_sid;
  const TOKEN = process.env.TWILIO_AUTH_TOKEN     || req.body?.twilio_token;
  const FROM  = process.env.TWILIO_WHATSAPP_FROM  || req.body?.twilio_from;
  const CLAUDE_KEY = process.env.CLAUDE_API_KEY;

  if (!SID || !TOKEN || !FROM) {
    return res.status(500).json({ error: 'Variables Twilio manquantes dans Vercel' });
  }

  const { rapport, chantier, date, avancement, alertes, destinataires } = req.body;

  if (!rapport || !destinataires || !destinataires.length) {
    return res.status(400).json({ error: 'rapport et destinataires requis' });
  }

  // ── 1. Résumé IA du rapport (5 lignes max) ──────────
  let resume = '';
  if (CLAUDE_KEY) {
    try {
      const claudeBody = JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `Tu es assistant de chantier. Fais un résumé WhatsApp du rapport suivant en exactement 5 lignes maximum, en français, sans mise en forme markdown, direct et factuel. Commence par une ligne de statut global (✅ Normal / ⚠️ Attention / 🔴 Alerte).\n\nRapport:\n${rapport.slice(0, 3000)}`
        }]
      });

      const claudeRes = await new Promise((resolve) => {
        const opts = {
          hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(claudeBody),
            'x-api-key': CLAUDE_KEY,
            'anthropic-version': '2023-06-01'
          }
        };
        const r = https.request(opts, resp => {
          let d = '';
          resp.on('data', c => d += c);
          resp.on('end', () => resolve(JSON.parse(d)));
        });
        r.on('error', () => resolve(null));
        r.write(claudeBody); r.end();
      });

      if (claudeRes?.content?.[0]?.text) {
        resume = claudeRes.content[0].text.trim();
      }
    } catch (e) {
      resume = '';
    }
  }

  // ── 2. Construction du message WhatsApp ─────────────
  const alertesTxt = alertes && alertes.length > 0
    ? '\n🔔 *Alertes:*\n' + alertes.map(a => `• ${a}`).join('\n')
    : '\n✅ Aucune alerte';

  const message = [
    `📋 *Rapport journalier Progev*`,
    `🏗 *${chantier || 'Chantier'}* — ${date || new Date().toLocaleDateString('fr-MA')}`,
    `📊 Avancement: *${avancement || '—'}*`,
    ``,
    resume || '(Résumé non disponible)',
    alertesTxt,
    ``,
    `🔗 Voir détails: progev.com/dashboard-direction.html`
  ].join('\n');

  // ── 3. Envoi à chaque destinataire ──────────────────
  const results = [];
  for (const numero of destinataires) {
    const num = numero.trim().replace(/\s/g, '');
    if (!num) continue;

    // Format E.164 avec préfixe whatsapp:
    const to = num.startsWith('whatsapp:') ? num : `whatsapp:${num.startsWith('+') ? num : '+' + num}`;

    const body = new URLSearchParams({
      From: FROM,
      To: to,
      Body: message
    }).toString();

    const result = await new Promise((resolve) => {
      const auth = Buffer.from(`${SID}:${TOKEN}`).toString('base64');
      const opts = {
        hostname: 'api.twilio.com',
        path: `/2010-04-01/Accounts/${SID}/Messages.json`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'Authorization': `Basic ${auth}`
        }
      };
      const r = https.request(opts, resp => {
        let d = '';
        resp.on('data', c => d += c);
        resp.on('end', () => {
          try {
            const parsed = JSON.parse(d);
            resolve({ numero: num, sid: parsed.sid, status: parsed.status, error: parsed.message });
          } catch(e) {
            resolve({ numero: num, error: 'Parse error' });
          }
        });
      });
      r.on('error', e => resolve({ numero: num, error: e.message }));
      r.write(body); r.end();
    });

    results.push(result);
  }

  const success = results.filter(r => r.sid && !r.error);
  const errors  = results.filter(r => r.error);

  return res.status(200).json({
    sent: success.length,
    errors: errors.length,
    details: results,
    message_preview: message.slice(0, 200)
  });
};
