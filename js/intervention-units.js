// Physical response origins stay disabled until an official record supplies coordinates.
const definitions = [
  ['garda-botosani', 'Garda Botoșani', 'Detașamentul Botoșani', 'botosani', 'guard', ['detasament']],
  ['garda-trusesti', 'Garda Trușești', 'Detașamentul Botoșani', 'trusesti', 'guard', []],
  ['garda-stefanesti', 'Garda Ștefănești', 'Detașamentul Botoșani', 'stefanesti', 'guard', []],
  ['punct-flamanzi', 'Punctul de lucru Flămânzi', 'Detașamentul Botoșani', 'flamanzi', 'point', []],
  ['garda-dorohoi', 'Garda Dorohoi', 'Detașamentul Dorohoi', 'dorohoi', 'guard', ['detasament']],
  ['punct-darabani', 'Punctul de lucru Darabani', 'Detașamentul Dorohoi', 'darabani', 'point', []],
  ['garda-saveni', 'Garda Săveni', 'Stația Săveni', 'saveni', 'guard', ['sectie', 'statie']],
  ['punct-cotusca', 'Punctul de lucru Coțușca', 'Stația Săveni', 'cotusca', 'point', []],
];

export const INTERVENTION_UNIT_ROSTER = Object.freeze(definitions.map(([id, name, parentLabel]) => Object.freeze({
  id, name, parentLabel, coordinate: null, confirmed: false, reason: 'coordinates-pending',
})));
export const roster = INTERVENTION_UNIT_ROSTER;

const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const forbiddenType = new Set(['inspectorat', 'svsu', 'spsu', 'vecin']);
const forbiddenName = /\b(inspectorat(?:ul)?|svsu|spsu|voluntari|voluntar|privat)\b/;

function eligible(record) {
  if (!record || typeof record !== 'object') return false;
  if (forbiddenType.has(normalize(record.type)) || forbiddenName.test(normalize(record.name))) return false;
  if (record.confirmed === false || record.official === false || /^osm-/i.test(String(record.id ?? ''))) return false;
  if (/\b(osm|openstreetmap)\b/.test(normalize(record.source))) return false;
  if (/\b(openstreetmap|osm)\b/.test(normalize(record.notes)) && /\bde verificat\b/.test(normalize(record.notes))) return false;
  return true;
}

function roleNames(locality, role, extraTypes) {
  const aliases = new Set([locality]);
  const types = new Set(role === 'point' ? ['punct', 'punct de lucru', 'pl'] : ['garda']);
  const prefixes = role === 'point'
    ? ['punct', 'punct de lucru', 'punctul de lucru', 'pl']
    : ['garda', 'garda de interventie', 'garda de pompieri'];
  if (extraTypes.includes('detasament')) {
    types.add('detasament');
    prefixes.push('detasament', 'detasamentul', 'detasament de pompieri', 'detasamentul de pompieri');
  }
  if (extraTypes.includes('sectie') || extraTypes.includes('statie')) {
    types.add('sectie'); types.add('statie');
    prefixes.push('sectie', 'sectia', 'sectia de pompieri', 'statie', 'statia', 'statia de pompieri');
  }
  for (const prefix of prefixes) aliases.add(prefix + ' ' + locality);
  return { aliases, types };
}

const matchingRules = definitions.map(([, , , locality, role, extraTypes]) => roleNames(locality, role, extraTypes));

function number(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function coordinate(record) {
  const lon = number(record.lon), lat = number(record.lat);
  // Reject absent values before numeric conversion; null and empty strings are not zero coordinates.
  if (lon === null || lat === null || lon < 25.95 || lon > 27.45 || lat < 47.45 || lat > 48.30) return null;
  return [lon, lat];
}

/** Resolve only the eight known physical origins against a caller-provided official list. */
export function getInterventionUnits(subunits = []) {
  const input = Array.isArray(subunits) ? subunits : Array.isArray(subunits?.subunits) ? subunits.subunits : [];
  const official = input.filter(eligible);
  return INTERVENTION_UNIT_ROSTER.map((unit, index) => {
    const stable = official.filter(record => record.id === unit.id);
    const { aliases, types } = matchingRules[index];
    const candidates = stable.length ? stable : official.filter(record => {
      const type = normalize(record.type), name = normalize(record.name);
      // A bare locality needs an explicit compatible role; a full name must also agree with an explicit type.
      return aliases.has(name) && (type ? types.has(type) : name !== definitions[index][3]);
    });
    if (candidates.length > 1) return { ...unit, reason: 'ambiguous-official-records' };
    if (!candidates.length) return { ...unit };
    const point = coordinate(candidates[0]);
    if (!point) return { ...unit, reason: 'invalid-coordinates' };
    return { ...unit, coordinate: point, confirmed: true, reason: undefined };
  });
}
