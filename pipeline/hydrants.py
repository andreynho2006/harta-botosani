#!/usr/bin/env python3
"""Transformă lista de hidranți (CSV, Excel, GeoJSON sau KML) în GeoJSON pentru aplicație.

Coordonatele pot fi în WGS84 (latitudine/longitudine, grade zecimale) sau în Stereo 70
(EPSG:3844, X = nord, Y = est, în metri). Ordinea X/Y se detectează automat: e aleasă
varianta care pune hidranții în interiorul județului.

Toate coloanele din fișierul original sunt păstrate și apar în aplicație la clic pe hidrant.
"""
import csv
import glob
import io
import json
import os
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET

from shapely.geometry import shape, Point

STEREO70 = ("+proj=sterea +lat_0=46 +lon_0=25 +k=0.99975 +x_0=500000 +y_0=500000 +ellps=krass "
            "+towgs84=2.329,-147.042,-92.08,-0.309,0.325,0.497,5.69 +units=m +no_defs")


def norm(s):
    s = unicodedata.normalize("NFKD", str(s or ""))
    return re.sub(r"[^a-z0-9]", "", "".join(c for c in s if not unicodedata.combining(c)).lower())


def num(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(" ", "")
    if s.count(",") == 1 and s.count(".") == 0:
        s = s.replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def read_rows(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".csv", ".txt"):
        raw = open(path, "rb").read()
        for enc in ("utf-8-sig", "cp1250", "latin-1"):
            try:
                text = raw.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        dialect = csv.Sniffer().sniff(text[:5000], delimiters=",;\t|")
        return list(csv.DictReader(io.StringIO(text), dialect=dialect)), None
    if ext in (".xlsx", ".xlsm"):
        import openpyxl
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        rows = []
        for ws in wb.worksheets:
            it = ws.iter_rows(values_only=True)
            header = None
            for r in it:
                if header is None:
                    if sum(1 for c in r if c not in (None, "")) >= 2:
                        header = [str(c).strip() if c is not None else f"col{i}" for i, c in enumerate(r)]
                    continue
                if any(c not in (None, "") for c in r):
                    rows.append({header[i]: c for i, c in enumerate(r) if i < len(header)})
        return rows, None
    if ext in (".geojson", ".json"):
        fc = json.load(open(path, encoding="utf-8"))
        feats = fc["features"] if "features" in fc else [fc]
        return [f.get("properties") or {} for f in feats], [f.get("geometry") for f in feats]
    if ext == ".kml":
        ns = {"k": "http://www.opengis.net/kml/2.2"}
        root = ET.parse(path).getroot()
        rows, geoms = [], []
        for pm in root.iter("{http://www.opengis.net/kml/2.2}Placemark"):
            props = {"nume": (pm.findtext("k:name", default="", namespaces=ns) or "").strip()}
            desc = pm.findtext("k:description", default="", namespaces=ns)
            if desc:
                props["descriere"] = re.sub(r"<[^>]+>", " ", desc).strip()
            for d in pm.iter("{http://www.opengis.net/kml/2.2}Data"):
                props[d.get("name")] = d.findtext("k:value", default="", namespaces=ns)
            for d in pm.iter("{http://www.opengis.net/kml/2.2}SimpleData"):
                props[d.get("name")] = d.text
            coords = pm.findtext(".//k:coordinates", default="", namespaces=ns).split()
            if coords:
                lon, lat = map(float, coords[0].split(",")[:2])
                geoms.append({"type": "Point", "coordinates": [lon, lat]})
                rows.append(props)
        return rows, geoms
    print(f"  ignor {path}: format necunoscut")
    return [], None


LAT_NAMES = {"lat", "latitudine", "latitude", "lat_wgs84", "latwgs84", "n"}
LON_NAMES = {"lon", "lng", "long", "longitudine", "longitude", "lon_wgs84", "lonwgs84", "e"}
X_NAMES = {"x", "xstereo", "xstereo70", "stereo70x", "coordx", "coordonatax", "nord", "northing"}
Y_NAMES = {"y", "ystereo", "ystereo70", "stereo70y", "coordy", "coordonatay", "est", "easting"}


def find_col(rows, names):
    for k in rows[0].keys():
        if norm(k) in names:
            return k
    return None


def main(src_dir, out_path, admin_path):
    county = None
    if os.path.exists(admin_path):
        for f in json.load(open(admin_path, encoding="utf-8"))["features"]:
            if f["properties"]["kind"] == "judet":
                county = shape(f["geometry"]).buffer(0.05)
    uats = []
    if os.path.exists(admin_path):
        uats = [(f["properties"]["name"], shape(f["geometry"]))
                for f in json.load(open(admin_path, encoding="utf-8"))["features"] if f["properties"]["kind"] == "uat"]

    files = sorted(p for p in glob.glob(os.path.join(src_dir, "*")) if not os.path.basename(p).startswith(("README", ".")))
    features = []
    for path in files:
        rows, geoms = read_rows(path)
        if not rows:
            continue
        print(f"  {os.path.basename(path)}: {len(rows)} rânduri")
        points = []
        if geoms:
            points = [tuple(g["coordinates"][:2]) if g and g.get("type") == "Point" else None for g in geoms]
        else:
            lat_c, lon_c = find_col(rows, LAT_NAMES), find_col(rows, LON_NAMES)
            x_c, y_c = find_col(rows, X_NAMES), find_col(rows, Y_NAMES)
            if lat_c and lon_c:
                points = [(num(r[lon_c]), num(r[lat_c])) for r in rows]
            elif x_c and y_c:
                xs = [(num(r[x_c]), num(r[y_c])) for r in rows]
                sample = [p for p in xs if p[0] and p[1]]
                if sample and max(abs(v) for p in sample for v in p) < 180:
                    # x/y în grade: x = longitudine
                    points = [(a, b) if a and b and a < b else (b, a) for a, b in xs]
                else:
                    from pyproj import Transformer
                    tr = Transformer.from_proj(STEREO70, "EPSG:4326", always_xy=True)

                    def convert(order):
                        res = []
                        for a, b in xs:
                            if a is None or b is None:
                                res.append(None)
                                continue
                            north, east = (a, b) if order == "xn" else (b, a)
                            lon, lat = tr.transform(east, north)
                            res.append((lon, lat))
                        return res

                    best = None
                    for order in ("xn", "yn"):
                        res = convert(order)
                        inside = sum(1 for p in res if p and county is not None and county.contains(Point(p)))
                        if best is None or inside > best[0]:
                            best = (inside, order, res)
                    print(f"  Stereo 70 detectat, X = {'nord' if best[1] == 'xn' else 'est'}; "
                          f"{best[0]}/{len(xs)} în județ")
                    points = best[2]
            else:
                print(f"  ATENȚIE: nu găsesc coloanele de coordonate în {path}. Coloane: {list(rows[0].keys())}")
                continue

        for row, p in zip(rows, points):
            if not p or p[0] is None or p[1] is None:
                continue
            props = {}
            for k, v in row.items():
                if k is None or v in (None, ""):
                    continue
                props[str(k).strip()] = v if isinstance(v, (int, float, str)) else str(v)
            pt = Point(p)
            if county is not None and not county.contains(pt):
                print(f"  ATENȚIE: hidrant în afara județului, ignorat: {props}")
                continue
            props["_uat"] = next((n for n, g in uats if g.contains(pt)), None)
            features.append({"type": "Feature", "id": len(features),
                             "properties": props,
                             "geometry": {"type": "Point", "coordinates": [round(p[0], 7), round(p[1], 7)]}})

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f, ensure_ascii=False)
    print(f"  {len(features)} hidranți scriși")


if __name__ == "__main__":
    main(*sys.argv[1:4])
