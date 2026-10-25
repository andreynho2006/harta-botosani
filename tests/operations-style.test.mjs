import test from 'node:test';
import assert from 'node:assert/strict';
import { decorateOperationalStyle } from '../web/js/operations-style.js';

const fc = features => ({ type: 'FeatureCollection', features });
const layer = (style, id) => style.layers.find(item => item.id === id);
const boundary = { type: 'Polygon', coordinates: [[[26, 47], [27, 47], [27, 48], [26, 47]]] };
const baseStyle = () => ({ version: 8, sources: {}, layers: [
  { id: 'land', type: 'background' },
  { id: 'roads', type: 'line' },
  { id: 'places', type: 'symbol', filter: ['==', ['get', 'visible'], true] },
  { id: 'other-label', type: 'symbol', layout: { visibility: 'none' } },
] });

test('blank state supplies all sources and leaves base label visibility intact', () => {
  const base = baseStyle();
  const style = decorateOperationalStyle(base);
  assert.equal(style, base);
  for (const id of ['ops-features', 'ops-draft', 'ops-selection', 'ops-mask', 'ops-alerts']) {
    assert.deepEqual(style.sources[id], { type: 'geojson', data: fc([]) });
  }
  assert.deepEqual(layer(style, 'places').filter, ['==', ['get', 'visible'], true]);
  assert.equal(layer(style, 'other-label').layout.visibility, 'none');
});

test('blocked roads use black above a wider white halo and resolved roads override black', () => {
  const style = decorateOperationalStyle(baseStyle());
  const road = layer(style, 'ops-features-line');
  const halo = layer(style, 'ops-features-line-halo');
  const expression = road.paint['line-color'];
  assert.equal(expression[0], 'case');
  assert.deepEqual(expression[1], ['==', ['get', 'status'], 'resolved']);
  assert.equal(expression[2], '#23834b');
  const match = expression[3];
  assert.equal(match[match.indexOf('blocked') + 1], '#080808');
  assert.equal(halo.paint['line-color'], '#ffffff');
  assert.deepEqual(road.paint['line-width'].slice(3), [8, 4, 14, 9, 19, 22]);
  assert.deepEqual(halo.paint['line-width'].slice(3), [8, 8, 14, 13, 19, 26]);
  assert.ok(style.layers.indexOf(halo) < style.layers.indexOf(road));
  assert.ok(style.layers.indexOf(road) > style.layers.findIndex(item => item.id === 'places'));
});

test('focus masks exterior labels while retaining original category filters and source data', () => {
  const features = fc([{ type: 'Feature', geometry: { type: 'Point', coordinates: [26, 47] }, properties: { kind: 'fire' } }]);
  const mask = fc([{ type: 'Feature', geometry: boundary, properties: {} }]);
  const selection = fc([{ type: 'Feature', geometry: boundary, properties: {} }]);
  const draft = fc([{ type: 'Feature', geometry: { type: 'Point', coordinates: [26, 47] }, properties: {} }]);
  const style = decorateOperationalStyle(baseStyle(), { theme: 'noapte', operations: { features, mask, selection, draft, focusGeometry: boundary } });
  assert.deepEqual(layer(style, 'places').filter, ['all', ['==', ['get', 'visible'], true], ['within', boundary]]);
  assert.deepEqual(layer(style, 'other-label').filter, ['within', boundary]);
  const ids = style.layers.map(item => item.id);
  assert.ok(ids.indexOf('ops-mask') > ids.indexOf('roads'));
  assert.ok(ids.indexOf('places') > ids.indexOf('ops-mask'));
  assert.ok(ids.indexOf('ops-selection') > ids.indexOf('places'));
  assert.equal(layer(style, 'ops-mask').paint['fill-opacity'], 1);
  assert.equal(layer(style, 'ops-mask').paint['fill-color'], '#161a1f');
  assert.deepEqual(layer(style, 'ops-selection').paint['line-dasharray'], [3, 2]);
  assert.equal(style.sources['ops-draft'].data, draft);
  assert.equal(style.sources['ops-features'].data, features);
  assert.equal(style.sources['ops-selection'].data, selection);
  assert.equal(style.sources['ops-mask'].data, mask);
});

test('stale exterior mask is cleared when focus is disabled and operational labels use bundled font', () => {
  const style = decorateOperationalStyle(baseStyle(), { operations: { mask: fc([{ geometry: boundary }]), focusGeometry: null } });
  assert.deepEqual(style.sources['ops-mask'].data, fc([]));
  assert.deepEqual(style.sources['ops-endpoints'].data, fc([]));
  assert.deepEqual(layer(style, 'ops-features-label').layout['text-font'], ['Noto Sans Medium']);
  assert.ok(layer(style, 'ops-endpoints-circle'));
  assert.ok(layer(style, 'ops-endpoints-label'));
  assert.ok(layer(style, 'ops-alert-fill'));
  assert.equal(layer(style, 'ops-selection-fill'), undefined, 'Single-warning tint layers are gone');
  assert.ok(style.layers.filter(item => item.source === 'ops-draft').every(item => item.id.startsWith('ops-draft')));
});


test('warning tint uses each UAT code colour below roads and labels, in day/night/satellite and focus modes', () => {
  const alerts = fc([{ type: 'Feature', geometry: boundary, properties: { name: 'Botoșani', kind: 'uat', code: 'orange', color: '#ea580c', severity: 2 } }]);
  for (const theme of ['zi', 'noapte']) for (const basemap of ['harta', 'satelit']) for (const focused of [false, true]) {
    const base = baseStyle(), roadBefore = structuredClone(layer(base, 'roads'));
    const style = decorateOperationalStyle(base, { theme, basemap, operations: { alerts, tintAreas: true, focusGeometry: focused ? boundary : null } });
    const fill = layer(style, 'ops-alert-fill'), glow = layer(style, 'ops-alert-glow');
    assert.equal(style.sources['ops-alerts'].data, alerts);
    assert.deepEqual(fill.paint['fill-color'], ['get', 'color']);
    assert.ok(fill.paint['fill-opacity'] > 0);
    assert.deepEqual(glow.paint['line-color'], ['get', 'color']);
    assert.ok(glow.paint['line-opacity'] > 0);
    const ids = style.layers.map(l => l.id);
    for (const id of ['roads', 'places', 'ops-features-line', 'ops-features-label']) {
      assert.ok(ids.indexOf(fill.id) < ids.indexOf(id));
      assert.ok(ids.indexOf(glow.id) < ids.indexOf(id));
    }
    assert.deepEqual(layer(style, 'roads'), roadBefore, 'Base road paint stays unchanged');
    assert.equal(layer(style, 'places').type, 'symbol');
    assert.equal(layer(style, 'ops-selection').paint['line-color'], '#008b9e');
  }
});

test('disabled area tint leaves both fill and glow invisible', () => {
  const style = decorateOperationalStyle(baseStyle(), { operations: { alerts: fc([]), tintAreas: false } });
  assert.equal(layer(style, 'ops-alert-fill').paint['fill-opacity'], 0);
  assert.equal(layer(style, 'ops-alert-glow').paint['line-opacity'], 0);
});
