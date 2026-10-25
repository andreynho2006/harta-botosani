// Reads a pasted ANM / INHGA warning: its code, validity interval, phenomena and the county's UATs.
// Pure and DOM-free; the editor turns each result into a warning the operator then checks.
import { placeKey } from './operations-alerts.js?v=20261019-multi-alerts';
import { localTime, isoTime } from './operations-time.js';
import { readRivers } from './operations-rivers.js';

const CODE_WORDS = { galben: 'yellow', portocaliu: 'orange', rosu: 'red' };
const MONTHS = {
  ianuarie: 1, ian: 1, februarie: 2, feb: 2, martie: 3, mar: 3, aprilie: 4, apr: 4, mai: 5, iunie: 6, iun: 6,
  iulie: 7, iul: 7, august: 8, aug: 8, septembrie: 9, sept: 9, sep: 9, octombrie: 10, oct: 10, noiembrie: 11, noi: 11, nov: 11, decembrie: 12, dec: 12,
};
const MONTH_NAMES = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const TEXT_LIMIT = 5000;

/** Lower case without diacritics (ş and ș alike), with a map from each folded character back to the original. */
export function foldText(text) {
  let folded = '';
  const origin = [];
  const source = String(text ?? '');
  for (let i = 0; i < source.length; i++) {
    const part = source[i].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    for (const char of part) { folded += char; origin.push(i); }
  }
  return { folded, origin };
}

/** A name as compared: folded, hyphens and dashes as spaces, single spaces, no edge punctuation. */
export const nameKey = value => foldText(value).folded.replace(/[-‐-―]/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

function distance(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const kept = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = kept;
    }
  }
  return row[b.length];
}

/** The single name within one edit of `key` (for names of five letters or more), else null. */
function closest(key, names) {
  if (key.length < 5) return null;
  const near = names.filter(name => distance(key, name.key) <= 1);
  return near.length === 1 ? near[0] : null;
}

const LEAD_WORDS = /^(?:(?:localitatile|localitatea|localitati|loc|comunele|comuna|com|orasele|orasul|oras|or|municipiile|municipiul|mun|satele|satul|sat|uat urile|uat|zonele|zona|si|in)\b\.?\s*)+/;

/**
 * Matches one listed name to a UAT, else to the only county village of that name. A village
 * name shared by several UATs needs its UAT in brackets, "Poiana (Flămânzi)", or stays ambiguous.
 */
function matchName(raw, { uats, villages }) {
  const qualifier = raw.match(/\(([^)]*)\)/)?.[1] || '';
  const key = nameKey(raw.replace(/\([^)]*\)/g, ' ')).replace(LEAD_WORDS, '').trim();
  if (!key) return null;
  // "Corni (județul Suceava)" is another county's Corni.
  const qualified = nameKey(qualifier);
  if (/\bjud/.test(qualified) && !/\bbotosani\b/.test(qualified)) return { unmatched: raw.trim() };
  const uat = uats.find(item => item.key === key) || closest(key, uats);
  if (uat) return { area: uat.name };
  let found = villages.filter(item => item.key === key);
  if (!found.length) { const near = closest(key, villages); if (near) found = villages.filter(item => item.key === near.key); }
  if (qualifier) found = found.filter(item => nameKey(item.place.uat) === nameKey(qualifier));
  if (found.length === 1) return { place: placeKey(found[0].place) };
  if (found.length > 1) return { ambiguous: raw.trim(), count: found.length };
  return { unmatched: raw.trim() };
}

function splitList(segment) {
  // "\b" does not see "ș" as a letter, so the conjunction is told by the spaces around it.
  return segment.split(/\s*[,;]\s*|\s+(?:si|și|şi)\s+/i).map(item => item.trim()).filter(Boolean);
}

/** Wall-clock parts as an instant, or '' when the calendar has no such time in Romania. */
function instant({ year, month, day, hour, minute }) {
  const pad = value => String(value).padStart(2, '0');
  try { return isoTime(`${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`); } catch { return ''; }
}

/** The year that puts a day and month closest to now: a message pasted on 31 December may be for January. */
function nearestYear(month, day, today) {
  const base = Date.UTC(today.year, today.month - 1, today.day);
  return [today.year - 1, today.year, today.year + 1]
    .map(year => ({ year, gap: Math.abs(Date.UTC(year, month - 1, day) - base) }))
    .sort((a, b) => a.gap - b.gap)[0].year;
}

// The time after a date, on the same line: "ora 10", "orele 10:30" or a bare "14:20". Four groups.
const TIME = String.raw`(?:[ \t,]*(?:(?:ora|orele)[ \t]*(\d{1,2})(?:[:.](\d{2}))?|(\d{1,2}):(\d{2}))(?!\d))?`;
const timeAt = (m, i) => ({ hour: m[i] ?? m[i + 2], minute: m[i + 1] ?? m[i + 3] });
const DATE_PATTERNS = [
  // 2026-10-25 14:20 or 2026-10-25T14:20
  { re: /\b(\d{4})-(\d{2})-(\d{2})(?:[t ]+(\d{2}):(\d{2}))?/g, parts: m => ({ year: +m[1], month: +m[2], day: +m[3], hour: m[4], minute: m[5] }) },
  // 25.10.2026, ora 14:20 · 25-10-2026 14:20 · 25/10/26
  { re: new RegExp(String.raw`\b(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?!\d)` + TIME, 'g'), parts: m => ({ year: +m[3] < 100 ? 2000 + +m[3] : +m[3], month: +m[2], day: +m[1], ...timeAt(m, 4) }) },
  // 25 octombrie 2026, ora 10 · 25 oct., ora 10:00
  { re: new RegExp(String.raw`\b(\d{1,2})[ \t]+(${MONTH_NAMES})\b\.?(?:[ \t]+(\d{4}))?` + TIME, 'g'), parts: m => ({ year: m[3] ? +m[3] : null, month: MONTHS[m[2]], day: +m[1], ...timeAt(m, 4) }) },
  // 25.10 ora 12:00 (no year: the hour word tells it from a time like 10.30)
  { re: /\b(\d{1,2})\.(\d{1,2})(?![.\d])[ \t,]*(?:ora|orele)[ \t]*(\d{1,2})(?:[:.](\d{2}))?(?!\d)/g, parts: m => ({ year: null, month: +m[2], day: +m[1], hour: m[3], minute: m[4] }) },
];
const TIME_ONLY = /(?:\b(?:ora|orele)[ \t]*(\d{1,2})(?:[:.](\d{2}))?(?!\d)|\b(\d{1,2}):(\d{2})(?!\d))/g;

/** Every date and time in the text, in reading order, each marked when it is the time the message was issued. */
function timeTokens(folded) {
  const tokens = [];
  const taken = [];
  const overlaps = (start, end) => taken.some(([a, b]) => start < b && end > a);
  for (const { re, parts } of DATE_PATTERNS) {
    for (const m of folded.matchAll(re)) {
      if (overlaps(m.index, m.index + m[0].length)) continue;
      const p = parts(m);
      if (p.month < 1 || p.month > 12 || p.day < 1 || p.day > 31 || +(p.hour ?? 0) > 23 || +(p.minute ?? 0) > 59) continue;
      const end = m.index + m[0].trimEnd().length;
      taken.push([m.index, end]);
      tokens.push({ index: m.index, end, date: { year: p.year, month: p.month, day: p.day }, time: p.hour !== undefined ? { hour: +p.hour, minute: +(p.minute || 0) } : null });
    }
  }
  for (const m of folded.matchAll(TIME_ONLY)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    const hour = +(m[1] ?? m[3]), minute = +(m[2] ?? m[4] ?? 0);
    if (hour > 23 || minute > 59) continue;
    taken.push([m.index, m.index + m[0].length]);
    tokens.push({ index: m.index, end: m.index + m[0].length, date: null, time: { hour, minute } });
  }
  tokens.sort((a, b) => a.index - b.index);
  // A date whose hour wrapped to the next line, "20.10.2026\nora 18:00", is one time.
  for (let i = 0; i < tokens.length - 1; i++) {
    const [token, next] = [tokens[i], tokens[i + 1]];
    if (token.date && !token.time && !next.date && /^[\s,]*$/.test(folded.slice(token.end, next.index))) {
      Object.assign(token, { time: next.time, end: next.end });
      tokens.splice(i + 1, 1);
    }
  }
  // Issued when, on its own line, a word of issue comes after the last word of validity.
  const lastAt = (text, re) => Math.max(-1, ...[...text.matchAll(re)].map(m => m.index));
  // An end when "până" is the last word of validity before it: "până la ora 11", "până la: 19:30".
  // The words that count are those since the previous time, even when their label wrapped.
  tokens.forEach((token, i) => {
    const before = folded.slice(Math.max(i ? tokens[i - 1].end : 0, token.index - 60), token.index);
    token.issued = lastAt(before, /emis|emiter|actualiz|transmis/g) > lastAt(before, /valabil|interval|de la|pana/g);
    token.until = lastAt(before, /pana/g) > lastAt(before, /valabil|interval|de la|incepand/g);
  });
  return tokens;
}

/**
 * The validity interval: the first two times after "valabil" / "interval" (else in the text),
 * skipping the time of issue. A time without a date takes the date before it, else today; an end
 * at an earlier hour on an inherited date is the next day. A reversed interval keeps only its start.
 */
function readInterval(folded, today) {
  const tokens = timeTokens(folded);
  const anchor = folded.search(/valabil|interval|in intervalul|de la/);
  const usable = tokens.filter(token => !token.issued);
  const after = anchor >= 0 ? usable.filter(token => token.index >= anchor) : [];
  const picked = (after.length ? after : usable).slice(0, 2);
  if (!picked.length) return { validFrom: '', validTo: '', note: 'none' };
  // A lone "până la ora 11:00" is the end of an interval already running.
  const onlyEnd = picked.length === 1 && picked[0].until;
  let context = null;
  const resolved = [];
  for (const token of tokens) {
    if (token.date) context = { ...token.date, year: token.date.year ?? nearestYear(token.date.month, token.date.day, today) };
    if (!picked.includes(token)) continue;
    const date = context || today;
    const end = onlyEnd || resolved.length === 1;
    const time = token.time || (end ? { hour: 23, minute: 59 } : { hour: 0, minute: 0 });
    let value = { year: date.year, month: date.month, day: date.day, ...time };
    if (end && !token.date) {
      const start = resolved[0];
      if (start && (time.hour * 60 + time.minute) < (start.hour * 60 + start.minute) && start.year === value.year && start.month === value.month && start.day === value.day) {
        const next = new Date(Date.UTC(value.year, value.month - 1, value.day + 1));
        value = { ...value, year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
      }
    }
    resolved.push(value);
  }
  const [validFrom = '', validTo = ''] = onlyEnd ? ['', instant(resolved[0])] : resolved.map(instant);
  if (validFrom && validTo && Date.parse(validTo) < Date.parse(validFrom)) return { validFrom, validTo: '', note: 'reversed' };
  return { validFrom, validTo, note: validFrom && validTo ? '' : 'partial' };
}

/** The phenomena paragraph when the message names one, else the whole section, within the field's limit. */
function readText(original) {
  const lines = original.split('\n');
  const start = lines.findIndex(line => /^\s*fenomen\w*(\s+vizate)?\s*[:-]/i.test(foldText(line).folded));
  let text = '';
  if (start >= 0) {
    const body = [lines[start].replace(/^[^:–-]*[:–-]\s*/, '')];
    for (const line of lines.slice(start + 1)) {
      const key = foldText(line).folded.trim();
      if (!key || /^(zon\w*|interval|valabil|cod|judet\w*|localitat\w*|mesaj|nota)\b/.test(key)) break;
      body.push(line.trim());
    }
    text = body.join(' ').replace(/\s+/g, ' ').trim();
  }
  if (!text) text = original.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > TEXT_LIMIT ? { text: text.slice(0, TEXT_LIMIT), cut: true } : { text, cut: false };
}

/**
 * A list runs to the end of its line, a ";", the next county, or a full stop after a word:
 * the stop of an abbreviation such as "mun." or "com." does not end it.
 */
function listAt(folded, start) {
  for (let at = start; ;) {
    const rest = folded.slice(at);
    // "(județul Suceava)" qualifies a name; it does not start the next county.
    const end = rest.search(/\n|;|(?<!\(\s*)\bjud(?:etul|\.)\s|[a-z]{4}\.(?:\s|$)/);
    if (end < 0) return { start, end: folded.length };
    // A line that ends in a comma or "și" wrapped: the list goes on.
    if (rest[end] === '\n' && /(?:,|\bsi)\s*$/.test(rest.slice(0, end))) { at += end + 1; continue; }
    return { start, end: at + (rest[end] === '\n' || rest[end] === ';' || rest.startsWith('jud', end) ? end : rest.indexOf('.', end)) };
  }
}

/** The lists after "Județul Botoșani:", as folded offsets. */
const countyLists = folded => [...folded.matchAll(/\bjud(?:etul|\.)?\s*botosani\s*[:–-]\s*/g)].map(m => listAt(folded, m.index + m[0].length));

/**
 * The section names the whole county: "județul Botoșani", "județele Suceava, Botoșani", not
 * "ISU Botoșani", "al județului Botoșani" or a "Județul Botoșani:" list.
 */
function namesCounty(text) {
  // A county list may wrap after a comma or "și".
  const folded = text.replace(/(,|\bsi)[ \t]*\n[ \t]*/g, '$1 ');
  for (const m of folded.matchAll(/\bjud(?:etul|etele|\.)[ \t]+/g)) {
    const rest = folded.slice(m.index + m[0].length, m.index + m[0].length + 200);
    const clause = rest.slice(0, rest.search(/[.\n;:(]|$/));
    const at = clause.search(/\bbotosani\b/);
    if (at >= 0 && /^[a-z\- ,]*$/.test(clause.slice(0, at)) && !/^\s*[:–-]/.test(rest.slice(at + 8))) return true;
  }
  return false;
}

/** A county-prefixed list for another county, "Județul Suceava:", whose names are not ours to match. */
const otherCountyList = folded => [...folded.matchAll(/\bjud(?:etul|\.)\s*([a-z\-]+)\s*[:–-]/g)].some(m => m[1] !== 'botosani');

/** Romania's counties, folded, by their first word: "a județului, respectiv" names none. */
export const COUNTIES = new Set(['alba', 'arad', 'arges', 'bacau', 'bihor', 'bistrita', 'botosani', 'braila', 'brasov', 'bucuresti', 'buzau',
  'calarasi', 'caras', 'cluj', 'constanta', 'covasna', 'dambovita', 'dolj', 'galati', 'giurgiu', 'gorj', 'harghita', 'hunedoara',
  'ialomita', 'iasi', 'ilfov', 'maramures', 'mehedinti', 'mures', 'neamt', 'olt', 'prahova', 'salaj', 'satu', 'sibiu', 'suceava',
  'teleorman', 'timis', 'tulcea', 'valcea', 'vaslui', 'vrancea']);

/**
 * The clause a list belongs to, back to the last ";", line break or full stop after a word. A line
 * that ends in a comma or "și" wrapped, so the clause goes on above it.
 */
function clauseBefore(folded, at) {
  let from = 0;
  for (const m of folded.slice(0, at).matchAll(/;|\n|[a-z]{4}\.(?=\s)/g)) {
    if (m[0] === '\n' && /(?:,|\bsi)[ \t]*$/.test(folded.slice(from, m.index))) continue;
    from = m.index + m[0].length;
  }
  return folded.slice(from, at);
}

/** The county a list's clause names, "zona de munte a județului Suceava, respectiv zona localităților:": ours, another, or ''. */
function clauseCounty(folded, at) {
  const counties = [...clauseBefore(folded, at).matchAll(/\bjud(?:etului|etul|\.)\s*([a-z]+)/g)].map(m => m[1]).filter(name => COUNTIES.has(name));
  return counties.includes('botosani') ? 'botosani' : counties[0] ?? '';
}

/** Lists after "Zone afectate:", "Zona:", "Localitățile:", "zona localităților:". */
const zoneLists = folded => [...folded.matchAll(/\b(?:zone(?:le)?\s+afectate|zona|zonele|localitatilor|localitatile|localitati|comunele|uat-urile)\s*:\s*/g)]
  .map(m => listAt(folded, m.index + m[0].length));

/** UAT names anywhere in a message without counties or lists, not "ISU Botoșani" or "al județului Botoșani". */
function namesInText(folded, uats) {
  const plain = ` ${folded.replace(/[-‐-―]/g, ' ').replace(/[^a-z0-9]+/g, ' ')} `;
  return uats.filter(uat => {
    for (const m of plain.matchAll(new RegExp(` ${uat.key} `, 'g'))) {
      // Four words back, so "ISU „Nicolae Iorga” Botoșani" is a signature too.
      const before = plain.slice(0, m.index).trim().split(' ').slice(-4);
      if (!before.some(word => ['isu', 'judetul', 'judetului', 'jud', 'inspectoratul', 'prefectura', 'prefecturii', 'consiliul', 'srpv', 'al'].includes(word))) return true;
    }
    return false;
  }).map(uat => uat.name);
}

/** A code heading, "COD GALBEN", "COD: GALBEN" or "Codul de culoare portocaliu"; the sections and the rivers' skipped title both end at it. */
export const CODE_HEADING = /\bcod(?:ul)?(?:\s+de\s+culoare)?\s*[:–-]?\s*(galben|portocaliu|rosu)\b/;

/**
 * Splits a message into one section per code. A different code opens a new section on its own
 * line, or where it is written when the line already holds a section; a title naming two codes
 * together, "cod portocaliu și cod galben", stays with the first. `head` ends the text before the
 * first code, whose interval is shared by sections that give none of their own.
 */
function sections(original) {
  const { folded, origin } = foldText(original);
  const mentions = [...folded.matchAll(new RegExp(CODE_HEADING, 'g'))];
  if (!mentions.length) {
    return { head: 0, list: /\bro[\s-]?alert\b/.test(folded) ? [{ code: 'ro-alert', start: 0, end: original.length }] : [] };
  }
  const list = [];
  let lastEnd = 0;
  for (const m of mentions) {
    const code = CODE_WORDS[m[1]];
    const current = list.at(-1);
    const joined = current && /^[\s,/-]*(?:si\s*)?$/.test(folded.slice(lastEnd, m.index));
    lastEnd = m.index + m[0].length;
    const lineAt = folded.lastIndexOf('\n', m.index) + 1;
    // The same code again opens a section of its own when it heads a line after the current section
    // gave its interval, "MESAJ 2: COD GALBEN" for another region; elsewhere it repeats the title.
    const again = current?.code === code && /^[\w\s:.,-]{0,40}$/.test(folded.slice(lineAt, m.index))
      && /\binterval(?:ul)? de valabilitate\b|\bvalabil/.test(folded.slice(current.at, lineAt));
    if (current && !again && (current.code === code || joined)) continue;
    const lineStart = origin[lineAt] ?? 0;
    const start = !current ? 0 : lineStart > current.start ? lineStart : origin[m.index];
    if (current) current.end = start;
    list.push({ code, start, end: original.length, at: m.index });
  }
  return { head: origin[folded.lastIndexOf('\n', mentions[0].index) + 1] ?? 0, list };
}

function sourceOf(folded) {
  if (/\binhga\b|hidrolog|bazin(?:ele|ul)?\s+hidrografic/.test(folded)) return 'INHGA';
  if (/\banm\b|meteorolog|nowcasting|srpv/.test(folded)) return 'ANM';
  if (/\bro[\s-]?alert\b|\bigsu\b/.test(folded)) return 'IGSU';
  return '';
}

/** The county's UATs and villages, keyed once for matching names. */
function nameIndex(uats, localities) {
  return {
    uats: [...new Set(uats)].map(name => ({ name, key: nameKey(name) })),
    villages: localities.filter(place => place?.uat && place.name).map(place => ({ place, key: nameKey(place.name) })),
  };
}

/** What one section names in the county; `concerns` is false when it is about other counties only. */
function zoneOf(body, index, source) {
  const { folded, origin } = foldText(body);
  const areas = new Set(), places = new Set(), unmatched = [], ambiguous = [];
  let county = false, concerns = false;
  const lists = countyLists(folded);
  // Matched on the original text, so the report names what the message wrote.
  const take = ({ start: from, end: to }) => {
    if (to <= from) return;
    for (const item of splitList(body.slice(origin[from], origin[to - 1] + 1))) {
      const match = matchName(item, index);
      if (!match) continue;
      if (match.area) areas.add(match.area);
      else if (match.place) places.add(match.place);
      else if (match.ambiguous) ambiguous.push({ name: match.ambiguous, count: match.count });
      else unmatched.push(match.unmatched);
    }
  };
  // A "Zona:" whose text opens a clause with a list of its own, "Zona: zona de câmpie a județului …,
  // respectiv zona localităților: …", only labels it: the inner list is the one read.
  const labelled = zoneLists(folded);
  const zones = labelled.filter(list => !labelled.some(other => other.start > list.start && other.start < list.end)
    && !lists.some(range => list.start >= range.start && list.start <= range.end))
    .map(list => ({ ...list, county: clauseCounty(folded, list.start) }));
  const ours = [...lists, ...zones.filter(list => list.county === 'botosani')];
  if (ours.length) { concerns = true; ours.forEach(take); }
  else if (namesCounty(folded)) { concerns = true; county = true; }
  else if (!otherCountyList(folded)) {
    const generic = zones.filter(list => !list.county);
    if (generic.length) generic.forEach(take);
    // Free text is read only when it names no county at all: names repeat across counties.
    else if (!/\bjud(?:et\w*|\.)/.test(folded)) namesInText(folded, index.uats).forEach(name => areas.add(name));
    concerns = areas.size > 0 || places.size > 0;
  }
  if (county && source !== 'INHGA') index.uats.forEach(uat => areas.add(uat.name));
  return { areas: [...areas], places: [...places], county, unmatched, ambiguous, concerns };
}

/**
 * The county's part of a zone text, as { areas, places, county, unmatched, ambiguous, concerns }:
 * the names of a "Județul Botoșani: …" list, every UAT for "județul Botoșani", else the names after
 * "Zona:" in a text naming no other county. `concerns` is false for a text about other counties only.
 */
export const readZone = (text, { uats = [], localities = [], source = '' } = {}) =>
  zoneOf(String(text ?? '').replace(/\r\n?/g, '\n'), nameIndex(uats, localities), source);

/** Today's date in Romania. */
function wallToday(now) {
  const wall = localTime(now.toISOString()).match(/\d+/g).map(Number);
  return { year: wall[0], month: wall[1], day: wall[2] };
}

/** The validity interval a text gives, as { validFrom, validTo, note } (note: '', 'partial', 'reversed' or 'none'). */
export const readValidity = (text, { now = new Date() } = {}) => readInterval(foldText(text).folded, wallToday(now));

/**
 * An INHGA section's zone with the rivers it names (see `readRivers`): when any is kept, their UATs
 * are the areas and the county mark, villages and unmatched names of the text give way to them.
 */
function withRivers(zone, water) {
  if (!water) return { ...zone, rivers: [], smallRivers: false, riverAmbiguous: [] };
  const own = water.rivers.length ? { ...zone, areas: water.areas, places: [], county: false, unmatched: [], ambiguous: [] } : zone;
  return { ...own, rivers: water.rivers, smallRivers: water.smallRivers, riverAmbiguous: water.ambiguous, concerns: zone.concerns || water.concerns };
}

/**
 * Every warning a pasted message holds for the county, as
 * { code, source, validFrom, validTo, text, textCut, areas, places, county, unmatched, ambiguous, rivers, smallRivers, riverAmbiguous, interval }.
 * `county` marks a message for the whole county (its areas are then all UATs, except for INHGA,
 * whose warnings name rivers). With `rivers`, the hydrography's `properties`, an INHGA warning
 * takes the UATs along the rivers it names for the county instead, and `rivers` lists them.
 * Sections that name other counties only are left out, unless no section concerns the county
 * at all or `all` asks for every section.
 */
export function parseWarningText(text, { uats = [], localities = [], rivers = [], now = new Date(), all = false } = {}) {
  const original = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!original.trim()) return [];
  const today = wallToday(now);
  const index = nameIndex(uats, localities);
  const wholeSource = sourceOf(foldText(original).folded);
  const { head, list } = sections(original);
  const shared = readInterval(foldText(original.slice(0, head)).folded, today);
  const results = list.map(({ code, start, end }) => {
    const body = original.slice(start, end);
    const { folded } = foldText(body);
    const source = sourceOf(folded) || wholeSource;
    const zone = withRivers(zoneOf(body, index, source), source === 'INHGA' && rivers.length ? readRivers(body, rivers, { uats }) : null);
    const { text: warningText, cut } = readText(body);
    const own = readInterval(folded, today);
    const { validFrom, validTo, note } = own.note === 'none' && shared.note !== 'none' ? shared : own;
    return { code, source, validFrom, validTo, text: warningText, textCut: cut, ...zone, interval: note };
  });
  const relevant = all ? [] : results.filter(result => result.concerns);
  return (relevant.length ? relevant : results).map(({ concerns, ...result }) => result);
}
