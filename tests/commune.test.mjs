import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

globalThis.location = { href: 'http://localhost:8000/' };
const { buildCommuneStyle } = await import('../web/js/commune.js');
const { LAYER_GROUPS } = await import('../web/js/config.js');
const empty = () => ({ type: 'FeatureCollection', features: [] });
const point = (coordinates) => ({ type: 'Feature', properties: {cat: 'pompieri'}, geometry: { type: 'Point', coordinates } });
const feature = { type: 'Feature', properties: { name: 'Example', kind: 'uat' }, geometry: {
  type: 'Polygon', coordinates: [[[26,47],[26.02,47],[26.02,47.02],[26,47.02],[26,47]]],
} };
const uat = { name: 'Example', feature };
const state = {
  theme: 'zi', basemap: 'harta', visible: Object.fromEntries(LAYER_GROUPS.flatMap(g => g.items.map(it => [it.id,it.on]))),
  data: { pois: { ...empty(), features: [point([26.01,47.01]),point([26.03,47.01])] },
    hydrants: { ...empty(), features: [point([26.01,47.01]),point([26.03,47.01])] }, admin: { ...empty(), features: [feature] } },
  overlays: { sel: empty(), analysis: empty(), measure: empty(), pin: empty() }, hoverUat: 'Other',
};

test('commune style isolates points and labels without changing the main map state', () => {
  const before = JSON.stringify(state);
  const style = buildCommuneStyle(uat, state);
  assert.equal(style.sources.pois.data.features.length, 1);
  assert.equal(style.sources.hydrants.data.features.length, 1);
  assert.equal(style.sources.admin.data.features.length, 1);
  for (const id of ['uat-line', 'county-line', 'uat-hover']) assert.equal(style.layers.some(l => l.id === id), false);
  assert.deepEqual(style.layers.find(l => l.id === 'places').filter, ['within', feature.geometry]);
  const maskIndex = style.layers.findIndex(l => l.id === 'commune-mask');
  assert.ok(style.layers.findIndex(l => l.id === 'roads') < maskIndex);
  assert.ok(style.layers.findIndex(l => l.id === 'commune-exits') > maskIndex);
  assert.ok(style.layers.findIndex(l => l.id === 'places') > maskIndex);
  assert.equal(JSON.stringify(state), before);
});

test('commune style keeps active road filters and supports night and satellite maps', () => {
  const style = buildCommuneStyle(uat, { ...state, theme: 'noapte', basemap: 'satelit' });
  assert.equal(style.layers.find(l => l.id === 'sat').layout.visibility, 'visible');
  assert.equal(style.layers.find(l => l.id === 'commune-mask').paint['fill-color'], '#161a1f');
  assert.ok(!JSON.stringify(style.layers.find(l => l.id === 'roads').filter).includes('service'));
  assert.equal(style.sources.sel.data.features.length, 0);
});

const main = readFileSync(new URL('../web/js/main.js', import.meta.url), 'utf8');
test('point information offers the correct commune action only inside a UAT', () => {
  const source = main.slice(main.indexOf('function showInfo('), main.indexOf('function closeInfo('));
  for (const selected of [uat, null]) {
    const box = { innerHTML: '', hidden: true };
    const calls = [];
    vm.runInNewContext(source + '\nshowInfo(null, [26.01,47.01]);', {
      $: () => box, uatAt: () => selected, state, icons: {}, esc: String, setOverlay() {},
      osmLink: () => null, ICON: {}, coordsBlock: () => '', extLinks: () => '', setSheet() {},
      openCommuneMap: options => calls.push(options),
    });
    assert.equal(box.innerHTML.includes('data-act="commune"'), !!selected);
    if (selected) {
      box.onclick({target:{closest:()=>({dataset:{act:'commune'}})}});
      assert.equal(calls.length, 1);
      assert.equal(calls[0].uat, uat);
      assert.equal(calls[0].state, state);
    }
  }
});
