import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareInterventionGraph, computeInterventionRoutes } from '../web/js/intervention-routing.js';

const A = [26, 47], B = [26.01, 47], C = [26.02, 47], D = [26.01, 47.01];
let nextId = 0;
const road = (coordinates, properties = {}) => ({ type: 'Feature', properties: { osm: `w${nextId++}`, cls: 'dj', ...properties }, geometry: { type: 'LineString', coordinates } });
const blocked = (coordinates, properties = {}) => ({ type: 'Feature', properties: { kind: 'blocked', status: 'confirmed', ...properties }, geometry: { type: 'LineString', coordinates } });
const fc = features => ({ type: 'FeatureCollection', features });
const route = (start, end, features, options) => computeInterventionRoutes(start, end, features, options);
const isFailure = result => { assert.equal(result.primary, null); assert.equal(result.alternative, null); assert.ok(result.reason); };

test('all seven driving classes route together regardless of visibility and include service/track', () => {
  const classes = ['dn', 'dj', 'dc', 'local', 'street', 'service', 'track'];
  const points = classes.map((_, i) => [26 + i * 0.001, 47]); points.push([26.007, 47]);
  const roads = classes.map((cls, i) => road([points[i], points[i + 1]], { cls }));
  const result = route(points[0], points.at(-1), fc(roads), { visible: {} });
  assert.deepEqual(result.primary.geometry.coordinates, points);
  assert.deepEqual(result.primary.roads.map(road => road.cls), classes);
  assert.ok(result.primary.distanceKm > 0.5 && result.primary.distanceKm < 0.6);
  assert.equal(result.alternative, null);
});

test('base is shortest and reserve follows a materially different actual road path', () => {
  const roads = [road([A, B, C]), road([A, D, C], { cls: 'dc' })];
  const graph = prepareInterventionGraph(roads);
  const result = route(A, C, graph);
  assert.deepEqual(result.primary.geometry.coordinates, [A, B, C]);
  assert.deepEqual(result.alternative.geometry.coordinates, [A, D, C]);
  assert.ok(result.primary.distanceKm < result.alternative.distanceKm);
  assert.equal(result.alternative.sharedFraction, 0);
  assert.equal(result.reason, '');
  assert.deepEqual(route(A, C, graph), result, 'Prepared graph must be reusable and immutable across searches');
});

test('a sole route never appears twice as its own reserve', () => {
  const result = route(A, C, [road([A, B, C])]);
  assert.ok(result.primary);
  assert.equal(result.alternative, null);
  assert.equal(result.alternativeReason, 'no_materially_different_alternative');
});

test('nearby disconnected roads and geometric crossings never invent connections', () => {
  const nearB = [B[0] + 0.00002, B[1]];
  isFailure(route(A, C, [road([A, B]), road([nearB, C])]));
  isFailure(route(A, D, [road([A, C]), road([[B[0], B[1] - 0.01], D])]));
  const gap = [B[0], B[1] + 0.00001]; // About 1.11 m: beyond source quantization tolerance.
  isFailure(route(A, D, [road([A, C]), road([gap, D])]));
});

test('actual same-grade endpoint touches can connect at a road interior', () => {
  const result = route(A, D, [road([A, C]), road([B, D])]);
  assert.deepEqual(result.primary.geometry.coordinates, [A, B, D]);
});

test('oneway and reverse oneway preserve geometry direction, including interior snaps', () => {
  const forward = [road([A, C], { oneway: 1 })];
  assert.ok(route(A, C, forward).primary);
  isFailure(route(C, A, forward));
  const s = [26.005, 47], e = [26.015, 47];
  assert.deepEqual(route(s, e, forward).primary.geometry.coordinates, [s, e]);
  isFailure(route(e, s, forward));
  const reverse = [road([A, C], { oneway: '-1' })];
  assert.ok(route(C, A, reverse).primary);
  isFailure(route(A, C, reverse));
});

test('bridges, tunnels and explicit levels do not merge at coincident vertices', () => {
  for (const properties of [{ bridge: 1 }, { tunnel: 'yes' }, { layer: 1 }]) {
    const roads = [road([A, B, C], properties), road([B, D])];
    isFailure(route(A, D, roads));
  }
  const roads = [road([A, B], { bridge: 1 }), road([B, C])];
  isFailure(route(A, C, roads), 'Uncertified bridge endpoints must remain separate');
});

test('only provider-certified endpoints on BOTH ways connect across grades', () => {
  const certified = [road([A, B], { bridge: 1, endpointJunctions: [B] }), road([B, C], { endpointJunctions: [B] })];
  assert.deepEqual(route(A, C, certified).primary.geometry.coordinates, [A, B, C]);
  isFailure(route(A, C, [certified[0], road([B, C])]));
  // A provider flag must not turn a bridge interior crossing into an endpoint.
  isFailure(route(A, D, [road([A, B, C], { bridge: 1, endpointJunctions: [B] }), road([B, D], { endpointJunctions: [B] })]));
});

test('rail, walking-only roads and known motor access restrictions are excluded', () => {
  for (const properties of [{ cls: 'rail' }, { hw: 'footway' }, { hw: 'pedestrian' }, { access: 'private' }, { motor_vehicle: 'no' }, { vehicle: 'forestry' }]) {
    isFailure(route(A, C, [road([A, C], properties)]));
  }
  assert.ok(route(A, C, [road([A, C], { access: 'private', emergency: 'yes' })]).primary);
  assert.ok(route(A, C, [road([A, C], { access: 'private', motor_vehicle: 'yes' })]).primary);
});

test('snapping is capped and reported without adding straight off-road connectors', () => {
  const start = [26.002, 47.0005], end = [26.018, 47.0005];
  const result = route(start, end, [road([A, C])]);
  assert.ok(result.snaps.start.distanceMeters > 50 && result.snaps.start.distanceMeters < 60);
  assert.deepEqual(result.primary.geometry.coordinates, [[26.002, 47], [26.018, 47]]);
  assert.notDeepEqual(result.primary.geometry.coordinates[0], start);
  isFailure(route([26.002, 47.003], end, [road([A, C])], { maxSnapMeters: 100000 }));
  assert.equal(route([26.002, 47.003], end, [road([A, C])]).reason, 'start_too_far');
});

test('operational closures avoid blocked edges while resolved closures do not exclude roads', () => {
  const roads = [road([A, B, C], { ref: 'DJ 29' }), road([A, D, C], { ref: 'DC1' })];
  const closure = blocked([[26.004, 47], [26.006, 47]], { road: 'DJ29' });
  const result = route(A, C, roads, { blockedFeatures: fc([closure]) });
  assert.deepEqual(result.primary.geometry.coordinates, [A, D, C]);
  assert.ok(result.blockedEdgeCount > 0);
  isFailure(route(A, C, [roads[0]], { blockedFeatures: [closure] }));
  closure.properties.status = 'resolved';
  assert.deepEqual(route(A, C, roads, { blockedFeatures: [closure] }).primary.geometry.coordinates, [A, B, C]);
});

test('closure road identity does not exclude an adjacent different road', () => {
  const closeLine = [[26, 47.00001], [26.02, 47.00001]];
  const roads = [road([A, C], { ref: 'DN29;E58' }), road(closeLine, { ref: 'DC1' })];
  const closure = blocked([[26.004, 47], [26.006, 47]], { road: 'DN29' });
  const graph = prepareInterventionGraph(roads);
  const result = route(closeLine[0], closeLine[1], graph, { blockedFeatures: [closure] });
  assert.ok(result.primary);
  assert.deepEqual(result.primary.geometry.coordinates, closeLine);
  assert.equal(result.blockedEdgeCount, 1);
});

test('MultiLineString, duplicate tile fragments and submeter duplicate vertices are supported', () => {
  const a = road([A, B]), b = road([[B[0] + 0.000002, B[1]], C]);
  const multi = { ...a, geometry: { type: 'MultiLineString', coordinates: [[A, B], [[B[0] + 0.000002, B[1]], C]] } };
  assert.ok(route(A, C, [multi]).primary);
  const graph = prepareInterventionGraph([a, a, b]);
  assert.equal(graph.edges.length, 2);
  assert.ok(route(A, C, graph).primary);
});

test('a long shared trunk is not mislabeled as an independent reserve', () => {
  const E = [26.001, 47], F = [26.001, 47.0002];
  const result = route(A, C, [road([A, E]), road([A, F, E]), road([E, C])]);
  assert.ok(result.primary);
  assert.equal(result.alternative, null);
});

test('invalid coordinates and an empty or malformed road network fail clearly', () => {
  assert.equal(route([NaN, 47], C, []).reason, 'invalid_coordinates');
  assert.equal(route(A, C, []).reason, 'empty_network');
  isFailure(route(A, C, [{ geometry: { type: 'LineString' }, properties: { cls: 'dj' } }]));
});

test('duplicate OSM ways or differently densified copies cannot be presented as reserve routes', () => {
  assert.equal(route(A, C, [road([A, B, C]), road([A, B, C])]).alternative, null);
  assert.equal(route(A, C, [road([A, C]), road([A, B, C])]).alternative, null);
  const result = route(A, C, [road([A, B, C]), road([A, B, C]), road([A, D, C])]);
  assert.deepEqual(result.alternative.geometry.coordinates, [A, D, C]);
});


test('quantized same-grade service/street endpoint junctions connect within 75 cm only', () => {
  for (const offset of [0.000001, 0.000002, 0.000006]) {
    const junction = [B[0], B[1] + offset];
    const result = route(A, D, [road([A, C], { cls: 'dn' }), road([junction, D], { cls: 'service' })]);
    assert.ok(result.primary, `Real endpoint rounding by ${offset} degrees should remain connected`);
    assert.deepEqual(result.primary.geometry.coordinates, [A, junction, D]);
  }
  const outsideTolerance = [B[0], B[1] + 0.000008];
  isFailure(route(A, D, [road([A, C]), road([outsideTolerance, D])]));
  const roundedJunction = [B[0], B[1] + 0.000001];
  isFailure(route(A, D, [road([A, C], { bridge: 1 }), road([roundedJunction, D])]));
});
