// Vercel Serverless Function — 백엔드 프록시 생존 확인용
// URL: GET /api/health → { ok: true }
//
// 프론트엔드 _probeBackendProxy()가 이 엔드포인트로 백엔드(=Vercel 함수)
// 가용 여부를 확인합니다. 200 + {ok:true}가 오면 /api/naver-shop 등
// 자체 프록시 경로를 사용하고, 실패하면 외부 CORS 프록시로 폴백합니다.

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, ts: Date.now() });
}
