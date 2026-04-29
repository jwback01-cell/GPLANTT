// Vercel Serverless Function — 네이버 검색광고 API (월 검색량 / 연관 키워드)
// URL: GET /api/naver-searchad?hint=티셔츠
// Headers:
//   x-naver-sa-customer  : CUSTOMER_ID (숫자)
//   x-naver-sa-license   : ACCESS_LICENSE
//   x-naver-sa-secret    : SECRET_KEY
//
// 응답 필드 (네이버 검색광고 키워드도구 원본 그대로):
//   keywordList[]:
//     - relKeyword                연관 키워드
//     - monthlyPcQcCnt            월 PC 검색수
//     - monthlyMobileQcCnt        월 모바일 검색수
//     - monthlyAvePcClkCnt        월 평균 PC 클릭수
//     - monthlyAveMobileClkCnt    월 평균 모바일 클릭수
//     - monthlyAvePcCtr           월 평균 PC 클릭률 (%)
//     - monthlyAveMobileCtr       월 평균 모바일 클릭률 (%)
//     - plAvgDepth                평균 광고 노출 개수
//     - compIdx                   경쟁정도 (낮음/중간/높음)

import crypto from 'crypto';

const SA_BASE_URL = 'https://api.searchad.naver.com';

function _saSignature(secretKey, timestamp, method, uri) {
  const message = `${timestamp}.${method}.${uri}`;
  return crypto.createHmac('sha256', secretKey).update(message).digest('base64');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-naver-sa-customer, x-naver-sa-license, x-naver-sa-secret');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const hint = String(req.query.hint || '').trim();
  if (!hint) { res.status(400).json({ error: 'hint required' }); return; }

  const customerId    = String(req.headers['x-naver-sa-customer'] || '').trim();
  const accessLicense = String(req.headers['x-naver-sa-license']  || '').trim();
  const secretKey     = String(req.headers['x-naver-sa-secret']   || '').trim();
  if (!customerId || !accessLicense || !secretKey) {
    res.status(400).json({ error: '검색광고 API 키 3종이 모두 필요합니다 (customer / license / secret)' });
    return;
  }

  const method = 'GET';
  const uri = '/keywordstool';
  const timestamp = String(Date.now());
  const signature = _saSignature(secretKey, timestamp, method, uri);

  const qs = new URLSearchParams({ hintKeywords: hint, showDetail: '1' }).toString();
  const url = `${SA_BASE_URL}${uri}?${qs}`;

  try {
    const r = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Timestamp': timestamp,
        'X-API-KEY': accessLicense,
        'X-Customer': customerId,
        'X-Signature': signature,
      },
    });

    const text = await r.text();
    if (!r.ok) {
      res.status(r.status).json({
        error: `searchad HTTP ${r.status}`,
        detail: text.slice(0, 500),
      });
      return;
    }

    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (e) {
      res.status(502).json({ error: 'invalid JSON from searchad', detail: text.slice(0, 500) });
      return;
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
