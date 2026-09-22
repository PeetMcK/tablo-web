# H.264 Recordings Playback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An H.264 recording plays in every browser, with sound, without re-encoding the picture and without asking the MPEG-2 WASM decoder to decode it.

**Architecture:** The device already labels each recording's codec (`video_details.container_format`: `"mpeg2"` vs `"mpeg4"`); the backend projects it as `codec`, and the VOD proxy grows a sibling segment name that copies the H.264 video and re-encodes only the AC-3 audio to AAC. The player routes on that label — MPEG-2 keeps the WASM decoder, H.264 takes the device's own segments through hls.js — and corrects itself once if the decoder reports a codec it does not have.

**Tech Stack:** FastAPI + httpx + ffmpeg (backend), React + hls.js + vitest (frontend), pytest.

**Spec:** `docs/superpowers/specs/2026-09-22-h264-recordings-playback.md`

## Global Constraints

- Codec mapping is exactly `{"mpeg2": "mpeg2", "mpeg4": "h264"}`. Anything else, including a missing field, projects as `None`/`null` and takes the MPEG-2 path.
- The swap command is `ffmpeg -v error -copyts -i pipe:0 -c:v copy -c:a aac -b:a 160k -ac 2 -f mpegts pipe:1`. `-c:v copy` is not negotiable: the picture must be the device's bytes.
- Segment boundaries never move. The swapped segment answers the same `#EXTINF` the device's did, so no window or keyframe machinery is involved.
- Swapped bytes are never written to disk. `vod_segment`'s contract is "fetched from the device on demand and never stored", and this keeps it.
- Run backend tests with `/Users/peet/GitHub/tablo-web/backend/.venv/bin/python -m pytest`; frontend with `npx vitest run` from `frontend/`.
- Typecheck with `npm run build` in `frontend/`, never `npx tsc --noEmit` alone — the build runs `tsc -b` with `erasableSyntaxOnly`, which rejects things the looser check accepts.

---

### Task 1: The device's codec label reaches the client

**Files:**
- Modify: `backend/app/state.py` (`_recording_fields`, ~line 1085–1180)
- Test: `backend/tests/test_recordings.py`

**Interfaces:**
- Produces: every recording projection gains `"codec": "mpeg2" | "h264" | None`. `recording_snapshot` returns the same projection, so an offline copy keeps it.

- [ ] **Step 1: Write the failing tests**

```python
def test_the_device_codec_label_is_projected():
    """`container_format` is the device's word for the video codec, and it is
    the only field that separates an H.264 recording from an MPEG-2 one — the
    dimensions are the device's intent rather than what it wrote."""
    from app.state import AppState

    mpeg2 = AppState._recording_fields(
        {"object_id": 1, "path": "/recordings/series/episodes/1",
         "video_details": {"container_format": "mpeg2", "height": 1080,
                           "flags": ["interlaced"]}})
    h264 = AppState._recording_fields(
        {"object_id": 2, "path": "/recordings/sports/events/2",
         "video_details": {"container_format": "mpeg4", "height": 1080,
                           "flags": []}})

    assert mpeg2["codec"] == "mpeg2"
    assert h264["codec"] == "h264"


def test_an_unrecognised_codec_label_is_no_codec_at_all():
    """A format nobody has seen must not be guessed at: null takes the MPEG-2
    path, which is what 38 of 39 recordings on the device are."""
    from app.state import AppState

    assert AppState._recording_fields(
        {"object_id": 3, "video_details": {"container_format": "hevc"}})["codec"] is None
    assert AppState._recording_fields(
        {"object_id": 4, "video_details": {}})["codec"] is None
```

- [ ] **Step 2: Run them and watch them fail**

Run: `.venv/bin/python -m pytest tests/test_recordings.py -k codec -q`
Expected: FAIL, `KeyError: 'codec'`.

- [ ] **Step 3: Project the field**

In `backend/app/state.py`, above `class AppState` (beside `_scan_label`):

```python
#: The device's `video_details.container_format`, which is its word for the
#: video codec rather than the container - everything it serves is MPEG-TS.
#: Measured across 39 recordings on 2026-09-22: 38 "mpeg2", one "mpeg4", and
#: ffprobe of that one's segments says h264 High 1280x720. Anything else maps
#: to None rather than a guess, so a format nobody has seen takes the path 38
#: of 39 recordings need.
_VIDEO_CODECS = {"mpeg2": "mpeg2", "mpeg4": "h264"}
```

and in `_recording_fields`, beside `"scan"`/`"interlaced"`:

```python
            "codec": _VIDEO_CODECS.get(vd.get("container_format")),
```

- [ ] **Step 4: Run them and watch them pass**

Run: `.venv/bin/python -m pytest tests/test_recordings.py -k codec -q`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/app/state.py backend/tests/test_recordings.py
git commit -m "feat(recordings): project the codec the device already names"
```

---

### Task 2: A segment whose audio the browser can decode

**Files:**
- Modify: `backend/app/vod_index.py` (`VodIndex.playlist`)
- Modify: `backend/app/routes/stream.py` (`VodSession`, `_SEGMENT_RE` use in `vod_segment`, `vod_playlist`)
- Test: `backend/tests/test_vod_routes.py`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `VodSession(index, device_url, swap_audio: bool = False)`; `VodIndex.playlist(suffix: str = ".ts")`; `GET /api/vod/{sid}/{nnnnn}.aac.ts`; `stream.swap_segment_audio(payload: bytes) -> bytes`; `stream.SWAP_CACHE` (an `OrderedDict` keyed `(session_id, number)`).

- [ ] **Step 1: Write the failing tests**

```python
def test_a_swapped_session_names_segments_the_browser_can_decode():
    """Chrome has no AC-3 decoder in any container - measured 2026-09-22, every
    ac-3 mime string is false in both MSE and <video>. The playlist for an H.264
    recording therefore names the swapped segment, and nothing else changes."""
    index = parse_vod_playlist(PLAYLIST, BASE)
    stream.vod_sessions[SESSION] = stream.VodSession(
        index=index, device_url=BASE, swap_audio=True)
    try:
        body = client.get(f"/api/vod/{SESSION}/playlist.m3u8").text
    finally:
        _clear()

    assert "00000.aac.ts" in body
    assert "00000.ts\n" not in body
    # The boundaries the device published, unmoved.
    assert body.count("#EXTINF:1.500,") == 2


def test_a_swapped_segment_keeps_the_video_and_changes_the_audio(monkeypatch):
    """`-c:v copy`: the picture is the device's bytes. Only the AC-3 is touched."""
    _register()
    seen = {}

    async def fake_fetch(url, byte_range=None):
        return b"DEVICE-TS"

    async def fake_swap(payload):
        seen["payload"] = payload
        return b"SWAPPED-TS"

    monkeypatch.setattr(stream, "_fetch_bytes", fake_fetch)
    monkeypatch.setattr(stream, "swap_segment_audio", fake_swap)
    try:
        r = client.get(f"/api/vod/{SESSION}/00000.aac.ts")
    finally:
        _clear()
        stream.SWAP_CACHE.clear()

    assert r.status_code == 200
    assert r.content == b"SWAPPED-TS"
    assert r.headers["content-type"].startswith("video/mp2t")
    assert seen["payload"] == b"DEVICE-TS"


def test_a_swapped_segment_is_only_made_once(monkeypatch):
    """A scrub back over a segment already swapped must not re-run ffmpeg."""
    _register()
    runs = []

    async def fake_fetch(url, byte_range=None):
        return b"DEVICE-TS"

    async def fake_swap(payload):
        runs.append(1)
        return b"SWAPPED-TS"

    monkeypatch.setattr(stream, "_fetch_bytes", fake_fetch)
    monkeypatch.setattr(stream, "swap_segment_audio", fake_swap)
    try:
        client.get(f"/api/vod/{SESSION}/00000.aac.ts")
        client.get(f"/api/vod/{SESSION}/00000.aac.ts")
    finally:
        _clear()
        stream.SWAP_CACHE.clear()

    assert len(runs) == 1


def test_a_failed_swap_is_an_error_not_the_untouched_segment(monkeypatch):
    """Handing back the device's bytes would drop the audio track silently,
    which is the failure this whole path exists to stop."""
    _register()

    async def fake_fetch(url, byte_range=None):
        return b"DEVICE-TS"

    async def fake_swap(payload):
        raise RuntimeError("ffmpeg died")

    monkeypatch.setattr(stream, "_fetch_bytes", fake_fetch)
    monkeypatch.setattr(stream, "swap_segment_audio", fake_swap)
    try:
        r = client.get(f"/api/vod/{SESSION}/00000.aac.ts")
    finally:
        _clear()
        stream.SWAP_CACHE.clear()

    assert r.status_code == 502
    assert "00000" in r.json()["detail"]
    assert r.content != b"DEVICE-TS"
```

- [ ] **Step 2: Run them and watch them fail**

Run: `.venv/bin/python -m pytest tests/test_vod_routes.py -k "swap" -q`
Expected: FAIL — `VodSession` takes no `swap_audio`, and the `.aac.ts` name is refused by `_SEGMENT_RE`.

- [ ] **Step 3: Name the swapped segment in the playlist**

In `backend/app/vod_index.py`, `VodIndex.playlist` takes the suffix its server will answer to:

```python
    def playlist(self, suffix: str = ".ts") -> str:
        """Our own playlist over the same media.

        `suffix` names the segment this session serves. An H.264 recording is
        served with its AC-3 swapped for AAC, under a different name, because
        the two are different bytes for the same instant and a cache that
        confused them would serve one for the other.
        ...
        """
```

and in the loop:

```python
            lines.append(f"{i:05d}{suffix}")
```

- [ ] **Step 4: Carry the choice on the session and answer the name**

In `backend/app/routes/stream.py`:

```python
_VOD_SEGMENT_RE = re.compile(r"^(\d{5})(\.aac)?\.ts$")

#: Swapped segments already made, newest last. Bounded: a segment is ~250KB,
#: so 64 of them is ~16MB - enough that a scrub back, a re-read, or a second
#: viewer pays nothing, and small enough to sit in memory. Never written to
#: disk: this route's promise is that the media stays on the device.
SWAP_CACHE: "OrderedDict[tuple[str, int], bytes]" = OrderedDict()
SWAP_CACHE_SIZE = 64

#: How many swaps may run at once. Each is ~0.08s of ffmpeg for a ~1s segment
#: (measured 2026-09-22), and hls.js fetches in bursts, so this bounds a seek
#: storm the way the device fetch is already bounded.
_swap_gate = asyncio.Semaphore(4)
```

`VodSession` gains the field:

```python
@dataclass
class VodSession:
    """An index over a recording, and where to re-read it if it is growing."""

    index: VodIndex
    #: The device's *variant* playlist, already resolved from its master.
    device_url: str
    #: True for an H.264 recording, whose AC-3 no browser but Safari decodes.
    #: Decided once, when the session opens, from the device's codec label.
    swap_audio: bool = False
    refreshed_at: float = field(default_factory=time.monotonic)
```

`vod_playlist` asks for the name it will answer to:

```python
    return Response(
        content=session.index.playlist(
            suffix=".aac.ts" if session.swap_audio else ".ts"),
```

and the swap itself:

```python
async def swap_segment_audio(payload: bytes) -> bytes:
    """One segment with its video copied and its AC-3 re-encoded to AAC.

    `-c:v copy` is the point: the H.264 is the device's own bytes, so there is
    no re-encode, no quality lost, and no deinterlace to do. `-copyts` keeps the
    segment's timestamps, which is what lets the published `#EXTINF` keep
    describing it.

    Measured 2026-09-22 on a real 1.089s segment: 0.07-0.08s, 248KB in and
    240KB out, `start_time` unchanged.
    """
    async with _swap_gate:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-v", "error", "-copyts",
            "-i", "pipe:0",
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "160k", "-ac", "2",
            "-f", "mpegts", "pipe:1",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, err = await proc.communicate(payload)
    if proc.returncode != 0 or not out:
        raise RuntimeError(err.decode(errors="replace").strip() or "ffmpeg failed")
    return out
```

`vod_segment` reads the name, and swaps when the name says so:

```python
@router.get("/vod/{session_id}/{name}")
async def vod_segment(session_id: str, name: str):
    """One segment, fetched from the device on demand and never stored.

    `{n}.aac.ts` is the same segment with its audio swapped - see `swap_segment_audio`.
    The two are different names because they are different bytes, and a cache
    keyed on the number alone would serve one where the other was asked for.
    """
    session = _vod_session(session_id)
    match = _VOD_SEGMENT_RE.match(name)
    if not match:
        raise HTTPException(status_code=400, detail="Bad segment name")
    number = int(match.group(1))
    swapped = match.group(2) is not None
    if number < 0 or number >= len(session.index.segments):
        raise HTTPException(status_code=404, detail="Segment not found")

    touch_session(session_id)

    if swapped:
        held = SWAP_CACHE.get((session_id, number))
        if held is not None:
            SWAP_CACHE.move_to_end((session_id, number))
            return _segment_response(held)

    segment = session.index.segments[number]
    try:
        payload = await _fetch_bytes(segment.url, segment.byte_range)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Device error: {e}")

    if swapped:
        try:
            payload = await swap_segment_audio(payload)
        except Exception as e:
            # Never the untouched segment: hls.js would play it happily and
            # silently drop the audio track, which is the failure this path
            # exists to stop.
            raise HTTPException(
                status_code=502,
                detail=f"Segment {number:05d} audio could not be converted: {e}",
            )
        SWAP_CACHE[(session_id, number)] = payload
        SWAP_CACHE.move_to_end((session_id, number))
        while len(SWAP_CACHE) > SWAP_CACHE_SIZE:
            SWAP_CACHE.popitem(last=False)

    return _segment_response(payload)


def _segment_response(payload: bytes) -> Response:
    return Response(
        content=payload,
        media_type="video/mp2t",
        headers={"Cache-Control": "max-age=30", "Access-Control-Allow-Origin": "*"},
    )
```

Add `from collections import OrderedDict` to the imports if it is not already there.

- [ ] **Step 5: Run them and watch them pass**

Run: `.venv/bin/python -m pytest tests/test_vod_routes.py -q`
Expected: all pass, including the pre-existing `test_a_bad_segment_name_is_refused`.

- [ ] **Step 6: Prove the swap against real bytes, once**

This is the only step that needs a real segment; it is a one-off check, not a test.

```bash
ffprobe -v error -show_entries stream=codec_name -of default=nw=1 /tmp/swapped.ts
```

Fetch a segment of an H.264 recording, pipe it through the same command
`swap_segment_audio` runs, and confirm `codec_name=h264` and `codec_name=aac`.

- [ ] **Step 7: Commit**

```bash
git add backend/app/vod_index.py backend/app/routes/stream.py backend/tests/test_vod_routes.py
git commit -m "feat(vod): serve an H.264 recording with audio the browser can decode"
```

---

### Task 3: The session knows which recording it is serving

**Files:**
- Modify: `backend/app/routes/recordings.py` (`watch_recording_vod`, ~line 908–993)
- Test: `backend/tests/test_recordings.py`

**Interfaces:**
- Consumes: `codec` from Task 1, `VodSession.swap_audio` from Task 2.
- Produces: `POST /api/recordings/{id}/watch-vod` returns `"codec": "mpeg2" | "h264" | None` alongside the existing fields, and sets `swap_audio` on the session it registers.

- [ ] **Step 1: Write the failing tests**

```python
def test_watching_an_h264_recording_swaps_its_audio(authed, monkeypatch):
    """The codec is read once, when the session opens, because it decides every
    segment name the playlist will publish."""
    from app.routes import recordings as rec
    from app.routes import stream as stream_routes

    async def snapshot(object_id):
        return {"object_id": object_id, "codec": "h264"}

    _stub_vod(monkeypatch, rec, snapshot)

    body = client.post("/api/recordings/94904/watch-vod").json()
    session = stream_routes.vod_sessions[body["session_id"]]

    assert body["codec"] == "h264"
    assert session.swap_audio is True


def test_watching_an_mpeg2_recording_serves_the_device_untouched(authed, monkeypatch):
    from app.routes import recordings as rec
    from app.routes import stream as stream_routes

    async def snapshot(object_id):
        return {"object_id": object_id, "codec": "mpeg2"}

    _stub_vod(monkeypatch, rec, snapshot)

    body = client.post("/api/recordings/86353/watch-vod").json()
    session = stream_routes.vod_sessions[body["session_id"]]

    assert body["codec"] == "mpeg2"
    assert session.swap_audio is False


def test_a_recording_whose_codec_cannot_be_read_is_served_untouched(authed, monkeypatch):
    """A device that will not answer must not turn every recording into a
    transcode. Unknown means the path 38 of 39 recordings need."""
    from app.routes import recordings as rec
    from app.routes import stream as stream_routes

    async def snapshot(object_id):
        raise RuntimeError("device down")

    _stub_vod(monkeypatch, rec, snapshot)

    body = client.post("/api/recordings/86353/watch-vod").json()

    assert body["codec"] is None
    assert stream_routes.vod_sessions[body["session_id"]].swap_audio is False
```

with this helper beside them:

```python
def _stub_vod(monkeypatch, rec, snapshot):
    """Everything `watch-vod` touches except the codec read under test."""
    from app.vod_index import VodIndex, VodSegment

    async def resolve(object_id):
        return f"/recordings/sports/events/{object_id}", 100

    async def session(path):
        return {"playlist_url": "http://dev/master.m3u8", "token": "t"}

    async def index(master):
        return VodIndex(segments=[VodSegment("http://dev/s.ts", None, 1.0)],
                        duration=1.0, finished=True), "http://dev/v.m3u8"

    monkeypatch.setattr(type(rec.state), "is_authenticated", property(lambda _s: True))
    monkeypatch.setattr(rec.state, "resolve_recording", resolve)
    monkeypatch.setattr(rec.state, "start_recording_session", session)
    monkeypatch.setattr(rec.state, "recording_snapshot", snapshot)
    monkeypatch.setattr(rec, "_fetch_vod_index", index)
    monkeypatch.setattr(rec.cache, "preview_available", lambda oid: True)
```

- [ ] **Step 2: Run them and watch them fail**

Run: `.venv/bin/python -m pytest tests/test_recordings.py -k watch_vod -q`
Expected: FAIL — no `codec` in the response body.

- [ ] **Step 3: Read the codec when the session opens**

In `watch_recording_vod`, after the index is fetched and before the session is
registered:

```python
    # Which decoder the player may use, decided here because it decides every
    # segment name the playlist publishes. One device read, once per session.
    #
    # Tolerant on purpose: a device that will not answer must not turn every
    # recording into something it is not. Unknown reads as MPEG-2, which is
    # what 38 of the 39 recordings on this device are.
    try:
        codec = (await state.recording_snapshot(object_id)).get("codec")
    except Exception:
        codec = None
```

register it:

```python
    stream_routes.vod_sessions[session_id] = stream_routes.VodSession(
        index=index, device_url=variant_url, swap_audio=codec == "h264",
    )
```

and return it:

```python
        "growing": not index.finished,
        "codec": codec,
        "mode": "vod",
```

Rewrite the docstring's opening line — "Serve a recording as MPEG-2, straight
from the device" is no longer true of every recording:

```
    """Serve a recording straight from the device, decoded in the browser.

    A recording is *usually* the MPEG-2 and AC-3 the live path decodes, and
    then this is a pure proxy: the index is held, the media stays where it is.
    A recording the device encoded itself is H.264, whose AC-3 no browser but
    Safari will decode - so that one is served with its audio swapped for AAC
    and its picture still untouched. `video_details.container_format` is how the
    device says which, and it is read once, here.
```

- [ ] **Step 4: Run them and watch them pass**

Run: `.venv/bin/python -m pytest tests/test_recordings.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/app/routes/recordings.py backend/tests/test_recordings.py
git commit -m "feat(vod): decide the segment names from the recording's codec"
```

---

### Task 4: The player refuses a decoder that cannot decode

**Files:**
- Modify: `frontend/src/api/tablo.ts` (`Recording`, `watchRecordingVod`)
- Modify: `frontend/src/lib/wasmlive/capability.ts` (`wasmLiveEligible`)
- Modify: `frontend/src/__tests__/decoderPolicySupport.tsx` (`REC` fixture)
- Test: `frontend/src/__tests__/wasmliveFallback.test.ts`

**Interfaces:**
- Consumes: `codec` on the recording projection (Task 1) and on the watch-vod response (Task 3).
- Produces: `Recording.codec: "mpeg2" | "h264" | null`; `wasmLiveEligible(win, storage, channelKind, codec?: string | null)`.

- [ ] **Step 1: Write the failing test**

In `frontend/src/__tests__/wasmliveFallback.test.ts`:

```ts
  it("refuses a recording the decoder was never built for", () => {
    // The vendored build is libav-…-tablo-mpeg2. Handing it H.264 produces
    // "Codec not found", which is not a fault to report — it is a question
    // that should have been asked here.
    expect(wasmLiveEligible(capableWindow(CHROME), flagOn, "ota", "h264")).toEqual({
      eligible: false,
      reason: "h264 recording",
    });
  });

  it("takes an MPEG-2 recording, and one whose codec the device did not say", () => {
    expect(wasmLiveEligible(capableWindow(CHROME), flagOn, "ota", "mpeg2").eligible)
      .toBe(true);
    expect(wasmLiveEligible(capableWindow(CHROME), flagOn, "ota", null).eligible)
      .toBe(true);
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/__tests__/wasmliveFallback.test.ts`
Expected: FAIL — eligible is true for `"h264"`, because the argument is ignored.

- [ ] **Step 3: Ask the question in the one place it is already asked**

In `frontend/src/lib/wasmlive/capability.ts`:

```ts
export function wasmLiveEligible(
  win: { navigator: { userAgent: string } },
  storage: Pick<Storage, "getItem">,
  channelKind: string | null | undefined,
  codec?: string | null,
): Eligibility {
```

and, directly after the `ott` check (it is the same statement about the same
thing — this decoder plays MPEG-2 and nothing else):

```ts
  // The vendored build is MPEG-2. A recording the device encoded itself is
  // H.264, and handing it here produces "Codec not found" after two rebuilds
  // and a dead player. The device says which, so this is answerable before
  // anything opens. Null means it did not say, which is MPEG-2's path.
  if (codec === "h264") return { eligible: false, reason: "h264 recording" };
```

In `frontend/src/api/tablo.ts`, on `Recording`, beside `scan`/`interlaced`:

```ts
  /**
   * The device's word for the video codec: "mpeg2", "h264", or null when it
   * said something nobody has seen.
   *
   * Almost always "mpeg2" — a broadcast, passed through. "h264" is a recording
   * the box encoded itself, which the WASM decoder cannot read and which the
   * browser can, and null takes MPEG-2's path because that is what all but one
   * recording measured has been.
   */
  codec: "mpeg2" | "h264" | null;
```

and on the `watchRecordingVod` response type:

```ts
      growing: boolean;
      codec: "mpeg2" | "h264" | null;
      mode: string;
```

In `frontend/src/__tests__/decoderPolicySupport.tsx`, the `REC` fixture gains
`codec: "mpeg2",` beside `interlaced`.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/__tests__/wasmliveFallback.test.ts && npm run build`
Expected: tests pass; the build typechecks (any other fixture missing `codec` fails here and gains it).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/tablo.ts frontend/src/lib/wasmlive/capability.ts frontend/src/__tests__
git commit -m "feat(player): the WASM decoder refuses a codec it does not have"
```

---

### Task 5: An H.264 recording opens on the device's own bytes

**Files:**
- Modify: `frontend/src/components/VideoPlayer.tsx` (recording branch, ~line 1100–1280)
- Test: `frontend/src/__tests__/decoderPolicy.test.tsx`

**Interfaces:**
- Consumes: `Recording.codec`, `wasmLiveEligible(..., codec)` (Task 4), the swapped playlist (Tasks 2–3).
- Produces: no new exports; the routing rule itself.

- [ ] **Step 1: Write the failing tests**

```ts
  it("plays an H.264 recording from the device, not from the encoder", async () => {
    // Measured 2026-09-22: hls.js plays the device's own H.264 segments and
    // seeks across them. Transcoding would decode H.264 to re-encode it as
    // worse H.264, for nothing.
    const vod = vi.spyOn(api, "watchRecordingVod").mockResolvedValue({
      object_id: REC.object_id, session_id: "v-9", stream_url: "/v9.m3u8",
      duration: REC.duration, segments: 10, growing: false,
      codec: "h264", mode: "vod",
    });
    const transcode = vi.spyOn(api, "watchRecording");

    renderPlayer({ recording: { ...REC, codec: "h264" } });

    await waitFor(() => expect(vod).toHaveBeenCalled());
    expect(wasm.open).not.toHaveBeenCalled();
    expect(transcode).not.toHaveBeenCalled();
    expect(loaded()).toContain("/v9.m3u8");
  });

  it("still gives an MPEG-2 recording to the WASM decoder", async () => {
    vi.spyOn(api, "watchRecordingVod").mockResolvedValue({
      object_id: REC.object_id, session_id: "v-1", stream_url: "/v.m3u8",
      duration: REC.duration, segments: 10, growing: false,
      codec: "mpeg2", mode: "vod",
    });

    renderPlayer({ recording: { ...REC, codec: "mpeg2" } });

    await waitFor(() => expect(wasm.open).toHaveBeenCalled());
  });
```

Match the file's existing render helper and `loaded()`/surface stub rather than
inventing new ones — `stubSurface` in `decoderPolicySupport` already records
which URL was loaded.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/__tests__/decoderPolicy.test.tsx`
Expected: FAIL — the H.264 recording calls `api.watchRecording` (the transcode).

- [ ] **Step 3: Route on the codec**

In `VideoPlayer.tsx`, the eligibility question for recordings (~line 1114):

```ts
          const eligibility = wasmLiveEligible(
            window, localStorage, "ota", current.recording.codec);
```

and the non-WASM branch below it, which today always opens the transcode. An
H.264 recording has a better answer:

```ts
          setUsingWasm(false);

          // H.264 needs no encoder at all: the browser decodes the picture the
          // device already wrote, and the backend swaps only the AC-3 the
          // browser cannot decode. Transcoding here would decode H.264 to
          // re-encode it as worse H.264.
          if (current.recording.codec === "h264") {
            const raw = await api.watchRecordingVod(current.recording.object_id);
            if (cancelled) {
              api.stopStream(raw.session_id).catch(() => {});
              return;
            }
            log.player(`open recording ${current.recording.object_id} as h264`, {
              session: raw.session_id, url: raw.stream_url,
              duration: fmt(raw.duration), segments: raw.segments,
            });
            setSessionId(raw.session_id);
            openSurface(raw.stream_url);
            if (!cancelled) setLoading(false);
            return;
          }

          const t0 = performance.now();
```

`openSurface` already loads through hls.js, and `startPosition` already reaches
it — which is why this path needs nothing for resume that the transcode did not
already have.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run src/__tests__/decoderPolicy.test.tsx`
Expected: all pass, including the file's existing "the transcode is not a rescue" tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/VideoPlayer.tsx frontend/src/__tests__/decoderPolicy.test.tsx
git commit -m "feat(player): an H.264 recording plays from the device's own bytes"
```

---

### Task 6: One correction when the label was not there

**Files:**
- Modify: `frontend/src/components/VideoPlayer.tsx` (recording `onFailure`, ~line 1145–1210)
- Test: `frontend/src/__tests__/decoderPolicy.test.tsx`

**Interfaces:**
- Consumes: `surface.diagnostics().failureDetail` (the worker's own message, set in `session.ts:547`).
- Produces: nothing exported.

- [ ] **Step 1: Write the failing test**

```ts
  it("corrects itself once when the decoder says it has no such codec", async () => {
    // A null codec takes the MPEG-2 path, so a format nobody has labelled yet
    // fails exactly as 94904 did. "Codec not found" is not a fault to report —
    // it is this routing being wrong, and the swap path is the same picture.
    const vod = vi.spyOn(api, "watchRecordingVod").mockResolvedValue({
      object_id: REC.object_id, session_id: "v-1", stream_url: "/v.m3u8",
      duration: REC.duration, segments: 10, growing: false,
      codec: null, mode: "vod",
    });

    renderPlayer({ recording: { ...REC, codec: null } });
    await waitFor(() => expect(wasm.open).toHaveBeenCalled());

    surface.diagnostics.mockReturnValue({ failureDetail: "Codec not found" });
    await act(async () => { failureOf(0)("decode error"); });

    await waitFor(() => expect(loaded()).toContain("/v.m3u8"));
    // Corrected, not rebuilt: the decoder is not asked a second time.
    expect(wasm.open).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Decoding stopped/)).toBeNull();
  });

  it("still gives up on a decode failure that is not about the codec", async () => {
    vi.spyOn(api, "watchRecordingVod").mockResolvedValue({
      object_id: REC.object_id, session_id: "v-1", stream_url: "/v.m3u8",
      duration: REC.duration, segments: 10, growing: false,
      codec: "mpeg2", mode: "vod",
    });

    renderPlayer({ recording: { ...REC, codec: "mpeg2" } });
    await waitFor(() => expect(wasm.open).toHaveBeenCalled());

    surface.diagnostics.mockReturnValue({ failureDetail: "damaged batch" });
    await act(async () => { failureOf(0)("decode error"); });

    // The existing rule: one rebuild, then the reason.
    await waitFor(() => expect(wasm.open).toHaveBeenCalledTimes(2));
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/__tests__/decoderPolicy.test.tsx -t "corrects itself"`
Expected: FAIL — the codec failure rebuilds the WASM session instead of correcting the route.

- [ ] **Step 3: Correct the route, once, on a codec failure only**

In the recording `onFailure`, before the `rebuilt` check:

```ts
                  // A codec the build does not have is not a fault to report:
                  // it is this routing being wrong about what the recording is,
                  // which happens when the device labelled it something new.
                  // Correct it rather than rebuilding a decoder that will say
                  // the same thing again. Not a rescue by a worse picture — the
                  // swap path copies the same frames the device wrote.
                  const detail = String(
                    surfaceRef.current?.diagnostics?.().failureDetail ?? "");
                  if (/codec not found/i.test(detail)) {
                    log.warn(`recording is not mpeg-2 after all (${detail})`
                      + " — playing the device's own stream", { at: fmt(at) });
                    surface.destroy();
                    if (surfaceRef.current === surface) surfaceRef.current = null;
                    setUsingWasm(false);
                    openSurface(raw.stream_url);
                    if (at > 0) surfaceRef.current?.seek(at);
                    return;
                  }
```

The same session and the same `stream_url` are reused: the backend decides the
segment names from its own read of the codec, so a session opened as MPEG-2
serves `.ts` names — which is correct, because a recording that reaches here is
one the device did not label. The audio may be missing in that case, and the
picture will play; that is strictly better than the dead player it replaces, and
the log says which happened.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run src/__tests__/decoderPolicy.test.tsx`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/VideoPlayer.tsx frontend/src/__tests__/decoderPolicy.test.tsx
git commit -m "feat(player): a missing codec corrects the route, not the decoder"
```

---

### Task 7: Verify, merge, deploy, push

**Files:** none changed.

- [ ] **Step 1: Whole backend suite and lint**

Run: `.venv/bin/python -m pytest -q && .venv/bin/python -m ruff check app tests`
Expected: all pass; ruff reports only the two pre-existing errors (`test_recordings.py` F811, `test_tmdb_enrich.py` I001).

- [ ] **Step 2: Whole frontend suite, lint and build**

Run: `npx vitest run && npx eslint src/api/tablo.ts src/lib/wasmlive/capability.ts src/components/VideoPlayer.tsx && npm run build`
Expected: all pass; eslint clean on the changed files.

- [ ] **Step 3: Merge**

```bash
git -C /Users/peet/GitHub/tablo-web merge --no-ff h264-play
```

- [ ] **Step 4: Deploy**

```bash
docker compose build frontend
docker compose up -d --force-recreate frontend
.claude/skills/tablo-stack/check-stack.sh
```

then restart the native backend and confirm `[state] restored 1 device(s)`.

- [ ] **Step 5: Verify against the real recording**

Open recording 94904 in Chrome. Expected: it plays, with sound, and the console
says `open recording 94904 as h264` — no `wasm decoder error`, no
`Decoding stopped`. Check an MPEG-2 recording in the same session still opens
`as mpeg-2`.

- [ ] **Step 6: Push**

```bash
git push origin main
```
