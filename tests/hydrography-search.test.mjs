import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { hydrography } from './fixtures/synthetic-cadastre.mjs';
import { mainSlice } from './fixtures/main-source.mjs';

// geo.js asks for proj4 at load time; the helpers only use its distance().
globalThis.proj4 = () => ({ forward() {}, inverse() {} });
globalThis.location = { href: 'http://localhost:8000/' };
const { SearchIndex, typeInfo } = await import('../web/js/search.js');
const { courseIndex, courseSearchRows } = await import('../web/js/hydrography-layer.js');

const empty = () => ({ type: 'FeatureCollection', features: [] });
const course = name => hydrography.features.find(f => f.properties.name === name);
const plain = value => JSON.parse(JSON.stringify(value));
const indexOf = rows => { const index = new SearchIndex(); index.add(rows); return index; };

test('a cadastre course is typed as a river from the cadastre', () => {
  assert.deepEqual(typeInfo('cad'), { label: 'Râu (cadastru)', cls: 't-apa' });
});

test('the search finds a course by its name, without diacritics, and by an alternate name', () => {
  const index = indexOf(courseSearchRows(hydrography));
  assert.equal(index.query('baseu')[0].ref, 'RO_XIII_1.10');
  assert.equal(index.query('Bașeu')[0].label, 'Bașeu');
  // "Sihna" is only an alternate name of the Sitna
  const hits = index.query('sihna');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].label, 'Sitna');
  assert.equal(hits[0].type, 'cad');
  assert.deepEqual(index.query('baseu mare').map(hit => hit.label), ['Bașeu']);
  // the tributaries of a river are found through the receiving river in the context (and the Prut itself, by its name)
  assert.deepEqual(index.query('afluent prut').map(hit => hit.label).sort(), ['Bașeu', 'Jijia', 'Prut']);
});

test('for the same name a cadastre course outranks the OSM river and ranks below a hydrant', () => {
  const rows = [
    ['Jijia', 'apa:rau', 26.6, 47.7, 'Hârlău', [26.5, 47.6, 26.7, 47.8], 'w100'],
    ['Jijia', 'hid', 26.61, 47.71, '', null, 7],
    ...courseSearchRows(hydrography).filter(row => row[0] === 'Jijia'),
  ];
  assert.deepEqual(indexOf(rows).query('jijia').map(hit => hit.type), ['hid', 'cad', 'apa:rau']);
});

// ------------------------------------------------------------------ main.js wiring

function replace(fc, { withMap = true, operations } = {}) {
  const calls = { data: [], info: 0, panel: 0, style: 0 };
  const search = indexOf([
    ['Jijia', 'cad', 1, 1, '', null, 'RO_OLD'], ['Hidrant 7', 'hid', 2, 2, '', null, 7], ['Pârâul Vechi', 'apa:parau', 3, 3, '', null, 'w1'],
  ]);
  const state = { data: { hydrography: empty() }, operations };
  const map = withMap ? { getSource: id => (id === 'hydrography' ? { setData: data => calls.data.push(data) } : null) } : undefined;
  vm.runInNewContext(`${mainSlice('function replaceHydrography(', '/** Aplică lista de subunități')}\nreplaceHydrography(fc);`, {
    fc, state, map, search, courseSearchRows, updateDataInfo: () => calls.info++, renderLayerPanel: () => calls.panel++,
    applyStyle: () => calls.style++,
  });
  return { calls, search, state };
}

test('replacing the hydrography updates the source, the search rows, the data line and the panel', () => {
  const { calls, search, state } = replace(hydrography);
  assert.equal(state.data.hydrography, hydrography);
  assert.deepEqual(calls.data, [hydrography]);
  assert.equal(calls.info, 1);
  assert.equal(calls.panel, 1);
  const cad = search.items.filter(it => it.type === 'cad');
  assert.deepEqual(cad.map(it => it.ref), hydrography.features.map(f => f.properties.code));
  // the other kinds of rows stay
  assert.deepEqual(search.items.filter(it => it.type !== 'cad').map(it => it.label), ['Hidrant 7', 'Pârâul Vechi']);
});

test('replacing the hydrography inside a focus rebuilds the style, because the focus labels come from a cut copy of it', () => {
  const focus = { type: 'Polygon', coordinates: [[[26, 47], [27, 47], [27, 48], [26, 47]]] };
  assert.equal(replace(hydrography, { operations: { focusGeometry: focus } }).calls.style, 1);
  assert.equal(replace(hydrography, { operations: { focusGeometry: null } }).calls.style, 0);
  assert.equal(replace(hydrography).calls.style, 0);
});

test('replacing the hydrography before the map exists, or with an empty one, still works', () => {
  const early = replace(hydrography, { withMap: false });
  assert.equal(early.calls.panel, 1);
  assert.equal(early.search.items.filter(it => it.type === 'cad').length, hydrography.features.length);
  assert.equal(replace(empty()).search.items.filter(it => it.type === 'cad').length, 0);
});

test('the boot adds the course rows right after the hydrants', () => {
  const init = mainSlice('async function init(', '// ------------------------------------------------------------------ telefon');
  const hydrants = init.indexOf('search.add(hydrantSearchRows());');
  assert.ok(hydrants > 0);
  assert.ok(init.indexOf('search.add(courseSearchRows(state.data.hydrography));') > hydrants);
  assert.ok(init.indexOf('state.data.hydrography = hydrography;') < hydrants, 'the rows are built from the loaded cadastre');
});

const chooseSource = mainSlice('const choose = (r) => {', '  input.addEventListener("input"');

function choose(row, { visible = false, hydro = hydrography } = {}) {
  const calls = { overlays: [], infos: [], fits: [], flies: [], stores: [], styles: 0, panels: 0, closed: 0 };
  const state = { visible: { cadastru: visible }, data: { hydrography: hydro, hydrants: empty(), pois: empty() } };
  const list = {};
  vm.runInNewContext(`${chooseSource}\nchoose(row);`, {
    row, state, list, input: { blur() {} }, FC: empty, courseIndex,
    setOverlay: (name, fc) => calls.overlays.push([name, fc]), showInfo: (f, ll) => calls.infos.push([f, ll]),
    closeInfo: () => calls.closed++, setSheet() {}, viewPadding: () => ({ top: 1 }),
    store: { set: (key, value) => calls.stores.push([key, plain(value)]) },
    applyStyle: () => calls.styles++, renderLayerPanel: () => calls.panels++,
    map: { fitBounds: (bounds, options) => calls.fits.push([bounds, options]), flyTo: options => calls.flies.push(options) },
  });
  return { calls, state, list };
}

const rowFor = query => indexOf(courseSearchRows(hydrography)).query(query)[0];

test('choosing a course shows its sheet at the anchor, without a pin, and fits the course up to zoom 13', () => {
  const row = rowFor('prut');
  const { calls, list } = choose(row, { visible: true });
  assert.equal(list.hidden, true);
  assert.deepEqual(plain(calls.overlays), [['pin', empty()]]);
  assert.equal(calls.infos.length, 1);
  const [feature, ll] = calls.infos[0];
  assert.deepEqual(plain(ll), [row.lon, row.lat]);
  assert.equal(feature.layer.id, 'hydro-line');
  // the whole feature, with its arrays, not the search row
  assert.deepEqual(plain(feature.geometry), plain(course('Prut').geometry));
  assert.deepEqual(feature.properties.uats, course('Prut').properties.uats);
  assert.deepEqual(plain(calls.fits), [[[[26.5, 47], [26.8, 47.6]], { padding: { top: 1 }, maxZoom: 13, duration: 800 }]]);
  assert.equal(calls.flies.length, 0);
});

test('choosing a course turns the layer on when it is off, and remembers that', () => {
  const { calls, state } = choose(rowFor('sitna'), { visible: false });
  assert.equal(state.visible.cadastru, true);
  assert.deepEqual(calls.stores, [['visible.v2', { cadastru: true }]]);
  assert.equal(calls.styles, 1);
  assert.equal(calls.panels, 1);
  assert.equal(calls.infos.length, 1);
  const already = choose(rowFor('sitna'), { visible: true });
  assert.deepEqual([already.calls.stores.length, already.calls.styles, already.calls.panels], [0, 0, 0]);
});

test('choosing a course that is no longer loaded closes the sheet and leaves the layer alone', () => {
  const { calls, state } = choose(rowFor('sitna'), { hydro: empty() });
  assert.equal(calls.infos.length, 0);
  assert.equal(calls.closed, 1);
  assert.equal(state.visible.cadastru, false);
  assert.equal(calls.styles, 0);
});

test('choosing any other result keeps its pin and its zoom limit', () => {
  const village = { label: 'Cetate', type: 'loc:village', lon: 26.4, lat: 47.5, ctx: '', bbox: [26.39, 47.49, 26.41, 47.51] };
  const { calls } = choose(village);
  assert.equal(calls.overlays[0][1].features[0].geometry.type, 'Point');
  assert.deepEqual(plain(calls.overlays[0][1].features[0].geometry.coordinates), [26.4, 47.5]);
  assert.equal(calls.fits[0][1].maxZoom, 17);
  assert.equal(calls.infos.length, 0);
});
