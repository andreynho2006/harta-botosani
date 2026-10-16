import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvent, EventStore, EVENT_STORAGE_KEY, sanitizeEvent } from '../web/js/event-store.js';

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
function marker(geometry = { type: 'LineString', coordinates: [[26.5, 47.8], [26.6, 47.9]] }) {
  return { type: 'Feature', geometry, properties: { id: 'road-1', kind: 'blocked', status: 'confirmed', title: 'DJ 29', road: 'DJ29', kmFrom: 3, kmTo: 6 } };
}
function eventWithRoad() {
  const event = createEvent('Winter response', 'snow');
  event.features.features.push(marker());
  return event;
}

test('events survive a new store instance and returned copies cannot mutate storage', () => {
  const storage = memoryStorage();
  const store = new EventStore(storage);
  const event = eventWithRoad();
  event.view = { center: [26.5, 47.8], zoom: 11, bearing: 0, pitch: 0 };
  event.visible = { 'road:dj': true, 'poi:pompieri': false, hidranti: true };
  const saved = store.save(event);
  assert.equal(saved.features.features[0].properties.kmFrom, 3);
  assert.deepEqual(saved.visible, event.visible);
  assert.deepEqual(new EventStore(storage).load(event.id), saved);
  store.load(event.id).title = 'Changed outside store';
  assert.equal(store.load(event.id).title, 'Winter response');
  assert.equal(store.load('missing'), null);
});

test('save updates the existing event while preserving its creation timestamp', () => {
  const store = new EventStore(memoryStorage());
  const event = eventWithRoad();
  event.createdAt = '2020-01-01T00:00:00.000Z';
  store.save(event);
  event.title = 'Updated situation';
  event.createdAt = '2021-01-01T00:00:00.000Z';
  const updated = store.save(event);
  assert.equal(updated.createdAt, '2020-01-01T00:00:00.000Z');
  assert.equal(store.list().length, 1);
  assert.equal(updated.title, 'Updated situation');
});

test('storage quota and malformed existing archives throw without replacing existing data', () => {
  const storage = memoryStorage(), store = new EventStore(storage);
  store.save(eventWithRoad());
  const original = storage.getItem(EVENT_STORAGE_KEY);
  storage.setItem = () => { throw new Error('Quota exceeded'); };
  assert.throws(() => store.save(createEvent('Another event')), /Quota exceeded/);
  assert.equal(storage.getItem(EVENT_STORAGE_KEY), original);
  const broken = memoryStorage();
  broken.setItem(EVENT_STORAGE_KEY, '{broken');
  assert.throws(() => new EventStore(broken).save(eventWithRoad()));
  assert.equal(broken.getItem(EVENT_STORAGE_KEY), '{broken');
});

test('archives round trip and merge only newer versions by identifier', () => {
  const store = new EventStore(memoryStorage());
  const event = store.save(eventWithRoad());
  const archive = store.exportArchive();
  const other = new EventStore(memoryStorage());
  assert.equal(other.importArchive(JSON.stringify(archive)).imported, 1);
  assert.equal(other.importArchive(archive).skipped, 1);
  archive.events[0].updatedAt = '2099-01-01T00:00:00.000Z';
  archive.events[0].title = 'Newer report';
  assert.equal(other.importArchive(archive).imported, 1);
  assert.equal(other.load(event.id).title, 'Newer report');
  archive.events[0].updatedAt = '2000-01-01T00:00:00.000Z';
  archive.events[0].title = 'Old report';
  assert.equal(other.importArchive(archive).skipped, 1);
  assert.equal(other.load(event.id).title, 'Newer report');
});

test('invalid archives are rejected entirely, including duplicate IDs', () => {
  const storage = memoryStorage(), store = new EventStore(storage);
  store.save(eventWithRoad());
  const original = storage.getItem(EVENT_STORAGE_KEY);
  const good = createEvent('Valid incoming');
  const bad = createEvent('Invalid incoming');
  bad.features.features = [marker({ type: 'Point', coordinates: [181, 48] })];
  const archive = { ...store.exportArchive(), events: [good, bad] };
  assert.throws(() => store.importArchive(archive), /coordinates/);
  assert.equal(storage.getItem(EVENT_STORAGE_KEY), original);
  archive.events = [good, good];
  assert.throws(() => store.importArchive(archive), /Duplicate event/);
  assert.equal(storage.getItem(EVENT_STORAGE_KEY), original);
});

test('sanitization copies only supported fields and rejects dangerous layer keys', () => {
  const event = eventWithRoad();
  event.password = 'never persist';
  event.features.features[0].properties.raw = { token: 'secret' };
  event.features.features[0].geometry.extra = 'discard';
  event.title = '<img src=x onerror=alert(1)>';
  const safe = sanitizeEvent(event);
  assert.equal(safe.password, undefined);
  assert.equal(safe.features.features[0].properties.raw, undefined);
  assert.equal(safe.features.features[0].geometry.extra, undefined);
  // Text remains text; DOM consumers must use textContent/escape HTML.
  assert.equal(safe.title, event.title);
  event.visible = JSON.parse('{"__proto__":true}');
  assert.throws(() => sanitizeEvent(event), /visibility/);
  assert.equal({}.polluted, undefined);
});

test('geometry rejects invalid bounds, nonfinite coordinates, open polygons and short roads', () => {
  const invalid = [
    { type: 'Point', coordinates: [26, -91] },
    { type: 'Point', coordinates: [NaN, 47] },
    { type: 'LineString', coordinates: [[26, 47]] },
    { type: 'Polygon', coordinates: [[[26, 47], [27, 47], [27, 48], [26, 48]]] },
    { type: 'MultiPoint', coordinates: [[26, 47]] },
  ];
  for (const geometry of invalid) {
    const event = eventWithRoad();
    event.features.features = [marker(geometry)];
    assert.throws(() => sanitizeEvent(event));
  }
  const event = eventWithRoad();
  event.features.features = [marker({ type: 'Polygon', coordinates: [[[26, 47], [27, 47], [27, 48], [26, 47]]] })];
  assert.equal(sanitizeEvent(event).features.features[0].geometry.type, 'Polygon');
});

test('archive size and coordinate budgets prevent oversized merges', () => {
  const store = new EventStore(memoryStorage());
  const archive = store.exportArchive();
  archive.events = Array.from({ length: 501 }, () => createEvent('Event'));
  assert.throws(() => store.importArchive(archive), /oversized/);
  const event = eventWithRoad();
  event.features.features[0].geometry.coordinates = Array.from({ length: 100001 }, () => [26, 47]);
  assert.throws(() => store.save(event), /too many coordinates/);
  event.features.features[0].geometry.coordinates = [[26, 47], [27, 48]];
  event.features.features[0].properties.kmTo = 2;
  assert.throws(() => store.save(event), /reversed/);
  assert.equal(store.list().length, 0);
});

test('remove deletes events and bundled situatii.json archive imports cleanly with CJSU fields', async () => {
  const fs = await import('node:fs');
  const store = new EventStore(memoryStorage());
  const raw = fs.readFileSync(new URL('../web/data/situatii.json', import.meta.url), 'utf8');
  const res = store.importArchive(raw);
  assert.ok(res.imported >= 1);
  const first = store.list()[0];
  assert.ok(first.places.includes('Huțani'));
  assert.equal(first.tintAreas, true);
  assert.equal(first.features.features[0].properties.lengthKm, 3);
  assert.equal(store.remove(first.id), true);
  assert.equal(store.remove('non-existent'), false);
  assert.equal(store.list().length, 0);
});

