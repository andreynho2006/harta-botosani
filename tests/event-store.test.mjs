import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvent, EventStore, EVENT_STORAGE_KEY, sanitizeEvent, cleanupLegacyArchive,
  LEGACY_CLEANUP_KEY, LEGACY_ARCHIVE_BACKUP_KEY, LEGACY_SESSION_BACKUP_KEY } from '../web/js/event-store.js';

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
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
  const bundled = JSON.parse(raw);
  assert.equal(store.list().length, bundled.events.length);
  const winter = store.load('cjsu-exemplu-iarna-dj29');
  assert.ok(winter);
  assert.deepEqual(winter.areas, bundled.events.find(e => e.id === winter.id).areas);
  assert.equal(winter.tintAreas, true);
  assert.equal(winter.features.features[0].properties.lengthKm, 3);
  for (const event of store.list()) {
    if (['yellow','orange','red','ro-alert'].includes(event.alert.code)) {
      assert.equal(event.tintAreas, true);
      assert.ok(event.areas.length || event.places.length, 'A warning needs affected geography');
    }
  }
  const townHall = store.load('d3463f81-3965-403d-9ab6-8cf5b6a8ca1b');
  assert.ok(townHall);
  assert.equal(townHall.alert.code, '', 'Do not invent a warning for the route-only event');
  assert.equal(townHall.features.features.find(f => f.properties.kind === 'route_backup').properties.lengthKm, 2.92);
  assert.equal(store.remove(winter.id), true);
  assert.equal(store.remove('non-existent'), false);
  assert.equal(store.list().length, bundled.events.length - 1);
});

const sessionKey = 'hb.ops.session.v1';
function cleanupEvent(id, updatedAt) {
  const event = eventWithRoad();
  return { ...event, id, createdAt: '2026-10-16T10:00:00.000Z', updatedAt };
}
function legacyStorage(events, session) {
  const storage = memoryStorage();
  const archive = { format: 'harta-botosani-events', version: 1, exportedAt: '2026-10-18T10:00:00.000Z', events };
  storage.setItem(EVENT_STORAGE_KEY, JSON.stringify(archive, null, 2));
  if (session) storage.setItem(sessionKey, JSON.stringify(session));
  return storage;
}

test('legacy cleanup preserves the October 17 seed and exact retained geometries', async () => {
  const { readFile } = await import('node:fs/promises');
  const seed = JSON.parse(await readFile(new URL('./fixtures/situatii-20261017.json', import.meta.url), 'utf8')).events[0];
  assert.equal(seed.createdAt.slice(0, 10), '2026-10-16');
  assert.equal(seed.updatedAt.slice(0, 10), '2026-10-17');
  const retained = cleanupEvent('retained', '2026-10-18T10:00:00.000Z');
  retained.features.features[0].geometry.extra = { originalPrecision: true };
  const old = cleanupEvent('remove', '2026-10-16T10:00:00.000Z');
  const storage = legacyStorage([seed, old, retained]);
  const before = storage.getItem(EVENT_STORAGE_KEY);
  assert.deepEqual(cleanupLegacyArchive(storage).removed, ['remove']);
  assert.deepEqual(JSON.parse(storage.getItem(EVENT_STORAGE_KEY)).events, [seed, retained]);
  assert.equal(storage.getItem(LEGACY_ARCHIVE_BACKUP_KEY), before);
  assert.equal(storage.getItem(LEGACY_CLEANUP_KEY), '1');
});

test('cleanup selects the displayed Bucharest updated date at both UTC boundaries', () => {
  const storage = legacyStorage([
    cleanupEvent('before', '2026-10-15T20:59:59.000Z'),
    cleanupEvent('start', '2026-10-15T21:00:00.000Z'),
    cleanupEvent('end', '2026-10-16T20:59:59.000Z'),
    cleanupEvent('after', '2026-10-16T21:00:00.000Z'),
  ]);
  assert.deepEqual(cleanupLegacyArchive(storage).removed, ['start', 'end']);
  assert.deepEqual(JSON.parse(storage.getItem(EVENT_STORAGE_KEY)).events.map(event => event.id), ['before', 'after']);
});

test('cleanup is one-time and does not overwrite the original recovery snapshot', () => {
  const event = cleanupEvent('remove', '2026-10-16T12:00:00.000Z');
  const storage = legacyStorage([event]);
  cleanupLegacyArchive(storage);
  const backup = storage.getItem(LEGACY_ARCHIVE_BACKUP_KEY);
  const restored = JSON.parse(backup);
  restored.events[0].id = 'manually-imported-later';
  storage.setItem(EVENT_STORAGE_KEY, JSON.stringify(restored));
  const before = storage.getItem(EVENT_STORAGE_KEY);
  assert.deepEqual(cleanupLegacyArchive(storage), { removed: [], alreadyApplied: true });
  assert.equal(storage.getItem(EVENT_STORAGE_KEY), before);
  assert.equal(storage.getItem(LEGACY_ARCHIVE_BACKUP_KEY), backup);
});

test('corrupt archives or sessions are preserved without a completion marker', () => {
  for (const raw of ['{broken', JSON.stringify({ format: 'unsupported', events: [] })]) {
    const storage = memoryStorage();
    storage.setItem(EVENT_STORAGE_KEY, raw);
    assert.throws(() => cleanupLegacyArchive(storage));
    assert.equal(storage.getItem(EVENT_STORAGE_KEY), raw);
    assert.equal(storage.getItem(LEGACY_CLEANUP_KEY), null);
    assert.equal(storage.getItem(LEGACY_ARCHIVE_BACKUP_KEY), null);
  }
  const storage = legacyStorage([cleanupEvent('remove', '2026-10-16T12:00:00.000Z')]);
  storage.setItem(sessionKey, '{broken');
  const before = storage.getItem(EVENT_STORAGE_KEY);
  assert.throws(() => cleanupLegacyArchive(storage));
  assert.equal(storage.getItem(EVENT_STORAGE_KEY), before);
  assert.equal(storage.getItem(sessionKey), '{broken');
  assert.equal(storage.getItem(LEGACY_CLEANUP_KEY), null);
});

test('backup failures preserve both original records before any deletion', () => {
  for (const failedKey of [LEGACY_ARCHIVE_BACKUP_KEY, LEGACY_SESSION_BACKUP_KEY]) {
    const event = cleanupEvent('remove', '2026-10-16T12:00:00.000Z');
    const storage = legacyStorage([event], { active: event, pending: { points: [[26, 47]] } });
    const before = storage.getItem(EVENT_STORAGE_KEY), session = storage.getItem(sessionKey);
    const setItem = storage.setItem;
    storage.setItem = (key, value) => {
      if (key === failedKey) throw new Error('Backup quota failure');
      setItem(key, value);
    };
    assert.throws(() => cleanupLegacyArchive(storage), /Backup quota/);
    assert.equal(storage.getItem(EVENT_STORAGE_KEY), before);
    assert.equal(storage.getItem(sessionKey), session);
    assert.equal(storage.getItem(LEGACY_CLEANUP_KEY), null);
  }
});

test('only a session whose active event was removed is backed up and cleared', () => {
  const removed = cleanupEvent('remove', '2026-10-16T12:00:00.000Z');
  const retained = cleanupEvent('keep', '2026-10-17T12:00:00.000Z');
  for (const active of [removed, retained]) {
    const storage = legacyStorage([removed, retained], { active, pending: { points: [[26, 47]] }, focusArea: 'Example' });
    const session = storage.getItem(sessionKey);
    cleanupLegacyArchive(storage);
    if (active.id === removed.id) {
      assert.equal(storage.getItem(sessionKey), null);
      assert.equal(storage.getItem(LEGACY_SESSION_BACKUP_KEY), session);
    } else {
      assert.equal(storage.getItem(sessionKey), session);
      assert.equal(storage.getItem(LEGACY_SESSION_BACKUP_KEY), null);
    }
  }
});

test('archive write failure restores a removed active session and leaves backups', () => {
  const event = cleanupEvent('remove', '2026-10-16T12:00:00.000Z');
  const storage = legacyStorage([event], { active: event });
  const before = storage.getItem(EVENT_STORAGE_KEY), session = storage.getItem(sessionKey);
  const setItem = storage.setItem;
  storage.setItem = (key, value) => {
    if (key === EVENT_STORAGE_KEY) throw new Error('Archive quota failure');
    setItem(key, value);
  };
  assert.throws(() => cleanupLegacyArchive(storage), /Archive quota/);
  assert.equal(storage.getItem(EVENT_STORAGE_KEY), before);
  assert.equal(storage.getItem(sessionKey), session);
  assert.equal(storage.getItem(LEGACY_ARCHIVE_BACKUP_KEY), before);
  assert.equal(storage.getItem(LEGACY_SESSION_BACKUP_KEY), session);
  assert.equal(storage.getItem(LEGACY_CLEANUP_KEY), null);
});

test('final completion write failure rolls back and retries without overwriting backups', () => {
  const event = cleanupEvent('remove', '2026-10-16T12:00:00.000Z');
  const storage = legacyStorage([event], { active: event });
  const before = storage.getItem(EVENT_STORAGE_KEY), session = storage.getItem(sessionKey);
  const setItem = storage.setItem;
  let fail = true, backupWrites = 0;
  storage.setItem = (key, value) => {
    if (key === LEGACY_CLEANUP_KEY && fail) { fail = false; throw new Error('Completion write failed'); }
    if (key === LEGACY_ARCHIVE_BACKUP_KEY || key === LEGACY_SESSION_BACKUP_KEY) backupWrites++;
    setItem(key, value);
  };
  assert.throws(() => cleanupLegacyArchive(storage), /Completion write/);
  assert.equal(storage.getItem(EVENT_STORAGE_KEY), before);
  assert.equal(storage.getItem(sessionKey), session);
  assert.equal(storage.getItem(LEGACY_CLEANUP_KEY), null);
  assert.deepEqual(cleanupLegacyArchive(storage).removed, ['remove']);
  assert.equal(backupWrites, 2);
  assert.equal(storage.getItem(LEGACY_ARCHIVE_BACKUP_KEY), before);
  assert.equal(storage.getItem(LEGACY_SESSION_BACKUP_KEY), session);
  assert.equal(storage.getItem(sessionKey), null);
  assert.equal(cleanupLegacyArchive(storage).alreadyApplied, true);
});
