import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSubunit, normalizeSubunitsDoc, mergeSubunitsIntoPois, subunitsFromOsm, parseCoordinateCandidates, subunitsToFC, isNewerSubunitsDocument,
} from "../web/js/subunits.js";

test("normalizeSubunit requires name and valid coordinates", () => {
  assert.equal(normalizeSubunit({ name: "", lat: 47.7, lon: 26.6 }), null);
  assert.equal(normalizeSubunit({ name: "X", lat: "abc", lon: 26.6 }), null);
  const s = normalizeSubunit({ name: "  Detașament   Dorohoi ", lat: "47.95", lon: 26.4, type: "bogus", staff: "12" });
  assert.equal(s.name, "Detașament Dorohoi");
  assert.equal(s.type, "detasament");
  assert.equal(s.staff, 12);
});

test("normalizeSubunitsDoc dedupes ids and drops invalid rows", () => {
  const doc = normalizeSubunitsDoc({ subunits: [
    { id: "a", name: "A", lat: 47.7, lon: 26.6 }, { id: "a", name: "B", lat: 47.8, lon: 26.7 }, { name: "bad" },
  ] });
  assert.equal(doc.subunits.length, 2);
  assert.notEqual(doc.subunits[0].id, doc.subunits[1].id);
});

test("official list replaces OSM fire stations only when non-empty", () => {
  const pois = { type: "FeatureCollection", features: [
    { type: "Feature", geometry: { type: "Point", coordinates: [26.6, 47.7] }, properties: { cat: "pompieri", name: "OSM" } },
    { type: "Feature", geometry: { type: "Point", coordinates: [26.6, 47.7] }, properties: { cat: "spital" } },
  ] };
  assert.equal(mergeSubunitsIntoPois(pois, []), pois);
  const s = normalizeSubunit({ name: "Oficial", lat: 47.75, lon: 26.66 });
  const merged = mergeSubunitsIntoPois(pois, [s]);
  const fire = merged.features.filter((f) => f.properties.cat === "pompieri");
  assert.equal(fire.length, 1);
  assert.equal(fire[0].properties.official, true);
  assert.equal(merged.features.length, 2);
  assert.equal(subunitsFromOsm(pois).length, 1);
  assert.deepEqual(subunitsToFC([s]).features[0].geometry.coordinates, [26.66, 47.75]);
});

test("parseCoordinateCandidates reads decimal, DMS and Stereo 70", () => {
  assert.deepEqual(parseCoordinateCandidates("47.7471, 26.6694")[0], [26.6694, 47.7471]);
  assert.deepEqual(parseCoordinateCandidates("47,7471 26,6694")[0], [26.6694, 47.7471]);
  const [dms] = parseCoordinateCandidates(`47°44'49.6"N 26°40'09.8"E`);
  assert.ok(Math.abs(dms[1] - 47.74711) < 1e-4 && Math.abs(dms[0] - 26.66939) < 1e-4);
  const calls = [];
  const fake = (x, y) => { calls.push([x, y]); return [26, 47]; };
  assert.equal(parseCoordinateCandidates("700000 650000", fake).length, 2);
  assert.deepEqual(calls, [[700000, 650000], [650000, 700000]]);
  assert.deepEqual(parseCoordinateCandidates("nimic"), []);
});

test('confirmed published coordinates are not overwritten by stale cloud or browser copies', () => {
  const published = { updatedAt: '2026-10-18T14:00:00Z', subunits: [{ id: 'confirmed' }] };
  assert.equal(isNewerSubunitsDocument({ updatedAt: '2026-10-17T14:00:00Z', subunits: [{ id: 'old' }] }, published), false);
  assert.equal(isNewerSubunitsDocument({ subunits: [{ id: 'undated' }] }, published), false);
  assert.equal(isNewerSubunitsDocument({ updatedAt: '2026-10-18T15:00:00Z', subunits: [{ id: 'new-edit' }] }, published), true);
  assert.equal(isNewerSubunitsDocument({ updatedAt: '2026-10-18T15:00:00Z', subunits: [] }, published), true);
  assert.equal(isNewerSubunitsDocument({ subunits: [{ id: 'initial' }] }, { subunits: [] }), true);
});
