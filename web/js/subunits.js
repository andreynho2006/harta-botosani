// Lista oficială a subunităților ISU (introdusă din panoul Admin).
// Fișier: web/data/subunitati.json  { format, version, updatedAt, subunits: [...] }
// Când lista oficială are cel puțin o subunitate, ea înlocuiește punctele „pompieri” din OSM
// (care pot fi incomplete sau plasate greșit). Lista servește ca puncte de plecare pentru rutele de intervenție.

export const SUBUNITS_FORMAT = "harta-botosani-subunitati";
export const SUBUNITS_DRAFT_KEY = "hb.subunits.draft.v1";

export const SUBUNIT_TYPES = {
  inspectorat: "Inspectorat (sediu ISU)",
  detasament: "Detașament de pompieri",
  statie: "Stație de pompieri",
  sectie: "Secție de pompieri",
  garda: "Gardă de intervenție",
  punct: "Punct de lucru / SMURD",
  svsu: "SVSU / SPSU (voluntari / privat)",
  vecin: "Subunitate județ vecin",
};

const str = (v, max = 500) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Validează și normalizează o subunitate; întoarce null dacă lipsesc denumirea sau coordonatele. */
export function normalizeSubunit(raw = {}) {
  const lat = Number(raw.lat), lon = Number(raw.lon);
  const name = str(raw.name, 160);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const staff = raw.staff === "" || raw.staff == null ? null : Number(raw.staff);
  return {
    id: str(raw.id, 60) || `su-${Math.random().toString(36).slice(2, 10)}`,
    name,
    type: SUBUNIT_TYPES[raw.type] ? raw.type : "detasament",
    lat: +lat.toFixed(7),
    lon: +lon.toFixed(7),
    address: str(raw.address, 300),
    phone: str(raw.phone, 80),
    equipment: str(raw.equipment, 1000),
    staff: Number.isFinite(staff) && staff >= 0 ? Math.round(staff) : null,
    notes: str(raw.notes, 2000),
  };
}

export function normalizeSubunitsDoc(doc) {
  const list = Array.isArray(doc) ? doc : Array.isArray(doc?.subunits) ? doc.subunits : [];
  const seen = new Set();
  const subunits = [];
  for (const raw of list) {
    const s = normalizeSubunit(raw);
    if (!s) continue;
    while (seen.has(s.id)) s.id += "-1";
    seen.add(s.id);
    subunits.push(s);
  }
  return { format: SUBUNITS_FORMAT, version: 1, updatedAt: doc?.updatedAt || null, subunits };
}

export function subunitsToFC(subunits = []) {
  return {
    type: "FeatureCollection",
    features: subunits.map((s) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      properties: {
        cat: "pompieri", official: true, sid: s.id, name: s.name, type: s.type,
        typeLabel: SUBUNIT_TYPES[s.type] || "", addr: s.address, phone: s.phone,
        equipment: s.equipment, staff: s.staff, notes: s.notes,
      },
    })),
  };
}

/** Înlocuiește punctele OSM „pompieri” cu lista oficială (doar dacă lista are elemente). */
export function mergeSubunitsIntoPois(pois, subunits = []) {
  if (!subunits.length) return pois;
  return { ...pois, features: [...pois.features.filter((f) => f.properties?.cat !== "pompieri"), ...subunitsToFC(subunits).features] };
}

/** Transformă punctele OSM „pompieri” în subunități (punct de plecare pentru lista oficială). */
export function subunitsFromOsm(pois) {
  return (pois?.features || [])
    .filter((f) => f.properties?.cat === "pompieri" && !f.properties.official && f.geometry?.type === "Point")
    .map((f, i) => normalizeSubunit({
      id: `osm-${i + 1}`,
      name: f.properties.name || `Subunitate ISU ${i + 1}`,
      type: /deta/i.test(f.properties.name || "") ? "detasament" : /sec[tț]/i.test(f.properties.name || "") ? "sectie" : /gard/i.test(f.properties.name || "") ? "garda" : "detasament",
      lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
      address: f.properties.addr, phone: f.properties.phone,
      notes: "Preluat din OpenStreetMap – de verificat",
    }))
    .filter(Boolean);
}

/**
 * Citește coordonate scrise liber și întoarce variantele posibile [lon, lat]:
 *  - „47.7471, 26.6694” (Google Maps: lat, lon) sau invers
 *  - „47°44'49.6"N 26°40'09.8"E” (grade, minute, secunde)
 *  - Stereo 70 „X Y” (numere mari), ambele ordini
 * `fromStereo70(X, Y)` → [lon, lat]. Alegerea finală se face cu verificarea „în județ”.
 */
export function parseCoordinateCandidates(text, fromStereo70) {
  const s = String(text || "").trim();
  if (!s) return [];
  const dms = [...s.matchAll(/(\d+(?:[.,]\d+)?)\s*°\s*(?:(\d+(?:[.,]\d+)?)\s*['′’]\s*)?(?:(\d+(?:[.,]\d+)?)\s*(?:["″”]|''))?\s*([NSEVW])?/gi)];
  if (dms.length >= 2) {
    const val = (m) => {
      const v = Number(m[1].replace(",", ".")) + Number((m[2] || "0").replace(",", ".")) / 60 + Number((m[3] || "0").replace(",", ".")) / 3600;
      return /[SW]/i.test(m[4] || "") ? -v : v;
    };
    const a = val(dms[0]), b = val(dms[1]);
    const latFirst = !/[EVW]/i.test(dms[0][4] || "");
    return [latFirst ? [b, a] : [a, b]];
  }
  const nums = (s.match(/-?\d+(?:[.,]\d+)?/g) || []).map((n) => Number(n.replace(",", ".")));
  if (nums.length < 2 || !nums.slice(0, 2).every(Number.isFinite)) {
    // „47,7471 26,6694” cu virgulă zecimală și separator spațiu e acoperit mai sus; altfel nimic.
    return [];
  }
  const [a, b] = nums;
  if (Math.abs(a) > 1000 || Math.abs(b) > 1000) {
    return fromStereo70 ? [fromStereo70(a, b), fromStereo70(b, a)] : [];
  }
  return [[b, a], [a, b]];
}
