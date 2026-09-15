"""Encoder profiles.

Hardware encoders differ in more than a codec name, and only libx264 can be
exercised here — the container has no VideoToolbox (macOS framework) and no
/dev/dri. These assert the command *shape* so a wrong pipeline is caught before
it reaches hardware.
"""

import pytest  # noqa: F401


from app.transcode_cache import encoder_profile, video_encoder


def _profile(monkeypatch, encoder, quality=None):
    monkeypatch.setenv("TRANSCODE_VIDEO_ENCODER", encoder)
    if quality:
        monkeypatch.setenv("TRANSCODE_QUALITY", quality)
    else:
        monkeypatch.delenv("TRANSCODE_QUALITY", raising=False)
    return None, encoder_profile()


def test_x264_is_the_default(monkeypatch):
    monkeypatch.delenv("TRANSCODE_VIDEO_ENCODER", raising=False)
    assert video_encoder() == "libx264"
    assert encoder_profile().name == "libx264"


def test_x264_carries_its_own_rate_control(monkeypatch):
    """-maxrate/-bufsize belong to x264 and must not leak to other encoders."""
    _, prof = _profile(monkeypatch, "libx264")
    assert "-maxrate" in prof.flags and "-crf" in prof.flags
    assert prof.pix_fmt == "yuv420p"
    assert prof.pre_input == [] and prof.filters == []


def test_videotoolbox_uses_qv_not_crf(monkeypatch):
    """VideoToolbox has no CRF; passing one is ignored at best."""
    _, prof = _profile(monkeypatch, "h264_videotoolbox")
    assert "-crf" not in prof.flags
    assert "-q:v" in prof.flags
    # Must be allowed to outrun wall clock, or a 3.5h recording takes 3.5h.
    assert prof.flags[prof.flags.index("-realtime") + 1] == "0"
    assert "-maxrate" not in prof.flags


def test_vaapi_opens_the_device_and_uploads_frames(monkeypatch):
    """VAAPI needs the device before -i and frames uploaded by a filter."""
    monkeypatch.setenv("VAAPI_DEVICE", "/dev/dri/renderD128")
    _, prof = _profile(monkeypatch, "h264_vaapi")
    assert prof.pre_input == ["-vaapi_device", "/dev/dri/renderD128"]
    assert prof.filters == ["format=nv12", "hwupload"]
    # It takes hardware frames, so a software pixel format would be rejected.
    assert prof.pix_fmt is None


def test_nvenc_takes_software_frames_directly(monkeypatch):
    _, prof = _profile(monkeypatch, "h264_nvenc")
    assert prof.filters == []
    assert prof.pix_fmt == "yuv420p"
    assert "-cq" in prof.flags


def test_quality_override_applies_per_encoder(monkeypatch):
    _, x264 = _profile(monkeypatch, "libx264", quality="18")
    assert x264.flags[x264.flags.index("-crf") + 1] == "18"
    _, vt = _profile(monkeypatch, "h264_videotoolbox", quality="70")
    assert vt.flags[vt.flags.index("-q:v") + 1] == "70"


def test_unknown_encoder_falls_back_without_crashing(monkeypatch):
    _, prof = _profile(monkeypatch, "h264_someday")
    assert prof.flags and prof.pix_fmt == "yuv420p"


