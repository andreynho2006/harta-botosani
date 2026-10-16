import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/js/restrictions.js', import.meta.url), 'utf8');
const { formatRestriction } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('original restrictions preserve explicit units and special values', () => {
  for (const value of ['7500 kg', '7.5 t', `12'6"`, '3.8 m', 'none', 'default', '7.5;12']) {
    assert.equal(formatRestriction({ maxweight_raw: value }, 'maxweight', 't'), value);
  }
  assert.equal(formatRestriction({ maxheight_raw: `12'6"` }, 'maxheight', 'm'), `12'6"`);
});

test('original unitless numbers display OSM default units', () => {
  assert.equal(formatRestriction({ maxweight_raw: '7.5' }, 'maxweight', 't'), '7.5 t');
  assert.equal(formatRestriction({ maxheight_raw: ' 3.8 ' }, 'maxheight', 'm'), '3.8 m');
  assert.equal(formatRestriction({ maxwidth_raw: '2,5' }, 'maxwidth', 'm'), '2,5 m');
});

test('legacy stripped values never acquire an assumed unit', () => {
  for (const [key, value, unit] of [['maxweight', '7500', 't'], ['maxheight', '12', 'm']]) {
    assert.equal(formatRestriction({ [key]: value }, key, unit), `${value} (unitate neverificată)`);
  }
  assert.equal(formatRestriction({ maxheight: '12', maxheight_raw: `12'6"` }, 'maxheight', 'm'), `12'6"`);
  assert.equal(formatRestriction({}, 'maxweight', 't'), null);
});

test('OSM hydrants stay hidden even with previously saved visibility', () => {
  const configSource = readFileSync(new URL('../web/js/config.js', import.meta.url), 'utf8');
  const config = vm.runInNewContext(configSource.replaceAll('export ', '') + '\n({POI, LAYER_GROUPS})');
  const styleSource = readFileSync(new URL('../web/js/style.js', import.meta.url), 'utf8');
  const poiFilter = vm.runInNewContext(styleSource.slice(styleSource.indexOf('export function poiFilter'), styleSource.indexOf('const FONT')).replace('export ', '') + '\npoiFilter', { POI: config.POI });
  const filter = poiFilter({ visible: { 'poi:hidrant_osm': true, 'poi:sursa_apa': true } }, false);
  assert.equal(filter[2][1].includes('hidrant_osm'), false);
  assert.equal(filter[2][1].includes('sursa_apa'), true);
  assert.equal(config.LAYER_GROUPS.some(group => group.items.some(item => item.id === 'poi:hidrant_osm')), false);
});

test('startup removes OSM hydrants from POIs and search while preserving ISU hydrants', async () => {
  const main = readFileSync(new URL('../web/js/main.js', import.meta.url), 'utf8');
  const initSource = main.slice(main.indexOf('async function init()'), main.indexOf('// ------------------------------------------------------------------ telefon'));
  const pois = { type: 'FeatureCollection', features: [
    { id: 1, properties: { cat: 'hidrant_osm' } },
    { id: 2, properties: { cat: 'sursa_apa' } },
  ] };
  const rows = [['OSM hydrant', 'poi:hidrant_osm'], ['Water source', 'poi:sursa_apa']];
  const isu = { features: [{ id: 3, properties: { _label: 'ISU hydrant' } }] };
  const state = { data: {} };
  const added = [];
  const noop = () => {};
  const context = vm.createContext({
    ensureLogin: async () => ({ name: 'Test', role: 'user' }), session: null,
    $: () => ({ addEventListener: noop }), esc: String,
    logout: noop, FC: () => ({ features: [] }), loadHydrants: async () => isu,
    loadJSON: async path => path.includes('pois') ? pois : path.includes('search') ? rows : { features: [] },
    state, prepareHydrants: fc => fc, stats: null, uatAt: null, makeUatLookup: noop,
    search: { add: items => added.push(...items) }, hydrantSearchRows: () => [['ISU hydrant', 'hid']],
    updateDataInfo: noop, renderLayerPanel: noop, renderAnalysis: noop,
    map: {}, toast: noop, selectTab: noop, setSheet: noop, applyStyle: noop,
    initSheet: noop, initMap: noop, initSearch: noop, initUI: noop, initOperations: noop,
  });
  await vm.runInContext(initSource + '\ninit()', context);
  assert.equal(state.data.pois.features.length, 1);
  assert.equal(state.data.pois.features[0].properties.cat, 'sursa_apa');
  assert.equal(state.data.hydrants, isu);
  assert.equal(added.some(row => row[1] === 'poi:hidrant_osm'), false);
  assert.equal(added.some(row => row[1] === 'hid'), true);
});
