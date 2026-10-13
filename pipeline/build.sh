#!/usr/bin/env bash
# Construiește harta județului Botoșani din datele OpenStreetMap.
# Rezultatul (tile-uri vectoriale + fișiere de date) ajunge în dist-data/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/work"
DIST="${DIST:-$ROOT/dist-data}"
PBF_URL="${PBF_URL:-https://download.geofabrik.de/europe/romania-latest.osm.pbf}"

mkdir -p "$WORK"
cd "$WORK"

if [ ! -s romania.osm.pbf ]; then
  echo "== Descarc datele OSM pentru România"
  curl -fL --retry 3 -o romania.osm.pbf "$PBF_URL"
fi

echo "== Limite administrative"
osmium tags-filter romania.osm.pbf r/boundary=administrative -o boundaries.osm.pbf --overwrite
osmium export boundaries.osm.pbf -f geojsonseq --geometry-types=polygon -o boundaries.geojsonseq --overwrite \
  -c "$ROOT/pipeline/osmium-export.json"
python3 "$ROOT/pipeline/county.py" boundaries.geojsonseq extract.geojson admin.geojson

echo "== Decupez județul (cu zonă tampon)"
osmium extract -p extract.geojson -s smart romania.osm.pbf -o botosani.osm.pbf --overwrite
osmium export botosani.osm.pbf -f geojsonseq -o botosani.geojsonseq --overwrite \
  -c "$ROOT/pipeline/osmium-export.json"

echo "== Împart pe straturi"
rm -rf layers out
python3 "$ROOT/pipeline/process.py" botosani.geojsonseq admin.geojson "$WORK"

echo "== Tile-uri vectoriale"
rm -rf "$DIST"
mkdir -p "$DIST"
LAYER_ARGS=()
for f in layers/*.geojsonseq; do
  name="$(basename "$f" .geojsonseq)"
  LAYER_ARGS+=(-L "$name:$f")
done
tippecanoe -e "$DIST/tiles" --force --no-tile-compression \
  -Z6 -z15 --no-tile-size-limit --no-feature-limit \
  --simplification=2 --no-tiny-polygon-reduction-at-maximum-zoom \
  --name="Botoșani" --attribution="© OpenStreetMap contributors" \
  "${LAYER_ARGS[@]}"

echo "== Date pentru aplicație"
mkdir -p "$DIST/data"
cp out/pois.geojson out/admin.geojson out/search.json out/stats.json "$DIST/data/"
du -sh "$DIST"
echo "Tile-uri: $(find "$DIST/tiles" -name '*.pbf' | wc -l)"
