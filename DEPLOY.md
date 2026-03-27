# 배포 가이드 — 카페24 판매관리 시스템

## 프로젝트 최종 구조

```
cafe24-api/
├── public/
│   ├── index.html          ← 메인 대시보드 (React CDN)
│   └── setup.html          ← API 설정 페이지
├── src/
│   ├── cafe24-client.js    ← 카페24 API 클라이언트
│   └── server.js           ← Express 서버 (API + 정적파일 서빙)
├── db/
│   └── schema.sql          ← PostgreSQL 통합 스키마
├── scripts/                ← 테스트 스크립트
├── .env.example
├── .gitignore
├── Dockerfile              ← Docker 배포용
├── railway.toml            ← Railway 배포 설정
├── render.yaml             ← Render 배포 설정
├── package.json
└── DEPLOY.md               ← (이 파일)
```

---

## 방법 1: Railway 배포 (추천)

Railway는 GitHub 연동으로 자동 배포되며 무료 크레딧이 있습니다.

### 1단계: GitHub 저장소 생성

```bash
cd cafe24-api
git init
git add .
git commit -m "카페24 판매관리 시스템 v1.0"

# GitHub에서 새 저장소 생성 후
git remote add origin https://github.com/YOUR_USERNAME/cafe24-sales-manager.git
git push -u origin main
```

### 2단계: Railway 프로젝트 생성

1. [railway.app](https://railway.app) 접속 → GitHub 로그인
2. "New Project" → "Deploy from GitHub repo" 선택
3. 방금 만든 저장소 선택
4. 자동으로 빌드 시작 (railway.toml 감지)

### 3단계: 환경변수 설정

Railway 대시보드 → 프로젝트 → Variables 탭에서 추가:

```
CAFE24_MALL_ID=본인쇼핑몰ID
CAFE24_CLIENT_ID=mfm3Yy1HVK9bfGTueR9TPK
CAFE24_CLIENT_SECRET=본인시크릿키
CAFE24_REDIRECT_URI=https://your-app.up.railway.app/auth/callback
PORT=3000
NODE_ENV=production
```

> **중요**: CAFE24_REDIRECT_URI를 Railway에서 부여한 도메인으로 변경하세요.
> Railway 대시보드 → Settings → Domains에서 확인 가능합니다.
> 카페24 개발자센터의 Redirect URI도 동일하게 변경해야 합니다.

### 4단계: 도메인 확인 & 접속

- 배포 완료 후 Railway가 자동 부여한 URL로 접속
- `https://your-app.up.railway.app` → 대시보드
- `https://your-app.up.railway.app/setup.html` → API 설정
- `https://your-app.up.railway.app/auth/login` → OAuth 인증 시작

---

## 방법 2: Render 배포 (무료 티어)

### 1단계: GitHub 저장소 (위와 동일)

### 2단계: Render 프로젝트 생성

1. [render.com](https://render.com) 접속 → GitHub 로그인
2. "New" → "Web Service" → 저장소 선택
3. 설정:
   - **Build Command**: `npm install`
   - **Start Command**: `node src/server.js`
4. Environment 탭에서 환경변수 추가 (Railway와 동일)

### 주의사항
- Render 무료 티어는 15분 미사용시 슬립됩니다
- 첫 접속시 약 30초 정도 웨이크업 시간이 있습니다

---

## 방법 3: Fly.io 배포

```bash
# Fly CLI 설치
brew install flyctl   # macOS
# 또는 curl -L https://fly.io/install.sh | sh

# 로그인
fly auth login

# 앱 생성 & 배포
cd cafe24-api
fly launch
# → Dockerfile 감지 → 자동 배포

# 환경변수 설정
fly secrets set CAFE24_MALL_ID=본인쇼핑몰ID
fly secrets set CAFE24_CLIENT_ID=mfm3Yy1HVK9bfGTueR9TPK
fly secrets set CAFE24_CLIENT_SECRET=본인시크릿키
fly secrets set CAFE24_REDIRECT_URI=https://your-app.fly.dev/auth/callback
```

---

## 배포 후 필수 작업

### 1. 카페24 개발자센터 Redirect URI 변경

개발자센터 → Apps → 앱 설정에서 Redirect URI를 배포된 도메인으로 변경:
```
http://localhost:3000/auth/callback
→ https://your-deployed-domain.com/auth/callback
```

### 2. OAuth 인증 실행

브라우저에서 `https://your-domain/auth/login` 접속 → 카페24 로그인 → 권한 승인

### 3. 동작 확인

| URL | 설명 |
|-----|------|
| `/` | 매출 대시보드 |
| `/setup.html` | API 설정 페이지 |
| `/auth/status` | 인증 상태 확인 (JSON) |
| `/api/orders?start_date=2025-03-01&end_date=2025-03-27` | 주문 API |
| `/api/products?limit=10` | 상품 API |
| `/api/analytics/sales?start_date=2025-03-01&end_date=2025-03-27` | 매출 분석 |

---

## 커스텀 도메인 연결 (선택)

### Railway
Settings → Domains → Custom Domain → 본인 도메인 입력
→ DNS에 CNAME 레코드 추가

### Render
Settings → Custom Domains → 도메인 추가
→ DNS 설정 안내에 따라 CNAME/A 레코드 추가

---

## 보안 체크리스트

- [ ] `.env` 파일이 `.gitignore`에 포함되어 있는지 확인
- [ ] Client Secret이 코드에 하드코딩되지 않았는지 확인
- [ ] HTTPS가 적용되어 있는지 확인 (Railway/Render는 자동 적용)
- [ ] 채팅에 노출된 기존 Secret Key 재발급 (카페24 개발자센터)
- [ ] 프로덕션에서는 토큰을 파일 대신 DB 또는 Redis에 저장 권장
