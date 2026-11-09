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
  // ⚠ Vercel 런타임에 따라 catch-all 파라미터가 'path' 또는 '...path' 키로 노출됨.
  //    (직접 검증 결과 — 적어도 일부 배포에서 '...path' 로 노출. 필터하지 않으면 업스트림
  //     URL 이 https://openapi.playauto.io/api/?...path=shops 가 되어 AWS API Gateway 가
  //     SigV4 를 요구하며 403 을 던짐.)
  const segs = req.query.path || req.query['...path'];
  const subPath = '/' + (Array.isArray(segs) ? segs.join('/') : (segs || ''));

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    // path / splat / ... 으로 시작하는 모든 catch-all 라우팅 키 제외
    if (k === 'path' || k === 'splat' || k.startsWith('...')) continue;
    if (Array.isArray(v)) v.forEach(x => qs.append(k, x));
    else if (v != null) qs.set(k, v);
  }
  const qsStr = qs.toString() ? '?' + qs.toString() : '';
  const upstreamUrl = PA_BASE + subPath + qsStr;
  console.log(`[playauto-vercel ${traceId}] ${req.method} → ${upstreamUrl}  (raw req.url=${req.url}, query keys=${Object.keys(req.query).join(',')})`);

  const bodyJson = (req.method === 'GET' || req.method === 'HEAD' || req.body == null)
    ? undefined
    : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));

  const diag = { traceId, version: 'v5-fulltrace', attempts: [] };

  const _mask = (v) => {
    if (!v) return '';
    const s = String(v);
    if (s.length <= 12) return s.slice(0, 2) + '***' + s.slice(-2) + ` (len=${s.length})`;
    return s.slice(0, 6) + '...' + s.slice(-4) + ` (len=${s.length})`;
  };
  const _maskAuth = (v) => {
    if (!v) return '';
    const parts = String(v).split(' ');
    if (parts.length === 2) return `${parts[0]} ${_mask(parts[1])}`;
    return _mask(v);
  };

  const doRequest = async (authHeaderValue, attemptName) => {
    const realHeaders = {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (authHeaderValue) realHeaders['Authorization'] = authHeaderValue;

    const r = await fetch(upstreamUrl, {
      method: req.method,
      headers: realHeaders,
      body: bodyJson,
    });
    const text = await r.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

    const maskedHeaders = {
      'x-api-key': _mask(apiKey),
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (authHeaderValue) maskedHeaders['Authorization'] = _maskAuth(authHeaderValue);

    const upstreamHeaders = {};
    try { for (const [k, v] of r.headers.entries()) upstreamHeaders[k] = v; } catch (_) {}

    diag.attempts.push({
      name: attemptName,
      authPrefix: authHeaderValue ? authHeaderValue.split(' ')[0] : 'none',
      outgoing: {
        method: req.method,
        url: upstreamUrl,
        headers: maskedHeaders,
        body: bodyJson || null,
      },
      upstream: {
        status: r.status,
        headers: upstreamHeaders,
        body: text.slice(0, 3000),
      },
      status: r.status,
      bodyPreview: text.slice(0, 150),
    });
    return { status: r.status, data };
  };

  // HTTP 헤더는 Latin-1 만 허용 — 한글/유니코드 문자가 포함된 진단 JSON 을
  // 그대로 setHeader 하면 "Invalid character in header content" 500 발생.
  // 안전하게 base64(utf-8) 로 인코딩 후 1900자 이내로 잘라 전송.
  const _safeDiagHeader = (obj) => {
    try {
      const json = JSON.stringify(obj);
      const b64 = Buffer.from(json, 'utf8').toString('base64');
      return b64.slice(0, 1900);
    } catch (_) {
      return '';
    }
  };
  const _setDiagHeaders = (diagObj) => {
    try { res.setHeader('x-pa-trace', traceId); } catch (_) {}
    try { res.setHeader('x-pa-diag-b64', _safeDiagHeader(diagObj)); } catch (_) {}
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

    // 시도 1~3: Token / Bearer / raw 스키마. 전부 401/403 이면 캐시된 토큰이 만료·무효화된 것일 수 있어(예: 다른 곳에서 새 토큰 발급,
    //   서버리스 인스턴스 메모리에 23시간 캐시) 토큰을 강제로 재발급해 한 번 더 시도한다.
    //   (기존에는 마지막 'no-auth' 시도의 일반 메시지 "Forbidden" 만 화면에 나와 원인을 알기 어려웠다.)
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) {
        const authFail = diag.attempts.length > 0 && diag.attempts.every(x => x.status === 401 || x.status === 403);
        if (!token || !authFail) break;
        try {
          token = await getToken(apiKey, authKey, true);
          diag.tokenRefreshed = true;
          diag.tokenLen = token.length;
        } catch (e) {
          diag.tokenRefreshError = String(e.message || e).slice(0, 300);
          break;
        }
      }
      if (!token) break;
      for (const [prefix, name] of [['Token ', 'Token'], ['Bearer ', 'Bearer'], ['', 'raw']]) {
        result = await doRequest(prefix + token, pass === 1 ? name + '#refreshed' : name);
        if (result.status >= 200 && result.status < 300) {
          _setDiagHeaders(diag);
          return res.status(result.status).json(result.data);
        }
      }
    }

    // 시도 4: Authorization 헤더 없음
    result = await doRequest(null, 'no-auth');

    _setDiagHeaders({ traceId, version: diag.version, tokenLen: diag.tokenLen, attemptStatuses: diag.attempts.map(a => ({ name: a.name, status: a.status })) });

    // 실패(4xx/5xx) 응답에는 진단전문(_paProxyDiag) 포함 — 프런트엔드 캡처 버튼이 사용
    const finalStatus = result ? result.status : 500;
    let finalBody;
    if (result && result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
      finalBody = { ...result.data, _paProxyDiag: diag };
    } else {
      finalBody = { upstreamData: result ? result.data : null, _paProxyDiag: diag };
    }
    if (finalStatus === 401 || finalStatus === 403) {
      // 화면에 'Forbidden' 만 보이면 원인을 알기 어려워 시도 결과를 함께 표시
      finalBody.error = 'Forbidden - PlayAuto 인증 실패 (API Key / 솔루션 인증키 확인 필요) [' + diag.attempts.map(x => x.name + ' ' + x.status).join(', ') + (diag.tokenError ? ' | 토큰발급: ' + diag.tokenError : '') + ']';
    }
    res.status(finalStatus).json(finalBody);
  } catch (e) {
    console.error(`[playauto ${traceId}] error:`, e);
    res.setHeader('x-pa-trace', traceId);
    res.status(500).json({ error: e.message || String(e), traceId, diag });
  }
}
