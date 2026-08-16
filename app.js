(() => {
  "use strict";

  const state = {
    stations: [],
    current: null,
    hls: null,
    activeFilter: "all",
    favorites: new Set(JSON.parse(localStorage.getItem("kyuRadioFavorites") || "[]")),
    retryStep: 0,
    retryTimer: null,
    stallTimer: null,
    stallCount: 0,
    hlsNetworkRecoveries: 0,
    hlsMediaRecoveries: 0,
    lastProgressTime: 0,
    currentResolvedUrl: ""
  };

  const $ = (id) => document.getElementById(id);
  const audio = $("radioPlayer");
  const playButton = $("playButton");
  const retryButton = $("retryButton");
  const officialButton = $("officialButton");
  const statusText = $("statusText");
  const nowTitle = $("nowTitle");
  const nowSubtitle = $("nowSubtitle");
  const stationArt = $("stationArt");
  const liveBadge = $("liveBadge");
  const stationGrid = $("stationGrid");
  const stationCount = $("stationCount");
  const searchInput = $("searchInput");
  const volume = $("volume");
  const themeButton = $("themeButton");

  function save(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function setStatus(text, kind = "idle") {
    statusText.textContent = text;
    liveBadge.classList.toggle("live", kind === "live");
    liveBadge.classList.toggle("error", kind === "error");
    liveBadge.textContent = kind === "live" ? "LIVE" : kind === "error" ? "연결 오류" : kind === "loading" ? "연결 중" : "대기";
  }

  function cleanTimers() {
    if (state.retryTimer) clearTimeout(state.retryTimer);
    if (state.stallTimer) clearTimeout(state.stallTimer);
    state.retryTimer = null;
    state.stallTimer = null;
  }

  function destroyHls() {
    if (state.hls) {
      state.hls.destroy();
      state.hls = null;
    }
  }

  function stopPlayback(resetSrc = true) {
    cleanTimers();
    destroyHls();
    audio.pause();
    if (resetSrc) {
      audio.removeAttribute("src");
      audio.load();
    }
    state.currentResolvedUrl = "";
    state.retryStep = 0;
    state.stallCount = 0;
    state.hlsNetworkRecoveries = 0;
    state.hlsMediaRecoveries = 0;
    updatePlayButton();
  }

  function updatePlayButton() {
    if (!state.current || state.current.playbackMode === "official-link") {
      playButton.disabled = true;
      playButton.textContent = "▶ 재생";
      return;
    }
    playButton.disabled = false;
    playButton.textContent = audio.paused ? "▶ 재생" : "❚❚ 일시정지";
  }

  function renderStations() {
    const q = searchInput.value.trim().toLowerCase();
    const list = state.stations.filter((s) => {
      const matchesFilter = state.activeFilter === "all" ||
        s.region === state.activeFilter ||
        (state.activeFilter === "favorite" && state.favorites.has(s.id));
      const haystack = `${s.name} ${s.provider} ${s.regionLabel} ${s.category}`.toLowerCase();
      return matchesFilter && (!q || haystack.includes(q));
    });

    stationCount.textContent = `${list.length}개`;
    if (!list.length) {
      stationGrid.innerHTML = '<div class="empty">조건에 맞는 방송국이 없습니다.</div>';
      return;
    }

    stationGrid.innerHTML = list.map((s) => {
      const favorite = state.favorites.has(s.id);
      const active = state.current?.id === s.id;
      const workerReady = Boolean((window.KYU_RADIO_CONFIG?.workerBaseUrl || "").trim());
      const modeLabel = ({
        direct: "직접 재생",
        "worker-resolver": workerReady ? "동적 연결" : "Worker 미설정",
        "official-link": "공식 페이지"
      })[s.playbackMode] || s.playbackMode;
      const modeClass = s.playbackMode === "worker-resolver" && !workerReady ? " warning" : "";
      return `
        <article class="station-card ${active ? "active" : ""}" data-id="${s.id}">
          <div>
            <h3>${s.name}</h3>
            <div class="station-meta">${s.regionLabel} · ${s.category} · ${s.provider}</div>
            <span class="mode-pill${modeClass}">${modeLabel}</span>
          </div>
          <div class="station-actions">
            <button class="station-play" data-play="${s.id}" type="button" aria-label="${s.name} 선택">${s.playbackMode === "official-link" ? "↗" : "▶"}</button>
            <button class="favorite ${favorite ? "on" : ""}" data-favorite="${s.id}" type="button" aria-label="즐겨찾기">★</button>
          </div>
        </article>`;
    }).join("");
  }

  async function fetchResolvedUrl(station) {
    const base = (window.KYU_RADIO_CONFIG?.workerBaseUrl || "").replace(/\/$/, "");
    if (!base) throw new Error("WORKER_NOT_CONFIGURED");
    const response = await fetch(`${base}/resolve?station=${encodeURIComponent(station.id)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`RESOLVER_${response.status}`);
    const json = await response.json();
    if (!json.url || !/^https:\/\//i.test(json.url)) throw new Error("INVALID_STREAM_URL");
    return json.url;
  }

  async function resolveStream(station) {
    if (station.playbackMode === "direct") return station.streamUrl;
    if (station.playbackMode === "worker-resolver") return fetchResolvedUrl(station);
    return null;
  }

  function attachHls(url) {
    destroyHls();
    const nativeHls = audio.canPlayType("application/vnd.apple.mpegurl");
    if (nativeHls) {
      audio.src = url;
      return Promise.resolve("native-hls");
    }

    if (window.Hls?.isSupported()) {
      state.hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 30,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 8
      });
      state.hls.loadSource(url);
      state.hls.attachMedia(audio);
      state.hls.on(Hls.Events.ERROR, (_, data) => {
        if (data?.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) scheduleStallCheck("HLS 버퍼 정체");
        if (!data?.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && state.hls) {
          state.hlsNetworkRecoveries += 1;
          if (state.hlsNetworkRecoveries <= 1) {
            setStatus("네트워크를 복구하고 있습니다…", "loading");
            state.hls.startLoad();
          } else {
            scheduleRetry("HLS 네트워크 오류 반복");
          }
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && state.hls) {
          state.hlsMediaRecoveries += 1;
          if (state.hlsMediaRecoveries <= 1) {
            setStatus("미디어 재생을 복구하고 있습니다…", "loading");
            state.hls.recoverMediaError();
          } else {
            scheduleRetry("HLS 미디어 오류 반복");
          }
        } else {
          scheduleRetry("HLS 치명적 오류");
        }
      });
      return Promise.resolve("hls.js");
    }

    throw new Error("HLS_UNSUPPORTED");
  }

  async function startCurrent({ isRetry = false } = {}) {
    if (!state.current) return;
    if (state.current.playbackMode === "official-link") {
      window.open(state.current.officialPage, "_blank", "noopener,noreferrer");
      return;
    }

    cleanTimers();
    if (!isRetry) {
      state.retryStep = 0;
      state.stallCount = 0;
    }
    state.hlsNetworkRecoveries = 0;
    state.hlsMediaRecoveries = 0;
    setStatus("최신 재생 주소를 준비하고 있습니다…", "loading");
    retryButton.classList.add("hidden");

    try {
      const url = await resolveStream(state.current);
      state.currentResolvedUrl = url;
      await attachHls(url);
      audio.volume = Number(volume.value);
      await audio.play();
      setStatus("방송을 재생하고 있습니다.", "live");
      updatePlayButton();
      updateMediaSession();
    } catch (error) {
      console.warn("Playback start failed", error);
      if (error.message === "WORKER_NOT_CONFIGURED") {
        setStatus("동적 채널용 Worker 주소가 아직 설정되지 않았습니다. 공식 방송 버튼을 이용하거나 README의 Worker 배포 단계를 완료하세요.", "error");
        retryButton.classList.add("hidden");
      } else if (error.name === "NotAllowedError") {
        setStatus("브라우저 자동재생 제한으로 멈췄습니다. 재생 버튼을 다시 눌러 주세요.", "error");
        retryButton.classList.remove("hidden");
      } else {
        scheduleRetry(error.message || "재생 실패");
      }
    }
  }

  function scheduleRetry(reason) {
    if (state.retryTimer) return;
    if (state.stallTimer) {
      clearTimeout(state.stallTimer);
      state.stallTimer = null;
    }
    const delays = [3000, 10000];
    if (state.retryStep >= delays.length || !navigator.onLine) {
      setStatus(`연결을 중단했습니다${reason ? ` (${reason})` : ""}. 다시 연결하거나 공식 방송을 이용하세요.`, "error");
      retryButton.classList.remove("hidden");
      updatePlayButton();
      return;
    }
    const delay = delays[state.retryStep++];
    setStatus(`${Math.round(delay / 1000)}초 후 다시 연결합니다…`, "loading");
    state.retryTimer = setTimeout(() => startCurrent({ isRetry: true }), delay);
  }

  function scheduleStallCheck(reason) {
    if (!state.current || audio.paused || state.stallTimer) return;
    const before = audio.currentTime;
    state.stallTimer = setTimeout(() => {
      state.stallTimer = null;
      const advanced = Math.abs(audio.currentTime - before) > 0.3;
      if (advanced || audio.paused) return;
      state.stallCount += 1;
      if (state.stallCount === 1 && state.hls) {
        setStatus("버퍼 정체를 복구하고 있습니다…", "loading");
        state.hls.startLoad(-1);
        return;
      }
      if (state.stallCount === 2 && state.hls) {
        const live = state.hls.liveSyncPosition;
        if (Number.isFinite(live) && live > audio.currentTime + 8) {
          audio.currentTime = live;
          setStatus("라이브 지점으로 재동기화했습니다.", "loading");
          return;
        }
      }
      scheduleRetry(reason);
    }, 4500);
  }

  function selectStation(id, autoStart = true) {
    const station = state.stations.find((s) => s.id === id);
    if (!station) return;
    stopPlayback();
    state.current = station;
    localStorage.setItem("kyuRadioLastStation", station.id);
    nowTitle.textContent = station.name;
    nowSubtitle.textContent = `${station.regionLabel} · ${station.category} · ${station.provider}`;
    stationArt.textContent = station.provider.replace(/[^A-Za-z가-힣]/g, "").slice(0, 7).toUpperCase() || "RADIO";
    officialButton.href = station.officialPage;
    officialButton.classList.remove("hidden");
    retryButton.classList.add("hidden");
    renderStations();

    if (station.playbackMode === "official-link") {
      setStatus("이 채널은 공식 온에어 페이지로 연결합니다.", "idle");
      playButton.disabled = true;
      if (autoStart) window.open(station.officialPage, "_blank", "noopener,noreferrer");
      return;
    }

    playButton.disabled = false;
    setStatus("재생 준비가 되었습니다.", "idle");
    if (autoStart) startCurrent();
  }

  function updateMediaSession() {
    if (!("mediaSession" in navigator) || !state.current) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: state.current.name,
      artist: state.current.regionLabel,
      album: "뀨 RADIO"
    });
    navigator.mediaSession.setActionHandler("play", () => audio.play());
    navigator.mediaSession.setActionHandler("pause", () => audio.pause());
  }

  audio.addEventListener("play", () => {
    setStatus("방송을 재생하고 있습니다.", "live");
    updatePlayButton();
  });
  audio.addEventListener("pause", updatePlayButton);
  audio.addEventListener("playing", () => {
    setStatus("방송을 재생하고 있습니다.", "live");
  });
  audio.addEventListener("waiting", () => scheduleStallCheck("waiting"));
  audio.addEventListener("stalled", () => scheduleStallCheck("stalled"));
  audio.addEventListener("error", () => scheduleRetry("audio error"));
  audio.addEventListener("timeupdate", () => { state.lastProgressTime = Date.now(); });

  playButton.addEventListener("click", async () => {
    if (!state.current) return;
    if (audio.paused && audio.src) {
      try { await audio.play(); } catch { await startCurrent({ isRetry: true }); }
    } else if (audio.paused) {
      await startCurrent();
    } else {
      audio.pause();
    }
  });
  retryButton.addEventListener("click", () => {
    state.retryStep = 0;
    startCurrent({ isRetry: true });
  });
  volume.addEventListener("input", () => {
    audio.volume = Number(volume.value);
    localStorage.setItem("kyuRadioVolume", volume.value);
  });

  stationGrid.addEventListener("click", (event) => {
    const play = event.target.closest("[data-play]");
    const favorite = event.target.closest("[data-favorite]");
    if (favorite) {
      const id = favorite.dataset.favorite;
      state.favorites.has(id) ? state.favorites.delete(id) : state.favorites.add(id);
      save("kyuRadioFavorites", [...state.favorites]);
      renderStations();
      return;
    }
    if (play) selectStation(play.dataset.play, true);
  });

  document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    tab.classList.add("active");
    state.activeFilter = tab.dataset.filter;
    renderStations();
  }));
  searchInput.addEventListener("input", renderStations);

  themeButton.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("kyuRadioTheme", next);
  });

  window.addEventListener("online", () => {
    if (state.current && audio.paused) setStatus("인터넷 연결이 복구되었습니다. 다시 재생할 수 있습니다.", "idle");
  });
  window.addEventListener("offline", () => setStatus("인터넷 연결이 끊겼습니다. 자동 재시도를 멈춥니다.", "error"));

  async function boot() {
    document.documentElement.dataset.theme = localStorage.getItem("kyuRadioTheme") || "dark";
    volume.value = localStorage.getItem("kyuRadioVolume") || "0.8";
    audio.volume = Number(volume.value);

    try {
      const response = await fetch("./stations.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`stations ${response.status}`);
      const data = await response.json();
      state.stations = [...data.stations].sort((a, b) => a.sortOrder - b.sortOrder);
      renderStations();
      const last = localStorage.getItem("kyuRadioLastStation");
      if (last && state.stations.some((s) => s.id === last)) selectStation(last, false);
    } catch (error) {
      stationGrid.innerHTML = `<div class="empty">방송국 목록을 불러오지 못했습니다: ${error.message}</div>`;
    }

    if ("serviceWorker" in navigator && location.protocol === "https:") {
      navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("SW registration failed", e));
    }
  }

  boot();
})();
