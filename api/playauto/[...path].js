// Vercel Serverless Function — 플레이오토 Open API 프록시 (catch-all)
// URL: /api/playauto/* → openapi.playauto.io/api/*
// 헤더: x-pa-key (API 키), x-pa-auth (솔루션 인증키)
//
// 동작:
//  1. POST /auth 로 토큰 발급 (인스턴스 메모리에 23h 캐시)
//  2. 실제 호출에 Authorization: Token <token> + x-api-key 동봉
//  3. 401 응답 시 토큰 강제 재발급 후 1회 재시도
// (netlify/functions/playauto.js 의 로직을 Vercel 시그니처로 이식)

const PA_BASE = 'https://openapi.playauto.io/api';
const TOKEN_TTL_MS = 23 * 3600 * 1000;

const tokenCache = new Map();

async function issueToken(apiKey, authKey) {
  const r = await fetch(PA_BASE + '/auth', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ authentication_key: authKey }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`/auth HTTP ${r.status}: ${text.slice(0, 300)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('/auth 응답 파싱 실패: ' + text.slice(0, 200)); }
  const item = Array.isArray(data) ? data[0] : data;
  const token = item && (item.token || item.access_token || item.Authorization);
  if (!token) throw new Error('/auth 응답에 token 필드 없음. 응답: ' + JSON.stringify(data).slice(0, 300));
  return String(token).trim();
}

async function getToken(apiKey, authKey, force = false) {
  const key = `${apiKey}:${authKey}`;
  const cached = tokenCache.get(key);
  if (!force && cached && Date.now() - cached.issued < TOKEN_TTL_MS) {
    return cached.token;
  }
  const token = await issueToken(apiKey, authKey);
  tokenCache.set(key, { token, issued: Date.now() });
  return token;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-pa-key, x-pa-auth');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const apiKey  = String(req.headers['x-pa-key']  || '').trim();
  const authKey = String(req.headers['x-pa-auth'] || '').trim();
  if (!apiKey)  { res.status(400).json({ error: 'x-pa-key header required' }); return; }
  if (!authKey) { res.status(400).json({ error: 'x-pa-auth header required (솔루션 인증키)' }); return; }
  // 디버그용 추적 ID — Vercel 함수 로그에서 식별 가능
  const traceId = Math.random().toString(36).slice(2, 8);
  console.log(`[playauto ${traceId}] ${req.method} ${req.url} apiKey=${apiKey.slice(0,6)}... authKey=${authKey.slice(0,6)}...`);

  // [...path] 다이내믹 라우트가 segments 배열로 들어옴
  const segs = req.query.path;
  const subPath = '/' + (Array.isArray(segs) ? segs.join('/') : (segs || ''));

  // 쿼리스트링 — path는 라우트 파라미터라 제외
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (k === 'path') continue;
    if (Array.isArray(v)) v.forEach(x => qs.append(k, x));
    else if (v != null) qs.set(k, v);
  }
  const qsStr = qs.toString() ? '?' + qs.toString() : '';
  const upstreamUrl = PA_BASE + subPath + qsStr;

  // body 직렬화 — Vercel은 JSON을 자동 파싱하므로 다시 stringify
  const bodyJson = (req.method === 'GET' || req.method === 'HEAD' || req.body == null)
    ? undefined
    : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));

  // 두 가지 인증 방식 — AWS API Gateway가 어느 쪽을 받는지 단계적으로 시도
  // 1) x-api-key 만 (AWS API Key 인증) — Authorization 없으면 Sigv4 검증 안 함
  // 2) x-api-key + Authorization: Token <token> — server.py 로컬 동작 방식
  const doRequest = async (token, includeAuth) => {
    const headers = {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (includeAuth && token) headers['Authorization'] = `Token ${token}`;
    const r = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: bodyJson,
    });
    const text = await r.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    return { status: r.status, data };
  };

  try {
    // 1차: Authorization 빼고 x-api-key 만 (AWS Sigv4 파싱 회피)
    let { status, data } = await doRequest(null, false);
    console.log(`[playauto ${traceId}] no-auth attempt ${upstreamUrl} → ${status}`);

    // 401/403 → 토큰 발급 후 Authorization 동봉해서 재시도
    const needAuth = status === 401 || status === 403
      || (data && typeof data === 'object' && (data.error_code === 401 || data.error_code === 403));
    if (needAuth) {
      let token = await getToken(apiKey, authKey);
      console.log(`[playauto ${traceId}] retry with token len=${token.length} preview=${token.slice(0,8)}...`);
      ({ status, data } = await doRequest(token, true));
      console.log(`[playauto ${traceId}] auth attempt → ${status}`);

      // 토큰 만료 → 강제 재발급 후 1회 더
      if (status === 401 || (data && typeof data === 'object' && data.error_code === 401)) {
        token = await getToken(apiKey, authKey, true);
        ({ status, data } = await doRequest(token, true));
        console.log(`[playauto ${traceId}] refresh+retry → ${status}`);
      }
    }

    res.status(status).json(data);
  } catch (e) {
    console.error(`[playauto ${traceId}] error:`, e);
    res.status(500).json({ error: e.message || String(e), traceId });
  }
}
