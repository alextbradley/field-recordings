#!/usr/bin/env bash
# Converts original recordings (WAV, etc.) in originals/ to web-friendly MP3s in public/audio/,
# loudness-normalised so no recording is jarringly louder than another.
# Usage: ./scripts/encode.sh            encode everything in originals/ (git-ignored; keep the masters there)
#        ./scripts/encode.sh FILE...    encode just these files (paths relative to the project root)
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p public/audio
shopt -s nullglob nocaseglob
files=("$@")
[ ${#files[@]} -eq 0 ] && files=(originals/*.{wav,aif,aiff,flac,mp3,m4a})
for f in ${files[@]+"${files[@]}"}; do  # this form is safe on macOS bash 3.2 when the list is empty
  name="$(basename "${f%.*}" | tr '[:upper:] ' '[:lower:]-')"
  echo "→ public/audio/$name.mp3"
  ffmpeg -loglevel error -y -i "$f" -af loudnorm=I=-20:TP=-1.5 -ar 48000 -b:a 192k "public/audio/$name.mp3"
done
