# H.264 Offline Copy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keeping an H.264 recording offline copies its picture and converts only its audio, and the Download button on that copy produces a file that plays start to finish with sound.

**Architecture:** `CacheMeta` learns the source codec at registration. The window job branches on it: `h264` copies video and encodes audio, anything else runs today's encoder untouched. Because copying cannot force keyframes, the window's output is counted against the published playlist and re-done with the encoder if it does not match.

**Tech Stack:** FastAPI, ffmpeg, pytest.

**Spec:** `docs/superpowers/specs/2026-09-22-h264-offline-copy-design.md`

## Global Constraints

- Codec values are `"mpeg2" | "h264" | None`, mapped in `state.py:_VIDEO_CODECS`. `None` encodes.
- The copy command keeps `-c:a aac -b:a 160k -ac 2` and drops `-vf`, the video encoder flags, and `-force_key_frames`.
- The window's file names and count stay exactly what `build_playlist` publishes. That is the invariant the whole feature has to preserve.
- Never test against recording 94904 destructively, and never against the device. It is the only H.264 recording in existence here — the box produced it recovering from a mid-game restart and cannot be made to do it again.
- Backend tests: `/Users/peet/GitHub/tablo-web/backend/.venv/bin/python -m pytest` from `backend/`.

---

### Task 1: The cache remembers what it is copying

**Files:**
- Modify: `backend/app/transcode_cache.py` (`CacheMeta`, `register`)
- Modify: `backend/app/routes/recordings.py` (`keep` route, ~line 1356)
- Test: `backend/tests/test_recordings.py`

**Interfaces:**
- Produces: `CacheMeta.source_codec: str | None`; `register(object_id, path, source_duration, codec=None)`.

- [ ] **Step 1: Write the failing tests**

```python
def test_registering_remembers_the_source_codec(tmp_path):
    """The window job cannot ask the device what it is copying — the only
    moment anyone holds the recording's projection is registration."""
    c = _cache(tmp_path)
    asyncio.run(c.register(94904, "/recordings/sports/events/94904", GAME, codec="h264"))

    assert c.read_meta(94904).source_codec == "h264"


def test_re_registering_updates_the_codec_without_clearing_the_pin(tmp_path):
    """Re-registration is how a kept copy is resumed, and it has silently
    cleared `pinned` before now — two offline copies were evicted that way."""
    c = _cache(tmp_path)
    asyncio.run(c.register(94904, "/recordings/sports/events/94904", GAME))
    c.set_pinned(94904, True)

    asyncio.run(c.register(94904, "/recordings/sports/events/94904", GAME, codec="h264"))

    meta = c.read_meta(94904)
    assert meta.source_codec == "h264"
    assert meta.pinned is True
```

- [ ] **Step 2: Run them and watch them fail**

Run: `.venv/bin/python -m pytest tests/test_recordings.py -k source_codec -q`
Expected: FAIL — `register() got an unexpected keyword argument 'codec'`.

- [ ] **Step 3: Carry the codec**

On `CacheMeta`, beside `source_duration`:

```python
    #: What the device said this recording's video is: "h264" for one the box
    #: encoded itself, "mpeg2" for a broadcast passed through, None where it
    #: said something nobody has seen. An H.264 source is copied rather than
    #: re-encoded; everything else takes the encoder.
    source_codec: str | None = None
```

In `register`, take `codec: str | None = None`, set it on the new meta, and
update it in place beside `source_duration`/`path` — keeping the comment there
about not replacing the record wholesale:

```python
            elif (meta.source_duration != source_duration or meta.path != path
                  or (codec is not None and meta.source_codec != codec)):
                meta.source_duration = source_duration
                meta.path = path
                if codec is not None:
                    meta.source_codec = codec
                self.write_meta(meta)
```

In `recordings.py`'s keep route, where `info` is already in hand:

```python
        await cache.register(object_id, path, duration, codec=info.get("codec"))
```

- [ ] **Step 4: Run them and watch them pass**

Run: `.venv/bin/python -m pytest tests/test_recordings.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/app/transcode_cache.py backend/app/routes/recordings.py backend/tests/test_recordings.py
git commit -m "feat(cache): remember what the offline copy is made of"
```

---

### Task 2: A window that copies instead of re-encoding

**Files:**
- Modify: `backend/app/transcode_cache.py` (`_encode_window`, ~line 1470–1560)
- Test: `backend/tests/test_recordings.py`

**Interfaces:**
- Consumes: `CacheMeta.source_codec` (Task 1).
- Produces: no new names; the command the window runs changes shape for an H.264 source.

- [ ] **Step 1: Write the failing tests**

Modelled on `test_ensure_window_encodes_the_right_offset`, which already stubs
`asyncio.create_subprocess_exec` and writes the segments FFmpeg would have.

```python
def test_an_h264_window_copies_the_picture(tmp_path, monkeypatch):
    """The box already encoded this. Decoding it to re-encode it spends a core
    per window and loses a generation to arrive at what we started with."""
    cmd = _run_one_window(tmp_path, monkeypatch, codec="h264")

    assert cmd[cmd.index("-c:v") + 1] == "copy"
    # Nothing is being decoded, so there is nothing to filter — and this source
    # is progressive 720p with square pixels already.
    assert "-vf" not in cmd
    # FFmpeg cannot place keyframes in a stream it is copying.
    assert "-force_key_frames" not in cmd
    # The audio still has to change: no browser but Safari decodes AC-3.
    assert cmd[cmd.index("-c:a") + 1] == "aac"


def test_an_mpeg2_window_still_encodes(tmp_path, monkeypatch):
    cmd = _run_one_window(tmp_path, monkeypatch, codec="mpeg2")

    assert cmd[cmd.index("-c:v") + 1] != "copy"
    assert "-force_key_frames" in cmd


def test_a_window_with_no_codec_still_encodes(tmp_path, monkeypatch):
    """Unknown takes the path all but one recording needs."""
    cmd = _run_one_window(tmp_path, monkeypatch, codec=None)

    assert cmd[cmd.index("-c:v") + 1] != "copy"
```

with this helper beside them:

```python
def _run_one_window(tmp_path, monkeypatch, codec, segments=None):
    """Run window 7 with FFmpeg stubbed, and return the argv it was given."""
    calls = {}

    async def fake_session(path):
        return {"playlist_url": "http://device/stream/pl.m3u8?tok"}

    c = TranscodeCache(session_starter=fake_session, root=tmp_path, budget_bytes=10**12)
    asyncio.run(c.register(80888, "/recordings/x/80888", GAME, codec=codec))

    real_exec = asyncio.create_subprocess_exec
    n_segments = segments if segments is not None else segments_in_window(GAME, 7)

    async def fake_exec(*cmd, cwd=None, **kw):
        calls.setdefault("cmds", []).append(list(cmd))
        from pathlib import Path as P
        for f in P(cwd).glob("seg_*.ts"):
            f.unlink()
        for n in range(n_segments):
            (P(cwd) / f"seg_{n:02d}.ts").write_bytes(b"x")

        class P0:
            returncode = 0
            async def wait(self): return 0
        return P0()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    try:
        asyncio.run(c.ensure_window(80888, 7, "/recordings/x/80888", GAME))
    finally:
        monkeypatch.setattr(asyncio, "create_subprocess_exec", real_exec)
    calls["cache"] = c
    return calls["cmds"][0] if len(calls["cmds"]) == 1 else calls["cmds"]
```

- [ ] **Step 2: Run them and watch them fail**

Run: `.venv/bin/python -m pytest tests/test_recordings.py -k "h264_window or still_encodes" -q`
Expected: FAIL — every window is an encode, so `-c:v copy` is absent.

- [ ] **Step 3: Branch the command**

In `_encode_window`, where `prof = encoder_profile()` and the filters are built:

```python
        # A recording the box encoded itself is already H.264: the offline copy
        # is trying to produce exactly what the device is serving, so copy it.
        # Only the audio has to change - AC-3 is what no browser but Safari
        # decodes, and what `build_mp4` cannot put in an MP4.
        meta = self.read_meta(object_id)
        copying = (meta.source_codec if meta else None) == "h264"

        prof = encoder_profile()
        filters = [] if copying else [
            *deinterlace_filter(), *square_pixels_filter(), *prof.filters]
        video_flags = ["-c:v", "copy"] if copying else ["-c:v", prof.name, *prof.flags]
```

and in the command, replace the `-force_key_frames`, `-vf` and `-c:v` section:

```python
            *([] if copying else [
                # Pins keyframes to exact segment boundaries so the window's
                # segment count matches what the published playlist declared.
                "-force_key_frames", f"expr:gte(t,n_forced*{SEGMENT_SECONDS})"]),
            *(["-vf", ",".join(filters)] if filters else []),
            *video_flags,
            *([] if copying or not prof.pix_fmt else ["-pix_fmt", prof.pix_fmt]),
            "-c:a", "aac", "-b:a", "160k", "-ac", "2",
```

- [ ] **Step 4: Run them and watch them pass**

Run: `.venv/bin/python -m pytest tests/test_recordings.py -q`
Expected: all pass, including the existing `test_ensure_window_encodes_the_right_offset`.

- [ ] **Step 5: Commit**

```bash
git add backend/app/transcode_cache.py backend/tests/test_recordings.py
git commit -m "feat(cache): copy the picture when the device already encoded it"
```

---

### Task 3: The window ends up the shape the playlist promised

**Files:**
- Modify: `backend/app/transcode_cache.py` (`_encode_window`, after the FFmpeg run)
- Test: `backend/tests/test_recordings.py`

**Interfaces:**
- Consumes: the copy branch (Task 2), `segments_in_window`.
- Produces: no new names.

- [ ] **Step 1: Write the failing test**

```python
def test_a_copied_window_that_comes_out_the_wrong_shape_is_re_encoded(
        tmp_path, monkeypatch):
    """`build_playlist` publishes the segment names before anything is made, so
    the files have to be the files it named: one fewer leaves the playlist
    pointing at a 404, one more hides that content from playback. Copying
    cannot force keyframes, so the shape is checked rather than assumed."""
    expected = segments_in_window(GAME, 7)
    cmds = _run_one_window(tmp_path, monkeypatch, codec="h264",
                           segments=expected - 1)

    # Two runs: the copy that came out short, then the encoder.
    assert len(cmds) == 2
    assert cmds[0][cmds[0].index("-c:v") + 1] == "copy"
    assert cmds[1][cmds[1].index("-c:v") + 1] != "copy"
    assert "-force_key_frames" in cmds[1]
```

Note `_run_one_window` returns the list of argvs when FFmpeg ran more than once;
the stub writes `segments` files each time, so the retry writes the same short
count and the window is marked done from the encoder's output regardless — the
test is about which commands ran, not about the stub's fidelity.

- [ ] **Step 2: Run it and watch it fail**

Run: `.venv/bin/python -m pytest tests/test_recordings.py -k wrong_shape -q`
Expected: FAIL — only one command ran.

- [ ] **Step 3: Check the output, and fall back once**

After the FFmpeg run completes and before the window is marked done, in
`_encode_window`:

```python
        if copying:
            made = len(list(wd.glob("seg_*.ts")))
            want = segments_in_window(duration, w)
            if made != want:
                # The playlist named `want` files and copying produced another
                # number, because the source's keyframes did not land where the
                # window boundaries are. Nothing downstream can absorb that, so
                # this window goes back through the encoder, which can put the
                # keyframes exactly where they are needed.
                print(f"[cache] {object_id} w{w} copy came out {made} segments, "
                      f"expected {want} — re-encoding", flush=True)
                for f in wd.glob("seg_*.ts"):
                    f.unlink()
                (wd / "index.m3u8").unlink(missing_ok=True)
                await self._run_window_ffmpeg(object_id, w, wd, playlist_url,
                                              start, length, seek_to, preroll,
                                              copying=False)
```

This requires the FFmpeg invocation to be callable twice, so lift the command
build and run out of `_encode_window` into:

```python
    async def _run_window_ffmpeg(self, object_id, w, wd, playlist_url,
                                 start, length, seek_to, preroll, copying):
        """Build and run one window's FFmpeg, copying or encoding."""
```

keeping every existing flag and comment; `_encode_window` calls it once with
`copying=copying` and, on a shape mismatch, once more with `copying=False`.

- [ ] **Step 4: Run it and watch it pass**

Run: `.venv/bin/python -m pytest tests/test_recordings.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/app/transcode_cache.py backend/tests/test_recordings.py
git commit -m "feat(cache): a copied window is checked against the playlist that named it"
```

---

### Task 4: Prove the Download button on a copied recording

**Files:** none changed unless this finds something.

This is the acceptance test, and it is the point of the feature for the person
who asked. It runs against the real recording, read-only as far as the device is
concerned — nothing here deletes or rewrites 94904 on the Tablo.

- [ ] **Step 1: Deploy the branch**

Merge, rebuild the frontend if it changed (it did not), restart the native
backend, and confirm `check-stack.sh` is green.

- [ ] **Step 2: Keep it offline**

```bash
curl -s -X POST http://127.0.0.1:7070/api/recordings/94904/keep | head -c 200
```

Then poll until complete:

```bash
curl -s http://127.0.0.1:7070/api/recordings/94904 \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['cache_state'], d['cache_progress'])"
```

Expected: `complete 1.0`, and the backend log shows no `re-encoding` lines —
i.e. every window came out the shape the playlist named.

- [ ] **Step 3: Check what landed on disk**

```bash
ffprobe -v error -show_entries stream=codec_name,width,height \
  -of default=nw=1 "$HOME/Library/Application Support/tablo-web/cache/recordings/94904/w00000/seg_00.ts"
```

Expected: `h264`, `1280`, `720`, and `aac` — the device's picture, our audio.
Compare the window's bytes-per-second against the device's 2.3 Mbit/s: a copy
should land within a few percent, where a re-encode would not.

- [ ] **Step 4: Press the button**

```bash
curl -s -o /tmp/94904.mp4 -w '%{http_code} %{size_download}\n' \
  http://127.0.0.1:7070/api/recordings/94904/download
ffprobe -v error -show_entries format=duration,start_time \
  -show_entries stream=codec_name -of default=nw=1 /tmp/94904.mp4
```

Expected: 200; `start_time=0`; `duration` within a second of 8472; `h264` and
`aac`. Then open it and confirm it plays with sound — the route returning 200 is
not the claim being tested.

- [ ] **Step 5: Confirm it plays from the copy, not the device**

In the app, with the copy complete, opening 94904 should play it locally. Check
the console says the local copy is in use rather than a device session.

- [ ] **Step 6: Tidy**

Leave the offline copy in place if it is wanted; otherwise remove it through the
UI's own control, never by deleting cache directories by hand.
