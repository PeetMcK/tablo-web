import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import guide_sync, store
from . import log_buffer as _log_buffer
from .routes import (
    auth,
    channels,
    iptv,
    recordings,
    resume,
    schedule,
    search,
    settings,
    stream,
)
from .state import CONFIG_PATH, _run_sync, state

_log_buffer.install()

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Import the pre-database layout before anything reads it. Both migrations
    # are guarded on an empty table, so this is a no-op after the first boot.
    try:
        await _run_sync(store.migrate_config, CONFIG_PATH)
        await _run_sync(store.migrate_recordings, recordings.cache.root)
    except Exception as e:
        print(f"[db] migration failed: {e}", flush=True)

    # Restore the session from stored tokens. Previously this re-POSTed the
    # password to Tablo's cloud on every single boot; discovery is the only
    # call that needs it, and its tokens are what every later request uses.
    try:
        await _run_sync(state.load_config)
    except Exception as e:
        print(f"[state] restore failed: {e}", flush=True)

    # Falling back to a full login covers a first run and a device list that was
    # never stored. Tablo issues no refresh token, so this is the only way back.
    if state.auth and not state.devices:
        try:
            creds = await _run_sync(store.load_credentials)
            if creds:
                print("[state] no stored device tokens - authenticating", flush=True)
                await state.login(*creds)
        except Exception as e:
            print(f"[state] login failed: {e}", flush=True)

    # A transcode marked RUNNING after a restart has no process behind it. Sweep
    # those to FAILED so they can be retried instead of wedging forever.
    try:
        orphans = recordings.cache.sweep_orphans()
        if orphans:
            print(f"[cache] swept {len(orphans)} interrupted transcode(s): {orphans}")
    except Exception as e:
        print(f"[cache] sweep failed: {e}")

    # Guide history can only be captured going forward, so this starts at boot
    # rather than waiting for the first interval.
    async def _fetch_guide():
        # strict=False: a sync that lost some of its fetches is still worth
        # storing. History is only capturable as it happens, `save_guide` only
        # appends, and guide_sync records the loss either way - so discarding a
        # partial run would trade a recoverable gap for a permanent one.
        return await state.get_grid_guide(
            max_airings=15000, concurrency=guide_sync.SYNC_CONCURRENCY, strict=False
        )

    guide_task = asyncio.create_task(
        guide_sync.run_forever(_fetch_guide, state.sync_series, state.prefetch_artwork)
    )

    # Abandoned live transcodes hold tuners, and the case they have to be swept
    # for is the one where no request is ever coming again to notice them.
    reap_task = asyncio.create_task(stream.reap_forever())

    # The device expires a watch session in 165 seconds unless it is refreshed,
    # and nothing here ever refreshed one - which is what killed a live session
    # at about three and a half minutes with a flood of 404s.
    keepalive_task = asyncio.create_task(stream.keepalive_forever())

    yield

    keepalive_task.cancel()
    reap_task.cancel()
    guide_task.cancel()
    # Before the HTTP client closes: each live stream holds a session on the
    # device whose token exists only in this process, so one not handed back
    # here is one nothing can ever release.
    await stream.release_all_sessions()
    # Before anything that can block: a live transcode holds a tuner on the
    # device, and one left running after this process goes keeps holding it.
    stream.shutdown_transcoders()
    await recordings.cache.shutdown()
    await state.http.aclose()

app = FastAPI(title="Tablo Web", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Explicitly include routers with the /api prefix
app.include_router(auth.router)
app.include_router(channels.router)
app.include_router(iptv.router)
app.include_router(recordings.router)
app.include_router(resume.router)
app.include_router(schedule.router)
app.include_router(search.router)
app.include_router(settings.router)
app.include_router(stream.router, prefix="/api")

@app.get("/api/health")
async def health():
    return {"ok": True}
