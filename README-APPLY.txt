뀨 RADIO recommended v3

Changes
- MBC -> KBS -> SBS stations are placed at the top.
- Stations confirmed by actual use are marked "✓ 정상".
- Added filters: 정상재생, 음악, 전국, 창원·경남, 즐겨찾기.
- Unverified direct streams are marked "테스트".
- Official-only channels are marked "공식 페이지".
- Service worker cache version bumped to v3 to reduce stale-file problems.
- Existing Cloudflare worker resolver remains compatible.

Recommended GitHub replacement files
- stations.json
- index.html
- app.js
- styles.css
- sw.js

Cloudflare worker
- No change is required if the V2 worker is already deployed.
- worker/worker.js is included only as a backup.

After replacing files
1. Commit changes.
2. Wait about 1 minute for GitHub Pages.
3. Open the site and use Ctrl+Shift+R once.
