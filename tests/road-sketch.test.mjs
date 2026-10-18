import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  snapToRoad,
  buildRoadSegment,
  findRoadRoute,
  findRoadByRef,
  sliceRoadByKm,
  sliceRoadByPlaces,
  projectPointOnRoad,
  roadNetworkToFeatures,
  lineLengthKm,
} from '../web/js/road-sketch.js';

const A = [26, 47], B = [26.01, 47], C = [26.01, 47.01];
const road = (coordinates, properties = { osm: 'w1', ref: 'DJ 208', name: 'Main Road', cls: 'dj' }) => ({
  type: 'Feature', properties, geometry: { type: 'LineString', coordinates },
});
const route = (start, end, roads) => buildRoadSegment(snapToRoad(start, roads), snapToRoad(end, roads), roads);
const close = (a, b, epsilon = 1e-7) => {
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < epsilon, `${a} != ${b}`);
};

test('snap projects to real geometry and reports distance in meters', () => {
  const roads = [road([A, B])];
  const hit = snapToRoad([26.005, 47.0005], roads);
  close(hit.coordinate, [26.005, 47]);
  assert.ok(hit.distance > 55 && hit.distance < 56);
  assert.deepEqual(hit.road, roads[0].properties);
  assert.equal(snapToRoad([26.005, 47.001], roads), null);
  assert.equal(snapToRoad([26.005, 47.0005], roads, 40), null);
});

test('same-edge selections split the graph at the selected points', () => {
  const result = route([26.002, 47], [26.008, 47], [road([A, B])]);
  assert.equal(result.type, 'LineString');
  assert.equal(result.coordinates.length, 2);
  close(result.coordinates[0], [26.002, 47]);
  close(result.coordinates[1], [26.008, 47]);
});

test('routes follow bends across matching refs and preserve the selected direction', () => {
  const roads = [road([A, B]), road([B, C], { osm: 'w2', ref: 'dj208', name: 'Other Label', cls: 'dj' })];
  const result = route([26.002, 47], [26.01, 47.008], roads);
  assert.equal(result.coordinates.length, 3);
  close(result.coordinates[1], B);
  const reverse = route([26.01, 47.008], [26.002, 47], roads);
  assert.deepEqual(reverse.coordinates.map((p) => p.map((v) => +v.toFixed(8))), result.coordinates.toReversed().map((p) => p.map((v) => +v.toFixed(8))));
});

test('normalized names connect without a ref and unnamed roads require a matching osm id', () => {
  const roads = [road([A, B], { osm: 'w1', name: 'Șoseaua  Mare' }), road([B, C], { osm: 'w2', name: 'soseaua mare' })];
  assert.ok(route(A, C, roads));
  const unnamed = [road([A, B], { osm: 'w8' }), road([B, C], { osm: 'w8' })];
  assert.ok(route(A, C, unnamed));
  assert.equal(route(A, C, [unnamed[0], road([B, C], { osm: 'w9' })]), null);
});

test('matching names cannot connect roads with conflicting or missing references', () => {
  const first = road([A, B], { osm: 'w1', ref: 'DJ208', name: 'Main Road' });
  for (const ref of ['DN29', '', null]) {
    const second = road([B, C], { osm: 'w2', ref, name: 'Main Road' });
    assert.equal(route(A, C, [first, second]), null);
    assert.equal(route(C, A, [first, second]), null);
  }
});

test('same-name bridges with a conflicting reference are excluded from the graph', () => {
  const roads = [
    road([A, [26.004, 47]], { osm: 'w1', ref: 'DJ208', name: 'Main Road' }),
    road([[26.004, 47], [26.006, 47]], { osm: 'w2', ref: 'DN29', name: 'Main Road' }),
    road([[26.006, 47], B], { osm: 'w3', ref: 'DJ208', name: 'Main Road' }),
  ];
  assert.equal(route([26.002, 47], [26.008, 47], roads), null);
});

test('same OSM identity takes precedence over missing or conflicting references', () => {
  for (const ref of ['DN29', null]) {
    const roads = [
      road([A, B], { osm: 'w1', ref: 'DJ208', name: 'First Name' }),
      road([B, C], { osm: 'w1', ref, name: 'Second Name' }),
    ];
    assert.ok(route(A, C, roads));
  }
});

test('a shared normalized reference in a multiple-reference value is sufficient', () => {
  const roads = [
    road([A, B], { osm: 'w1', ref: 'DJ 208; DC 12' }),
    road([B, C], { osm: 'w2', ref: 'dc12' }),
  ];
  assert.ok(route(A, C, roads));
});

test('clipped overlapping tile fragments connect and reversed duplicates do not alter the route', () => {
  const roads = [road([A, [26.006, 47]]), road([[26.004, 47], B, C])];
  const result = route([26.002, 47], [26.01, 47.008], roads);
  assert.ok(result);
  assert.ok(result.coordinates.some((p) => Math.abs(p[0] - B[0]) < 1e-8 && Math.abs(p[1] - B[1]) < 1e-8));
  const duplicated = [...roads, road([[26.006, 47], A]), road([C, B, [26.004, 47]])];
  assert.deepEqual(route([26.002, 47], [26.01, 47.008], duplicated), result);
});

test('tile endpoint quantization within three meters is joined', () => {
  const roads = [road([A, B]), road([[26.01002, 47.00001], C])];
  assert.ok(route([26.002, 47], [26.010005, 47.008], roads));
});

test('unconnected fragments return null and never draw a straight fallback', () => {
  const roads = [road([A, [26.004, 47]]), road([[26.006, 47], B])];
  assert.equal(route([26.002, 47], [26.008, 47], roads), null);
});

test('other roads cannot bridge disconnected pieces or match the second selection', () => {
  const first = road([A, [26.004, 47]]);
  const last = road([[26.006, 47], B]);
  const bridge = road([[26.004, 47], [26.006, 47]], { osm: 'w9', ref: 'DN29', name: 'Other Road' });
  assert.equal(route([26.002, 47], [26.008, 47], [first, last, bridge]), null);
  assert.equal(route([26.002, 47], [26.005, 47], [first, last, bridge]), null);
});

test('geometric crossings without shared vertices never create junctions', () => {
  const roads = [road([[26, 47.005], [26.02, 47.005]]), road([[26.01, 47], [26.01, 47.01]])];
  assert.equal(route([26.002, 47.005], [26.01, 47.009], roads), null);
  const oneVertex = [roads[0], road([[26.01, 47], [26.01, 47.005], [26.01, 47.01]])];
  assert.equal(route([26.002, 47.005], [26.01, 47.009], oneVertex), null);
});

test('shared vertices permit junctions and Dijkstra chooses the shorter matching branch', () => {
  const branch = [26.005, 47.005], far = [26.02, 47.015];
  const roads = [road([A, branch, C]), road([A, far, C])];
  const result = route(A, C, roads);
  assert.equal(result.coordinates.length, 3);
  close(result.coordinates[1], branch);
});

test('MultiLineString and FeatureCollection inputs are supported', () => {
  const multi = { ...road([]), geometry: { type: 'MultiLineString', coordinates: [[A, B], [B, C]] } };
  const roads = { type: 'FeatureCollection', features: [multi] };
  assert.ok(route([26.002, 47], [26.01, 47.008], roads));
  assert.equal(buildRoadSegment(null, null, roads), null);
  assert.equal(snapToRoad(A, []), null);
});

test('sliceRoadByKm and sliceRoadByPlaces trace DJ29 km 3-6 and locality segments on Botoșani road network', () => {
  const roadsData = JSON.parse(fs.readFileSync(new URL('../web/data/roads.json', import.meta.url), 'utf8'));
  assert.ok(roadsData.roads.length >= 200);

  // DJ29 aliases to DN29 and slices km 3 to km 6 accurately
  const dj29 = findRoadByRef(roadsData, 'DJ 29');
  assert.ok(dj29);
  const seg = sliceRoadByKm(roadsData, 'DJ29', 3, 6);
  assert.ok(seg);
  assert.equal(seg.kmFrom, 3);
  assert.equal(seg.kmTo, 6);
  assert.equal(seg.lengthKm, 3);
  assert.equal(seg.geometry.type, 'LineString');
  assert.ok(seg.geometry.coordinates.length >= 2);
  assert.ok(Math.abs(lineLengthKm(seg.geometry.coordinates) - 3) < 0.05);

  // Slicing between two localities along the road
  const byPlace = sliceRoadByPlaces(roadsData, 'DN29', dj29.places[0].name, dj29.places[2].name);
  assert.ok(byPlace);
  assert.ok(byPlace.lengthKm > 1);
  assert.equal(byPlace.geometry.type, 'LineString');

  // Projecting endpoint back onto the road yields its km position
  const pStart = projectPointOnRoad(dj29, seg.geometry.coordinates[0]);
  const pEnd = projectPointOnRoad(dj29, seg.geometry.coordinates.at(-1));
  assert.ok(Math.abs(pStart.km - 3) < 0.1);
  assert.ok(Math.abs(pEnd.km - 6) < 0.1);

  // roadNetworkToFeatures produces valid LineString features
  const feats = roadNetworkToFeatures(roadsData);
  assert.equal(feats.length, roadsData.roads.length);
  assert.equal(feats[0].geometry.type, 'LineString');
});

test('findRoadRoute connects different road classifications (DN, DJ, DC) across junctions', () => {
  const D = [26.02, 47.01];
  const dn = road([A, B], { osm: 'w1', ref: 'DN29', cls: 'dn', name: 'Drum Național 29' });
  const dj = road([B, C], { osm: 'w2', ref: 'DJ207N', cls: 'dj', name: 'Drum Județean 207N' });
  const dc = road([C, D], { osm: 'w3', ref: 'DC60A', cls: 'dc', name: 'Drum Comunal 60A' });
  const roads = [dn, dj, dc];

  const snapDN = snapToRoad([26.002, 47], roads);
  const snapDJ = snapToRoad([26.01, 47.005], roads);
  const snapDC = snapToRoad([26.018, 47.01], roads);

  // Single-road builder intentionally returns null because classifications and refs do not match
  assert.equal(buildRoadSegment(snapDN, snapDJ, roads), null);
  assert.equal(buildRoadSegment(snapDN, snapDC, roads), null);

  // findRoadRoute unites DN29 and DJ207N across the shared junction B
  const routeDNDJ = findRoadRoute(snapDN, snapDJ, roads);
  assert.ok(routeDNDJ);
  assert.equal(routeDNDJ.type, 'LineString');
  assert.ok(routeDNDJ.coordinates.length >= 3);
  close(routeDNDJ.coordinates[0], [26.002, 47]);
  close(routeDNDJ.coordinates[routeDNDJ.coordinates.length - 1], [26.01, 47.005]);

  // findRoadRoute unites DN29 to DC60A across the entire chain DN -> DJ -> DC
  const routeChain = findRoadRoute(snapDN, snapDC, roads);
  assert.ok(routeChain);
  assert.equal(routeChain.type, 'LineString');
  assert.ok(routeChain.coordinates.length >= 4);
  close(routeChain.coordinates[0], [26.002, 47]);
  close(routeChain.coordinates[routeChain.coordinates.length - 1], [26.018, 47.01]);

  // Completely disconnected roads return null
  const farDisconnected = [dn, road([[27.5, 47.5], [27.51, 47.51]], { osm: 'w99', ref: 'DN24C', cls: 'dn' })];
  const snapFar = snapToRoad([27.505, 47.505], farDisconnected);
  assert.equal(findRoadRoute(snapDN, snapFar, farDisconnected), null);
});


