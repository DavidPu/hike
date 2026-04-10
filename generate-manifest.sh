#!/usr/bin/env bash
# Generates gpx-manifest.json from all .gpx files in the gpx/ directory.
# Run this after adding/removing GPX files.

set -euo pipefail
cd "$(dirname "$0")"

{
  echo "["
  first=true
  for f in gpx/*.gpx; do
    [ -f "$f" ] || continue
    name=$(basename "$f" .gpx | sed 's/_/ /g')
    if [ "$first" = true ]; then
      first=false
    else
      echo ","
    fi
    printf '  {"name": "%s", "path": "%s"}' "$name" "$f"
  done
  echo ""
  echo "]"
} > gpx-manifest.json

echo "Updated gpx-manifest.json with $(grep -c '"path"' gpx-manifest.json) track(s)"
