#!/usr/bin/env bash
# Run the backend on macOS so it can use the Media Engine.
#
# The container cannot reach VideoToolbox: it is a macOS framework, and both
# Docker Desktop and Apple Container run Linux guests with no passthrough
# (tested - `ffmpeg -encoders | grep -c videotoolbox` returns 0 inside them, and
# there is no /dev/dri). Only a host process can encode in hardware.
#
#   docker compose -f docker-compose.yml -f docker-compose.native.yml up -d
#   backend/run-native.sh
#
# Measured against libx264 -preset veryfast on the same 60s window:
# CPU 47.4s -> 5.1s, output 30 MB -> 22 MB.
set -euo pipefail
cd "$(dirname "$0")"

# One data root, laid out exactly like the container's /data. Keeping the shape
# identical is what lets the two modes share a directory, and makes moving
# between them a plain copy.
#
# Application Support, not Caches: kept recordings are the user's offline copies
# and macOS is free to purge ~/Library/Caches under disk pressure, which would
# quietly delete the thing "keep offline" promised to preserve.
DATA="${TABLO_DATA_DIR:-$HOME/Library/Application Support/tablo-web}"
mkdir -p "$DATA/cache/recordings"

if ! command -v ffmpeg >/dev/null; then
  echo "ffmpeg not found. Install it with: brew install ffmpeg" >&2
  exit 1
fi

if ! ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_videotoolbox; then
  echo "This ffmpeg has no h264_videotoolbox encoder." >&2
  echo "Reinstall with: brew reinstall ffmpeg" >&2
  exit 1
fi

# A virtualenv beside the code, so this does not depend on what happens to be
# installed system-wide.
VENV="${TABLO_VENV:-.venv}"
if [ ! -x "$VENV/bin/python" ]; then
  echo "creating virtualenv at $VENV"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q --disable-pip-version-check -r requirements.txt
fi

export TRANSCODE_VIDEO_ENCODER="${TRANSCODE_VIDEO_ENCODER:-h264_videotoolbox}"
# Higher than the CPU default, because on hardware the bottleneck moves.
#
# Measured per 60s window: fetching and remuxing from the device alone takes
# 8.0s, and adding the VideoToolbox encode takes 7.5s - the encode is free. The
# limit is per-request latency waiting on the Tablo to produce segments, which
# overlapping streams hide. Aggregate throughput, same recording:
#
#     concurrency 1  ->  5.1x realtime
#     concurrency 2  ->  6.2x
#     concurrency 4  ->  8.4x
#     concurrency 6  ->  9.8x        <- knee
#     concurrency 10 -> 10.2x        <- device ceiling, per-window latency 51s
#
# Those figures predate deinterlacing, which halves per-stream throughput:
# a 1080i window went from ~3.2x realtime to 1.61x, so four streams give ~6.4x
# aggregate rather than the ~8.4x above. Six restores roughly 9.7x, back at the
# device ceiling, and costs ~2.3 of ten cores.
#
# Past ~6 the device is saturated and only per-window latency grows, which also
# slows an on-demand seek sharing the same device.
export TRANSCODE_CONCURRENCY="${TRANSCODE_CONCURRENCY:-6}"
export TABLO_CONFIG_PATH="${TABLO_CONFIG_PATH:-$DATA/config.json}"
export TABLO_DB_PATH="${TABLO_DB_PATH:-$DATA/tablo.db}"
export TABLO_SECRET_KEY_PATH="${TABLO_SECRET_KEY_PATH:-$DATA/.secret_key}"
export TRANSCODE_CACHE_DIR="${TRANSCODE_CACHE_DIR:-$DATA/cache/recordings}"
export TRANSCODE_CACHE_GB="${TRANSCODE_CACHE_GB:-250}"
# Lets the browser fetch large exports straight from here. nginx runs inside
# the Docker VM, so a proxied download crosses the virtual network twice:
# measured 583 MB/s direct against 117 MB/s through the proxy.
export PUBLIC_BACKEND_ORIGIN="${PUBLIC_BACKEND_ORIGIN:-http://127.0.0.1:8000}"

echo "encoder : $TRANSCODE_VIDEO_ENCODER (concurrency $TRANSCODE_CONCURRENCY)"
echo "ffmpeg  : $(ffmpeg -version 2>/dev/null | head -1)"
echo "data    : $DATA"

# 127.0.0.1 only: the app has no authentication, and a host process is not
# confined by the container network the way the containerized backend is.
exec "$VENV/bin/uvicorn" app.main:app --host 127.0.0.1 --port 8000
