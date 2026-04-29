# Vercel 배포 가이드 — 네이버 쇼핑 실시간 순위 프록시

## 1. 준비

1. [vercel.com](https://vercel.com) 가입 (GitHub 계정 연동 추천)
2. GitHub에 이 프로젝트를 push (이미 되어 있으면 스킵)

## 2. 배포

### 방법 A: Vercel CLI (빠름)

```bash
npm install -g vercel
cd "새 폴더"
vercel
```

- 첫 실행 시 로그인 → 프로젝트 선택/생성 → 배포
- 완료되면 `https://your-project.vercel.app` 주소 발급

### 방법 B: 웹 대시보드

1. vercel.com → **New Project**
2. GitHub 저장소 import
3. **Framework Preset: Other** 선택
4. **Deploy** 클릭

## 3. 동작 확인

브라우저에서:
```
https://your-project.vercel.app/api/naver-shop?query=캠핑의자&display=10
```

JSON 응답 확인. 실패하면 Vercel 대시보드 → Logs 에서 에러 확인.

## 4. 앱 코드 연결

`index.html` 안에서 기존 `_naverShopSearch` 함수를 새 프록시로 교체 (아래 섹션 참고).

---

## 프록시 API 스펙

### GET `/api/naver-shop`

파라미터:
- `query` (필수): 검색 키워드
- `start`: 시작 순위 (기본 1)
- `display`: 한 번에 가져올 개수 (기본 40, 최대 80)

응답:
```json
{
  "query": "캠핑의자",
  "total": 1234567,
  "start": 1,
  "display": 40,
  "items": [
    {
      "rank": 1,
      "productId": "12345...",
      "title": "상품명",
      "link": "상품 URL",
      "image": "이미지 URL",
      "price": 12000,
      "mallName": "판매처",
      "category1": "스포츠/레저",
      "category2": "캠핑",
      "category3": "캠핑의자",
      "reviewCount": 1234,
      "adId": null
    }
  ]
}
```

---

## 로컬 테스트

```bash
npm install -g vercel
vercel dev
```

→ `http://localhost:3000/api/naver-shop?query=테스트` 로 접속

---

## 비용

- Vercel 무료 플랜: 월 100GB 대역폭, 함수 호출 100,000회 → **일반 사용 무료**
- 초과 시: Pro 플랜 $20/월

## 주의

네이버가 봇 탐지를 강화하면 차단될 수 있습니다. 차단 시:
1. `User-Agent`를 다른 브라우저 값으로 교체
2. 요청 빈도를 낮춤 (Cache-Control 연장)
3. 필요 시 여러 프록시 서비스(ScraperAPI, ScrapingBee) 사용
