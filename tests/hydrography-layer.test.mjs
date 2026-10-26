import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyHydrography, hydrography } from './fixtures/synthetic-cadastre.mjs';

// geo.js asks for proj4 at load time; these helpers only use its distance().
globalThis.proj4 = () => ({ forward() {}, inverse() {} });
const { distance } = await import('../web/js/geo.js');
const { cadastreCode, courseIndex, parentLabel, lengthInCountyKm, courseAnchor, courseBBox, courseRows, courseSearchRows }
  = await import('../web/js/hydrography-layer.js');

const byName = name => hydrography.features.find(f => f.properties.name === name);
// 0.1 degree of latitude is 11.1195 km on the sphere distance() uses.
const KM_PER_TENTH_DEGREE = 11.1195;
const close = (actual, expected, tolerance = 0.001) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} is not ${expected}`);

test('cadastreCode writes the code in the notation of the water cadastre atlas', () => {
  assert.equal(cadastreCode('RO_XIII_1.15'), 'XIII-1.15');
  assert.equal(cadastreCode('RO_XII_1'), 'XII-1');
  assert.equal(cadastreCode('RO_XIII_1.14a'), 'XIII-1.14a');
  assert.equal(cadastreCode(undefined), '');
});

test('courseIndex maps each code to its feature and is built once per collection', () => {
  const index = courseIndex(hydrography);
  assert.equal(index.size, hydrography.features.length);
  assert.equal(index.get('RO_XIII_1.10'), byName('Bașeu'));
  assert.equal(courseIndex(hydrography), index);
  assert.notEqual(courseIndex({ ...hydrography }), index);
  assert.equal(courseIndex(emptyHydrography).size, 0);
  assert.equal(courseIndex(null).size, 0);
});

test('parentLabel finds the receiving river ignoring case and diacritics, then falls back', () => {
  assert.equal(parentLabel('Baseu', hydrography), 'Bașeu');
  assert.equal(parentLabel('BASEU', hydrography), 'Bașeu');
  assert.equal(parentLabel('Prut', hydrography), 'Prut');
  // The cadastre name "SITNA (SIHNA)" is matched as a whole.
  assert.equal(parentLabel('Sitna (Sihna)', hydrography), 'Sitna');
  assert.equal(parentLabel('Dunarea', hydrography), 'Dunărea');
  assert.equal(parentLabel('Dunarea', emptyHydrography), 'Dunărea');
  assert.equal(parentLabel('Rau Strain', hydrography), 'Rau Strain');
  assert.equal(parentLabel('', hydrography), '');
  assert.equal(parentLabel(null, hydrography), '');
});

test('lengthInCountyKm adds up every part of the course', () => {
  // 0.1 + 0.2 + 0.4 + 0.1 degrees of latitude over the two parts of the Prut
  close(lengthInCountyKm(byName('Prut').geometry), 7 * KM_PER_TENTH_DEGREE, 0.01);
  close(lengthInCountyKm({ type: 'LineString', coordinates: [[26, 47], [26, 47.1]] }), KM_PER_TENTH_DEGREE, 0.01);
  assert.equal(lengthInCountyKm({ type: 'MultiLineString', coordinates: [] }), 0);
});

test('courseAnchor lies on the longest part, halfway along it', () => {
  const [lon, lat] = courseAnchor(byName('Prut').geometry);
  // The short piece is listed first and the middle of the bounding box is at lon 26.65: neither is the answer.
  assert.equal(lon, 26.5);
  close(lat, 47.3, 1e-9);
  // An L-shaped course: half of its length is walked from the start, round the corner, to the anchor.
  const bent = { type: 'MultiLineString', coordinates: [[[26, 47], [26.1, 47], [26.1, 47.1]]] };
  const anchor = courseAnchor(bent);
  assert.equal(anchor[0], 26.1);
  close((distance([26, 47], [26.1, 47]) + distance([26.1, 47], anchor)) / 1000, lengthInCountyKm(bent) / 2, 1e-6);
  assert.equal(courseAnchor({ type: 'MultiLineString', coordinates: [] }), null);
  assert.deepEqual(courseAnchor({ type: 'LineString', coordinates: [[26, 47]] }), [26, 47]);
});

test('courseBBox spans every part', () => {
  assert.deepEqual(courseBBox(byName('Prut').geometry), [26.5, 47, 26.8, 47.6]);
  assert.equal(courseBBox({ type: 'MultiLineString', coordinates: [] }), null);
});

test('courseRows lists the sheet rows in order, with the number formats of the app', () => {
  assert.deepEqual(courseRows(byName('Prut'), hydrography), [
    ['Cod cadastral', 'XIII-1'],
    ['Se varsă în', 'Dunărea'],
    ['Lungime totală', '742 km'],
    ['Lungime în județ (aprox.)', '≈ 78 km'],
    ['Suprafața bazinului', '5.757 km²'],
    // sorted the Romanian way: Ă right after A, not after Z
    ['UAT-uri riverane', '3: Ălbăstrea, Mierea, Zorilă'],
  ]);
  assert.deepEqual(courseRows(byName('Bașeu'), hydrography), [
    ['Cod cadastral', 'XIII-1.10'],
    ['Se varsă în', 'Prut'],
    ['Lungime totală', '8,5 km'],
    ['Lungime în județ (aprox.)', '≈ 8,9 km'],
    ['Suprafața bazinului', '120 km²'],
    ['Alte denumiri', 'Baseu Mare, Bașeul'],
    ['UAT-uri riverane', '1: Cetate'],
  ]);
});

test('courseRows skips what the cadastre does not give', () => {
  assert.deepEqual(courseRows(byName('Valea Mare'), hydrography), [
    ['Cod cadastral', 'XIII-1.12.2'],
    ['Se varsă în', 'Rau Strain'],
    ['Lungime în județ (aprox.)', '≈ 5,6 km'],
  ]);
  const bare = { type: 'Feature', properties: { name: 'X', code: 'RO_XII_1' }, geometry: { type: 'MultiLineString', coordinates: [] } };
  assert.deepEqual(courseRows(bare, hydrography), [['Cod cadastral', 'XII-1']]);
});

test('courseRows reads lists that went through MapLibre as JSON text', () => {
  const flat = { ...byName('Bașeu'), properties: { ...byName('Bașeu').properties, alt: '["Baseu Mare","Bașeul"]', uats: '["Cetate"]' } };
  assert.deepEqual(courseRows(flat, hydrography), courseRows(byName('Bașeu'), hydrography));
  const broken = { ...flat, properties: { ...flat.properties, alt: 'not json', uats: null } };
  assert.deepEqual(courseRows(broken, hydrography).map(([label]) => label),
    ['Cod cadastral', 'Se varsă în', 'Lungime totală', 'Lungime în județ (aprox.)', 'Suprafața bazinului']);
});

test('courseSearchRows gives one row per course in the SearchIndex tuple format', () => {
  const rows = courseSearchRows(hydrography);
  assert.equal(rows.length, hydrography.features.length);
  const [name, type, lon, lat, ctx, bbox, ref] = rows.find(row => row[0] === 'Prut');
  assert.equal(name, 'Prut');
  assert.equal(type, 'cad');
  assert.equal(lon, 26.5);
  close(lat, 47.3, 1e-9);
  assert.equal(ctx, 'afluent al Dunărea · 742 km');
  assert.deepEqual(bbox, [26.5, 47, 26.8, 47.6]);
  assert.equal(ref, 'RO_XIII_1');
  assert.deepEqual(courseSearchRows(emptyHydrography), []);
  assert.deepEqual(courseSearchRows(undefined), []);
});

test('courseSearchRows skips a course without coordinates instead of throwing', () => {
  const nameless = (name, geometry) => ({ type: 'Feature', properties: { code: 'RO_XIII_9', name, parent: 'Prut', alt: [], uats: [] }, geometry });
  const fantoms = [
    nameless('Fantoma', { type: 'MultiLineString', coordinates: [] }),
    nameless('Fantoma', { type: 'MultiLineString', coordinates: [[]] }),
    nameless('Fantoma', { type: 'LineString', coordinates: [] }),
    nameless('Fantoma', null),
  ];
  for (const fantom of fantoms) {
    const fc = { type: 'FeatureCollection', features: [fantom, byName('Prut')] };
    assert.deepEqual(courseSearchRows(fc).map(row => row[0]), ['Prut'], JSON.stringify(fantom.geometry));
  }
});

test('courseSearchRows puts the alternate names in the context so a search for them hits', () => {
  const ctx = courseSearchRows(hydrography).find(row => row[0] === 'Bașeu')[4];
  assert.equal(ctx, 'afluent al Prut · 8,5 km · și Baseu Mare, Bașeul');
  const plain = courseSearchRows(hydrography).find(row => row[0] === 'Jijia')[4];
  assert.equal(plain, 'afluent al Prut · 275 km');
  const orphan = courseSearchRows(hydrography).find(row => row[0] === 'Valea Mare')[4];
  assert.equal(orphan, 'afluent al Rau Strain');
});
