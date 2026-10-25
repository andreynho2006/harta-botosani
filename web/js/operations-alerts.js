// Warning geography belongs to each warning; event geography remains its wider scope.
export const ALERT_CODES = Object.freeze(['yellow', 'orange', 'red', 'ro-alert']);
export const ALERT_LABELS = Object.freeze({ yellow: 'Cod galben', orange: 'Cod portocaliu', red: 'Cod roșu', 'ro-alert': 'RO-Alert' });
export const ALERT_RANK = Object.freeze({ yellow: 1, orange: 2, red: 3, 'ro-alert': 4 });
export const ALERT_COLORS = Object.freeze({ yellow: '#eab308', orange: '#ea580c', red: '#dc2626', 'ro-alert': '#dc2626' });

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
