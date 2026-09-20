# Handoff: WASM MPEG-2 playback dies on one damaged packet, then 404-storms

Recording 78643 cannot be played past ~1:54:33. It fails the same way every
time, so this is a deterministic repro, not a flake. Two independent defects
are involved; either can be fixed without the other.

Written 2026-09-20 by session `tablo-web-0e [d5b99a]` from two console logs the
user captured. The diagnosis below is traced to code and checked against the
running backend; the fix is **not** written yet. That is the work being handed
over.

---

## Working agreement — read this first

The session that wrote this (`tablo-web-0e`) is the one that pulls, builds,
deploys and merges to `main` on this machine. So:

- **Push your branch to `origin`.** Work that only exists in your working copy
  or a local branch cannot be merged, reviewed or deployed by anyone else. The
  remotes here are `origin` = `PeetMcK/tablo-web` (ours) and `upstream` =
  `trevor-viljoen/tablo-web` (not ours — do not push there).
- **Tell `tablo-web-0e` when it is pushed**, with the branch name and a one-line
  summary: `SendMessage({to: "tablo-web-0e", message: "..."})`. If that session
  is gone, say so in your final message to the user instead, naming the branch.
- Repo convention for landing work: branch → `fix(...)`/`feat(...)` commit →
  `git merge --no-ff` into `main` → push. Do not commit straight onto `main`.
- There is **no CI**. `.github/workflows/ci.yml` was removed on 2026-09-20 (it
  belonged to upstream and had never run on this fork — 0 runs, ever). Nothing
  checks your work but you: run `npm test` and `npm run build` in `frontend/`,
  and `backend/.venv/bin/python -m pytest backend/tests -q`.
- `npm run lint` currently reports 2 errors + 2 warnings, all pre-existing
  (`ChannelGrid.tsx`, `useMediaQuery.ts`, `LibraryView.tsx`, `VideoPlayer.tsx`).
  Do not let that stop you; do not add to it.

## How to run the app here

This Mac has **no container runtime**, so the compose path in the README does
not work. Native only:

```bash
backend/run-native.sh            # uvicorn on 127.0.0.1:8000, VideoToolbox
cd frontend && npm run dev       # Vite on 127.0.0.1:7070 (pinned, strictPort)
.claude/skills/tablo-stack/check-stack.sh    # exits 0 when the stack is right
```

Both were running when this was written (backend pid 11341, Vite pid 90134).
The backend does **not** hot-reload: restart it after a backend change. Vite
serves from source, so frontend edits are live.

---

## Symptom

Open recording 78643 (3:30:17, MPEG-2, WASM path) at ~1:54:33. Within seconds:

```
[ac3 @ ...] new bit allocation info must be present in block 0
[ac3 @ ...] error decoding the audio block
[tablo:warn] wasm decoder error: Error submitting the packet to the decoder: Unknown error
[tablo:warn] wasm session failed: decode error
[tablo:warn] recording wasm failed (decode error) — rebuilding
... rebuild lands on the same bytes ...
[tablo:warn] recording wasm gave up (decode error)
```

and then an unbounded stream of:

```
:7070/api/vod/<session>/06382.ts  404 (Not Found)
:7070/api/vod/<session>/06383.ts  404 (Not Found)
```

which never stops until the page is navigated away.

---

## Log 1 — with skips (16:38:39 – 16:39:18)

The user skipped +30 three times and -10 once before the failure. The skips are
incidental: see Log 2.

```
[tablo:net] 16:38:39 release recording 78643 — transcoding stops, cache kept
[tablo:player] 16:38:40 open recording 78643 as mpeg-2
The AudioContext was not allowed to start. It must be resumed (or created) after a user gesture on the page.
[tablo:wasm] 16:38:40 session starting
[tablo:wasm] 16:38:40 worker booted
[tablo:wasm] 16:38:40 decoder opened
[tablo:wasm] 16:38:41 fed segment 0
[tablo:wasm] 16:38:41 fed segment 1
[tablo:player] 16:38:41 opening at 1:53:03
[tablo:wasm] 16:38:41 decoder open
[tablo:wasm] 16:38:41 decoder rebuilt at epoch 1
[tablo:wasm] 16:38:41 fed segment 6279
[tablo:wasm] 16:38:41 fed segment 6280
[tablo:wasm] 16:38:41 fed segment 6281
[tablo:cache] 16:38:42 absent — 0:00 of 0:00 (0%)
[tablo:warn] 16:38:43 picture held
[tablo:cache] 16:38:45 absent — 0:00 of 0:00 (0%)
[tablo:wasm] 16:38:46 fed segment 6282
[tablo:cache] 16:38:48 absent — 0:00 of 0:00 (0%)
[tablo:wasm] 16:38:48 fields
[tablo:wasm] 16:38:49 fed segment 6283
[tablo:wasm] 16:38:50 fed segment 6284
[tablo:player] 16:38:50 skip +30 → 1:53:36
[tablo:player] 16:38:50 seek → 1:53:36
[tablo:wasm] 16:38:50 decoder rebuilt at epoch 2
[tablo:wasm] 16:38:50 fed segment 6311
[tablo:wasm] 16:38:50 fed segment 6312
[tablo:warn] 16:38:50 waiting for fields
[tablo:warn] 16:38:50 stalled at 1:53:36
[tablo:player] 16:38:51 resumed after 32ms at 1:53:35
[tablo:wasm] 16:38:51 fed segment 6313
[tablo:warn] 16:38:51 picture held
[tablo:cache] 16:38:51 absent — 0:00 of 0:00 (0%)
[tablo:wasm] 16:38:53 fed segment 6314
[tablo:wasm] 16:38:53 fields
[tablo:wasm] 16:38:54 fed segment 6315
[tablo:cache] 16:38:54 absent — 0:00 of 0:00 (0%)
[tablo:wasm] 16:38:55 fed segment 6316
[tablo:wasm] 16:38:55 fed segment 6317
[tablo:player] 16:38:56 skip +30 → 1:54:11
[tablo:wasm] 16:38:56 fed segment 6318
[tablo:player] 16:38:56 seek → 1:54:11
[tablo:wasm] 16:38:56 decoder rebuilt at epoch 3
[tablo:wasm] 16:38:57 fed segment 6345
[tablo:wasm] 16:38:57 fed segment 6346
[tablo:warn] 16:38:57 waiting for fields
[tablo:warn] 16:38:57 stalled at 1:54:11
[tablo:player] 16:38:57 resumed after 33ms at 1:54:10
[tablo:warn] 16:38:57 picture held
[tablo:cache] 16:38:57 absent — 0:00 of 0:00 (0%)
[tablo:wasm] 16:38:58 fed segment 6347
[tablo:wasm] 16:38:58 fields
[tablo:wasm] 16:38:59 fed segment 6348
[tablo:player] 16:38:59 skip +30 → 1:54:43
[tablo:player] 16:38:59 seek → 1:54:43
[tablo:wasm] 16:38:59 decoder rebuilt at epoch 4
[tablo:wasm] 16:39:00 fed segment 6375
[tablo:warn] 16:39:00 waiting for fields
[tablo:warn] 16:39:00 stalled at 1:54:42
[tablo:player] 16:39:00 resumed after 32ms at 1:54:42
[tablo:wasm] 16:39:00 fed segment 6376
[tablo:wasm] 16:39:00 fed segment 6377
[tablo:cache] 16:39:00 absent — 0:00 of 0:00 (0%)
[tablo:warn] 16:39:00 picture held
[tablo:wasm] 16:39:02 fed segment 6378
[tablo:wasm] 16:39:03 fed segment 6379
[tablo:player] 16:39:03 skip -10 → 1:54:35
[tablo:cache] 16:39:03 absent — 0:00 of 0:00 (0%)
[tablo:player] 16:39:03 seek → 1:54:35
[tablo:wasm] 16:39:03 decoder rebuilt at epoch 5
[tablo:wasm] 16:39:04 fed segment 6367
[tablo:wasm] 16:39:04 fed segment 6368
[tablo:warn] 16:39:04 waiting for fields
[tablo:warn] 16:39:04 stalled at 1:54:33
[tablo:wasm] 16:39:04 fields
[tablo:wasm] 16:39:04 fed segment 6369
[mpeg2video @ 0x2b73c0] skipped MB in I-frame at 37 5
[mpeg2video @ 0x2b73c0] Warning MVs not available
[mpeg2video @ 0x2b73c0] concealing 80 DC, 80 AC, 80 MV errors in I frame
[tablo:player] 16:39:04 resumed after 49ms at 1:54:33
[mpeg2video @ 0x2b73c0] Warning MVs not available
[mpeg2video @ 0x2b73c0] concealing 80 DC, 80 AC, 80 MV errors in B frame
[tablo:warn] 16:39:04 picture held
[tablo:wasm] 16:39:04 fed segment 6370
[ac3 @ 0x2b7a60] new bit allocation info must be present in block 0
[ac3 @ 0x2b7a60] error decoding the audio block
[tablo:warn] 16:39:04 wasm decoder error: Error submitting the packet to the decoder: Unknown error
[tablo:warn] 16:39:04 wasm decoder error: Error submitting the packet to the decoder: Unknown error
[tablo:warn] 16:39:04 wasm decoder error: Error submitting the packet to the decoder: Unknown error
[tablo:warn] 16:39:04 wasm session failed: decode error
[tablo:warn] 16:39:04 recording wasm failed (decode error) — rebuilding
:7070/api/vod/1fa9265e4ca74519b50c20a87efbe8ae/06374.ts:1  404 (Not Found)
[tablo:wasm] 16:39:05 session starting
[tablo:wasm] 16:39:05 worker booted
[tablo:wasm] 16:39:05 decoder opened
[tablo:cache] 16:39:06 absent — 0:00 of 0:00 (0%)
[tablo:wasm] 16:39:06 fed segment 0
[tablo:wasm] 16:39:06 fed segment 1
[tablo:wasm] 16:39:06 decoder open
[tablo:wasm] 16:39:06 decoder rebuilt at epoch 1
[tablo:wasm] 16:39:07 fed segment 6367
[tablo:wasm] 16:39:07 fed segment 6368
[mpeg2video @ 0x2b73c0] skipped MB in I-frame at 37 5
[mpeg2video @ 0x2b73c0] Warning MVs not available
[mpeg2video @ 0x2b73c0] concealing 80 DC, 80 AC, 80 MV errors in I frame
[mpeg2video @ 0x2b73c0] Warning MVs not available
[mpeg2video @ 0x2b73c0] concealing 80 DC, 80 AC, 80 MV errors in B frame
[tablo:warn] 16:39:07 picture held
[tablo:wasm] 16:39:09 fed segment 6369
[ac3 @ 0x2b7a60] new bit allocation info must be present in block 0
[ac3 @ 0x2b7a60] error decoding the audio block
[tablo:warn] 16:39:09 wasm decoder error: Error submitting the packet to the decoder: Unknown error
[tablo:warn] 16:39:09 wasm decoder error: Error submitting the packet to the decoder: Unknown error
[tablo:warn] 16:39:09 wasm session failed: decode error
[tablo:warn] 16:39:09 recording wasm gave up (decode error)
[tablo:cache] 16:39:09 absent — 0:00 of 0:00 (0%)
[tablo:wasm] 16:39:09 fed segment 6370
[tablo:warn] 16:39:09 wasm decoder error: Error submitting the packet to the decoder: Unknown error
:7070/api/vod/df93dfc89c3341ca838e1e0e6520e466/06382.ts:1  404 (Not Found)
[tablo:wasm] 16:39:10 fed segment 6371
[tablo:warn] 16:39:10 wasm decoder error: Error submitting the packet to the decoder: Unknown error
:7070/api/vod/df93dfc89c3341ca838e1e0e6520e466/06382.ts:1  404 (Not Found)
:7070/api/vod/df93dfc89c3341ca838e1e0e6520e466/06383.ts:1  404 (Not Found)

... this 06382/06383 pair repeats indefinitely, roughly two per poll,
    interleaved with `[tablo:cache] absent — 0:00 of 0:00 (0%)` every 3s.
    Stack on each, from the console:

open.ts:164   GET http://127.0.0.1:7070/api/vod/<session>/06382.ts 404 (Not Found)
  (anonymous) @ open.ts:164
  (anonymous) @ supply.ts:115
  (anonymous) @ supply.ts:162
  (anonymous) @ supply.ts:241
  (anonymous) @ session.ts:583
  (anonymous) @ session.ts:722
  Promise.then
  (anonymous) @ session.ts:722
  (anonymous) @ session.ts:754

last cache line:
[tablo:cache] 16:39:18 absent — 0:00 of 0:00 (0%) {playhead: '1:54:35', ahead: '0:00', ranges: 'none', error: null}
```

## Log 2 — no skips at all (16:40:29 – 16:40:53). **Use this as the repro.**

Opened straight at 1:54:33 and played forward. Same death, no seeking involved.

```
[tablo:net] 16:40:29 release recording 78643 — transcoding stops, cache kept
[tablo:player] 16:40:30 open recording 78643 as mpeg-2
[tablo:wasm] 16:40:30 session starting
[tablo:wasm] 16:40:30 worker booted
[tablo:wasm] 16:40:30 decoder opened
[tablo:wasm] 16:40:30 fed segment 0
[tablo:wasm] 16:40:30 fed segment 1
[tablo:player] 16:40:30 opening at 1:54:33
[tablo:wasm] 16:40:31 decoder open
[tablo:wasm] 16:40:31 decoder rebuilt at epoch 1
[tablo:wasm] 16:40:31 fed segment 6366
[tablo:wasm] 16:40:31 fed segment 6367
[mpeg2video @ 0x2b73c0] skipped MB in I-frame at 37 5
[mpeg2video @ 0x2b73c0] Warning MVs not available
[mpeg2video @ 0x2b73c0] concealing 80 DC, 80 AC, 80 MV errors in I frame
[tablo:warn] 16:40:31 picture held
[mpeg2video @ 0x2b73c0] Warning MVs not available
[mpeg2video @ 0x2b73c0] concealing 80 DC, 80 AC, 80 MV errors in B frame
[tablo:cache] 16:40:32 absent — 0:00 of 0:00 (0%)
[tablo:wasm] 16:40:33 fed segment 6368
[tablo:wasm] 16:40:34 fed segment 6369
[ac3 @ 0x2b7a60] new bit allocation info must be present in block 0
[ac3 @ 0x2b7a60] error decoding the audio block
[tablo:warn] 16:40:34 wasm decoder error: Error submitting the packet to the decoder: Unknown error
[tablo:warn] 16:40:34 wasm decoder error: Error submitting the packet to the decoder: Unknown error
[tablo:warn] 16:40:34 wasm session failed: decode error
[tablo:warn] 16:40:34 recording wasm failed (decode error) — rebuilding
[tablo:wasm] 16:40:34 fed segment 6370
[tablo:warn] 16:40:34 wasm decoder error: Error submitting the packet to the decoder: Unknown error
:7070/api/vod/194e871404e74b3ab066e2c8986b1cf4/06382.ts:1  404 (Not Found)
[tablo:wasm] 16:40:34 session starting
[tablo:wasm] 16:40:34 worker booted
[tablo:wasm] 16:40:34 decoder opened
[tablo:wasm] 16:40:35 fed segment 6371
[tablo:warn] 16:40:35 wasm decoder error: Error submitting the packet to the decoder: Unknown error
[tablo:wasm] 16:40:35 fed segment 0
[tablo:wasm] 16:40:35 fed segment 1
:7070/api/vod/194e871404e74b3ab066e2c8986b1cf4/06382.ts:1  404 (Not Found)
:7070/api/vod/194e871404e74b3ab066e2c8986b1cf4/06383.ts:1  404 (Not Found)
[tablo:wasm] 16:40:35 decoder open
[tablo:cache] 16:40:35 absent — 0:00 of 0:00 (0%)
[tablo:wasm] 16:40:35 decoder rebuilt at epoch 1
[tablo:wasm] 16:40:36 fed segment 6367
[tablo:wasm] 16:40:36 fed segment 6368
[mpeg2video @ 0x2b73c0] skipped MB in I-frame at 37 5
[mpeg2video @ 0x2b73c0] Warning MVs not available
[mpeg2video @ 0x2b73c0] concealing 80 DC, 80 AC, 80 MV errors in I frame
[mpeg2video @ 0x2b73c0] Warning MVs not available
[mpeg2video @ 0x2b73c0] concealing 80 DC, 80 AC, 80 MV errors in B frame
[tablo:warn] 16:40:36 picture held
[tablo:wasm] 16:40:37 fed segment 6369
[ac3 @ 0x2b7a60] new bit allocation info must be present in block 0
[ac3 @ 0x2b7a60] error decoding the audio block
[tablo:warn] 16:40:37 wasm decoder error: Error submitting the packet to the decoder: Unknown error
[tablo:warn] 16:40:37 wasm decoder error: Error submitting the packet to the decoder: Unknown error
[tablo:warn] 16:40:37 wasm session failed: decode error
[tablo:warn] 16:40:37 recording wasm gave up (decode error)
[tablo:wasm] 16:40:38 fed segment 6370
[tablo:warn] 16:40:38 wasm decoder error: Error submitting the packet to the decoder: Unknown error
:7070/api/vod/10bd9e229e52479ca97ca2288deb4d5a/06382.ts:1  404 (Not Found)
[tablo:cache] 16:40:38 absent — 0:00 of 0:00 (0%)
[tablo:wasm] 16:40:38 fed segment 6371
[tablo:warn] 16:40:38 wasm decoder error: Error submitting the packet to the decoder: Unknown error
:7070/api/vod/10bd9e229e52479ca97ca2288deb4d5a/06382.ts:1  404 (Not Found)
:7070/api/vod/10bd9e229e52479ca97ca2288deb4d5a/06383.ts:1  404 (Not Found)

... 06382/06383 then repeat for ever, ~2 per poll, with a
    `[tablo:cache] absent` line every 3 seconds. Final one observed:
[tablo:cache] 16:40:53 absent — 0:00 of 0:00 (0%) {playhead: '1:54:35', ahead: '0:00', ranges: 'none', error: null}
```

---

## Defect A — a single refused packet is fatal to the session

Chain, all in `frontend/src/lib/wasmlive/`:

1. `workerProtocol.ts:130` — `await decoder.push(new Uint8Array(message.bytes))`
   throws when libav's `send_packet` refuses the packet. The message
   "Error submitting the packet to the decoder" comes from libav, after the
   `[ac3] new bit allocation info must be present in block 0` warning.
2. `workerProtocol.ts:167` — the surrounding `catch` turns *any* throw into
   `post({ type: "error", message })`.
3. `session.ts:465-467` — any `error` message becomes
   `reduceFallback(fallback, { kind: "decode-error" })`.
4. `fallback.ts:73-74` — `decode-error` sets `failed: "decode error"`, and
   `fallback.ts:68` (`if (state.failed) return state;`) latches it for good.
5. `VideoPlayer.tsx:1048-1080` — `onFailure` rebuilds once at the current
   playhead, then gives up on the second failure.

There is no tolerance anywhere on that path: one bad packet ends the session.
The rebuild resumes at the same playhead by design, feeds the same bytes, and
fails identically — which is why it is reproducible rather than flaky.

## Defect B — the 404 storm is a dead session still polling

The 404s are **not** missing segments and **not** past the end of the
recording. They are `"Stream session not found"` from
`backend/app/routes/stream.py:935-941` (`_vod_session`), because:

- `VideoPlayer.tsx:1065` calls `api.stopStream(raw.session_id)` on give-up
  (and on rebuild), which removes the session from the backend's in-memory map;
- but the failed wasm surface is never destroyed, so its poll timer
  (`session.ts:719-752` → `safePoll` → `session.ts:583` → `supply.ts:241`)
  keeps requesting the next two segments in its plan for ever.

`safePoll` already has a guard for exactly this — `session.ts:734-737` detects
`sessionGone(e)` and feeds `{ kind: "session-gone" }` to the fallback machine —
but it **cannot fire**, because `reduceFallback` returns early on an
already-`failed` state and `"decode error"` was latched seconds earlier. Even if
it did fire, nothing on that path stops the timer.

Note the prefetcher's own 404 protection (`supply.ts:137-160`, from the earlier
"vod 404 storm" fix) is working as designed — it unplans a failed segment and
deliberately does not `pump()`. That is why this storm is ~2 requests per poll
rather than thousands per sweep. It is a slower leak of the same kind.

---

## Evidence already gathered (do not redo)

Against the running backend, recording 78643:

```
POST /api/recordings/78643/watch-vod
  → {"duration":12617.436866,"segments":11748,"growing":false,"mode":"vod"}
```

So the recording is 3:30:17 with **11,748 segments**; the failure is ~54% in,
nowhere near the end. Then, through a fresh session:

```
seg 00100 -> 200 642208B     06367 -> 200 1253020B
seg 06369 -> 200  909920B    06382 -> 200  719100B
seg 06383 -> 200 1126684B    11747 -> 200  504028B
```

Every one of those is a well-formed transport stream: first byte `0x47`, size an
exact multiple of 188, sync bytes intact across the first 50 packets. **The
transport and the backend are not at fault** — including segments 6382/6383,
the very ones that 404 in the browser, which is what proves Defect B is a
session-lifetime problem rather than missing data.

## Ruled out

- Not the skip feature (Log 2 has no skips).
- Not segment numbers past the end of the index (11,748 segments exist).
- Not corrupt transport from the backend (segments verified well-formed).
- Not the `supply.ts` prefetch storm fixed earlier (that guard is holding).

## Suggested fix — unvalidated, use your own judgement

1. **Make a refused packet survivable.** Skip it and keep going rather than
   throwing out of `decoder.push`; count consecutive failures and fail the
   session only past a threshold. Damaged spots in OTA recordings are normal and
   the decoder resyncs at the next key frame. This is the change that makes
   recording 78643 playable. Note the `mpeg2video` concealment warnings just
   before it: the video decoder already tolerates damage here; only the audio
   path is fatal.
2. **Stop a dead session's timer.** Destroy the surface on give-up and on
   rebuild in `VideoPlayer.tsx`, so the poll loop ends with the session it
   belongs to. Independently, consider letting `session-gone` override an
   already-latched failure in `reduceFallback` — "the backend forgot me" is
   strictly more actionable than whatever failed first.

(1) fixes the user-visible problem; (2) only stops the console flood. They are
separable, and (2) is the smaller, safer change.

## Repo state at handoff

`main` is at `443ef24`. Five files are modified in the working copy and are
**not** committed or pushed — leave them alone unless the user says otherwise:

```
 M .claude/skills/tablo-stack/SKILL.md      (native-on-7070 is the documented default)
 M .claude/skills/tablo-stack/check-stack.sh (checker learned native mode)
 M README.md                                 (24h dependency-age note)
 M frontend/vite.config.ts                   (dev+preview pinned to 127.0.0.1:7070)
?? frontend/.npmrc                           (min-release-age=1)
```

Recent related commits on `main`: `34d1e28` (jsdom localStorage restored in
tests), `443ef24` (upstream CI workflow removed), `70395a4` (configurable skip),
`5c45c13`/`60bf0b3` (OS Now Playing + the silent audio anchor).

---

## Addendum, 2026-09-20 16:48 — "it only happens on this box"

The user reports the crash does not occur on their other machines. That does
**not** point at local corruption, and it fits Defect A exactly:

`wasmlive/capability.ts:52-61` gates the WASM MPEG-2 path on two things — the
`tablo.wasmlive` localStorage flag (**on unless explicitly set to `"0"`**) and a
Chrome-family desktop UA (`/Chrome\/|Edg\//`, excluding `CriOS|Android`).
Anything else falls through `chooseLivePath` to `mode: "transcode"`, which
decodes H.264 in the browser's own pipeline and never runs libav-in-WASM at all.

So a box on Safari or Firefox, or one where the kill switch was set, cannot hit
this. The logs here show `open recording 78643 as mpeg-2` and an Edge-only
`Intervention` line (`go.microsoft.com/fwlink`), i.e. this box is taking the
WASM path. Machine-specific is what a defect confined to that path looks like —
it is not evidence that the recording or this host is at fault.

**Viewer-level workaround while this is open:** in the browser console,
`localStorage.setItem("tablo.wasmlive", "0")` and reload. Playback falls back to
the transcode path, which does not go near the failing decoder.

### Ruled out by a clean restart

Done at 16:48 on this box, and the failure reproduced immediately afterwards
from the reconnected tab:

- `frontend/node_modules/.vite` (9.5 MB) and `.vite-temp` deleted, so the dev
  server re-optimised its dependencies from scratch — **not** a stale optimised
  bundle or a cached wasm asset.
- Both processes stopped and restarted clean (backend pid 14187, Vite pid
  14215); no stray `ffmpeg` processes existed before or after; `check-stack.sh`
  exits 0.
- `npm ls --depth=0` reports no unmet or invalid installs, so `node_modules`
  matches `package.json`.

If you want to narrow the environment further, the remaining box-specific
variables are the browser build itself and this host's GPU/WebGL2 backing for
the presenter — but note the failure is in `decoder.push` (audio), upstream of
anything the presenter does.
