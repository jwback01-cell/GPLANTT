// Vercel Serverless Function — 플레이오토 Open API 프록시
// URL: /api/playauto-proxy?path=/orders&x-pa-key=YOUR_KEY&...extra_params

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-pa-key');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const apiKey = req.headers['x-pa-key'] || req.query['x-pa-key'] || '';
  const path = req.query.path || '';
  if (!apiKey) { res.status(400).json({ error: 'x-pa-key required' }); return; }
  if (!path) { res.status(400).json({ error: 'path required' }); return; }

  // query params 중 path, x-pa-key 제외한 나머지를 upstream으로 전달
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (k !== 'path' && k !== 'x-pa-key') qs.set(k, v);
  }
  const qsStr = qs.toString() ? '?' + qs.toString() : '';
  const url = `https://openapi.playauto.io/api${path}${qsStr}`;

  try {
    const r = await fetch(url, {
      method: req.method,
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
    });

    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
