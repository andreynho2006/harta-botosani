#!/usr/bin/env python3
"""Împarte extrasul OSM al județului în straturi pentru hartă și construiește fișierele aplicației.

Intrare:
  botosani.geojsonseq  (osmium export)
  admin.geojson        (din county.py)
Ieșire în directorul de lucru:
  layers/*.geojsonseq  straturi pentru tippecanoe (fiecare obiect are minzoom propriu)
  out/pois.geojson     instituții și obiective (pompieri, poliție, școli, primării, baraje...)
  out/search.json      index de căutare (localități, străzi, adrese, obiective, ape)
  out/admin.geojson    UAT-uri, pentru „în ce comună sunt” și evidențiere
  out/stats.json       câte obiecte are fiecare categorie
"""
import json
import os
import sys
import unicodedata
from collections import defaultdict, Counter
from datetime import datetime, timezone

from shapely.geometry import shape, Point
from shapely import STRtree

RS = "\x1e"


def norm(s):
    s = unicodedata.normalize("NFKD", s or "")
    return "".join(c for c in s if not unicodedata.combining(c)).lower()


def read_seq(path):
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip().lstrip(RS)
            if line:
                yield json.loads(line)


def r6(x):
    return round(x, 6)


def to_int(v):
    try:
        return int(float(str(v).replace(",", ".").split()[0]))
    except (TypeError, ValueError, IndexError):
        return None


def clean(d):
    return {k: v for k, v in d.items() if v not in (None, "", False)}


# ---------------------------------------------------------------- UAT lookup

class AdminIndex:
    def __init__(self, path):
        with open(path, encoding="utf-8") as f:
            fc = json.load(f)
        self.county = None
        self.uats = []
        for feat in fc["features"]:
            g = shape(feat["geometry"])
            if feat["properties"]["kind"] == "judet":
                self.county = g
            else:
                self.uats.append((feat["properties"]["name"], g))
        self.tree = STRtree([g for _, g in self.uats])
        self.fc = fc

    def uat(self, pt):
        for i in self.tree.query(pt):
            name, g = self.uats[i]
            if g.contains(pt):
                return name
        return None

    def inside(self, pt):
        return self.county.contains(pt)


# ---------------------------------------------------------------- clasificări

HIGHWAY_BASE = {
    "motorway": "dn", "trunk": "dn", "primary": "dn", "secondary": "dj",
    "tertiary": "local", "unclassified": "local", "road": "local",
    "residential": "street", "living_street": "street", "pedestrian": "street",
    "service": "service", "track": "track",
}
ROAD_MINZOOM = {"dn": 6, "dj": 8, "dc": 10, "local": 11, "street": 12, "track": 12, "service": 14}


def road_class(t):
    hw = t.get("highway", "")
    base = hw[:-5] if hw.endswith("_link") else hw
    if base not in HIGHWAY_BASE:
        return None
    refs = [r.strip().upper().replace(" ", "") for r in (t.get("ref") or "").split(";") if r.strip()]
    if any(r.startswith("DN") or r.startswith("A") and r[1:2].isdigit() for r in refs):
        return "dn"
    if any(r.startswith("DJ") for r in refs):
        return "dj"
    if any(r.startswith("DC") for r in refs):
        return "dc"
    return HIGHWAY_BASE[base]


BUILDING_KIND = {
    "bloc": {"apartments", "dormitory"},
    "casa": {"house", "detached", "semidetached_house", "terrace", "residential", "bungalow", "farm"},
    "industrial": {"industrial", "warehouse", "factory", "manufacture", "hangar", "storage_tank", "silo"},
    "public": {"school", "kindergarten", "hospital", "public", "civic", "government", "townhall", "university",
               "college", "fire_station", "train_station", "transportation", "sports_hall", "clinic"},
    "cult": {"church", "chapel", "cathedral", "monastery", "mosque", "synagogue", "religious", "temple"},
    "comercial": {"commercial", "retail", "office", "supermarket", "hotel", "kiosk"},
    "anexa": {"barn", "farm_auxiliary", "shed", "garage", "garages", "stable", "cowshed", "greenhouse",
              "roof", "carport", "sty", "hut"},
}
BUILDING_LOOKUP = {v: k for k, vs in BUILDING_KIND.items() for v in vs}


def building_kind(t):
    b = t.get("building")
    kind = BUILDING_LOOKUP.get(b, "altele")
    if kind == "casa" and b == "residential" and (to_int(t.get("building:levels")) or 0) >= 4:
        kind = "bloc"
    if kind == "altele" and t.get("amenity") in ("school", "kindergarten", "hospital", "townhall", "fire_station", "police"):
        kind = "public"
    return kind


def landuse_class(t):
    lu, nat, lei = t.get("landuse"), t.get("natural"), t.get("leisure")
    if lu == "forest" or nat == "wood":
        return "forest", 8
    if lu in ("residential",):
        return "residential", 9
    if lu in ("industrial", "commercial", "retail", "quarry", "railway"):
        return "industrial", 11
    if lu == "military":
        return "military", 10
    if lu in ("cemetery",) or t.get("amenity") == "grave_yard":
        return "cemetery", 12
    if nat == "wetland":
        return "wetland", 10
    if lei in ("park", "garden") or lu in ("recreation_ground", "village_green"):
        return "park", 12
    if lei in ("pitch", "stadium", "sports_centre"):
        return "sport", 13
    if lu in ("orchard", "vineyard"):
        return "orchard", 11
    if lu in ("meadow", "grass") or nat in ("grassland", "scrub", "heath"):
        return "grass", 11
    return None, None


def water_area(t):
    if t.get("natural") == "water" or t.get("landuse") in ("reservoir", "basin") or t.get("waterway") == "riverbank":
        w = t.get("water") or ("reservoir" if t.get("landuse") == "reservoir" else None)
        kind = {"river": "rau", "reservoir": "acumulare", "pond": "iaz", "lake": "lac", "fishpond": "iaz",
                "basin": "bazin", "oxbow": "lac", "lagoon": "lac", "wastewater": "bazin"}.get(w, "lac")
        return kind
    return None


WATERWAY = {"river": ("rau", 6), "canal": ("canal", 10), "stream": ("parau", 10),
            "ditch": ("sant", 13), "drain": ("sant", 13), "dam": ("baraj", 11), "weir": ("stavila", 12)}

PLACE_MINZOOM = {"city": 6, "town": 7, "village": 9, "suburb": 11, "hamlet": 11,
                 "neighbourhood": 13, "quarter": 12, "isolated_dwelling": 14, "locality": 14}
PLACE_LABEL = {"city": "municipiu", "town": "oraș", "village": "sat", "suburb": "cartier", "hamlet": "cătun",
               "neighbourhood": "cartier", "quarter": "cartier", "isolated_dwelling": "locuință izolată",
               "locality": "loc"}


def poi_category(t):
    a, em, name = t.get("amenity"), t.get("emergency"), norm(t.get("name"))
    if a == "fire_station":
        return "pompieri"
    if a == "police" or (t.get("office") == "government" and ("jandarm" in name or "politia" in name)):
        if "jandarm" in name or t.get("police") == "gendarmerie":
            return "jandarmerie"
        if "frontier" in name or t.get("police") == "border":
            return "frontiera"
        return "politie"
    if em == "ambulance_station" or "ambulant" in name and a in ("clinic", "hospital", None):
        return "ambulanta"
    if a == "townhall" or (t.get("office") == "government" and name.startswith("primaria")):
        return "primarie"
    if a == "hospital":
        return "spital"
    if a in ("clinic", "doctors") or t.get("healthcare") in ("clinic", "centre"):
        return "medical"
    if a in ("school", "college", "university"):
        return "scoala"
    if a == "kindergarten":
        return "gradinita"
    if a == "fuel":
        return "carburant"
    if em == "fire_hydrant":
        return "hidrant_osm"
    if em in ("water_tank", "suction_point", "fire_water_pond") or a == "fire_water":
        return "sursa_apa"
    if t.get("waterway") in ("dam", "weir") or t.get("man_made") == "dam":
        return "baraj"
    return None


POI_DEDUPE_M = 120  # același nume și categorie la mai puțin de 120 m = același obiectiv


def address(t):
    street = t.get("addr:street") or t.get("addr:place")
    num = t.get("addr:housenumber")
    city = t.get("addr:city")
    parts = [" ".join(x for x in (street, num) if x), city]
    return ", ".join(p for p in parts if p) or None


# ---------------------------------------------------------------- main

def main(src, admin_path, workdir):
    admin = AdminIndex(admin_path)
    layers_dir = os.path.join(workdir, "layers")
    out_dir = os.path.join(workdir, "out")
    os.makedirs(layers_dir, exist_ok=True)
    os.makedirs(out_dir, exist_ok=True)

    writers = {}

    def emit(layer, geom, props, minzoom):
        if layer not in writers:
            writers[layer] = open(os.path.join(layers_dir, f"{layer}.geojsonseq"), "w", encoding="utf-8")
        writers[layer].write(json.dumps({
            "type": "Feature", "tippecanoe": {"minzoom": minzoom},
            "properties": clean(props), "geometry": geom}, ensure_ascii=False) + "\n")

    stats = Counter()
    pois = []
    streets = defaultdict(list)    # (nume, uat) -> [(lungime, lon, lat, bbox)]
    waters = defaultdict(list)
    addresses = {}
    places = []

    for feat in read_seq(src):
        t = feat.get("properties") or {}
        g = feat.get("geometry")
        if not g:
            continue
        gtype = g["type"]
        osm_id = t.pop("@id", None)
        osm_type = t.pop("@type", None)
        ref = f"{osm_type[0] if osm_type else ''}{osm_id}" if osm_id else None
        is_line = gtype in ("LineString", "MultiLineString")
        is_area = gtype in ("Polygon", "MultiPolygon")
        is_point = gtype == "Point"
        geom = None

        def shp():
            nonlocal geom
            if geom is None:
                geom = shape(g)
            return geom

        # --- obiective (pompieri, poliție, școli...) - din puncte și din contururi
        cat = poi_category(t)
        if cat and (is_point or is_area or (is_line and cat == "baraj")):
            s = shp()
            pt = s.representative_point() if is_area else (s.interpolate(0.5, normalized=True) if is_line else s)
            pois.append({"cat": cat, "pt": pt, "area": is_area, "props": clean({
                "name": t.get("name"), "operator": t.get("operator"), "addr": address(t),
                "phone": t.get("phone") or t.get("contact:phone"), "website": t.get("website"),
                "ref": t.get("ref"), "osm": ref, "height": t.get("height"),
            })})

        # --- drumuri
        if is_line and "highway" in t and t.get("area") != "yes":
            cls = road_class(t)
            if cls:
                props = {
                    "cls": cls, "ref": (t.get("ref") or "").replace(";", " / ") or None, "name": t.get("name"),
                    "bridge": 1 if t.get("bridge") not in (None, "no") else None,
                    "tunnel": 1 if t.get("tunnel") not in (None, "no") else None,
                    "oneway": 1 if t.get("oneway") in ("yes", "1", "true") else None,
                    # Preserve OSM values, including units and special values.
                    # Separate fields distinguish them from previously stripped values.
                    "maxweight_raw": t.get("maxweight"), "maxheight_raw": t.get("maxheight"),
                    "maxwidth_raw": t.get("maxwidth"), "surface": t.get("surface"),
                    "hw": t.get("highway"), "osm": ref,
                }
                emit("roads", g, props, ROAD_MINZOOM[cls])
                stats["drum_" + cls] += 1
                if t.get("name"):
                    s = shp()
                    mid = s.interpolate(0.5, normalized=True)
                    streets[(t["name"], admin.uat(mid))].append((s.length, mid.x, mid.y, s.bounds))
            continue

        # --- cale ferată
        if is_line and t.get("railway") in ("rail", "light_rail", "narrow_gauge"):
            if t.get("service") in ("yard", "siding", "spur"):
                emit("rail", g, {"name": t.get("name"), "service": 1}, 13)
            else:
                emit("rail", g, {"name": t.get("name")}, 8)
            continue

        # --- cursuri de apă și baraje (linii)
        if is_line and t.get("waterway") in WATERWAY:
            kind, mz = WATERWAY[t["waterway"]]
            if kind in ("rau", "parau") and t.get("intermittent") == "yes":
                mz = max(mz, 11)
            emit("waterways", g, {"kind": kind, "name": t.get("name"), "osm": ref,
                                  "intermittent": 1 if t.get("intermittent") == "yes" else None}, mz)
            stats["apa_" + kind] += 1
            if t.get("name") and kind in ("rau", "parau", "canal"):
                s = shp()
                mid = s.interpolate(0.5, normalized=True)
                waters[(t["name"], kind)].append((s.length, mid.x, mid.y, s.bounds))
            continue

        if is_area:
            # --- clădiri
            if t.get("building") and t.get("building") != "no":
                kind = building_kind(t)
                emit("buildings", g, {
                    "kind": kind, "b": t.get("building"), "levels": to_int(t.get("building:levels")),
                    "name": t.get("name"), "addr": address(t), "osm": ref,
                    "height": t.get("height"), "material": t.get("building:material"),
                    "roof": t.get("roof:material"),
                }, 13 if kind in ("bloc", "public", "industrial") else 14)
                stats["cladire_" + kind] += 1
                if t.get("addr:housenumber"):
                    pt = shp().representative_point()
                    addresses[(address(t), round(pt.x, 4), round(pt.y, 4))] = pt
                continue
            # --- ape (suprafețe)
            wk = water_area(t)
            if wk:
                s = shp()
                emit("water", g, {"kind": wk, "name": t.get("name"), "osm": ref,
                                  "area_ha": round(s.area * 111320 * 75000 / 10000, 1)}, 6)
                stats["apa_" + wk] += 1
                if t.get("name"):
                    pt = s.representative_point()
                    emit("water_labels", {"type": "Point", "coordinates": [r6(pt.x), r6(pt.y)]},
                         {"kind": wk, "name": t["name"]}, 10 if s.area > 2e-5 else 12)
                    waters[(t["name"], wk)].append((s.area * 1000, pt.x, pt.y, s.bounds))
                continue
            # --- folosința terenului
            lc, mz = landuse_class(t)
            if lc:
                emit("landuse", g, {"kind": lc}, mz)
                continue
            if t.get("waterway") in ("dam", "weir"):
                emit("waterways", g, {"kind": "baraj", "name": t.get("name"), "osm": ref}, 11)
                continue

        # --- localități
        if is_point and t.get("place") in PLACE_MINZOOM and t.get("name"):
            pt = shp()
            places.append({"name": t["name"], "kind": t["place"], "pt": pt,
                           "population": to_int(t.get("population")), "uat": admin.uat(pt)})
            emit("places", g, {"name": t["name"], "kind": t["place"],
                               "population": to_int(t.get("population"))}, PLACE_MINZOOM[t["place"]])
            stats["loc_" + t["place"]] += 1
            continue

        # --- adrese pe puncte
        if is_point and t.get("addr:housenumber"):
            pt = shp()
            addresses[(address(t), round(pt.x, 4), round(pt.y, 4))] = pt

    for w in writers.values():
        w.close()

    # ---------------------------------------------------- limite administrative ca linii
    with open(os.path.join(layers_dir, "boundaries.geojsonseq"), "w", encoding="utf-8") as f:
        for feat in admin.fc["features"]:
            p = feat["properties"]
            s = shape(feat["geometry"])
            rings = []
            for poly in getattr(s, "geoms", [s]):
                rings.append(list(poly.exterior.coords))
            f.write(json.dumps({
                "type": "Feature",
                "tippecanoe": {"minzoom": 6 if p["kind"] == "judet" else 9},
                "properties": {"kind": p["kind"], "name": p["name"]},
                "geometry": {"type": "MultiLineString", "coordinates": [[[r6(x), r6(y)] for x, y in r] for r in rings]},
            }, ensure_ascii=False) + "\n")

    # ---------------------------------------------------- obiective: deduplicare
    pois.sort(key=lambda p: not p["area"])  # contururile au prioritate (au de obicei mai multe date)
    kept = []
    grid = defaultdict(list)
    cell = 0.002
    for p in pois:
        key = (p["cat"], norm(p["props"].get("name")))
        gx, gy = int(p["pt"].x / cell), int(p["pt"].y / cell)
        dup = False
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for q in grid[(gx + dx, gy + dy)]:
                    if (q["cat"], norm(q["props"].get("name"))) == key and \
                            q["pt"].distance(p["pt"]) * 90000 < POI_DEDUPE_M:
                        dup = True
                        for k, v in p["props"].items():
                            q["props"].setdefault(k, v)
        if not dup:
            grid[(gx, gy)].append(p)
            kept.append(p)

    poi_features = []
    for i, p in enumerate(kept):
        pt = p["pt"]
        p["props"]["uat"] = admin.uat(pt)
        poi_features.append({"type": "Feature", "id": i,
                             "properties": {"cat": p["cat"], **p["props"]},
                             "geometry": {"type": "Point", "coordinates": [r6(pt.x), r6(pt.y)]}})
        stats["poi_" + p["cat"]] += 1
    with open(os.path.join(out_dir, "pois.geojson"), "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": poi_features}, f, ensure_ascii=False)

    # ---------------------------------------------------- index de căutare
    # format compact: [eticheta, tip, lon, lat, context, [minx,miny,maxx,maxy] sau null]
    search = []

    def bbox_union(items):
        return [r6(min(b[3][0] for b in items)), r6(min(b[3][1] for b in items)),
                r6(max(b[3][2] for b in items)), r6(max(b[3][3] for b in items))]

    for pl in places:
        kind = PLACE_LABEL.get(pl["kind"], pl["kind"])
        ctx = kind + (f", {pl['uat']}" if pl["uat"] and norm(pl["uat"]) != norm(pl["name"]) else "")
        search.append([pl["name"], "loc:" + pl["kind"], r6(pl["pt"].x), r6(pl["pt"].y), ctx, None])

    for (name, uat), segs in streets.items():
        best = max(segs, key=lambda s: s[0])
        search.append([name, "str", r6(best[1]), r6(best[2]), uat or "", bbox_union(segs)])

    for (name, kind), segs in waters.items():
        best = max(segs, key=lambda s: s[0])
        search.append([name, "apa:" + kind, r6(best[1]), r6(best[2]), "", bbox_union(segs)])

    for (label, _, _), pt in addresses.items():
        if label:
            search.append([label, "adr", r6(pt.x), r6(pt.y), admin.uat(pt) or "", None])

    for feat in poi_features:
        pr = feat["properties"]
        label = pr.get("name") or {"hidrant_osm": "Hidrant", "sursa_apa": "Sursă de apă", "baraj": "Baraj"}.get(pr["cat"])
        if label:
            search.append([label, "poi:" + pr["cat"], *feat["geometry"]["coordinates"], pr.get("uat") or "", None])

    with open(os.path.join(out_dir, "search.json"), "w", encoding="utf-8") as f:
        json.dump(search, f, ensure_ascii=False, separators=(",", ":"))

    with open(os.path.join(out_dir, "admin.geojson"), "w", encoding="utf-8") as f:
        json.dump(admin.fc, f, ensure_ascii=False, separators=(",", ":"))

    stats["cautare_intrari"] = len(search)
    with open(os.path.join(out_dir, "stats.json"), "w", encoding="utf-8") as f:
        json.dump({"generated": datetime.now(timezone.utc).isoformat(timespec="minutes"),
                   "counts": dict(sorted(stats.items()))}, f, ensure_ascii=False, indent=1)
    for k, v in sorted(stats.items()):
        print(f"{k:28s} {v}")


if __name__ == "__main__":
    main(*sys.argv[1:4])
