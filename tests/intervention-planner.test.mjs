import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createInterventionPlanner } from '../web/js/intervention-planner.js';

const point = (id, name = 'Incident objective') => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [26.7, 47.76] }, properties: { id, name } });
const blocked = status => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[26.6, 47.7], [26.7, 47.76]] }, properties: { id: status, kind: 'blocked', status } });
class FakeWorker {
  messages = [];
  terminated = false;
  postMessage(message) { this.messages.push(structuredClone(message)); }
  terminate() { this.terminated = true; }
  reply(data) { this.onmessage?.({ data }); }
}
function setup({ confirmed = true, timeout = 30000 } = {}) {
  let current = { id: 'event-1', features: { type: 'FeatureCollection', features: [point('p1'), blocked('reported'), blocked('resolved')] } };
  const workers = [], routes = [], notices = [];
  const calls = { start: 0, end: 0, render: 0 };
  const state = { data: {
    subunits: confirmed ? [{ id: 'garda-botosani', name: 'Garda Botoșani', type: 'garda', lon: 26.66, lat: 47.75 }] : [],
    pois: { type: 'FeatureCollection', features: [
      { ...point('hospital', '<Hospital>'), properties: { cat: 'spital', name: '<Hospital>', id: 'hospital' } },
      { ...point('fire'), properties: { cat: 'pompieri', name: 'Unverified OSM fire station', id: 'fire' } },
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[26, 47.5], [26.1, 47.5], [26.1, 47.6], [26, 47.5]]] }, properties: { name: 'No guessed centroid' } },
    ] },
  } };
  const planner = createInterventionPlanner({
    state, getActive: () => current,
    render: () => calls.render++, toast: text => notices.push(text),
    onPickStart: () => calls.start++, onPickEnd: () => calls.end++,
    createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
    onRoutes: (result, meta) => routes.push({ result, meta }), routeTimeoutMs: timeout,
  });
  const click = action => planner.handleClick({ dataset: { itinerary: action } });
  const change = (field, value) => planner.handleChange({ dataset: { itineraryField: field }, value });
  planner.handleClick({ dataset: { action: 'open-itinerary' } });
  const ready = () => { change('unit', 'garda-botosani'); change('destination', 'event:p1'); };
  return { planner, state, workers, routes, notices, calls, click, change, ready, get active() { return current; }, set active(value) { current = value; } };
}
const result = (alternative = true) => ({
  primary: { geometry: { type: 'LineString', coordinates: [[26.66, 47.75], [26.7, 47.76]] }, distanceKm: 7.25 },
  alternative: alternative ? { geometry: { type: 'LineString', coordinates: [[26.66, 47.75], [26.68, 47.78], [26.7, 47.76]] }, distanceKm: 9.6 } : null,
  snaps: { start: { distanceMeters: 12 }, end: { distanceMeters: 38 } },
});

test('unconfirmed roster is grouped and disabled without creating a worker or guessing locations', () => {
  const h = setup({ confirmed: false }), html = h.planner.html();
  assert.equal((html.match(/<optgroup label="(?:Detașamentul|Stația)/g) || []).length, 3);
  assert.equal((html.match(/coordonate neconfirmate<\/option>/g) || []).length, 8);
  assert.match(html, /data-itinerary="calculate" disabled/);
  assert.match(html, /coordonatele exacte/);
  assert.equal(html.includes('Unverified OSM fire station'), false);
  assert.equal(html.includes('No guessed centroid'), false);
  assert.match(html, /&lt;Hospital&gt;/);
  h.click('calculate');
  assert.equal(h.workers.length, 0);
  assert.equal(h.planner.handleClick({ dataset: { action: 'save' } }), false);
  assert.equal(h.planner.handleChange({ dataset: { field: 'title' }, value: '' }), false);
});

test('confirmed source and explicit objective enable lazy local calculation and preserve metadata', () => {
  const h = setup(); h.ready();
  assert.equal(h.workers.length, 0);
  assert.doesNotMatch(h.planner.html(), /data-itinerary="calculate" disabled/);
  h.click('calculate'); h.click('calculate');
  assert.equal(h.workers.length, 1);
  const worker = h.workers[0], request = worker.messages[0];
  assert.equal(worker.messages.length, 1);
  assert.deepEqual(request.start, [26.66, 47.75]);
  assert.deepEqual(request.end, [26.7, 47.76]);
  assert.equal(request.blockedFeatures.length, 1);
  assert.equal(request.blockedFeatures[0].properties.status, 'reported');
  assert.match(h.planner.html(), /Se calculează local/);
  worker.reply({ id: request.id + 1, result: result() });
  assert.equal(h.routes.length, 0);
  worker.reply({ id: request.id, result: result() });
  assert.equal(h.routes.length, 1);
  assert.equal(h.routes[0].meta.unit.id, 'garda-botosani');
  assert.equal(h.routes[0].meta.destination.id, 'event:p1');
  assert.match(h.planner.html(), /7\.3 km/);
  assert.match(h.planner.html(), /9\.6 km/);
  assert.match(h.planner.html(), /plecare 12 m, obiectiv 38 m/);
  assert.match(h.planner.html(), /nu sunt desenate ca drumuri/);
});

test('map selection accepts an exact point and manual coordinates are validated without centroids', () => {
  const h = setup();
  h.change('unit', 'garda-botosani');
  h.click('pick');
  assert.equal(h.planner.isPicking(), true);
  assert.equal(h.calls.start, 1);
  assert.equal(h.planner.handleMapClick({ lngLat: { lng: 0, lat: 0 } }), true);
  assert.equal(h.planner.isPicking(), true);
  h.planner.handleMapClick({ lngLat: { lng: 26.72, lat: 47.78 } });
  assert.equal(h.planner.isPicking(), false);
  assert.equal(h.calls.end, 1);
  h.change('name', 'Exact objective'); h.click('calculate');
  let worker = h.workers[0], request = worker.messages[0];
  assert.deepEqual(request.end, [26.72, 47.78]);
  worker.reply({ id: request.id, result: result(false) });
  assert.equal(h.routes[0].meta.destination.name, 'Exact objective');
  assert.match(h.planner.html(), /Nu există o alternativă/);
  h.change('coordinate', 'not coordinates'); h.click('calculate');
  assert.equal(worker.messages.length, 1);
  h.change('coordinate', '47.790000, 26.730000'); h.click('calculate');
  request = worker.messages[1];
  assert.deepEqual(request.end, [26.73, 47.79]);
  h.click('cancel');
});

test('changed selections, incident blocks and active events invalidate outstanding results', () => {
  for (const mutate of [
    h => h.change('destination', 'poi:hospital'),
    h => { h.active.features.features.push(blocked('confirmed')); },
    h => { h.active = { id: 'event-2', features: { type: 'FeatureCollection', features: [] } }; },
    h => { h.state.data.subunits[0].lon = 26.67; },
  ]) {
    const h = setup(); h.ready(); h.click('calculate');
    const worker = h.workers[0], id = worker.messages[0].id;
    mutate(h); worker.reply({ id, result: result() });
    assert.equal(h.routes.length, 0);
    h.click('cancel');
  }
});

test('cancel terminates the worker, and a late result cannot overwrite a new request', () => {
  const h = setup(); h.ready(); h.click('calculate');
  const oldWorker = h.workers[0], callback = oldWorker.onmessage, oldId = oldWorker.messages[0].id;
  h.click('cancel'); assert.equal(oldWorker.terminated, true);
  h.click('calculate');
  callback({ data: { id: oldId, result: result() } });
  assert.equal(h.routes.length, 0);
  const worker = h.workers[1]; worker.reply({ id: worker.messages[0].id, result: result() });
  assert.equal(h.routes.length, 1);
});

test('missing routes and worker errors are visible and allow a clean retry', () => {
  const h = setup(); h.ready(); h.click('calculate');
  let worker = h.workers[0];
  worker.reply({ id: worker.messages[0].id, result: { primary: null, alternative: null, reason: 'disconnected_or_blocked' } });
  assert.equal(h.routes.length, 0);
  assert.match(h.planner.html(), /Nu există un traseu conectat/);
  h.click('calculate'); worker.onerror();
  assert.equal(worker.terminated, true);
  h.click('calculate'); worker = h.workers[1];
  worker.reply({ id: worker.messages[0].id, error: 'routing-data-unavailable' });
  assert.equal(worker.terminated, true);
  assert.match(h.planner.html(), /Calculul local nu a reușit/);
});

test('timeout, close and active-event replacement release outstanding work and picking mode', async () => {
  const h = setup({ timeout: 5 }); h.ready(); h.click('calculate');
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(h.workers[0].terminated, true);
  assert.match(h.planner.html(), /durat prea mult/);
  h.click('pick'); h.click('close');
  assert.equal(h.calls.end, 1);
  assert.equal(h.planner.html(), '');
  h.planner.handleClick({ dataset: { action: 'open-itinerary' } });
  h.ready(); h.click('calculate');
  const worker = h.workers[1];
  h.active = { id: 'replacement', features: { type: 'FeatureCollection', features: [] } };
  assert.equal(h.planner.html(), '');
  assert.equal(worker.terminated, true);
});

test('route worker lazily fetches and prepares one local graph for repeated calculations', async () => {
  const source = await readFile(new URL('../web/js/intervention-route-worker.js', import.meta.url), 'utf8');
  let fetches = 0, prepares = 0;
  const responses = [], computations = [], features = [{ test: true }];
  const prepared = { graph: true };
  const context = vm.createContext({
    URL,
    fetch: async url => { fetches++; assert.equal(url.origin, 'https://local.example'); assert.match(url.pathname, /\/web\/data\/routing-roads\.json$/); return { ok: true, json: async () => ({ type: 'FeatureCollection', features }) }; },
    prepareInterventionGraph: values => { prepares++; assert.deepEqual(values, features); return prepared; },
    computeInterventionRoutes: (start, end, graph, options) => { computations.push({ start, end, graph, options }); return { primary: null }; },
    self: { postMessage: value => responses.push(value) },
  });
  vm.runInContext(source.replace(/^import .*;\n/, '').replaceAll('import.meta.url', JSON.stringify('https://local.example/web/js/intervention-route-worker.js')), context);
  assert.equal(fetches, 0);
  await context.self.onmessage({ data: { id: 1, start: [26.6, 47.7], end: [26.7, 47.8], blockedFeatures: [] } });
  await context.self.onmessage({ data: { id: 2, start: [26.6, 47.7], end: [26.7, 47.8], blockedFeatures: ['new-block'] } });
  assert.equal(fetches, 1); assert.equal(prepares, 1);
  assert.equal(computations.length, 2);
  assert.equal(computations[0].graph, prepared);
  assert.equal(computations[1].options.maxSnapMeters, 150);
  assert.equal(responses[1].id, 2);
});

test('editing a custom coordinate keeps inputs mounted and updates calculation availability', () => {
  const h = setup(); h.change('unit', 'garda-botosani'); h.change('destination', 'custom');
  const before = h.calls.render, button = { disabled: true };
  const previousDocument = globalThis.document;
  globalThis.document = { querySelector: () => ({ querySelector: selector => selector === '[data-itinerary=calculate]' ? button : null }) };
  try {
    h.change('coordinate', '47.78, 26.72');
    assert.equal(button.disabled, false);
    h.change('name', 'Dispatch objective');
    assert.equal(h.calls.render, before);
    h.change('coordinate', '');
    assert.equal(button.disabled, true);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('route worker returns an error for unavailable data and can retry the lazy fetch', async () => {
  const source = await readFile(new URL('../web/js/intervention-route-worker.js', import.meta.url), 'utf8');
  const responses = [];
  let fetches = 0;
  const context = vm.createContext({
    URL,
    fetch: async () => { fetches++; return fetches === 1 ? { ok: false } : { ok: true, json: async () => ({ type: 'FeatureCollection', features: [] }) }; },
    prepareInterventionGraph: () => ({}), computeInterventionRoutes: () => ({ primary: null, reason: 'empty_network' }),
    self: { postMessage: value => responses.push(value) },
  });
  vm.runInContext(source.replace(/^import .*;\n/, '').replaceAll('import.meta.url', JSON.stringify('https://local.example/web/js/intervention-route-worker.js')), context);
  await context.self.onmessage({ data: { id: 1 } });
  assert.equal(responses[0].error, 'routing-calculation-failed');
  await context.self.onmessage({ data: { id: 2 } });
  assert.equal(fetches, 2);
  assert.equal(responses[1].result.reason, 'empty_network');
});

test('map picking remains active after the host cancels its previous tool', () => {
  const event = { id: 'pick-test', features: { type: 'FeatureCollection', features: [] } };
  let planner;
  planner = createInterventionPlanner({ state: { data: {} }, getActive: () => event, render() {},
    onPickStart() { planner.cancelPick(); } });
  planner.handleClick({ dataset: { action: 'open-itinerary' } });
  planner.handleClick({ dataset: { itinerary: 'pick' } });
  assert.equal(planner.isPicking(), true);
  assert.equal(planner.handleMapClick({ lngLat: { lng: 26.7, lat: 47.8 } }), true);
  assert.equal(planner.isPicking(), false);
  assert.match(planner.html(), /47\.8000000, 26\.7000000/);
});
