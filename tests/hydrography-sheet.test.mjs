import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { hydrography } from './fixtures/synthetic-cadastre.mjs';
import { main, mainSlice } from './fixtures/main-source.mjs';

// geo.js asks for proj4 at load time; the helpers only use its distance().
globalThis.proj4 = () => ({ forward() {}, inverse() {} });
const { courseIndex, courseRows } = await import('../web/js/hydrography-layer.js');

const empty = () => ({ type: 'FeatureCollection', features: [] });
const course = name => hydrography.features.find(f => f.properties.name === name);
// What queryRenderedFeatures hands back: the piece of the line in one tile, with the list properties as JSON text.
const rendered = (name, layerId = 'hydro-line') => {
  const { properties, geometry } = course(name);
  return {
    type: 'Feature', layer: { id: layerId },
    properties: { ...properties, alt: JSON.stringify(properties.alt), uats: JSON.stringify(properties.uats) },
    geometry: { type: 'LineString', coordinates: geometry.coordinates[0].slice(0, 2) },
  };
};
const plain = value => JSON.parse(JSON.stringify(value));

const pickOrder = plain(vm.runInNewContext(mainSlice('const PICK_ORDER = ', '\n\nfunction onMapClick(') + '\nPICK_ORDER'));
const describeSource = mainSlice('function describe(', 'function coordsBlock(');
const showInfoSource = mainSlice('function showInfo(', 'function closeInfo(');

test('a click on a cadastre river wins over the OSM water lines but not over roads, buildings or points', () => {
  const at = id => pickOrder.indexOf(id);
  assert.ok(at('hydro-line') >= 0);
  assert.equal(at('hydro-label'), at('hydro-line') + 1);
  assert.equal(at('dams'), at('hydro-label') + 1);
  for (const id of ['hydrant-icon', 'poi-major', 'pin', 'buildings', 'roads', 'tracks', 'rail']) assert.ok(at(id) < at('hydro-line'), id);
  for (const id of ['rivers', 'streams', 'water', 'places', 'landuse']) assert.ok(at('hydro-line') < at(id), id);
});

function click(rendered, { hidden = [] } = {}) {
  const shown = [];
  const asked = [];
  vm.runInNewContext(`${mainSlice('const PICK_ORDER = ', '\n\nfunction onMapClick(')}\n${mainSlice('function onMapClick(', '// ------')}\nonMapClick(event);`, {
    event: { point: { x: 10, y: 10 }, lngLat: { lng: 26.4, lat: 47.54 } },
    suppressClickUntil: 0, closeContextMenu() {}, pendingPick: null, operations: null, state: { mode: null, analysis: null },
    map: {
      getLayer: () => true, getLayoutProperty: id => (hidden.includes(id) ? 'none' : 'visible'),
      queryRenderedFeatures: (box, { layers }) => { asked.push(...layers); return rendered.filter(f => layers.includes(f.layer.id)); },
    },
    showInfo: (f, ll) => shown.push([f, ll]), selectTab() {}, setMode() {}, analyzePoint() {}, addMeasurePoint() {},
  });
  return { shown, asked };
}

test('clicking on the map picks the cadastre river over an OSM river, and a road over the cadastre river', () => {
  const osm = { layer: { id: 'rivers' }, properties: { name: 'Bașeu' } };
  const road = { layer: { id: 'roads' }, properties: { ref: 'DJ1' } };
  const hydro = rendered('Bașeu');
  assert.equal(click([osm, hydro]).shown[0][0].layer.id, 'hydro-line');
  assert.equal(click([osm, hydro, road]).shown[0][0].layer.id, 'roads');
  const hidden = click([osm, hydro], { hidden: ['hydro-line', 'hydro-label'] });
  assert.equal(hidden.shown[0][0].layer.id, 'rivers');
  assert.ok(!hidden.asked.includes('hydro-line'));
});

test('the cadastre line shows the pointer cursor on hover like the point layers', () => {
  const clickable = main.match(/const clickable = \[([^\]]*)\]/)[1];
  assert.ok(clickable.includes('"hydro-line"'));
  assert.ok(clickable.includes('"poi-major"'));
});

function show(feature, clickAt = [26.4, 47.54]) {
  const box = { innerHTML: '', hidden: true };
  const overlays = [];
  const state = { hydrography, visible: {}, data: { hydrography } };
  vm.runInNewContext(`${describeSource}\n${showInfoSource}\nshowInfo(feature, clickAt);`, {
    $: () => box, uatAt: () => ({ name: 'Cetate' }), state, icons: {}, esc: String, setOverlay: (name, fc) => overlays.push([name, fc]),
    osmLink: () => null, ICON: {}, coordsBlock: () => '', extLinks: () => '', setSheet() {}, openCommuneMap() {},
    courseIndex, courseRows, POI: {}, LABELS: {}, iconDataURL: () => '', formatRestriction: () => '', feature, clickAt,
  });
  return { box, overlays };
}

test('the sheet of a cadastre river is read from the whole course, not from the clicked tile piece', () => {
  // the rendered Prut is its short first part, 11 km, and its lists are JSON text
  const { box } = show(rendered('Prut'), [26.8, 47.05]);
  assert.ok(box.innerHTML.includes('<h2>Prut</h2>'));
  assert.ok(box.innerHTML.includes('<span class="kind">Curs de apă · cadastrul apelor (ABA)</span>'));
  const rows = courseRows(course('Prut'), hydrography);
  assert.ok(rows.some(([label, value]) => label === 'Lungime în județ (aprox.)' && value === '≈ 78 km'));
  for (const [label, value] of rows) assert.ok(box.innerHTML.includes(`<dt>${label}</dt><dd class="">${value}</dd>`), label);
  assert.ok(box.innerHTML.includes('<dd class="">3: Ălbăstrea, Mierea, Zorilă</dd>'));
  const { box: other } = show(rendered('Bașeu'));
  assert.ok(other.innerHTML.includes('<dd class="">Baseu Mare, Bașeul</dd>'));
});

test('the selection overlay outlines the whole course', () => {
  // the rendered piece is a two-point LineString; the course is a MultiLineString with every part
  const prut = rendered('Prut', 'hydro-label');
  const { overlays } = show(prut, [26.5, 47.3]);
  const [name, fc] = overlays[0];
  assert.equal(name, 'sel');
  assert.deepEqual(plain(fc.features[0].geometry), plain(course('Prut').geometry));
  assert.notDeepEqual(plain(fc.features[0].geometry), plain(prut.geometry));
});

test('the sheet of the full feature from the search shows the same rows', () => {
  const { box, overlays } = show({ ...course('Sitna'), layer: { id: 'hydro-line' } }, [26.3, 47.2]);
  assert.ok(box.innerHTML.includes('<h2>Sitna</h2>'));
  assert.ok(box.innerHTML.includes('<dd class="">Jijia</dd>'));
  assert.deepEqual(plain(overlays[0][1].features[0].geometry), plain(course('Sitna').geometry));
});
