import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAlerts, affectedAlertLocations, warningsForLocation } from '../web/js/operations-alerts.js';
import { createEvent, sanitizeEvent, EventStore } from '../web/js/event-store.js';

const alert = (id, code, areas, places = []) => ({ id, code, source: 'ANM', validFrom: '2026-10-19T10:00:00+03:00', validTo: '2026-10-19T18:00:00+03:00', text: 'Vânt puternic', areas, places });
function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test('legacy warnings keep their original localities without mutating the archive', () => {
  const event = { alert: { code: 'orange', validFrom: '2026-10-17T08:00:00Z' }, areas: ['Vlădeni'], places: ['Huțani'] };
  const normalized = normalizeAlerts(event);
  assert.equal(normalized[0].id, 'legacy-alert');
  assert.deepEqual(normalized[0].areas, ['Vlădeni']);
  assert.deepEqual(normalized[0].places, ['Huțani']);
  assert.equal(normalized[0].validFrom, event.alert.validFrom);
  normalized[0].areas.push('Botoșani');
  assert.deepEqual(event.areas, ['Vlădeni']);
  assert.deepEqual(normalizeAlerts({ alert: { code: '' }, areas: ['Botoșani'] }), []);
});

test('explicit warning geography overrides legacy fields and an empty list stays empty', () => {
  const event = { alert: { code: 'red' }, areas: ['Botoșani'], alerts: [alert('a', 'yellow', ['Dorohoi'])] };
  assert.deepEqual(normalizeAlerts(event)[0].areas, ['Dorohoi']);
  assert.deepEqual(normalizeAlerts({ ...event, alerts: [] }), []);
  assert.deepEqual(normalizeAlerts({ ...event, alerts: [{ id: 'b', code: 'orange' }] })[0].areas, []);
});

test('concurrent codes retain independent locations and validity through save, export and import', () => {
  const event = createEvent('Avertizări simultane', 'storm');
  event.areas = ['Botoșani', 'Dorohoi'];
  event.alerts = [alert('yellow-a', 'yellow', ['Botoșani'], ['Agafton']), alert('red-b', 'red', ['Botoșani', 'Dorohoi'])];
  event.alerts[1].validFrom = '2026-10-19T16:00:00+03:00';
  const store = new EventStore(memoryStorage());
  const saved = store.save(event);
  const imported = new EventStore(memoryStorage());
  imported.importArchive(JSON.stringify(store.exportArchive()));
  assert.deepEqual(imported.load(event.id).alerts, saved.alerts);
  assert.equal(saved.alerts[0].validFrom, '2026-10-19T07:00:00.000Z');
  assert.equal(saved.alerts[1].validFrom, '2026-10-19T13:00:00.000Z');
  assert.deepEqual(warningsForLocation(saved, 'uat', 'Botoșani').map(a => a.code), ['yellow', 'red']);
  assert.deepEqual(warningsForLocation(saved, 'uat', 'Dorohoi').map(a => a.code), ['red']);
  assert.deepEqual(warningsForLocation(saved, 'place', 'Agafton').map(a => a.code), ['yellow']);
  assert.deepEqual(warningsForLocation(saved, 'uat', 'Agafton'), []);
  assert.deepEqual(warningsForLocation(saved, 'uat', 'Boto'), []);
  assert.deepEqual(affectedAlertLocations(saved), { areas: ['Botoșani', 'Dorohoi'], places: ['Agafton'] });
});

test('invalid warning lists and reversed intervals are rejected before storage changes', () => {
  const store = new EventStore(memoryStorage());
  const event = createEvent('Weather', 'storm');
  event.alerts = [alert('a', 'yellow', ['Dorohoi'])];
  store.save(event);
  const before = store.load(event.id);
  const bad = [null, {}, [alert('a', 'unknown', [])], [alert('a', 'red', []), alert('a', 'yellow', [])],
    [{ ...alert('a', 'red', []), validTo: '2026-10-18T10:00:00Z' }],
    [{ ...alert('a', 'red', []), areas: 'Botoșani' }],
    [{ ...alert('a', 'red', []), places: [42] }],
    Array.from({ length: 101 }, (_, i) => alert(String(i), 'red', []))];
  for (const alerts of bad) {
    assert.throws(() => store.save({ ...event, alerts }));
    assert.deepEqual(store.load(event.id), before);
  }
  assert.deepEqual(sanitizeEvent({ ...event, alerts: [] }).alerts, []);
});
