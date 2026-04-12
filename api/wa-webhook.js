// api/wa-webhook.js
// Webhook WhatsApp entrant — alimente le JOURNAL DE CHANTIER
// Les messages sont agrégés dans journal_chantier, pas de rapport automatique
// Le chef de projet décide quand générer le rapport depuis la page journal

const https  = require('https');
const { URL } = require('url');

const SUPA_URL   = process.env.SUPABASE_URL    || 'https://kytoohxfditlhmvzehgj.supabase.co';
const SUPA_KEY   = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt5dG9vaHhmZGl0bGhtdnplaGdqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUzOTk2MzEsImV4cCI6MjA5MDk3NTYzMX0.oMTiAaoYlzY0cryj2pBM9v4si4hHiE0QFSlhiSTRAFA';
const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOK = process.env.TWILIO_AUTH_TOKEN;
const WA_FROM    = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';

module.exports = async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).send('Progev Journal Webhook OK');
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  try {
    const body      = req.body || {};
    const from      = body.From || '';
    const msgBody   = body.Body || '';
    const numMedia  = parseInt(body.NumMedia || '0');
    const mediaUrl  = body.MediaUrl0 || '';
    const mediaType = body.MediaContentType0 || '';
    const senderNum = from.replace('whatsapp:', '').trim();

    if (!senderNum) return res.status(200).send('<Response></Response>');

    // ── 1. Identifier le chantier ──────────────────────
    const chantierInfo = await findChantierByNumero(senderNum);
    if (!chantierInfo) {
      await sendWA(senderNum, `❌ Numéro non reconnu dans Progev.\nContactez votre chef de projet pour configurer votre accès.`);
      return res.status(200).send('<Response></Response>');
    }
    const { chantier, user } = chantierInfo;

    // ── 2. Extraire le contenu du message ─────────────
    let texteExtrait = '';
    let transcription = '';
    const isAudio = numMedia > 0 && mediaType.startsWith('audio');

    if (isAudio && mediaUrl) {
      const result  = await processVoice(mediaUrl, mediaType);
      texteExtrait  = result.texte;
      transcription = result.transcription;
    } else if (msgBody && msgBody.trim().length > 2) {
      texteExtrait = msgBody.trim();
    } else {
      await sendWA(senderNum, `👋 Envoyez un message ou une note vocale décrivant l'avancement du chantier.\n\nExemple:\n"Liouma derna 8 pylônes, 22 ouvriers, mafich incident"`);
      return res.status(200).send('<Response></Response>');
    }

    // ── 3. Alerte instantanée HSE ─────────────────────
    const hseCheck = texteExtrait.toLowerCase();
    const isHSE = hseCheck.includes('accident') || hseCheck.includes('blesse') || hseCheck.includes('blessé') || hseCheck.includes('incident') || hseCheck.includes('presqu');
    if (isHSE) {
      await sendWA(senderNum, `🔴 *ALERTE HSE détectée*\nMessage reçu et transmis au chef de projet.\nChantier: ${chantier.nom}`);
    }

    // ── 4. Récupérer ou créer le journal du jour ──────
    const today   = new Date().toISOString().split('T')[0];
    const journal = await upsertJournal(chantier.id, today, user?.id);

    if (!journal) {
      await sendWA(senderNum, `⚠️ Erreur système. Réessayez dans quelques instants.`);
      return res.status(200).send('<Response></Response>');
    }

    // ── 5. Ajouter le message au journal ──────────────
    const heure = new Date().toLocaleTimeString('fr-MA', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Casablanca'
    });
    const nouveauMsg = {
      heure,
      texte: texteExtrait,
      transcription: transcription || null,
      source: isAudio ? 'vocal' : 'texte',
      expediteur: senderNum,
    };
    const messagesMAJ = [...(journal.messages || []), nouveauMsg];

    // ── 6. Agréger tous les messages du jour ──────────
    const agregation = await agregerJournal(messagesMAJ, chantier.nom, journal);

    // ── 7. Mettre à jour le journal dans Supabase ─────
    await supabaseQuery('PATCH',
      `/rest/v1/journal_chantier?id=eq.${journal.id}`,
      {
        messages:           messagesMAJ,
        travaux_realises:   agregation.travaux   || journal.travaux_realises,
        effectif:           agregation.effectif  || journal.effectif,
        engins:             agregation.engins    || journal.engins,
        meteo:              agregation.meteo     || journal.meteo,
        hse_evenements:     agregation.hse       || journal.hse_evenements,
        hse_incident:       isHSE || agregation.hse_incident || journal.hse_incident || false,
        livraisons_attente: agregation.livraisons_attente || journal.livraisons_attente,
        problemes:          agregation.problemes || journal.problemes,
        decisions:          agregation.decisions || journal.decisions,
        risques:            agregation.risques   || journal.risques,
        updated_at:         new Date().toISOString(),
      }
    );

    // ── 8. Confirmation au chef de chantier ───────────
    const nbMessages = messagesMAJ.length;
    let confirm  = `✅ *Message ${nbMessages} enregistré — ${chantier.nom}*\n`;
    confirm += `📅 Journal du ${today}\n\n`;

    if (transcription) {
      confirm += `🎙 _"${transcription.slice(0, 150)}${transcription.length > 150 ? '...' : ''}"_\n\n`;
    }

    if (agregation.effectif)           confirm += `👷 Effectif: ${agregation.effectif} pers.\n`;
    if (agregation.travaux)            confirm += `🔧 ${agregation.travaux.slice(0, 100)}\n`;
    if (agregation.meteo)              confirm += `🌤 Météo: ${agregation.meteo}\n`;
    if (agregation.livraisons_attente) confirm += `⚠️ En attente: ${agregation.livraisons_attente}\n`;
    if (agregation.problemes)          confirm += `⚠️ Problème: ${agregation.problemes}\n`;

    confirm += `\n📋 Le chef de projet consultera le journal et générera le rapport officiel:\n`;
    confirm += `🔗 https://www.progev.com/journal.html`;

    await sendWA(senderNum, confirm);
    return res.status(200).send('<Response></Response>');

  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(200).send('<Response></Response>');
  }
};

// ── TROUVER LE CHANTIER ────────────────────────────────
async function findChantierByNumero(numero) {
  const clean = numero.replace(/\s/g, '');
  const resp  = await supabaseQuery('GET',
    `/rest/v1/wa_numeros?select=*,chantiers(*),utilisateurs(*)&numero=eq.${encodeURIComponent(clean)}&actif=eq.true&limit=1`
  );
  if (resp && resp.length > 0 && resp[0].chantiers) {
    return { chantier: resp[0].chantiers, user: resp[0].utilisateurs || { id: null } };
  }
  // Fallback MVP : premier chantier actif
  const chantiers = await supabaseQuery('GET', '/rest/v1/chantiers?statut=eq.en_cours&order=created_at.desc&limit=1');
  const users     = await supabaseQuery('GET', '/rest/v1/utilisateurs?role=eq.admin&limit=1');
  if (chantiers && chantiers.length > 0) {
    return { chantier: chantiers[0], user: (users && users.length > 0) ? users[0] : { id: null } };
  }
  return null;
}

// ── CRÉER OU RÉCUPÉRER LE JOURNAL DU JOUR ─────────────
async function upsertJournal(chantierId, date, userId) {
  const existing = await supabaseQuery('GET',
    `/rest/v1/journal_chantier?chantier_id=eq.${chantierId}&date_journal=eq.${date}&limit=1`
  );
  if (existing && existing.length > 0) return existing[0];
  const created = await supabaseQuery('POST',
    '/rest/v1/journal_chantier',
    { chantier_id: chantierId, date_journal: date, cree_par: userId || null, messages: [], statut: 'brouillon' },
    'return=representation'
  );
  return created && created.length > 0 ? created[0] : null;
}

// ── AGRÉGER LES MESSAGES DU JOUR ──────────────────────
async function agregerJournal(messages, chantierNom, journalActuel) {
  if (!CLAUDE_KEY || !messages.length) return {};
  const historique = messages.map(m => `[${m.heure}] ${m.texte}`).join('\n');
  const prompt = `Tu es assistant expert chantiers électriques HTB.
Voici TOUS les messages du jour pour "${chantierNom}":
${historique}

Données déjà enregistrées: effectif=${journalActuel.effectif||'?'}, travaux=${journalActuel.travaux_realises||'?'}

Agrège en synthèse cohérente. Si contradiction, garde la plus récente.
Réponds UNIQUEMENT JSON sans backticks:
{"effectif":null,"engins":null,"meteo":null,"travaux":"","hse":"Aucun incident","hse_incident":false,"livraisons_attente":"","problemes":"","decisions":"","risques":"","quantites":[{"activite":"","quantite":0,"unite":""}]}
Darija: nas/khdam=ouvriers, mafich=aucun, t'akhrat=retard, derna=on a fait`;
  return await callClaude(prompt);
}

// ── TRAITER NOTE VOCALE ────────────────────────────────
async function processVoice(mediaUrl, mediaType) {
  let audioBase64 = '';
  try { audioBase64 = await downloadBase64(mediaUrl); }
  catch(e) { return { texte: '', transcription: '' }; }
  const prompt = `Note vocale d'un chef de chantier marocain (français/darija/arabe).
Transcris et résume en français.
Réponds UNIQUEMENT JSON sans backticks:
{"transcription":"<texte exact>","resume_fr":"<résumé français clair>"}`;
  const result = await callClaude(prompt, audioBase64, mediaType);
  return { texte: result?.resume_fr || result?.transcription || '', transcription: result?.transcription || '' };
}

// ── APPEL CLAUDE ───────────────────────────────────────
async function callClaude(prompt, audioBase64, audioMime) {
  if (!CLAUDE_KEY) return {};
  const content = audioBase64
    ? [{ type: 'document', source: { type: 'base64', media_type: audioMime || 'audio/ogg', data: audioBase64 } }, { type: 'text', text: prompt }]
    : [{ type: 'text', text: prompt }];
  const bodyStr = JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 600, messages: [{ role: 'user', content }] });
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' }
    }, resp => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => {
        try { resolve(JSON.parse(JSON.parse(d).content?.[0]?.text?.replace(/```json|```/g,'').trim() || '{}')); }
        catch { resolve({}); }
      });
    });
    req.on('error', () => resolve({}));
    req.write(bodyStr); req.end();
  });
}

// ── ENVOYER WHATSAPP ───────────────────────────────────
async function sendWA(to, message) {
  if (!TWILIO_SID || !TWILIO_TOK) return;
  const toNum   = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  const fromNum = WA_FROM.startsWith('whatsapp:') ? WA_FROM : `whatsapp:${WA_FROM}`;
  const body    = new URLSearchParams({ From: fromNum, To: toNum, Body: message }).toString();
  return new Promise(resolve => {
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOK}`).toString('base64');
    const req  = https.request({
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'Authorization': `Basic ${auth}` }
    }, resp => { let d=''; resp.on('data',c=>d+=c); resp.on('end',()=>resolve(JSON.parse(d))); });
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
}

// ── SUPABASE ───────────────────────────────────────────
async function supabaseQuery(method, path, body = null, prefer = '') {
  return new Promise(resolve => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json' };
    if (prefer) headers['Prefer'] = prefer;
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const url = new URL(SUPA_URL + path);
    const req = https.request({ hostname: url.hostname, path: url.pathname + url.search, method, headers }, resp => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── TÉLÉCHARGER AUDIO ──────────────────────────────────
async function downloadBase64(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const auth   = Buffer.from(`${TWILIO_SID}:${TWILIO_TOK}`).toString('base64');
    const req    = https.request({
      hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'GET',
      headers: { 'Authorization': `Basic ${auth}` }
    }, resp => {
      if (resp.statusCode === 301 || resp.statusCode === 302) {
        return downloadBase64(resp.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
    });
    req.on('error', reject); req.end();
  });
}
