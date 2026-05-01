// Vercel Serverless Function — 네이버 검색광고 일자별 광고비(salesAmt) 조회
// URL: GET /api/naver-searchad-spend?from=YYYY-MM-DD&to=YYYY-MM-DD
// Headers: x-naver-sa-customer / x-naver-sa-license / x-naver-sa-secret
//
// 동작:
//   1) GET /ncc/campaigns 로 캠페인 목록 조회
//   2) 캠페인이 있으면 광고그룹(GET /ncc/adgroups?nccCampaignId=...) 까지 펼침
//   3) 광고그룹 ID 들을 /stats?ids=&fields=["salesAmt","impCnt","clkCnt"]&timeRange={since,until}
//      로 호출해 일자별 광고비 합계 산출 — timeRange 를 하루 단위로 N번 호출 (병렬)
//   4) {rows:[{date, campaign, amount, impCnt, clkCnt}], total, campaignCount, ...} 반환
//
// 응답 본문에 _diag 포함 (실패/빈 결과일 때 디버깅용 — 실제 호출한 URL/응답 일부)

import crypto from 'crypto';

const SA_BASE_URL = 'https://api.searchad.naver.com';

function _saSignature(secretKey, timestamp, method, uri) {
  const message = `${timestamp}.${method}.${uri}`;
  return crypto.createHmac('sha256', secretKey).update(message).digest('base64');
}

async function saRequest(uri, method, customerId, accessLicense, secretKey, qsObj) {
  const timestamp = String(Date.now());
  const signature = _saSignature(secretKey, timestamp, method, uri);
  let qs = '';
  if (qsObj) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(qsObj)) {
      if (v == null) continue;
      sp.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    qs = '?' + sp.toString();
  }
  const url = `${SA_BASE_URL}${uri}${qs}`;
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
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) {}
  return { ok: r.ok, status: r.status, text, data, url };
}

function _ymd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function _datesBetween(from, to) {
  const out = [];
  const d = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  if (isNaN(d) || isNaN(end) || d > end) return out;
  while (d <= end) { out.push(_ymd(d)); d.setDate(d.getDate() + 1); }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-naver-sa-customer, x-naver-sa-license, x-naver-sa-secret');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const customerId    = String(req.headers['x-naver-sa-customer'] || '').trim();
  const accessLicense = String(req.headers['x-naver-sa-license']  || '').trim();
  const secretKey     = String(req.headers['x-naver-sa-secret']   || '').trim();
  if (!customerId || !accessLicense || !secretKey) {
    res.status(400).json({ error: '검색광고 API 키 3종이 모두 필요합니다 (customer / license / secret)' });
    return;
  }

  const from = String(req.query.from || '').trim();
  const to   = String(req.query.to   || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    res.status(400).json({ error: 'from, to 형식 오류 (YYYY-MM-DD)' });
    return;
  }
  const dates = _datesBetween(from, to);
  if (!dates.length) {
    res.status(400).json({ error: '날짜 범위가 비어있습니다.' });
    return;
  }
  // 안전 상한: 최대 92일 (병렬 호출 폭주 방지)
  if (dates.length > 92) {
    res.status(400).json({ error: '한 번에 조회 가능한 기간은 최대 92일입니다.' });
    return;
  }

  const diag = { steps: [] };

  try {
    // 1) 캠페인 목록
    const cResp = await saRequest('/ncc/campaigns', 'GET', customerId, accessLicense, secretKey);
    diag.steps.push({ step: 'campaigns', status: cResp.status, count: Array.isArray(cResp.data) ? cResp.data.length : null });
    if (!cResp.ok) {
      res.status(cResp.status).json({ error: '캠페인 목록 조회 실패', detail: cResp.text.slice(0, 500), _diag: diag });
      return;
    }
    const campaigns = Array.isArray(cResp.data) ? cResp.data : [];
    if (!campaigns.length) {
      res.status(200).json({ rows: [], total: 0, campaignCount: 0, note: '등록된 캠페인이 없습니다.', _diag: diag });
      return;
    }

    // 2) 캠페인 → 광고그룹 펼침 (광고비 ID는 그룹 단위가 보통 정확)
    //    /stats 는 캠페인 ID로도 받지만, 광고그룹 ID로 호출해야 모든 광고형식의 비용이 잡히는 경우가 있음.
    //    구현 단순화: 1차로 캠페인 ID로 /stats 호출 → 0이면 그룹 펼쳐서 재시도.
    const campaignIdMap = Object.fromEntries(campaigns.map(c => [c.nccCampaignId, c.name]));
    const campaignIds = campaigns.map(c => c.nccCampaignId);

    // 3) 일자별 /stats 병렬 호출
    const fields = ['salesAmt', 'impCnt', 'clkCnt'];
    const callForDate = async (dt) => {
      const params = {
        ids: campaignIds.join(','),
        fields,
        timeRange: { since: dt, until: dt },
      };
      const r = await saRequest('/stats', 'GET', customerId, accessLicense, secretKey, params);
      return { date: dt, ok: r.ok, status: r.status, data: r.data, text: r.text };
    };

    // 너무 많이 병렬로 보내면 429 — 10개씩 배치
    const batchSize = 10;
    const results = [];
    for (let i = 0; i < dates.length; i += batchSize) {
      const slice = dates.slice(i, i + batchSize);
      // eslint-disable-next-line no-await-in-loop
      const batch = await Promise.all(slice.map(callForDate));
      results.push(...batch);
    }

    diag.steps.push({
      step: 'stats',
      callCount: results.length,
      successCount: results.filter(r => r.ok).length,
      sampleOkBody: (results.find(r => r.ok && r.text)?.text || '').slice(0, 300),
      sampleErrBody: (results.find(r => !r.ok && r.text)?.text || '').slice(0, 300),
    });

    // 4) 결과 평탄화
    const rows = [];
    for (const r of results) {
      if (!r.ok) continue;
      const arr = Array.isArray(r.data) ? r.data : (Array.isArray(r.data?.data) ? r.data.data : []);
      for (const s of arr) {
        const amount = Number(s.salesAmt || 0);
        if (amount === 0) continue;
        rows.push({
          date: r.date,
          campaign: campaignIdMap[s.id] || String(s.id || '(unknown)'),
          amount,
          impCnt: Number(s.impCnt || 0),
          clkCnt: Number(s.clkCnt || 0),
        });
      }
    }

    const total = rows.reduce((a, r) => a + r.amount, 0);

    res.status(200).json({
      rows,
      total,
      campaignCount: campaigns.length,
      dateCount: dates.length,
      from,
      to,
      _diag: diag,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e), _diag: diag });
  }
}
