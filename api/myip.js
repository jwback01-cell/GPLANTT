// 이 서버(Vercel 함수)가 외부로 나갈 때 쓰는 IP 확인용 — 플레이오토 허용 IP 등록 시 대조
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 4000);
    const r = await fetch('https://api.ipify.org?format=json', { signal: ac.signal });
    clearTimeout(tm);
    const j = await r.json();
    res.status(200).json({ ip: j.ip, region: process.env.VERCEL_REGION || '', at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
