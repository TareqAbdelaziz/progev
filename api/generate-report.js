// api/generate-report.js
// Vercel Serverless Function — proxy sécurisé vers l'API Claude
// Ce fichier doit être placé dans le dossier /api/ de ton repo GitHub

export default async function handler(req, res) {

  // Autoriser uniquement les requêtes POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  // Lire la clé API depuis les variables d'environnement Vercel
  const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
  if (!CLAUDE_KEY) {
    return res.status(500).json({ error: 'Clé API non configurée sur Vercel' });
  }

  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt manquant' });
    }

    // Appel à l'API Claude
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Erreur Claude API:', errorData);
      return res.status(response.status).json({ error: 'Erreur API Claude', details: errorData });
    }

    const data = await response.json();
    const text = data.content?.map(c => c.text || '').join('') || '';

    return res.status(200).json({ text });

  } catch (error) {
    console.error('Erreur serveur:', error);
    return res.status(500).json({ error: 'Erreur serveur interne' });
  }
}

