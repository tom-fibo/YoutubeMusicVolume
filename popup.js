(function () {
  const emptyState = document.getElementById("empty-state");
  const app = document.getElementById("app");
  const titleEl = document.getElementById("track-title");
  const artistEl = document.getElementById("track-artist");
  const autoToggle = document.getElementById("auto-toggle");
  const targetSelect = document.getElementById("target-select");
  const autoGainValue = document.getElementById("auto-gain-value");
  const combinedGainValue = document.getElementById("combined-gain-value");
  const overrideSlider = document.getElementById("override-slider");
  const overrideValue = document.getElementById("override-value");
  const clearOverrideBtn = document.getElementById("clear-override-btn");

  let tabId = null;
  let pollTimer = null;

  function debounce(fn, wait) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  function currentScope() {
    return document.querySelector('input[name="scope"]:checked').value;
  }

  function sendMessage(msg) {
    return chrome.tabs.sendMessage(tabId, msg).catch(() => null);
  }

  function render(state) {
    titleEl.textContent = state.title || "(unknown title)";
    artistEl.textContent = state.artist || "(unknown artist)";
    autoToggle.checked = state.autoEnabled;
    targetSelect.value = String(state.target);
    autoGainValue.textContent = `${state.autoGain.toFixed(2)}x`;
    combinedGainValue.textContent = `${state.combinedGain.toFixed(2)}x`;

    const scope = currentScope();
    const hasOverride = scope === "artist" ? state.hasArtistOverride : state.hasTrackOverride;
    if (!overrideSlider.matches(":active")) {
      overrideSlider.value = hasOverride ? state.manualMultiplier : 1;
      overrideValue.textContent = `${Number(overrideSlider.value).toFixed(2)}x`;
    }
  }

  async function refresh() {
    const state = await sendMessage({ type: "GET_STATE" });
    if (state) render(state);
  }

  const sendOverride = debounce((value) => {
    sendMessage({ type: "SET_MANUAL_OVERRIDE", scope: currentScope(), value });
  }, 400);

  overrideSlider.addEventListener("input", () => {
    const v = Number(overrideSlider.value);
    overrideValue.textContent = `${v.toFixed(2)}x`;
    sendOverride(v);
  });

  document.querySelectorAll('input[name="scope"]').forEach((radio) => {
    radio.addEventListener("change", refresh);
  });

  autoToggle.addEventListener("change", () => {
    sendMessage({ type: "SET_AUTO_ENABLED", value: autoToggle.checked });
  });

  targetSelect.addEventListener("change", () => {
    sendMessage({ type: "SET_TARGET_PRESET", value: targetSelect.value });
  });

  clearOverrideBtn.addEventListener("click", async () => {
    await sendMessage({ type: "CLEAR_OVERRIDE", scope: currentScope() });
    refresh();
  });

  async function init() {
    const [tab] = await chrome.tabs.query({ url: "*://music.youtube.com/*", active: true, lastFocusedWindow: true });
    const targetTab = tab || (await chrome.tabs.query({ url: "*://music.youtube.com/*" }))[0];
    if (!targetTab) {
      emptyState.hidden = false;
      return;
    }
    tabId = targetTab.id;
    const state = await sendMessage({ type: "GET_STATE" });
    if (!state) {
      emptyState.hidden = false;
      return;
    }
    app.hidden = false;
    render(state);
    pollTimer = setInterval(refresh, 1000);
  }

  window.addEventListener("unload", () => {
    if (pollTimer) clearInterval(pollTimer);
  });

  init();
})();
