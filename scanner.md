# 폰 스캐너 웹앱 PRD (Product Requirements Document)

## 프로젝트 개요

**프로젝트명**: QR 스캔 기반 문서 스캐너 웹앱
**배포 환경**: GitHub Pages (설치 없음, 서버 없음)
**목표**: QR코드 스캔 → 문서 촬영 → PC에서 자동 보정 → PDF 다운로드

---

## 핵심 차별점

- 앱 설치 불필요
- QR 찍고 촬영하면 끝
- PC에서 바로 PDF 생성 및 다운로드
- 완전 무료 (서버 운영 비용 없음)

---

## 전체 아키텍처

```
[폰 브라우저]                        [PC 브라우저]
     │                                    │
  사진 촬영                          QR코드 생성
  base64 인코딩                      이미지 수신 대기
  Gun.js로 전송 ──── relay ──────→  보정 처리
                                    PDF 생성
```

### 설계 원칙

- 폰은 **촬영 + 전송만** 담당 (보정 없음)
- PC가 **모든 이미지 처리** 담당
- WebRTC P2P 없음 → Gun.js를 단순 릴레이로 사용
- OpenCV.js 없음 → Canvas API + 경량 라이브러리로 대체

### 기술 스택

| 역할 | 기술 | 비고 |
|------|------|------|
| 이미지 릴레이 | Gun.js (CDN) | 자체 서버 불필요, 공개 relay 활용 |
| QR코드 생성 | qrcode.js (CDN) | 세션ID 포함 |
| 폰 카메라 접근 | getUserMedia | 브라우저 내장 |
| 엣지 검출 | Sobel 필터 직접 구현 | Canvas API 기반, ~80줄 |
| 원근 변환 | perspective-transform.js (CDN) | 4KB 경량 라이브러리 |
| 화이트밸런스 보정 | Canvas API | 직접 구현 |
| PDF 생성 | jsPDF (CDN) | 브라우저에서 처리 |
| 호스팅 | GitHub Pages | 무료 |

---

## 사용자 흐름 (User Flow)

### PC 측
```
1. github.io/scanner 접속
2. 세션ID 생성 + QR코드 표시
3. 폰 연결 대기 (Gun.js 구독 시작)
4. 이미지 수신 → 보정 처리
5. 미리보기 표시 + 코너 확인/수정
6. PDF 생성 및 다운로드
```

### 폰 측
```
1. 기본 카메라 앱으로 QR코드 스캔
2. 브라우저 자동 실행 + 카메라 권한 요청
3. 후면 카메라 실행
4. 문서 촬영 버튼 누르기
5. 전송 완료 메시지 표시
```

---

## 페이지 구성

### 1. PC 메인 페이지 (`index.html`)

**상태별 화면**
```
[QR 대기]     → QR코드 크게 표시
[이미지 수신]  → 로딩 인디케이터
[코너 확인]   → 미리보기 + 코너 포인트 표시/수정 UI
[보정중]      → 프로그레스
[완료]        → 보정 결과 + PDF 다운로드 버튼
```

### 2. 폰 카메라 페이지 (`camera.html`)

**화면 구성**
- 전체화면 카메라 뷰파인더
- 하단 중앙: 촬영 버튼 (크고 누르기 쉽게)
- 상단: 연결 상태 표시
- 촬영 후: 전송 완료 메시지

---

## 이미지 전송 구조

```javascript
// 세션ID 기반 채널
const sessionId = crypto.randomUUID();
const gun = Gun(['https://gun-manhattan.herokuapp.com/gun']);

// 폰 → PC 전송
const imageData = canvas.toDataURL('image/jpeg', 0.85);
gun.get(sessionId).put({ image: imageData });

// PC 수신
gun.get(sessionId).on(data => {
  if (data.image) processImage(data.image);
});
```

---

## 보정 처리 파이프라인 (PC에서 실행)

### Step 1. 자동 코너 감지 (1순위)
- Canvas API `getImageData`로 픽셀 데이터 추출
- Sobel 필터로 엣지 검출 (직접 구현)
- 강한 엣지로 사각형 꼭짓점 4개 추정
- 성공 시 → Step 3, 실패 시 → Step 2

### Step 2. 수동 코너 지정 (기본 UX / Fallback)
- 보정된 이미지 위에 드래그 가능한 코너 포인트 4개 표시
- 자동 감지 성공해도 사용자가 미세 조정 가능
- 확인 버튼 → Step 3

### Step 3. 원근 변환
- perspective-transform.js로 4개 꼭짓점 → A4 비율(1:√2) 변환
- Canvas에 결과 렌더링

### Step 4. 화이트밸런스 보정
- 종이 빈 영역 픽셀 샘플링
- 샘플 색상과 흰색 RGB(255,255,255) 차이 계산
- 차이값 전체 픽셀에 균등 적용 (`getImageData` / `putImageData`)

### Step 5. PDF 생성
- jsPDF로 보정된 이미지를 A4 사이즈 PDF로 변환
- 자동 다운로드

---

## 파일 구조

```
/
├── index.html          # PC 메인 페이지
├── camera.html         # 폰 카메라 페이지
├── js/
│   ├── pc.js           # PC 측 릴레이 수신 + 보정 처리
│   ├── phone.js        # 폰 측 카메라 + 릴레이 전송
│   ├── correction.js   # 보정 파이프라인 (Sobel, 원근변환, 화이트밸런스)
│   └── corner-ui.js    # 수동 코너 지정 드래그 UI
├── css/
│   └── style.css
└── README.md
```

---

## 외부 라이브러리 (CDN)

```html
<!-- QR코드 생성 -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>

<!-- Gun.js 릴레이 -->
<script src="https://cdn.jsdelivr.net/npm/gun/gun.js"></script>

<!-- 원근 변환 (4KB) -->
<script src="https://cdn.jsdelivr.net/npm/perspective-transform@1.1.3/dist/perspective-transform.js"></script>

<!-- PDF 생성 -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
```

**총 초기 로딩**: ~200KB (기존 OpenCV.js 8MB 대비 대폭 감소)

---

## 제약 사항 및 고려사항

### 브라우저 요구사항
- getUserMedia 지원 브라우저 (Chrome, Edge, Safari, Firefox 최신버전)
- 폰에서 카메라 권한 허용 필요
- HTTPS 환경 필요 (GitHub Pages 기본 HTTPS)

### Gun.js relay 경유
- 이미지 데이터가 공개 relay 서버를 경유함
- 민감한 문서의 경우 사용자에게 고지 필요
- 대안: Firebase Storage 무료 티어로 교체 가능

### base64 이미지 크기
- JPEG quality 0.85 기준 약 200~500KB
- Gun.js relay 전송에 문제 없는 수준

---

## 개발 우선순위

| 우선순위 | 기능 |
|---------|------|
| P0 | QR코드 생성 및 세션ID 관리 |
| P0 | 폰 카메라 실행 및 촬영 |
| P0 | Gun.js 이미지 전송/수신 |
| P0 | 화이트밸런스 보정 |
| P0 | 수동 코너 지정 UI |
| P0 | 원근 변환 + PDF 생성 |
| P1 | Sobel 기반 자동 코너 감지 |
| P2 | 다중 페이지 PDF |
| P2 | 보정 강도 슬라이더 |
