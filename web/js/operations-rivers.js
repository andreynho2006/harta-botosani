// Reads the rivers an INHGA warning names for the county, and the UATs along them, against the water cadastre's course list.
// Pure and DOM-free: the list is the `properties` of the loaded hydrography features, so the parser needs no map data.
// Imports the parser's name folding and the parser imports `readRivers` back: neither module uses the other's exports
// while it loads, only when called, so the cycle is harmless.
import { foldText, nameKey, COUNTIES } from './operations-alert-parse.js';

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

/** A full stop that ends a sentence: after a word, not the stops of "S.H." or "ac.". */
const endsSentence = (text, at) => text[at] === '.' && at >= 3 && /[a-z0-9]{3}$/.test(text.slice(at - 3, at)) && (at + 1 >= text.length || /\s/.test(text[at + 1]));

/** The national title "BAZINELE HIDROGRAFICE VIZATE: …" names basins without their counties; its rivers are skipped. */
function titleRanges(folded) {
  return [...folded.matchAll(/^[ \t]*bazinele[ \t]+hidrografice[ \t]+(?:vizate|afectate)\b/gm)].map(m => {
    const next = folded.indexOf('\n', m.index);
    const lineEnd = next < 0 ? folded.length : next;
    for (let at = m.index + m[0].length; at < lineEnd; at++) if (endsSentence(folded, at)) return [m.index, at + 1];
    return [m.index, lineEnd];
  });
}

/**
 * The county lists, "județele: Botoșani și Iași", as { start, end, counties } on the folded text. A list
 * stops at the first word that is no county ("județul Botoșani și pe râurile"); "Satu Mare" counts by its first word.
 */
const COUNTY_WORD = /([a-z]+)(?:-[a-z]+|[ \t]+mare\b)?/y;
const COUNTY_JOIN = /\s*,\s*(?:si\s+)?|\s+si\s+/y;
function countyLists(folded) {
  const lists = [];
  for (const m of folded.matchAll(/\bjud(?:etul|etele|etelor|\.)\s*:?\s*/g)) {
    const counties = new Set();
    let at = m.index + m[0].length, end = at;
    for (;;) {
      COUNTY_WORD.lastIndex = at;
      const word = COUNTY_WORD.exec(folded);
      if (!word || !COUNTIES.has(word[1])) break;
      counties.add(word[1]);
      end = at = COUNTY_WORD.lastIndex;
      COUNTY_JOIN.lastIndex = at;
      if (!COUNTY_JOIN.exec(folded)) break;
      at = COUNTY_JOIN.lastIndex;
    }
    if (counties.size) lists.push({ start: m.index, end, counties });
  }
  return lists;
}

/** Each name takes the first county list after it, and the last list before it when none follows; none is unknown. */
function assignLists(hits, lists) {
  const events = [...hits.map(hit => ({ at: hit.start, hit })), ...lists.map(list => ({ at: list.start, list }))].sort((a, b) => a.at - b.at);
  let waiting = [], last = null;
  for (const { hit, list } of events) {
    if (hit) { waiting.push(hit); continue; }
    for (const name of waiting) name.list = list;
    waiting = [];
    last = list;
  }
  for (const name of waiting) name.list = last;
}

/** Where an entry ends: a comma, a semicolon, a sentence or a line break outside brackets, or the bracket it sits in. */
function entryEnd(folded, from, limit) {
  let depth = 0;
  for (let at = from; at < limit; at++) {
    const char = folded[at];
    if (char === '(') depth++;
    else if (char === ')') { if (--depth < 0) return at; }
    else if (depth === 0 && (char === ',' || char === ';' || char === '\n' || endsSentence(folded, at))) return at;
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
function readEntry(folded, hit, course, index, lists) {
  const limit = lists.find(list => list.start >= hit.end)?.start ?? folded.length;
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
    // Without a confluence the index knows, the whole of the tributaries stands for the sector.
    Object.assign(river, { scope: 'tributaries', sector: ends.length ? usable.length < ends.length : /\bsector|\baval\b|\bamonte\b/.test(qualifier) });
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

// "pe unele râuri mici din județele: Prahova, Suceava și Botoșani" names counties, not rivers.
const SMALL_RIVERS = /rauri(?:le)?\s+mici\s+din\s+judet\w*\s*:?\s*[^.]*\bbotosani\b/;

/**
 * The rivers a section names for Botoșani, as { rivers, areas, ambiguous, smallRivers, concerns }.
 * `rivers` are { name, scope: 'basin' | 'river' | 'tributaries', sector, uats, after?, before? } with `uats` in the order of
 * the `uats` option; `sector` marks a sector the text gives that the whole river or tributaries stand in for.
 * `ambiguous` names rivers whose name belongs to unrelated courses. Rivers named only as landmarks, in the national
 * title or for other counties are left out.
 */
export function readRivers(sectionText, properties, { uats = [] } = {}) {
  const { folded } = foldText(sectionText);
  const index = riverIndex(properties);
  const smallRivers = SMALL_RIVERS.test(folded);
  const kept = [], clashing = [];
  if (index.scan) {
    const titles = titleRanges(folded);
    const lists = countyLists(folded);
    const hits = [...folded.matchAll(index.scan)]
      .map(m => ({ start: m.index, end: m.index + m[0].length, key: nameKey(m[0]) }))
      .filter(hit => !titles.some(([from, to]) => hit.start >= from && hit.start < to) && !isLandmark(folded, hit.start));
    assignLists(hits, lists);
    const mentioned = /\bbotosani\b/.test(folded);
    for (const hit of hits) {
      if (!(hit.list ? hit.list.counties.has('botosani') : mentioned)) continue;
      const course = index.names.get(hit.key);
      if (course) kept.push(readEntry(folded, hit, course, index, lists));
      else clashing.push(index.clashes.get(hit.key));
    }
  }
  // The same river and scope named twice is one.
  const rivers = [];
  for (const { river, domain } of kept) {
    const found = new Set(domain.flatMap(course => course.uats.map(nameKey)));
    const mine = { ...river, uats: uats.filter(name => found.has(nameKey(name))) };
    const same = rivers.find(other => ['name', 'scope', 'after', 'before'].every(field => other[field] === mine[field]));
    if (same) same.sector ||= mine.sector; else rivers.push(mine);
  }
  const areas = uats.filter(name => rivers.some(river => river.uats.includes(name)));
  return { rivers, areas, ambiguous: [...new Set(clashing)], smallRivers, concerns: rivers.length > 0 || smallRivers };
}
