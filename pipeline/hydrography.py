#!/usr/bin/env python3
"""Transformă hidrografia cadastrală ABA Prut-Bârlad într-un GeoJSON pentru Administrare.

Folosire:
  hydrography.py HidrografieABAPB.kmz admin.geojson search.json hidrografie-botosani.geojson

Intrare:
  HidrografieABAPB.kmz  cadastrul apelor (KMZ cu un singur doc.kml, sau un KML simplu)
  admin.geojson         din county.py (județul și UAT-urile)
  search.json           din process.py (numele apelor și ale localităților din OSM)
Ieșire:
  un FeatureCollection `harta-botosani-hydrography` cu un feature pe cod ABA, tăiat la județ + 1 km

Licența datelor ABA nu e clară, iar depozitul și pagina sunt publice: ieșirea NU se comite și nu se
publică necriptată. Se încarcă în aplicație, la Administrare → Hidrografie, care o criptează
(hidrografie.enc, ca hidranții).
"""
import contextlib
import json
import math
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timezone
from html import unescape

from shapely import STRtree, make_valid, prepare
from shapely.affinity import affine_transform
from shapely.geometry import MultiLineString, shape
from shapely.ops import unary_union

# Proiecție locală în metri (echirectangulară la lat. 47,75), suficientă pentru lungimi și praguri.
KX = math.cos(math.radians(47.75)) * 111320  # metri pe grad de longitudine
KY = 110574  # metri pe grad de latitudine

MARGIN_M = 1000  # cât se păstrează din cursuri dincolo de conturul județului
SIMPLIFY_M = 10  # toleranța de simplificare
MIN_UAT_M = 200  # cât trebuie să treacă albia printr-un UAT ca să-l numărăm
FORMAT = "harta-botosani-hydrography"
SOURCE = "ABA Prut-Bârlad – cadastrul apelor"
ATTRS = ("Nume", "COD_ROMAN", "NumeObiect", "ORDIN", "L_CURS", "SBazin_km2")

RO_ALPHABET = "aăâbcdefghiîjklmnopqrsștțuvwxyz"
SMALL_WORDS = {"lui", "de", "din", "la", "cel", "cea", "cu"}
CELLS = re.compile(r"<td>([^<]*)</td>\s*<td>([^<]*)</td>")


# ---------------------------------------------------------------- nume

def fold(s):
    """Cheia de comparare a numelor: fără diacritice, litere mici, „-” ca spațiu, spații unice."""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return " ".join(s.replace("-", " ").split())


def title_case(s):
    words = []
    for i, word in enumerate(s.lower().split()):
        if i and word in SMALL_WORDS:
            words.append(word)
        else:
            words.append("-".join(p[:1].upper() + p[1:] for p in word.split("-")))
    return " ".join(words)


def letters(s):
    return re.findall(r"[^\W\d_]", s)


def split_name(raw):
    """„SITNA (SIHNA)” → („SITNA”, [„SIHNA”], „”).

    Ce e în paranteze și are cel puțin două litere sunt nume alternative. Restul („(1)”, „(B)”) și
    cifrele lipite de nume („CORNESTI1”) deosebesc omonimele: rămân ca sufix al numelui.
    """
    alts, suffix = [], ""
    for group in re.findall(r"\(([^()]*)\)", raw):
        for part in re.split(r"[,;]", group):
            part = part.strip()
            if len(letters(part)) >= 2:
                alts.append(part)
            elif part:
                suffix += f" ({part})"
    base = re.sub(r"\([^()]*\)", " ", raw).replace("(", " ").replace(")", " ")
    base = " ".join(base.split()) or raw.strip()
    m = re.fullmatch(r"(.*[^\W\d_])(\d+)", base)
    if m:
        base, suffix = m.group(1), f" {m.group(2)}" + suffix
    return base, alts, suffix


class Names:
    """Numele de afișat: întâi o apă din OSM, apoi un UAT sau o localitate, altfel numele ABA."""

    def __init__(self, search, uat_names):
        self.waters, self.places = {}, {}
        for row in search:
            if not (isinstance(row, list) and len(row) > 1 and isinstance(row[0], str)):
                continue
            if str(row[1]).startswith("apa:"):
                self.waters.setdefault(fold(row[0]), row[0])
            elif str(row[1]).startswith("loc:"):
                self.places.setdefault(fold(row[0]), row[0])
        for name in uat_names:
            self.places.setdefault(fold(name), name)
        self.unmatched = set()  # numele ABA rămase fără corespondent

    def display(self, s):
        key = fold(s)
        found = self.waters.get(key) or self.places.get(key)
        if found:
            return found
        self.unmatched.add(key)
        return title_case(s)

    def label(self, raw):
        """Numele de afișat (cu sufixul omonimelor), același fără sufix și numele alternative."""
        base, alts, suffix = split_name(raw)
        shown = self.display(base)
        return shown + suffix, shown, [self.display(a) for a in alts]


def ro_key(s):
    """Cheie de sortare ca `localeCompare('ro')`: ă, â, î, ș, ț vin după litera de bază."""
    s = s.translate(str.maketrans("şŞţŢ", "șȘțȚ"))
    primary = [(1, RO_ALPHABET.index(c)) if c in RO_ALPHABET else (0, ord(c)) for c in s.lower()]
    return primary, [c.isupper() for c in s]


def code_key(code):
    """Ordine naturală: RO_XIII_1.2 înainte de RO_XIII_1.10, emisarul înaintea afluenților."""
    return [(1, int(t)) if t.isdigit() else (0, t) for t in re.findall(r"\d+|\D+", code)]


def to_number(v):
    try:
        n = float(str(v).replace(",", "."))
    except ValueError:
        return None
    return int(n) if n == int(n) else n


# ---------------------------------------------------------------- citire KML

def local(tag):
    return tag.rsplit("}", 1)[-1]


@contextlib.contextmanager
def open_kml(path):
    """Deschide KML-ul direct din KMZ (nu extrage nimic pe disc) sau un KML simplu."""
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            kmls = [n for n in archive.namelist() if n.lower().endswith(".kml")]
            if len(kmls) != 1:
                raise ValueError(f"KMZ-ul trebuie să aibă un singur KML, are {len(kmls)}")
            with archive.open(kmls[0]) as f:
                yield f
    else:
        with open(path, "rb") as f:
            yield f


def parse_coordinates(text):
    points = []
    for token in text.split():
        parts = token.split(",")
        try:
            points.append((float(parts[0]), float(parts[1])))
        except (ValueError, IndexError):
            continue
    return points


def read_placemarks(path):
    """Produce (atribute, linii) pentru fiecare Placemark; eliberează elementele pe măsură ce le citește."""
    with open_kml(path) as source:
        for _, el in ET.iterparse(source):
            if local(el.tag) != "Placemark":
                continue
            attrs, lines, title = {}, [], ""
            for sub in el.iter():
                tag = local(sub.tag)
                if tag == "name" and not title:
                    title = (sub.text or "").strip()
                elif tag == "description":
                    for key, value in CELLS.findall(sub.text or ""):
                        if key.strip() in ATTRS:
                            attrs[key.strip()] = unescape(value).strip()
                elif tag == "coordinates":
                    points = parse_coordinates(sub.text or "")
                    if len(points) > 1:
                        lines.append(points)
            attrs.setdefault("Nume", title)
            el.clear()
            yield attrs, lines


# ---------------------------------------------------------------- geometrie

def project(geom):
    return affine_transform(geom, [KX, 0, 0, KY, 0, 0])


def unproject(geom):
    return affine_transform(geom, [1 / KX, 0, 0, 1 / KY, 0, 0])


def valid(geom):
    return geom if geom.is_valid else make_valid(geom)


def load_admin(path):
    """Conturul județului și UAT-urile, în metri."""
    with open(path, encoding="utf-8") as f:
        fc = json.load(f)
    county, uats = None, []
    for feat in fc["features"]:
        kind = feat["properties"].get("kind")
        if kind == "judet":
            county = valid(project(shape(feat["geometry"])))
        elif kind == "uat":
            uats.append((feat["properties"]["name"], valid(project(shape(feat["geometry"])))))
    if county is None or not uats:
        raise ValueError("admin.geojson nu are conturul județului și UAT-urile")
    return county, uats


def line_parts(geom):
    """Liniile dintr-un rezultat de intersecție; punctele rămase la atingeri se ignoră."""
    if geom.is_empty:
        return []
    if geom.geom_type == "LineString":
        return [geom]
    if hasattr(geom, "geoms"):
        return [p for g in geom.geoms for p in line_parts(g)]
    return []


def to_coordinates(line):
    """Linia simplificată la 10 m, în grade, cu 5 zecimale și fără puncte repetate."""
    out = []
    for x, y in unproject(line.simplify(SIMPLIFY_M, preserve_topology=True)).coords:
        point = [round(x, 5), round(y, 5)]
        if not out or point != out[-1]:
            out.append(point)
    return out if len(out) > 1 else None


def touched_uats(parts, uats, tree):
    """UAT-urile prin care albia trece pe cel puțin MIN_UAT_M, în ordinea alfabetică românească."""
    if not parts:
        return []
    line = unary_union(parts)  # fără dublarea tronsoanelor suprapuse
    names = [uats[i][0] for i in tree.query(line)
             if line.intersection(uats[i][1]).length >= MIN_UAT_M]
    return sorted(names, key=ro_key)


# ---------------------------------------------------------------- cursuri

def read_course(attrs, names):
    """Atributele ABA ale unui tronson, cu numele rezolvate."""
    name, base, alts = names.label(attrs["Nume"])
    parent = attrs.get("NumeObiect", "")
    return {
        "name": name, "base": base, "alts": alts, "aba": attrs["Nume"], "code": attrs["COD_ROMAN"],
        "parent": names.label(parent)[0] if parent else None,
        "order": to_number(attrs.get("ORDIN")),
        "length": to_number(attrs.get("L_CURS")),
        "basin": to_number(attrs.get("SBazin_km2")),
    }


def merge_courses(rows):
    """Un cod apare o singură dată: tronsonul cel mai lung dă numele, ceilalți îi dau nume alternative."""
    main = max(rows, key=lambda r: (r["length"] or 0, r["basin"] or 0))
    skip = {fold(main["name"]), fold(main["base"])}
    alt = []
    for row in [main] + [r for r in rows if r is not main]:
        for name in (row["alts"] if row is main else [row["name"]] + row["alts"]):
            if fold(name) not in skip:
                skip.add(fold(name))
                alt.append(name)
    return {
        "name": main["name"], "aba": main["aba"], "alt": alt, "code": main["code"],
        "parent": main["parent"], "order": main["order"],
        "lengthKm": max((r["length"] for r in rows if r["length"] is not None), default=None),
        "basinKm2": max((r["basin"] for r in rows if r["basin"] is not None), default=None),
    }


def build(source, admin_path, search_path, generated=None):
    """Întoarce (FeatureCollection, statistici) pentru KMZ-ul/KML-ul `source`."""
    county, uats = load_admin(admin_path)
    with open(search_path, encoding="utf-8") as f:
        names = Names(json.load(f), [n for n, _ in uats])
    zone = county.buffer(MARGIN_M)
    prepare(zone)
    tree = STRtree([g for _, g in uats])

    groups = {}
    stats = {"read": 0, "zone": 0, "no_code": 0}
    for attrs, lines in read_placemarks(source):
        stats["read"] += 1
        if not lines:
            continue
        line = MultiLineString([[(lon * KX, lat * KY) for lon, lat in pts] for pts in lines])
        if not line.intersects(zone):
            continue
        stats["zone"] += 1
        if not attrs.get("COD_ROMAN"):
            stats["no_code"] += 1
            continue
        group = groups.setdefault(attrs["COD_ROMAN"], {"rows": [], "cut": [], "inside": []})
        group["rows"].append(read_course(attrs, names))
        group["cut"] += line_parts(line.intersection(zone))
        group["inside"] += line_parts(line.intersection(county))

    features, touched = [], set()
    meters = {"county": 0, "zone": 0}
    stats["merged"] = {}
    for code in sorted(groups, key=code_key):
        group = groups[code]
        coordinates = []
        for part in group["cut"]:
            coords = to_coordinates(part)
            if coords and coords not in coordinates and coords[::-1] not in coordinates:
                coordinates.append(coords)
        if not coordinates:
            continue
        props = merge_courses(group["rows"])
        props["uats"] = touched_uats(group["inside"], uats, tree)
        touched.update(props["uats"])
        meters["county"] += unary_union(group["inside"]).length if group["inside"] else 0
        meters["zone"] += unary_union(group["cut"]).length
        if len(group["rows"]) > 1:
            stats["merged"][code] = [r["aba"] for r in group["rows"]]
        features.append({"type": "Feature", "properties": props,
                         "geometry": {"type": "MultiLineString", "coordinates": coordinates}})

    stats.update(courses=len(features), km=meters["county"] / 1000, km_zone=meters["zone"] / 1000,
                 uats=len(touched), uat_total=len(uats), unmatched=len(names.unmatched))
    fc = {"type": "FeatureCollection", "format": FORMAT, "version": 1, "source": SOURCE,
          "generated": generated or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
          "features": features}
    return fc, stats


def thousands(n):
    return f"{n:,.0f}".replace(",", ".")


def summary(stats):
    lines = [
        f"Tronsoane ABA citite: {stats['read']} (în județ + 1 km: {stats['zone']}, fără cod: {stats['no_code']})",
        f"Cursuri (coduri distincte): {stats['courses']}",
        f"Lungime: {thousands(stats['km'])} km în județ, {thousands(stats['km_zone'])} km cu marginea de 1 km",
        f"UAT-uri atinse (cel puțin {MIN_UAT_M} m): {stats['uats']} din {stats['uat_total']}",
        f"Nume fără corespondent în OSM sau în localități (rămân cele din ABA): {stats['unmatched']}",
    ]
    for code, abas in stats["merged"].items():
        lines.append(f"Cod unit: {code} ({len(abas)} tronsoane: {', '.join(abas)})")
    return "\n".join(lines)


def main(source, admin_path, search_path, out_path):
    try:
        fc, stats = build(source, admin_path, search_path)
    except ValueError as e:
        sys.exit(f"Eroare: {e}")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False, separators=(",", ":"))
    print(summary(stats))
    print(f"Scris: {out_path}")


if __name__ == "__main__":
    if len(sys.argv) != 5:
        sys.exit(__doc__)
    main(*sys.argv[1:5])
