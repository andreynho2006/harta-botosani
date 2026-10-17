// Original OSM numbers use tonnes/metres by default. Explicit units stay intact.
// https://wiki.openstreetmap.org/wiki/Key:maxweight
// https://wiki.openstreetmap.org/wiki/Key:maxheight
// https://wiki.openstreetmap.org/wiki/Key:maxwidth
// Legacy tiles discarded units, so their original unit cannot be recovered safely.
export function formatRestriction(properties, key, defaultUnit) {
  const raw = properties[key + "_raw"];
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    const value = String(raw).trim();
    return /^\d+(?:[.,]\d+)?$/.test(value) ? `${value} ${defaultUnit}` : value;
  }
  const legacy = properties[key];
  if (legacy === undefined || legacy === null || String(legacy).trim() === "") return null;
  return `${legacy} (unitate neverificată)`;
}
