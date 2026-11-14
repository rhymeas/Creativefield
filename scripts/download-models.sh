#!/usr/bin/env bash
# Downloads the model files for one pipeline provider into ComfyUI's models folders.
# Each file is fetched to *.part, resumed if interrupted, and renamed only when complete.
# Usage: scripts/download-models.sh pipelines/i2v/wan22-ti2v-5b/models.txt
# models.txt lines:  <models subfolder> <url>
set -euo pipefail

COMFY_HOME="${COMFY_HOME:?set COMFY_HOME to your ComfyUI_windows_portable folder}"
MODELS="$COMFY_HOME/ComfyUI/models"
LIST="${1:?usage: download-models.sh <models.txt>}"

# A list saved with Windows line endings leaves a carriage return on every line; drop it.
while read -r dir url; do
  [[ -z "${dir:-}" || "$dir" == \#* ]] && continue
  url="$(printf '%s' "$url" | tr -d '\r')"
  name="$(basename "$url")"
  dest="$MODELS/$dir/$name"
  mkdir -p "$MODELS/$dir"
  if [[ -f "$dest" ]]; then
    echo "have  $dir/$name"
    continue
  fi
  echo "fetch $dir/$name"
  curl -L --fail --retry 5 --retry-delay 5 -C - --progress-bar -o "$dest.part" "$url"
  mv "$dest.part" "$dest"
  echo "done  $dir/$name ($(du -h "$dest" | cut -f1))"
done < "$LIST"
echo "all files present"
