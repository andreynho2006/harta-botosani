import { normalizeAlerts, ALERT_LABELS as CODES } from './operations-alerts.js?v=20261019-multi-alerts';
import { localTime, isoTime } from './operations-time.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fold = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const dateValue = value => { try { return localTime(value); } catch { return ''; } };

export function createAlertEditor({ panel, getActive, getData, onChange }) {
  let newId = null;
  function geography(kind) {
    const data = getData() || {};
    const names = kind === 'areas'
      ? (data.admin?.features || []).filter(f => f.properties?.kind === 'uat').map(f => f.properties.name)
      : (data.localities || []).map(place => place.name);
    return [...new Set(names.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ro'));
  }
  function warnings() { return normalizeAlerts(getActive()); }
  function editable() {
    const active = getActive();
    if (!active) return [];
    if (!Array.isArray(active.alerts)) active.alerts = warnings();
    return active.alerts;
  }
  function listHTML(alert, kind, label) {
    const selected = new Set(alert[kind] || []);
    const names = geography(kind);
    return `<details class="ops-alert-picker"><summary>${label} <span data-alert-count="${kind}">${selected.size} selectate</span></summary>
      <label>Caută ${kind === 'areas' ? 'UAT' : 'localitate'}<input type="search" data-alert-search="${kind}" placeholder="Scrie numele…" autocomplete="off"></label>
      <div class="ops-alert-options" role="group" aria-label="${label}">${names.map(name => `<label data-alert-option="${esc(fold(name))}"><input type="checkbox" data-alert-area="${kind}" value="${esc(name)}" ${selected.has(name) ? 'checked' : ''}><span>${esc(name)}</span></label>`).join('')}</div>
      <p class="muted" data-alert-no-results hidden>Niciun rezultat.</p>
      ${names.length ? '' : '<p class="muted">Lista se încarcă odată cu harta.</p>'}
    </details>`;
  }
  function status(alert) {
    if (alert.validFrom && alert.validTo && Date.parse(alert.validTo) < Date.parse(alert.validFrom)) return 'Interval invalid: sfârșitul trebuie să fie după început.';
    if (!(alert.areas?.length || alert.places?.length)) return 'Selectează UAT-urile sau localitățile de mai jos pentru a colora harta.';
    if (!alert.validFrom || !alert.validTo) return 'Completează ambele capete ale intervalului de valabilitate.';
    return 'Zona și intervalul sunt asociate acestei avertizări.';
  }
  function html() {
    if (!getActive()) return '';
    const alerts = warnings();
    return `<section class="ops-card" data-ops-card="alerts"><h3>Avertizări și localități sub cod</h3>
      <p class="muted">Fiecare cod are propria zonă și propriul interval. Poți suprapune mai multe avertizări.</p>
      <div class="ops-alert-list">${alerts.map((alert, i) => `<details class="ops-alert-entry" data-warning-id="${esc(alert.id)}" ${alerts.length === 1 || alert.id === newId ? 'open' : ''}>
        <summary><span class="ops-alert-dot" data-code="${esc(alert.code)}" aria-hidden="true"></span><span data-alert-summary>${esc(CODES[alert.code] || 'Avertizare')} · ${(alert.areas?.length || 0) + (alert.places?.length || 0)} zone</span></summary>
        <div class="ops-alert-fields">
          <label>Cod / avertizare<select data-warning-field="code">${Object.entries(CODES).map(([key, label]) => `<option value="${key}" ${key === alert.code ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
          <label>Sursă avertizare<input data-warning-field="source" maxlength="300" value="${esc(alert.source)}" placeholder="ANM / INHGA / IGSU"></label>
          <label>Valabil de la (ora României)<input data-warning-field="validFrom" type="datetime-local" value="${dateValue(alert.validFrom)}"></label>
          <label>Valabil până la (ora României)<input data-warning-field="validTo" type="datetime-local" value="${dateValue(alert.validTo)}"></label>
          <label>Fenomene vizate / mesaj<textarea data-warning-field="text" rows="2" maxlength="5000">${esc(alert.text)}</textarea></label>
          <p class="ops-alert-status muted" data-alert-status role="status">${esc(status(alert))}</p>
          ${listHTML(alert, 'areas', 'Comune / orașe (UAT)')}${listHTML(alert, 'places', 'Localități / sate')}
          <p class="muted">UAT-urile folosesc limitele administrative. Zonele satelor sunt orientative.</p>
          <button type="button" class="btn" data-alert-action="remove" aria-label="Șterge avertizarea ${i + 1}">Șterge avertizarea</button>
        </div></details>`).join('')}</div>
      ${alerts.length ? '' : '<p class="muted">Nicio avertizare adăugată.</p>'}
      <button type="button" class="btn" data-alert-action="add">＋ Adaugă un cod / o avertizare</button>
    </section>`;
  }
  function updateStatus(entry, alert) {
    const summary = entry.querySelector('[data-alert-summary]');
    if (summary) summary.textContent = `${CODES[alert.code] || 'Avertizare'} · ${(alert.areas?.length || 0) + (alert.places?.length || 0)} zone`;
    const dot = entry.querySelector('.ops-alert-dot');
    if (dot) dot.dataset.code = alert.code;
    const note = entry.querySelector('[data-alert-status]');
    if (note) note.textContent = status(alert);
    for (const kind of ['areas', 'places']) {
      const count = entry.querySelector(`[data-alert-count="${kind}"]`);
      if (count) count.textContent = `${alert[kind]?.length || 0} selectate`;
    }
  }
  function handleInput(target) {
    if (target.dataset.alertSearch) {
      const picker = target.closest('.ops-alert-picker');
      const query = fold(target.value);
      let count = 0;
      for (const row of picker.querySelectorAll('[data-alert-option]')) {
        row.hidden = !row.dataset.alertOption.includes(query);
        if (!row.hidden) count++;
      }
      picker.querySelector('[data-alert-no-results]').hidden = count > 0;
      return true;
    }
    if (!target.dataset.warningField || target.tagName === 'SELECT' || target.type === 'datetime-local') return false;
    return editField(target);
  }
  function editField(target) {
    const entry = target.closest('[data-warning-id]');
    const field = target.dataset.warningField;
    if (!entry || !['code', 'source', 'validFrom', 'validTo', 'text'].includes(field)) return false;
    let value = target.value;
    if (field === 'code' && !CODES[value]) return true;
    if (field === 'validFrom' || field === 'validTo') {
      try { value = isoTime(value); } catch { target.setCustomValidity('Date sau ore invalide pentru România.'); target.reportValidity(); return true; }
      const current = warnings().find(alert => alert.id === entry.dataset.warningId);
      const from = field === 'validFrom' ? value : current?.validFrom;
      const to = field === 'validTo' ? value : current?.validTo;
      if (from && to && Date.parse(to) < Date.parse(from)) {
        target.setCustomValidity('Sfârșitul intervalului trebuie să fie după început.');
        target.reportValidity();
        entry.querySelector('[data-alert-status]').textContent = 'Interval invalid: corectează data înainte de salvare.';
        return true;
      }
      entry.querySelectorAll('input[type="datetime-local"]').forEach(input => input.setCustomValidity(''));
    }
    const alert = editable().find(item => item.id === entry.dataset.warningId);
    if (!alert || alert[field] === value) return true;
    alert[field] = value;
    updateStatus(entry, alert);
    onChange({ render: false, geography: false });
    return true;
  }
  function handleChange(target) {
    if (target.dataset.warningField) return editField(target);
    const kind = target.dataset.alertArea;
    if (!['areas', 'places'].includes(kind)) return false;
    if (!geography(kind).includes(target.value)) return true;
    const entry = target.closest('[data-warning-id]');
    const alert = editable().find(item => item.id === entry?.dataset.warningId);
    if (!alert) return true;
    const selected = new Set(alert[kind] || []);
    if (target.checked) selected.add(target.value); else selected.delete(target.value);
    alert[kind] = [...selected];
    updateStatus(entry, alert);
    onChange({ render: false, geography: true });
    return true;
  }
  function handleClick(button) {
    const action = button?.dataset.alertAction;
    if (!['add', 'remove'].includes(action) || !getActive()) return false;
    const alerts = editable();
    if (action === 'add') {
      newId = crypto.randomUUID();
      alerts.push({ id: newId, code: 'yellow', source: '', validFrom: '', validTo: '', text: '', areas: [], places: [] });
    } else {
      const id = button.closest('[data-warning-id]')?.dataset.warningId;
      getActive().alerts = alerts.filter(alert => alert.id !== id);
    }
    onChange({ render: true, geography: true });
    return true;
  }
  return { html, handleInput, handleChange, handleClick };
}
