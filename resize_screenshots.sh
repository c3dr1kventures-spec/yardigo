#!/bin/bash
# Resize App Store screenshots to 1284x2778px (iPhone 6.5" required format)
DEST="$HOME/.openclaw/workspace/YardiGo/screenshots_resized"
mkdir -p "$DEST"

for i in 1 2 3 4 5 6 7 8 9; do
  SRC="$HOME/Desktop/$i.png"
  if [ -f "$SRC" ]; then
    sips -z 2778 1284 "$SRC" --out "$DEST/$i.png"
    echo "Resized $i.png"
  else
    echo "Not found: $i.png"
  fi
done

echo "Done! Resized files in: $DEST"
