#!/bin/bash
SRC="$HOME/.openclaw/workspace/YardiGo/screenshots_resized"
DEST="$HOME/Desktop/screenshots_resized"
mkdir -p "$DEST"

for i in 1 2 3 4 5 6 7 8 9; do
  cp "$SRC/$i.png" "$DEST/$i.png"
  echo "✅ Gekopieerd: $i.png"
done

echo ""
echo "✅ Klaar! Bestanden staan op het bureaublad in: screenshots_resized/"
read -p "Druk Enter om te sluiten..."
