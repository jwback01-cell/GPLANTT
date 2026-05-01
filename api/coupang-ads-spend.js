// Vercel Serverless Function — 쿠팡 Wing API 광고비(ad reports) 조회
// URL: GET /api/coupang-ads-spend?action=create&from=YYYY-MM-DD&to=YYYY-MM-DD
//      GET /api/coupang-ads-spend?action=poll&reportId=...
// Headers: x-coupang-access-key / x-coupang-secret-key / x-coupang-vendor-id
//
// 비동기 보고서 방식:
//   1) action=create → POST /v2/providers/openapi/apis/api/v1/ad/reports
//   2) action=poll&reportId=... → GET .../reports/{reportId}
//   3) status=COMPLETED 이면 fileUrl 다운로드 + CSV 파싱하여 rows 반환
//
// ⚠ 쿠팡은 IP 화이트리스트 — Vercel 동적 IP 는 거부됨.
// 로컬 (python server.py) 환경에서만 작동.

import crypto from 'crypto';

const COUPANG_BASE = 'https://api-gateway.coupang.com';

function _coupangSign(secretKey, method, path, query) {
  const now = new Date();
  const yy = String(now.getUTCFullYear()).slice(2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mi = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  const datetime = `${yy}${mm}${dd}T${hh}${mi}${ss}Z`;
  const message = datetime + method + path + (query || '');
  const signature = crypto.createHmac('sha256', secretKey).update(message).digest('hex');
  return { datetime, signature };
}

async function coupangCall(accessKey, secretKey, method, path, query, body) {
  const { datetime, signature } = _coupangSign(secretKey, method, path, query);
  const auth = `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${signature}`;
  const url = `${COUPANG_BASE}${path}${query ? '?' + query : ''}`;
  const r = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Authorization': auth,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) {}
  return { ok: r.ok, status: r.status, text, data, url, sentDatetime: datetime };
}

// 매우 단순한 CSV 파서 — 쉼표 구분, 큰따옴표 둘러싸인 값 지원
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };
  const splitLine = (line) => {
    const out = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQ = !inQ; continue; }
      if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    out.push(cur);
    return out;
  };
  const headers = splitLine(lines[0]).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = splitLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => { row[h] = (vals[idx] || '').trim(); });
    rows.push(row);
  }
  return { headers, rows };
}

// CSV/JSON 응답에서 {date, campaign, amount, impCnt, clkCnt} 행으로 정규화
function normalizeAdRows(parsed, fallbackData) {
  const dateKeys = ['date', 'reportDate', 'REPORT_DATE', '날짜', '일자', 'dt'];
  const costKeys = ['cost', 'spend', 'salesAmt', 'adCost', 'AD_COST', 'COST', '광고비', '비용', '집행비용'];
  const campKeys = ['campaign', 'campaignName', 'CAMPAIGN_NAME', 'adGroupName', 'AD_GROUP_NAME', '캠페인', '광고그룹'];
  const impKeys  = ['impression', 'impCnt', 'IMPRESSION', 'IMP_CNT', '노출', '노출수'];
  const clkKeys  = ['click', 'clkCnt', 'CLICK', 'CLK_CNT', '클릭', '클릭수'];

  const findVal = (row, keys) => {
    for (const k of keys) if (row[k] != null && row[k] !== '') return row[k];
    return null;
  };
  const normalizeDate = (v) => {
    const s = String(v || '').trim();
    let m = s.match(/(\d{4})[.\-\/]?(\d{2})[.\-\/]?(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    return null;
  };
  const normalizeNumber = (v) => {
    if (v == null || v === '') return 0;
    const n = Number(String(v).replace(/[,\s원₩]/g, ''));
    return isNaN(n) ? 0 : n;
  };

  const sourceRows = parsed?.rows || (Array.isArray(fallbackData) ? fallbackData : []);
  const out = [];
  for (const r of sourceRows) {
    const date = normalizeDate(findVal(r, dateKeys));
    const amount = normalizeNumber(findVal(r, costKeys));
    if (!date || amount === 0) continue;
    out.push({
      date,
      campaign: String(findVal(r, campKeys) || ''),
      amount,
      impCnt: normalizeNumber(findVal(r, impKeys)),
      clkCnt: normalizeNumber(findVal(r, clkKeys)),
    });
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-coupang-access-key, x-coupang-secret-key, x-coupang-vendor-id');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const accessKey = String(req.headers['x-coupang-access-key'] || '').trim();
  const secretKey = String(req.headers['x-coupang-secret-key'] || '').trim();
  const vendorId  = String(req.headers['x-coupang-vendor-id']  || '').trim();
  if (!accessKey || !secretKey) {
    res.status(400).json({ error: 'access-key, secret-key 헤더 필수' });
    return;
  }

  const action   = String(req.query.action || '').trim() || 'create';
  const reportId = String(req.query.reportId || '').trim();
  const from = String(req.query.from || '').trim();
  const to   = String(req.query.to || '').trim();

  const diag = { steps: [], note: '쿠팡 Wing API — IP 화이트리스트 필요. 로컬에서만 동작.' };

  try {
    // ────────────────────────────────
    // 1) action=create — 보고서 생성 요청
    // ────────────────────────────────
    if (action === 'create') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        res.status(400).json({ error: 'from, to 형식 오류 (YYYY-MM-DD)' });
        return;
      }
      const path = '/v2/providers/openapi/apis/api/v1/ad/reports';
      const body = {
        REPORT_TYPE: 'CAMPAIGN_DAILY',
        START_DATE: from.replace(/-/g, ''),
        END_DATE: to.replace(/-/g, ''),
        FORMAT: 'CSV',
      };
      const r = await coupangCall(accessKey, secretKey, 'POST', path, '', body);
      diag.steps.push({
        step: 'create-report',
        status: r.status,
        url: r.url,
        sentBody: body,
        sentDatetime: r.sentDatetime,
        responseBody: r.text.slice(0, 600),
      });
      if (!r.ok) {
        res.status(r.status).json({
          error: '보고서 생성 실패',
          hint: r.status === 401 ? 'access-key / secret-key 확인. IP 화이트리스트 등록되어 있는지도 확인 (로컬 PC IP).' :
                r.status === 403 ? 'IP 화이트리스트 거부. 본인 PC IP가 쿠팡에 등록되어 있고 변경되지 않았는지 확인.' :
                r.status === 404 ? '엔드포인트 미존재 (Wing API에 광고 보고서 권한 미부여 가능성). 쿠팡 광고센터 → 도구 → API 사용 관리 확인.' :
                undefined,
          detail: r.text.slice(0, 500),
          _diag: diag,
        });
        return;
      }
      const newReportId = r.data?.reportId || r.data?.REPORT_ID || r.data?.data?.reportId
        || (r.data?.data && r.data.data.reportId) || r.data?.id;
      if (!newReportId) {
        res.status(502).json({
          error: '보고서 ID를 응답에서 찾지 못했습니다',
          rawResponse: r.data,
          _diag: diag,
        });
        return;
      }
      res.status(200).json({ pending: true, reportId: newReportId, _diag: diag });
      return;
    }

    // ────────────────────────────────
    // 2) action=poll — 보고서 상태 확인 + 완료 시 다운로드
    // ────────────────────────────────
    if (action === 'poll') {
      if (!reportId) {
        res.status(400).json({ error: 'reportId 필요' });
        return;
      }
      const path = `/v2/providers/openapi/apis/api/v1/ad/reports/${encodeURIComponent(reportId)}`;
      const r = await coupangCall(accessKey, secretKey, 'GET', path, '', null);
      diag.steps.push({
        step: 'poll-report',
        status: r.status,
        url: r.url,
        responseBody: r.text.slice(0, 600),
      });
      if (!r.ok) {
        res.status(r.status).json({
          error: '보고서 상태 조회 실패',
          detail: r.text.slice(0, 500),
          _diag: diag,
        });
        return;
      }
      const status = String(r.data?.status || r.data?.STATUS || r.data?.data?.status || '').toUpperCase();
      const fileUrl = r.data?.fileUrl || r.data?.FILE_URL || r.data?.downloadUrl
        || r.data?.data?.fileUrl || r.data?.data?.downloadUrl;

      // 완료가 아니면 pending 응답
      const doneStates = ['COMPLETED', 'COMPLETE', 'DONE', 'SUCCESS', 'FINISHED'];
      if (!doneStates.includes(status) && !fileUrl) {
        res.status(200).json({ pending: true, status, reportId, _diag: diag });
        return;
      }

      // 완료 — fileUrl 다운로드 또는 inline 데이터 처리
      if (fileUrl) {
        const fr = await fetch(fileUrl);
        const csv = await fr.text();
        diag.steps.push({ step: 'download-file', status: fr.status, fileSize: csv.length, fileUrl });
        const parsed = parseCSV(csv);
        const rows = normalizeAdRows(parsed);
        res.status(200).json({
          pending: false,
          rows,
          total: rows.reduce((a, x) => a + x.amount, 0),
          parsedHeaders: parsed.headers,
          rawRowCount: parsed.rows.length,
          _diag: diag,
        });
        return;
      }
      // inline 데이터 (JSON 응답에 직접 포함되는 경우)
      const inline = r.data?.rows || r.data?.data?.rows || r.data?.data || [];
      const rows = normalizeAdRows(null, inline);
      res.status(200).json({
        pending: false,
        rows,
        total: rows.reduce((a, x) => a + x.amount, 0),
        rawRowCount: Array.isArray(inline) ? inline.length : 0,
        _diag: diag,
      });
      return;
    }

    res.status(400).json({ error: 'action 은 create 또는 poll' });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e), _diag: diag });
  }
}
