// Vercel Serverless Function — 네이버 쇼핑 검색 프록시
// URL: /api/naver-shop?query=캠핑의자&start=1&display=40
// 헤더(폴백용): X-Naver-Client-Id, X-Naver-Client-Secret
//
// 동작:
//  1차 시도 — 네이버 쇼핑 웹사이트(search.shopping.naver.com) 스크래핑
//             웹과 동일한 실시간 순위가 나오지만 Vercel IP에서 차단될 수 있음
//  2차 시도 — 1차가 비-200 또는 빈 결과면 공식 Open API(openapi.naver.com)로 폴백
//             클라이언트가 헤더로 Client-Id/Secret을 넘겨줘야 함
//             공식 API는 관련도(sim) 정렬이라 웹 순위와 다를 수 있음

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Naver-Client-Id, X-Naver-Client-Secret');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const query = (req.query.query || '').trim();
  const start = parseInt(req.query.start || '1', 10);
  const display = Math.min(parseInt(req.query.display || '40', 10), 100);
  if (!query) { res.status(400).json({ error: 'query required' }); return; }

  const clientId     = String(req.headers['x-naver-client-id']     || '').trim();
  const clientSecret = String(req.headers['x-naver-client-secret'] || '').trim();

  // ── 1차: 웹 스크래핑 ─────────────────────────
  let scrapeError = null;
  try {
    const result = await tryScrape(query, start, display);
    if (result && result.items.length > 0) {
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
      res.status(200).json({ ...result, source: 'scrape' });
      return;
    }
    scrapeError = result ? 'empty result' : 'no result';
  } catch (e) {
    scrapeError = e.message || String(e);
  }

  // ── 2차: 공식 Open API ──────────────────────
  if (!clientId || !clientSecret) {
    res.status(502).json({
      error: 'scrape failed and no Naver Open API credentials provided',
      scrapeError,
      hint: '프론트에서 X-Naver-Client-Id / X-Naver-Client-Secret 헤더를 보내거나, 키워드 순위 페이지의 "네이버 API 설정"에 키를 등록하세요.',
    });
    return;
  }
  try {
    const result = await tryOfficial(query, start, display, clientId, clientSecret);
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json({ ...result, source: 'openapi', scrapeError });
  } catch (e) {
    res.status(502).json({
      error: 'all paths failed',
      scrapeError,
      officialError: e.message || String(e),
    });
  }
}

// ── 1차: search.shopping.naver.com 스크래핑 ────────────────────
async function tryScrape(query, start, display) {
  const pagingIndex = Math.ceil(start / display);
  const url = `https://search.shopping.naver.com/api/search/all?origQuery=${encodeURIComponent(query)}&pagingIndex=${pagingIndex}&pagingSize=${display}&productSet=total&query=${encodeURIComponent(query)}&sort=rel&viewType=list`;

  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      'Referer': `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(query)}`,
      'urlprefix': '/api',
      'logic': 'PART',
      'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
  });
  if (!r.ok) throw new Error('naver scrape HTTP ' + r.status);

  const data = await r.json();
  const list = data?.shoppingResult?.products || [];
  const items = list.map((p, i) => ({
    rank: (pagingIndex - 1) * display + i + 1,
    productId: String(p.id || p.nvMid || ''),
    title: (p.productTitle || p.productName || '').replace(/<[^>]+>/g, ''),
    link: p.crUrl || p.mallPcUrl || '',
    image: p.imageUrl || '',
    price: Number(p.price || 0),
    mallName: p.mallName || '',
    brand: p.brand || p.maker || '',
    manuTag: p.manuTag || '',
    attributeValue: p.attributeValue || '',
    category1: p.category1Name || '',
    category2: p.category2Name || '',
    category3: p.category3Name || '',
    category4: p.category4Name || '',
    reviewCount: Number(p.reviewCount || 0),
    adId: p.adId || null,
  }));

  // manuTag 집계 (빈도순)
  const manuTagCount = {};
  list.forEach(p => {
    const raw = String(p.manuTag || '').trim();
    if (!raw) return;
    raw.split(/[\s,\/|·]+/).filter(Boolean).forEach(tag => {
      const t = tag.trim();
      if (t) manuTagCount[t] = (manuTagCount[t] || 0) + 1;
    });
  });
  const manuTags = Object.entries(manuTagCount)
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count }));

  return {
    query,
    total: data?.shoppingResult?.total || items.length,
    start,
    display,
    items,
    manuTags,
  };
}

// ── 2차: 공식 Open API ───────────────────────────────────────
// 응답 필드 매핑은 1차(scrape)와 동일한 형태로 맞춤 (프론트가 단일 포맷으로 처리하도록)
async function tryOfficial(query, start, display, clientId, clientSecret) {
  // 공식 API: display 1~100, start 1~1000
  const safeDisplay = Math.min(Math.max(display, 1), 100);
  const safeStart   = Math.min(Math.max(start, 1), 1000);
  const url = `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(query)}&display=${safeDisplay}&start=${safeStart}&sort=sim`;

  const r = await fetch(url, {
    headers: {
      'X-Naver-Client-Id': clientId,
      'X-Naver-Client-Secret': clientSecret,
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error('openapi HTTP ' + r.status + ' ' + body.slice(0, 200));
  }
  const data = await r.json();
  const list = data.items || [];
  const items = list.map((p, i) => ({
    rank: safeStart + i,
    productId: String(p.productId || ''),
    title: (p.title || '').replace(/<[^>]+>/g, ''),
    link: p.link || '',
    image: p.image || '',
    price: Number(p.lprice || 0),
    mallName: p.mallName || '',
    brand: p.brand || p.maker || '',
    manuTag: '',
    attributeValue: '',
    category1: p.category1 || '',
    category2: p.category2 || '',
    category3: p.category3 || '',
    category4: p.category4 || '',
    reviewCount: 0,
    adId: null,
  }));
  return {
    query,
    total: Number(data.total || items.length),
    start: safeStart,
    display: safeDisplay,
    items,
    manuTags: [],
  };
}
