import assert from 'node:assert/strict';
import test from 'node:test';
import { ROAD, LAYER_PRESETS } from '../web/js/config.js';
import { createEvent, EventStore, sanitizeEvent } from '../web/js/event-store.js';
import { decorateOperationalStyle } from '../web/js/operations-style.js';

const point = [26.648056, 47.752107];
function itinerary(kind) {
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: [point, [26.65, 47.754], [26.66, 47.756]] },
    properties: { id: kind, kind, status: 'reported', title: kind, lengthKm: 1.6, routeGroup: 'route-1',
      subunitId: 'garda-botosani', objectiveId: 'objective-1', origin: point, destination: [26.66, 47.756] } };
}

test('fire profile includes every road class and rail context without enabling access roads in the base profile', () => {
  const fire = LAYER_PRESETS.find(p => p.id === 'fire');
  for (const cls of Object.keys(ROAD)) assert.ok(fire.layers.includes('road:' + cls));
  assert.ok(fire.layers.includes('rail'));
  assert.ok(!LAYER_PRESETS.find(p => p.id === 'baza').layers.includes('road:service'));
});

test('base and reserve itineraries survive archive export/import with their endpoints and identities', () => {
  const data = new Map();
  const storage = { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
  const event = createEvent('Deployment plan', 'fire');
  event.features.features = [itinerary('route_primary'), itinerary('route_backup')];
  const db = new EventStore(storage);
  db.save(event);
  const archive = db.exportArchive();
  const imported = new EventStore({ getItem: () => null, setItem: (_, value) => data.set('imported', value) });
  imported.importArchive(archive);
  const restored = JSON.parse(data.get('imported')).events[0];
  for (const feature of restored.features.features) {
    assert.equal(feature.properties.routeGroup, 'route-1');
    assert.equal(feature.properties.subunitId, 'garda-botosani');
    assert.deepEqual(feature.properties.origin, point);
    assert.deepEqual(feature.properties.destination, [26.66, 47.756]);
    assert.deepEqual(feature.geometry, itinerary(feature.properties.kind).geometry);
  }
});

test('invalid itinerary geometry and endpoint metadata cannot enter a saved situation', () => {
  for (const mutate of [f => { f.geometry = { type: 'Point', coordinates: point }; }, f => { f.properties.origin = [NaN, 47]; }, f => { delete f.properties.routeGroup; }]) {
    const event = createEvent('Invalid route', 'fire');
    const feature = itinerary('route_primary'); mutate(feature); event.features.features = [feature];
    assert.throws(() => sanitizeEvent(event));
  }
});

test('base and reserve routes use different colors, with a dashed reserve and preserved black closures', () => {
  const style = decorateOperationalStyle({ version: 8, sources: {}, layers: [] });
  const base = style.layers.find(l => l.id === 'ops-features-line');
  const reserve = style.layers.find(l => l.id === 'ops-route-backup');
  assert.deepEqual(reserve.paint['line-dasharray'], [2, 2]);
  const colors = base.paint['line-color'][3];
  assert.notEqual(colors[colors.indexOf('route_primary') + 1], colors[colors.indexOf('route_backup') + 1]);
  assert.equal(colors[colors.indexOf('blocked') + 1], '#080808');
  assert.ok(JSON.stringify(base.filter).includes('route_backup'));
});
