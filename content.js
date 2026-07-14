// YouTube Music Volume Leveler — content script
// Builds a Web Audio graph over the page's <video> element and continuously
// nudges gain toward a target loudness, with per-track/per-artist manual
// overrides stored in chrome.storage.sync.
(function () {
  if (window.__ytmVolumeLevelerInjected) return;
  window.__ytmVolumeLevelerInjected = true;

  // --- Selectors (unofficial YTM DOM structure — keep isolated here so a
  // future redesign only requires editing this block). ---
  const SELECTORS = {
    playerBar: "ytmusic-player-bar",
    title: "ytmusic-player-bar .title",
    byline: "ytmusic-player-bar .byline",
  };

  // Linear RMS targets, roughly halved from initial guesses after testing
  // showed even "Quiet" was boosting tracks already at an appropriate
  // volume. Best-effort calibration, not measured against real content —
  // check the popup's live "Auto gain" readout on a track that shouldn't
  // need boosting and nudge these down further if it's still climbing.
  const TARGET_PRESETS = [0.008, 0.016, 0.025]; // quiet, normal, loud

  const TUNING = {
    // Deliberately slow: currentAutoGain should drift toward the song's
    // average loudness over roughly the song's own length, not "fix" it
    // within a couple seconds — that would flatten intentional in-song
    // dynamics (quiet verse vs loud chorus). Short-term dynamics still come
    // through; only the slow-moving trend gets leveled song-to-song.
    smoothingUp: 0.0015, // tau ~= tickMs / rate ~= 67s
    smoothingDown: 0.004, // tau ~= 25s (a bit faster: still cheap insurance against a loud outlier)
    rmsEma: 0.2, // fast smoothing on the *input* RMS reading itself (tau ~= 500ms) — feeds the slow gain above
    minAutoGain: 0.3,
    maxAutoGain: 3.0,
    silenceRms: 0.001,
    tickMs: 100,
    gainTimeConstant: 0.15,
  };

  const OVERRIDE_LIMITS = {
    minManual: 0.25,
    maxManual: 4.0,
    maxCombined: 4.0,
    maxEntries: 150,
  };

  const LEARNED_GAIN_MAX_ENTRIES = 150;

  const STORAGE_KEYS = {
    settings: "settings",
    trackOverrides: "trackOverrides",
    artistOverrides: "artistOverrides",
    learnedGains: "learnedGains",
  };

  const DEFAULT_SETTINGS = { autoEnabled: 1, target: 1, minGain: 30, maxGain: 300 };

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  // --- In-memory state (settings/overrides mirror chrome.storage.sync) ---
  let settings = { ...DEFAULT_SETTINGS };
  let trackOverrides = {};
  let artistOverrides = {};
  // Auto-computed gain the AGC converged to per videoId, last time that
  // song finished playing — the starting point for currentAutoGain next
  // time the same song plays, distinct from user-set trackOverrides.
  let learnedGains = {};

  let audioCtx = null;
  let gainNode = null;
  let analyserNode = null;
  let tickTimer = null;
  let currentAutoGain = 1.0;
  let smoothedRms = TARGET_PRESETS[DEFAULT_SETTINGS.target];

  // `key` is what storage (trackOverrides/learnedGains) is actually keyed
  // by — prefer the real videoId when available, but fall back to a
  // title+artist composite when it isn't (see computeTrackKey below). This
  // is what decouples change detection from needing a reliable video ID.
  let currentTrack = { key: null, videoId: null, title: null, artist: null };

  // --- Storage ---
  function loadStorage(callback) {
    chrome.storage.sync.get(
      [STORAGE_KEYS.settings, STORAGE_KEYS.trackOverrides, STORAGE_KEYS.artistOverrides, STORAGE_KEYS.learnedGains],
      (result) => {
        settings = { ...DEFAULT_SETTINGS, ...(result[STORAGE_KEYS.settings] || {}) };
        trackOverrides = result[STORAGE_KEYS.trackOverrides] || {};
        artistOverrides = result[STORAGE_KEYS.artistOverrides] || {};
        learnedGains = result[STORAGE_KEYS.learnedGains] || {};
        callback();
      }
    );
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes[STORAGE_KEYS.settings]) {
      settings = { ...DEFAULT_SETTINGS, ...changes[STORAGE_KEYS.settings].newValue };
    }
    if (changes[STORAGE_KEYS.trackOverrides]) {
      trackOverrides = changes[STORAGE_KEYS.trackOverrides].newValue || {};
    }
    if (changes[STORAGE_KEYS.artistOverrides]) {
      artistOverrides = changes[STORAGE_KEYS.artistOverrides].newValue || {};
    }
    if (changes[STORAGE_KEYS.learnedGains]) {
      learnedGains = changes[STORAGE_KEYS.learnedGains].newValue || {};
    }
  });

  // LRU-ish set: delete+re-insert moves key to "most recent" (object key
  // order = insertion order), evict oldest when over the cap.
  function touchAndSet(map, key, value, maxEntries) {
    delete map[key];
    map[key] = value;
    const keys = Object.keys(map);
    while (keys.length > maxEntries) {
      delete map[keys.shift()];
    }
  }

  function getManualMultiplier() {
    if (currentTrack.key && trackOverrides[currentTrack.key] != null) {
      return trackOverrides[currentTrack.key] / 100;
    }
    if (currentTrack.artist && artistOverrides[currentTrack.artist] != null) {
      return artistOverrides[currentTrack.artist] / 100;
    }
    return 1.0;
  }

  // --- Audio graph ---
  function findVideoElement() {
    return document.querySelector("video");
  }

  function resumeAudioContext() {
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
  }

  function ensureAudioGraph(video) {
    if (video.__ytmvAttached) return;
    video.__ytmvAttached = true;

    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();

    let sourceNode;
    try {
      sourceNode = audioCtx.createMediaElementSource(video);
    } catch (e) {
      console.warn("[YTM Volume Leveler] could not attach to media element", e);
      return;
    }

    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 1024;

    gainNode = audioCtx.createGain();

    const compressorNode = audioCtx.createDynamicsCompressor();
    compressorNode.threshold.value = -3;
    compressorNode.knee.value = 6;
    compressorNode.ratio.value = 12;
    compressorNode.attack.value = 0.003;
    compressorNode.release.value = 0.15;

    sourceNode.connect(analyserNode);
    analyserNode.connect(gainNode);
    gainNode.connect(compressorNode);
    compressorNode.connect(audioCtx.destination);

    video.addEventListener("play", resumeAudioContext);
    startTickLoop();
  }

  function startTickLoop() {
    if (tickTimer) return;
    const buf = new Float32Array(analyserNode.fftSize);
    tickTimer = setInterval(() => {
      if (!analyserNode || !gainNode) return;
      analyserNode.getFloatTimeDomainData(buf);

      let sumSquares = 0;
      for (let i = 0; i < buf.length; i++) sumSquares += buf[i] * buf[i];
      const instRms = Math.sqrt(sumSquares / buf.length);
      if (instRms < TUNING.silenceRms) return; // ignore silence/pauses

      smoothedRms += TUNING.rmsEma * (instRms - smoothedRms);

      const target = TARGET_PRESETS[settings.target] ?? TARGET_PRESETS[DEFAULT_SETTINGS.target];
      const desiredGain = clamp(target / Math.max(smoothedRms, 1e-4), TUNING.minAutoGain, TUNING.maxAutoGain);
      const rate = desiredGain > currentAutoGain ? TUNING.smoothingUp : TUNING.smoothingDown;
      currentAutoGain += rate * (desiredGain - currentAutoGain);

      applyGain();
    }, TUNING.tickMs);
  }

  function applyGain() {
    if (!gainNode || !audioCtx) return;
    const auto = settings.autoEnabled ? currentAutoGain : 1.0;
    const manual = getManualMultiplier();
    const combined = clamp(auto * manual, 0.15, OVERRIDE_LIMITS.maxCombined);
    gainNode.gain.setTargetAtTime(combined, audioCtx.currentTime, TUNING.gainTimeConstant);
  }

  // --- Track identification & change detection ---
  function getVideoIdFromUrl() {
    return new URLSearchParams(location.search).get("v");
  }

  // #movie_player is YouTube/YTM's persistent internal player element — it
  // lives in the player bar, not the routed SPA page, so unlike the URL it
  // *should* keep reflecting the actual playing video even while the user
  // has navigated elsewhere (search, a playlist, etc.) with the "Now
  // playing" panel collapsed. In practice this didn't reliably work on
  // music.youtube.com (unlike plain youtube.com) — kept as one attempt
  // among several below rather than trusted alone. See TASKS.md #1.
  function getMoviePlayer() {
    return document.querySelector("#movie_player");
  }

  function getCurrentVideoData() {
    const player = getMoviePlayer();
    if (player && typeof player.getVideoData === "function") {
      try {
        const data = player.getVideoData();
        if (data && data.video_id) return data;
      } catch (e) {
        // player API not ready yet — fall through to other lookups
      }
    }
    return null;
  }

  // Best-effort: the player bar's title link (when present) points at
  // `watch?v=<id>` for whatever is currently playing, independent of the
  // page the user has actually navigated to.
  function getVideoIdFromPlayerBarLink() {
    const link = document.querySelector('ytmusic-player-bar a[href*="watch?v="]');
    if (!link) return null;
    try {
      return new URL(link.href, location.origin).searchParams.get("v");
    } catch (e) {
      return null;
    }
  }

  // None of these sources are confirmed reliable on their own while the
  // "Now playing" panel is collapsed — try all of them, but track-change
  // detection (see computeTrackKey/checkForTrackChange) does NOT depend on
  // this succeeding, since navigator.mediaSession.metadata is the one
  // signal confirmed to keep updating regardless of panel state.
  function getCurrentVideoId() {
    const data = getCurrentVideoData();
    if (data && data.video_id) return data.video_id;
    const linkId = getVideoIdFromPlayerBarLink();
    if (linkId) return linkId;
    return getVideoIdFromUrl();
  }

  // Storage key for trackOverrides/learnedGains: prefer the real videoId,
  // but fall back to a title+artist composite when no videoId is available
  // at all (e.g. every getCurrentVideoId() strategy failed while browsing
  // with the panel collapsed). The "t:" prefix guarantees this can never
  // collide with a real 11-character YouTube video ID.
  function computeTrackKey(videoId, title, artist) {
    if (videoId) return videoId;
    if (title) return `t:${title.toLowerCase()}|${(artist || "").toLowerCase()}`;
    return null;
  }

  // The in-page player bar DOM (SELECTORS.title/byline) only reflects
  // metadata reliably while YTM's "Now playing" panel is the active view.
  // When the user collapses it to browse (search, playlists, etc.) while
  // still listening, those elements can be stale, hidden, or restructured.
  // navigator.mediaSession.metadata is what YTM feeds the OS-level lock
  // screen / notification controls, so it stays populated regardless of
  // which panel is showing — use it as the primary source, DOM as fallback
  // for the brief window before YTM has set it (e.g. very first load).
  function readTrackMetadata() {
    const msMetadata = navigator.mediaSession && navigator.mediaSession.metadata;
    if (msMetadata && msMetadata.title) {
      return {
        title: msMetadata.title.trim(),
        artist: msMetadata.artist ? msMetadata.artist.trim().toLowerCase().slice(0, 100) : null,
      };
    }

    const videoData = getCurrentVideoData();
    if (videoData && videoData.title) {
      return {
        title: videoData.title.trim(),
        artist: videoData.author ? videoData.author.trim().toLowerCase().slice(0, 100) : null,
      };
    }

    const titleEl = document.querySelector(SELECTORS.title);
    const bylineEl = document.querySelector(SELECTORS.byline);
    const title = titleEl?.textContent?.trim() || null;

    let artist = null;
    if (bylineEl?.textContent) {
      const parts = bylineEl.textContent
        .split("•") // "•"
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length) artist = parts[0].toLowerCase().slice(0, 100);
    }
    return { title, artist };
  }

  // Persist how far the AGC converged for a finished/outgoing track, so the
  // next time it plays currentAutoGain starts near the right value instead
  // of re-learning from scratch (see initAutoGainForTrack below). `key` is
  // whatever computeTrackKey() produced — a real videoId when available,
  // otherwise a title+artist composite.
  function saveLearnedGain(key, gain) {
    if (!key) return;
    touchAndSet(learnedGains, key, Math.round(gain * 100), LEARNED_GAIN_MAX_ENTRIES);
    chrome.storage.sync.set({ [STORAGE_KEYS.learnedGains]: learnedGains });
  }

  // Reset AGC state for a newly-started track: seed currentAutoGain from a
  // previously learned value (or a neutral 1.0 if this song has never been
  // played before), and align smoothedRms so desiredGain doesn't lurch on
  // the very next tick.
  function initAutoGainForTrack(key) {
    const learned = key && learnedGains[key] != null ? learnedGains[key] / 100 : 1.0;
    currentAutoGain = clamp(learned, TUNING.minAutoGain, TUNING.maxAutoGain);
    const target = TARGET_PRESETS[settings.target] ?? TARGET_PRESETS[DEFAULT_SETTINGS.target];
    smoothedRms = target / currentAutoGain;
  }

  function checkForTrackChange() {
    const meta = readTrackMetadata();
    const videoId = getCurrentVideoId();
    const newKey = computeTrackKey(videoId, meta.title, meta.artist);
    if (!newKey) return; // nothing usable yet (very early load)

    if (newKey === currentTrack.key) {
      // Same track: fill in whichever field wasn't ready yet on the last check.
      if (!currentTrack.title && meta.title) currentTrack.title = meta.title;
      if (!currentTrack.artist && meta.artist) currentTrack.artist = meta.artist;
      if (!currentTrack.videoId && videoId) currentTrack.videoId = videoId;
      return;
    }

    // Real change — driven primarily by mediaSession title/artist changing
    // (confirmed reliable regardless of panel state), not by videoId
    // resolution succeeding. If a videoId later becomes available for a
    // track that started under a title-only key (e.g. panel re-expanded
    // mid-song), this will treat it as one more "change" and briefly reset
    // AGC state for what's actually the same song — a known minor gap, not
    // worth the extra complexity of key migration to fully close.
    if (currentTrack.key) {
      saveLearnedGain(currentTrack.key, currentAutoGain);
    }

    currentTrack = { key: newKey, videoId, title: meta.title, artist: meta.artist };
    initAutoGainForTrack(newKey);
    applyGain(); // re-apply overrides for the new track immediately
  }

  let playerBarObserved = false;
  const playerBarObserver = new MutationObserver(checkForTrackChange);
  function ensurePlayerBarObserved() {
    if (playerBarObserved) return;
    const bar = document.querySelector(SELECTORS.playerBar);
    if (bar) {
      playerBarObserver.observe(bar, { childList: true, subtree: true, characterData: true });
      playerBarObserved = true;
    }
  }

  // --- Popup messaging ---
  function getState() {
    return {
      videoId: currentTrack.videoId,
      title: currentTrack.title,
      artist: currentTrack.artist,
      autoGain: Number(currentAutoGain.toFixed(2)),
      manualMultiplier: Number(getManualMultiplier().toFixed(2)),
      combinedGain: gainNode ? Number(gainNode.gain.value.toFixed(2)) : 1,
      autoEnabled: !!settings.autoEnabled,
      target: settings.target,
      hasTrackOverride: !!(currentTrack.key && trackOverrides[currentTrack.key] != null),
      hasArtistOverride: !!(currentTrack.artist && artistOverrides[currentTrack.artist] != null),
    };
  }

  function setManualOverride(scope, value) {
    const v = clamp(Number(value), OVERRIDE_LIMITS.minManual, OVERRIDE_LIMITS.maxManual);
    const intVal = Math.round(v * 100);
    if (scope === "track" && currentTrack.key) {
      touchAndSet(trackOverrides, currentTrack.key, intVal, OVERRIDE_LIMITS.maxEntries);
      chrome.storage.sync.set({ [STORAGE_KEYS.trackOverrides]: trackOverrides });
    } else if (scope === "artist" && currentTrack.artist) {
      touchAndSet(artistOverrides, currentTrack.artist, intVal, OVERRIDE_LIMITS.maxEntries);
      chrome.storage.sync.set({ [STORAGE_KEYS.artistOverrides]: artistOverrides });
    }
    applyGain();
  }

  function clearOverride(scope) {
    if (scope === "track" && currentTrack.key) {
      delete trackOverrides[currentTrack.key];
      chrome.storage.sync.set({ [STORAGE_KEYS.trackOverrides]: trackOverrides });
    } else if (scope === "artist" && currentTrack.artist) {
      delete artistOverrides[currentTrack.artist];
      chrome.storage.sync.set({ [STORAGE_KEYS.artistOverrides]: artistOverrides });
    }
    applyGain();
  }

  function setAutoEnabled(value) {
    settings.autoEnabled = value ? 1 : 0;
    chrome.storage.sync.set({ [STORAGE_KEYS.settings]: settings });
    applyGain();
  }

  function setTargetPreset(value) {
    settings.target = clamp(Math.round(Number(value)), 0, TARGET_PRESETS.length - 1);
    chrome.storage.sync.set({ [STORAGE_KEYS.settings]: settings });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case "GET_STATE":
        sendResponse(getState());
        break;
      case "SET_MANUAL_OVERRIDE":
        setManualOverride(msg.scope, msg.value);
        sendResponse({ ok: true });
        break;
      case "CLEAR_OVERRIDE":
        clearOverride(msg.scope);
        sendResponse({ ok: true });
        break;
      case "SET_AUTO_ENABLED":
        setAutoEnabled(msg.value);
        sendResponse({ ok: true });
        break;
      case "SET_TARGET_PRESET":
        setTargetPreset(msg.value);
        sendResponse({ ok: true });
        break;
      default:
        break;
    }
    return false; // all handlers respond synchronously
  });

  // --- Boot ---
  function init() {
    document.addEventListener("click", resumeAudioContext, { capture: true });
    window.addEventListener("yt-navigate-finish", checkForTrackChange);
    setInterval(checkForTrackChange, 1000); // fallback in case other signals are missed

    const bodyObserver = new MutationObserver(() => {
      const video = findVideoElement();
      if (video && !video.__ytmvAttached) ensureAudioGraph(video);
      ensurePlayerBarObserved();
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });

    const existingVideo = findVideoElement();
    if (existingVideo) ensureAudioGraph(existingVideo);
    ensurePlayerBarObserved();
    checkForTrackChange();
  }

  loadStorage(init);
})();
