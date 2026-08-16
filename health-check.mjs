import fs from "node:fs/promises";

const ROOT = new URL("./", import.meta.url);
const doc = JSON.parse(await fs.readFile(new URL("./stations.json", ROOT), "utf8"));
const results = [];

function isPlaylistLike(contentType, text) {
  const ct = (contentType || "").toLowerCase();
  return text.includes("#EXTM3U") || ct.includes("mpegurl") || ct.includes("application/x-mpegurl");
}

async function checkOfficialPage(station) {
  if (!station.officialPage) return { status: "WARN", note: "official page missing" };
  try {
    const r = await fetch(station.officialPage, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(12000),
      headers: { "User-Agent": "kyu-radio-health-check/1.0" }
    });
    if (r.status >= 400) return { status: "WARN", note: `official page HTTP ${r.status}` };
    return { status: "PASS", note: `official page HTTP ${r.status}` };
  } catch (error) {
    return { status: "WARN", note: `official page runner verification failed: ${error.message}` };
  }
}

async function check(station) {
  if (station.playbackMode === "official-link") {
    const official = await checkOfficialPage(station);
    return {
      id: station.id,
      name: station.name,
      status: official.status === "PASS" ? "WARN" : official.status,
      note: `official-link only; ${official.note}`
    };
  }

  if (station.playbackMode === "worker-resolver") {
    const official = await checkOfficialPage(station);
    return {
      id: station.id,
      name: station.name,
      status: "WARN",
      note: `dynamic resolver: manual/browser verification required; ${official.note}`
    };
  }

  if (!station.streamUrl) {
    return { id: station.id, name: station.name, status: "FAIL", note: "direct station has no streamUrl" };
  }

  try {
    const r = await fetch(station.streamUrl, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(12000),
      headers: { "User-Agent": "kyu-radio-health-check/1.0" }
    });

    const ct = r.headers.get("content-type") || "";

    // 명확한 HTTP 오류는 실제 설정/엔드포인트 문제일 가능성이 높으므로 FAIL.
    // 반면 fetch 자체 실패는 러너의 지역/망/WAF 차단일 수 있어 catch에서 WARN 처리.
    if (!r.ok) {
      return {
        id: station.id,
        name: station.name,
        status: "FAIL",
        note: `HTTP ${r.status}, ${ct || "unknown content-type"}`
      };
    }

    const text = await r.text();
    const playlistLike = isPlaylistLike(ct, text);
    if (!playlistLike) {
      return {
        id: station.id,
        name: station.name,
        status: "FAIL",
        note: `HTTP ${r.status}, ${ct || "unknown content-type"}, not HLS playlist-like`
      };
    }

    return {
      id: station.id,
      name: station.name,
      status: "PASS",
      note: `HTTP ${r.status}, ${ct || "unknown content-type"}, playlist-like`
    };
  } catch (error) {
    return {
      id: station.id,
      name: station.name,
      status: "WARN",
      note: `runner could not verify (geo/WAF/network possible): ${error.message}`
    };
  }
}

for (const station of doc.stations) results.push(await check(station));
console.table(results);

const counts = results.reduce((acc, x) => {
  acc[x.status] = (acc[x.status] || 0) + 1;
  return acc;
}, {});

const report = [
  "# 뀨 RADIO 주간 상태 점검",
  "",
  `- 점검 시각(UTC): ${new Date().toISOString()}`,
  `- PASS: ${counts.PASS || 0}`,
  `- WARN: ${counts.WARN || 0}`,
  `- FAIL: ${counts.FAIL || 0}`,
  "",
  "| 상태 | 방송국 | 메모 |",
  "|---|---|---|",
  ...results.map((x) => `| ${x.status} | ${x.name.replaceAll("|", "\\|")} | ${x.note.replaceAll("|", "\\|")} |`),
  "",
  "> WARN은 GitHub-hosted runner의 해외 IP, WAF, 지오블로킹 등으로 생길 수 있으므로 실제 국내 브라우저 실측이 최종 판정입니다."
].join("\n");

await fs.writeFile(new URL("./health-report.md", ROOT), report, "utf8");
await fs.writeFile(new URL("./health-report.json", ROOT), JSON.stringify({ generatedAt: new Date().toISOString(), counts, results }, null, 2), "utf8");

const hardFailures = results.filter((x) => x.status === "FAIL");
if (hardFailures.length) {
  console.error(`\n${hardFailures.length} hard failure(s) detected.`);
  process.exitCode = 1;
}
