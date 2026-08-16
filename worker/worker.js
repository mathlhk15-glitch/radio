const DEFAULT_ALLOWED_ORIGIN = "https://mathlhk15-glitch.github.io";

const STATIONS = {
  "kbs-1": {
    type: "kbs",
    code: "21"
  },
  "mbc-fm4u": {
    type: "endpoint",
    url: "https://sminiplay.imbc.com/aacplay.ashx?agent=webapp&channel=mfm"
  },
  "sbs-power": {
    type: "endpoint",
    url: "https://apis.sbs.co.kr/play-api/1.0/livestream/powerpc/powerfm?protocol=hls&ssl=Y"
  }
};

function corsHeaders(origin, allowedOrigin) {
  const allowed =
    origin === allowedOrigin ||
    origin === "http://localhost:8000" ||
    origin === "http://127.0.0.1:8000";

  return {
    "Access-Control-Allow-Origin": allowed ? origin : allowedOrigin,
    "Vary": "Origin",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  };
}

function json(body, status, origin, allowedOrigin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(origin, allowedOrigin)
  });
}

function normalizeHttpsUrl(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replaceAll("\\/", "/");

  try {
    const url = new URL(cleaned);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function collectServiceUrls(value, out = [], context = {}) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectServiceUrls(item, out, context);
    }
    return out;
  }

  if (!value || typeof value !== "object") return out;

  const code = String(
    value.channel_code ??
    value.channelCode ??
    value.code ??
    context.code ??
    ""
  );

  const candidate = normalizeHttpsUrl(
    value.service_url ??
    value.serviceUrl ??
    value.stream_url ??
    value.streamUrl ??
    ""
  );

  if (candidate) {
    out.push({
      url: candidate,
      code,
      mediaType: String(value.media_type ?? value.mediaType ?? "")
    });
  }

  for (const [key, child] of Object.entries(value)) {
    if (["service_url", "serviceUrl", "stream_url", "streamUrl"].includes(key)) {
      continue;
    }
    collectServiceUrls(child, out, { code });
  }

  return out;
}

function extractStreamUrlFromPayload(text, contentType = "") {
  const candidates = [];
  const trimmed = text.trim();

  const direct = normalizeHttpsUrl(trimmed);
  if (direct) candidates.push(direct);

  if (
    contentType.includes("json") ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[")
  ) {
    try {
      const parsed = JSON.parse(trimmed);

      for (const item of collectServiceUrls(parsed)) {
        candidates.push(item.url);
      }

      const scan =
        JSON.stringify(parsed).match(/https:\/\/[^"\\\s<>]+/g) || [];

      candidates.push(
        ...scan.map(normalizeHttpsUrl).filter(Boolean)
      );
    } catch {}
  }

  const regexMatches =
    trimmed.replaceAll("\\/", "/").match(/https:\/\/[^\s"'<>]+/gi) || [];

  candidates.push(
    ...regexMatches.map(normalizeHttpsUrl).filter(Boolean)
  );

  const unique = [...new Set(candidates)];

  return (
    unique.find((u) => /\.m3u8($|\?)/i.test(u)) ||
    unique[0] ||
    null
  );
}

async function resolveKbs(code) {
  const endpoint =
    `https://cfpwwwapi.kbs.co.kr/api/v1/landing/live/channel_code/${encodeURIComponent(code)}`;

  const response = await fetch(endpoint, {
    headers: {
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`KBS_${response.status}`);
  }

  const data = await response.json();
  const candidates = collectServiceUrls(data);

  const preferred =
    candidates.find(
      (x) =>
        x.code === String(code) &&
        x.mediaType.toLowerCase() === "radio"
    ) ||
    candidates.find((x) => x.code === String(code)) ||
    candidates.find((x) => x.mediaType.toLowerCase() === "radio") ||
    candidates[0];

  if (!preferred?.url) {
    throw new Error("KBS_URL_NOT_FOUND");
  }

  return preferred.url;
}

async function resolveEndpoint(endpoint) {
  const response = await fetch(endpoint, {
    headers: {
      "Accept": "application/json,text/plain,*/*"
    }
  });

  if (!response.ok) {
    throw new Error(`UPSTREAM_${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  const url = extractStreamUrlFromPayload(text, contentType);

  if (!url) {
    throw new Error("STREAM_URL_NOT_FOUND");
  }

  return url;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin =
      env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN;

    if (request.method === "OPTIONS") {
      const headers = corsHeaders(origin, allowedOrigin);
      headers["Access-Control-Allow-Methods"] = "GET, OPTIONS";
      headers["Access-Control-Allow-Headers"] = "Content-Type";
      headers["Access-Control-Max-Age"] = "86400";

      return new Response(null, {
        status: 204,
        headers
      });
    }

    if (request.method !== "GET") {
      return json(
        { error: "method_not_allowed" },
        405,
        origin,
        allowedOrigin
      );
    }

    if (
      origin &&
      origin !== allowedOrigin &&
      ![
        "http://localhost:8000",
        "http://127.0.0.1:8000"
      ].includes(origin)
    ) {
      return json(
        { error: "origin_not_allowed" },
        403,
        origin,
        allowedOrigin
      );
    }

    if (url.pathname === "/health") {
      return json(
        {
          ok: true,
          service: "kyu-radio-resolver"
        },
        200,
        origin,
        allowedOrigin
      );
    }

    if (url.pathname !== "/resolve") {
      return json(
        { error: "not_found" },
        404,
        origin,
        allowedOrigin
      );
    }

    const id = url.searchParams.get("station") || "";
    const station = STATIONS[id];

    if (!station) {
      return json(
        { error: "unknown_station" },
        404,
        origin,
        allowedOrigin
      );
    }

    try {
      let streamUrl;

      if (station.type === "kbs") {
        streamUrl = await resolveKbs(station.code);
      } else if (station.type === "endpoint") {
        streamUrl = await resolveEndpoint(station.url);
      } else {
        throw new Error("UNSUPPORTED_RESOLVER");
      }

      return json(
        {
          url: streamUrl,
          resolvedAt: new Date().toISOString()
        },
        200,
        origin,
        allowedOrigin
      );
    } catch (error) {
      console.error("resolver failure", id, error);

      return json(
        {
          error: "resolver_failed"
        },
        502,
        origin,
        allowedOrigin
      );
    }
  }
};
