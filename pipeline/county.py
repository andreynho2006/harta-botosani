#!/usr/bin/env python3
"""Găsește conturul județului Botoșani și unitățile administrative (UAT) din el.

Intrare: limitele administrative exportate de osmium (GeoJSON Sequence).
Ieșire:
  - extract.geojson  : conturul județului + o zonă tampon, folosit la decuparea datelor OSM
  - admin.geojson    : județul și UAT-urile (municipii, orașe, comune), cu nume și nivel
"""
import json
import sys
import unicodedata
from collections import Counter

from shapely.geometry import shape, mapping
from shapely import make_valid

EXPECTED_UAT = 78  # Botoșani: 2 municipii, 5 orașe, 71 de comune
BUFFER_DEG = 0.03  # ~2-3 km în jurul județului, ca să se vadă și drumurile de la graniță


def norm(s):
    s = unicodedata.normalize("NFKD", s or "")
    return "".join(c for c in s if not unicodedata.combining(c)).lower()


def read_seq(path):
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip().lstrip("\x1e")
            if line:
                yield json.loads(line)


def level(props):
    try:
        return int(props.get("admin_level"))
    except (TypeError, ValueError):
        return None


def main(src, out_extract, out_admin):
    polys = []
    for feat in read_seq(src):
        p = feat.get("properties") or {}
        if p.get("boundary") != "administrative" or level(p) is None:
            continue
        g = feat.get("geometry")
        if not g or g["type"] not in ("Polygon", "MultiPolygon"):
            continue
        geom = make_valid(shape(g))
        if geom.is_empty:
            continue
        polys.append((p, geom))

    # Județul = cel mai mare poligon administrativ care are „Botoșani” în nume.
    candidates = [(p, g) for p, g in polys if "botosani" in norm(p.get("name"))]
    if not candidates:
        sys.exit("Nu am găsit conturul județului Botoșani în datele OSM.")
    county_props, county = max(candidates, key=lambda pg: pg[1].area)
    county_level = level(county_props)
    print(f"Județ: {county_props.get('name')} (admin_level={county_level}, osm={county_props.get('@id')})")

    # UAT-urile: nivelul administrativ sub județ care are cel mai apropiat număr de 78 de unități.
    inner = [(p, g) for p, g in polys
             if level(p) > county_level and county.contains(g.representative_point())]
    counts = Counter(level(p) for p, _ in inner)
    print("Unități găsite pe niveluri:", dict(sorted(counts.items())))
    if not counts:
        sys.exit("Nu am găsit UAT-urile din județ.")
    uat_level = min(counts, key=lambda lv: abs(counts[lv] - EXPECTED_UAT))
    uats = [(p, g) for p, g in inner if level(p) == uat_level]
    print(f"UAT-uri: {len(uats)} pe admin_level={uat_level}")

    def feat(p, g, kind, tol):
        g = g.simplify(tol, preserve_topology=True)
        return {
            "type": "Feature",
            "properties": {"name": p.get("name"), "kind": kind, "admin_level": level(p),
                            "siruta": p.get("ref:siruta"), "population": p.get("population")},
            "geometry": json.loads(json.dumps(mapping(g))),
        }

    admin = {"type": "FeatureCollection",
             "features": [feat(county_props, county, "judet", 0.0002)] +
                         [feat(p, g, "uat", 0.0002) for p, g in sorted(uats, key=lambda pg: norm(pg[0].get("name")))]}
    with open(out_admin, "w", encoding="utf-8") as f:
        json.dump(admin, f, ensure_ascii=False)

    area = county.buffer(BUFFER_DEG).simplify(0.002)
    with open(out_extract, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {}, "geometry": mapping(area)}]}, f)


if __name__ == "__main__":
    main(*sys.argv[1:4])
