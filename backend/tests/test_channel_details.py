"""What the device knows about a channel that the cloud does not.

The cloud guide's channel record is six fields: identifier, kind, logos, name
and an `ota`/`ott` block with the number and network. It has no resolution, no
scan type and no favourite flag — verified against the live account, where the
union of every key across all 28 channels was exactly that.

The device has all three, per channel, at `/guide/channels/{id}`:

    {"channel": {"call_sign": "KSPS-HD", "major": 7, "minor": 1,
                 "resolution": "hd_1080",
                 "flags": ["mpeg2", "interlaced", "canRecord"],
                 "favourite": false, ...}}

So the channel list is enriched from the device in one pass, and the guide
carries what it found.
"""

import pytest

from app.state import AppState, _scan_label


class TestScanLabel:
    """`resolution` + `flags` as the string a viewer would recognise."""

    def test_interlaced_hd(self):
        assert _scan_label("hd_1080", ["mpeg2", "interlaced", "canRecord"]) == "1080i"

    def test_progressive_hd(self):
        # Measured: every hd_720 channel on the account lacks the interlaced
        # flag, which is what 720p means.
        assert _scan_label("hd_720", ["mpeg2", "canRecord"]) == "720p"

    def test_standard_definition_is_spelled_out(self):
        # `sd` carries no height of its own. OTA standard definition is 480
        # lines, so deriving the number from the string would give "sdi".
        assert _scan_label("sd", ["mpeg2", "interlaced", "canRecord"]) == "480i"

    def test_unknown_resolution_says_nothing(self):
        assert _scan_label("uhd_4320", ["interlaced"]) is None
        assert _scan_label(None, []) is None
        assert _scan_label("", []) is None


@pytest.mark.asyncio
class TestChannelDetails:
    async def test_keys_the_device_record_by_cloud_identifier(self, monkeypatch):
        """`channel_identifier` is the join: it is what the cloud calls
        `identifier`, and nothing else in the device record is."""
        state = AppState()

        async def fake_request(method, path, body=""):
            if path == "/guide/channels":
                return ["/guide/channels/5802", "/guide/channels/5803"]
            rec = {
                "/guide/channels/5802": {
                    "call_sign": "KSPS-HD", "major": 7, "minor": 1,
                    "resolution": "hd_1080", "flags": ["mpeg2", "interlaced"],
                    "favourite": True, "channel_identifier": "S79600_007_01",
                },
                "/guide/channels/5803": {
                    "call_sign": "MTN", "major": 8, "minor": 2,
                    "resolution": "hd_720", "flags": ["mpeg2"],
                    "favourite": False, "channel_identifier": "S84522_008_02",
                },
            }[path]
            return {"channel": rec}

        monkeypatch.setattr(state, "request_device", fake_request)
        monkeypatch.setattr(state, "active_device", object())

        found = await state.channel_details()

        assert found["S79600_007_01"]["scan"] == "1080i"
        assert found["S79600_007_01"]["favourite"] is True
        assert found["S79600_007_01"]["interlaced"] is True
        assert found["S84522_008_02"]["scan"] == "720p"
        assert found["S84522_008_02"]["favourite"] is False
        assert found["S84522_008_02"]["interlaced"] is False

    async def test_asks_once_and_remembers(self, monkeypatch):
        """23 signed requests is not something to repeat per guide refresh —
        a channel's scan type and favourite flag change when the lineup does,
        which is the same moment the channel list itself is dropped."""
        state = AppState()
        calls = []

        async def fake_request(method, path, body=""):
            calls.append(path)
            if path == "/guide/channels":
                return ["/guide/channels/1"]
            return {"channel": {"channel_identifier": "S1", "resolution": "sd",
                                "flags": ["interlaced"], "favourite": False}}

        monkeypatch.setattr(state, "request_device", fake_request)
        monkeypatch.setattr(state, "active_device", object())

        await state.channel_details()
        await state.channel_details()

        assert calls.count("/guide/channels") == 1

    async def test_a_device_that_will_not_answer_costs_the_guide_nothing(self, monkeypatch):
        """The scan pill and the favourite are worth having and worth nothing
        next to the guide itself, so a device that refuses leaves them empty
        rather than failing the request everyone is waiting on."""
        state = AppState()

        async def boom(method, path, body=""):
            raise RuntimeError("device said no")

        monkeypatch.setattr(state, "request_device", boom)
        monkeypatch.setattr(state, "active_device", object())

        assert await state.channel_details() == {}
