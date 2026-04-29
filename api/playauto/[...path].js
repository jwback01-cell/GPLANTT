// Vercel Serverless Function — 플레이오토 Open API 프록시 (catch-all)
// URL: /api/playauto/* → openapi.playauto.io/api/*
// 헤더: x-pa-key (API 키), x-pa-auth (솔루션 인증키)

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
  // HTTP 헤더에 들어갈 수 없는 공백/제어문자 제거 (\r, \n, \t)
  return String(token).replace(/[\r\n\t]/g, '').trim();
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-pa-key, x-pa-auth');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const apiKey  = String(req.headers['x-pa-key']  || '').trim();
  const authKey = String(req.headers['x-pa-auth'] || '').trim();
  if (!apiKey)  { res.status(400).json({ error: 'x-pa-key header required' }); return; }
  if (!authKey) { res.status(400).json({ error: 'x-pa-auth header required' }); return; }

  const traceId = Math.random().toString(36).slice(2, 8);

  // [...path] catch-all 경로
  const segs = req.query.path;
  const subPath = '/' + (Array.isArray(segs) ? segs.join('/') : (segs || ''));

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (k === 'path') continue;
    if (Array.isArray(v)) v.forEach(x => qs.append(k, x));
    else if (v != null) qs.set(k, v);
  }
  const qsStr = qs.toString() ? '?' + qs.toString() : '';
  const upstreamUrl = PA_BASE + subPath + qsStr;

  const bodyJson = (req.method === 'GET' || req.method === 'HEAD' || req.body == null)
    ? undefined
    : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));

  const diag = { traceId, version: 'v4-bearer-test', attempts: [] };

  const doRequest = async (authHeaderValue) => {
    const headers = {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (authHeaderValue) headers['Authorization'] = authHeaderValue;
    const r = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: bodyJson,
    });
    const text = await r.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    diag.attempts.push({
      authPrefix: authHeaderValue ? authHeaderValue.split(' ')[0] : 'none',
      status: r.status,
      bodyPreview: text.slice(0, 150),
    });
    return { status: r.status, data };
  };

  try {
    let token;
    try {
      token = await getToken(apiKey, authKey);
      diag.tokenLen = token.length;
      diag.tokenPrefix = token.slice(0, 12);
      diag.tokenSuffix = token.slice(-6);
      diag.tokenHasSpace = /\s/.test(token);
      diag.tokenHasDot = token.includes('.');
    } catch (e) {
      diag.tokenError = String(e.message || e).slice(0, 300);
    }

    let result;

    // 시도 1: Token <token>
    if (token) {
      result = await doRequest(`Token ${token}`);
      if (result.status >= 200 && result.status < 300) {
        res.setHeader('x-pa-trace', traceId);
        res.setHeader('x-pa-diag', JSON.stringify(diag).slice(0, 1900));
        return res.status(result.status).json(result.data);
      }
    }

    // 시도 2: Bearer <token>
    if (token) {
      result = await doRequest(`Bearer ${token}`);
      if (result.status >= 200 && result.status < 300) {
        res.setHeader('x-pa-trace', traceId);
        res.setHeader('x-pa-diag', JSON.stringify(diag).slice(0, 1900));
        return res.status(result.status).json(result.data);
      }
    }

    // 시도 3: 그냥 <token> (스키마 없음)
    if (token) {
      result = await doRequest(token);
      if (result.status >= 200 && result.status < 300) {
        res.setHeader('x-pa-trace', traceId);
        res.setHeader('x-pa-diag', JSON.stringify(diag).slice(0, 1900));
        return res.status(result.status).json(result.data);
      }
    }

    // 시도 4: Authorization 헤더 없음
    result = await doRequest(null);

    res.setHeader('x-pa-trace', traceId);
    res.setHeader('x-pa-diag', JSON.stringify(diag).slice(0, 1900));
    res.status(result ? result.status : 500).json(result ? result.data : { error: 'no result' });
  } catch (e) {
    console.error(`[playauto ${traceId}] error:`, e);
    res.setHeader('x-pa-trace', traceId);
    res.status(500).json({ error: e.message || String(e), traceId, diag });
  }
}
