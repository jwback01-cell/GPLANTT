// Netlify Function — 플레이오토 Open API 프록시
// 라우팅: /api/playauto/* → /.netlify/functions/playauto/* (netlify.toml 리다이렉트)
// server.py 의 proxy_playauto 로직을 Node.js 로 이식

const PA_BASE = 'https://openapi.playauto.io/api';
const TOKEN_TTL_MS = 23 * 3600 * 1000; // 23시간 (24h 만료 여유)

// 함수 인스턴스 메모리에 토큰 캐시 (cold-start 시 초기화됨)
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
  if (!r.ok) throw new Error(`/auth HTTP ${r.status}: ${text.slice(0, 200)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('/auth 응답 파싱 실패'); }
  const item = Array.isArray(data) ? data[0] : data;
  const token = item && item.token;
  if (!token) throw new Error('/auth 응답에 token 없음');
  return token;
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

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-pa-key, x-pa-auth',
};

function getHeader(headers, name) {
  if (!headers) return '';
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k] || '';
  }
  return '';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  const apiKey = getHeader(event.headers, 'x-pa-key');
  const authKey = getHeader(event.headers, 'x-pa-auth');
  if (!apiKey) {
    return { statusCode: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'x-pa-key header required' }) };
  }
  if (!authKey) {
    return { statusCode: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'x-pa-auth header required (솔루션 인증키)' }) };
  }

  // 원본 URL 경로에서 /api/playauto 또는 /.netlify/functions/playauto 접두 제거
  let path = event.path || '';
  path = path.replace(/^\/\.netlify\/functions\/playauto/, '');
  path = path.replace(/^\/api\/playauto/, '');
  if (!path.startsWith('/')) path = '/' + path;

  let qsStr = '';
  if (event.rawQuery) {
    qsStr = '?' + event.rawQuery;
  } else if (event.queryStringParameters && Object.keys(event.queryStringParameters).length) {
    qsStr = '?' + new URLSearchParams(event.queryStringParameters).toString();
  }
  const upstreamUrl = PA_BASE + path + qsStr;

  const doRequest = async (token) => {
    const r = await fetch(upstreamUrl, {
      method: event.httpMethod,
      headers: {
        'x-api-key': apiKey,
        'Authorization': `Token ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: event.httpMethod !== 'GET' && event.body ? event.body : undefined,
    });
    const text = await r.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch { data = { raw: text }; }
    return { status: r.status, data };
  };

  try {
    let token = await getToken(apiKey, authKey);
    let { status, data } = await doRequest(token);

    // HTTP 401 또는 응답 본문 error_code=401 → 토큰 재발급 후 1회 재시도
    const needsRefresh = status === 401 || (data && typeof data === 'object' && data.error_code === 401);
    if (needsRefresh) {
      token = await getToken(apiKey, authKey, true);
      ({ status, data } = await doRequest(token));
    }

    return {
      statusCode: status,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e.message }),
    };
  }
};
