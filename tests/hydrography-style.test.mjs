import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyHydrography, hydrography } from './fixtures/synthetic-cadastre.mjs';

globalThis.location = { href: 'http://localhost:8000/' };
const { LAYER_GROUPS, LAYER_PRESETS, itemLabel } = await import('../web/js/config.js');
const { buildStyle, PALETTES } = await import('../web/js/style.js');
const { buildCommuneStyle } = await import('../web/js/commune.js');

const empty = () => ({ type: 'FeatureCollection', features: [] });
const defaults = () => Object.fromEntries(LAYER_GROUPS.flatMap(group => group.items.map(item => [item.id, item.on])));
const stateWith = (extra = {}, data = {}) => ({
  theme: 'zi', basemap: 'harta', visible: defaults(),
  data: { pois: empty(), hydrants: empty(), admin: empty(), ...data },
  overlays: { sel: empty(), analysis: empty(), measure: empty(), pin: empty() }, hoverUat: '', ...extra,
});
const layer = (style, id) => style.layers.find(item => item.id === id);
const index = (style, id) => style.layers.findIndex(item => item.id === id);

test('the cadastre item sits after the OSM rivers, off by default', () => {
  const group = LAYER_GROUPS.find(item => item.id === 'ape');
  const ids = group.items.map(item => item.id);
  assert.equal(ids[ids.indexOf('rivers') + 1], 'cadastru');
  const item = group.items.find(entry => entry.id === 'cadastru');
  assert.equal(itemLabel(item), 'Hidrografie (cadastru)');
  assert.equal(item.kind, 'hydrography');
  assert.equal(item.on, false);
  assert.equal(defaults().cadastru, false);
});

test('the flood profile shows the cadastre and the CJSU base profile still matches the defaults', () => {
  const layers = id => LAYER_PRESETS.find(preset => preset.id === id).layers;
  assert.ok(layers('flood').includes('cadastru'));
  assert.ok(!layers('baza').includes('cadastru'));
  const on = Object.entries(defaults()).filter(([, visible]) => visible).map(([id]) => id);
  assert.deepEqual([...on].sort(), [...layers('baza')].sort());
  for (const id of ['snow', 'fire', 'storm']) assert.ok(!layers(id).includes('cadastru'), id);
  assert.ok(layers('all').includes('cadastru'));
});

test('the hydrography source carries the loaded cadastre, or an empty collection when a caller has none', () => {
  assert.equal(buildStyle(stateWith({}, { hydrography })).sources.hydrography.data, hydrography);
  const missing = buildStyle(stateWith());
  assert.deepEqual(missing.sources.hydrography, { type: 'geojson', data: empty() });
  assert.deepEqual(buildStyle(stateWith({}, { hydrography: emptyHydrography })).sources.hydrography.data, empty());
});

test('the commune map builds without a cadastre in its state', () => {
  const polygon = { type: 'Polygon', coordinates: [[[26, 47], [26.02, 47], [26.02, 47.02], [26, 47.02], [26, 47]]] };
  const uat = { name: 'Example', feature: { type: 'Feature', properties: { name: 'Example', kind: 'uat' }, geometry: polygon } };
  const style = buildCommuneStyle(uat, stateWith());
  assert.deepEqual(style.sources.hydrography.data, empty());
  assert.ok(layer(style, 'hydro-line'));
});

test('the cadastre layers follow state.visible.cadastru', () => {
  for (const on of [false, true]) {
    const state = stateWith({}, { hydrography });
    state.visible.cadastru = on;
    const style = buildStyle(state);
    for (const id of ['hydro-line', 'hydro-label']) assert.equal(layer(style, id).layout.visibility, on ? 'visible' : 'none', id);
  }
});

test('hydro-line goes under roads and labels, right after the dams', () => {
  const style = buildStyle(stateWith({}, { hydrography }));
  const line = index(style, 'hydro-line');
  assert.equal(line, index(style, 'dams') + 1);
  assert.ok(line < index(style, 'uat-line'));
  assert.ok(line < index(style, 'roads-casing'));
  assert.ok(line < index(style, 'buildings'));
  assert.ok(line < style.layers.findIndex(item => item.type === 'symbol'));
  assert.equal(layer(style, 'hydro-line').type, 'line');
  assert.equal(layer(style, 'hydro-line').source, 'hydrography');
  assert.equal(layer(style, 'hydro-line').layout['line-cap'], 'round');
  assert.equal(layer(style, 'hydro-line').layout['line-join'], 'round');
});

test('hydro-label is a line label right after the OSM river labels', () => {
  const style = buildStyle(stateWith({}, { hydrography }));
  assert.equal(index(style, 'hydro-label'), index(style, 'river-label') + 1);
  const label = layer(style, 'hydro-label');
  assert.equal(label.type, 'symbol');
  assert.equal(label.source, 'hydrography');
  assert.equal(label.minzoom, 10);
  assert.equal(label.layout['symbol-placement'], 'line');
  assert.deepEqual(label.layout['text-field'], ['get', 'name']);
  assert.deepEqual(label.layout['text-font'], ['Noto Sans Italic']);
});

test('the colours follow the theme and the satellite map', () => {
  assert.equal(PALETTES.zi.hydro, '#1565c0');
  assert.equal(PALETTES.noapte.hydro, '#58a6ff');
  const colors = state => {
    const style = buildStyle(state);
    return [layer(style, 'hydro-line').paint['line-color'], layer(style, 'hydro-label').paint['text-color']];
  };
  assert.equal(colors(stateWith())[0], '#1565c0');
  assert.equal(colors(stateWith())[1], '#1565c0');
  assert.equal(colors(stateWith({ theme: 'noapte' }))[0], '#58a6ff');
  const [satLine, satText] = colors(stateWith({ basemap: 'satelit' }));
  assert.equal(satLine, '#7fdbff');
  assert.notEqual(satText, '#1565c0');
  assert.notEqual(satText, satLine);
});

test('main rivers are drawn thicker than their tributaries at every zoom', () => {
  const width = layer(buildStyle(stateWith()), 'hydro-line').paint['line-width'];
  assert.deepEqual(width.slice(0, 3), ['interpolate', ['linear'], ['zoom']]);
  const stops = [];
  for (let i = 3; i < width.length; i += 2) stops.push([width[i], width[i + 1]]);
  assert.deepEqual(stops.map(([zoom]) => zoom), [7, 10, 14]);
  const sizes = [];
  for (const [, expression] of stops) {
    assert.deepEqual(expression.slice(0, 3), ['match', ['get', 'order'], 1]);
    sizes.push({ first: expression[3], second: expression[5], other: expression[6] });
  }
  for (const { first, second, other } of sizes) assert.ok(first > second && second > other, JSON.stringify({ first, second, other }));
  assert.deepEqual(sizes.map(size => size.first), [2, 3, 6]);
  assert.deepEqual(sizes.map(size => size.second), [1.2, 2, 4]);
  assert.deepEqual(sizes.map(size => size.other), [0.6, 1.2, 2.5]);
});

test('the operational decoration keeps both cadastre layers, and the label stays inside a focus', () => {
  const focus = { type: 'Polygon', coordinates: [[[26, 47], [27, 47], [27, 48], [26, 47]]] };
  const style = buildStyle(stateWith({ operations: { focusGeometry: focus } }, { hydrography }));
  assert.ok(layer(style, 'hydro-line'));
  assert.deepEqual(layer(style, 'hydro-label').filter, ['within', focus]);
  assert.ok(index(style, 'hydro-line') < index(style, 'ops-alert-outline'));
});
