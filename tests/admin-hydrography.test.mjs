import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// Doar date sintetice: niciun nume, cod sau coordonată din cadastrul ABA real.
const authSource = await readFile(new URL('../web/js/auth.js', import.meta.url), 'utf8');
const geoSource = await readFile(new URL('../web/js/geo.js', import.meta.url), 'utf8');
const adminSource = await readFile(new URL('../web/js/admin.js', import.meta.url), 'utf8');
const mainSource = await readFile(new URL('../web/js/main.js', import.meta.url), 'utf8');

// geo.js cere proj4 la încărcare; de ea avem nevoie doar de distance().
const distanceSource = geoSource.slice(geoSource.indexOf('const R ='), geoSource.indexOf('export function bearing'));
const downloads = [], blobs = new Map();
const context = vm.createContext({
  crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, btoa, atob, structuredClone,
  Blob: class { constructor(parts) { this.json = parts.join(''); } },
  URL: { createObjectURL: blob => { const url = `blob:test-${blobs.size}`; blobs.set(url, blob); return url; }, revokeObjectURL() {} },
  document: { createElement: () => ({ click() { downloads.push({ name: this.download, json: blobs.get(this.href).json }); } }) },
  setTimeout: callback => callback(),
});
vm.runInContext([
  authSource.replace(/\bexport\s+/g, ''),
  distanceSource.replace(/\bexport\s+/g, ''),
  adminSource.replace(/^import .*;\n/gm, '').replace(/\bexport\s+/g, ''),
  'globalThis.api = { readHydrography, renderAdmin, encryptJSON, decryptJSON };',
].join('\n'), context);
const { readHydrography, renderAdmin, encryptJSON, decryptJSON } = context.api;
const key = webcrypto.getRandomValues(new Uint8Array(32));

// 0,01 grade de latitudine = 1,11195 km pe sfera folosită de distance()
const KM_PER_HUNDREDTH_DEGREE = 1.11195;

function synthetic(extra = {}) {
  return {
    type: 'FeatureCollection', format: 'harta-botosani-hydrography', version: 1,
    source: 'Sursă sintetică', generated: '2026-01-01T00:00Z',
    features: [
      { type: 'Feature',
        properties: { name: 'Râul Probă', aba: 'RAUL PROBA (PROBA)', alt: ['Proba'], code: 'RO_TEST_1', parent: null, order: 1, lengthKm: 12, basinKm2: 40, uats: ['Alfa', 'Beta'] },
        geometry: { type: 'MultiLineString', coordinates: [[[26, 47], [26, 47.01]], [[26.1, 47], [26.1, 47.02]]] } },
      { type: 'Feature',
        properties: { name: 'Pârâul Test', aba: 'PARAUL TEST', alt: [], code: 'RO_TEST_1.2', parent: 'Râul Probă', order: 2, lengthKm: 3, basinKm2: 5, uats: ['Beta', 'Gama'] },
        geometry: { type: 'LineString', coordinates: [[26.2, 47], [26.2, 47.01]] } },
    ],
    ...extra,
  };
}

function withFeature(patch, geometry) {
  const fc = synthetic();
  Object.assign(fc.features[0].properties, patch);
  if (geometry !== undefined) fc.features[0].geometry = geometry;
  return JSON.stringify(fc);
}

test('a valid hydrography file is summarized and returned unchanged', () => {
  const fc = synthetic();
  const r = readHydrography(JSON.stringify(fc));
  assert.equal(r.count, 2);
  assert.equal(r.uats, 3);
  assert.equal(r.source, 'Sursă sintetică');
  assert.equal(r.generated, '2026-01-01T00:00Z');
  assert.deepEqual(JSON.parse(JSON.stringify(r.fc)), fc);
  // 0,01° + 0,02° (primul curs) + 0,01° (al doilea)
  assert.ok(Math.abs(r.km - 4 * KM_PER_HUNDREDTH_DEGREE) < 0.01, `km = ${r.km}`);
});

test('source and generated are optional', () => {
  const fc = synthetic();
  delete fc.source;
  delete fc.generated;
  const r = readHydrography(JSON.stringify(fc));
  assert.equal(r.source, '');
  assert.equal(r.generated, '');
  assert.equal(r.count, 2);
});

test('invalid hydrography files are refused with a Romanian message', () => {
  const cases = [
    ['not JSON', 'nu e json', /nu este JSON valid/],
    ['JSON null', 'null', /Nu este un fișier de hidrografie/],
    ['another file format', JSON.stringify({ type: 'FeatureCollection', features: [] }), /Nu este un fișier de hidrografie/],
    ['a different format', JSON.stringify({ ...synthetic(), format: 'harta-botosani-events' }), /Nu este un fișier de hidrografie/],
    ['missing version', JSON.stringify({ ...synthetic(), version: undefined }), /Versiunea necunoscută/],
    ['unknown version', JSON.stringify({ ...synthetic(), version: 2 }), /Versiunea 2 nu este acceptată/],
    ['no features', JSON.stringify({ ...synthetic(), features: [] }), /niciun curs de apă/],
    ['features not a list', JSON.stringify({ ...synthetic(), features: {} }), /niciun curs de apă/],
    ['missing name', withFeature({ name: undefined }), /Cursul 1: lipsește numele/],
    ['blank name', withFeature({ name: '   ' }), /Cursul 1: lipsește numele/],
    ['missing code', withFeature({ code: undefined }), /Cursul 1 \(Râul Probă\): lipsește codul/],
    ['uats not a list', withFeature({ uats: 'Alfa' }), /Cursul 1 \(Râul Probă\): lista de UAT-uri nu este validă/],
    ['uats with a non-string', withFeature({ uats: ['Alfa', 7] }), /lista de UAT-uri nu este validă/],
    ['missing uats', withFeature({ uats: undefined }), /lista de UAT-uri nu este validă/],
    ['point geometry', withFeature({}, { type: 'Point', coordinates: [26, 47] }), /geometria nu este o linie validă/],
    ['no geometry', withFeature({}, null), /geometria nu este o linie validă/],
    ['no lines', withFeature({}, { type: 'MultiLineString', coordinates: [] }), /geometria nu este o linie validă/],
    ['a one-point line', withFeature({}, { type: 'MultiLineString', coordinates: [[[26, 47]]] }), /geometria nu este o linie validă/],
    ['a text coordinate', withFeature({}, { type: 'LineString', coordinates: [[26, 47], ['x', 47.1]] }), /geometria nu este o linie validă/],
    ['an out-of-range coordinate', withFeature({}, { type: 'LineString', coordinates: [[26, 47], [260, 47.1]] }), /geometria nu este o linie validă/],
  ];
  for (const [label, text, message] of cases) {
    assert.throws(() => readHydrography(text), err => err.name === 'Error' && message.test(err.message), label);
  }
  const second = synthetic();
  second.features[1] = { type: 'Feature', properties: null, geometry: second.features[1].geometry };
  assert.throws(() => readHydrography(JSON.stringify(second)), { message: /Cursul 2: nu este un obiect GeoJSON valid/ });
});

test('the encrypted hydrography round-trips with the data key and hides the names', async () => {
  const fc = synthetic();
  const box = await encryptJSON(key, fc);
  assert.deepEqual(Object.keys(box).sort(), ['ct', 'iv', 'v']);
  const file = JSON.stringify(box, null, 1);
  assert.ok(!file.includes('Probă') && !file.includes('RO_TEST') && !file.includes('26.1'));
  assert.deepEqual(JSON.parse(JSON.stringify(await decryptJSON(key, JSON.parse(file)))), fc);
  await assert.rejects(decryptJSON(webcrypto.getRandomValues(new Uint8Array(32)), JSON.parse(file)));
});

function adminHarness() {
  const nodes = { '#adm-hyd': { innerHTML: '' }, '#adm-hyd-now': { textContent: '' } };
  let html = '';
  const toasts = [], used = [];
  const el = {
    set innerHTML(value) { html = value; },
    get innerHTML() { return html; },
    querySelector: selector => nodes[selector],
    querySelectorAll: () => [],
  };
  const session = { u: 'administrator', key, users: { iterations: 1000, users: [] } };
  renderAdmin(el, {
    session, toast: text => toasts.push(text), copy() {},
    state: { data: { hydrants: { features: [] }, hydrography: { features: [] } } },
    onHydrography: fc => used.push(fc),
  });
  const choose = (text, name = 'hidrografie-test.geojson') =>
    el.onchange({ target: { id: 'adm-hydro-file', files: [{ name, text: async () => text }] } });
  const click = act => el.onclick({ target: { closest: () => ({ dataset: { act }, disabled: false }) } });
  return { el, nodes, toasts, used, choose, click, get html() { return html; } };
}

test('the Administrare panel has a Hidrografie section that keeps the clear file local', () => {
  const h = adminHarness();
  assert.match(h.html, /<h3>Hidrografie \(cadastrul apelor\)<\/h3>/);
  assert.match(h.html, /id="adm-hydro-file"[^>]*accept="\.geojson,\.json"/);
  assert.match(h.html, /Fișierul clar nu părăsește calculatorul\. Se urcă doar varianta criptată\./);
  assert.ok(h.html.indexOf('<h3>Hidranți</h3>') < h.html.indexOf('<h3>Hidrografie (cadastrul apelor)</h3>'));
  assert.equal(h.nodes['#adm-hyd'].innerHTML, '');
});

test('a chosen file is summarized, used in the session and downloaded only encrypted', async () => {
  downloads.length = 0;
  const h = adminHarness();
  const fc = synthetic();
  await h.choose(JSON.stringify(fc));
  const summary = h.nodes['#adm-hyd'].innerHTML;
  assert.match(summary, /Râuri \(cursuri de apă\)<\/dt><dd>2<\/dd>/);
  assert.match(summary, /UAT-uri atinse<\/dt><dd>3<\/dd>/);
  assert.match(summary, /Sursă sintetică/);
  assert.match(summary, /Folosește în această sesiune/);
  assert.match(summary, /Descarcă hidrografie\.enc/);

  await h.click('show-hydro');
  assert.equal(h.used.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.used[0])), fc);
  assert.equal(h.toasts.length, 1);
  assert.equal(downloads.length, 0);

  await h.click('dl-hydro');
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].name, 'hidrografie.enc');
  assert.ok(!downloads[0].json.includes('Probă'));
  assert.deepEqual(JSON.parse(JSON.stringify(await decryptJSON(key, JSON.parse(downloads[0].json)))), fc);
});

test('an invalid file shows its error and offers neither use nor download', async () => {
  downloads.length = 0;
  const h = adminHarness();
  await h.choose(withFeature({ code: undefined }));
  assert.match(h.nodes['#adm-hyd'].innerHTML, /class="warnp">Cursul 1 \(Râul Probă\): lipsește codul\./);
  await h.click('show-hydro');
  await h.click('dl-hydro');
  assert.equal(h.used.length, 0);
  assert.equal(downloads.length, 0);
  // un fișier valid ales după unul greșit înlocuiește eroarea
  await h.choose(JSON.stringify(synthetic()));
  assert.doesNotMatch(h.nodes['#adm-hyd'].innerHTML, /warnp/);
  // iar unul greșit ales după el nu lasă în urmă un fișier de descărcat
  await h.choose('nu e json');
  await h.click('dl-hydro');
  assert.equal(downloads.length, 0);
});

function mainHarness({ fetchImpl, sessionKey = key } = {}) {
  const warnings = [];
  const loaders = vm.createContext({
    session: { key: sessionKey }, FC: () => ({ type: 'FeatureCollection', features: [] }),
    fetch: fetchImpl, decryptJSON, console: { warn: (...args) => warnings.push(args) },
  });
  vm.runInContext(mainSource.slice(mainSource.indexOf('/** Descarcă și decriptează'), mainSource.indexOf('function hydrantSearchRows')) +
    '\nglobalThis.api = { loadHydrants, loadHydrography };', loaders);
  return { warnings, ...loaders.api };
}

const served = async obj => ({ ok: true, json: async () => JSON.parse(JSON.stringify(await encryptJSON(key, obj))) });

test('main loads data/hidrografie.enc as an empty collection when it is missing', async () => {
  const requested = [];
  const h = mainHarness({ fetchImpl: async path => { requested.push(path); return { ok: false, status: 404 }; } });
  assert.deepEqual(JSON.parse(JSON.stringify(await h.loadHydrography())), { type: 'FeatureCollection', features: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(await h.loadHydrants())), { type: 'FeatureCollection', features: [] });
  assert.deepEqual(requested, ['data/hidrografie.enc', 'data/hidranti.enc']);
  assert.equal(h.warnings.length, 0);
});

test('main decrypts data/hidrografie.enc and keeps only the hydrography format', async () => {
  const fc = synthetic();
  const h = mainHarness({ fetchImpl: async path => served(path.includes('hidrografie') ? fc : { type: 'FeatureCollection', features: [{ id: 0 }] }) });
  assert.deepEqual(JSON.parse(JSON.stringify(await h.loadHydrography())), fc);
  assert.equal((await h.loadHydrants()).features.length, 1);

  const foreign = mainHarness({ fetchImpl: async () => served({ type: 'FeatureCollection', format: 'altceva', features: [{}] }) });
  assert.equal((await foreign.loadHydrography()).features.length, 0);
  const noFeatures = mainHarness({ fetchImpl: async () => served({ format: 'harta-botosani-hydrography' }) });
  assert.deepEqual(JSON.parse(JSON.stringify(await noFeatures.loadHydrography())), { type: 'FeatureCollection', features: [] });
  assert.equal(h.warnings.length + foreign.warnings.length + noFeatures.warnings.length, 0);
});

test('main warns only when the encrypted hydrography cannot be decrypted', async () => {
  const wrongKey = mainHarness({ sessionKey: webcrypto.getRandomValues(new Uint8Array(32)), fetchImpl: async () => served(synthetic()) });
  assert.equal((await wrongKey.loadHydrography()).features.length, 0);
  assert.equal(wrongKey.warnings.length, 1);
  assert.match(wrongKey.warnings[0][0], /Nu pot decripta hidrografia/);

  const garbled = mainHarness({ fetchImpl: async () => ({ ok: true, json: async () => ({ v: 1, iv: 'AAAA', ct: 'AAAA' }) }) });
  assert.equal((await garbled.loadHydrants()).features.length, 0);
  assert.match(garbled.warnings[0][0], /Nu pot decripta hidranții/);

  const offline = mainHarness({ fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal((await offline.loadHydrography()).features.length, 0);
  assert.equal(offline.warnings.length, 1);
});

test('the data line names the rivers only when the hydrography is loaded', () => {
  const source = mainSource.slice(mainSource.indexOf('function updateDataInfo()'), mainSource.indexOf('/** Înlocuiește hidranții afișați')) +
    mainSource.slice(mainSource.indexOf('/** Înlocuiește hidrografia încărcată'), mainSource.indexOf('/** Aplică lista de subunități ISU'));
  const line = { textContent: '' };
  const state = { data: { hydrants: { features: [] }, hydrography: { features: [] } } };
  const ctx = vm.createContext({ $: () => line, stats: null, state });
  vm.runInContext(source + '\nglobalThis.api = { updateDataInfo, replaceHydrography };', ctx);
  ctx.api.updateDataInfo();
  assert.equal(line.textContent, 'Date OSM din – · fără listă de hidranți');
  const fc = synthetic();
  ctx.api.replaceHydrography(fc);
  assert.equal(state.data.hydrography, fc);
  assert.equal(line.textContent, 'Date OSM din – · fără listă de hidranți · 2 râuri (cadastru ABA)');
  state.data.hydrants.features.push({});
  ctx.api.updateDataInfo();
  assert.equal(line.textContent, 'Date OSM din – · 1 hidranți · 2 râuri (cadastru ABA)');
});
