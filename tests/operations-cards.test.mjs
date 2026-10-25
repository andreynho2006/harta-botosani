import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chrome, skipWithoutChrome } from './chrome.mjs';

async function browserChecks({ initOperations, createEvent }) {
  try {
    const active = createEvent('Card disclosure regression', 'snow');
    const memory = new Map([['hb.ops.session.v1', JSON.stringify({ active })]]);
    const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
    const noop = () => {};
    const map = { on: noop, getSource: noop, getLayer: noop, getCanvas: () => ({ style: {} }),
      getCenter: () => ({ lng: 26.6, lat: 47.7 }), getZoom: () => 8, getBearing: () => 0, getPitch: () => 0,
      getPadding: () => ({}), getContainer: () => document.querySelector('#map'), resize: noop, jumpTo: noop, fitBounds: noop, setPadding: noop };
    const operations = initOperations({ map, storage, state: { data: {}, visible: {}, overlays: {}, basemap: 'harta', theme: 'zi' }, toast: noop, selectTab: noop, setSheet: noop, stopOtherTools: noop, applyStyle: noop, renderLayerPanel: noop });
    const panel = document.querySelector('#tab-situatii');
    const select = () => panel.querySelector('[data-ops-add-action]');
    const choose = value => { const input = select(); input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); };
    const toggle = key => panel.querySelector(`[data-ops-card-toggle="${key}"]`);
    const result = { viewport: innerWidth + 'x' + innerHeight };
    const check = (name, value) => { result[name] = Boolean(value); };
    const visible = element => element && getComputedStyle(element).display !== 'none' && element.getClientRects().length > 0;
    const cardContract = () => [...panel.querySelectorAll('.ops-card')].every(card => {
      const button = card.querySelector('[data-ops-card-toggle]'), body = card.querySelector(':scope > .ops-card-body');
      return button && body && button.getAttribute('aria-controls') === body.id && button.getAttribute('aria-expanded') === String(!body.hidden);
    });
    check('allInitialCardsHaveDisclosure', cardContract());
    check('metadataInitiallyCollapsed', toggle('event').getAttribute('aria-expanded') === 'false');
    check('saveAndPresentationRemainVisible', visible(panel.querySelector('[data-action="save"]')) && visible(panel.querySelector('[data-action="present"]')));
    const choices = [...select().options].filter(option => option.value);
    check('allSixteenActionsAvailable', choices.length === 16 && new Set(choices.map(option => option.value)).size === 16);
    check('menuContainsRoutesRoadsZonesAndForces', ['open-itinerary', 'open-road-form', 'road', 'zone:fire', 'point:command', 'point:shelter'].every(value => choices.some(option => option.value === value)));
    const heights = [...panel.querySelectorAll('[data-ops-card-toggle]')].map(button => button.getBoundingClientRect());
    check('disclosures44px', heights.every(rect => rect.width >= 44 && rect.height >= 44));
    toggle('roads').click();
    choose('open-itinerary');
    check('plannerActionDispatched', Boolean(panel.querySelector('#ops-itinerary')));
    check('plannerAlsoCollapsible', Boolean(toggle('ops-itinerary')) && cardContract());
    check('collapsedStateSurvivesRerender', toggle('roads').getAttribute('aria-expanded') === 'false');
    panel.querySelector('[data-itinerary="close"]').click();
    const dispatched = [];
    const record = event => { const button = event.target.closest('button'); if (button?.hidden && button.dataset.action) dispatched.push([button.dataset.action, button.dataset.kind].filter(Boolean).join(':')); };
    panel.addEventListener('click', record, true);
    choose('point:command');
    check('selectedActionPreservesKind', dispatched.at(-1) === 'point:command' && operations.isDrawing());
    panel.removeEventListener('click', record, true);
    operations.handleMapClick({ lngLat: { lng: 26.7, lat: 47.76 }, point: { x: 20, y: 20 } });
    check('mapActionCreatesEditableMarker', Boolean(panel.querySelector('#ops-marker')) && cardContract());
    const title = panel.querySelector('#ops-marker [name="title"]');
    title.value = 'Unsaved field survives folding';
    toggle('ops-marker').click(); toggle('ops-marker').click();
    check('foldingPreservesMountedInputs', title.isConnected && title.value === 'Unsaved field survives folding');
    check('focusAndAriaFollowDisclosure', document.activeElement === toggle('ops-marker') && toggle('ops-marker').getAttribute('aria-expanded') === 'true');
    for (const button of panel.querySelectorAll('[data-ops-card-toggle]')) if (button.getAttribute('aria-expanded') === 'true') button.click();
    check('allCardBodiesCanCollapse', [...panel.querySelectorAll('.ops-card-body')].every(body => body.hidden));
    check('saveStillAvailableAfterFoldingAll', visible(panel.querySelector('[data-action="save"]')));
    check('noHorizontalOverflow', panel.scrollWidth <= panel.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth);
    parent.postMessage(result, '*');
  } catch (error) { parent.postMessage({ viewport: innerWidth + 'x' + innerHeight, error: error.stack }, '*'); }
}

test('operational cards preserve forms and disclosure state while the action menu uses existing handlers', { skip: skipWithoutChrome }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'operations-cards-'));
  try {
    const web = new URL('../web/', import.meta.url).href;
    const child = `<!doctype html><script src="${web}vendor/proj4.js"></script><link rel="stylesheet" href="${web}css/app.css"><link rel="stylesheet" href="${web}css/operations.css"><link rel="stylesheet" href="${web}css/operations-cards.css"><div class="app"><aside class="side"><section class="panel" id="tab-situatii"></section></aside><div class="mapwrap"><div id="map"></div></div></div><script type="module">import { initOperations } from '${web}js/operations.js';import { createEvent } from '${web}js/event-store.js';(${browserChecks.toString()})({initOperations,createEvent});</script>`;
    const sizes = [[320, 568], [390, 844], [844, 390], [1366, 768]];
    const harness = `<body><pre id="results"></pre><script>const results=[];onmessage=event=>{results.push(event.data);document.querySelector('#results').textContent=JSON.stringify(results);};for(const [width,height] of ${JSON.stringify(sizes)}){const frame=document.createElement('iframe');frame.width=width;frame.height=height;frame.srcdoc=${JSON.stringify(child).replaceAll('<', '\\u003c')};document.body.append(frame);}</script>`;
    const path = join(dir, 'test.html'); writeFileSync(path, harness);
    const run = spawnSync(chrome, ['--headless', '--window-size=1440,1000', '--enable-logging=stderr', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files', '--user-data-dir=' + join(dir, 'profile'), '--virtual-time-budget=5000', '--dump-dom', pathToFileURL(path).href], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(run.status, 0, run.error?.message || run.stderr || String(run.signal));
    const match = run.stdout.match(/<pre id="results">([\s\S]*?)<\/pre>/);
    assert.ok(match?.[1], 'Browser did not complete card checks: ' + run.stderr.slice(-2500));
    const results = JSON.parse(match[1].replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'));
    assert.equal(results.length, sizes.length, JSON.stringify(results));
    const failures = results.flatMap(result => result.error ? [result.viewport + ': ' + result.error] : Object.entries(result).filter(([key, value]) => key !== 'viewport' && !value).map(([key]) => result.viewport + ': ' + key));
    assert.deepEqual(failures, [], failures.join('\n'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
