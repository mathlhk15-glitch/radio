# 뀨 RADIO

개인용 무료 웹 라디오입니다. 현재 저장소 `mathlhk15-glitch/radio`의 **루트(root)** 를 GitHub Pages로 배포하는 구조입니다.

- 실제 배포 주소: `https://mathlhk15-glitch.github.io/radio/`
- 고정 HTTPS 스트림: 브라우저가 방송사 CDN에서 직접 재생
- KBS·MBC·SBS 일부 동적 채널: Cloudflare Worker가 현재 유효한 재생 URL만 조회해 반환
- Worker는 오디오 바이트/HLS 세그먼트를 프록시하지 않음
- 실제 국내 브라우저에서 확인된 채널은 `✓ 정상` 상태로 표시

## 주요 파일

- `index.html` / `app.js` / `styles.css`: 웹 UI와 플레이어
- `stations.json`: 방송국 목록, 재생 방식, 상태, 정렬 순서
- `config.js`: 배포된 Worker 주소
- `sw.js`: PWA 앱 셸 캐시. 오디오 스트림과 resolver 응답은 캐시하지 않음
- `worker/worker.js`: KBS·MBC·SBS 동적 URL resolver
- `health-check.mjs`: 주간 엔드포인트 상태 점검
- `.github/workflows/radio-health.yml`: GitHub Actions 주간 상태 점검

## Cloudflare Worker

현재 프런트엔드 설정:

```js
window.KYU_RADIO_CONFIG = {
  workerBaseUrl: "https://kyu-radio-resolver.mathlhk15.workers.dev"
};
```

Worker의 허용 Origin은 다음과 맞아야 합니다.

```text
https://mathlhk15-glitch.github.io
```

GitHub Pages의 `/radio/` 경로는 Origin에 포함하지 않습니다.

## GitHub Pages 배포

이 저장소에서는 파일들이 **저장소 루트에 직접 위치**합니다.

```text
.github/
icons/
worker/
index.html
app.js
config.js
stations.json
styles.css
sw.js
...
```

GitHub 저장소 → **Settings → Pages**에서 `main` 브랜치의 `/ (root)`를 배포 대상으로 사용합니다.

정적 리소스는 `./styles.css`, `./icons/...` 같은 상대경로를 사용하므로 프로젝트 페이지 `/radio/`에서도 정상 동작합니다. `manifest.webmanifest`의 `start_url`과 `scope`도 `./`로 설정되어 있습니다.

## 재생 모드

- `direct`: HTTPS HLS를 브라우저에서 직접 재생
- `worker-resolver`: Worker가 최신 HTTPS URL만 발급하고 브라우저가 방송사 CDN에서 직접 재생
- `official-link`: 브라우저 내 직접 재생이 불안정한 경우 공식 온에어 페이지로 이동

## 캐시 정책

Service Worker는 앱 셸만 캐시합니다. 다음은 캐시하지 않습니다.

- `.m3u8`
- `.ts`
- `.m4s`
- `.aac`
- `.mp3`
- `/resolve` Worker 응답

`stations.json`은 network-first 방식입니다.

## 상태 점검

GitHub Actions는 매주 `health-check.mjs`를 저장소 루트에서 실행합니다.

- `PASS`: 해당 시점 GitHub runner에서 정상 응답 확인
- `WARN`: 해외 runner IP, WAF, 지오블로킹 등으로 자동 검증 불확실
- `FAIL`: 명확한 HTTP/구성 오류

동적 채널은 Worker `/resolve` 응답이 유효한 HTTPS URL을 반환하는지 자동 점검합니다. 실제 국내 브라우저 재생 결과가 최종 판정입니다.

## 유지보수 원칙

1. 정상 확인 채널은 상단 유지
2. 새 채널은 먼저 `testing`으로 추가
3. 실제 브라우저에서 재생 확인 후 `verified`로 승격
4. 반복 실패 채널은 `official-link`로 강등
5. 토큰/서명된 동적 URL은 `stations.json`이나 localStorage에 저장하지 않음
