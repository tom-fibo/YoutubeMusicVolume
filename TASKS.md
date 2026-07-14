# Tasks / Known Issues

Open items found during manual testing. See `MAINTENANCE.md` for architecture context and code pointers referenced below.

**Status legend**: 🔧 fix implemented, not yet manually verified · ✅ verified working · ❌ failed testing · 🟡 open, not yet implemented

---

## 1. ✅ Track switch not detected at all when YTM's player panel is collapsed

**Update**: the previous fix (Media Session metadata) addressed *title/artist lookup* once a track change was already detected, but testing showed the deeper problem: **the extension doesn't realize the song has changed at all** while the "Now playing" panel is collapsed and the user is browsing (search, playlists, etc.).

**Root cause**: `checkForTrackChange()` identified the playing video via `getVideoIdFromUrl()` (`new URLSearchParams(location.search).get("v")`). This only reflects the *currently playing* video while the URL itself is the watch page. Once the user navigates elsewhere in the SPA (search results, a playlist page, etc.) while playback continues via the persistent player bar, `location.search` reflects whatever page is being browsed — not the song still playing. The video ID effectively "freezes" at whatever it last was when the watch URL was active, so no change is ever detected until the user returns to a `watch?v=...` URL.

**First attempted fix (failed)**: added `getCurrentVideoId()` reading `document.querySelector('#movie_player').getVideoData().video_id`, on the assumption YTM exposes the same internal player element/API as regular youtube.com watch pages. Tested and **still failed** — most likely `#movie_player` either doesn't exist under that ID on `music.youtube.com`, isn't the same API surface, or is otherwise not reachable the way it is on youtube.com (couldn't confirm which without live DevTools access to inspect the actual page). Lesson: don't trust an unverified assumption about YTM's internal DOM/API as the *sole* mechanism for something this central — see `MAINTENANCE.md` for how this shaped the second attempt.

**Second fix implemented** (`content.js`) — redesigned to not depend on video-ID resolution succeeding at all:
- `checkForTrackChange()` now drives change detection off `navigator.mediaSession.metadata` (title/artist) as the primary signal, since that's a standard web platform API YTM must keep updated for OS lock-screen/notification controls to work — independently confirmed more trustworthy than any internal DOM/Polymer structure guess.
- A new `computeTrackKey(videoId, title, artist)` produces the identity used for storage (`trackOverrides`/`learnedGains`): the real videoId when any of three attempts resolve it (`#movie_player`, a `watch?v=` link in the player bar, or the URL), or a `t:title|artist` composite key when none of them do. Either way, a title/artist change is what triggers `checkForTrackChange()` to treat it as a new track — video ID resolution is now just "nice to have" for a cleaner key, not a requirement.
- **Known minor gap, not fully solved**: if a videoId becomes resolvable partway through a song that started under a title-only key (e.g. the panel gets re-expanded mid-song), the key changes and this is treated as one more "track change," briefly resetting AGC state for what's actually the same song. Considered adding key-migration logic to close this but decided it wasn't worth the added complexity/risk for a self-correcting, low-severity edge case — revisit if it turns out to matter in practice.

**To verify**: play a song, collapse the "Now playing" panel and browse (search for something, open a playlist) while letting the current song finish or skipping to the next one, then open the popup and confirm the title/artist/gain reflect the *new* song, not the one that was playing when you started browsing. Also worth checking: does a manual per-song override set while the panel is collapsed (title-only key) still apply correctly on replay?

---

## 2. ✅ Automatic gain didn't reset between songs, and wasn't remembered per song across replays

Verified working. `learnedGains` map in `chrome.storage.sync`, seeded/saved in `checkForTrackChange()` — see `MAINTENANCE.md` "Per-song learned gain" for details.

---

## 3. ✅ Mid-song gain changed too fast, flattening intentional in-song volume variance

Verified working. `TUNING.smoothingUp/Down` slowed to tau ≈ 67s/25s — see `MAINTENANCE.md` for details.

---

## 4. ✅ Target loudness is calibrated too high — songs already at an appropriate/louder volume still get boosted, even on the "Quiet" preset

**Symptom**: tracks the user considers already appropriately loud (or on the louder side) — e.g. *Reflection (Center of the Earth Mix)* — still get their gain increased, even with the target preset set to "Quiet."

**Likely cause**: `TARGET_PRESETS` (`content.js`) were rough initial guesses (`[0.03, 0.05, 0.08]` linear RMS) never validated against real playback. Naive full-band RMS also doesn't match perceived loudness well — content with wide dynamic range / more headroom (less brickwall limiting, e.g. ambient/downtempo mixes) can have a genuinely low average RMS despite sounding "loud enough," so the AGC keeps trying to boost it toward a target that's calibrated for more compressed/limited material.

**Fix implemented** (`content.js`, `TARGET_PRESETS`): lowered all three presets by roughly half (`[0.015, 0.025, 0.04]`) so meaningfully less boosting happens by default, particularly on "Quiet." This is a best-effort recalibration, not a measured fix — there was no way to play real audio and measure RMS in the environment this was implemented in.

**To verify**: replay *Reflection (Center of the Earth Mix)* (and a few other tracks you consider already fine) on the "Quiet" preset and confirm gain stays at/near 1.0x rather than climbing. If it's still boosting more than expected, the presets likely need another downward pass — check the popup's live "Auto gain" readout while such a track plays to see the actual number, which will make further tuning much faster than guessing blind.

**Open follow-up if this still isn't enough**: consider moving from raw linear-RMS targets to a dB-scale representation (more intuitive to tune) and/or a perceptual/K-weighted loudness measure closer to LUFS, which better accounts for the fact that bass-heavy content reads "louder" in raw RMS than equally-loud brighter content. Not implemented — would be a bigger change, only worth it if simple recalibration proves insufficient.
