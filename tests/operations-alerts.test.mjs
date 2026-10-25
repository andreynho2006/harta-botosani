import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAlerts, affectedAlertLocations, warningsForLocation, placeKey, resolvePlace, placeLabel, legacyNote, legacyNoteOverflow, notesWithLegacyNote, countLabel } from '../web/js/operations-alerts.js';
import { createEvent, sanitizeEvent, EventStore } from '../web/js/event-store.js';
import { warningOptions, createAlertEditor, rejectedInterval } from '../web/js/operations-alert-editor.js';
import { isoTime, localTime } from '../web/js/operations-time.js';

const alert = (id, code, areas, places = []) => ({ id, code, source: 'ANM', validFrom: '2026-10-19T10:00:00+03:00', validTo: '2026-10-19T18:00:00+03:00', text: 'Vânt puternic', areas, places });
function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test('legacy warnings keep their original localities without mutating the archive', () => {
  const event = { alert: { code: 'orange', validFrom: '2026-10-17T08:00:00Z' }, areas: ['Vlădeni'], places: ['Huțani'] };
  const normalized = normalizeAlerts(event);
  assert.equal(normalized[0].id, 'legacy-alert');
  assert.deepEqual(normalized[0].areas, ['Vlădeni']);
  assert.deepEqual(normalized[0].places, ['Huțani']);
  assert.equal(normalized[0].validFrom, event.alert.validFrom);
  normalized[0].areas.push('Botoșani');
  assert.deepEqual(event.areas, ['Vlădeni']);
  assert.deepEqual(normalizeAlerts({ alert: { code: '' }, areas: ['Botoșani'] }), []);
});

test('explicit warning geography overrides legacy fields and an empty list stays empty', () => {
  const event = { alert: { code: 'red' }, areas: ['Botoșani'], alerts: [alert('a', 'yellow', ['Dorohoi'])] };
  assert.deepEqual(normalizeAlerts(event)[0].areas, ['Dorohoi']);
  assert.deepEqual(normalizeAlerts({ ...event, alerts: [] }), []);
  assert.deepEqual(normalizeAlerts({ ...event, alerts: [{ id: 'b', code: 'orange' }] })[0].areas, []);
});

test('concurrent codes retain independent locations and validity through save, export and import', () => {
  const event = createEvent('Avertizări simultane', 'storm');
  event.areas = ['Botoșani', 'Dorohoi'];
  event.alerts = [alert('yellow-a', 'yellow', ['Botoșani'], ['Agafton']), alert('red-b', 'red', ['Botoșani', 'Dorohoi'])];
  event.alerts[1].validFrom = '2026-10-19T16:00:00+03:00';
  const store = new EventStore(memoryStorage());
  const saved = store.save(event);
  const imported = new EventStore(memoryStorage());
  imported.importArchive(JSON.stringify(store.exportArchive()));
  assert.deepEqual(imported.load(event.id).alerts, saved.alerts);
  assert.equal(saved.alerts[0].validFrom, '2026-10-19T07:00:00.000Z');
  assert.equal(saved.alerts[1].validFrom, '2026-10-19T13:00:00.000Z');
  assert.deepEqual(warningsForLocation(saved, 'uat', 'Botoșani').map(a => a.code), ['yellow', 'red']);
  assert.deepEqual(warningsForLocation(saved, 'uat', 'Dorohoi').map(a => a.code), ['red']);
  assert.deepEqual(warningsForLocation(saved, 'place', 'Agafton').map(a => a.code), ['yellow']);
  assert.deepEqual(warningsForLocation(saved, 'uat', 'Agafton'), []);
  assert.deepEqual(warningsForLocation(saved, 'uat', 'Boto'), []);
  assert.deepEqual(affectedAlertLocations(saved), { areas: ['Botoșani', 'Dorohoi'], places: ['Agafton'] });
});

test('Romanian counts take "de" from 20, after round hundreds, but not after 101-119', () => {
  const cases = [[0, '0 sate'], [1, '1 sat'], [2, '2 sate'], [19, '19 sate'], [20, '20 de sate'], [69, '69 de sate'],
    [100, '100 de sate'], [101, '101 sate'], [119, '119 sate'], [120, '120 de sate'], [1000, '1000 de sate']];
  for (const [n, words] of cases) assert.equal(countLabel(n, 'sat', 'sate'), words);
});

test('a code-less legacy message is kept as a note instead of disappearing', () => {
  const event = { alert: { code: '', source: 'IGSU', text: 'Viscol', validFrom: '', validTo: '' }, notes: 'Sinteză' };
  assert.deepEqual(normalizeAlerts(event), [], 'Nothing to colour');
  assert.deepEqual(legacyNote(event), { text: 'Viscol', source: 'IGSU', validFrom: '', validTo: '' });
  assert.equal(legacyNote({ ...event, alerts: [] }), null, 'Once warnings exist the legacy field is only a summary');
  assert.equal(legacyNote({ alert: { code: 'red', text: 'x' } }), null);
  assert.equal(legacyNote({ alert: { code: '' } }), null);
  assert.equal(notesWithLegacyNote('Sinteză', legacyNote(event), '25.10.2026, 12:00 – …'), 'Sinteză\n\nMesaj fără cod (arhivă): Viscol · IGSU · 25.10.2026, 12:00 – …');
  assert.equal(notesWithLegacyNote('', legacyNote(event)), 'Mesaj fără cod (arhivă): Viscol · IGSU');
  const line = 'Mesaj fără cod (arhivă): Viscol · IGSU';
  const fits = 'x'.repeat(10000 - line.length - 2);
  assert.equal(notesWithLegacyNote(fits, legacyNote(event)), `${fits}\n\n${line}`, 'Notes that fit are kept whole');
  assert.equal(legacyNoteOverflow(fits, legacyNote(event)), 0);
  assert.equal(notesWithLegacyNote(`${fits}x`, legacyNote(event)), null, 'Neither text is cut to make room');
  assert.equal(legacyNoteOverflow(`${fits}x`, legacyNote(event)), 1);
  assert.equal(legacyNoteOverflow('x'.repeat(10000), null), 0);
  assert.equal(notesWithLegacyNote('Sinteză', null), 'Sinteză');
});

test('full notes keep a legacy event unmigrated and say how much to shorten', () => {
  const active = { alert: { code: '', source: 'IGSU', text: 'Viscol', validFrom: '', validTo: '' }, notes: 'x'.repeat(10000) };
  const note = { textContent: '', setAttribute(name, value) { this[name] = value; } };
  const panel = { querySelector: selector => selector === '[data-legacy-note]' ? note : null };
  let changes = 0;
  const editor = createAlertEditor({ panel, getActive: () => active, getData: () => ({}), onChange: () => { changes++; } });
  const overflow = legacyNoteOverflow(active.notes, legacyNote(active));
  assert.match(editor.html(), new RegExp(`scurteaz-o cu ${overflow} de caractere`));
  assert.equal(editor.handleClick({ dataset: { alertAction: 'add' } }), true);
  assert.equal(active.alerts, undefined, 'The legacy message stays in place');
  assert.equal(active.notes.length, 10000, 'The notes are not cut');
  assert.equal(changes, 0);
  assert.match(note.textContent, new RegExp(`scurteaz-o cu ${overflow} de caractere`));
  assert.equal(note.role, 'alert');
  // The count is recomputed on each click, not taken from the last render.
  for (const [left, words] of [[19, '19 caractere'], [1, '1 caracter']]) {
    active.notes = 'x'.repeat(10000 - overflow + left);
    editor.handleClick({ dataset: { alertAction: 'add' } });
    assert.match(note.textContent, new RegExp(`scurteaz-o cu ${words},`));
  }

  active.notes = 'x'.repeat(10000 - overflow);
  editor.handleClick({ dataset: { alertAction: 'add' } });
  assert.equal(active.alerts.length, 1);
  assert.equal(active.notes.length, 10000);
  assert.ok(active.notes.endsWith('Mesaj fără cod (arhivă): Viscol · IGSU'));
  assert.doesNotMatch(editor.html(), /data-legacy-note/, 'Once migrated the message lives in the notes');
});

test('villages with the same name are told apart by UAT and legacy names prefer the county', () => {
  const localities = [
    { name: 'Poiana', lon: 27.6, lat: 47.3, uat: '' },
    { name: 'Poiana', lon: 26.9, lat: 47.6, uat: 'Flămânzi' },
    { name: 'Poiana', lon: 26.7, lat: 47.9, uat: 'Ștefănești' },
    { name: 'Curtești', lon: 26.6, lat: 47.8, uat: 'Curtești' },
  ];
  assert.equal(placeKey(localities[2]), 'Poiana|Ștefănești');
  assert.equal(placeKey(localities[0]), 'Poiana');
  assert.equal(resolvePlace('Poiana|Ștefănești', localities), localities[2]);
  assert.equal(resolvePlace('Poiana|Flămânzi', localities), localities[1]);
  assert.equal(resolvePlace('Poiana', localities), localities[1], 'Legacy names skip villages outside the county');
  assert.equal(resolvePlace('Poiana|Hudum', localities), null);
  assert.equal(resolvePlace('Poia', localities), null, 'No prefix matches');
  assert.equal(resolvePlace('Poiana', [{ name: 'Poiana', lon: 1, lat: 2 }]).lon, 1, 'Data without UATs still resolves');
  assert.equal(placeLabel('Poiana|Flămânzi'), 'Poiana (Flămânzi)');
  assert.equal(placeLabel('Curtești|Curtești'), 'Curtești');
  assert.equal(placeLabel('Agafton'), 'Agafton');
});

test('saving derives the legacy warning summary from the most severe warning', () => {
  const event = createEvent('Summary', 'storm');
  event.alert = { code: 'orange', source: 'Old', validFrom: '', validTo: '', text: 'Stale' };
  event.alerts = [alert('y', 'yellow', ['Dorohoi']), alert('r', 'red', ['Botoșani']), alert('r2', 'red', ['Flămânzi'])];
  event.alerts[1].text = 'Ploi torențiale';
  const saved = sanitizeEvent(event);
  assert.deepEqual(saved.alert, { code: 'red', source: 'ANM', validFrom: '2026-10-19T07:00:00.000Z', validTo: '2026-10-19T15:00:00.000Z', text: 'Ploi torențiale' });
  assert.deepEqual(sanitizeEvent({ ...event, alerts: [] }).alert, { code: '', source: '', validFrom: '', validTo: '', text: '' });
  const legacy = { ...event }; delete legacy.alerts;
  assert.equal(sanitizeEvent(legacy).alert.code, 'orange', 'Legacy single warnings stay untouched');
  assert.equal(new EventStore(memoryStorage()).save({ ...event, alerts: [] }).alert.code, '');
});

test('invalid warning lists and reversed intervals are rejected before storage changes', () => {
  const store = new EventStore(memoryStorage());
  const event = createEvent('Weather', 'storm');
  event.alerts = [alert('a', 'yellow', ['Dorohoi'])];
  store.save(event);
  const before = store.load(event.id);
  const bad = [null, {}, [alert('a', 'unknown', [])], [alert('a', 'red', []), alert('a', 'yellow', [])],
    [{ ...alert('a', 'red', []), validTo: '2026-10-18T10:00:00Z' }],
    [{ ...alert('a', 'red', []), areas: 'Botoșani' }],
    [{ ...alert('a', 'red', []), places: [42] }],
    Array.from({ length: 101 }, (_, i) => alert(String(i), 'red', []))];
  for (const alerts of bad) {
    assert.throws(() => store.save({ ...event, alerts }));
    assert.deepEqual(store.load(event.id), before);
  }
  assert.deepEqual(sanitizeEvent({ ...event, alerts: [] }).alerts, []);
});

test('the warning picker offers county villages by UAT and keeps unlisted stored entries clearable', () => {
  const data = { localities: [
    { name: 'Agafton', lon: 26.6, lat: 47.8, uat: 'Curtești' }, { name: 'Braniște', lon: 27.25, lat: 47.8, uat: '' },
    { name: 'Poiana', lon: 26.9, lat: 47.6, uat: 'Flămânzi' },
  ], admin: { features: [{ properties: { kind: 'uat', name: 'Curtești' } }, { properties: { kind: 'judet', name: 'Botoșani' } }] } };
  assert.deepEqual(warningOptions('places', data, ['Braniște', 'Agafton']), [
    { value: 'Braniște', label: 'Braniște (în afara listei)', checked: true },
    { value: 'Agafton|Curtești', label: 'Agafton (Curtești)', checked: true },
    { value: 'Poiana|Flămânzi', label: 'Poiana (Flămânzi)', checked: false },
  ]);
  assert.deepEqual(warningOptions('areas', data, ['Curtești', 'Hârlău']).map(o => [o.value, o.checked]), [['Hârlău', true], ['Curtești', true]]);
  assert.deepEqual(warningOptions('places', data).map(o => o.value), ['Agafton|Curtești', 'Poiana|Flămânzi'], 'Villages outside the county are not offered');
});

// A DOM stand-in for one warning entry: two datetime inputs, its status line, and a marker-style date
// field outside the warnings that must never count as a rejected interval. render() rebuilds the entry
// from the stored alert, as the real panel does, so a rejected date only survives if the editor puts it back.
function intervalStub({ from = '2026-10-25T09:00', to = '2026-10-25T17:00' } = {}) {
  const active = { alerts: [{ id: 'a', code: 'yellow', source: 'ANM', text: '', areas: ['Dorohoi'], places: [], validFrom: from && isoTime(from), validTo: to && isoTime(to) }] };
  const log = { changes: 0, reported: [], focused: null };
  const s = { active, log };
  const build = (shownFrom, shownTo) => {
    const status = { textContent: '' };
    const input = (field, value) => ({
      tagName: 'INPUT', type: 'datetime-local', dataset: { warningField: field }, value, validationMessage: '',
      setCustomValidity(message) { this.validationMessage = message; },
      reportValidity() { log.reported.push(this); return !this.validationMessage; },
      focus() { log.focused = this; },
      closest: () => entry,
    });
    const start = input('validFrom', shownFrom);
    const end = input('validTo', shownTo);
    const inputs = [start, end];
    const entry = {
      dataset: { warningId: active.alerts[0].id }, open: false,
      querySelector: selector => selector === '[data-alert-status]' ? status : null,
      querySelectorAll: selector => selector.includes('datetime-local') ? inputs : [],
    };
    Object.assign(s, { status, start, end, entry, inputs });
  };
  const marker = { tagName: 'INPUT', type: 'datetime-local', dataset: {}, value: '', validationMessage: 'Please enter a valid value.' };
  s.panel = {
    querySelector: () => null,
    querySelectorAll: selector => selector === '[data-warning-id]' ? [s.entry]
      : selector.includes('datetime-local') ? [marker, ...s.inputs].filter(item => !selector.includes('data-warning-field') || item.dataset.warningField) : [],
  };
  s.editor = createAlertEditor({ panel: s.panel, getActive: () => active, getData: () => ({}), onChange: () => { log.changes++; } });
  s.type = (target, value) => { target.value = value; return s.editor.handleChange(target); };
  s.stored = () => [active.alerts[0].validFrom, active.alerts[0].validTo];
  s.render = () => {
    const rejected = s.editor.rejectedDates();
    build(...s.stored().map(value => value ? localTime(value) : ''));
    s.editor.restoreRejectedDates(rejected);
  };
  build(from, to);
  return s;
}
const INVALID = 'Interval invalid: corectează data înainte de salvare.';
const VALID = 'Zona și intervalul sunt asociate acestei avertizări.';

test('a rejected start keeps the stored interval and the invalid status', () => {
  const s = intervalStub();
  const before = s.stored();
  s.type(s.start, '2026-10-26T10:00');
  assert.deepEqual(s.stored(), before);
  assert.ok(s.start.validationMessage);
  assert.equal(s.status.textContent, INVALID);
  assert.equal(s.log.changes, 0);
});

test('a half-typed date is unreadable, not a cleared end of the interval', () => {
  const s = intervalStub();
  const before = s.stored();
  // The browser reports an incomplete datetime-local as value '' with validity.badInput.
  s.start.validity = { badInput: true };
  s.type(s.start, '');
  assert.deepEqual(s.stored(), before, 'The stored start is kept');
  assert.ok(s.start.validationMessage);
  assert.equal(s.status.textContent, INVALID);
  assert.equal(s.log.changes, 0);
  // Clearing the field for real still makes a single-ended interval.
  s.start.validity = { badInput: false };
  s.type(s.start, '');
  assert.deepEqual(s.stored(), ['', before[1]]);
  assert.equal(s.start.validationMessage, '');
});

test('an end is judged against the start as displayed, not the stored one', () => {
  const s = intervalStub();
  const before = s.stored();
  s.type(s.start, '2026-10-26T10:00');
  // Valid against the stored 09:00 start, but the screen shows 26 Oct 10:00 - 25 Oct 12:00.
  s.type(s.end, '2026-10-25T12:00');
  assert.deepEqual(s.stored(), before);
  assert.ok(s.start.validationMessage, 'The start stays flagged');
  assert.ok(s.end.validationMessage, 'The end is flagged too');
  assert.equal(s.status.textContent, INVALID);
  assert.equal(s.log.changes, 0);
});

test('moving a rejected window by its end accepts both dates as displayed', () => {
  const s = intervalStub();
  s.type(s.start, '2026-10-26T10:00');
  s.type(s.end, '2026-10-26T12:00');
  assert.deepEqual(s.stored(), [isoTime('2026-10-26T10:00'), isoTime('2026-10-26T12:00')]);
  assert.equal(s.start.validationMessage, '');
  assert.equal(s.end.validationMessage, '');
  assert.equal(s.status.textContent, VALID);
  assert.equal(s.log.changes, 1);
});

test('typing the stored start back clears the flag and the status without a change', () => {
  const s = intervalStub();
  const before = s.stored();
  s.type(s.start, '2026-10-26T10:00');
  assert.equal(s.type(s.start, '2026-10-25T09:00'), true);
  assert.equal(s.start.validationMessage, '');
  assert.equal(s.status.textContent, VALID);
  assert.deepEqual(s.stored(), before);
  assert.equal(s.log.changes, 0, 'Nothing differs from the stored interval');
});

test('a flag clears only on the input whose displayed value is accepted', () => {
  const s = intervalStub();
  s.type(s.start, '2026-10-26T10:00');
  s.type(s.end, '2026-10-25T12:00');
  // The end is corrected into the shown start: both displayed dates are consistent now.
  s.type(s.end, '2026-10-27T12:00');
  assert.equal(s.end.validationMessage, '');
  assert.equal(s.start.validationMessage, '');
  assert.deepEqual(s.stored(), [isoTime('2026-10-26T10:00'), isoTime('2026-10-27T12:00')]);
  // A start moved past the shown end is flagged alone while the end stays accepted.
  s.type(s.start, '2026-10-28T08:00');
  assert.ok(s.start.validationMessage);
  assert.equal(s.end.validationMessage, '');
  assert.equal(s.status.textContent, INVALID);
  assert.deepEqual(s.stored(), [isoTime('2026-10-26T10:00'), isoTime('2026-10-27T12:00')]);
});

test('an unreadable local time is flagged and the status says so', () => {
  const s = intervalStub();
  const before = s.stored();
  s.type(s.start, '2026-03-29T03:30'); // skipped by the spring clock change
  assert.ok(s.start.validationMessage);
  assert.equal(s.status.textContent, INVALID);
  assert.deepEqual(s.stored(), before);
  s.type(s.start, '2026-10-25T08:00');
  assert.equal(s.start.validationMessage, '');
  assert.equal(s.status.textContent, VALID);
});

test('a warning may keep a single end of its interval', () => {
  const s = intervalStub({ to: '' });
  assert.equal(s.status.textContent, '');
  s.type(s.start, '2026-10-26T10:00');
  assert.equal(s.start.validationMessage, '', 'Nothing to compare with');
  assert.deepEqual(s.stored(), [isoTime('2026-10-26T10:00'), '']);
  s.type(s.end, '2026-10-26T12:00');
  assert.deepEqual(s.stored(), [isoTime('2026-10-26T10:00'), isoTime('2026-10-26T12:00')]);
  s.type(s.start, '');
  assert.deepEqual(s.stored(), ['', isoTime('2026-10-26T12:00')]);
  assert.equal(s.end.validationMessage, '');
  assert.equal(s.status.textContent, 'Completează ambele capete ale intervalului de valabilitate.');
});

test('clearing the other end accepts a rejected date as displayed', () => {
  const s = intervalStub();
  s.type(s.start, '2026-10-26T10:00');
  s.type(s.end, '');
  assert.deepEqual(s.stored(), [isoTime('2026-10-26T10:00'), '']);
  assert.equal(s.start.validationMessage, '');
});

test('the save guard finds a rejected warning date, opens its warning and focuses the input', () => {
  const s = intervalStub();
  assert.equal(rejectedInterval(s.panel), null);
  assert.equal(s.editor.revealRejectedInterval(), false, 'Nothing to block while every date is accepted');
  assert.equal(s.log.focused, null);
  s.type(s.start, '2026-10-26T10:00');
  s.log.reported.length = 0;
  assert.equal(rejectedInterval(s.panel), s.start, 'A marker date field outside the warnings is ignored');
  assert.equal(s.entry.open, false);
  assert.equal(s.editor.revealRejectedInterval(), true);
  assert.equal(s.entry.open, true, 'The warning holding the date is opened');
  assert.equal(s.log.focused, s.start);
  assert.deepEqual(s.log.reported, [s.start], 'The browser message points at the date');
  s.type(s.start, '2026-10-25T09:00');
  assert.equal(s.editor.revealRejectedInterval(), false, 'Correcting the date lifts the block');
  assert.equal(rejectedInterval(s.panel), null);
});

test('a render keeps a rejected date, its flag and the invalid status', () => {
  const s = intervalStub();
  const before = s.stored();
  s.render();
  assert.equal(s.start.value, '2026-10-25T09:00', 'Without a rejected date the stored interval is shown');
  assert.equal(rejectedInterval(s.panel), null);
  s.type(s.start, '2026-10-26T10:00');
  s.render();
  assert.equal(s.start.value, '2026-10-26T10:00', 'The typed date is not replaced by the stored one');
  assert.ok(s.start.validationMessage);
  assert.equal(s.end.validationMessage, '', 'Only the rejected input is flagged again');
  assert.equal(s.status.textContent, INVALID);
  assert.equal(s.entry.open, true, 'The warning holding the date is open');
  assert.equal(rejectedInterval(s.panel), s.start, 'The save guard still finds it');
  assert.deepEqual(s.stored(), before);
  assert.equal(s.log.changes, 0);
  // It can still be corrected after the render.
  s.type(s.start, '2026-10-25T08:00');
  assert.equal(s.start.validationMessage, '');
  assert.equal(s.status.textContent, VALID);
  assert.deepEqual(s.stored(), [isoTime('2026-10-25T08:00'), before[1]]);
  s.render();
  assert.equal(rejectedInterval(s.panel), null, 'A corrected date is not carried over');
});

test('a render keeps every rejected date and drops those of a warning that is gone', () => {
  const s = intervalStub();
  s.type(s.start, '2026-10-26T10:00');
  s.type(s.end, '2026-10-25T12:00');
  s.render();
  assert.deepEqual([s.start.value, s.end.value], ['2026-10-26T10:00', '2026-10-25T12:00']);
  assert.ok(s.start.validationMessage && s.end.validationMessage);
  assert.equal(s.status.textContent, INVALID);
  s.active.alerts[0].id = 'b';
  s.render();
  assert.equal(rejectedInterval(s.panel), null, 'Nothing is restored onto another warning');
  assert.equal(s.start.value, '2026-10-25T09:00');
});
