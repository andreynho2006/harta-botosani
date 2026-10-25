// Warning geography belongs to each warning; event geography remains its wider scope.
export const ALERT_CODES = Object.freeze(['yellow', 'orange', 'red', 'ro-alert']);
export const ALERT_LABELS = Object.freeze({ yellow: 'Cod galben', orange: 'Cod portocaliu', red: 'Cod roșu', 'ro-alert': 'RO-Alert' });
export const ALERT_RANK = Object.freeze({ yellow: 1, orange: 2, red: 3, 'ro-alert': 4 });
export const ALERT_COLORS = Object.freeze({ yellow: '#eab308', orange: '#ea580c', red: '#dc2626', 'ro-alert': '#dc2626' });
// Night and satellite maps are dark: the day colours turn into three browns there.
export const ALERT_COLORS_DARK = Object.freeze({ yellow: '#facc15', orange: '#fb923c', red: '#f87171', 'ro-alert': '#f87171' });
// Label text keeps the code hue but stays readable over its halo.
export const ALERT_INK = Object.freeze({ yellow: '#854d0e', orange: '#9a3412', red: '#991b1b', 'ro-alert': '#991b1b' });
export const ALERT_INK_DARK = Object.freeze({ yellow: '#fde047', orange: '#fdba74', red: '#fca5a5', 'ro-alert': '#fca5a5' });

/**
 * Village names repeat across UATs, so warnings store villages as `Name|UAT`.
 * A plain name is a legacy entry and resolves to the first in-county match.
 */
export const placeKey = place => place?.uat ? `${place.name}|${place.uat}` : String(place?.name ?? '');

export function resolvePlace(entry, localities = []) {
  const [name, uat] = String(entry ?? '').split('|');
  const usable = place => place?.name === name && Number.isFinite(place.lon) && Number.isFinite(place.lat);
  if (uat !== undefined) return localities.find(place => usable(place) && place.uat === uat) || null;
  return localities.find(place => usable(place) && place.uat) || localities.find(usable) || null;
}

export function placeLabel(entry) {
  const [name, uat] = String(entry ?? '').split('|');
  return uat && uat !== name ? `${name} (${uat})` : name;
}

/** Romanian counts: 1 sat, 2 sate, 20 de sate, 101 sate (numbers ending in 00 or 20-99 take "de"). */
export const countLabel = (n, one, many) =>
  n === 1 ? `1 ${one}` : `${n} ${n && (n % 100 === 0 || n % 100 >= 20) ? 'de ' : ''}${many}`;

/** The most severe warning; the first one wins a tie. */
export function mostSevereAlert(alerts = []) {
  return alerts.reduce((top, alert) => (ALERT_RANK[alert?.code] || 0) > (ALERT_RANK[top?.code] || 0) ? alert : top, null);
}

function copyAlert(alert, index, fallback = {}) {
  return {
    id: alert.id || `alert-${index + 1}`, code: alert.code || '',
    source: alert.source || '', validFrom: alert.validFrom || '', validTo: alert.validTo || '', text: alert.text || '',
    areas: [...(alert.areas ?? fallback.areas ?? [])], places: [...(alert.places ?? fallback.places ?? [])],
  };
}

/** Read both archive generations without mutating or silently expanding warning areas. */
export function normalizeAlerts(event) {
  if (Array.isArray(event?.alerts)) return event.alerts.map((alert, index) => copyAlert(alert, index));
  if (!event?.alert?.code) return [];
  return [copyAlert({ ...event.alert, id: 'legacy-alert' }, 0, event)];
}

/**
 * A message saved before multiple warnings existed, with "Fără cod": it has text but no
 * colour. It stays visible and moves into the notes once real warnings are added.
 */
export function legacyNote(event) {
  if (Array.isArray(event?.alerts) || event?.alert?.code) return null;
  const { text = '', source = '', validFrom = '', validTo = '' } = event?.alert || {};
  return text || source || validFrom || validTo ? { text, source, validFrom, validTo } : null;
}

const NOTES_LIMIT = 10000;
const joinLegacyNote = (notes, note, interval) =>
  [notes, `Mesaj fără cod (arhivă): ${[note.text, note.source, interval].filter(Boolean).join(' · ')}`].filter(Boolean).join('\n\n');

/** Characters the notes must lose before the legacy message fits the 10 000-character limit. */
export function legacyNoteOverflow(notes, note, interval = '') {
  return note ? Math.max(0, joinLegacyNote(notes, note, interval).length - NOTES_LIMIT) : 0;
}

/** Notes with the legacy message appended; null when they do not fit, since cutting either loses text. */
export function notesWithLegacyNote(notes, note, interval = '') {
  if (!note) return notes || '';
  return legacyNoteOverflow(notes, note, interval) ? null : joinLegacyNote(notes, note, interval);
}

export function affectedAlertLocations(event) {
  const alerts = normalizeAlerts(event);
  return {
    areas: [...new Set(alerts.flatMap(alert => alert.areas))],
    places: [...new Set(alerts.flatMap(alert => alert.places))],
  };
}

/** Exact names deliberately avoid matching similarly named villages or UATs. */
export function warningsForLocation(event, kind, name) {
  const key = kind === 'uat' || kind === 'area' ? 'areas' : kind === 'place' ? 'places' : null;
  return key ? normalizeAlerts(event).filter(alert => alert[key].includes(name)) : [];
}
