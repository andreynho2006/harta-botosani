// Reads the rivers an INHGA warning names for the county, and the UATs along them, against the water cadastre's course list.
// Pure and DOM-free: the list is the `properties` of the loaded hydrography features, so the parser needs no map data.
// Imports the parser's name folding and the parser imports `readRivers` back: neither module uses the other's exports
// while it loads, only when called, so the cycle is harmless.
import { foldText, nameKey, COUNTIES, CODE_HEADING } from './operations-alert-parse.js?v=20261026-hydro';

// A course's code is its outlet's plus one segment, numbered from upstream to downstream: Jijia "RO_XIII_1.15",
// its tributary Sitna "RO_XIII_1.15.18". A segment may carry a letter, "14a", which sorts between 14 and 15.
const below = (course, ancestor) => course.code.startsWith(`${ancestor.code}.`);
const childOf = (course, parent) => below(course, parent) && !course.code.slice(parent.code.length + 1).includes('.');
const segmentOf = course => course.code.slice(course.code.lastIndexOf('.') + 1);
/** The first segment below `ancestor` on the way to `course`: the tributary of the ancestor it hangs from. */
const branchOf = (course, ancestor) => course.code.slice(ancestor.code.length + 1).split('.')[0];
const rank = segment => {
  const m = /^(\d+)([a-z]*)$/i.exec(segment);
  return m ? [+m[1], m[2].toLowerCase()] : [Infinity, segment];
};
const compareRank = (a, b) => (a[0] === b[0] ? 0 : a[0] < b[0] ? -1 : 1) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);

const indexes = new WeakMap();

function buildIndex(properties) {
  const courses = [], groups = new Map();
  for (const item of properties) {
    if (!item?.name || !item.code) continue;
    const course = { name: item.name, alt: Array.isArray(item.alt) ? item.alt : [], code: String(item.code), parent: item.parent ?? '', order: item.order, uats: Array.isArray(item.uats) ? item.uats : [] };
    courses.push(course);
    // "SITNA (SIHNA)" is also found as plain "SITNA".
    const aba = String(item.aba ?? '').replace(/\([^)]*\)/g, ' ');
    for (const key of new Set([course.name, ...course.alt, aba].map(nameKey).filter(Boolean))) groups.set(key, [...(groups.get(key) || []), course]);
  }
  // A name shared by unrelated courses is not chosen for the operator; one that is the outlet of the others stands for them.
  const names = new Map(), clashes = new Map();
  for (const [key, group] of groups) {
    const outlet = group.length === 1 ? group[0] : group.find(course => group.every(other => other === course || below(other, course)));
    if (outlet) names.set(key, outlet); else clashes.set(key, group[0].name);
  }
  // Longer names first, so "Valea Mare" is not read as "Valea".
  const keys = [...names.keys(), ...clashes.keys()].sort((a, b) => b.length - a.length);
  const words = keys.map(key => key.split(' ').join('[\\s-]+')).join('|');
  // "Rădăuți-Prut" is not the Prut.
  const pattern = flags => keys.length ? new RegExp(`(?<![a-z0-9-])(?:${words})(?![a-z0-9-])`, flags) : null;
  return { courses, names, clashes, scan: pattern('g'), at: pattern('y') };
}

/** The courses of a hydrography's `properties`, keyed by name for matching, built once per list. */
export function riverIndex(properties) {
  const list = Array.isArray(properties) ? properties : [];
  if (!indexes.has(list)) indexes.set(list, buildIndex(list));
  return indexes.get(list);
}

/** The course or clashing name written at an offset of the folded text, else null. */
function riverAt(index, folded, offset) {
  if (!index.at) return null;
  index.at.lastIndex = offset;
  const m = index.at.exec(folded);
  return m ? index.names.get(nameKey(m[0])) ?? null : null;
}

// A river named only to place a sector, a station or a reservoir, not warned itself.
const LANDMARKS = [/confluent\w*\s+cu\s+(?:raul\s+)?$/, /afluent(?:ul)?\s+al\s+(?:raului\s+)?$/, /(?<![a-z])s\.?\s*h\.?\s*$/,
  /statiei\s+hidrometrice\s+$/, /statia\s+hidrometrica\s+$/, /acumularea\s+$/, /acumulare\s+$/, /(?<![a-z])ac\.\s*$/, /lacul\s+$/, /barajul\s+$/];
const isLandmark = (folded, at) => { const before = folded.slice(Math.max(0, at - 60), at); return LANDMARKS.some(re => re.test(before)); };

/** A full stop that ends a sentence: after a word or a closing bracket, not the stops of "S.H." or "ac.". */
const endsSentence = (text, at) => text[at] === '.' && /(?:[a-z0-9]{3}|\))$/.test(text.slice(Math.max(0, at - 3), at)) && (at + 1 >= text.length || /\s/.test(text[at + 1]));

/**
 * The national title "BAZINELE HIDROGRAFICE VIZATE: …" and the addressees "Către: … Administrațiile Bazinale de Apă: Siret și
 * Prut-Bârlad" name basins without their counties. Their rivers are skipped, to the end of the sentence (its list may
 * wrap onto the next lines), or to the first code or "momentul producerii" heading, or 500 characters.
 */
function skippedRanges(folded) {
  // The title may share its line with the text pasted before it, or lose its colon; the addressees open their own line.
  return [...folded.matchAll(/\bbazinele\s+hidrografice\s+(?:vizate|afectate)\b\s*:?|^[ \t]*catre[ \t]*:/gm)].map(m => {
    const from = m.index + m[0].length;
    const heading = folded.slice(from, m.index + 500).search(new RegExp(`${CODE_HEADING.source}|\\bmomentul\\s+producerii\\b`));
    const limit = heading < 0 ? Math.min(folded.length, m.index + 500) : from + heading;
    for (let at = from; at < limit; at++) if (endsSentence(folded, at)) return [m.index, at + 1];
    return [m.index, limit];
  });
}

/**
 * The county lists, "județele: Botoșani și Iași", as { start, end, counties } on the folded text. A list
 * stops at the first word that is no county ("județul Botoșani și pe râurile"); a county of two words, "Satu Mare" or
 * "Bistrița Năsăud", is taken whole, across a hyphen or a line break, and counts by its first word.
 */
const COUNTY_WORD = /(satu[\s-]+mare|bistrita[\s-]+nasaud|caras[\s-]+severin|[a-z]+)(?:-[a-z]+)?/y;
const COUNTY_JOIN = /\s*,\s*(?:si\s+)?|\s+si\s+/y;
function countyLists(folded) {
  const lists = [];
  for (const m of folded.matchAll(/\bjud(?:etul|etele|etelor|\.)\s*:?\s*/g)) {
    const counties = new Set();
    let at = m.index + m[0].length, end = at;
    for (;;) {
      COUNTY_WORD.lastIndex = at;
      const word = COUNTY_WORD.exec(folded);
      const county = word?.[1].split(/[\s-]+/)[0];
      if (!county || !COUNTIES.has(county)) break;
      counties.add(county);
      end = at = COUNTY_WORD.lastIndex;
      COUNTY_JOIN.lastIndex = at;
      if (!COUNTY_JOIN.exec(folded)) break;
      at = COUNTY_JOIN.lastIndex;
    }
    if (counties.size) lists.push({ start: m.index, end, counties });
  }
  return lists;
}

/**
 * Each name takes the first county list after it. When none follows, it takes the last list before it in the same
 * sentence ("Prut (județele: Botoșani și Iași), Jijia"); a name after the sentence of the last list has none.
 */
function assignLists(folded, hits, lists) {
  const events = [...hits.map(hit => ({ at: hit.start, hit })), ...lists.map(list => ({ at: list.start, list }))].sort((a, b) => a.at - b.at);
  let waiting = [], last = null;
  for (const { hit, list } of events) {
    if (hit) { waiting.push(hit); continue; }
    for (const name of waiting) name.list = list;
    waiting = [];
    last = list;
  }
  const sentenceEnds = (from, to) => { for (let at = from; at < to; at++) if (endsSentence(folded, at)) return true; return false; };
  for (const name of waiting) if (last && !sentenceEnds(last.end, name.start)) name.list = last;
}

// An entry is a line or two; a text pasted from a PDF wraps lines inside it, so a line break does not end it.
const ENTRY_LIMIT = 300;

/** Where an entry ends: a comma, a semicolon or a sentence outside brackets, or the bracket it sits in. */
function entryEnd(folded, from, limit) {
  let depth = 0;
  for (let at = from; at < limit; at++) {
    const char = folded[at];
    if (char === '(') depth++;
    else if (char === ')') { if (--depth < 0) return at; }
    else if (depth === 0 && (char === ',' || char === ';' || endsSentence(folded, at))) return at;
  }
  return limit;
}

/** What the list of rivers was opened with, "pe râurile din bazinele hidrografice:" or "pe râurile:"; null without one. */
function opening(folded, at) {
  let from = -1;
  for (const m of folded.slice(0, at).matchAll(/\brauril\w*|\bbazin\w*\s+hidrografic\w*/g)) from = m.index;
  if (from < 0) return null;
  const colon = folded.indexOf(':', from);
  return folded.slice(from, colon >= 0 && colon < at ? colon : at);
}

// "aval confluență cu râul Jijia": the tributaries below (aval) or above (amonte) that confluence.
const SECTOR_END = /\b(aval|amonte)\s+confluent\w*\s+cu\s+(?:raul\s+)?/g;

/** What one entry covers: its scope, the courses in it and whether the text's sector was only approximated. */
function readEntry(folded, hit, next, course, index, lists) {
  // The entry stops where its county list or the next river begins.
  const limit = Math.min(lists.find(list => list.start >= hit.end)?.start ?? Infinity, next?.start ?? Infinity, hit.end + ENTRY_LIMIT, folded.length);
  const entry = folded.slice(hit.end, entryEnd(folded, hit.end, limit));
  // "Miletin (afluent al râului Jijia)" says what Miletin is, not that its tributaries are warned.
  const qualifier = entry.replace(/\bafluent(?:ul)?\s+al\s+(?:raului\s+)?[a-z0-9]+/g, ' ');
  const descendants = index.courses.filter(other => below(other, course));
  const river = { name: course.name };
  let domain;
  if (/bazin/.test(qualifier)) {
    Object.assign(river, { scope: 'basin', sector: false });
    domain = [course, ...descendants];
  } else if (/afluent/.test(qualifier)) {
    const ends = [...entry.matchAll(SECTOR_END)].map(m => ({ side: m[1], limit: riverAt(index, folded, hit.end + m.index + m[0].length) }));
    const usable = ends.filter(end => end.limit && childOf(end.limit, course));
    domain = descendants;
    for (const { side, limit: mark } of usable) {
      const cut = rank(segmentOf(mark));
      domain = domain.filter(other => (side === 'aval' ? 1 : -1) * compareRank(rank(branchOf(other, course)), cut) > 0);
      river[side === 'aval' ? 'after' : 'before'] = mark.name;
    }
    // What the text delimits and the index could not cut (a station, a bank, a confluence it lacks) is approximated
    // by the whole of the tributaries.
    const limits = (qualifier.match(/\b(?:aval|amonte)\b/g) || []).length + (/\b(?:dreapta|stanga)\b/.test(qualifier) ? 1 : 0);
    Object.assign(river, { scope: 'tributaries', sector: (limits || (/\bsector/.test(qualifier) ? 1 : 0)) > usable.length });
  } else {
    const sector = /\bsector/.test(qualifier);
    const named = /raul\s+$/.test(folded.slice(Math.max(0, hit.start - 12), hit.start));
    const open = sector || named ? null : opening(folded, hit.start);
    if (sector || named || (open !== null && !open.includes('bazin'))) {
      Object.assign(river, { scope: 'river', sector });
      domain = [course];
    } else {
      Object.assign(river, { scope: 'basin', sector: false });
      domain = [course, ...descendants];
    }
  }
  return { course, river, domain };
}

/**
 * The cadastre's name, or the warning's spelling of it when only that one has diacritics: many cadastre names
 * came without them ("Volovat"), while the warning writes "Volovăț".
 */
function shownName(text, origin, hit, course) {
  if (/[^\x00-\x7f]/.test(course.name)) return course.name;
  const written = text.slice(origin[hit.start], origin[hit.end - 1] + 1).replace(/[\s-]+/g, ' ')
    .replace(/ş/g, 'ș').replace(/Ş/g, 'Ș').replace(/ţ/g, 'ț').replace(/Ţ/g, 'Ț');
  const marked = /[^\x00-\x7f]/.test(written) && written !== written.toUpperCase();
  return marked && nameKey(written) === nameKey(course.name) ? written : course.name;
}

// "pe unele râuri mici din județele: Prahova, Suceava și Botoșani" names counties, not rivers.
const SMALL_RIVERS = /rauri(?:le)?\s+mici\s+din\s+judet\w*\s*:?\s*[^.]*\bbotosani\b/;

/**
 * The rivers a section names for Botoșani, as { rivers, areas, ambiguous, smallRivers, concerns }.
 * `rivers` are { name, scope: 'basin' | 'river' | 'tributaries', sector, uats, after?, before? } with `uats` in the order of
 * the `uats` option; `sector` marks a sector the text gives that the whole river or tributaries stand in for.
 * `ambiguous` names rivers whose name belongs to unrelated courses. Rivers named only as landmarks, in the national
 * title or the addressees, or for other counties are left out.
 */
export function readRivers(sectionText, properties, { uats = [] } = {}) {
  const { folded, origin } = foldText(sectionText);
  const index = riverIndex(properties);
  const smallRivers = SMALL_RIVERS.test(folded);
  const kept = [], clashing = [];
  if (index.scan) {
    const lists = countyLists(folded);
    // A name inside a county list is the county ("Suceava", the "Bistrița" of "Bistrița Năsăud"), not the river.
    const skipped = [...skippedRanges(folded), ...lists.map(list => [list.start, list.end])];
    const hits = [...folded.matchAll(index.scan)]
      .map(m => ({ start: m.index, end: m.index + m[0].length, key: nameKey(m[0]) }))
      .filter(hit => !skipped.some(([from, to]) => hit.start >= from && hit.start < to) && !isLandmark(folded, hit.start));
    assignLists(folded, hits, lists);
    // Without any county list, the rivers are the county's when the text names Botoșani; with lists, a name
    // outside them belongs to a part of the message about some other place.
    const mentioned = !lists.length && /\bbotosani\b/.test(folded);
    hits.forEach((hit, i) => {
      if (!(hit.list ? hit.list.counties.has('botosani') : mentioned)) return;
      const course = index.names.get(hit.key);
      if (course) kept.push({ ...readEntry(folded, hit, hits[i + 1], course, index, lists), hit });
      else clashing.push(index.clashes.get(hit.key));
    });
  }
  // The same course and scope named twice is one, however each time spelled it.
  const rivers = [], seen = new Map();
  for (const { course, river, domain, hit } of kept) {
    const found = new Set(domain.flatMap(other => other.uats.map(nameKey)));
    const mine = { ...river, name: shownName(sectionText, origin, hit, course), uats: uats.filter(name => found.has(nameKey(name))) };
    const key = [course.code, mine.scope, mine.after, mine.before].join('|');
    if (seen.has(key)) seen.get(key).sector ||= mine.sector;
    else { seen.set(key, mine); rivers.push(mine); }
  }
  const areas = uats.filter(name => rivers.some(river => river.uats.includes(name)));
  return { rivers, areas, ambiguous: [...new Set(clashing)], smallRivers, concerns: rivers.length > 0 || smallRivers };
}
