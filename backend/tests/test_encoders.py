"""Encoder profiles.

Hardware encoders differ in more than a codec name, and only libx264 can be
exercised here — the container has no VideoToolbox (macOS framework) and no
/dev/dri. These assert the command *shape* so a wrong pipeline is caught before
it reaches hardware.
"""

import pytest

from app.transcode_cache import deinterlace_filter, encoder_profile, video_encoder


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




# ---------------------------------------------------------------------------
# Deinterlacing
# ---------------------------------------------------------------------------

def test_deinterlace_defaults_to_field_doubling(monkeypatch):
    """1080i carries 59.94 fields/s; send_frame would throw half of them away."""
    monkeypatch.delenv("TRANSCODE_DEINTERLACE", raising=False)
    assert deinterlace_filter() == ["bwdif=mode=send_field:parity=auto:deint=interlaced"]


def test_deinterlace_only_touches_interlaced_frames(monkeypatch):
    """ABC and FOX broadcast 720p60; filtering those would double their rate."""
    monkeypatch.delenv("TRANSCODE_DEINTERLACE", raising=False)
    assert "deint=interlaced" in deinterlace_filter()[0]


def test_deinterlace_frame_mode_preserves_frame_rate(monkeypatch):
    monkeypatch.setenv("TRANSCODE_DEINTERLACE", "frame")
    assert deinterlace_filter() == ["bwdif=mode=send_frame:parity=auto:deint=interlaced"]


@pytest.mark.parametrize("value", ["off", "none", "0", ""])
def test_deinterlace_can_be_disabled(monkeypatch, value):
    monkeypatch.setenv("TRANSCODE_DEINTERLACE", value)
    assert deinterlace_filter() == []


def test_deinterlace_precedes_the_hardware_upload(monkeypatch):
    """VAAPI ends its chain in hwupload; frames must be progressive by then."""
    monkeypatch.delenv("TRANSCODE_DEINTERLACE", raising=False)
    monkeypatch.setenv("TRANSCODE_VIDEO_ENCODER", "h264_vaapi")
    chain = [*deinterlace_filter(), *encoder_profile().filters]
    assert chain.index("hwupload") > 0
    assert chain[0].startswith("bwdif")


# ---------------------------------------------------------------------------
# Anamorphic SD, which the hardware encoder will not carry
# ---------------------------------------------------------------------------

def test_the_picture_is_squared_before_it_is_encoded():
    """Broadcast SD is a 16:9 picture in a 4:3 grid, and VideoToolbox drops it.

    Measured: 704x480 with SAR 40:33 through libx264 keeps 40:33 and a 16:9
    display aspect, and through h264_videotoolbox comes out N/A - the encoder
    discards the VUI. A player then draws the coded 1.47 and everything in it
    is tall and thin, which is what Saturday Night Live looked like.

    A `setsar` filter cannot rescue that, because the encoder throws away what
    it would set. So the correction goes into the pixels instead, where no
    metadata is needed to survive.
    """
    from app.transcode_cache import square_pixels_filter
    assert square_pixels_filter() == ["scale=trunc(iw*sar/2)*2:ih", "setsar=1"]


def test_squaring_runs_after_the_deinterlace_and_before_the_upload(monkeypatch):
    """Order is load-bearing at both ends.

    Deinterlacing samples real rows, so it has to see the coded picture rather
    than a scaled one; VAAPI's chain ends in hwupload, and a software scale
    after that has nothing to work on.
    """
    from app.transcode_cache import square_pixels_filter
    monkeypatch.delenv("TRANSCODE_DEINTERLACE", raising=False)
    monkeypatch.setenv("TRANSCODE_VIDEO_ENCODER", "h264_vaapi")
    chain = [*deinterlace_filter(), *square_pixels_filter(), *encoder_profile().filters]

    assert chain[0].startswith("bwdif")
    assert chain.index("scale=trunc(iw*sar/2)*2:ih") > 0
    assert chain.index("scale=trunc(iw*sar/2)*2:ih") < chain.index("hwupload")


def test_a_square_pixel_source_is_left_alone():
    """`iw*sar` is the width itself when the pixels are already square, so HD
    passes through at its own size. Verified against the encoder: 1280x720 in,
    1280x720 out."""
    from app.transcode_cache import square_pixels_filter
    # Nothing here hardcodes a shape - the expression is evaluated per input.
    assert all("1280" not in f and "480" not in f for f in square_pixels_filter())


# ---------------------------------------------------------------------------
# Bits per pixel, which is what sharpness actually is
# ---------------------------------------------------------------------------

def test_a_tall_picture_is_brought_down_to_the_cap():
    """The device's own transcode looked sharper than ours while using *fewer*
    bits, because it covers far fewer pixels with them:

        Tablo   1280x720  29.97   1.98 Mbps   0.0718 bits/px
        ours    1920x1080 59.94   2.49 Mbps   0.0200 bits/px

    Both were High profile with B-frames by then, so the settings had already
    converged - the gap was the four and a half times pixel rate.
    """
    from app.transcode_cache import height_cap_filter
    assert height_cap_filter(720) == [r"scale=-2:min(ih\,720)"]
    # The comma belongs to `min()`, not to the filter list. Unescaped, FFmpeg
    # reads `720)` as a filter of its own and the whole graph fails to parse.
    assert r"\," in height_cap_filter(720)[0]


def test_the_cap_can_be_turned_off():
    from app.transcode_cache import height_cap_filter
    assert height_cap_filter(-1) == []


def test_the_cap_runs_after_the_squaring(monkeypatch):
    """Anamorphic SD has to reach its real shape before anything measures its
    height, and the hardware upload has to come last of all."""
    from app.transcode_cache import height_cap_filter, square_pixels_filter
    monkeypatch.delenv("TRANSCODE_DEINTERLACE", raising=False)
    monkeypatch.setenv("TRANSCODE_VIDEO_ENCODER", "h264_vaapi")
    chain = [*deinterlace_filter(), *square_pixels_filter(),
             *height_cap_filter(720), *encoder_profile().filters]

    assert chain.index("setsar=1") < chain.index(r"scale=-2:min(ih\,720)")
    assert chain.index(r"scale=-2:min(ih\,720)") < chain.index("hwupload")


def test_the_hardware_encoder_asks_for_the_devices_sharpness(monkeypatch):
    """`-q:v 55` is 0.0756 bits/px on 720p60, against the device's 0.0718.
    At the 40 we shipped it was 0.0246, which is the softness that started
    this. Swept on 30s of real 720p60 with the rest of the profile in place."""
    monkeypatch.delenv("TRANSCODE_QUALITY", raising=False)
    monkeypatch.setenv("TRANSCODE_VIDEO_ENCODER", "h264_videotoolbox")
    flags = encoder_profile().flags

    assert flags[flags.index("-q:v") + 1] == "55"


def test_quality_stays_overridable(monkeypatch):
    """Three times the bitrate is a real cost, and someone may want the disk."""
    monkeypatch.setenv("TRANSCODE_QUALITY", "45")
    monkeypatch.setenv("TRANSCODE_VIDEO_ENCODER", "h264_videotoolbox")
    flags = encoder_profile().flags

    assert flags[flags.index("-q:v") + 1] == "45"
