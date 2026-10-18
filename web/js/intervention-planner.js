import { getInterventionUnits } from './intervention-units.js?v=20261018-itineraries-v2';
import { parseCoordinateCandidates } from './subunits.js?v=20261018-itineraries-v2';
import { POI } from './config.js?v=20261018-itineraries-v2';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const validPoint = point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite) &&
  point[0] >= 25.95 && point[0] <= 27.45 && point[1] >= 47.45 && point[1] <= 48.30;
const distanceLabel = value => Number.isFinite(value) ? `${value.toFixed(1)} km` : '–';
const failureMessages = {
  start_too_far: 'Subunitatea este prea departe de rețeaua de drumuri disponibilă (maximum 150 m).',
  end_too_far: 'Obiectivul este prea departe de rețeaua de drumuri disponibilă (maximum 150 m).',
  disconnected_or_blocked: 'Nu există un traseu conectat în datele disponibile, evitând sectoarele blocate.',
  empty_network: 'Rețeaua locală de drumuri nu este disponibilă.',
  invalid_coordinates: 'Verifică poziția subunității și a obiectivului.',
};

/** Event-scoped UI; the host delegates its existing click, change and map handlers here. */
export function createInterventionPlanner(ctx) {
  let opened = false, picking = false, eventId = null, unitId = '', destinationId = '';
  let coordinateText = '', destinationName = '', feedback = '', lastResult = null;
  let worker = null, request = null, sequence = 0;
  const render = () => ctx.render?.();
  const toast = text => ctx.toast?.(text);
  const active = () => ctx.getActive?.() ?? null;
  const units = () => getInterventionUnits(ctx.state?.data?.subunits);

  function stopWorker() {
    if (worker) { worker.onmessage = null; worker.onerror = null; worker.terminate(); worker = null; }
  }
  function invalidate(terminate = false) {
    if (request) clearTimeout(request.timer);
    request = null; lastResult = null;
    if (terminate) stopWorker();
  }
  function context() {
    const nextId = active()?.id ?? null;
    if (eventId !== nextId) {
      eventId = nextId; invalidate(true);
      unitId = ''; destinationId = ''; coordinateText = ''; destinationName = ''; feedback = '';
      if (picking) { picking = false; ctx.onPickEnd?.(); }
      opened = false;
    }
    return active();
  }
  function destinations() {
    const output = [], seen = new Set();
    const add = (feature, prefix, i) => {
      if (feature?.geometry?.type !== 'Point' || !validPoint(feature.geometry.coordinates)) return;
      if (prefix === 'poi' && feature.properties?.cat === 'pompieri') return;
      const id = `${prefix}:${feature.properties?.id ?? feature.id ?? feature.properties?.osm ?? i}`;
      if (seen.has(id)) return;
      seen.add(id);
      const p = feature.properties || {};
      const name = p.name || p.title || POI[p.cat]?.label || p.kind || 'Obiectiv';
      const location = [p.uat, p.addr].filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join(' · ');
      output.push({ id, name: `${name}${location ? ' · ' + location : ''}`.slice(0, 200),
        coordinate: feature.geometry.coordinates.slice(0, 2), group: prefix === 'event' ? 'Marcajele situației' : 'Obiective de pe hartă' });
    };
    (active()?.features?.features ?? []).forEach((feature, i) => add(feature, 'event', i));
    (ctx.state?.data?.pois?.features ?? []).forEach((feature, i) => add(feature, 'poi', i));
    return output.sort((a, b) => a.name.localeCompare(b.name, 'ro'));
  }
  function destination() {
    if (destinationId !== 'custom') return destinations().find(item => item.id === destinationId) ?? null;
    const candidates = parseCoordinateCandidates(coordinateText).filter(validPoint);
    if (!candidates.length) return null;
    const point = candidates[0];
    return { id: 'custom:' + point.map(n => n.toFixed(7)).join(','),
      name: destinationName.trim() || 'Obiectiv selectat', coordinate: point };
  }
  function selection() {
    const unit = units().find(item => item.id === unitId);
    const target = destination();
    if (!unit?.confirmed || !validPoint(unit.coordinate) || !target) return null;
    return { unit, destination: target };
  }
  function key(value) {
    return JSON.stringify([eventId, value?.unit.id, value?.unit.coordinate, value?.destination.id,
      value?.destination.name, value?.destination.coordinate, active()?.features?.features]);
  }
  function cancelPick() {
    if (!picking) return false;
    picking = false; ctx.onPickEnd?.(); render(); return true;
  }
  function html() {
    const event = context();
    if (!event || !opened) return '';
    const roster = units(), selected = selection(), targets = destinations();
    const groups = [...new Set(roster.map(unit => unit.parentLabel))];
    const options = groups.map(group => `<optgroup label="${esc(group)}">${roster.filter(unit => unit.parentLabel === group).map(unit =>
      `<option value="${esc(unit.id)}" ${unit.id === unitId ? 'selected' : ''} ${unit.confirmed ? '' : 'disabled'}>${esc(unit.name)}${unit.confirmed ? '' : ' · coordonate neconfirmate'}</option>`).join('')}</optgroup>`).join('');
    const targetOptions = ['Marcajele situației', 'Obiective de pe hartă'].map(group => {
      const items = targets.filter(item => item.group === group);
      return items.length ? `<optgroup label="${group}">${items.map(item => `<option value="${esc(item.id)}" ${destinationId === item.id ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</optgroup>` : '';
    }).join('');
    return `<section id="ops-itinerary" class="ops-card"><div class="ops-card-title"><h3>Itinerar de intervenție</h3><button class="lnk" type="button" data-itinerary="close">Închide</button></div>
      <label>Subunitatea de plecare<select data-itinerary-field="unit" ${request ? 'disabled' : ''}><option value="">Alege subunitatea…</option>${options}</select></label>
      ${roster.some(unit => !unit.confirmed) ? '<p class="muted">Pentru subunitățile dezactivate sunt necesare coordonatele exacte, confirmate la ieșirea autospecialelor. Completează lista oficială din Administrare; punctele OSM nu sunt folosite ca plecări.</p>' : ''}
      <label>Obiectiv<select data-itinerary-field="destination" ${request ? 'disabled' : ''}><option value="">Alege obiectivul…</option>${targetOptions}<option value="custom" ${destinationId === 'custom' ? 'selected' : ''}>Punct ales pe hartă / coordonate</option></select></label>
      <div class="ops-actions"><button class="btn" type="button" data-itinerary="pick" ${request ? 'disabled' : ''}>${picking ? 'Anulează alegerea' : 'Alege obiectiv pe hartă'}</button></div>
      ${destinationId === 'custom' ? `<label>Denumirea obiectivului<input data-itinerary-field="name" maxlength="200" value="${esc(destinationName)}" placeholder="Ex. obiectivul intervenției" ${request ? 'disabled' : ''}></label><label>Coordonate obiectiv (latitudine, longitudine)<input data-itinerary-field="coordinate" value="${esc(coordinateText)}" placeholder="47.750000, 26.660000" ${request ? 'disabled' : ''}></label>` : ''}
      ${picking ? '<p role="status">Alege punctul exact pe hartă; destinația nu este estimată din conturul unei zone.</p>' : ''}
      <div class="ops-actions"><button class="btn primary" type="button" data-itinerary="calculate" ${selected && !request && !picking ? '' : 'disabled'}>${request ? 'Se calculează local…' : 'Calculează itinerarele'}</button>${request ? '<button class="btn" type="button" data-itinerary="cancel">Anulează calculul</button>' : ''}</div>
      <p class="muted">Trasee orientative; verifică accesul și gabaritul autospecialei. Sensurile și restricțiile din date pot fi incomplete. Calcul local pe drumurile disponibile; sectoarele marcate „Drum blocat” și nerezolvate sunt evitate. Accesul de la punctele alese până la drum se verifică separat.</p>
      ${feedback ? `<p class="ops-notice" data-itinerary-feedback role="status">${esc(feedback)}</p>` : ''}
      ${lastResult?.primary ? `<p data-itinerary-result><b>Principal:</b> ${esc(distanceLabel(lastResult.primary.distanceKm))}${lastResult.alternative ? `<br><b>Rezervă:</b> ${esc(distanceLabel(lastResult.alternative.distanceKm))}` : '<br>Nu există o alternativă suficient de diferită în rețeaua disponibilă.'}</p>` : ''}
      </section>`;
  }
  function calculate() {
    if (request) return;
    const chosen = selection();
    if (!chosen || picking) { feedback = 'Alege o subunitate cu poziție confirmată și un obiectiv valid.'; render(); return; }
    const id = ++sequence, requestKey = key(chosen), event = active();
    feedback = ''; lastResult = null;
    try {
      if (!worker) {
        worker = ctx.createWorker ? ctx.createWorker() : new Worker(new URL('./intervention-route-worker.js?v=20261018-itineraries-v2', import.meta.url), { type: 'module' });
        worker.onmessage = ({ data }) => {
          const current = request;
          if (!current || data?.id !== current.id) return;
          const selected = selection();
          if (active()?.id !== current.eventId || key(selected) !== current.key) { invalidate(); render(); return; }
          clearTimeout(current.timer); request = null;
          if (data.error || !data.result) { feedback = 'Calculul local nu a reușit. Reîncearcă după verificarea datelor de drum.'; stopWorker(); render(); return; }
          lastResult = data.result;
          if (!lastResult.primary) feedback = failureMessages[lastResult.reason] || 'Nu s-a găsit un traseu sigur în rețeaua disponibilă.';
          else {
            const gaps = lastResult.snaps;
            feedback = `Distanțe până la rețeaua rutieră: plecare ${Math.round(gaps?.start?.distanceMeters ?? 0)} m, obiectiv ${Math.round(gaps?.end?.distanceMeters ?? 0)} m. Aceste legături nu sunt desenate ca drumuri.`;
            ctx.onRoutes?.(lastResult, current.meta);
          }
          render();
        };
        worker.onerror = () => { if (request) { invalidate(true); feedback = 'Calculul local nu a reușit. Reîncearcă.'; render(); } };
      }
      request = { id, eventId: event.id, key: requestKey, meta: structuredClone(chosen), timer: null };
      request.timer = setTimeout(() => {
        if (request?.id !== id) return;
        invalidate(true); feedback = 'Calculul a durat prea mult și a fost oprit. Reîncearcă.'; render();
      }, ctx.routeTimeoutMs ?? 30000);
      const blockedFeatures = (event.features?.features ?? []).filter(feature => feature.properties?.kind === 'blocked' && feature.properties?.status !== 'resolved');
      worker.postMessage({ id, start: chosen.unit.coordinate, end: chosen.destination.coordinate, blockedFeatures });
    } catch { invalidate(true); feedback = 'Calculul local nu este disponibil în acest browser.'; }
    render();
  }
  function handleClick(button) {
    context();
    const action = button?.dataset?.itinerary;
    if (button?.dataset?.action === 'open-itinerary') {
      if (!active()) { toast('Deschide mai întâi o situație operativă.'); return true; }
      opened = !opened;
      if (!opened) { cancelPick(); invalidate(true); }
      render(); return true;
    }
    if (!action) return false;
    if (!['close', 'pick', 'calculate', 'cancel'].includes(action)) return false;
    if (action === 'close') { opened = false; cancelPick(); invalidate(true); render(); }
    if (action === 'pick') {
      if (request) return true;
      if (picking) cancelPick();
      else { opened = true; invalidate(); ctx.onPickStart?.(); picking = true; render(); }
    }
    if (action === 'calculate') calculate();
    if (action === 'cancel') { invalidate(true); feedback = 'Calculul a fost anulat.'; render(); }
    return true;
  }
  function handleChange(target) {
    context();
    const field = target?.dataset?.itineraryField;
    if (!['unit', 'destination', 'coordinate', 'name'].includes(field)) return false;
    invalidate(); feedback = '';
    if (field === 'unit') unitId = target.value;
    if (field === 'destination') destinationId = target.value;
    if (field === 'coordinate') coordinateText = String(target.value ?? '');
    if (field === 'name') destinationName = String(target.value ?? '').slice(0, 200);
    if (field === 'coordinate' || field === 'name') {
      // Keep the input mounted while typing or blurring onto the calculate button.
      const section = typeof document === 'undefined' ? null : document.querySelector('#ops-itinerary');
      const calculateButton = section?.querySelector('[data-itinerary=calculate]');
      if (calculateButton) calculateButton.disabled = !selection() || picking;
      section?.querySelector('[data-itinerary-feedback]')?.remove();
      section?.querySelector('[data-itinerary-result]')?.remove();
    } else render();
    return true;
  }
  function handleMapClick(event) {
    context();
    if (!picking) return false;
    const point = [event?.lngLat?.lng, event?.lngLat?.lat];
    if (!validPoint(point)) { toast('Alege un punct din județul Botoșani.'); return true; }
    destinationId = 'custom'; coordinateText = `${point[1].toFixed(7)}, ${point[0].toFixed(7)}`;
    if (!destinationName) destinationName = 'Obiectiv ales pe hartă';
    invalidate(); feedback = ''; cancelPick(); render(); return true;
  }
  return { html, handleClick, handleChange, handleMapClick, isPicking: () => picking, cancelPick };
}
