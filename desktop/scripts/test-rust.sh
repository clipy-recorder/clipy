#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "test-rust.sh is macOS-only. See desktop/README.md for Linux and Windows test instructions." >&2
  exit 1
fi

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI_DIR="$DESKTOP_DIR/src-tauri"
FFMPEG_LIB_DIR="$TAURI_DIR/target/native-deps/Spacedrive.framework/Libraries"

if [ ! -d "$FFMPEG_LIB_DIR" ]; then
  (
    cd "$DESKTOP_DIR"
    pnpm run setup:native-deps
  )
fi

if [ ! -d "$FFMPEG_LIB_DIR" ]; then
  echo "Missing native FFmpeg libraries: $FFMPEG_LIB_DIR" >&2
  exit 1
fi

export DYLD_FALLBACK_LIBRARY_PATH="$FFMPEG_LIB_DIR${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"

cd "$TAURI_DIR"
cargo test "$@"
