// Calcule geografice: distanțe, Stereo 70, interpretarea coordonatelor introduse.
/* global proj4 */

const STEREO70 = "+proj=sterea +lat_0=46 +lon_0=25 +k=0.99975 +x_0=500000 +y_0=500000 +ellps=krass " +
  "+towgs84=2.329,-147.042,-92.08,-0.309,0.325,0.497,5.69 +units=m +no_defs";
const toS70 = proj4("EPSG:4326", STEREO70);

/** WGS84 → Stereo 70. Întoarce { X: nord, Y: est } (convenția românească). */
export function toStereo70(lon, lat) {
  const [e, n] = toS70.forward([lon, lat]);
  return { X: n, Y: e };
}

/** Stereo 70 (X = nord, Y = est) → [lon, lat] */
export function fromStereo70(X, Y) {
  return toS70.inverse([Y, X]);
}

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

export function distance(a, b) {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function bearing(a, b) {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const DIRS = ["N", "NE", "E", "SE", "S", "SV", "V", "NV"];
export const direction = (deg) => DIRS[Math.round(deg / 45) % 8];

export function circle(center, radius, steps = 96) {
  const coords = [];
  const lat = rad(center[1]);
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    const dx = radius * Math.cos(t);
    const dy = radius * Math.sin(t);
    coords.push([center[0] + (dx / (R * Math.cos(lat))) * (180 / Math.PI), center[1] + (dy / R) * (180 / Math.PI)]);
  }
  return { type: "Polygon", coordinates: [coords] };
}

// ------------------------------------------------------------- formatare

const nf0 = new Intl.NumberFormat("ro-RO", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("ro-RO", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

export function fmtDistance(m) {
  if (m < 1000) return `${nf0.format(Math.round(m / 5) * 5 || Math.round(m))} m`;
  return `${nf2.format(m / 1000)} km`;
}

export const fmtLatLon = (lon, lat) => `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

export function fmtStereo(lon, lat) {
  const { X, Y } = toStereo70(lon, lat);
  const g = (v) => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
  return { X: g(X), Y: g(Y), raw: `${Math.round(X)} ${Math.round(Y)}` };
}

export function fmtDMS(lon, lat) {
  const f = (v, pos, neg) => {
    const a = Math.abs(v);
    const d = Math.floor(a);
    const m = Math.floor((a - d) * 60);
    const s = ((a - d) * 60 - m) * 60;
    return `${d}°${String(m).padStart(2, "0")}′${s.toFixed(1).padStart(4, "0")}″${v >= 0 ? pos : neg}`;
  };
  return `${f(lat, "N", "S")} ${f(lon, "E", "V")}`;
}

// ------------------------------------------------------------- interpretarea coordonatelor

const inCounty = ([lon, lat]) => lon > 25.5 && lon < 27.9 && lat > 47.1 && lat < 48.6;

/**
 * Recunoaște coordonate scrise în căutare:
 *  - zecimale WGS84: „47.7412, 26.6631” sau „47,7412 26,6631” (lat/lon în orice ordine)
 *  - grade-minute-secunde: „47°44'28"N 26°39'47"E”
 *  - Stereo 70: „694000 624000” (X/Y în orice ordine)
 * Întoarce { lonlat, kind } sau null.
 */
export function parseCoordinates(q) {
  const s = q.trim();
  const dms = [...s.matchAll(/(\d{1,3})\s*[°º:\s]\s*(\d{1,2})\s*['′:\s]\s*(\d{1,2}(?:[.,]\d+)?)\s*(?:["″]|'')?\s*([NSEVW])?/gi)];
  if (dms.length === 2) {
    const v = dms.map((m) => {
      let d = +m[1] + +m[2] / 60 + +m[3].replace(",", ".") / 3600;
      if (m[4] && /[SVW]/i.test(m[4])) d = -d;
      return { d, h: (m[4] || "").toUpperCase() };
    });
    let lat = v[0].d, lon = v[1].d;
    if (v[0].h === "E" || v[1].h === "N" || (lat < 40 && lon > 40)) [lat, lon] = [lon, lat];
    if (inCounty([lon, lat])) return { lonlat: [lon, lat], kind: "WGS84" };
  }
  let nums;
  if (/^-?\d+(\.\d+)?\s*[,;\s]\s*-?\d+(\.\d+)?$/.test(s)) {
    nums = s.split(/\s*[,;\s]\s*/).map(Number);
  } else if (/^-?\d+(,\d+)?\s*[;\s]\s*-?\d+(,\d+)?$/.test(s)) {
    nums = s.split(/\s*[;\s]\s*/).map((x) => Number(x.replace(",", ".")));
  } else {
    return null;
  }
  const [a, b] = nums;
  if (Math.abs(a) < 90 && Math.abs(b) < 90) {
    for (const ll of [[b, a], [a, b]]) if (inCounty(ll)) return { lonlat: ll, kind: "WGS84" };
    return null;
  }
  if (a > 100000 && b > 100000 && a < 1000000 && b < 1000000) {
    for (const [X, Y] of [[a, b], [b, a]]) {
      const ll = fromStereo70(X, Y);
      if (inCounty(ll)) return { lonlat: ll, kind: "Stereo 70" };
    }
  }
  return null;
}

// ------------------------------------------------------------- punct în poligon (pentru UAT)

function ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polyContains(poly, x, y) {
  if (!ringContains(poly[0], x, y)) return false;
  for (let k = 1; k < poly.length; k++) if (ringContains(poly[k], x, y)) return false;
  return true;
}

export function makeUatLookup(fc) {
  const items = (fc?.features || [])
    .filter((f) => f.properties.kind === "uat")
    .map((f) => {
      const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
      let minx = 180, miny = 90, maxx = -180, maxy = -90;
      for (const p of polys) for (const [x, y] of p[0]) {
        if (x < minx) minx = x; if (y < miny) miny = y; if (x > maxx) maxx = x; if (y > maxy) maxy = y;
      }
      return { name: f.properties.name, polys, bbox: [minx, miny, maxx, maxy], feature: f };
    });
  return (lon, lat) => {
    for (const it of items) {
      const b = it.bbox;
      if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
      if (it.polys.some((p) => polyContains(p, lon, lat))) return it;
    }
    return null;
  };
}
