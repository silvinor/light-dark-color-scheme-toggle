#!/bin/sh
# Renders every icons/src/*.svg to icons/<name>-<size>.png at the sizes the
# extension uses. Needs rsvg-convert (brew install librsvg).
# Usage: ./build-icons.sh [output-dir]   (default: icons)
set -e
cd "$(dirname "$0")"
out="${1:-icons}"
for svg in icons/src/*.svg; do
  name=$(basename "$svg" .svg)
  for size in 16 24 32 48 128; do
    rsvg-convert -w "$size" -h "$size" "$svg" -o "$out/$name-$size.png"
  done
done
