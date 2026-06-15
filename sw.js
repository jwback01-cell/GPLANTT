// GPLAN 서비스워커 — PWA 설치 가능 조건(fetch 핸들러) 충족용.
// 앱이 자주 업데이트되므로 캐시하지 않고 네트워크로만 전달(항상 최신 유지).
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => {
  // 네트워크 우선(캐시 미사용) — 실패 시 그대로 에러 전달
  e.respondWith(fetch(e.request).catch(() => Response.error()));
});
