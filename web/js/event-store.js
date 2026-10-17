// Local, portable incident archive. No credentials or base-map data are stored.
export const EVENT_STORAGE_KEY = 'hb.events.v1';
export const EVENT_TYPES = Object.freeze(Object.fromEntries(['fire', 'flood', 'snow', 'storm', 'other'].map(key => [key, key])));
export const MARK_TYPES = Object.freeze(Object.fromEntries([
  'blocked', 'flooded', 'damaged', 'snow', 'threat', 'fire',
  'evacuated', 'isolated', 'power', 'stranded', 'houses', 'persons',
  'command', 'isu', 'police', 'medical', 'utility', 'shelter',
].map(key => [key, key])));
const MAX_EVENTS = 500;
const MAX_FEATURES = 2000;
const MAX_VERTICES = 100000;
const MAX_JSON_SIZE = 32 * 1024 * 1024;
const STATUSES = ['threat', 'reported', 'confirmed', 'resolved'];

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}.`);
  return value;
}

function string(value, max = 2000, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.length > max) throw new Error('Invalid or oversized text.');
  return value;
}

function timestamp(value) {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) throw new Error('Invalid timestamp.');
  return new Date(value).toISOString();
}

function identifier(value) {
  const id = string(value, 120);
  if (!id.trim()) throw new Error('Missing identifier.');
  return id;
}

function position(value, budget) {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite) || Math.abs(value[0]) > 180 || Math.abs(value[1]) > 90) throw new Error('Invalid map coordinates.');
  if (++budget.vertices > MAX_VERTICES) throw new Error('Archive contains too many coordinates.');
  return [...value];
}

function geometry(value, budget) {
  object(value, 'geometry');
  const { type, coordinates } = value;
  if (type === 'Point') return { type, coordinates: position(coordinates, budget) };
  if (type === 'LineString') {
    if (!Array.isArray(coordinates) || coordinates.length < 2) throw new Error('A road needs at least two points.');
    return { type, coordinates: coordinates.map(p => position(p, budget)) };
  }
  if (type === 'Polygon') {
    if (!Array.isArray(coordinates) || !coordinates.length) throw new Error('Missing polygon boundary.');
    return { type, coordinates: coordinates.map(ring => {
      if (!Array.isArray(ring) || ring.length < 4) throw new Error('A boundary needs a closed ring.');
      const points = ring.map(p => position(p, budget));
      if (points[0][0] !== points.at(-1)[0] || points[0][1] !== points.at(-1)[1]) throw new Error('Boundary is not closed.');
      return points;
    }) };
  }
  throw new Error('Unsupported geometry.');
}

function kilometer(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!Number.isFinite(value) || value < 0 || value > 100000) throw new Error('Invalid road kilometer.');
  return value;
}

function feature(value, budget) {
  object(value, 'feature');
  if (value.type !== 'Feature') throw new Error('Invalid GeoJSON feature.');
  const p = object(value.properties, 'feature properties');
  if (!Object.hasOwn(MARK_TYPES, p.kind)) throw new Error('Unknown map marker type.');
  const status = p.status ?? 'reported';
  if (!STATUSES.includes(status)) throw new Error('Unknown marker status.');
  const kmFrom = kilometer(p.kmFrom), kmTo = kilometer(p.kmTo);
  if (kmFrom !== null && kmTo !== null && kmTo < kmFrom) throw new Error('Road kilometers are reversed.');
  const lengthKm = kilometer(p.lengthKm);
  const personnel = string(p.personnel, 300);
  const vehicles = string(p.vehicles, 400);
  const props = {
    id: identifier(p.id), kind: p.kind, status, title: string(p.title, 200),
    road: string(p.road, 100), kmFrom, kmTo, source: string(p.source, 300),
    observedAt: p.observedAt ? timestamp(p.observedAt) : '', notes: string(p.notes, 5000),
  };
  if (lengthKm !== null) props.lengthKm = lengthKm;
  if (personnel) props.personnel = personnel;
  if (vehicles) props.vehicles = vehicles;
  return {
    type: 'Feature', geometry: geometry(value.geometry, budget),
    properties: props,
  };
}

export function sanitizeEvent(value, budget = { vertices: 0 }) {
  object(value, 'event');
  const title = string(value.title, 200).trim();
  if (!title) throw new Error('An event title is required.');
  if (!Object.hasOwn(EVENT_TYPES, value.type)) throw new Error('Unknown event type.');
  const alert = object(value.alert ?? {}, 'alert');
  const areas = value.areas ?? [];
  if (!Array.isArray(areas) || areas.length > 1000) throw new Error('Invalid selected areas.');
  const places = value.places ?? [];
  if (!Array.isArray(places) || places.length > 2000) throw new Error('Invalid selected places.');
  const collection = object(value.features, 'feature collection');
  if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features) || collection.features.length > MAX_FEATURES) throw new Error('Invalid or oversized feature collection.');
  const features = collection.features.map(f => feature(f, budget));
  if (new Set(features.map(f => f.properties.id)).size !== features.length) throw new Error('Duplicate map marker identifiers.');
  let view = null;
  if (value.view != null) {
    const v = object(value.view, 'map view');
    if (!Number.isFinite(v.zoom) || v.zoom < 0 || v.zoom > 24 || !Number.isFinite(v.bearing) || Math.abs(v.bearing) > 360 || !Number.isFinite(v.pitch) || v.pitch < 0 || v.pitch > 85) throw new Error('Invalid map view.');
    view = { center: position(v.center, budget), zoom: v.zoom, bearing: v.bearing, pitch: v.pitch };
  }
  const visible = {};
  const layers = object(value.visible ?? {}, 'visible layers');
  if (Object.keys(layers).length > 200) throw new Error('Too many visible layers.');
  for (const [key, enabled] of Object.entries(layers)) {
    if (!/^[a-zA-Z0-9_:-]{1,100}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key) || typeof enabled !== 'boolean') throw new Error('Invalid layer visibility.');
    visible[key] = enabled;
  }
  const sanitized = {
    id: identifier(value.id), title, type: value.type,
    createdAt: timestamp(value.createdAt), updatedAt: timestamp(value.updatedAt),
    alert: { code: string(alert.code, 80), source: string(alert.source, 300), validFrom: alert.validFrom ? timestamp(alert.validFrom) : '', validTo: alert.validTo ? timestamp(alert.validTo) : '', text: string(alert.text, 5000) },
    notes: string(value.notes, 10000), areas: [...new Set(areas.map(a => string(a, 200)).filter(Boolean))],
    features: { type: 'FeatureCollection', features }, view, visible,
  };
  if (places.length) sanitized.places = [...new Set(places.map(p => string(p, 200)).filter(Boolean))];
  if (typeof value.isolateArea === 'boolean') sanitized.isolateArea = value.isolateArea;
  if (typeof value.tintAreas === 'boolean') sanitized.tintAreas = value.tintAreas;
  return sanitized;
}

export function createEvent(title, type = 'other') {
  const now = new Date().toISOString();
  const id = globalThis.crypto?.randomUUID?.() ?? `event-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return sanitizeEvent({ id, title, type, createdAt: now, updatedAt: now, features: { type: 'FeatureCollection', features: [] } });
}

function parseArchive(input) {
  if (typeof input === 'string') {
    if (input.length > MAX_JSON_SIZE) throw new Error('Archive is too large.');
    input = JSON.parse(input);
  }
  object(input, 'archive');
  if (input.format !== 'harta-botosani-events' || input.version !== 1 || !Array.isArray(input.events) || input.events.length > MAX_EVENTS) throw new Error('Unsupported or oversized event archive.');
  const budget = { vertices: 0 };
  const events = input.events.map(event => sanitizeEvent(event, budget));
  if (new Set(events.map(event => event.id)).size !== events.length) throw new Error('Duplicate event identifiers.');
  return events;
}

export class EventStore {
  constructor(storage = globalThis.localStorage) { this.storage = storage; }

  _read() {
    const raw = this.storage.getItem(EVENT_STORAGE_KEY);
    return raw === null ? [] : parseArchive(raw);
  }

  _write(events) {
    // Validate the entire merged archive before the single atomic storage write.
    const archive = { format: 'harta-botosani-events', version: 1, exportedAt: new Date().toISOString(), events };
    archive.events = parseArchive(archive);
    const json = JSON.stringify(archive);
    if (json.length > MAX_JSON_SIZE) throw new Error('Archive is too large.');
    this.storage.setItem(EVENT_STORAGE_KEY, json);
  }

  list() { return this._read().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  load(id) { return this._read().find(event => event.id === id) ?? null; }

  save(event) {
    const events = this._read();
    const old = events.find(item => item.id === event.id);
    const saved = sanitizeEvent({ ...event, createdAt: old?.createdAt ?? event.createdAt, updatedAt: new Date().toISOString() });
    const index = events.findIndex(item => item.id === saved.id);
    if (index < 0) events.push(saved); else events[index] = saved;
    this._write(events);
    return saved;
  }

  remove(id) {
    const events = this._read();
    const filtered = events.filter(item => item.id !== id);
    if (filtered.length === events.length) return false;
    this._write(filtered);
    return true;
  }

  exportArchive() { return { format: 'harta-botosani-events', version: 1, exportedAt: new Date().toISOString(), events: this.list() }; }

  importArchive(input) {
    const incoming = parseArchive(input);
    const events = this._read();
    let imported = 0;
    for (const event of incoming) {
      const index = events.findIndex(item => item.id === event.id);
      if (index >= 0 && events[index].updatedAt >= event.updatedAt) continue;
      if (index < 0) events.push(event); else events[index] = event;
      imported++;
    }
    this._write(events);
    return { imported, skipped: incoming.length - imported, total: events.length };
  }
}
