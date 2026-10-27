// Pure helpers for the "Hidrografie (cadastru)" layer: the info-sheet rows and the search rows of the ABA courses.
// No DOM and no map, so the tests can run them; main.js wires the results into the sheet and the search index.
import { distance } from "./geo.js";
import { norm } from "./search.js?v=20261026-hydro";

const nf1 = new Intl.NumberFormat("ro-RO", { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("ro-RO", { maximumFractionDigits: 0 });

/** "RO_XIII_1.15" → "XIII-1.15": the notation of the Romanian water cadastre atlas. */
export function cadastreCode(code) {
  return String(code ?? "").replace(/^RO_/, "").replace(/_/g, "-");
}

const indexes = new WeakMap();

/** Code → feature, built once per FeatureCollection object (a new collection gets a new index). */
export function courseIndex(fc) {
  if (!fc || typeof fc !== "object") return new Map();
  let index = indexes.get(fc);
  if (!index) {
    index = new Map((fc.features ?? []).map((f) => [f.properties.code, f]));
    indexes.set(fc, index);
  }
  return index;
}

// The cadastre writes the receiving river without diacritics; the Danube is the one parent no county course carries.
const KNOWN_PARENTS = { dunarea: "Dunărea" };
const labels = new WeakMap();

function nameLabels(fc) {
  let map = labels.get(fc);
  if (!map) {
    map = new Map();
    for (const f of fc.features ?? []) {
      for (const key of [norm(f.properties.name), norm(f.properties.aba)]) if (key && !map.has(key)) map.set(key, f.properties.name);
    }
    labels.set(fc, map);
  }
  return map;
}

/** Display name of the receiving river: the county course of that name (with diacritics), else the cadastre's spelling. */
export function parentLabel(parent, fc) {
  if (!parent) return "";
  const key = norm(parent);
  return (fc && typeof fc === "object" && nameLabels(fc).get(key)) || KNOWN_PARENTS[key] || parent;
}

const partsOf = (geometry) => (geometry?.type === "LineString" ? [geometry.coordinates] : geometry?.coordinates ?? []);

function partLength(part) {
  let metres = 0;
  for (let i = 1; i < part.length; i++) metres += distance(part[i - 1], part[i]);
  return metres;
}

/** Length of the course inside the clipped geometry, in km. */
export function lengthInCountyKm(geometry) {
  return partsOf(geometry).reduce((sum, part) => sum + partLength(part), 0) / 1000;
}

/** A point ON the line: halfway along the longest part (the middle of the bbox can fall off a bent river). */
export function courseAnchor(geometry) {
  let part = null, total = -1;
  for (const candidate of partsOf(geometry)) {
    const length = partLength(candidate);
    if (candidate.length && length > total) { part = candidate; total = length; }
  }
  if (!part) return null;
  let left = total / 2;
  for (let i = 1; i < part.length; i++) {
    const segment = distance(part[i - 1], part[i]);
    if (segment > 0 && left <= segment) {
      const t = left / segment;
      return [part[i - 1][0] + (part[i][0] - part[i - 1][0]) * t, part[i - 1][1] + (part[i][1] - part[i - 1][1]) * t];
    }
    left -= segment;
  }
  return part[part.length - 1];
}

/** [minLon, minLat, maxLon, maxLat] of the whole geometry, or null when it has no coordinates. */
export function courseBBox(geometry) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const part of partsOf(geometry)) {
    for (const [lon, lat] of part) {
      box[0] = Math.min(box[0], lon); box[1] = Math.min(box[1], lat);
      box[2] = Math.max(box[2], lon); box[3] = Math.max(box[3], lat);
    }
  }
  return box[0] === Infinity ? null : box;
}

// MapLibre hands array properties back as JSON text; a feature that went through it still reads right.
function listOf(value) {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return []; }
  }
  return Array.isArray(value) ? value : [];
}

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
// A course length of 0 in the cadastre means "not measured", not a course of no length.
const totalKm = (p) => (isNumber(p.lengthKm) && p.lengthKm > 0 ? p.lengthKm : null);

/** Rows [label, value] of the info sheet; empty values are left out. */
export function courseRows(feature, fc) {
  const p = feature.properties ?? {};
  const rows = [];
  const add = (label, value) => { if (value) rows.push([label, value]); };
  add("Cod cadastral", cadastreCode(p.code));
  add("Se varsă în", parentLabel(p.parent, fc));
  const total = totalKm(p);
  add("Lungime totală", total && `${nf1.format(total)} km`);
  // The drawn line runs longer than the cadastre's measured course (meanders, the 1 km kept past the county border),
  // so the county share is capped at the whole course.
  const inCounty = Math.min(lengthInCountyKm(feature.geometry), total ?? Infinity);
  add("Lungime în județ (aprox.)", inCounty > 0 && `≈ ${(inCounty < 10 ? nf1 : nf0).format(inCounty)} km`);
  add("Suprafața bazinului", isNumber(p.basinKm2) && `${nf1.format(p.basinKm2)} km²`);
  const alt = listOf(p.alt);
  add("Alte denumiri", alt.join(", "));
  const uats = listOf(p.uats).slice().sort((a, b) => a.localeCompare(b, "ro"));
  add("UAT-uri riverane", uats.length && `${uats.length}: ${uats.join(", ")}`);
  return rows;
}

/** One search row per course, in the tuple format of `SearchIndex.add`; an alternate name is found through the context. */
export function courseSearchRows(fc) {
  const rows = [];
  for (const f of fc?.features ?? []) {
    const p = f.properties;
    const anchor = courseAnchor(f.geometry);
    if (!anchor) continue;
    const parent = parentLabel(p.parent, fc);
    const alt = listOf(p.alt);
    const total = totalKm(p);
    const ctx = [parent && `afluent al ${parent}`, total && `${nf1.format(total)} km`, alt.length && `și ${alt.join(", ")}`]
      .filter(Boolean).join(" · ");
    rows.push([p.name, "cad", anchor[0], anchor[1], ctx, courseBBox(f.geometry), p.code]);
  }
  return rows;
}
