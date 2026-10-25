import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { urbanUats, presetAreas } from '../web/js/operations-alert-editor.js';

const chrome = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const data = {
  admin: { features: ['Botoșani', 'Curtești', 'Dorohoi', 'Vlădeni'].map(name => ({ properties: { kind: 'uat', name } })).concat({ properties: { kind: 'judet', name: 'Botoșani' } }) },
  localities: [
    { name: 'Botoșani', kind: 'city', uat: 'Botoșani' }, { name: 'Dorohoi', kind: 'city', uat: 'Dorohoi' },
    { name: 'Liteni', kind: 'town', uat: '' }, { name: 'Agafton', kind: 'village', uat: 'Curtești' },
  ],
};

test('town presets come from the index: a town outside the county is not a UAT of it', () => {
  assert.deepEqual(urbanUats(data), ['Botoșani', 'Dorohoi']);
  assert.deepEqual(presetAreas('all', data), ['Botoșani', 'Curtești', 'Dorohoi', 'Vlădeni']);
  assert.deepEqual(presetAreas('none', data), []);
  assert.equal(presetAreas('all', {}), null, 'Without the map data a preset cannot clear the selection');
  assert.equal(presetAreas('urban', { admin: data.admin }), null);
});

// Runs in the page: boots the real initOperations against a stub map whose UATs are squares, then
// drives the warning editor the way the operator does.
async function browserChecks({ initOperations, createEvent }) {
  const out = document.querySelector('#results');
  const result = {};
  const pageErrors = [];
  addEventListener('error', event => pageErrors.push(event.message));
  addEventListener('unhandledrejection', event => pageErrors.push(String(event.reason?.stack || event.reason)));
  const check = (name, value) => { result[name] = Boolean(value); };
  const noop = () => {};
  const square = (x, y) => ({ type: 'Polygon', coordinates: [[[x, y], [x + 0.2, y], [x + 0.2, y + 0.2], [x, y + 0.2], [x, y]]] });
  const uats = [['Botoșani', 26.6, 47.7], ['Curtești', 26.8, 47.7], ['Dorohoi', 26.4, 47.9], ['Vlădeni', 27.0, 47.4]];
  const admin = { features: uats.map(([name, x, y]) => ({ type: 'Feature', properties: { kind: 'uat', name }, geometry: square(x, y) })) };
  const uatAt = (lon, lat) => {
    const hit = uats.find(([, x, y]) => lon >= x && lon <= x + 0.2 && lat >= y && lat <= y + 0.2);
    return hit ? { name: hit[0] } : null;
  };
  const inside = name => { const [, x, y] = uats.find(item => item[0] === name); return { lng: x + 0.1, lat: y + 0.1 }; };
  const localities = [
    { name: 'Botoșani', kind: 'city', lon: 26.7, lat: 47.8, uat: 'Botoșani' }, { name: 'Dorohoi', kind: 'city', lon: 26.5, lat: 48.0, uat: 'Dorohoi' },
    { name: 'Agafton', kind: 'village', lon: 26.9, lat: 47.8, uat: 'Curtești' },
  ];
  const warn = (id, areas = [], places = []) => ({ id, code: 'orange', source: 'ANM', validFrom: '', validTo: '', text: '', areas, places });
  let handlers = {};
  const boot = ({ alerts, areas = [], data = { admin, localities }, legacy }) => {
    const active = createEvent('Introducere rapidă', 'snow');
    Object.assign(active, { areas, places: [], alerts });
    // An event saved before multiple warnings: one `alert` and the event's own areas, no list.
    if (legacy) { delete active.alerts; active.alert = legacy; }
    const memory = new Map([['hb.ops.session.v1', JSON.stringify({ active })]]);
    const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) };
    handlers = {};
    const map = {
      // Only whole-map handlers: a layer's hover handlers need rendered features the stub does not have.
      on: (type, layerOrFn, fn) => { if (!fn) (handlers[type] ||= []).push(layerOrFn); }, getSource: noop, getLayer: noop, queryRenderedFeatures: () => [],
      getCenter: () => ({ lng: 26.6, lat: 47.7 }), getZoom: () => 8, getBearing: () => 0, getPitch: () => 0, getPadding: () => ({}),
      getContainer: () => document.querySelector('#map'), getCanvas: () => document.querySelector('#map'),
      fitBounds: noop, flyTo: noop, setPadding: noop, resize: noop, jumpTo: noop,
    };
    const state = { data, visible: {}, overlays: {}, basemap: 'harta', theme: 'zi' };
    document.querySelector('#tab-situatii').replaceChildren();
    document.querySelectorAll('.ops-drawbar, .ops-focusbar, .ops-presentation').forEach(el => el.remove());
    const toasts = [];
    const ops = initOperations({ map, storage, state, uatAt, toast: text => toasts.push(text), selectTab: noop, setSheet: noop, stopOtherTools: noop,
      applyStyle: noop, renderLayerPanel: noop, cloudDb: { saveSituation: () => Promise.resolve(true), deleteSituation: () => Promise.resolve(true) } });
    const stored = () => JSON.parse(memory.get('hb.ops.session.v1')).active;
    return { ops, state, toasts, stored };
  };
  const $ = selector => document.querySelector(selector);
  const click = selector => $(selector)?.click();
  const entry = id => $(`[data-warning-id="${id}"]`);
  const boxes = (id, kind) => [...entry(id).querySelectorAll(`input[data-alert-area="${kind}"]`)].filter(box => box.checked).map(box => box.value);
  const clickMap = (ops, name) => ops.handleMapClick({ lngLat: inside(name), point: { x: 10, y: 10 } });
  const brush = (name, shiftKey = true) => (handlers.mousemove || []).forEach(fn => fn({ lngLat: inside(name), point: { x: 10, y: 10 }, originalEvent: { shiftKey } }));

  try {
    // Presets replace the UATs in place: the open picker stays open and only its boxes follow.
    {
      const { stored } = boot({ alerts: [warn('w1', ['Vlădeni'], ['Agafton|Curtești'])] });
      const picker = entry('w1').querySelector('.ops-alert-picker');
      picker.open = true;
      click('[data-warning-id="w1"] [data-alert-preset="all"]');
      check('allPresetSelectsEveryUat', JSON.stringify(stored().alerts[0].areas.sort()) === JSON.stringify(['Botoșani', 'Curtești', 'Dorohoi', 'Vlădeni']));
      check('allPresetChecksTheBoxes', boxes('w1', 'areas').length === 4);
      check('presetKeepsThePickerOpen', entry('w1').querySelector('.ops-alert-picker') === picker && picker.open);
      check('allPresetKeepsVillages', stored().alerts[0].places.includes('Agafton|Curtești') && boxes('w1', 'places').includes('Agafton|Curtești'));
      check('presetUpdatesTheCount', entry('w1').querySelector('[data-alert-count="areas"]').textContent === '4 selectate');
      click('[data-warning-id="w1"] [data-alert-preset="urban"]');
      check('urbanPresetSelectsTowns', JSON.stringify(stored().alerts[0].areas.sort()) === JSON.stringify(['Botoșani', 'Dorohoi']) && boxes('w1', 'areas').length === 2);
      click('[data-warning-id="w1"] [data-alert-preset="none"]');
      check('nonePresetClearsUatsAndVillages', !stored().alerts[0].areas.length && !stored().alerts[0].places.length && !boxes('w1', 'places').length);
      check('nonePresetSaysSelectZone', entry('w1').querySelector('[data-alert-status]').textContent.startsWith('Selectează UAT-urile'));
    }
    // With the map data still loading, "Tot județul" must not clear the selection instead.
    {
      const { stored } = boot({ alerts: [warn('w1', ['Vlădeni'])], data: { admin: { features: [] }, localities: [] } });
      click('[data-warning-id="w1"] [data-alert-preset="all"]');
      check('presetWaitsForMapData', stored().alerts[0].areas.join() === 'Vlădeni' && entry('w1').querySelector('[data-alert-status]').textContent.includes('se încarcă'));
    }
    // Picking on the map edits that warning only, not the situation's own zone.
    {
      const { ops, stored } = boot({ alerts: [warn('w1'), warn('w2', ['Vlădeni'])], areas: ['Dorohoi'] });
      click('[data-warning-id="w2"] [data-alert-pick]');
      check('pickSaysWhichWarning', $('.ops-drawbar')?.textContent.includes('avertizarea „Cod portocaliu · 1 zonă”'));
      clickMap(ops, 'Curtești');
      check('pickAddsToTheWarning', stored().alerts[1].areas.includes('Curtești') && !stored().alerts[0].areas.length);
      check('pickLeavesTheSituationZone', stored().areas.join() === 'Dorohoi');
      clickMap(ops, 'Vlădeni');
      check('secondClickRemoves', !stored().alerts[1].areas.includes('Vlădeni'));
      brush('Botoșani'); brush('Botoșani'); brush('Dorohoi');
      check('shiftBrushAdds', ['Curtești', 'Botoșani', 'Dorohoi'].every(name => stored().alerts[1].areas.includes(name)));
      brush('Vlădeni', false);
      check('brushNeedsShift', !stored().alerts[1].areas.includes('Vlădeni'));
      check('drawbarCountFollows', $('.ops-drawbar')?.textContent.includes('Cod portocaliu · 3 zone'));
      click('.ops-drawbar [data-action="finish"]');
      check('finishEndsThePick', $('.ops-drawbar')?.hidden && !ops.isDrawing());
      check('finishOpensTheWarning', entry('w2')?.open);
      clickMap(ops, 'Vlădeni');
      check('mapClicksAfterFinishEditNothing', !stored().alerts[1].areas.includes('Vlădeni'));
    }
    // The situation's own UAT pick still edits the zone, and the brush works there too.
    {
      const { ops, stored } = boot({ alerts: [warn('w1')] });
      click('button[data-action="area"]');
      clickMap(ops, 'Curtești'); brush('Vlădeni');
      check('zonePickUnchanged', stored().areas.join() === 'Curtești,Vlădeni' && !stored().alerts[0].areas.length);
      ops.cancelDrawing();
    }
    // A warning removed while picking closes the pick instead of editing nothing.
    {
      const { ops, stored, toasts } = boot({ alerts: [warn('w1'), warn('w2')] });
      click('[data-warning-id="w2"] [data-alert-pick]');
      click('[data-warning-id="w2"] [data-alert-action="remove"]');
      clickMap(ops, 'Curtești');
      check('goneWarningClosesPick', !ops.isDrawing() && toasts.at(-1)?.startsWith('Avertizarea aleasă nu mai există') && !stored().alerts[0].areas.length);
    }
    // A legacy single-warning event migrates to the list when its warning is picked on the map.
    {
      const { ops, stored } = boot({ areas: ['Dorohoi'], legacy: { code: 'red', source: 'ANM', text: 'Viscol', validFrom: '', validTo: '' } });
      click('[data-alert-pick]');
      clickMap(ops, 'Curtești');
      const alerts = stored().alerts;
      check('legacyPickMigrates', Array.isArray(alerts) && alerts.length === 1 && alerts[0].code === 'red' && alerts[0].areas.join() === 'Dorohoi,Curtești');
      ops.cancelDrawing();
    }
    // A marker form still open keeps the map for itself: the pick is refused with the usual message.
    {
      const { ops, toasts } = boot({ alerts: [warn('w1')] });
      ops.openRoadCreator();
      click('[data-warning-id="w1"] [data-alert-pick]');
      check('pickWaitsForOpenMarker', !ops.isDrawing() && toasts.at(-1)?.startsWith('Salvează marcajul curent'));
    }
    // A pasted message adds one warning per code for the county and says what to check.
    {
      const { stored } = boot({ alerts: [warn('w1', ['Vlădeni'])] });
      const paste = text => {
        const box = $('[data-alert-paste]');
        box.value = text;
        box.dispatchEvent(new Event('input', { bubbles: true }));
        click('[data-alert-action="parse"]');
      };
      const report = () => $('[data-alert-report]')?.textContent || '';
      paste('Informare meteorologică fără cod.');
      check('pasteWithoutCodeAddsNothing', stored().alerts.length === 1 && report().includes('Nu am găsit') && $('[data-alert-paste]').value.startsWith('Informare'));
      paste(`AVERTIZARE NOWCASTING
Cod: PORTOCALIU
Valabil de la: 20.10.2026 ora 18:30 până la: 20.10.2026 ora 19:30
Zona: Județul Botoșani: Dorohoi, Curtești, Agafton, Tâmpești;
Fenomene: vijelie`);
      const added = stored().alerts[1];
      check('pasteAddsTheWarning', stored().alerts.length === 2 && added?.code === 'orange' && added.source === 'ANM' && added.text === 'vijelie');
      check('pasteFillsTheZone', added?.areas.join() === 'Dorohoi,Curtești' && added.places.join() === 'Agafton|Curtești');
      check('pasteFillsTheInterval', added?.validFrom && added.validTo && Date.parse(added.validTo) - Date.parse(added.validFrom) === 3600000);
      check('pasteOpensTheNewWarning', entry(added?.id)?.open && !entry('w1').open);
      check('pasteReportsWhatToCheck', report().includes('Am adăugat 1 avertizare') && report().includes('Cod portocaliu (ANM): 2 UAT-uri și 1 sat') && report().includes('Nerecunoscute: „Tâmpești”'));
      check('pasteClearsTheBox', $('[data-alert-paste]').value === '' && $('.ops-alert-paste').open);
      click('[data-alert-action="add"]');
      check('reportGoesWithTheNextAdd', !report() && stored().alerts.length === 3);
    }
    // Text pasted but not yet recognised survives a render, such as a colleague's version arriving.
    {
      const { ops, stored } = boot({ alerts: [warn('w1')] });
      const box = $('[data-alert-paste]');
      box.value = 'Cod galben. Zona: Curtești';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      ops.syncFromCloud([{ ...stored(), title: 'Versiunea colegului', updatedAt: new Date(Date.now() + 60000).toISOString() }]);
      check('colleagueVersionLoaded', $('[data-ops-card="event"] h2')?.textContent === 'Versiunea colegului');
      check('pasteDraftSurvivesRender', $('[data-alert-paste]')?.value === 'Cod galben. Zona: Curtești' && $('.ops-alert-paste').open);
      click('[data-alert-action="parse"]');
      check('pasteDraftGoesOnceAdded', !$('[data-alert-paste]').value && stored().alerts.length === 2);
    }
    // Two codes in one message are two warnings; a county-wide one takes every UAT.
    {
      const { stored } = boot({ alerts: [] });
      const box = $('[data-alert-paste]');
      box.value = 'COD ROȘU\nZone afectate: județul Botoșani\nCOD GALBEN\nZona: Curtești';
      click('[data-alert-action="parse"]');
      const alerts = stored().alerts;
      check('pasteTwoCodes', alerts.length === 2 && alerts[0].code === 'red' && alerts[0].areas.length === 4 && alerts[1].code === 'yellow');
      check('pasteSaysWholeCounty', $('[data-alert-report]')?.textContent.includes('Cod roșu: tot județul; fără interval'));
    }
    // Without the map data the names cannot be matched, so nothing is added yet.
    {
      const { stored } = boot({ alerts: [], data: { admin: { features: [] }, localities: [] } });
      $('[data-alert-paste]').value = 'Cod galben. Zona: Corni';
      click('[data-alert-action="parse"]');
      check('pasteWaitsForMapData', !(stored().alerts || []).length && $('[data-alert-report]')?.textContent.includes('se încarcă'));
    }
    // An open marker form would be lost to the re-render, so the paste waits for it.
    {
      const { ops, stored, toasts } = boot({ alerts: [] });
      ops.openRoadCreator();
      $('[data-alert-paste]').value = 'Cod galben. Zona: Corni';
      click('[data-alert-action="parse"]');
      check('pasteWaitsForOpenMarker', !(stored().alerts || []).length && toasts.at(-1)?.startsWith('Finalizează sau anulează marcajul'));
    }
  } catch (error) { result.error = error.stack + (pageErrors.length ? '\n' + pageErrors.join('\n') : ''); }
  check('noPageErrors', !pageErrors.length || (result.pageErrors = pageErrors, false));
  out.textContent = JSON.stringify(result);
}

test('zone presets, the map pick and a pasted message fill warnings in the real editor', { skip: !existsSync(chrome) }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'cjsu-alert-entry-'));
  const web = new URL('../web/', import.meta.url).href;
  const page = `<!doctype html><meta charset="utf-8"><script src="${web}vendor/proj4.js"></script><div class="app"><aside class="side"><div id="tab-situatii"></div></aside><div class="mapwrap"><div id="map"></div></div></div><pre id="results"></pre><script type="module">import { initOperations } from "${web}js/operations.js"; import { createEvent } from "${web}js/event-store.js"; (${browserChecks.toString()})({ initOperations, createEvent })</script>`;
  try {
    const path = join(dir, 'test.html');
    writeFileSync(path, page);
    const run = spawnSync(chrome, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files', '--user-data-dir=' + join(dir, 'profile'), '--virtual-time-budget=5000', '--dump-dom', pathToFileURL(path).href], { encoding: 'utf8', timeout: 60000 });
    assert.equal(run.status, 0, run.error?.message || run.stderr || String(run.signal));
    const match = run.stdout.match(/<pre id="results"[^>]*>([\s\S]*?)<\/pre>/);
    assert.ok(match?.[1], 'Browser did not report results: ' + run.stderr.slice(-2000));
    const result = JSON.parse(match[1].replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'));
    assert.equal(result.error, undefined, result.error);
    const failed = Object.entries(result).filter(([, ok]) => !ok).map(([name]) => name);
    assert.deepEqual(failed, [], 'Warning entry regressions');
    assert.ok(Object.keys(result).length >= 39, 'Every scenario reported');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
