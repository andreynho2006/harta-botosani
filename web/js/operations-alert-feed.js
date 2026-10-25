// Reads the ANM warnings published on meteoromania.ro: the nowcasting and the general warnings that
// concern the county, as warnings the editor adds and the operator then checks.
// Pure apart from `fetchAnmFeeds`, which the editor gets injected.
import { foldText, readZone, readValidity, parseWarningText } from './operations-alert-parse.js?v=20261025-rivers';
import { isoTime, localTime } from './operations-time.js';

const API = 'https://www.meteoromania.ro/wp-json/meteoapi/v2/';
export const ANM_FEEDS = Object.freeze({ nowcasting: `${API}avertizari-nowcasting`, general: `${API}avertizari-generale` });
const COUNTY = 'BT';
const TEXT_LIMIT = 5000;
// A message's own colour counts from 0; a county's or a zone's from 1, where 0 and -1 mean not under the code.
const MESSAGE_CODES = { 0: 'yellow', 1: 'orange', 2: 'red' };
const AREA_CODES = { 1: 'yellow', 2: 'orange', 3: 'red' };
const CODE_WORDS = { galben: 'yellow', portocaliu: 'orange', rosu: 'red' };

/**
 * Both feeds as parsed JSON, or null with the reason in `errors`. The query string reads past the
 * site's cache, whose copy lacks the header that lets another site read it.
 */
export async function fetchAnmFeeds({ fetchImpl = globalThis.fetch, now = Date.now(), timeout = 15000 } = {}) {
  const read = async url => {
    const response = await fetchImpl(`${url}?_=${now}`, { cache: 'no-store', signal: AbortSignal.timeout?.(timeout) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    // Another answer, such as an error object, a bare value or { avertizare: null }, is a failure, not an empty feed.
    const empty = value => typeof value === 'string' && /^nu exist/i.test(value.trim());
    const warnings = data?.avertizare;
    if (!empty(data) && !(data && typeof data === 'object' && !Array.isArray(data) && (empty(warnings) || (warnings && typeof warnings === 'object')))) throw new Error('răspuns neașteptat');
    return data;
  };
  const names = Object.keys(ANM_FEEDS);
  const settled = await Promise.allSettled(names.map(name => read(ANM_FEEDS[name])));
  const feeds = { errors: {} };
  settled.forEach((result, i) => {
    feeds[names[i]] = result.status === 'fulfilled' ? result.value : null;
    if (result.status === 'rejected') feeds.errors[names[i]] = String(result.reason?.message || result.reason);
  });
  return feeds;
}

const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—', hellip: '…', deg: '°',
  bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', laquo: '«', raquo: '»',
  acirc: 'â', Acirc: 'Â', icirc: 'î', Icirc: 'Î', abreve: 'ă', Abreve: 'Ă', scedil: 'ş', Scedil: 'Ş', tcedil: 'ţ', Tcedil: 'Ţ',
};
const entity = (match, name) => {
  if (name[0] !== '#') return ENTITIES[name] ?? match;
  const point = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
  return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
};

/** Text of an ANM HTML fragment: line breaks and paragraphs as new lines, entities decoded. */
export function htmlText(value) {
  return String(value ?? '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n').replace(/<\/\s*(?:p|div|li|h\d|tr)\s*>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, entity)
    .replace(/[ \t ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The feed's warnings: one object, a list, or the string "Nu exista date". */
const asList = value => (Array.isArray(value) ? value : [value]).filter(item => item && typeof item === 'object');
const attributes = item => item?.['@attributes'] ?? item ?? {};
const itemsOf = data => asList(data?.avertizare).map(item => ({ attrs: attributes(item), item }));

/** A Romanian wall time as instants: none in the spring gap, two in the hour autumn repeats. */
function wallInstants(year, month, day, hour, minute) {
  const wall = `${year}-${month}-${day}T${String(hour).padStart(2, '0')}:${minute}`;
  let first;
  try { first = isoTime(wall); } catch { return []; }
  const second = new Date(Date.parse(first) + 3600000).toISOString();
  return localTime(second) === wall ? [first, second] : [first];
}

/**
 * Every reading of an ANM time, earliest first. The feed pads hours 1–9 on the right, "T50:00" for
 * 05:00, so "T10" and "T20" may be 01:00 or 10:00, 02:00 or 20:00; the hour autumn repeats has two.
 */
export function anmTimes(value) {
  const m = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
  if (!m) return [];
  const [, year, month, day, hour, minute] = m;
  const padded = hour.length === 2 && hour[1] === '0' && hour[0] !== '0';
  const hours = padded ? (+hour >= 30 ? [+hour[0]] : [+hour[0], +hour]) : +hour <= 23 ? [+hour] : [];
  return hours.flatMap(h => wallInstants(year, month, day, h, minute)).sort((a, b) => Date.parse(a) - Date.parse(b));
}

/** When the warning was written, "2024-12-08 04:44:01" in Romania: a field the padding spares. */
const issuedAt = value => {
  const m = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  return m ? wallInstants(m[1], m[2], m[3], m[4], m[5])[0] || '' : '';
};

/** The start nearest the time of issue, then the first end after the start. */
function anmInterval(from, to, issued) {
  const starts = anmTimes(from), ends = anmTimes(to);
  const ref = Date.parse(issued);
  const gap = time => Math.abs(Date.parse(time) - ref);
  const validFrom = !starts.length ? '' : Number.isFinite(ref) ? starts.reduce((best, time) => gap(time) < gap(best) ? time : best) : starts.at(-1);
  // Without a start (one in the hour spring skips), the end still comes after the time of issue.
  const floor = Date.parse(validFrom || issued);
  const after = ends.filter(time => !Number.isFinite(floor) || Date.parse(time) > floor);
  const validTo = after[0] || '';
  const note = validFrom && validTo ? '' : ends.length && validFrom ? 'reversed' : validFrom || validTo ? 'partial' : 'none';
  return { validFrom, validTo, note };
}

const limited = text => text.length > TEXT_LIMIT ? { text: text.slice(0, TEXT_LIMIT), textCut: true } : { text, textCut: false };

/** FNV-1a: a short stable fingerprint of what a warning says, so a second import tells it apart. */
function fingerprint(parts) {
  let hash = 0x811c9dc5;
  for (const char of parts.map(part => String(part ?? '')).join('\u0001')) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}
const digits = value => String(value ?? '').replace(/\D+/g, '').slice(0, 14);

/**
 * Nowcasting warnings whose zone names the county. `key` stays the same while ANM updates a warning,
 * `id` changes with what it says.
 */
export function readNowcasting(data, { uats = [], localities = [] } = {}) {
  return itemsOf(data).flatMap(({ attrs: a }) => {
    const code = CODE_WORDS[foldText(a.numeCuloare).folded.trim()] || MESSAGE_CODES[a.culoare];
    const zoneText = htmlText(a.zona);
    if (!code || !/\bbotosani\b/.test(foldText(zoneText).folded)) return [];
    const zone = readZone(zoneText, { uats, localities, source: 'ANM' });
    const found = zone.areas.length || zone.places.length;
    // A zone written in a way the reader does not know stays in the text, for the operator to pick.
    const message = htmlText(a.semnalare);
    const key = `anm-nc-${digits(a.creat)}-${code}`;
    const { validFrom, validTo, note } = anmInterval(a.dataInceput, a.dataSfarsit, issuedAt(a.creat));
    return [{
      key, id: `${key}-${fingerprint([a.dataInceput, a.dataSfarsit, a.zona, a.semnalare])}`,
      code, source: 'ANM nowcasting', validFrom, validTo, interval: note,
      ...limited(found ? message : [message, `Zona (ANM): ${zoneText}`].filter(Boolean).join('\n')),
      areas: zone.areas, places: zone.places, county: zone.county, unmatched: zone.unmatched, ambiguous: zone.ambiguous,
    }];
  });
}

const conformText = value => /\bconform\b/.test(foldText(value).folded);

/**
 * General warnings that colour the county, and its zones ("BT_…") a code more severe than the
 * county's: the whole county takes every UAT, a zone none, since the feed draws it as a shape and
 * names no UAT.
 */
export function readGeneral(data, { uats = [], now = new Date() } = {}) {
  return itemsOf(data).flatMap(({ attrs: a, item }) => {
    const county = asList(item.judet).map(attributes).find(j => String(j.cod).toUpperCase() === COUNTY);
    const level = +(AREA_CODES[county?.culoare] ? county.culoare : 0);
    const zones = asList(item.zona).map(attributes).filter(z => String(z.cod).toUpperCase().startsWith(`${COUNTY}_`) && AREA_CODES[z.culoare] && +z.culoare > level);
    const parts = [
      ...(level ? [{ code: AREA_CODES[level], zoneOnly: [] }] : []),
      ...[...new Set(zones.map(z => +z.culoare))].map(value => ({ code: AREA_CODES[value], zoneOnly: zones.filter(z => +z.culoare === value).map(z => z.cod) })),
    ];
    if (!parts.length) return [];
    // The message holds one section per code, each with its own interval and phenomena. Its dates
    // name no year, so the day it appeared tells which one.
    // "T10" / "T20" read 10:00 / 20:00 here: ANM issues its general warnings by day, not at 01:00 or 02:00.
    const appeared = anmTimes(a.dataAparitiei).at(-1);
    const issued = appeared ? new Date(appeared) : now;
    const sections = parseWarningText(htmlText(a.mesaj), { now: issued, all: true });
    const listed = conformText(a.intervalul) ? null : readValidity(a.intervalul, { now: issued });
    // The feed's own dates are when the message appeared and when it expires: only the end is validity.
    const expires = anmTimes(a.dataExpirarii).filter(time => !appeared || Date.parse(time) > Date.parse(appeared))[0] || '';
    return parts.map(({ code, zoneOnly }) => {
      const ofCode = sections.filter(result => result.code === code);
      const section = ofCode.find(result => result.county) || ofCode[0];
      // The section's own interval, else the message's, else only the end.
      const { validFrom, validTo, note } = section?.interval === '' ? { validFrom: section.validFrom, validTo: section.validTo, note: '' }
        : listed?.note === '' ? listed : { validFrom: '', validTo: expires, note: expires ? 'partial' : 'none' };
      const listedPhenomena = a.fenomeneVizate && !conformText(a.fenomeneVizate) ? htmlText(a.fenomeneVizate).replace(/[;.\s]+$/, '') : null;
      const phenomena = listedPhenomena === null ? { text: section?.text || '', textCut: Boolean(section?.textCut) } : limited(listedPhenomena);
      // Several messages may share a time of issue and a code, so what they say tells them apart.
      const id = `anm-gen-${digits(a.dataAparitiei)}-${code}-${fingerprint([a.tipMesaj, a.dataExpirarii, a.intervalul, county?.culoare, zoneOnly.join(), a.fenomeneVizate, a.mesaj])}`;
      return {
        key: id, id, code, source: 'ANM', validFrom, validTo, interval: note,
        ...phenomena, areas: zoneOnly.length ? [] : [...uats], places: [], county: !zoneOnly.length,
        unmatched: [], ambiguous: [], zoneOnly,
      };
    });
  });
}

/** The county's warnings in both feeds, nowcasting first; an item the feed repeats counts once. */
export function anmWarnings(feeds = {}, options = {}) {
  const seen = new Set();
  return [...readNowcasting(feeds.nowcasting, options), ...readGeneral(feeds.general, options)]
    .filter(warning => !seen.has(warning.id) && seen.add(warning.id));
}
