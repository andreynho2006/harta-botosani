import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chrome, skipWithoutChrome } from './chrome.mjs';


// Runs in the page: boots the real initOperations against a stub map and reports which
// focus outlines the selection source hands to the style (it hides those with alert=true).
async function browserChecks({ initOperations, createEvent }) {
  const out = document.querySelector('#results');
  try {
    const square = (x, y) => ({ type: 'Polygon', coordinates: [[[x, y], [x + 0.2, y], [x + 0.2, y + 0.2], [x, y + 0.2], [x, y]]] });
    const admin = { features: [
      { type: 'Feature', properties: { kind: 'uat', name: 'Curtești' }, geometry: square(26.5, 47.7) },
      { type: 'Feature', properties: { kind: 'uat', name: 'Flămânzi' }, geometry: square(26.8, 47.5) },
    ] };
    const localities = [
      { name: 'Agafton', lon: 26.6, lat: 47.8, uat: 'Curtești' }, { name: 'Vârfu', lon: 26.55, lat: 47.75, uat: 'Curtești' },
      { name: 'Poiana', lon: 26.9, lat: 47.6, uat: 'Flămânzi' },
    ];
    const warn = (id, code, areas, places = []) => ({ id, code, source: 'ANM', validFrom: '2026-10-17T06:00:00Z', validTo: '2026-10-17T20:00:00Z', text: '', areas, places });
    const scenarios = {
      // The regression: a focused village inside a warned UAT, with no village warning of its own.
      villageInWarnedUat: { places: ['Agafton'], alerts: [warn('w1', 'orange', ['Curtești'])] },
      // Warned at the UAT's own level: merged into the UAT outline, so its circle must still show.
      villageAbsorbed: { places: ['Agafton'], alerts: [warn('w1', 'orange', ['Curtești'], ['Agafton|Curtești'])] },
      // Warned more severely: it has an outline of its own, so the circle steps aside.
      villageOutlined: { places: ['Agafton'], alerts: [warn('w1', 'orange', ['Curtești']), warn('w2', 'red', [], ['Agafton|Curtești'])] },
      villageUnwarned: { places: ['Poiana'], alerts: [warn('w1', 'orange', ['Curtești'])] },
      uatFocus: { areas: ['Curtești'], alerts: [warn('w1', 'orange', ['Curtești'])] },
    };
    const result = {};
    for (const [name, scenario] of Object.entries(scenarios)) {
      const active = createEvent('Focus outline ' + name, 'snow');
      Object.assign(active, { areas: scenario.areas || [], places: scenario.places || [], alerts: scenario.alerts, isolateArea: true });
      const memory = new Map([['hb.ops.session.v1', JSON.stringify({ active })]]);
      const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
      const noop = () => {};
      const map = {
        on: noop, getSource: noop, getLayer: noop, getCenter: () => ({ lng: 26.6, lat: 47.7 }), getZoom: () => 8, getBearing: () => 0, getPitch: () => 0,
        getPadding: () => ({}), getContainer: () => document.querySelector('#map'), fitBounds: noop, setPadding: noop, resize: noop, jumpTo: noop,
      };
      const state = { data: { admin, localities }, visible: {}, overlays: {}, basemap: 'harta', theme: 'zi' };
      document.querySelector('#tab-situatii').replaceChildren();
      initOperations({ map, storage, state, toast: noop, selectTab: noop, applyStyle: noop, renderLayerPanel: noop });
      result[name] = state.operations.selection.features.map(f => f.properties.kind + ':' + f.properties.name + ':' + f.properties.alert);
    }

    // "Focalizează UAT" from the map while a situation is open is a view, not an edit.
    {
      const active = createEvent('View focus', 'snow');
      Object.assign(active, { areas: [], places: ['Poiana'], alerts: [warn('w1', 'orange', ['Curtești'])], isolateArea: false });
      const memory = new Map([['hb.ops.session.v1', JSON.stringify({ active })]]);
      const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
      const noop = () => {};
      const map = {
        on: noop, getSource: noop, getLayer: noop, getCenter: () => ({ lng: 26.6, lat: 47.7 }), getZoom: () => 8, getBearing: () => 0, getPitch: () => 0,
        getPadding: () => ({}), getContainer: () => document.querySelector('#map'), fitBounds: noop, flyTo: noop, setPadding: noop, resize: noop, jumpTo: noop,
      };
      const state = { data: { admin, localities }, visible: {}, overlays: {}, basemap: 'harta', theme: 'zi' };
      document.querySelector('#tab-situatii').replaceChildren();
      initOperations({ map, storage, state, toast: noop, selectTab: noop, stopOtherTools: noop, applyStyle: noop, renderLayerPanel: noop });
      const bar = [...document.querySelectorAll('.ops-focusbar')].at(-1);
      const saved = () => JSON.parse(memory.get('hb.ops.session.v1')).active;
      const selection = () => state.operations.selection.features.map(f => f.properties.kind + ':' + f.properties.name).join(',');
      state.focusUat({ name: 'Flămânzi', feature: admin.features[1] });
      result.view = { areasAfterFocus: saved().areas, selectionDuringView: selection(), barLabel: bar.querySelector('strong')?.textContent, masked: Boolean(state.operations.focusGeometry) };
      bar.querySelector('[data-faction="clear-focus"]').click();
      Object.assign(result.view, { selectionAfterBack: selection(), barHiddenAfterBack: bar.hidden });
      state.focusUat({ name: 'Flămânzi', feature: admin.features[1] });
      bar.querySelector('[data-faction="adopt-view"]').click();
      Object.assign(result.view, { areasAfterAdopt: saved().areas, barAfterAdopt: bar.querySelector('strong')?.textContent });
      // Editing the situation's own zone in the panel ends a map view.
      state.focusUat({ name: 'Curtești', feature: admin.features[0] });
      document.querySelector('#tab-situatii [data-area="Flămânzi"]').click();
      Object.assign(result.view, { areasAfterPanelEdit: saved().areas, selectionAfterPanelEdit: selection(), barAfterPanelEdit: bar.querySelector('strong')?.textContent });
    }
    out.textContent = JSON.stringify(result);
  } catch (error) { out.textContent = JSON.stringify({ error: error.stack }); }
}

test('the real focus outline hides only where a code outline draws the same shape, and a map focus is only a view', { skip: skipWithoutChrome }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'cjsu-focus-outline-'));
  const web = new URL('../web/', import.meta.url).href;
  const page = `<!doctype html><meta charset="utf-8"><script src="${web}vendor/proj4.js"></script><div class="app"><aside class="side"><div id="tab-situatii"></div></aside><div class="mapwrap"><div id="map"></div></div></div><pre id="results"></pre><script type="module">import { initOperations } from "${web}js/operations.js"; import { createEvent } from "${web}js/event-store.js"; (${browserChecks.toString()})({ initOperations, createEvent })</script>`;
  try {
    const path = join(dir, 'test.html');
    writeFileSync(path, page);
    const run = spawnSync(chrome, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files', '--user-data-dir=' + join(dir, 'profile'), '--virtual-time-budget=10000', '--dump-dom', pathToFileURL(path).href], { encoding: 'utf8', timeout: 60000 });
    assert.equal(run.status, 0, run.error?.message || run.stderr || String(run.signal));
    const match = run.stdout.match(/<pre id="results"[^>]*>([\s\S]*?)<\/pre>/);
    assert.ok(match?.[1], 'Browser did not report the selection: ' + run.stderr.slice(-2000));
    const result = JSON.parse(match[1].replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'));
    assert.equal(result.error, undefined, result.error);
    assert.deepEqual(result.villageInWarnedUat, ['uat:Curtești:true', 'place-focus:Agafton:false'], 'No village outline exists, so the turquoise circle shows');
    assert.deepEqual(result.villageAbsorbed, ['uat:Curtești:true', 'place-focus:Agafton:false'], 'A village merged into the UAT outline keeps its circle');
    assert.deepEqual(result.villageOutlined, ['uat:Curtești:true', 'place-focus:Agafton:true'], 'A village with its own code outline hands over to it');
    assert.deepEqual(result.villageUnwarned, ['uat:Curtești:true', 'place-focus:Poiana:false']);
    assert.deepEqual(result.uatFocus, ['uat:Curtești:true'], 'A focused UAT under a code keeps stepping aside');
    assert.deepEqual(result.view, {
      areasAfterFocus: [], selectionDuringView: 'uat:Flămânzi', barLabel: 'Vizualizare:', masked: true,
      selectionAfterBack: 'uat:Curtești,place-focus:Poiana', barHiddenAfterBack: false,
      areasAfterAdopt: ['Flămânzi'], barAfterAdopt: 'Focus:',
      areasAfterPanelEdit: [], selectionAfterPanelEdit: 'uat:Curtești,place-focus:Poiana', barAfterPanelEdit: 'Focus:',
    }, 'A map focus frames a view; only "Adaugă în situație" changes the open situation');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
