// Vercel Serverless Function — 네이버 쇼핑인사이트 키워드 순위 프록시
// URL: /api/naver-keyword-rank?cid=50000000&days=30&gender=&age=&device=
//
// datalab.naver.com/shoppingInsight/getKeywordRank.naver 를 대신 호출
// → 사진 1의 네이버 쇼핑인사이트 실제 인기 키워드 TOP 500 반환

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const cid = String(req.query.cid || '').trim();
  const days = Math.max(1, Math.min(parseInt(req.query.days || '30', 10), 90));
  const gender = (req.query.gender || '').toString();
  const age = (req.query.age || '').toString();
  const device = (req.query.device || '').toString();
  const timeUnit = (req.query.timeUnit || 'date').toString();

  if (!cid) { res.status(400).json({ error: 'cid required' }); return; }

  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const fmt = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const startDate = fmt(start);
  const endDate = fmt(end);

  const url = 'https://datalab.naver.com/shoppingInsight/getKeywordRank.naver';
  const body = new URLSearchParams({
    cid, timeUnit, startDate, endDate,
    age: Array.isArray(age) ? age.join(',') : age,
    gender, device,
  }).toString();

  try {
    // 1. 쿠키 확보 (메인 페이지 방문)
    const warmup = await fetch('https://datalab.naver.com/shoppingInsight/sCategory.naver', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
    });
    const cookie = (warmup.headers.get('set-cookie') || '').split(',').map(s => s.split(';')[0].trim()).filter(Boolean).join('; ');

    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Origin': 'https://datalab.naver.com',
        'Referer': 'https://datalab.naver.com/shoppingInsight/sCategory.naver',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': cookie,
      },
      body,
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      res.status(502).json({ error: 'naver fetch failed', status: r.status, sample: txt.slice(0, 200) });
      return;
    }

    const data = await r.json();
    const ranks = Array.isArray(data?.ranks) ? data.ranks : (Array.isArray(data) ? data : []);
    const items = ranks.map(k => ({
      rank: Number(k.rank || 0),
      keyword: String(k.keyword || ''),
      linkId: String(k.linkId || ''),
    }));

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
    res.status(200).json({
      cid,
      timeUnit,
      startDate,
      endDate,
      total: items.length,
      items,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
