/* global maplibregl */
import { normalizeAlerts, resolvePlace, placeKey, placeLabel, ALERT_COLORS as colors, ALERT_RANK as rank, ALERT_LABELS as labels } from './operations-alerts.js?v=20261019-multi-alerts';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Village boundaries are not part of the frozen dataset. Keep the same clearly
// identified, approximate 1.6 km area used by the locality focus tool.
function villageGeometry(lon, lat) {
  const radius = 1600 / 6371008.8 * 180 / Math.PI;
  const ring = Array.from({ length: 49 }, (_, i) => {
    const angle = i / 48 * 2 * Math.PI;
    return [lon + radius * Math.cos(angle) / Math.cos(lat * Math.PI / 180), lat + radius * Math.sin(angle)];
  });
  ring[48] = [...ring[0]];
  return { type: 'Polygon', coordinates: [ring] };
}

/** One feature per exact named target, with every warning retained for hover. */
export function buildAlertGeography(event, { admin, localities = [] } = {}) {
  const targets = new Map();
  for (const warning of normalizeAlerts(event)) {
    for (const [kind, names] of [['uat', warning.areas], ['place', warning.places]]) {
      for (const name of names || []) {
        // A legacy plain name and its `Name|UAT` key are the same village: one feature.
        const place = kind === 'place' ? resolvePlace(name, localities) : null;
        const key = place ? `place:${placeKey(place)}` : `${kind}:${name}`;
        if (!targets.has(key)) {
          let geometry;
          if (kind === 'uat') {
            geometry = admin?.features?.find(f => f.properties?.kind === 'uat' && f.properties.name === name)?.geometry;
          } else if (place) {
            geometry = villageGeometry(place.lon, place.lat);
          }
          if (!geometry) continue;
          const label = place ? placeLabel(placeKey(place)) : name;
          targets.set(key, { type: 'Feature', properties: { name: label, kind, key: place ? placeKey(place) : name, uat: place?.uat || '', code: '', color: '', alerts: [] }, geometry });
        }
        const properties = targets.get(key).properties;
        if (!properties.alerts.some(a => a.id === warning.id)) properties.alerts.push(warning);
        if ((rank[warning.code] || 0) > (rank[properties.code] || 0)) {
          properties.code = warning.code;
          properties.color = colors[warning.code];
          properties.severity = rank[warning.code];
        }
      }
    }
  }
  // A village circle inside a UAT tinted at the same or a higher level only adds a darker
  // blotch that reads as "more severe". Its warnings move to the UAT popup instead.
  const uats = new Map([...targets.values()].filter(f => f.properties.kind === 'uat').map(f => [f.properties.name, f.properties]));
  for (const [key, { properties }] of targets) {
    const parent = properties.kind === 'place' ? uats.get(properties.uat) : null;
    if (!parent || parent.severity < properties.severity) continue;
    for (const warning of properties.alerts) if (!parent.alerts.some(a => a.id === warning.id)) parent.alerts.push(warning);
    targets.delete(key);
  }
  const features = [...targets.values()].sort((a, b) => rank[a.properties.code] - rank[b.properties.code]);
  for (const feature of features) feature.properties.alerts = JSON.stringify(feature.properties.alerts);
  return { type: 'FeatureCollection', features };
}

/**
 * Which focus outlines a code outline already draws, read off the features that
 * buildAlertGeography actually emitted so its absorption rules live in one place.
 * A village merged into its UAT's outline has no feature of its own, so its circle stays.
 */
export function alertOutlined(geography) {
  const uats = new Set(), places = new Set();
  for (const { properties: p } of geography?.features || []) {
    if (p?.kind === 'uat') uats.add(p.key);
    else if (p?.kind === 'place') places.add(p.key);
  }
  return { uat: name => uats.has(name), place: place => places.has(placeKey(place)) };
}

/**
 * Visual centre of a polygon (pole of inaccessibility): unlike a centroid it always
 * falls inside concave UATs such as Cristinești or Santa Mare. Longitudes are scaled
 * by cos(latitude) so distances are close to metric at the county's latitude.
 */
export function labelPoint(geometry, precision = 0.0005) {
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  let rings = null, largest = -1;
  for (const polygon of polygons) {
    const area = Math.abs(ringArea(polygon[0] || []));
    if (area > largest) { largest = area; rings = polygon; }
  }
  if (!rings?.[0]?.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of rings[0]) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  const k = Math.cos((minY + maxY) / 2 * Math.PI / 180);
  const projected = rings.map(ring => ring.map(([x, y]) => [x * k, y]));
  const x0 = minX * k, x1 = maxX * k, size = Math.min(x1 - x0, maxY - minY);
  if (!size) return [minX, minY];
  const cell = (x, y, h) => { const d = signedDistance(x, y, projected); return { x, y, h, d, max: d + h * Math.SQRT2 }; };
  const heap = [];
  const push = c => { heap.push(c); for (let i = heap.length - 1; i;) { const p = (i - 1) >> 1; if (heap[p].max >= heap[i].max) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < heap.length && heap[l].max > heap[m].max) m = l;
        if (r < heap.length && heap[r].max > heap[m].max) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
      }
    }
    return top;
  };
  const half = size / 2;
  for (let x = x0; x < x1; x += size) for (let y = minY; y < maxY; y += size) push(cell(x + half, y + half, half));
  let best = cell((x0 + x1) / 2, (minY + maxY) / 2, 0);
  while (heap.length) {
    const c = pop();
    if (c.d > best.d) best = c;
    if (c.max - best.d <= precision) continue;
    const q = c.h / 2;
    push(cell(c.x - q, c.y - q, q)); push(cell(c.x + q, c.y - q, q)); push(cell(c.x - q, c.y + q, q)); push(cell(c.x + q, c.y + q, q));
  }
  return [best.x / k, best.y];
}

function ringArea(ring) {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return area / 2;
}

function signedDistance(x, y, rings) {
  let inside = false, min = Infinity;
  for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[j];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
    let px = ax, py = ay;
    const dx = bx - ax, dy = by - ay;
    if (dx || dy) {
      const t = ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy);
      if (t > 1) { px = bx; py = by; } else if (t > 0) { px += dx * t; py += dy * t; }
    }
    min = Math.min(min, (x - px) ** 2 + (y - py) ** 2);
  }
  return (inside ? 1 : -1) * Math.sqrt(min);
}

// UAT geometries are shared admin objects, so their label point is computed once.
const labelPoints = new WeakMap();

/** One point per tinted area for the "NAME / COD …" label. */
export function buildAlertLabels(geography) {
  const features = [];
  for (const feature of geography?.features || []) {
    const p = feature.properties || {};
    let point = labelPoints.get(feature.geometry);
    if (!point) {
      // Village areas are circles: their centre is the mean of the ring.
      const ring = feature.geometry?.coordinates?.[0] || [];
      point = p.kind === 'place' && ring.length > 1
        ? [0, 1].map(i => ring.slice(0, -1).reduce((sum, c) => sum + c[i], 0) / (ring.length - 1))
        : labelPoint(feature.geometry);
      if (point && feature.geometry && typeof feature.geometry === 'object') labelPoints.set(feature.geometry, point);
    }
    if (!point) continue;
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: point },
      properties: { name: p.name, kind: p.kind, code: p.code, severity: p.severity, codeLabel: (labels[p.code] || '').toUpperCase() } });
  }
  return { type: 'FeatureCollection', features };
}

function formatTime(value) {
  if (!value) return 'neprecizat';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return String(value);
  return new Intl.DateTimeFormat('ro-RO', { timeZone: 'Europe/Bucharest', dateStyle: 'short', timeStyle: 'short' }).format(timestamp);
}

/** Escaped popup markup; historic and future warnings remain inspectable. */
export function alertPopupHTML(features, now = Date.now()) {
  const names = new Set(), warnings = new Map();
  let approximate = false;
  for (const feature of features) {
    const p = feature.properties || {};
    names.add(p.name || 'Zonă afectată');
    approximate ||= p.kind === 'place';
    let entries = p.alerts;
    if (typeof entries === 'string') { try { entries = JSON.parse(entries); } catch { entries = []; } }
    for (const warning of Array.isArray(entries) ? entries : []) {
      warnings.set(warning.id || JSON.stringify(warning), warning);
    }
  }
  if (!warnings.size) return '';
  const entries = [...warnings.values()].sort((a, b) => (rank[b.code] || 0) - (rank[a.code] || 0));
  return `<div class="ops-alert-popup"><strong>${[...names].map(escape).join(' · ')}</strong>${entries.map(warning => {
    const start = Date.parse(warning.validFrom), end = Date.parse(warning.validTo);
    const timing = Number.isFinite(end) && end < now ? 'Încheiat' : Number.isFinite(start) && start > now ? 'Urmează' : Number.isFinite(start) && Number.isFinite(end) ? 'În vigoare' : 'Interval incomplet';
    return `<div class="ops-alert-popup-item" data-code="${escape(warning.code)}"><strong>${escape(labels[warning.code] || warning.code)}</strong>${warning.source ? ` · ${escape(warning.source)}` : ''}<br>${escape(formatTime(warning.validFrom))} – ${escape(formatTime(warning.validTo))}<br><small>${timing} · ora României</small>${warning.text ? `<div>${escape(warning.text)}</div>` : ''}</div>`;
  }).join('')}${approximate ? '<p class="ops-alert-popup-note"><small>Zona satului este orientativă (1,6 km).</small></p>' : ''}</div>`;
}

/** Hover on desktop and a tap on mobile. Returns a disposer for teardown. */
export function attachAlertPopups(map, getEnabled = () => true) {
  let popup = null, shown = '', hideTimer = 0;
  const cancelHide = () => { clearTimeout(hideTimer); hideTimer = 0; };
  function clear() { cancelHide(); const open = popup; popup = null; shown = ''; open?.remove(); }
  // Moving from the area onto the popup leaves the layer; wait briefly so the pointer can
  // reach the popup (to scroll it or press ×), and keep it while the pointer is over it.
  function scheduleClear() { cancelHide(); hideTimer = setTimeout(clear, 300); }
  function show(event, reposition = false) {
    if (!getEnabled()) { clear(); return; }
    const html = alertPopupHTML(map.queryRenderedFeatures(event.point, { layers: ['ops-alert-fill'] }));
    if (!html) { clear(); return; }
    cancelHide();
    if (!popup) {
      // focusAfterOpen: false keeps the caret in the warning editor while the pointer crosses the map.
      popup = new maplibregl.Popup({ className: 'ops-alert-popup-wrap', closeButton: true, closeOnClick: false, focusAfterOpen: false, offset: 12, maxWidth: 'min(340px, calc(100vw - 32px))' });
      popup.on?.('close', () => { popup = null; shown = ''; });
    }
    // The popup stays where it opened until the pointer reaches different areas, so it can be reached.
    if (html !== shown || reposition) popup.setLngLat(event.lngLat);
    if (html !== shown) { popup.setHTML(html); shown = html; }
    if (!popup.isOpen()) {
      popup.addTo(map);
      popup.getElement()?.addEventListener('mouseenter', cancelHide);
      popup.getElement()?.addEventListener('mouseleave', scheduleClear);
    }
  }
  const tap = event => show(event, true);
  map.on('mousemove', 'ops-alert-fill', show);
  map.on('mouseleave', 'ops-alert-fill', scheduleClear);
  map.on('click', 'ops-alert-fill', tap);
  map.on('movestart', clear);
  map.on('styledata', clear);
  return () => {
    clear();
    map.off('mousemove', 'ops-alert-fill', show);
    map.off('mouseleave', 'ops-alert-fill', scheduleClear);
    map.off('click', 'ops-alert-fill', tap);
    map.off('movestart', clear);
    map.off('styledata', clear);
  };
}
