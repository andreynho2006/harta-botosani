// Shared presentation scope: the map, counts and lists use the same event risks.
const COMMON = ['blocked', 'damaged', 'stranded', 'houses', 'persons', 'isolated', 'power', 'evacuated'];
const HAZARDS = { fire: ['fire'], flood: ['flooded', 'threat'], snow: ['snow'], storm: ['flooded', 'threat'], other: ['fire', 'flooded', 'threat', 'snow'] };
const SUPPORT = ['command', 'isu', 'police', 'medical', 'utility', 'shelter', 'route_primary', 'route_backup'];
export function presentationFeatures(features, type, hideResolved = false) {
  const allowed = new Set([...COMMON, ...(HAZARDS[type] || HAZARDS.other), ...SUPPORT]);
  return features.filter(f => allowed.has(f.properties?.kind) && (!hideResolved || f.properties.status !== 'resolved'));
}
export function presentationRiskGroups(type) {
  const hazards = HAZARDS[type] || HAZARDS.other;
  const names = {fire:'Incendii',flood:'Inundații și fenomene hidro',snow:'Înzăpezire și viscol',storm:'Furtună și efecte asociate',other:'Tipuri de risc'};
  return [
    {id:'hazards', label:names[type] || names.other, kinds:hazards},
    {id:'roads', label:'Căi de comunicație', kinds:['blocked','damaged','stranded']},
    {id:'people', label:'Populație și localități', kinds:['houses','persons','isolated','evacuated']},
    {id:'utilities', label:'Utilități', kinds:['power']},
  ];
}
export function presentationKindLabel(kind, type, fallback) {
  if (type !== 'snow') return {stranded:'Autovehicule blocate / trafic',houses:'Gospodării afectate'}[kind] || fallback;
  return fallback;
}
