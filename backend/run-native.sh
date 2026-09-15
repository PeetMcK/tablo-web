#!/usr/bin/env bash
# Run the backend on macOS with hardware H.264 encoding.
#
# Requires ffmpeg with VideoToolbox:  brew install ffmpeg
set -euo pipefail
cd "$(dirname "$0")"

SUPPORT="$HOME/Library/Application Support/tablo-web"
CACHE="$HOME/Library/Caches/tablo-web/recordings"
mkdir -p "$SUPPORT" "$CACHE"

if ! command -v ffmpeg >/dev/null; then
  echo "ffmpeg not found. Install it with: brew install ffmpeg" >&2
  exit 1
fi

if ! ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_videotoolbox; then
  echo "This ffmpeg has no h264_videotoolbox encoder." >&2
  exit 1
fi

export TRANSCODE_VIDEO_ENCODER="${TRANSCODE_VIDEO_ENCODER:-h264_videotoolbox}"
# The Media Engine is fixed-function; extra parallel jobs mostly add contention.
export TRANSCODE_CONCURRENCY="${TRANSCODE_CONCURRENCY:-2}"
export TABLO_CONFIG_PATH="${TABLO_CONFIG_PATH:-$SUPPORT/config.json}"
export TRANSCODE_CACHE_DIR="${TRANSCODE_CACHE_DIR:-$CACHE}"
export TRANSCODE_CACHE_GB="${TRANSCODE_CACHE_GB:-250}"

echo "encoder : $TRANSCODE_VIDEO_ENCODER"
echo "config  : $TABLO_CONFIG_PATH"
echo "cache   : $TRANSCODE_CACHE_DIR"

# 127.0.0.1 only: the app has no authentication, and a host process is not
# confined by the container network the way the containerized backend is.
exec uvicorn app.main:app --host 127.0.0.1 --port 8000
