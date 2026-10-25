/* global maplibregl */
import { normalizeAlerts } from './operations-alerts.js?v=20261019-multi-alerts';

const colors = { yellow: '#eab308', orange: '#ea580c', red: '#dc2626', 'ro-alert': '#dc2626' };
const rank = { yellow: 1, orange: 2, red: 3, 'ro-alert': 4 };
const labels = { yellow: 'Cod galben', orange: 'Cod portocaliu', red: 'Cod roșu', 'ro-alert': 'RO-ALERT' };
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
        const key = `${kind}:${name}`;
        if (!targets.has(key)) {
          let geometry;
          if (kind === 'uat') {
            geometry = admin?.features?.find(f => f.properties?.kind === 'uat' && f.properties.name === name)?.geometry;
          } else {
            const loc = localities.find(l => l.name === name && Number.isFinite(l.lon) && Number.isFinite(l.lat));
            if (loc) geometry = villageGeometry(loc.lon, loc.lat);
          }
          if (!geometry) continue;
          targets.set(key, { type: 'Feature', properties: { name, kind, code: '', color: '', alerts: [] }, geometry });
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
  const features = [...targets.values()].sort((a, b) => rank[a.properties.code] - rank[b.properties.code]);
  for (const feature of features) feature.properties.alerts = JSON.stringify(feature.properties.alerts);
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
  return `<div class="ops-alert-popup" style="max-height:45vh;overflow:auto;line-height:1.45"><strong>${[...names].map(escape).join(' · ')}</strong>${entries.map(warning => {
    const start = Date.parse(warning.validFrom), end = Date.parse(warning.validTo);
    const timing = Number.isFinite(end) && end < now ? 'Încheiat' : Number.isFinite(start) && start > now ? 'Urmează' : Number.isFinite(start) && Number.isFinite(end) ? 'În vigoare' : 'Interval incomplet';
    return `<div style="border-left:4px solid ${colors[warning.code] || '#64748b'};padding-left:8px;margin-top:10px"><strong>${escape(labels[warning.code] || warning.code)}</strong>${warning.source ? ` · ${escape(warning.source)}` : ''}<br>${escape(formatTime(warning.validFrom))} – ${escape(formatTime(warning.validTo))}<br><small>${timing} · ora României</small>${warning.text ? `<div>${escape(warning.text)}</div>` : ''}</div>`;
  }).join('')}${approximate ? '<p style="margin-bottom:0"><small>Zona satului este orientativă (1,6 km).</small></p>' : ''}</div>`;
}

/** Hover on desktop and a tap on mobile. Returns a disposer for teardown. */
export function attachAlertPopups(map, getEnabled = () => true) {
  let popup = null;
  function clear() { popup?.remove(); popup = null; }
  function show(event) {
    if (!getEnabled()) { clear(); return; }
    const features = map.queryRenderedFeatures(event.point, { layers: ['ops-alert-fill'] });
    const html = alertPopupHTML(features);
    if (!html) { clear(); return; }
    popup ??= new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: 'min(340px, calc(100vw - 32px))' });
    popup.setLngLat(event.lngLat).setHTML(html).addTo(map);
  }
  map.on('mousemove', 'ops-alert-fill', show);
  map.on('mouseleave', 'ops-alert-fill', clear);
  map.on('click', 'ops-alert-fill', show);
  map.on('movestart', clear);
  map.on('styledata', clear);
  return () => {
    clear();
    map.off('mousemove', 'ops-alert-fill', show);
    map.off('mouseleave', 'ops-alert-fill', clear);
    map.off('click', 'ops-alert-fill', show);
    map.off('movestart', clear);
    map.off('styledata', clear);
  };
}
