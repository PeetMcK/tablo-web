"""Global in-process state — auth, active device, live stream sessions."""

import asyncio
import html
import json
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Lock

import httpx
from tablo_api import TabloAuth, TabloClient
from tablo_api.models import TabloChannel, TabloDevice, TabloStream

from . import store

# Default suits the container, where /data is a volume. Running the backend
# natively on macOS - the only way to reach VideoToolbox - needs it elsewhere.
CONFIG_PATH = Path(os.environ.get("TABLO_CONFIG_PATH", "/data/config.json"))

# Matches guide_sync's own concurrency: this runs on the same background loop
# and shares the device with playback, which saturates around 10x realtime.
SERIES_SYNC_CONCURRENCY = int(os.environ.get("TABLO_SERIES_SYNC_CONCURRENCY", "8"))

# How far the cloud guide is walked, one request per day.
#
# Fourteen because that is where the data stops: the device publishes its own
# horizon at /server/guide/status.limit, and the cloud grid returns partial
# data one day past it and nothing two days past. Asking for more is free but
# pointless. See docs/tablo-api.md.
CLOUD_GUIDE_DAYS = int(os.environ.get("TABLO_CLOUD_GUIDE_DAYS", "14"))

# These are someone else's servers, not the Tablo, so the reasoning that keeps
# the device sync slow does not apply - but fourteen requests need no fan-out
# either, and a burst is a poor way to greet a rate limiter.
CLOUD_GUIDE_CONCURRENCY = int(os.environ.get("TABLO_CLOUD_GUIDE_CONCURRENCY", "4"))


def _unescape(text: str | None) -> str | None:
    """Undo the cloud's HTML escaping. The device sends none.

    The cloud sends `Follow what&#x27;s happening`, and React escapes again on
    render, so anything left encoded is displayed literally - the sheet showed
    `what&#x27;s`. Decoding on the way in keeps the mirror holding text rather
    than markup, which also means search indexes the word someone would type.

    Safe against double-decoding: `html.unescape` on already-plain text is a
    no-op, and the device's text has no entities to begin with.
    """
    return html.unescape(text) if isinstance(text, str) else text

_lock = Lock()


class StreamSession:
    """Tracks a live HLS stream for one viewer."""

    def __init__(self, stream: TabloStream, base_url: str) -> None:
        self.stream = stream
        # base URL of the Tablo device (e.g. http://10.0.0.5:8885)
        self.base_url = base_url


class AppState:
    def __init__(self) -> None:
        self.auth: TabloAuth | None = None
        self.email: str | None = None
        self.devices: list[TabloDevice] = []
        self.active_device: TabloDevice | None = None
        self._channels: list[TabloChannel] | None = None
        self.streams: dict[str, StreamSession] = {}  # session_id → session
        self._http = httpx.AsyncClient(timeout=30)
        # Grid enrichment cache — avoids re-fetching 800 airing details on every guide load
        self._grid_cache: tuple | None = None
        self._grid_cache_time: float = 0.0
        self._grid_cache_lock = asyncio.Lock()
        # object_id → device path. The client holds only the id, but every device
        # call needs the category-scoped path, which the id does not encode.
        self._recording_paths: dict[int, str] = {}
        self.recordings_total: int = 0

    # Schedules are stable for hours and the device fetch is hundreds of airing
    # records, so 10 minutes was re-asking far more often than the data changed.
    # The client keeps its own copy for instant display; this only governs how
    # often the device is re-consulted.
    _GRID_CACHE_TTL = int(os.environ.get("GUIDE_CACHE_TTL", "3600"))

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def load_config(self) -> None:
        """Restore the account from the database.

        Imports the pre-database ``config.json`` first if the table is still
        empty, so an existing install keeps working without a re-login. That
        file stored the password in cleartext at mode 0644; the database stores
        it encrypted (see ``crypto``) and is created 0600.
        """
        try:
            store.migrate_config(CONFIG_PATH)
            creds = store.load_credentials()
            if creds:
                email, password = creds
                self.auth = TabloAuth(email, password)
                self.email = email
                self._restore_devices()
        except Exception as e:
            print(f"[state] could not load credentials: {e}", flush=True)

    def _restore_devices(self) -> None:
        """Rebuild device objects from storage, avoiding a cloud round trip.

        Discovery is what needs the password; the tokens it produced are enough
        for every subsequent call, so a restart does not re-authenticate.
        """
        rows, active_sid = store.load_devices()
        if not rows:
            return
        self.devices = [
            TabloDevice(
                sid=r["sid"],
                name=r["name"],
                local_url=r["local_url"],
                lighthouse_token=r["lighthouse_token"],
                account_token=r["account_token"],
                client_id=r["client_id"],
            )
            for r in rows
        ]
        self.active_device = next(
            (d for d in self.devices if d.sid == active_sid),
            self.devices[0] if len(self.devices) == 1 else None,
        )
        print(f"[state] restored {len(self.devices)} device(s) from stored tokens "
              f"- no cloud login needed", flush=True)

    def save_config(self, email: str, password: str) -> None:
        store.save_credentials(email, password)

    def clear_config(self) -> None:
        store.clear_credentials()
        self.auth = None
        self.email = None
        self.devices = []
        self.active_device = None
        self._channels = None
        self.streams.clear()

    # ------------------------------------------------------------------
    # Auth / discovery
    # ------------------------------------------------------------------

    async def login(self, email: str, password: str) -> list[TabloDevice]:
        auth = TabloAuth(email, password)
        devices = await _run_sync(auth.discover)
        self.auth = auth
        self.email = email
        self.devices = devices
        self.active_device = devices[0] if len(devices) == 1 else None
        self._channels = None
        self.save_config(email, password)
        # Persist the tokens discovery just produced. They, not the password,
        # are what every later request uses - so a restart can skip the cloud.
        store.save_devices(devices, self.active_device.sid if self.active_device else None)
        return devices

    async def select_device(self, sid: str) -> TabloDevice:
        dev = next((d for d in self.devices if d.sid == sid), None)
        if dev is None:
            raise ValueError(f"Device {sid} not found")
        self.active_device = dev
        self._channels = None
        store.set_active_device(sid)
        return dev

    # ------------------------------------------------------------------
    # Channels
    # ------------------------------------------------------------------

    async def channels(self, refresh: bool = False, include_ott: bool = True) -> list[TabloChannel]:
        """Get channels from Tablo (OTA + OTT)."""
        if self.active_device is None:
            raise RuntimeError("No active device")

        if self._channels is None or refresh:
            client = TabloClient(self.active_device)

            # Ultra-safe wrapper
            def fetch_channels():
                try:
                    return client.channels(include_ott=include_ott)
                except Exception as e:
                    print(f"Error calling client.channels: {e}")
                    raise

            self._channels = await _run_sync(fetch_channels)

        return self._channels


    # ------------------------------------------------------------------
    # Streaming
    # ------------------------------------------------------------------

    async def start_stream(self, identifier: str) -> tuple[str, StreamSession]:
        if self.active_device is None:
            raise RuntimeError("No active device")
        client = TabloClient(self.active_device)
        stream = await _run_sync(client.watch, identifier)
        session_id = uuid.uuid4().hex

        # Deriving base_url from the playlist_url ensures we use the correct port
        # for segments and nested playlists (e.g. port 80 vs 8887).
        from urllib.parse import urlparse
        parsed = urlparse(stream.playlist_url)
        base_url = f"{parsed.scheme}://{parsed.netloc}"

        sess = StreamSession(stream=stream, base_url=base_url)
        with _lock:
            self.streams[session_id] = sess
        return session_id, sess

    def get_session(self, session_id: str) -> StreamSession | None:
        return self.streams.get(session_id)

    async def request_device(self, method: str, path: str, body: str = "") -> dict:
        """Make an authenticated request to the active local Tablo device."""
        resp = await self._request_device_raw(method, path, body)
        return resp.json()

    async def _request_device_raw(
        self, method: str, path: str, body: str = "", follow_redirects: bool = False
    ):
        """Signed device request returning the raw httpx response.

        Used directly for non-JSON responses such as snapshot images.

        `follow_redirects` is off by default and only `fetch_device_image` turns
        it on. On the API port a redirect means something unexpected happened;
        on the image path it is the normal answer. See `fetch_device_image`.
        """
        if self.active_device is None:
            raise RuntimeError("No active device")

        from tablo_api import TabloAuth
        auth_header, date_header = TabloAuth.make_device_auth(method, path, body)

        url = self.active_device.local_url.rstrip("/") + path
        resp = await self._http.request(
            method,
            url,
            content=body.encode() if body else None,
            headers={
                "Authorization": auth_header,
                "Date": date_header,
                "User-Agent": "Tablo-FAST/1.7.0 (Mobile; iPhone; iOS 18.4)",
            },
            follow_redirects=follow_redirects,
        )
        resp.raise_for_status()
        return resp

    async def fetch_device_image(self, image_id: int) -> tuple[bytes, str]:
        """Fetch an image from the device. Returns (bytes, content_type).

        Follows redirects, which is the whole trick. `/images/{id}` returns a
        body for a few ids and a 302 for most, pointing at the device's *stream*
        port: `http://<device>:80/stream/thumb?id=...&path=<base64>`. Measured
        on a real guide, 157 of 160 imminent cover images answered that way.

        Without following it, `raise_for_status` turns every one into an error
        and `guide_images.get` reports it as an absent poster - which is silent
        by design, so the symptom is simply that almost no sheet has artwork.

        This is the same split `start_recording_session` documents: media lives
        on port 80, the API on 8887, and `local_url` is the API. httpx drops the
        Authorization header on a cross-origin hop, which is correct here - the
        redirect target carries its own signed `path` parameter.
        """
        resp = await self._request_device_raw(
            "GET", f"/images/{int(image_id)}", follow_redirects=True
        )
        return resp.content, resp.headers.get("content-type", "image/jpeg")

    async def start_recording_session(self, path: str) -> dict:
        """Open (or refresh) a device watch session for a recording.

        ``POST {path}/watch`` with an empty body; GET on the same path 404s. The
        response carries a ``playlist_url`` on the device's *stream* port (80),
        not the API port, so callers must not assume ``local_url``.

        Re-POSTing an active session refreshes its expiry and returns the same
        playlist URL, which is what makes this usable as a keepalive.
        """
        if not path.startswith("/recordings/"):
            raise ValueError(f"not a recording path: {path}")
        return await self.request_device("POST", f"{path}/watch")

    def _cloud_headers(self) -> tuple[str, dict]:
        """Return (cloud_base_url, auth_headers) for the active device."""
        dev = self.active_device
        return "https://lighthousetv.ewscloud.com", {
            "Authorization": f"Bearer {dev.account_token}",
            "Lighthouse": dev.lighthouse_token,
            "User-Agent": "Tablo-FAST/2.0.0 (Mobile; iPhone; iOS 16.6)",
        }

    async def _fetch_cloud_channels(self) -> tuple[dict, list[str]]:
        """Fetch OTT channel list from the cloud API (single request, fast).

        Returns (logo_map, identifiers).
        """
        if self.active_device is None:
            return {}, []
        host, headers = self._cloud_headers()
        try:
            resp = await self._http.get(
                f"{host}/api/v2/account/{self.active_device.lighthouse_token}/guide/channels/",
                headers=headers,
                timeout=15,
            )
            resp.raise_for_status()
            channels = resp.json()
        except Exception:
            return {}, []

        logo_map: dict = {}
        identifiers: list[str] = []
        for ch in channels:
            identifier = ch.get("identifier")
            if not identifier:
                continue
            identifiers.append(identifier)
            logos = ch.get("logos") or []
            logo = next((lg["url"] for lg in logos if lg.get("kind") == "originalLarge"), None)
            if not logo:
                logo = next((lg["url"] for lg in logos if lg.get("kind") == "lightLarge"), None)
            if not logo:
                logo = next((lg.get("url") for lg in logos if lg.get("url")), None)
            if logo:
                logo_map[identifier] = logo

        return logo_map, identifiers

    @staticmethod
    def _airing_on_now(airings: list, now: datetime | None = None) -> dict | None:
        """Whichever of `airings` is on air, or None.

        The cloud schedule is a full timeline now, so the current programme has
        to be picked out of it rather than handed over ready-made as the
        single-airing endpoint used to do.
        """
        at = now or datetime.now(timezone.utc)
        for air in airings:
            start_str = air.get("start")
            if not start_str:
                continue
            try:
                start = datetime.fromisoformat(str(start_str).replace("Z", "+00:00"))
                end = start + timedelta(seconds=air.get("duration") or 0)
                if start <= at < end:
                    return air
            except ValueError:
                continue
        return None

    # Which cloud artwork the sheet wants, best first.
    #
    # The hero is a 16:9 frame, so the wide kinds come first and `poster` - a
    # 2:3 portrait - is the last resort rather than the first. An episode still
    # beats a series cover because it is about this episode. Kinds outside this
    # list are ignored rather than guessed at: an unrecognised name could be
    # any shape, and a banner stretched across the hero looks like a bug.
    _CLOUD_IMAGE_KINDS = ("stillLarge", "coverLarge", "background",
                          "stillSmall", "coverSmall", "poster")

    @staticmethod
    def _cloud_image_url(images: list | None) -> str | None:
        """The best available artwork URL from a cloud airing, or None."""
        by_kind = {
            i.get("kind"): i.get("url")
            for i in (images or []) if isinstance(i, dict) and i.get("url")
        }
        for kind in AppState._CLOUD_IMAGE_KINDS:
            if by_kind.get(kind):
                return by_kind[kind]
        return None

    @staticmethod
    def _cloud_airing_row(a: dict) -> dict:
        """One cloud airing, in the shape the mirror stores.

        The naming is inverted relative to the device, and getting it wrong is
        silent: the cloud's `title` is the *episode* and `show.title` is the
        programme, where the device has `airing_details.show_title` for the
        programme and `episode.title` for the episode. Mapping `title` to
        `title` puts "Oh, the Humidity!" in the grid cell and loses "Weather
        Hunters" altogether.

        Movies and one-off events repeat the same string in both fields, so the
        episode title is dropped when it matches - otherwise the sheet renders
        the title twice, once under itself.

        `airing_path`, `series_path` and the schedule fields stay None. The
        cloud has no device paths, and a non-null `airing_path` that is not one
        would be a PATCH target that 404s. See docs/tablo-api.md.
        """
        show = a.get("show") or {}
        ep = a.get("episode") or {}
        season = ep.get("season") or {}

        programme = _unescape(show.get("title") or a.get("title"))
        episode_title = _unescape(a.get("title"))
        if episode_title == programme:
            episode_title = None

        # `season.number` is 0 on plenty of real records - 500.1 is full of
        # them - and that means "no season", not "season zero". The `kind`
        # field exists at all because the slot is not always a season index, so
        # anything other than "number" is not one either.
        season_number = season.get("number")
        if season.get("kind") != "number" or not season_number:
            season_number = None

        return {
            "title": programme,
            "subtitle": None,
            "description": _unescape(a.get("description")),
            "start": a.get("datetime"),
            "duration": a.get("duration"),
            "genres": a.get("genres") or [],
            "kind": a.get("kind"),
            "episode_title": episode_title,
            "season_number": season_number,
            "episode_number": ep.get("episodeNumber"),
            "orig_air_date": ep.get("originalAirDate"),
            # An absolute CDN URL, not a device image id. OTT airings have no
            # series record to hang a cover on, and the browser already loads
            # channel logos from this host - so no proxy and no server-side
            # fetch is involved. See docs/tablo-api.md.
            "image_url": AppState._cloud_image_url(a.get("images")),
            # Display source only - the cloud carries no device handles.
            "series_path": None,
            "airing_path": None,
            "schedule_state": None,
            "schedule_qualifier": None,
            "skip_reason": None,
        }

    async def _fetch_cloud_schedule(
        self, days: int = CLOUD_GUIDE_DAYS, today: str | None = None
    ) -> dict[str, list[dict]]:
        """The cloud guide, keyed by channel identifier. Never raises.

        This is the only source of OTT/FAST schedules - the device returns zero
        airings for every one of them.

        Two undocumented parameters do the work. `limit=50` collapses the
        grid's four-channels-per-page pagination into a single response, and
        `day` walks forward; nothing else moves the window. So the whole
        14-day guide for every channel is `days` requests, against the ~9,166
        the device walk costs for the same period.

        Consecutive days overlap at their edges because the grid's day boundary
        is local rather than UTC, so airings are keyed on start and deduped.
        """
        if self.active_device is None:
            return {}
        host, headers = self._cloud_headers()
        token = self.active_device.lighthouse_token
        start = (
            datetime.fromisoformat(today) if today
            else datetime.now(timezone.utc)
        )
        url = f"{host}/api/v2/account/{token}/guide/grid/"
        sem = asyncio.Semaphore(CLOUD_GUIDE_CONCURRENCY)

        async def fetch_day(offset: int):
            day = (start + timedelta(days=offset)).strftime("%Y-%m-%d")
            async with sem:
                try:
                    r = await self._http.get(
                        url, headers=headers,
                        params={"limit": 50, "day": day}, timeout=30,
                    )
                    if r.status_code != 200:
                        return []
                    return (r.json() or {}).get("grid") or []
                except Exception:
                    return []

        pages = await asyncio.gather(*[fetch_day(d) for d in range(days)])

        by_channel: dict[str, dict[str, dict]] = {}
        for grid in pages:
            for row in grid:
                ident = ((row or {}).get("channel") or {}).get("identifier")
                if not ident:
                    continue
                slot = by_channel.setdefault(ident, {})
                for a in row.get("airings") or []:
                    mapped = AppState._cloud_airing_row(a)
                    if mapped["start"]:
                        slot[mapped["start"]] = mapped

        return {
            ident: [slot[k] for k in sorted(slot)]
            for ident, slot in by_channel.items()
        }

    async def _fetch_cloud_data(self) -> tuple[dict, dict]:
        """Fetch cloud channel logos and the cloud guide.

        Returns (logo_map, schedule_map). The schedule is keyed by channel
        identifier and each value is the channel's airings, in order.
        """
        logo_map, _ = await self._fetch_cloud_channels()
        schedule = await self._fetch_cloud_schedule()
        return logo_map, schedule

    async def _fetch_guide_enrichment_local(self) -> tuple[dict, dict, dict]:
        """Fetch local device logos and current airings (OTA only).

        Returns (logo_map, path_to_ident, channel_airing_map).
        """
        path_results = await asyncio.gather(
            self.request_device("GET", "/guide/channels"),
            self.request_device("GET", "/guide/airings"),
            return_exceptions=True,
        )
        detail_paths = path_results[0] if not isinstance(path_results[0], Exception) else []
        airing_paths = path_results[1] if not isinstance(path_results[1], Exception) else []

        sem = asyncio.Semaphore(30)

        async def fetch_detail(path):
            async with sem:
                try:
                    return path, await self.request_device("GET", path)
                except Exception:
                    return path, None

        async def fetch_airing(path):
            async with sem:
                try:
                    return await self.request_device("GET", path)
                except Exception:
                    return None

        detail_results, airing_results = await asyncio.gather(
            asyncio.gather(*[fetch_detail(p) for p in detail_paths[:300]]),
            asyncio.gather(*[fetch_airing(p) for p in airing_paths[:800]]),
        )

        logo_map: dict = {}
        path_to_ident: dict = {}
        for path, d in detail_results:
            if d and "channel" in d:
                c_info = d["channel"]
                ident = c_info.get("channel_identifier")
                path_to_ident[d.get("path", path)] = ident
                logos = c_info.get("logos", [])
                logo = next(( logo["url"] for logo in logos if logo["kind"] == "originalLarge"), None)
                if not logo:
                    logo = next(( logo["url"] for logo in logos if logo["kind"] == "lightLarge"), None)
                if ident and logo:
                    logo_map[ident] = logo

        now = datetime.now(timezone.utc)
        channel_airing_map: dict = {}
        for a in airing_results:
            if not a or "airing_details" not in a:
                continue
            ad = a["airing_details"]
            try:
                start_str = ad.get("datetime")
                if not start_str:
                    continue
                start = datetime.fromisoformat(start_str.replace("Z", "+00:00"))
                duration = ad.get("duration", 0)
                end = start + timedelta(seconds=duration)
                if start <= now < end:
                    c_path = ad.get("channel_path")
                    if c_path:
                        channel_airing_map[c_path] = {
                            "title": ad.get("show_title"),
                            "description": a.get("episode", {}).get("description") or a.get("series", {}).get("description"),
                            "start": start_str,
                            "duration": duration,
                            "genres": ad.get("genres") or [],
                            "kind": ad.get("event_type"),
                        }
            except Exception:
                continue

        return logo_map, path_to_ident, channel_airing_map

    async def _fetch_guide_enrichment(self) -> tuple[dict, dict, dict, dict]:
        """Fetch logo and airing data from local device and cloud in parallel.

        Returns (logo_map, path_to_ident, channel_airing_map, cloud_schedule).
        channel_airing_map is keyed by local channel path (OTA only).
        cloud_schedule is keyed by channel identifier (OTT).
        """
        path_results = await asyncio.gather(
            self.request_device("GET", "/guide/channels"),
            self.request_device("GET", "/guide/airings"),
            self._fetch_cloud_data(),
            return_exceptions=True,
        )
        detail_paths = path_results[0] if not isinstance(path_results[0], Exception) else []
        airing_paths = path_results[1] if not isinstance(path_results[1], Exception) else []
        cloud_logos: dict
        cloud_schedule: dict
        if isinstance(path_results[2], Exception):
            cloud_logos, cloud_schedule = {}, {}
        else:
            cloud_logos, cloud_schedule = path_results[2]

        sem = asyncio.Semaphore(30)

        async def fetch_detail(path):
            async with sem:
                try:
                    return path, await self.request_device("GET", path)
                except Exception:
                    return path, None

        async def fetch_airing(path):
            async with sem:
                try:
                    return await self.request_device("GET", path)
                except Exception:
                    return None

        detail_results, airing_results = await asyncio.gather(
            asyncio.gather(*[fetch_detail(p) for p in detail_paths[:300]]),
            asyncio.gather(*[fetch_airing(p) for p in airing_paths[:800]]),
        )

        logo_map: dict = {}
        path_to_ident: dict = {}
        for path, d in detail_results:
            if d and "channel" in d:
                c_info = d["channel"]
                ident = c_info.get("channel_identifier")
                path_to_ident[d.get("path", path)] = ident
                logos = c_info.get("logos", [])
                logo = next(( logo["url"] for logo in logos if logo["kind"] == "originalLarge"), None)
                if not logo:
                    logo = next(( logo["url"] for logo in logos if logo["kind"] == "lightLarge"), None)
                if ident and logo:
                    logo_map[ident] = logo

        now = datetime.now(timezone.utc)
        channel_airing_map: dict = {}
        for a in airing_results:
            if not a or "airing_details" not in a:
                continue
            ad = a["airing_details"]
            try:
                start_str = ad.get("datetime")
                if not start_str:
                    continue
                start = datetime.fromisoformat(start_str.replace("Z", "+00:00"))
                duration = ad.get("duration", 0)
                end = start + timedelta(seconds=duration)
                if start <= now < end:
                    c_path = ad.get("channel_path")
                    if c_path:
                        channel_airing_map[c_path] = {
                            "title": ad.get("show_title"),
                            "description": a.get("episode", {}).get("description") or a.get("series", {}).get("description"),
                            "start": start_str,
                            "duration": duration,
                            "genres": ad.get("genres") or [],
                            "kind": ad.get("event_type"),
                        }
            except Exception:
                continue

        # Merge cloud logos as fallback (local logos take priority)
        for ident, url in cloud_logos.items():
            if ident not in logo_map:
                logo_map[ident] = url

        return logo_map, path_to_ident, channel_airing_map, cloud_schedule

    async def get_guide_data(self) -> list[dict]:
        """Aggregate channels with logos and current airing info."""
        if self.active_device is None:
            raise RuntimeError("No active device")

        channels = await self.channels()
        logo_map, path_to_ident, channel_airing_map, cloud_schedule = await self._fetch_guide_enrichment()

        guide = []
        for c in channels:
            c_path = next((p for p, ident in path_to_ident.items() if ident == c.identifier), None)
            current_program = (
                (channel_airing_map.get(c_path) if c_path else None)
                or AppState._airing_on_now(cloud_schedule.get(c.identifier) or [])
            )
            guide.append({
                "identifier": c.identifier,
                "call_sign": c.call_sign,
                "major": c.major,
                "minor": c.minor,
                "network": c.network,
                "kind": c.kind,
                "display_name": c.display_name,
                "logo_url": logo_map.get(c.identifier),
                "current_program": current_program,
            })

        return guide

    async def stream_guide_data(self):
        """Async generator for NDJSON guide streaming.

        Yields basic channel records immediately, then enriched records once
        logo/airing data is available. The frontend merges by identifier.
        """
        if self.active_device is None:
            raise RuntimeError("No active device")

        channels = await self.channels()

        def _stub(c, logo_url=None, current_program=None):
            return json.dumps({
                "identifier": c.identifier,
                "call_sign": c.call_sign,
                "major": c.major,
                "minor": c.minor,
                "network": c.network,
                "kind": c.kind,
                "display_name": c.display_name,
                "logo_url": logo_url,
                "current_program": current_program,
            }) + "\n"

        # Phase 1: bare stubs so the UI renders immediately on cold start.
        # Skip when cache is warm — Phase 3 will be instant and stubs would
        # briefly clobber existing logo/program data already held by the frontend.
        import time as _time
        cache_warm = bool(
            self._grid_cache and _time.monotonic() - self._grid_cache_time < self._GRID_CACHE_TTL
        )
        if not cache_warm:
            for c in channels:
                yield _stub(c)

        # Phase 2: cloud logos fast path — only when enrichment cache is cold
        if not cache_warm:
            cloud_logo_map, _ = await self._fetch_cloud_channels()
            for c in channels:
                if c.identifier in cloud_logo_map:
                    yield _stub(c, logo_url=cloud_logo_map[c.identifier])

        # Phase 3: full enrichment via shared grid cache (instant on hit, ~90s on cold start)
        try:
            logo_map, path_to_ident, channel_to_airings, cloud_schedule = await asyncio.wait_for(
                self._build_grid_enrichment(), timeout=90
            )
        except Exception as e:
            print(f"[guide-live] Phase 3 failed: {type(e).__name__}: {e}")
            return

        for c in channels:
            c_path = next((p for p, ident in path_to_ident.items() if ident == c.identifier), None)
            airings = channel_to_airings.get(c_path, []) if c_path else []
            current_program = (
                AppState._airing_on_now(airings)
                or AppState._airing_on_now(cloud_schedule.get(c.identifier) or [])
            )
            yield _stub(c, logo_url=logo_map.get(c.identifier), current_program=current_program)

    @staticmethod
    def _recording_fields(data: dict) -> dict:
        """Project a device recording record into the shape the UI consumes.

        Three details the device gets right and the old projection got wrong:

        * Description lives under ``event`` for sports, ``episode`` for series,
          ``series`` as a fallback. Reading only the latter two left every sports
          recording with a null description.
        * ``video_details.duration`` is what was actually recorded, including the
          padding in ``recorded_offsets``. ``airing_details.duration`` is only the
          scheduled slot and understates every recording.
        * ``snapshot_image.image_id`` is a real, fetchable thumbnail.
        """
        ad = data.get("airing_details") or {}
        vd = data.get("video_details") or {}
        event = data.get("event") or {}
        episode = data.get("episode") or {}
        series = data.get("series") or {}
        user = data.get("user_info") or {}
        snapshot = data.get("snapshot_image") or {}
        object_id = data.get("object_id")

        image_id = snapshot.get("image_id")
        channel = AppState._channel_fields(ad)
        # The device flags this on the recording itself, so the scan type is
        # known without probing the stream. Verified against ffmpeg's idet on
        # all six recordings: the flag and the detection agreed every time.
        interlaced = "interlaced" in (vd.get("flags") or [])
        height = vd.get("height")
        scan = f"{height}{'i' if interlaced else 'p'}" if height else None
        return {
            "object_id": object_id,
            # Retained so existing frontend code keyed on `identifier` keeps working.
            "identifier": object_id,
            "path": data.get("path"),
            "title": ad.get("show_title") or event.get("title"),
            "subtitle": event.get("title") or episode.get("title"),
            "description": (
                event.get("description")
                or episode.get("description")
                or series.get("description")
            ),
            "start": ad.get("datetime"),
            "duration": vd.get("duration") or ad.get("duration") or 0,
            "thumbnail": f"/api/recordings/{object_id}/thumbnail" if image_id else None,
            "width": vd.get("width"),
            "height": vd.get("height"),
            "state": vd.get("state"),
            "error": vd.get("error"),
            "watched": user.get("watched", False),
            "position": user.get("position", 0),
            "channel": channel,
            # e.g. "1080i" / "720p". Interlaced sources need deinterlacing on
            # the way to H.264, which costs throughput and roughly doubles the
            # cached size, so it is worth showing rather than leaving to be
            # discovered as combing on a moving edge.
            "scan": scan,
            "interlaced": interlaced,
        }

    @staticmethod
    def _channel_fields(ad: dict) -> dict | None:
        """Station identity, flattened out of the nested airing record."""
        wrapper = ad.get("channel") or {}
        ch = wrapper.get("channel") or wrapper
        if not ch.get("call_sign"):
            return None
        major, minor = ch.get("major"), ch.get("minor")
        return {
            "call_sign": ch.get("call_sign"),
            "network": ch.get("network"),
            "number": f"{major}.{minor}" if major is not None else None,
        }

    async def get_recordings(self, limit: int = 200) -> list[dict]:
        """Fetch recordings from the device, enriched for the Library view.

        Also populates the object_id → path map. The client only ever holds an
        object_id, but every device call needs the category-scoped path
        (e.g. ``/recordings/sports/events/80888``), which is not derivable from
        the id alone.
        """
        if self.active_device is None:
            raise RuntimeError("No active device")

        try:
            paths = await self.request_device("GET", "/recordings/airings")
        except Exception:
            return []

        self.recordings_total = len(paths)
        sem = asyncio.Semaphore(30)

        async def fetch_recording(path):
            async with sem:
                try:
                    return self._recording_fields(await self.request_device("GET", path))
                except Exception:
                    return None

        recordings = await asyncio.gather(*[fetch_recording(p) for p in paths[:limit]])
        out = [r for r in recordings if r and r.get("object_id") is not None]
        for r in out:
            self._recording_paths[int(r["object_id"])] = r["path"]
        return out

    async def recording_snapshot(self, object_id: int) -> dict:
        """Full library projection for one recording, straight from the device.

        Stored when a recording is kept offline, so it can still be listed and
        played after the Tablo has deleted it.
        """
        path = self._recording_paths.get(int(object_id))
        if path is None:
            await self.get_recordings()
            path = self._recording_paths.get(int(object_id))
        if path is None:
            raise KeyError(f"recording {object_id} not found")
        return self._recording_fields(await self.request_device("GET", path))

    async def resolve_recording(self, object_id: int) -> tuple[str, int]:
        """Return (device_path, duration) for a recording id.

        Refreshes the recording list once on a miss so a cold start or a direct
        API call still works without the client having listed recordings first.
        """
        object_id = int(object_id)
        path = self._recording_paths.get(object_id)
        if path is None:
            await self.get_recordings()
            path = self._recording_paths.get(object_id)
        if path is None:
            raise KeyError(f"recording {object_id} not found")

        data = await self.request_device("GET", path)
        vd = data.get("video_details") or {}
        ad = data.get("airing_details") or {}
        return path, int(vd.get("duration") or ad.get("duration") or 0)

    @staticmethod
    def _series_row(data: dict) -> dict:
        """One series record, as the mirror stores it."""
        s = data.get("series") or {}
        keep = data.get("keep") or {}

        def image_id(key: str):
            return (s.get(key) or {}).get("image_id")

        return {
            "path": data.get("path"),
            "identifier": data.get("identifier"),
            "title": s.get("title"),
            "description": s.get("description"),
            "genres": s.get("genres") or [],
            "rating": s.get("series_rating"),
            "orig_air_date": s.get("orig_air_date"),
            "episode_runtime": s.get("episode_runtime"),
            "cast": s.get("cast") or [],
            "cover_image_id": image_id("cover_image"),
            "thumbnail_image_id": image_id("thumbnail_image"),
            "background_image_id": image_id("background_image"),
            # Captured, not yet exposed - see docs/tablo-api.md.
            "schedule_rule": data.get("schedule_rule"),
            "keep_rule": keep.get("rule"),
            "keep_count": keep.get("count"),
        }

    async def sync_series(self, paths: list[str]) -> int:
        """Fetch and store the series we do not already have. Never raises.

        Runs on the background sync, never on the interactive guide path: a
        cold guide load spans ~350 distinct series, and 350 round trips is the
        wrong thing to put in front of someone waiting for the grid.
        """
        if self.active_device is None:
            return 0
        wanted = await _run_sync(store.series_needing_refresh, paths)
        if not wanted:
            return 0

        sem = asyncio.Semaphore(SERIES_SYNC_CONCURRENCY)

        async def fetch(path: str):
            async with sem:
                try:
                    return await self.request_device("GET", path)
                except Exception:
                    return None

        results = [r for r in await asyncio.gather(*[fetch(p) for p in wanted]) if r]
        if not results:
            return 0
        rows = [AppState._series_row(r) for r in results]
        await _run_sync(store.save_series, rows)
        return len(rows)

    async def prefetch_artwork(self) -> int:
        """Warm the cache for what airs soon. Never raises.

        Paired with `sync_series`: that fills in which image each series has,
        this fetches the ones a viewer is about to be able to see.
        """
        from . import guide_images

        ids = await _run_sync(store.imminent_cover_ids)
        missing = [i for i in ids if not guide_images.cached_path(i).exists()]
        if not missing:
            return 0
        sem = asyncio.Semaphore(SERIES_SYNC_CONCURRENCY)

        async def one(image_id: int):
            async with sem:
                return await guide_images.get(image_id, self.fetch_device_image)

        got = await asyncio.gather(*[one(i) for i in missing])
        return sum(1 for g in got if g)

    @staticmethod
    def _airing_row(a: dict) -> dict:
        """One guide airing, as the mirror stores it.

        Extracted from the loop in `_build_grid_enrichment` so it can be tested
        without a device, and widened: the record carries an `episode` object
        and a `schedule` block that the previous six-field mapping discarded.
        Both arrive in a response already being fetched, so keeping them costs
        nothing.

        `airing_path` is the PATCH target for recording management (see
        docs/tablo-api.md). It is captured now so that work needs no
        migration and no re-sync.
        """
        ad = a.get("airing_details") or {}
        ep = a.get("episode") or {}
        sched = a.get("schedule") or {}
        return {
            "title": ad.get("show_title"),
            "description": ep.get("description") or (a.get("series") or {}).get("description"),
            "start": ad.get("datetime"),
            "duration": ad.get("duration"),
            "genres": ad.get("genres") or [],
            "kind": ad.get("event_type"),
            # Displayed by the show sheet.
            "episode_title": ep.get("title"),
            "season_number": ep.get("season_number"),
            "episode_number": ep.get("number"),
            "orig_air_date": ep.get("orig_air_date"),
            "series_path": a.get("series_path"),
            # Captured, not yet exposed - see docs/tablo-api.md.
            "airing_path": a.get("path"),
            "schedule_state": sched.get("state"),
            "schedule_qualifier": sched.get("qualifier"),
            "skip_reason": sched.get("skip_reason"),
        }

    async def _build_grid_enrichment(self, max_airings: int = 1000, concurrency: int = 30) -> tuple[dict, dict, dict, dict]:
        """Fetch logos and airings for the grid guide.

        Returns (logo_map, path_to_ident, channel_to_airings, cloud_schedule).
        Results are cached for _GRID_CACHE_TTL seconds so repeated guide loads
        don't re-fetch hundreds of airing detail records from the device.
        The EPG endpoint passes max_airings=15000 and bypasses the cache.

        `concurrency` bounds how many device requests are in flight at once.
        The background guide sync (up to 8455 airings) passes a value lower
        than the interactive default so it does not starve a concurrent seek -
        the Tablo saturates around 10x realtime, and it is shared with playback.
        """
        import time as _time

        # Cache only applies to the standard guide load (max_airings == 1000)
        use_cache = max_airings == 1000
        if use_cache:
            async with self._grid_cache_lock:
                if self._grid_cache and _time.monotonic() - self._grid_cache_time < self._GRID_CACHE_TTL:
                    return self._grid_cache

        path_results = await asyncio.gather(
            self.request_device("GET", "/guide/channels"),
            self.request_device("GET", "/guide/airings"),
            self._fetch_cloud_data(),
            return_exceptions=True,
        )
        local_paths = path_results[0] if not isinstance(path_results[0], Exception) else []
        airing_paths = path_results[1] if not isinstance(path_results[1], Exception) else []
        cloud_logos: dict
        cloud_schedule: dict
        if isinstance(path_results[2], Exception):
            cloud_logos, cloud_schedule = {}, {}
        else:
            cloud_logos, cloud_schedule = path_results[2]

        sem = asyncio.Semaphore(concurrency)

        async def fetch_detail(path):
            async with sem:
                try:
                    return await self.request_device("GET", path)
                except Exception:
                    return None

        async def fetch_airing(path):
            async with sem:
                try:
                    return await self.request_device("GET", path)
                except Exception:
                    return None

        details, airing_details = await asyncio.gather(
            asyncio.gather(*[fetch_detail(p) for p in local_paths[:300]]),
            asyncio.gather(*[fetch_airing(p) for p in airing_paths[:max_airings]]),
        )

        path_to_ident: dict = {}
        logo_map: dict = {}
        for d in details:
            if d and "channel" in d:
                c_info = d["channel"]
                ident = c_info.get("channel_identifier")
                path_to_ident[d["path"]] = ident
                logos = c_info.get("logos", [])
                logo = next(( logo["url"] for logo in logos if logo["kind"] == "originalLarge"), None)
                if not logo:
                    logo = next(( logo["url"] for logo in logos if logo["kind"] == "lightLarge"), None)
                if ident and logo:
                    logo_map[ident] = logo

        for ident, url in cloud_logos.items():
            if ident not in logo_map:
                logo_map[ident] = url

        cloud_schedule_local = cloud_schedule  # rename for closure clarity
        channel_to_airings: dict = {}
        for a in airing_details:
            if not a or "airing_details" not in a:
                continue
            c_path = (a["airing_details"] or {}).get("channel_path")
            if not c_path:
                continue
            channel_to_airings.setdefault(c_path, []).append(AppState._airing_row(a))

        result = logo_map, path_to_ident, channel_to_airings, cloud_schedule_local
        if use_cache:
            async with self._grid_cache_lock:
                self._grid_cache = result
                self._grid_cache_time = _time.monotonic()
        return result

    def _assemble_grid_row(self, c, logo_map: dict, path_to_ident: dict, channel_to_airings: dict, cloud_schedule: dict) -> dict:
        c_path = next((p for p, ident in path_to_ident.items() if ident == c.identifier), None)
        airings = channel_to_airings.get(c_path, []) if c_path else []
        # OTT/FAST channels have no device schedule at all, so the cloud is not
        # a fallback here - it is the only source. This used to inject a single
        # current programme, which is why those rows drew exactly one cell.
        #
        # The device still wins where it has anything, because its records
        # carry the recording handles the cloud has no equivalent for.
        if not airings:
            airings = list(cloud_schedule.get(c.identifier) or [])
        airings.sort(key=lambda x: x.get("start") or "")
        return {
            "identifier": c.identifier,
            "call_sign": c.call_sign,
            "major": c.major,
            "minor": c.minor,
            "network": c.network,
            # The player transcodes OTA because no browser decodes MPEG-2 video.
            # A row without a kind plays the raw broadcast into hls.js, which
            # fails to parse every fragment and shows nothing.
            "kind": c.kind,
            "display_name": c.display_name,
            "logo_url": logo_map.get(c.identifier),
            "airings": airings,
        }

    async def get_grid_guide(self, max_airings: int = 1000, concurrency: int = 30) -> list[dict]:
        """The grid guide: channels plus their upcoming airings.

        Served from the database when it is fresh enough. Previously the only
        cache was in process memory, so every restart paid a cold rebuild of
        hundreds of airing records from the device.

        The stored-guide short-circuit only applies at the default
        `max_airings`. A caller asking for more (the background guide sync
        passes 15000) wants a deeper fetch than the grid already cached -
        serving the stored guide back to it would just hand it its own mirror,
        and the mirror would never deepen past what the interactive grid path
        happens to have cached.
        """
        if max_airings == 1000:
            stored = await self._stored_guide()
            if stored is not None:
                return stored

        if self.active_device is None:
            raise RuntimeError("No active device")
        # refresh=True, because `self._channels` has no TTL of its own - it is
        # only cleared when the device changes. Without this, a channel the
        # account has since dropped survives every guide rebuild and only
        # disappears when the process restarts, which made the hour-long guide
        # TTL above look like it expired the channel list when it did not.
        # Only reached when the stored guide was already stale, so this costs
        # no extra device traffic at rest.
        channels = await self.channels(refresh=True)
        logo_map, path_to_ident, channel_to_airings, cloud_schedule = await self._build_grid_enrichment(
            max_airings=max_airings, concurrency=concurrency
        )
        rows = [
            self._assemble_grid_row(c, logo_map, path_to_ident, channel_to_airings, cloud_schedule)
            for c in channels
        ]
        try:
            await _run_sync(store.save_guide, rows)
        except Exception as e:
            print(f"[db] could not store guide: {e}", flush=True)
        return rows

    async def refresh_channel_list(self) -> dict:
        """Re-fetch the account's channel list and rebuild the guide from it.

        Not a tuner scan. `TabloClient.channels` is a GET against the Tablo
        cloud guide for this device - the same list read on first connect - so
        nothing here touches the antenna and a channel disabled in the Tablo
        app disappears because their cloud stops listing it, not because the
        broadcast changed.

        Deliberately does not go through `get_grid_guide`, which returns the
        stored guide whenever it is fresh and would make this a no-op for an
        hour after any normal load. Every cache between the device and the grid
        is dropped first, in order: the channel list, the enrichment cache, and
        then the stored guide by way of `save_guide` stamping a newer sync -
        `load_guide` returns only channels carrying the newest stamp, so a
        dropped channel stops appearing while its airing history stays on disk
        for the search index.
        """
        if self.active_device is None:
            raise RuntimeError("No active device")

        before = {c.identifier for c in (self._channels or [])}

        self._channels = None
        async with self._grid_cache_lock:
            self._grid_cache = None
            self._grid_cache_time = 0.0

        channels = await self.channels(refresh=True)
        logo_map, path_to_ident, channel_to_airings, cloud_schedule = await self._build_grid_enrichment()
        rows = [
            self._assemble_grid_row(c, logo_map, path_to_ident, channel_to_airings, cloud_schedule)
            for c in channels
        ]
        await _run_sync(store.save_guide, rows)

        after = {c.identifier for c in channels}
        return {
            "channels": len(rows),
            "added": sorted(after - before),
            "removed": sorted(before - after),
        }

    async def _stored_guide(self) -> list[dict] | None:
        """The stored guide, if it is fresh and still has something to show.

        A guide whose airings have all ended is treated as absent: rendering
        empty rows looks like a broken guide rather than a stale one.
        """
        try:
            age = await _run_sync(store.guide_age_seconds)
            if age is None or age > self._GRID_CACHE_TTL:
                return None
            rows = await _run_sync(store.load_guide)
        except Exception as e:
            print(f"[db] could not read guide: {e}", flush=True)
            return None
        if not rows or not any(r.get("airings") for r in rows):
            return None
        return rows

    async def get_epg_guide(self) -> list[dict]:
        """Full multi-day guide fetch for XMLTV EPG — fetches up to 15000 airings."""
        if self.active_device is None:
            raise RuntimeError("No active device")
        channels = await self.channels()
        logo_map, path_to_ident, channel_to_airings, cloud_schedule = await self._build_grid_enrichment(max_airings=15000)
        return [self._assemble_grid_row(c, logo_map, path_to_ident, channel_to_airings, cloud_schedule) for c in channels]

    async def stream_grid_guide_data(self):
        """Async generator for NDJSON grid guide streaming.

        Phase 1: emits channel stubs immediately so the grid renders at once.
        Phase 2: emits fully-enriched rows (logos + airings) once fetching is done.
        """
        # A stored guide is already complete, so stream it and stop. This is the
        # path a page refresh takes: no device round trip, and no stub phase to
        # blank out rows the client already had.
        stored = await self._stored_guide()
        if stored is not None:
            for row in stored:
                yield json.dumps(row) + "\n"
            return

        if self.active_device is None:
            raise RuntimeError("No active device")

        # refresh=True for the same reason as `get_grid_guide`: only reached
        # when the stored guide is already stale, and without it a dropped
        # channel is pinned in memory until the process restarts.
        channels = await self.channels(refresh=True)

        # Phase 1: channel stubs — grid rows appear immediately
        for c in channels:
            yield json.dumps({
                "identifier": c.identifier,
                "call_sign": c.call_sign,
                "major": c.major,
                "minor": c.minor,
                "network": c.network,
                "kind": c.kind,
                "display_name": c.display_name,
                "logo_url": None,
                "airings": [],
            }) + "\n"

        # Phase 2: enriched rows with logos and timelines (90s hard timeout)
        try:
            logo_map, path_to_ident, channel_to_airings, cloud_schedule = await asyncio.wait_for(
                self._build_grid_enrichment(), timeout=90
            )
        except Exception as e:
            print(f"[guide-grid] Phase 2 failed: {type(e).__name__}: {e}")
            return
        rows = [
            self._assemble_grid_row(c, logo_map, path_to_ident, channel_to_airings, cloud_schedule)
            for c in channels
        ]
        for row in rows:
            yield json.dumps(row) + "\n"

        # Stored after streaming so the client is never kept waiting on a write.
        try:
            await _run_sync(store.save_guide, rows)
        except Exception as e:
            print(f"[db] could not store guide: {e}", flush=True)

    def stop_session(self, session_id: str) -> None:
        with _lock:
            self.streams.pop(session_id, None)

    @property
    def is_authenticated(self) -> bool:
        return self.auth is not None

    @property
    def http(self) -> httpx.AsyncClient:
        return self._http


# Module-level singleton
state = AppState()


async def _run_sync(fn, *args):
    """Run a blocking function in the default thread pool."""
    import asyncio
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, fn, *args)
