// Vercel Serverless Function — 네이버 쇼핑 검색 프록시
// URL: /api/naver-shop?query=캠핑의자&start=1&display=40
//
// 실제 네이버 쇼핑 웹사이트(search.shopping.naver.com)를 대신 호출해 JSON으로 반환.
// 웹사이트와 동일한 순위가 나옵니다.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const query = (req.query.query || '').trim();
  const start = parseInt(req.query.start || '1', 10);
  const display = Math.min(parseInt(req.query.display || '40', 10), 80);
  if (!query) { res.status(400).json({ error: 'query required' }); return; }

  const pagingIndex = Math.ceil(start / display);
  const url = `https://search.shopping.naver.com/api/search/all?origQuery=${encodeURIComponent(query)}&pagingIndex=${pagingIndex}&pagingSize=${display}&productSet=total&query=${encodeURIComponent(query)}&sort=rel&viewType=list`;

  try {
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

    if (!r.ok) {
      res.status(502).json({ error: 'naver fetch failed', status: r.status });
      return;
    }

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

    // 전체 manuTag 집계 (빈도순)
    const manuTagCount = {};
    list.forEach(p => {
      const raw = String(p.manuTag || '').trim();
      if (!raw) return;
      // manuTag는 보통 공백/콤마/슬래시 구분 여러 값
      raw.split(/[\s,\/|·]+/).filter(Boolean).forEach(tag => {
        const t = tag.trim();
        if (t) manuTagCount[t] = (manuTagCount[t] || 0) + 1;
      });
    });
    const manuTags = Object.entries(manuTagCount)
      .sort((a, b) => b[1] - a[1])
      .map(([tag, count]) => ({ tag, count }));

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json({
      query,
      total: data?.shoppingResult?.total || items.length,
      start,
      display,
      items,
      manuTags,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
