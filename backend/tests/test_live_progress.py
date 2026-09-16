"""How far a live transcode has got.

The player waits on the encoder when a live channel opens, and the only honest
number to show while it waits is how much video FFmpeg has produced. FFmpeg
reports that as a `time=` field on its stats line, rewritten in place with a
carriage return rather than a newline — so the parser has to read the tail of a
line, not a line.
"""

from app.routes.stream import encoded_seconds


def test_no_stats_line_yet_means_no_number():
    assert encoded_seconds("Starting FFmpeg\nInput: http://tablo/x\n") is None


def test_the_latest_stats_line_wins():
    log = (
        "frame=  120 fps= 60 q=28.0 size=N/A time=00:00:04.00 bitrate=N/A\r"
        "frame=  240 fps= 60 q=28.0 size=N/A time=00:00:08.50 bitrate=N/A\r"
    )
    assert encoded_seconds(log) == 8.5


def test_hours_and_minutes_count():
    assert encoded_seconds("time=01:02:03.25 bitrate=N/A") == 3723.25


def test_a_negative_start_time_is_ignored():
    """FFmpeg prints time=-577014:32:22.77 before the first frame lands."""
    assert encoded_seconds("time=-577014:32:22.77 bitrate=N/A") is None
