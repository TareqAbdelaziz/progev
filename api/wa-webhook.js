// api/wa-webhook.js
// Webhook WhatsApp entrant via Twilio
// Gère : messages texte (FR/Darija/AR) + notes vocales
// Extrait les données chantier avec Claude → sauvegarde dans Supabase → confirmation WhatsApp

const https = require('https');
const http  = require('http');
const { URL } = require('url');

// ── CONFIG ────────────────────────────────────────────
const SUPA_URL   = process.env.SUPABASE_URL   || 'https://kytoohxfditlhmvzehgj.supabase.co';
const SUPA_KEY   = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt5dG9vaHhmZGl0bGhtdnplaGdqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUzOTk2MzEsImV4cCI6MjA5MDk3NTYzMX0.oMTiAaoYlzY0cryj2pBM9v4si4hHiE0QFSlhiSTRAFA';
const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOK = process.env.TWILIO_AUTH_TOKEN;
const WA_FROM    = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';

module.exports = async function handler(req, res) {
  // Twilio envoie en POST avec Content-Type: application/x-www-form-urlencoded
  if (req.method === 'GET') {
    return res.status(200).send('Progev WhatsApp Webhook OK');
  }
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  try {
    // ── 1. Parser le body Twilio ──────────────────────
    const body = req.body || {};
    const from     = body.From || '';        // ex: whatsapp:+212661234567
    const msgBody  = body.Body || '';        // texte du message
    const numMedia = parseInt(body.NumMedia || '0');
    const mediaUrl = body.MediaUrl0 || '';   // URL du fichier audio
    const mediaType= body.MediaContentType0 || ''; // ex: audio/ogg

    const senderNum = from.replace('whatsapp:', '').trim();

    if (!senderNum) {
      return res.status(200).send('<Response></Response>');
    }

    // ── 2. Identifier le chantier lié à ce numéro ────
    const chantierInfo = await findChantierByNumero(senderNum);

    if (!chantierInfo) {
      await sendWhatsApp(senderNum, `❌ Numéro non reconnu dans Progev.\n\nContactez votre chef de projet pour configurer votre accès sur progev.com`);
      return res.status(200).send('<Response></Response>');
    }

    const { chantier, user } = chantierInfo;

    // ── 3. Extraire les données selon le type ────────
    let extracted = null;
    let transcription = '';

    const isAudio = numMedia > 0 && mediaType.startsWith('audio');
    const isText  = msgBody && msgBody.trim().length > 3;

    if (isAudio && mediaUrl) {
      // Note vocale → télécharger + envoyer à Claude audio
      const result = await processVoiceMessage(mediaUrl, mediaType, chantier.nom);
      extracted     = result.extracted;
      transcription = result.transcription;
    } else if (isText) {
      // Message texte (FR / Darija / AR)
      extracted = await extractFromText(msgBody, chantier.nom);
    } else {
      await sendWhatsApp(senderNum, `👋 Bonjour !\n\nEnvoyez un message texte ou une note vocale décrivant l'avancement de votre chantier.\n\nExemple:\n"Aujourd'hui 8 pylônes posés, 22 ouvriers, pas d'incident, retard livraison câble"`);
      return res.status(200).send('<Response></Response>');
    }

    if (!extracted) {
      await sendWhatsApp(senderNum, `⚠️ Je n'ai pas pu extraire les données de votre message.\n\nEssayez avec plus de détails :\n"X supports posés, Y personnes, météo, incidents HSE, problèmes..."`);
      return res.status(200).send('<Response></Response>');
    }

    // ── 4. Générer le rapport complet ────────────────
    const rapport = await generateRapport(extracted, chantier);

    // ── 5. Sauvegarder dans Supabase ─────────────────
    const date = extracted.date || new Date().toISOString().split('T')[0];
    const saved = await saveToSupabase({
      chantier_id:      chantier.id,
      auteur_id:        user.id,
      date_rapport:     date,
      avancement_reel:  extracted.avancement || null,
      effectif:         extracted.effectif || 0,
      engins:           extracted.engins || 0,
      meteo:            extracted.meteo || 'Non précisé',
      travaux_realises: extracted.travaux || msgBody || transcription,
      hse_evenements:   extracted.hse || 'Aucun incident',
      hse_incident:     extracted.hse_incident || false,
      livraisons_attente: extracted.livraisons_attente || '',
      problemes:        extracted.problemes || '',
      decisions:        extracted.decisions || '',
      risques:          extracted.risques || '',
      texte_rapport:    rapport,
    });

    // ── 6. Confirmation WhatsApp ──────────────────────
    const alertes = [];
    if (extracted.hse_incident) alertes.push('🔴 Incident HSE signalé');
    if (extracted.livraisons_attente) alertes.push(`⚠️ ${extracted.livraisons_attente}`);
    if (extracted.problemes) alertes.push(`⚠️ ${extracted.problemes}`);

    let confirmMsg = `✅ *Rapport enregistré — ${chantier.nom}*\n`;
    confirmMsg += `📅 ${date}\n\n`;

    if (transcription) {
      confirmMsg += `🎙 *Transcription:*\n_"${transcription.slice(0, 200)}${transcription.length > 200 ? '...' : ''}"_\n\n`;
    }

    confirmMsg += `📊 *Données extraites:*\n`;
    if (extracted.avancement) confirmMsg += `• Avancement: *${extracted.avancement}%*\n`;
    if (extracted.effectif)   confirmMsg += `• Effectif: *${extracted.effectif} personnes*\n`;
    if (extracted.engins)     confirmMsg += `• Engins: *${extracted.engins}*\n`;
    if (extracted.meteo)      confirmMsg += `• Météo: ${extracted.meteo}\n`;
    if (extracted.travaux)    confirmMsg += `• Travaux: ${extracted.travaux.slice(0, 100)}\n`;

    if (alertes.length) {
      confirmMsg += `\n🔔 *Alertes:*\n${alertes.join('\n')}`;
    } else {
      confirmMsg += `\n✅ Aucune alerte`;
    }

    confirmMsg += `\n\n🔗 https://www.progev.com/dashboard-direction.html`;

    await sendWhatsApp(senderNum, confirmMsg);

    return res.status(200).send('<Response></Response>');

  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(200).send('<Response></Response>');
  }
};

// ── TROUVER LE CHANTIER PAR NUMÉRO ───────────────────
async function findChantierByNumero(numero) {
  // Chercher dans wa_numeros (table de mapping numéro ↔ chantier)
  const clean = numero.replace(/\s/g, '');
  const resp = await supabaseQuery('GET',
    `/rest/v1/wa_numeros?select=*,chantiers(*),utilisateurs(*)&numero=eq.${encodeURIComponent(clean)}&actif=eq.true&limit=1`
  );

  if (resp && resp.length > 0) {
    const row = resp[0];
    return {
      chantier: row.chantiers,
      user: row.utilisateurs || { id: null }
    };
  }

  // Fallback MVP : premier chantier actif de la base
  const chantiers = await supabaseQuery('GET',
    '/rest/v1/chantiers?statut=eq.en_cours&order=created_at.desc&limit=1'
  );
  const users = await supabaseQuery('GET',
    '/rest/v1/utilisateurs?role=eq.admin&limit=1'
  );

  if (chantiers && chantiers.length > 0) {
    return {
      chantier: chantiers[0],
      user: (users && users.length > 0) ? users[0] : { id: null }
    };
  }

  return null;
}

// ── EXTRAIRE DEPUIS TEXTE ─────────────────────────────
async function extractFromText(text, chantierNom) {
  const prompt = `Tu es un assistant de chantier électrique expert. Analyse ce message envoyé par un chef de chantier marocain (peut être en français, darija, arabe ou mélange).

Message reçu:
"${text}"

Extrait les informations et réponds UNIQUEMENT avec un objet JSON valide, sans aucun texte autour, sans backticks:
{
  "avancement": <nombre entier % ou null si non mentionné>,
  "effectif": <nombre de personnes ou 0>,
  "engins": <nombre d'engins ou 0>,
  "meteo": "<description météo ou null>",
  "travaux": "<description des travaux réalisés>",
  "hse": "<événements HSE ou 'Aucun incident'>",
  "hse_incident": <true si accident/presqu'accident mentionné, sinon false>,
  "livraisons_attente": "<matériaux en attente ou ''>",
  "problemes": "<problèmes/blocages mentionnés ou ''>",
  "decisions": "<décisions prises ou ''>",
  "risques": "<risques mentionnés ou ''>",
  "date": "<date au format YYYY-MM-DD si mentionnée, sinon null>"
}

Interprétation darija:
- "nas" / "khdam" / "3mal" = ouvriers/personnes
- "mafich" / "ma kaynch" = aucun/pas de
- "t'akhrat" / "t2akhret" = retard
- "mzyan" / "meziane" = bien/OK
- "mushkil" / "problème" = problème
- pylône/support/poteau = structure HT`;

  return await callClaude(prompt, null, null);
}

// ── TRAITER NOTE VOCALE ───────────────────────────────
async function processVoiceMessage(mediaUrl, mediaType, chantierNom) {
  // Télécharger le fichier audio depuis Twilio
  let audioBase64 = '';
  try {
    audioBase64 = await downloadAsBase64(mediaUrl);
  } catch(e) {
    console.error('Audio download error:', e);
    return { extracted: null, transcription: '' };
  }

  const prompt = `Tu es un assistant de chantier électrique expert. 
Écoute cette note vocale envoyée par un chef de chantier marocain (peut être en français, darija, arabe ou mélange).

1. D'abord, retranscris exactement ce qui est dit.
2. Ensuite, extrait les informations structurées.

Réponds UNIQUEMENT avec un objet JSON valide, sans aucun texte autour, sans backticks:
{
  "transcription": "<texte exact de l'audio>",
  "avancement": <nombre entier % ou null>,
  "effectif": <nombre de personnes ou 0>,
  "engins": <nombre d'engins ou 0>,
  "meteo": "<météo ou null>",
  "travaux": "<travaux réalisés>",
  "hse": "<événements HSE ou 'Aucun incident'>",
  "hse_incident": <true/false>,
  "livraisons_attente": "<en attente ou ''>",
  "problemes": "<problèmes ou ''>",
  "decisions": "<décisions ou ''>",
  "risques": "<risques ou ''>",
  "date": null
}`;

  const result = await callClaude(prompt, audioBase64, mediaType);
  const transcription = result?.transcription || '';
  return { extracted: result, transcription };
}

// ── GÉNÉRER LE RAPPORT COMPLET ────────────────────────
async function generateRapport(extracted, chantier) {
  const prompt = `Tu es un assistant expert en gestion de chantiers électriques HTB (60kV).
Génère un rapport journalier officiel et professionnel basé sur ces données extraites:

Chantier: ${chantier.nom}
Date: ${extracted.date || new Date().toISOString().split('T')[0]}
Avancement: ${extracted.avancement || 'Non précisé'}%
Effectif: ${extracted.effectif || 0} personnes
Engins: ${extracted.engins || 0}
Météo: ${extracted.meteo || 'Non précisé'}
Travaux réalisés: ${extracted.travaux || 'Non précisé'}
HSE: ${extracted.hse || 'Aucun incident'}
Livraisons en attente: ${extracted.livraisons_attente || 'Aucune'}
Problèmes: ${extracted.problemes || 'Aucun'}
Décisions: ${extracted.decisions || 'Aucune'}
Risques: ${extracted.risques || 'Aucun'}

Rédige un rapport en 8 sections: 1.EN-TÊTE 2.RÉSUMÉ EXÉCUTIF 3.AVANCEMENT 4.ACTIVITÉS DU JOUR 5.HSE 6.APPROVISIONNEMENT 7.PROBLÈMES & ACTIONS 8.PRÉVISIONS J+1. Ton professionnel, termes HT, alertes ⚠️.`;

  const result = await callClaude(prompt, null, null);
  return typeof result === 'string' ? result : JSON.stringify(result);
}

// ── APPEL CLAUDE ──────────────────────────────────────
async function callClaude(prompt, audioBase64, audioMimeType) {
  if (!CLAUDE_KEY) return null;

  const messages = [{
    role: 'user',
    content: audioBase64 ? [
      {
        type: 'document',
        source: {
          type: 'base64',
          media_type: audioMimeType || 'audio/ogg',
          data: audioBase64
        }
      },
      { type: 'text', text: prompt }
    ] : [{ type: 'text', text: prompt }]
  }];

  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: audioBase64 ? 800 : 1500,
    messages
  });

  return new Promise((resolve) => {
    const opts = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      }
    };

    const req = https.request(opts, resp => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.content?.[0]?.text || '';
          // Essayer de parser en JSON d'abord
          try {
            const clean = text.replace(/```json|```/g, '').trim();
            resolve(JSON.parse(clean));
          } catch {
            // Si pas du JSON, retourner le texte brut (pour le rapport)
            resolve(text);
          }
        } catch(e) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ── ENVOYER WHATSAPP ──────────────────────────────────
async function sendWhatsApp(to, message) {
  if (!TWILIO_SID || !TWILIO_TOK) return;
  const toNum = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  const body = new URLSearchParams({
    From: WA_FROM.startsWith('whatsapp:') ? WA_FROM : `whatsapp:${WA_FROM}`,
    To: toNum,
    Body: message
  }).toString();

  return new Promise((resolve) => {
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOK}`).toString('base64');
    const opts = {
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Basic ${auth}`
      }
    };
    const req = https.request(opts, resp => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ── SAUVEGARDER DANS SUPABASE ─────────────────────────
async function saveToSupabase(rapport) {
  return supabaseQuery('POST', '/rest/v1/rapports', {
    ...rapport,
    // Upsert sur chantier_id + date_rapport
  }, 'Prefer: resolution=merge-duplicates');
}

async function supabaseQuery(method, path, body = null, extraHeader = '') {
  return new Promise((resolve) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = {
      'apikey': SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
    };
    if (extraHeader) {
      const [k, v] = extraHeader.split(': ');
      headers[k] = v;
    }
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const url = new URL(SUPA_URL + path);
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers
    };

    const req = https.request(opts, resp => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── TÉLÉCHARGER AUDIO EN BASE64 ───────────────────────
async function downloadAsBase64(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    // Twilio requiert auth pour télécharger les médias
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOK}`).toString('base64');
    const opts = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: { 'Authorization': `Basic ${auth}` }
    };

    const req = protocol.request(opts, resp => {
      // Gérer les redirects
      if (resp.statusCode === 301 || resp.statusCode === 302) {
        return downloadAsBase64(resp.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve(buf.toString('base64'));
      });
    });
    req.on('error', reject);
    req.end();
  });
}
