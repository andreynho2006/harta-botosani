// Warning geography belongs to each warning; event geography remains its wider scope.
export const ALERT_CODES = Object.freeze(['yellow', 'orange', 'red', 'ro-alert']);

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
