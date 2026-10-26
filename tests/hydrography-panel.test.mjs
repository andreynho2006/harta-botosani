import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { emptyHydrography, hydrography } from './fixtures/synthetic-cadastre.mjs';
import { mainSlice } from './fixtures/main-source.mjs';

globalThis.location = { href: 'http://localhost:8000/' };
const { LAYER_GROUPS, LAYER_PRESETS, itemLabel } = await import('../web/js/config.js');
const { PALETTES } = await import('../web/js/style.js');

const empty = () => ({ type: 'FeatureCollection', features: [] });
const panel = mainSlice('function swatch(', 'function renderLayerPanelHeaders(');

function render({ theme = 'zi', data = emptyHydrography } = {}) {
  const el = { innerHTML: '' };
  const state = {
    theme, visible: Object.fromEntries(LAYER_GROUPS.flatMap(group => group.items.map(item => [item.id, item.on]))),
    data: { pois: empty(), hydrants: empty(), hydrography: data },
  };
  vm.runInNewContext(panel + '\nrenderLayerPanel();', {
    $: () => el, state, stats: null, PALETTES, LAYER_GROUPS, LAYER_PRESETS, itemLabel, esc: String,
    iconDataURL: () => 'data:,', store: { set() {} }, applyStyle() {}, renderLayerPanelHeaders() {},
  });
  const [row, after] = el.innerHTML.slice(el.innerHTML.indexOf('data-id="cadastru"')).split('</label>');
  return { row, after };
}

test('the cadastre item is listed unchecked, with a line swatch in the theme colour and the course count', () => {
  const { row } = render({ data: hydrography });
  assert.ok(row.includes('Hidrografie (cadastru)'));
  assert.ok(!row.includes('checked'));
  assert.ok(row.includes(`height:3px;background:${PALETTES.zi.hydro}`));
  assert.ok(row.includes(`<span class="cnt">${hydrography.features.length}</span>`));
  assert.ok(render({ theme: 'noapte', data: hydrography }).row.includes(`background:${PALETTES.noapte.hydro}`));
});

test('without a cadastre the item says so, like the hydrants do, and with one it stays quiet', () => {
  const missing = render();
  assert.ok(missing.after.includes('<div class="note">Cadastrul apelor nu este încărcat.</div>'));
  assert.ok(missing.row.includes('<span class="cnt">0</span>'));
  assert.ok(!render({ data: hydrography }).after.includes('Cadastrul apelor'));
});
