# Maintenance Guide

Read this first if you're picking up this project cold (including a fresh chat with no prior context). It explains what the extension does, how the pieces fit together, and where the fragile parts are.

## What this is

A Manifest V3 Chrome extension for `music.youtube.com` that fixes song-to-song loudness inconsistency. It has two layers:

1. **Automatic**: a Web Audio `GainNode` is driven by a simple real-time AGC (automatic gain control) loop that watches RMS loudness and nudges gain toward a target level.
2. **Manual override**: the user can set a multiplier for the current song or artist via the toolbar popup, which layers on top of the automatic gain. Overrides sync across devices via `chrome.storage.sync`.

No build step, no frameworks — plain JS/HTML/CSS, loaded as an unpacked extension.

## Files

| File | Responsibility |
|---|---|
| `manifest.json` | MV3 manifest. No service worker/background script — popup talks directly to the content script. |
| `content.js` | Everything: finds the `<video>` element, builds the Web Audio graph, runs the AGC tick loop, detects track changes, reads/writes `chrome.storage.sync`, handles messages from the popup. One file by design — see "Why one file" below. |
| `popup.html` / `popup.js` / `popup.css` | Toolbar popup UI: current track, auto/combined gain readout, auto-normalize toggle, target preset (quiet/normal/loud), manual override slider (song or artist scope), clear-override button. |
| `icons/*.png` | **Placeholder icons**, generated programmatically (simple flat-color speaker glyph) — not a real design. Replace before any Chrome Web Store submission. |

### Why one file for `content.js`

MV3 content scripts without a bundler need `"type": "module"` config gymnastics to split cleanly across files. At ~330 lines this isn't worth it. If it grows meaningfully past that, reconsider.

## Architecture / boot sequence

1. `loadStorage(init)` reads `settings` / `trackOverrides` / `artistOverrides` from `chrome.storage.sync` into module-level variables, then calls `init()`.
2. `init()`:
   - Registers a document-level `click` listener to resume the `AudioContext` (it starts `"suspended"` until a user gesture).
   - Registers `yt-navigate-finish` (YouTube's internal SPA navigation event) and a 1s `setInterval` fallback, both calling `checkForTrackChange()`.
   - Starts a `MutationObserver` on `document.body` that (a) attaches the audio graph the first time it finds a `<video>` element, and (b) starts observing the player bar for title/byline changes once it exists.
   - Runs an initial `checkForTrackChange()`.
3. Once a `<video>` is found, `ensureAudioGraph(video)` builds the Web Audio chain and starts the AGC tick loop (`startTickLoop`, `setInterval` @ 100ms).
4. The popup queries `GET_STATE` from the content script on open and every 1s while open; user actions (toggle, slider, preset) send messages back.

## Audio graph

```
video element
  → MediaElementAudioSourceNode   (source)
  → AnalyserNode                  (fftSize 1024, used to read RMS for the AGC loop)
  → GainNode                      (the actual volume control — combined auto × manual gain)
  → DynamicsCompressorNode        (safety limiter: threshold -3dB, ratio 12, attack 3ms, release 150ms)
  → audioCtx.destination
```

Constraints to respect if you touch this code:

- `createMediaElementSource()` can only be called **once per `<video>` element, ever** — a second call throws `InvalidStateError`. Guarded via `video.__ytmvAttached`. If YTM ever swaps in a new `<video>` node, the body `MutationObserver` will catch it and build a fresh graph for the new element.
- Once a `MediaElementAudioSourceNode` exists, audio **only** reaches speakers via wherever the graph is connected — if the chain doesn't reach `audioCtx.destination`, the page goes silent. This is the most common thing to break here.
- `AudioContext` starts `"suspended"`; `resumeAudioContext()` is called from both a document click listener and the video's own `play` event.
- Gain clamps exist at three points (see `TUNING` / `OVERRIDE_LIMITS` in `content.js`): auto-gain (0.3x–3.0x), manual override (0.25x–4x), and the combined product (hard-capped, currently 4x, floor 0.15x).

## Automatic normalization algorithm (current implementation)

Runs every 100ms in `startTickLoop`:

1. Read `AnalyserNode.getFloatTimeDomainData()`, compute instantaneous RMS over the buffer.
2. Skip the tick entirely if RMS is below `TUNING.silenceRms` (avoid reacting to silence/pauses).
3. Smooth RMS with a fast 1-pole EMA (`TUNING.rmsEma = 0.2`, tau ~500ms) — this is just noise reduction on the raw reading, not the song-leveling itself.
4. `desiredGain = clamp(target / smoothedRms, minAutoGain, maxAutoGain)`, where `target` comes from `TARGET_PRESETS[settings.target]` (quiet/normal/loud = 0.015/0.025/0.04 — halved from initial guesses after testing showed even "Quiet" was boosting already-appropriate tracks; still a best-effort calibration pending further listening tests, see `TASKS.md` #4).
5. Move `currentAutoGain` toward `desiredGain` with **asymmetric, deliberately slow rates** — `TUNING.smoothingUp = 0.0015` (tau ~67s) vs `TUNING.smoothingDown = 0.004` (tau ~25s). This is the key mechanism that preserves a song's own dynamics (quiet verse vs loud chorus): `desiredGain` swings around a lot tick to tick, but `currentAutoGain` only drifts toward its *trend* over roughly the song's length, so short-term swings pass through mostly unflattened while the song-to-song average gets leveled.
6. Apply via `gainNode.gain.setTargetAtTime(combined, audioCtx.currentTime, TUNING.gainTimeConstant)` — deliberately **not** `linearRampToValueAtTime`, which would produce audible staircase artifacts since the target changes every tick.

### Per-song learned gain (persists across replays)

`currentAutoGain` is no longer a pure carry-over between songs. On every detected track change (`checkForTrackChange`):

- **Before** switching, `saveLearnedGain(outgoingVideoId, currentAutoGain)` writes wherever the AGC had converged to into `learnedGains[videoId]` (`chrome.storage.sync`, LRU-capped at `LEARNED_GAIN_MAX_ENTRIES = 150`). This is the closest available proxy for "song finished" — there's no explicit `ended`-event hook, so a song skipped early saves whatever gain had been reached by that point, not a fully-converged value. If the tab/browser closes mid-song without a subsequent track change, that listen's progress is never saved (accepted limitation, not handled).
- **After** switching, `initAutoGainForTrack(newVideoId)` seeds `currentAutoGain` from `learnedGains[videoId]` if present, or `1.0` (neutral) if this song has never been played before — and back-calculates `smoothedRms` from that so `desiredGain` doesn't jump on the very next tick.

`learnedGains` is intentionally a separate storage map from `trackOverrides` — one is the AGC's own memory, the other is an explicit user-set multiplier from the popup. `applyGain()` combines `currentAutoGain × manual override` exactly as before; only where `currentAutoGain` starts from, and how fast it moves, changed.

## Track identification & change detection

**Important lesson learned here** (see `TASKS.md` #1 for the full history): an earlier version of this made video-ID resolution (`#movie_player.getVideoData()`) the thing that *drove* change detection — it seemed reliable by analogy with regular youtube.com, but testing showed it wasn't, and video ID went stale exactly when the "Now playing" panel was collapsed (the scenario that mattered most). The current design instead treats video-ID resolution as best-effort and drives detection off `navigator.mediaSession.metadata`, which is a standard web API YTM has to keep correct for OS-level lock screen/notification integration to work at all — a much safer thing to depend on than guessing at internal Polymer/DOM structure. **Keep this ordering if you touch this code again**: metadata (title/artist) changing is the trigger; video ID is only ever used to build a nicer storage key when it happens to be available.

- **`computeTrackKey(videoId, title, artist)`** is what storage (`trackOverrides`/`learnedGains`) is actually keyed by: the real videoId if any resolution attempt succeeded, otherwise a `t:<title>|<artist>` composite (the `t:` prefix guarantees it can never collide with a real 11-character YouTube video ID). `currentTrack.key` holds this; `currentTrack.videoId` is kept separately purely for popup display/debugging and may be `null` even while `currentTrack.key` is set.
- **Video ID resolution** (`getCurrentVideoId()`) tries, in order: `document.querySelector("#movie_player").getVideoData().video_id` (unconfirmed whether this ID/API even exists on `music.youtube.com` — kept since it's cheap to try and does no harm when absent), a `watch?v=` link inside `ytmusic-player-bar` if one exists, then `location.search`'s `v` param (`getVideoIdFromUrl()` — the original, page-dependent approach, now just one fallback among several rather than the sole source).
- **Title/artist** (`readTrackMetadata()`), in order of preference: `navigator.mediaSession.metadata` (`.title`/`.artist` — populated regardless of which panel is showing) → `#movie_player.getVideoData()`'s `.title`/`.author` → scraping `ytmusic-player-bar .title`/`.byline` DOM text as a last resort. Byline format when falling all the way back is `"Artist • Album • Year"` — split on `•`, first segment, lowercased and truncated to 100 chars.
- **Change detection** (`checkForTrackChange()`) combines three trigger signals — the `yt-navigate-finish` event, a `MutationObserver` on the player bar, and a 1s polling fallback — all of which just call `checkForTrackChange()`, which itself computes `computeTrackKey(...)` and compares it against `currentTrack.key`. A change is only "real" (resets AGC state, saves the outgoing song's learned gain) when the key differs; if the key matches but title/artist/videoId had been missing before, it backfills them without treating it as a new track.
- **Known minor gap**: if a videoId becomes resolvable mid-song after starting under a title-only key (panel re-expanded), the key changes and this one time gets (incorrectly) treated as a track change. Accepted tradeoff — see `TASKS.md` #1 for why key-migration logic wasn't added.
- `SELECTORS` in `content.js` (`playerBar`, `title`, `byline`) are **unofficial, unversioned YTM DOM implementation details** and will break on redesigns — now only a last-resort fallback, but still centralized at the top of `content.js` so a break is a one-place fix. All metadata/ID lookups fail soft (return `null`, never throw); the audio graph itself only depends on finding a `<video>` element, the most stable dependency of all, so normalization keeps working even if every identification layer above it breaks.

## Storage schema (`chrome.storage.sync`)

Four top-level keys, chosen to stay well under sync quotas (8KB/item, 512 items, ~100KB total, ~120 writes/min):

```js
{
  settings:       { autoEnabled: 1, target: 1, minGain: 30, maxGain: 300 }, // gain values as int(gain*100)
  trackOverrides: { "<trackKey>": 125, ... },          // user-set multiplier*100, LRU-capped at 150 entries
  artistOverrides:{ "<lowercased artist>": 80, ... },  // same, keyed by artist string
  learnedGains:   { "<trackKey>": 87, ... },           // AGC's own memory, gain*100, LRU-capped at 150 entries
}
```

`<trackKey>` is whatever `computeTrackKey()` produced (see "Track identification & change detection" above) — a real videoId when resolvable, otherwise a `t:title|artist` composite. `learnedGains` is written by the content script itself (not the popup) whenever a track change is detected — see "Per-song learned gain" above. It is never touched by user actions.

- LRU eviction (`touchAndSet` in `content.js`): delete-then-reinsert on every write moves a key to "most recent" (JS objects preserve string-key insertion order); oldest key is dropped once over `OVERRIDE_LIMITS.maxEntries` (or `LEARNED_GAIN_MAX_ENTRIES` for `learnedGains`).
- `chrome.storage.onChanged` listener keeps in-memory copies fresh if edited from another synced device (or from the popup in the same session).
- Popup slider writes are debounced client-side (~400ms) to stay under the write-rate budget; toggle/preset changes write immediately.

## Popup ↔ content script messaging

No background/service worker — popup calls `chrome.tabs.sendMessage(tabId, {...})` directly against the YTM tab; content script replies synchronously via `chrome.runtime.onMessage`.

| `type` | Direction | Payload | Notes |
|---|---|---|---|
| `GET_STATE` | popup → content | — | Returns `{videoId, title, artist, autoGain, manualMultiplier, combinedGain, autoEnabled, target, hasTrackOverride, hasArtistOverride}` |
| `SET_MANUAL_OVERRIDE` | popup → content | `{scope: "track"\|"artist", value: number}` | Writes to `trackOverrides`/`artistOverrides` |
| `CLEAR_OVERRIDE` | popup → content | `{scope: "track"\|"artist"}` | Deletes the override for the current track/artist |
| `SET_AUTO_ENABLED` | popup → content | `{value: boolean}` | Toggles `settings.autoEnabled` |
| `SET_TARGET_PRESET` | popup → content | `{value: 0\|1\|2}` | Sets `settings.target` (quiet/normal/loud) |

If the content script isn't injected yet (tab still loading, or not a YTM tab), `chrome.tabs.sendMessage` rejects — popup catches this and shows the empty state.

## How to load & test locally

1. `chrome://extensions` → enable Developer mode → "Load unpacked" → select this folder.
2. After editing `content.js`, reload the extension (the reload icon on the extension card) **and** refresh the YTM tab — content scripts don't hot-reload.
3. After editing `popup.*`, just closing and reopening the popup is enough (no extension reload needed).
4. Check both the page DevTools console (content script errors, e.g. `InvalidStateError`) and `chrome://extensions` for manifest-level errors.

## Versioning

Bump the `version` field in `manifest.json` on any released change (Chrome requires a version bump to reload an already-installed unpacked extension in some flows, and it's good hygiene regardless).
