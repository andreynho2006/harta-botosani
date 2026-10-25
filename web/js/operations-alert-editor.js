import { normalizeAlerts, resolvePlace, placeKey, placeLabel, legacyNote, legacyNoteOverflow, notesWithLegacyNote, countLabel, ALERT_LABELS as CODES } from './operations-alerts.js?v=20261019-multi-alerts';
import { localTime, isoTime, dateLabel, intervalLabel } from './operations-time.js?v=20261025-same-day';
import { parseWarningText } from './operations-alert-parse.js?v=20261025-anm-review';
import { anmWarnings } from './operations-alert-feed.js?v=20261025-anm-review';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fold = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const dateValue = value => { try { return localTime(value); } catch { return ''; } };
/**
 * A displayed date as an instant: '' when empty, null when it is not a real time in Romania.
 * A half-typed date reads as '' too, so the browser's badInput tells it apart from a cleared one.
 */
const displayedInstant = input => {
  if (input.validity?.badInput) return null;
  try { return isoTime(input.value); } catch { return null; }
};
const REVERSED = 'Sfârșitul intervalului trebuie să fie după început.';
const UNREADABLE = 'Date sau ore invalide pentru România.';

/** Every warning date still showing a value the editor rejected. */
const rejectedInputs = root => [...root.querySelectorAll('input[type="datetime-local"][data-warning-field]')].filter(input => input.validationMessage);

/**
 * The first warning date still showing a value the editor rejected. The stored interval stays
 * the last accepted one meanwhile, so keeping the event now would drop what is on screen.
 */
export function rejectedInterval(root) {
  return rejectedInputs(root)[0] || null;
}

// One list per loaded hydrography, so the parser can keep its river index between pastes.
const riverLists = new WeakMap();

/** The cadastre's courses, as the `properties` of the loaded hydrography's features; empty while it is not loaded. */
function riverProperties(data = {}) {
  const features = data.hydrography?.features;
  if (!Array.isArray(features)) return [];
  if (!riverLists.has(features)) riverLists.set(features, features.map(feature => feature.properties).filter(Boolean));
  return riverLists.get(features);
}

/** Stored legacy village names map to their current `Name|UAT` key; unknown entries are kept. */
export function canonicalEntry(kind, entry, localities = []) {
  if (kind !== 'places') return entry;
  const place = resolvePlace(entry, localities);
  return place?.uat ? placeKey(place) : entry;
}

/**
 * Picker options as { value, label, checked }. Villages outside the county are not offered,
 * but a stored entry the list cannot show comes first, so it can still be cleared.
 */
export function warningOptions(kind, data = {}, stored = []) {
  const values = kind === 'areas'
    ? (data.admin?.features || []).filter(f => f.properties?.kind === 'uat').map(f => f.properties.name)
    : (data.localities || []).filter(place => place.uat && place.name).map(placeKey);
  const label = value => kind === 'places' ? placeLabel(value) : value;
  const options = [...new Set(values.filter(Boolean))].map(value => ({ value, label: label(value) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ro'));
  const selected = new Set(stored.map(entry => canonicalEntry(kind, entry, data.localities)));
  const listed = new Set(options.map(option => option.value));
  const unlisted = [...selected].filter(value => !listed.has(value)).map(value => ({ value, label: `${label(value)} (în afara listei)` }));
  return [...unlisted, ...options].map(option => ({ ...option, checked: selected.has(option.value) }));
}

/** The county's municipalities and towns: the UATs holding a city or town of the index. */
export function urbanUats(data = {}) {
  const listed = new Set(warningOptions('areas', data).map(option => option.value));
  return [...new Set((data.localities || []).filter(place => ['city', 'town'].includes(place.kind) && listed.has(place.uat)).map(place => place.uat))];
}

/** A preset's UAT list: null while the map data that defines it has not loaded. */
export function presetAreas(preset, data = {}) {
  if (preset === 'none') return [];
  const areas = preset === 'all' ? warningOptions('areas', data).map(option => option.value) : preset === 'urban' ? urbanUats(data) : [];
  return areas.length ? areas : null;
}

/**
 * `fetchFeeds` reads the ANM feeds (see `fetchAnmFeeds`); `blocked` says why the situation cannot
 * take new warnings right now, such as a marker form a re-render would lose.
 */
export function createAlertEditor({ panel, getActive, getData, onChange, onPickMap, fetchFeeds, blocked = () => '' }) {
  // The warning drawn open at the next render: a new one, or the one just picked on the map.
  let newId = null;
  // What the last pasted message gave, shown under the paste box of that situation until the next add or removal.
  let parseReport = null;
  // Text pasted but not yet recognised: a render, such as a colleague's version arriving, keeps it.
  let pasteDraft = null;
  // The situation whose ANM import waits for the feed; its button stays busy through a render.
  let importing = null;
  const canonical = (kind, entry) => canonicalEntry(kind, entry, getData()?.localities || []);
  function warnings() { return normalizeAlerts(getActive()); }
  const legacyInterval = note => note.validFrom && note.validTo ? intervalLabel(note.validFrom, note.validTo)
    : note.validFrom || note.validTo ? [note.validFrom, note.validTo].map(value => value ? dateLabel(value) : '…').join(' – ') : '';
  function legacyText(active) {
    const note = legacyNote(active);
    if (!note) return '';
    const overflow = legacyNoteOverflow(active.notes, note, legacyInterval(note));
    return `Mesaj fără cod din arhivă: „${note.text || note.source}”. Apare în prezentare; ${overflow
      ? `„Sinteză operativă” nu mai are loc pentru el: scurteaz-o cu ${countLabel(overflow, 'caracter', 'caractere')}, apoi adaugă avertizarea.`
      : 'la prima avertizare adăugată, textul trece în „Sinteză operativă”.'}`;
  }
  /** The warning list, migrating a legacy event; null while its code-less message does not fit the notes. */
  function editable() {
    const active = getActive();
    if (!active) return [];
    if (!Array.isArray(active.alerts)) {
      // Saving rewrites the legacy field from the warning list, so keep a code-less message in the notes.
      const note = legacyNote(active);
      if (note) {
        const notes = notesWithLegacyNote(active.notes, note, legacyInterval(note));
        if (notes === null) return null;
        active.notes = notes;
      }
      active.alerts = warnings();
    }
    return active.alerts;
  }
  function listHTML(alert, kind, label) {
    const options = warningOptions(kind, getData() || {}, alert[kind] || []);
    return `<details class="ops-alert-picker"><summary>${label} <span data-alert-count="${kind}">${options.filter(option => option.checked).length} selectate</span></summary>
      <label>Caută ${kind === 'areas' ? 'UAT' : 'localitate'}<input type="search" data-alert-search="${kind}" placeholder="Scrie numele…" autocomplete="off"></label>
      <div class="ops-alert-options" role="group" aria-label="${label}">${options.map(option => `<label data-alert-option="${esc(fold(option.label))}"><input type="checkbox" data-alert-area="${kind}" value="${esc(option.value)}" ${option.checked ? 'checked' : ''}><span>${esc(option.label)}</span></label>`).join('')}</div>
      <p class="muted" data-alert-no-results hidden>Niciun rezultat.</p>
      ${options.length ? '' : '<p class="muted">Lista se încarcă odată cu harta.</p>'}
    </details>`;
  }
  const summaryText = alert => `${CODES[alert.code] || 'Avertizare'} · ${countLabel((alert.areas?.length || 0) + (alert.places?.length || 0), 'zonă', 'zone')}`;
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
      ${legacyNote(getActive()) ? `<p class="muted" role="note" data-legacy-note>${esc(legacyText(getActive()))}</p>` : ''}
      <div class="ops-alert-list">${alerts.map((alert, i) => `<details class="ops-alert-entry" data-warning-id="${esc(alert.id)}" ${alerts.length === 1 || alert.id === newId ? 'open' : ''}>
        <summary><span class="ops-alert-dot" data-code="${esc(alert.code)}" aria-hidden="true"></span><span data-alert-summary>${esc(summaryText(alert))}</span></summary>
        <div class="ops-alert-fields">
          <label>Cod / avertizare<select data-warning-field="code">${Object.entries(CODES).map(([key, label]) => `<option value="${key}" ${key === alert.code ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
          <label>Sursă avertizare<input data-warning-field="source" maxlength="300" value="${esc(alert.source)}" placeholder="ANM / INHGA / IGSU"></label>
          <label>Valabil de la (ora României)<input data-warning-field="validFrom" type="datetime-local" value="${dateValue(alert.validFrom)}"></label>
          <label>Valabil până la (ora României)<input data-warning-field="validTo" type="datetime-local" value="${dateValue(alert.validTo)}"></label>
          <label>Fenomene vizate / mesaj<textarea data-warning-field="text" rows="2" maxlength="5000">${esc(alert.text)}</textarea></label>
          <p class="ops-alert-status muted" data-alert-status role="status">${esc(status(alert))}</p>
          <div class="ops-alert-zone" role="group" aria-label="Zona avertizării">
            <button type="button" class="btn" data-alert-preset="all">Tot județul</button>
            <button type="button" class="btn" data-alert-preset="urban">Orașe și municipii</button>
            <button type="button" class="btn" data-alert-preset="none">Niciunul</button>
            <button type="button" class="btn" data-alert-pick>Alege pe hartă</button>
          </div>
          ${listHTML(alert, 'areas', 'Comune / orașe (UAT)')}${listHTML(alert, 'places', 'Localități / sate')}
          <p class="muted">UAT-urile folosesc limitele administrative. Zonele satelor sunt orientative.</p>
          <button type="button" class="btn" data-alert-action="remove" aria-label="Șterge avertizarea ${i + 1}">Șterge avertizarea</button>
        </div></details>`).join('')}</div>
      ${alerts.length ? '' : '<p class="muted">Nicio avertizare adăugată.</p>'}
      <button type="button" class="btn" data-alert-action="add">＋ Adaugă un cod / o avertizare</button>
      ${importButtonHTML()}
      ${pasteHTML()}
    </section>`;
  }
  const reportHTML = lines => lines.map(line => `<p>${esc(line)}</p>`).join('');
  const IMPORT_LABEL = 'Importă din ANM (nowcasting și avertizări generale)';
  // One read at a time: while another situation's import runs, this one's button waits too.
  const importButtonHTML = () => importing
    ? `<button type="button" class="btn" data-alert-action="import-anm" disabled aria-busy="true">${importing === getActive()?.id ? 'Se citesc avertizările ANM…' : 'Se citesc avertizările ANM pentru altă situație…'}</button>`
    : `<button type="button" class="btn" data-alert-action="import-anm">${IMPORT_LABEL}</button>`;
  function setImporting(id) {
    importing = id;
    const button = panel.querySelector('[data-alert-action="import-anm"]');
    if (button) button.outerHTML = importButtonHTML();
  }
  function pasteHTML() {
    const lines = parseReport && parseReport.id === getActive()?.id ? parseReport.lines : [];
    const draft = pasteDraft && pasteDraft.id === getActive()?.id ? pasteDraft.text : '';
    return `<details class="ops-alert-paste" ${lines.length || draft ? 'open' : ''}><summary>Adaugă din textul ANM / INHGA</summary>
      <label>Textul avertizării<textarea data-alert-paste rows="5" maxlength="20000" placeholder="Lipește aici mesajul primit, cu codul, intervalul și zonele afectate…">${esc(draft)}</textarea></label>
      <button type="button" class="btn" data-alert-action="parse">Recunoaște și adaugă</button>
      <div class="ops-alert-report" data-alert-report role="status">${reportHTML(lines)}</div>
    </details>`;
  }
  const showReport = lines => {
    parseReport = { id: getActive()?.id, lines };
    const box = panel.querySelector('[data-alert-report]');
    if (box) box.innerHTML = reportHTML(lines);
    // An import reports here too, so the box shows even while the paste section is folded.
    const section = box?.closest('details');
    if (section) section.open = true;
  };
  const listed = items => items.slice(0, 8).join(', ') + (items.length > 8 ? ` și încă ${items.length - 8}` : '');
  const quoted = names => listed(names.map(name => `„${name}”`));
  const RIVER_SCOPES = { basin: 'bazin', river: 'albie', tributaries: 'afluenți' };
  const riverLabel = river => `${river.name} – ${RIVER_SCOPES[river.scope]}${river.after ? ` aval de ${river.after}` : ''}${river.before ? ` amonte de ${river.before}` : ''}`;
  /** What the operator must check in each warning made from the text, in the order they were added. */
  function reportLines(found, allUats, from = 'din text', riversLoaded = true) {
    const lines = [`Am adăugat ${countLabel(found.length, 'avertizare', 'avertizări')} ${from}. Verifică-le înainte de publicare.`];
    for (const warning of found) {
      const rivers = warning.rivers || [];
      const zone = warning.zoneOnly?.length ? `doar o parte a județului (${warning.zoneOnly.join(', ')}): alege UAT-urile cu „Alege pe hartă”`
        : rivers.length ? `${countLabel(warning.areas.length, 'UAT riveran', 'UAT-uri riverane')} din cadastrul apelor (${listed(rivers.map(riverLabel))}): verifică-le cu „Alege pe hartă”`
        : warning.county && warning.source === 'INHGA' ? `privește râuri din județ, nu UAT-uri: alege UAT-urile riverane cu „Alege pe hartă”${riversLoaded ? '' : ' (lista râurilor nu e încărcată)'}`
        : warning.county && warning.areas.length === allUats ? 'tot județul'
        : warning.areas.length || warning.places.length ? [warning.areas.length && countLabel(warning.areas.length, 'UAT', 'UAT-uri'), warning.places.length && countLabel(warning.places.length, 'sat', 'sate')].filter(Boolean).join(' și ')
        : 'nicio zonă din județ recunoscută: alege-o cu butoanele zonei';
      const interval = warning.validFrom && warning.validTo ? intervalLabel(warning.validFrom, warning.validTo)
        : warning.interval === 'reversed' ? 'sfârșitul intervalului era înaintea începutului, completează-l'
        : warning.validFrom || warning.validTo ? 'interval incomplet, completează-l' : 'fără interval, completează-l';
      lines.push(`${CODES[warning.code]}${warning.source ? ` (${warning.source})` : ''}: ${zone}; ${interval}.`);
      const sectors = [...new Set(rivers.filter(river => river.sector).map(river => river.name))];
      if (sectors.length) lines.push(`Sectorul din text e delimitat aproximativ: am luat toată albia sau toți afluenții din județ pentru ${sectors.join(', ')}.`);
      if (warning.smallRivers) lines.push('Textul privește și „unele râuri mici” din tot județul: extinde zona dacă e cazul.');
      for (const name of warning.riverAmbiguous || []) lines.push(`„${name}”: mai multe cursuri de apă cu acest nume; alege UAT-urile cu „Alege pe hartă”.`);
      if (warning.unmatched.length) lines.push(`Nerecunoscute: ${quoted(warning.unmatched)}.`);
      for (const { name, count } of warning.ambiguous) lines.push(`„${name}”: ${count} sate cu acest nume în județ. Alege-l din „Localități / sate”.`);
      if (warning.textCut) lines.push('Textul fenomenelor avea peste 5 000 de caractere: au rămas primele 5 000.');
    }
    return lines;
  }
  /** Adds one warning per code the pasted message holds for the county. */
  function addFromText(button) {
    const text = button.closest('.ops-alert-paste')?.querySelector('[data-alert-paste]')?.value || '';
    if (!text.trim()) { showReport(['Lipește întâi textul avertizării în casetă.']); return; }
    const data = getData() || {};
    const uats = warningOptions('areas', data).map(option => option.value);
    if (!uats.length) { showReport(['Lista UAT-urilor se încarcă odată cu harta. Încearcă din nou după încărcare.']); return; }
    const rivers = riverProperties(data);
    const found = parseWarningText(text, { uats, localities: data.localities || [], rivers });
    if (!found.length) { showReport(['Nu am găsit în text codul avertizării (galben, portocaliu, roșu sau RO-Alert). Nu am adăugat nimic.']); return; }
    const alerts = editableOrExplain();
    if (!alerts) return;
    const added = found.map(newWarning);
    alerts.push(...added);
    newId = added[0].id;
    pasteDraft = null;
    parseReport = { id: getActive().id, lines: reportLines(found, uats.length, 'din text', rivers.length > 0) };
    onChange({ render: true, geography: true });
  }
  const newWarning = warning => ({ id: warning.id ?? crypto.randomUUID(), code: warning.code, source: warning.source, validFrom: warning.validFrom, validTo: warning.validTo, text: warning.text, areas: warning.areas, places: warning.places });
  /**
   * Adds the county's warnings ANM publishes now. One already imported, with the same content,
   * is not added twice; a nowcasting ANM changed since is added again, and the report says so.
   */
  async function importFromAnm() {
    const id = getActive()?.id;
    if (!id || importing) return;
    const data = getData() || {};
    const uats = warningOptions('areas', data).map(option => option.value);
    if (!uats.length) { showReport(['Lista UAT-urilor se încarcă odată cu harta. Încearcă din nou după încărcare.']); return; }
    if (!editableOrExplain()) return;
    setImporting(id);
    showReport(['Se citesc avertizările ANM…']);
    let feeds;
    try { feeds = await fetchFeeds(); } catch (error) { feeds = { errors: { nowcasting: String(error), general: String(error) } }; }
    setImporting(null);
    // Another situation opened meanwhile: nothing is added, and this one's report no longer says "reading".
    if (getActive()?.id !== id) {
      if (parseReport?.id === id) parseReport = { id, lines: ['Importul din ANM s-a oprit: între timp ai deschis altă situație. Apasă din nou „Importă din ANM”.'] };
      return;
    }
    const errors = feeds?.errors || {};
    if (errors.nowcasting && errors.general) {
      showReport(['Nu am putut citi avertizările ANM: fără conexiune sau site-ul meteoromania.ro nu răspunde. Încearcă din nou sau lipește textul mai jos.']);
      return;
    }
    const notes = [errors.nowcasting && 'Nowcasting-ul ANM nu a putut fi citit; am folosit doar avertizările generale.', errors.general && 'Avertizările generale ANM nu au putut fi citite; am folosit doar nowcasting-ul.'].filter(Boolean);
    const found = anmWarnings(feeds, { uats, localities: data.localities || [], now: new Date() });
    if (!found.length) { showReport([...notes, 'ANM nu are acum nicio avertizare pentru județul Botoșani. Nu am adăugat nimic.']); return; }
    const why = blocked();
    if (why) { showReport([...notes, why]); return; }
    const alerts = editableOrExplain();
    if (!alerts) { showReport([...notes, 'Nu am adăugat nimic: notele situației trebuie scurtate întâi, după cum scrie deasupra listei.']); return; }
    const held = new Set(alerts.map(alert => alert.id));
    const fresh = found.filter(warning => !held.has(warning.id));
    const kept = found.length - fresh.length;
    if (!fresh.length) { showReport([...notes, `Avertizările ANM pentru județ sunt deja în listă (${kept}). Nu am adăugat nimic.`]); return; }
    // A nowcasting ANM updated keeps its time of issue and code, so its earlier version shares the prefix.
    const updated = fresh.filter(warning => warning.key !== warning.id && alerts.some(alert => alert.id.startsWith(`${warning.key}-`)));
    const added = fresh.map(newWarning);
    alerts.push(...added);
    newId = added[0].id;
    const lines = reportLines(fresh, uats.length, 'din ANM');
    for (const warning of updated) lines.push(`${CODES[warning.code]} (${warning.source}) are aceeași oră de emitere ca una importată deja: dacă ANM a actualizat-o, șterge versiunea veche.`);
    if (kept) lines.push(`Deja în listă: ${countLabel(kept, 'avertizare ANM', 'avertizări ANM')}.`);
    parseReport = { id, lines: [...notes, ...lines] };
    onChange({ render: true, geography: true });
  }
  function updateStatus(entry, alert) {
    const summary = entry.querySelector('[data-alert-summary]');
    if (summary) summary.textContent = summaryText(alert);
    const dot = entry.querySelector('.ops-alert-dot');
    if (dot) dot.dataset.code = alert.code;
    const note = entry.querySelector('[data-alert-status]');
    // A rejected date stays on screen until corrected, so keep saying so.
    const rejected = [...entry.querySelectorAll('input[type="datetime-local"]')].some(input => input.validationMessage);
    if (note) note.textContent = rejected ? 'Interval invalid: corectează data înainte de salvare.' : status(alert);
    for (const kind of ['areas', 'places']) {
      const count = entry.querySelector(`[data-alert-count="${kind}"]`);
      if (count) count.textContent = `${alert[kind]?.length || 0} selectate`;
    }
  }
  function handleInput(target) {
    // The pasted text is read only on "Recunoaște și adaugă"; typing there changes nothing in the situation.
    if (target.dataset.alertPaste !== undefined) { pasteDraft = { id: getActive()?.id, text: target.value }; return true; }
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
  /**
   * An endpoint is judged against the other input as displayed, not as stored: after a rejected
   * date the two differ, and the screen is what the operator is correcting.
   */
  function editInterval(entry, target, field) {
    const stored = warnings().find(alert => alert.id === entry.dataset.warningId);
    if (!stored) return true;
    const otherField = field === 'validFrom' ? 'validTo' : 'validFrom';
    const other = [...entry.querySelectorAll('input[type="datetime-local"]')]
      .find(input => input !== target && input.dataset.warningField === otherField);
    const reject = message => {
      target.setCustomValidity(message);
      target.reportValidity();
      updateStatus(entry, stored);
      return true;
    };
    const value = displayedInstant(target);
    if (value === null) return reject(UNREADABLE);
    // When the other input holds a time the editor cannot read, its stored value stands in.
    const shown = other ? displayedInstant(other) : null;
    const otherValue = shown ?? stored[otherField];
    const [from, to] = field === 'validFrom' ? [value, otherValue] : [otherValue, value];
    if (from && to && Date.parse(to) < Date.parse(from)) return reject(REVERSED);
    target.setCustomValidity('');
    const alert = editable()?.find(item => item.id === stored.id);
    if (!alert) return true;
    let changedValue = false;
    const keep = (name, instant) => { if (alert[name] !== instant) { alert[name] = instant; changedValue = true; } };
    keep(field, value);
    // The other end was flagged against a date that has since changed: what it shows is consistent now.
    if (other?.validationMessage === REVERSED && shown !== null) { other.setCustomValidity(''); keep(otherField, shown); }
    updateStatus(entry, alert);
    if (changedValue) onChange({ render: false, geography: false });
    return true;
  }
  function editField(target) {
    const entry = target.closest('[data-warning-id]');
    const field = target.dataset.warningField;
    if (!entry || !['code', 'source', 'validFrom', 'validTo', 'text'].includes(field)) return false;
    if (field === 'validFrom' || field === 'validTo') return editInterval(entry, target, field);
    const value = target.value;
    if (field === 'code' && !CODES[value]) return true;
    const alert = editable().find(item => item.id === entry.dataset.warningId);
    if (!alert || alert[field] === value) return true;
    alert[field] = value;
    updateStatus(entry, alert);
    onChange({ render: false, geography: false });
    return true;
  }
  /** True when a warning date is still rejected: opens that warning and points at the date. */
  function revealRejectedInterval() {
    const input = rejectedInterval(panel);
    if (!input) return false;
    const entry = input.closest('[data-warning-id]');
    if (entry) entry.open = true;
    input.focus?.();
    input.reportValidity();
    return true;
  }
  /**
   * A rejected date lives only in its input while the stored interval stays the last accepted one,
   * and a render rebuilds the panel from the stored event. Take them before and put them back
   * after, or the typed date and the invalid status would vanish without a word.
   */
  function rejectedDates() {
    return rejectedInputs(panel).flatMap(input => {
      const id = input.closest('[data-warning-id]')?.dataset.warningId;
      return id ? [{ id, field: input.dataset.warningField, value: input.value, message: input.validationMessage }] : [];
    });
  }
  function restoreRejectedDates(dates) {
    if (!dates?.length) return;
    const alerts = warnings();
    for (const entry of panel.querySelectorAll('[data-warning-id]')) {
      const mine = dates.filter(date => date.id === entry.dataset.warningId);
      const alert = alerts.find(item => item.id === entry.dataset.warningId);
      if (!mine.length || !alert) continue;
      const inputs = [...entry.querySelectorAll('input[type="datetime-local"]')];
      for (const { field, value, message } of mine) {
        const input = inputs.find(item => item.dataset.warningField === field);
        if (!input) continue;
        input.value = value;
        input.setCustomValidity(message);
      }
      entry.open = true;
      updateStatus(entry, alert);
    }
  }
  function handleChange(target) {
    if (target.dataset.alertPaste !== undefined) return true;
    if (target.dataset.warningField) return editField(target);
    const kind = target.dataset.alertArea;
    if (!['areas', 'places'].includes(kind)) return false;
    const entry = target.closest('[data-warning-id]');
    const alert = editable().find(item => item.id === entry?.dataset.warningId);
    if (!alert) return true;
    const selected = new Set((alert[kind] || []).map(item => canonical(kind, item)));
    // Accept a listed option, or clearing an entry that is stored but no longer listed.
    const listed = warningOptions(kind, getData() || {}).some(option => option.value === target.value);
    if (!listed && !(selected.has(target.value) && !target.checked)) return true;
    if (target.checked) selected.add(target.value); else selected.delete(target.value);
    alert[kind] = [...selected];
    updateStatus(entry, alert);
    onChange({ render: false, geography: true });
    return true;
  }
  /** The warning list, or null after saying how much the notes must lose before a legacy event can migrate. */
  function editableOrExplain() {
    const alerts = editable();
    if (!alerts) {
      // The notes may have grown since the last render, so say how much to shorten now.
      const note = panel.querySelector('[data-legacy-note]');
      if (note) { note.textContent = legacyText(getActive()); note.setAttribute('role', 'alert'); }
    }
    return alerts;
  }
  /** A preset replaces the warning's UATs and leaves its villages; "Niciunul" clears both. */
  function applyPreset(entry, preset) {
    const alert = editableOrExplain()?.find(item => item.id === entry?.dataset.warningId);
    if (!alert) return;
    const areas = presetAreas(preset, getData() || {});
    const note = entry.querySelector('[data-alert-status]');
    if (!areas) { if (note) note.textContent = 'Lista UAT-urilor se încarcă odată cu harta.'; return; }
    const next = { areas, places: preset === 'none' ? [] : alert.places || [] };
    const same = ['areas', 'places'].every(kind => {
      const before = new Set((alert[kind] || []).map(item => canonical(kind, item)));
      return before.size === next[kind].length && next[kind].every(value => before.has(canonical(kind, value)));
    });
    if (same) return;
    Object.assign(alert, next);
    // The picker lists stay as they are, open or closed: only their boxes follow.
    for (const kind of ['areas', 'places']) {
      const chosen = new Set(alert[kind].map(item => canonical(kind, item)));
      for (const box of entry.querySelectorAll(`input[data-alert-area="${kind}"]`)) box.checked = chosen.has(box.value);
    }
    updateStatus(entry, alert);
    onChange({ render: false, geography: true });
  }
  function handleClick(button) {
    if (!getActive()) return false;
    const entry = () => button.closest('[data-warning-id]');
    if (button?.dataset.alertPreset) { applyPreset(entry(), button.dataset.alertPreset); return true; }
    if (button?.dataset.alertPick !== undefined) {
      const alert = editableOrExplain()?.find(item => item.id === entry()?.dataset.warningId);
      // Drawn open again once the pick ends.
      if (alert) { newId = alert.id; onPickMap?.(alert.id); }
      return true;
    }
    const action = button?.dataset.alertAction;
    if (!['add', 'remove', 'parse', 'import-anm'].includes(action)) return false;
    if (action === 'parse') { addFromText(button); return true; }
    if (action === 'import-anm') { importFromAnm(); return true; }
    const alerts = editableOrExplain();
    if (!alerts) return true;
    parseReport = null;
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
  /**
   * Adds or removes a UAT picked on the map for one warning; `add` only adds, for a brush stroke.
   * False when the warning is gone or nothing changed. The caller re-renders.
   */
  function pickArea(id, name, { add = false } = {}) {
    const alert = (Array.isArray(getActive()?.alerts) ? getActive().alerts : []).find(item => item.id === id);
    if (!alert || !name) return false;
    const areas = alert.areas || [];
    if (areas.includes(name)) {
      if (add) return false;
      alert.areas = areas.filter(item => item !== name);
    } else alert.areas = [...areas, name];
    return true;
  }
  /** What the map pick says it edits; '' once the warning is gone. */
  function describe(id) {
    const alert = warnings().find(item => item.id === id);
    return alert ? summaryText(alert) : '';
  }
  return { html, handleInput, handleChange, handleClick, revealRejectedInterval, rejectedDates, restoreRejectedDates, pickArea, describe };
}
