#!/usr/bin/env bash
# Builds the tablo-mpeg2 variant of libav.js: MPEG-2 video + AC-3 audio out of
# MPEG-TS, deinterlaced with bwdif. No prebuilt libav.js variant carries that
# set — checked against configs/mkconfigs.js in 6.10.9.
#
# The Emscripten toolchain runs in a container rather than being installed on
# the host. The ffmpeg compile is long; 30-60 minutes is normal.
#
# Usage: tools/build-libav.sh [workdir]
set -euo pipefail

VERSION=6.10.9
FFMPEG_VERSION=9.0
VARIANT=tablo-mpeg2
IMAGE=emscripten/emsdk:latest

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${1:-${TMPDIR:-/tmp}/libav-build}"
OUT="$ROOT/frontend/public/wasm/libav"

FRAGMENTS='["avformat","avcodec","avfcbridge","avfilter","swresample","swscale",
"demuxer-mpegts","parser-mpegvideo","decoder-mpeg2video",
"parser-ac3","decoder-ac3",
"filter-bwdif","filter-yadif","filter-format","filter-aformat","filter-aresample",
"audio-filters","video-filters"]'

# libav.js optimises for size by default (-Oz). Deinterlacing is the hot loop in
# this pipeline and it is worth trading artifact size for speed.
OPTFLAGS="${OPTFLAGS:--O3}"

# ---------------------------------------------------------------- fetch
if [ ! -d "$WORK/src" ]; then
    mkdir -p "$WORK/pkg"
    cd "$WORK/pkg"
    npm pack "libav.js@$VERSION" >/dev/null
    tar xzf "libav.js-$VERSION.tgz"
    mkdir -p "$WORK/src"
    tar xJf package/sources/libav.js.tar.xz -C "$WORK/src"
    # The npm package ships the ffmpeg tarball, so the build needs no network.
    mkdir -p "$WORK/src/build"
    cp "package/sources/ffmpeg-$FFMPEG_VERSION.tar.xz" "$WORK/src/build/"
    cp package/sources/*.tar.* "$WORK/sources-lgpl-staging" 2>/dev/null || true
fi

# ---------------------------------------------------------------- configure
cd "$WORK/src/configs"
node ./mkconfig.js "$VARIANT" "$FRAGMENTS"
echo "--- ffmpeg configure flags for $VARIANT"
cat "configs/$VARIANT/ffmpeg-config.txt"

# ---------------------------------------------------------------- build
# Only the loader, the wasm build and the types: the asm.js and threaded
# variants cost most of the build time and nothing here uses them.
cd "$WORK/src"
docker run --rm \
    -v "$WORK/src:/src" \
    -u "$(id -u):$(id -g)" \
    -e HOME=/tmp \
    "$IMAGE" \
    bash -lc "cd /src && npm install --no-audit --no-fund && \
        make -j\$(nproc) OPTFLAGS=$OPTFLAGS \
            dist/libav-$VERSION.0-$VARIANT.js \
            dist/libav-$VERSION.0-$VARIANT.wasm.js \
            dist/libav-$VERSION.0-$VARIANT.mjs \
            dist/libav-$VERSION.0-$VARIANT.wasm.mjs \
            dist/libav.types.d.ts"

# ---------------------------------------------------------------- publish
mkdir -p "$OUT/sources"
cp "$WORK/src/dist/libav-$VERSION.0-$VARIANT".* "$OUT/"
cp "$WORK/src/dist/libav.types.d.ts" "$OUT/"
# LGPL: distributing the build obliges shipping the corresponding sources.
cp "$WORK/pkg/package/sources/ffmpeg-$FFMPEG_VERSION.tar.xz" \
   "$WORK/pkg/package/sources/libav.js.tar.xz" "$OUT/sources/"

ls -l "$OUT"
