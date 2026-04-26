#!/bin/bash
DEST="$HOME/.openclaw/workspace/YardiGo/screenshots_resized"
mkdir -p "$DEST"

for i in 1 2 3 4 5 6 7 8 9; do
  SRC="$HOME/Desktop/$i.png"
  if [ -f "$SRC" ]; then
    sips -z 2778 1284 "$SRC" --out "$DEST/$i.png"
    echo "✅ Resized $i.png → 1284×2778"
  else
    echo "⚠️  Niet gevonden: $i.png"
  fi
done

echo ""
echo "✅ Klaar! Resized bestanden staan in:"
echo "$DEST"
echo ""
read -p "Druk Enter om te sluiten..."
