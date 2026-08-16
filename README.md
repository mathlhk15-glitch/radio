# 뀨 RADIO

개인용 무료 웹 라디오입니다. GitHub Pages를 프런트엔드로 사용하고, 고정 HTTPS 스트림은 브라우저가 방송사 CDN에서 직접 재생합니다. KBS·중앙 MBC·SBS처럼 재생 URL이 동적으로 바뀌는 일부 채널만 Cloudflare Worker가 최신 URL을 조회해서 반환합니다. Worker는 오디오 바이트, HLS 매니페스트 또는 세그먼트를 프록시하지 않습니다.

## 포함 채널

- 창원·경남: KBS창원 1라디오, KBS창원 2라디오, KBS창원 음악FM, MBC경남 표준FM, MBC경남 FM4U, KNN 러브FM, KNN 파워FM, 경남CBS, TBN 경남교통방송, 창원극동방송
- 전국: KBS 1Radio, KBS Cool FM, MBC FM4U, SBS PowerFM, CBS 음악FM, EBS FM, YTN 라디오, 국악방송

`stations.json`에서 채널을 추가·제거할 수 있습니다.

## 재생 방식

- `direct`: HTTPS HLS를 방송사 CDN에서 직접 재생
- `worker-resolver`: Worker가 방송사 온에어/API에서 현재 유효한 URL만 조회해서 반환한 후 브라우저가 직접 재생
- `official-link`: HTTP-only, 정책·호환성 문제가 예상되는 채널은 공식 페이지를 새 탭으로 열기

## 1. 로컬 테스트

파일을 더블클릭하지 말고 간단한 HTTP 서버로 여세요.

```bash
python3 -m http.server 8000
```

브라우저에서 `http://localhost:8000` 접속. direct 채널은 바로 테스트할 수 있습니다.

## 2. Cloudflare Worker 배포

동적 채널(KBS, 중앙 MBC FM4U, SBS PowerFM)을 사용하려면 `worker/`를 Cloudflare Workers에 배포합니다.

Wrangler 예시:

```bash
cd worker
npx wrangler deploy
```

배포 결과 주소가 예를 들어 아래처럼 나오면:

```text
https://kyu-radio-resolver.<account>.workers.dev
```

루트의 `config.js`에서 설정합니다.

```js
window.KYU_RADIO_CONFIG = {
  workerBaseUrl: "https://kyu-radio-resolver.<account>.workers.dev"
};
```

`worker/wrangler.toml`의 `ALLOWED_ORIGIN`은 기본적으로 `https://mathlhk15-glitch.github.io`로 지정되어 있습니다. GitHub Pages 사용자 도메인이 달라지면 수정하세요. 경로(`/lhk15/radio`)는 Origin에 포함되지 않습니다.

## 3. GitHub Pages 배포

이 `radio/` 폴더를 GitHub Pages가 서비스할 위치에 넣습니다. 예를 들어 기존 `lhk15` 저장소에서 `/radio/` 폴더로 올리면 상대경로를 사용하므로 별도 수정 없이 동작하도록 구성했습니다. 단, GitHub Actions 워크플로는 `radio/.github` 안이 아니라 **저장소 루트의 `.github/workflows/`** 에 있어야 하므로, 배포 패키지 최상위의 `.github/` 폴더를 저장소 루트에 병합하세요.

예상 주소:

```text
https://mathlhk15-glitch.github.io/lhk15/radio/
```

## PWA

HTTPS로 배포되면 Service Worker가 앱 셸을 캐시합니다. `stations.json`은 network-first이고 마지막 정상본만 fallback으로 사용합니다. 스트림 URL, `.m3u8`, `.ts`, `.m4s`, `.aac`, Worker resolver 응답은 캐시하지 않습니다.

## 복구 정책

- `waiting`/`stalled` 감지 후 4.5초 동안 재생헤드가 이동하지 않으면 단계적 복구
- 첫 정체: hls.js 로드 재개
- 같은 세션의 반복 정체: 라이브 지연이 큰 경우에만 live edge 재동기화
- 재연결: 3초 후 1회, 10초 후 1회
- HLS 치명적 네트워크/미디어 오류는 각 1회만 내부 복구 후 전체 재연결 단계로 전환
- 이후 자동 재시도 중단 후 `다시 연결` 및 `공식 방송` 제공

## GitHub Actions 헬스체크

`저장소 루트/.github/workflows/radio-health.yml`은 매주 일요일 UTC 21:20(한국 월요일 06:20)에 정적 URL을 참고용으로 검사합니다. 데이터센터 IP, geo-block, CDN 정책 때문에 WARN이 나도 실제 국내 브라우저에서는 정상일 수 있습니다. 따라서 Actions는 장애 확정 도구가 아니라 조기 경보입니다.

## 운영 원칙

- `radio.bsod.kr` 런타임 의존성 없음
- 오디오 저장/재송출/세그먼트 프록시 없음
- 동적 URL과 토큰은 localStorage/PWA Cache에 저장하지 않음
- Worker는 station whitelist만 허용하고 임의 `?url=` 프록시 기능이 없음
- 방송사 구조가 변경되면 해당 채널의 `stations.json` 또는 `worker/worker.js`만 수정

## 확인이 필요한 부분

자동화 환경에서는 일부 국내 CDN이 데이터센터 IP를 거부할 수 있습니다. 최종 A/B/C/D 판정은 실제 Windows Chrome/Edge 및 Galaxy Chrome/Samsung Internet에서 이루어져야 합니다. 이 완성본은 실패 시 공식 온에어로 빠질 수 있도록 설계되어 있습니다.

## 출처/참고

방송사 공식 웹페이지 및 각 방송사 원본 온에어/API 구조를 기준으로 작성했습니다. `radio.bsod.kr`의 서비스 URL 자체를 런타임에서 호출하지 않으며, 해당 사이트 UI나 소스 코드를 복제하지 않았습니다.
