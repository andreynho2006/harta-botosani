import assert from 'node:assert/strict';
import test from 'node:test';
import { containsPoint, geometryBounds, linesInside, outsideMask, roadExits } from '../web/js/commune-geometry.js';

const ring = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const square = { type: 'Polygon', coordinates: [ring(26, 47, 26.02, 47.02)] };
const road = (coordinates, properties = { osm: 'w1', cls: 'local', name: 'Example Road' }) => ({
  type: 'Feature', properties, geometry: { type: 'LineString', coordinates },
});
const collection = (...features) => ({ type: 'FeatureCollection', features });
const approx = (actual, expected, epsilon = 1e-8) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
const length = (coordinates) => coordinates.slice(1).reduce((sum, b, i) => {
  const a = coordinates[i], rad = Math.PI / 180;
  const h = Math.sin((b[1] - a[1]) * rad / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin((b[0] - a[0]) * rad / 2) ** 2;
  return sum + 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}, 0);
const outsideMidpoints = (result, geometry) => {
  for (const feature of result.features) {
    const coords = feature.geometry.coordinates;
    for (let i = 1; i < coords.length; i++) {
      const mid = coords[i].map((v, d) => (v + coords[i - 1][d]) / 2);
      assert.equal(containsPoint(geometry, mid), false);
    }
  }
};

test('containment and bounds support holes and multiple polygons', () => {
  const geometry = { type: 'MultiPolygon', coordinates: [
    [ring(26, 47, 26.02, 47.02), ring(26.005, 47.005, 26.015, 47.015)],
    [ring(26.03, 47, 26.04, 47.02)],
  ] };
  assert.equal(containsPoint(geometry, [26.002, 47.01]), true);
  assert.equal(containsPoint(geometry, [26.01, 47.01]), false);
  assert.equal(containsPoint(geometry, [26.035, 47.01]), true);
  assert.equal(containsPoint(geometry, [26.025, 47.01]), false);
  assert.deepEqual(geometryBounds(geometry), [[26, 47], [26.04, 47.02]]);
  assert.equal(geometryBounds(null), null);
});

test('outside mask covers exterior and polygon holes without covering selected islands', () => {
  const geometry = { type: 'MultiPolygon', coordinates: [
    [ring(26, 47, 26.02, 47.02), ring(26.005, 47.005, 26.015, 47.015)],
    [ring(26.03, 47, 26.04, 47.02)],
  ] };
  const before = JSON.stringify(geometry);
  const mask = outsideMask(geometry);
  assert.equal(mask.features.length, 2);
  const masked = (point) => mask.features.some((feature) => containsPoint(feature.geometry, point));
  assert.equal(masked([0, 0]), true);
  assert.equal(masked([26.002, 47.01]), false);
  assert.equal(masked([26.01, 47.01]), true);
  assert.equal(masked([26.035, 47.01]), false);
  assert.equal(masked([26.025, 47.01]), true);
  assert.deepEqual(geometryBounds(mask.features[0].geometry), [[-180, -85], [180, 85]]);
  assert.equal(JSON.stringify(geometry), before);
});

test('a true crossing emits only the short exterior path with fading and properties', () => {
  const result = roadExits(collection(road([[26.01, 47.01], [26.04, 47.01]])), square);
  assert.equal(result.features.length, 8);
  approx(result.features[0].geometry.coordinates[0][0], 26.02);
  assert.deepEqual(result.features.map((f) => f.properties.fade), Array.from({ length: 8 }, (_, i) => 1 - i / 7));
  for (const feature of result.features) {
    assert.equal(feature.properties.osm, 'w1');
    assert.equal(feature.properties.name, 'Example Road');
  }
  const meters = result.features.reduce((n, f) => n + length(f.geometry.coordinates), 0);
  approx(meters, 250, 0.01);
  outsideMidpoints(result, square);
});

test('fully exterior, fully interior and tangential roads do not create exits', () => {
  for (const coords of [
    [[26.03, 47], [26.04, 47.02]],
    [[26.005, 47.005], [26.015, 47.015]],
    [[25.99, 47.01], [26, 47.02], [25.99, 47.03]],
  ]) assert.equal(roadExits([road(coords)], square).features.length, 0);
});

test('both exterior endpoints still detect two boundary crossings', () => {
  const result = roadExits([road([[25.99, 47.01], [26.03, 47.01]])], square);
  assert.equal(result.features.length, 16);
  approx(result.features[0].geometry.coordinates[0][0], 26);
  approx(result.features[8].geometry.coordinates[0][0], 26.02);
  outsideMidpoints(result, square);
});

test('concave polygons detect exterior gaps even when both road endpoints are inside', () => {
  const geometry = { type: 'Polygon', coordinates: [[
    [26, 47], [26.03, 47], [26.03, 47.03], [26.02, 47.03],
    [26.02, 47.01], [26.01, 47.01], [26.01, 47.03], [26, 47.03], [26, 47],
  ]] };
  const result = roadExits([road([[26.005, 47.02], [26.025, 47.02]])], geometry);
  assert.equal(result.features.length, 16);
  approx(result.features[0].geometry.coordinates[0][0], 26.01);
  approx(result.features[8].geometry.coordinates[0][0], 26.02);
  outsideMidpoints(result, geometry);
});

test('hole boundaries, multiple polygon crossings and multiline roads are supported', () => {
  const geometry = { type: 'MultiPolygon', coordinates: [
    [ring(26, 47, 26.02, 47.02), ring(26.005, 47.005, 26.015, 47.015)],
    [ring(26.03, 47, 26.04, 47.02)],
  ] };
  const feature = {
    ...road([]), geometry: { type: 'MultiLineString', coordinates: [
      [[25.99, 47.01], [26.05, 47.01]], [[26.06, 47], [26.07, 47.01]],
    ] },
  };
  const result = roadExits([feature], geometry);
  assert.equal(result.features.length, 48);
  outsideMidpoints(result, geometry);
});

test('duplicate tile features including reversed lines do not duplicate exits', () => {
  const coords = [[26.01, 47.01], [26.025, 47.01], [26.04, 47.015]];
  const single = roadExits([road(coords)], square);
  const duplicate = roadExits([road(coords), road(coords), road([...coords].reverse())], square);
  assert.deepEqual(duplicate, single);
});

test('overlapping tile fragments with different outside endpoints keep the longest exit', () => {
  const full = road([[26.01, 47.01], [26.04, 47.01]]);
  const fragment = road([[26.015, 47.01], [26.0205, 47.01]]);
  assert.deepEqual(roadExits([fragment, full], square), roadExits([full], square));
});

test('custom length limits follow bent roads, and short exits stop at the endpoint', () => {
  const result = roadExits([road([[26.01, 47.01], [26.021, 47.01], [26.021, 47.03]])], square, 150);
  assert.equal(result.features.length, 8);
  const meters = result.features.reduce((n, f) => n + length(f.geometry.coordinates), 0);
  approx(meters, 150, 0.01);
  assert.ok(result.features.some((f) => f.geometry.coordinates.length > 2));
  outsideMidpoints(result, square);
  const short = roadExits([road([[26.01, 47.01], [26.0201, 47.01]])], square);
  approx(short.features.at(-1).geometry.coordinates.at(-1)[0], 26.0201);
  assert.equal(roadExits([road([[26.01, 47.01], [26.04, 47.01]])], square, 0).features.length, 0);
});

const river = (coordinates, properties = { name: 'Example River', code: 'RO_X_1' }) => ({
  type: 'Feature', properties, geometry: Array.isArray(coordinates[0][0])
    ? { type: 'MultiLineString', coordinates } : { type: 'LineString', coordinates },
});
const insideMidpoints = (result, geometry) => {
  for (const feature of result.features) {
    const coords = feature.geometry.coordinates;
    for (let i = 1; i < coords.length; i++) assert.equal(containsPoint(geometry, coords[i].map((v, d) => (v + coords[i - 1][d]) / 2)), true);
  }
};

test('linesInside cuts a line that crosses the border and keeps the stretch inside, with its properties', () => {
  const result = linesInside(collection(river([[26.01, 47.01], [26.01, 47.05]])), square);
  assert.equal(result.type, 'FeatureCollection');
  assert.equal(result.features.length, 1);
  const [feature] = result.features;
  assert.equal(feature.geometry.type, 'LineString');
  assert.deepEqual(feature.properties, { name: 'Example River', code: 'RO_X_1' });
  approx(feature.geometry.coordinates[0][1], 47.01);
  approx(feature.geometry.coordinates.at(-1)[1], 47.02);
  insideMidpoints(result, square);
});

test('linesInside keeps a line that is inside whole and drops one that is outside', () => {
  const inside = river([[26.005, 47.005], [26.015, 47.015]]);
  const outside = river([[26.03, 47], [26.04, 47.02]], { name: 'Other', code: 'RO_X_2' });
  const result = linesInside(collection(inside, outside), square);
  assert.deepEqual(result.features.map(f => f.properties.name), ['Example River']);
  assert.deepEqual(result.features[0].geometry.coordinates, inside.geometry.coordinates);
});

test('linesInside gives one stretch for each time a line is inside, across the parts of a multiline', () => {
  const geometry = { type: 'MultiPolygon', coordinates: [
    [ring(26, 47, 26.02, 47.02), ring(26.005, 47.005, 26.015, 47.015)],
    [ring(26.03, 47, 26.04, 47.02)],
  ] };
  const result = linesInside(collection(river([[[25.99, 47.01], [26.05, 47.01]], [[26.01, 47.003], [26.01, 47.004]]])), geometry);
  // along 47.01 the first part is inside the first polygon on either side of the hole, then inside the second polygon;
  // the short second part lies below the hole
  assert.equal(result.features.length, 4);
  insideMidpoints(result, geometry);
});

test('linesInside copes with no lines, no polygon and lines without points', () => {
  for (const lines of [undefined, null, collection(), collection(river([[26.01, 47.01], [26.01, 47.012]]), river([[]]))]) {
    const result = linesInside(lines, square);
    assert.equal(result.type, 'FeatureCollection');
    assert.equal(result.features.length, lines?.features?.length ? 1 : 0);
  }
  assert.deepEqual(linesInside(collection(river([[26.01, 47.01], [26.01, 47.012]])), null).features, []);
});

test('linesInside answers a second call for the same lines and area with the same collection', () => {
  const lines = collection(river([[26.01, 47.01], [26.01, 47.05]]));
  const first = linesInside(lines, square);
  assert.equal(linesInside(lines, JSON.parse(JSON.stringify(square))), first);
  assert.notEqual(linesInside(lines, { type: 'Polygon', coordinates: [ring(26, 47, 26.02, 47.03)] }), first);
  assert.notEqual(linesInside(collection(...lines.features), square), first);
});
