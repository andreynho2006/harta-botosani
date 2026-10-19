// Definițiile categoriilor și ale straturilor afișate în aplicație.

export const COUNTY_BOUNDS = [[25.95, 47.45], [27.45, 48.30]];
export const START_VIEW = { center: [26.67, 47.86], zoom: 9 };

// Obiective (puncte) — culoare, etichetă, zoom minim, grup în panoul de straturi
export const POI = {
  pompieri:    { label: "Subunități ISU",          color: "#d0232c", major: true },
  politie:     { label: "Poliție",                 color: "#2357a8", major: true },
  jandarmerie: { label: "Jandarmerie",             color: "#3f5f2c", major: true },
  frontiera:   { label: "Poliția de Frontieră",    color: "#17708a", major: true },
  ambulanta:   { label: "Ambulanță (SAJ)",         color: "#e0601a", major: true },
  spital:      { label: "Spitale",                 color: "#b0174a", major: true },
  medical:     { label: "Dispensare și clinici",   color: "#c25a7c", major: false },
  primarie:    { label: "Primării",                color: "#6a4ca0", major: true },
  scoala:      { label: "Școli",                   color: "#a8700f", major: false },
  gradinita:   { label: "Grădinițe",               color: "#c48c12", major: false },
  carburant:   { label: "Stații carburant",        color: "#59616c", major: false },
  baraj:       { label: "Baraje și stăvilare",     color: "#1c6aa8", major: true },
  hidrant_osm: { label: "Hidranți (OSM)",          color: "#de5562", major: false },
  sursa_apa:   { label: "Surse de apă (OSM)",      color: "#2a8bd0", major: false },
};

export const ROAD = {
  dn:      { label: "Drumuri naționale",     short: "DN" },
  dj:      { label: "Drumuri județene",      short: "DJ" },
  dc:      { label: "Drumuri comunale",      short: "DC" },
  local:   { label: "Drumuri locale",        short: "" },
  street:  { label: "Străzi",                short: "" },
  service: { label: "Drumuri de acces",      short: "" },
  track:   { label: "Drumuri de exploatare", short: "" },
};

export const BUILDING = {
  bloc:       "Blocuri de locuințe",
  public:     "Clădiri publice",
  industrial: "Industriale și depozite",
  cult:       "Lăcașuri de cult",
  comercial:  "Comerciale și birouri",
  casa:       "Locuințe",
  anexa:      "Anexe",
  altele:     "Alte clădiri",
};

// Panoul de straturi: grupuri → elemente. Fiecare element are un id unic de vizibilitate.
// Implicit sunt pornite doar straturile de bază pentru ședințele CJSU (drumuri principale, UAT, localități, ape principale, subunități ISU).
export const LAYER_GROUPS = [
  { id: "interventie", label: "Intervenție", items: [
    { id: "poi:pompieri", on: true }, { id: "poi:ambulanta", on: false }, { id: "poi:spital", on: false },
    { id: "poi:politie", on: false }, { id: "poi:jandarmerie", on: false }, { id: "poi:frontiera", on: false },
    { id: "hidranti", label: "Hidranți ISU", kind: "hydrant", on: false },
    { id: "hidranti_defecti", label: "Hidranți nefuncționali", kind: "hydrant", on: false },
    { id: "poi:sursa_apa", on: false }, { id: "poi:medical", on: false },
  ]},
  { id: "institutii", label: "Instituții și obiective", items: [
    { id: "poi:primarie", on: false }, { id: "poi:scoala", on: false }, { id: "poi:gradinita", on: false },
    { id: "poi:carburant", on: false }, { id: "poi:baraj", on: false },
  ]},
  { id: "drumuri", label: "Căi de comunicație", items: [
    ...Object.keys(ROAD).map((k) => ({ id: "road:" + k, on: k === "dn" || k === "dj" || k === "dc" })),
    { id: "rail", label: "Căi ferate", on: false },
    { id: "roadlabels", label: "Numere și nume de drumuri", on: true },
  ]},
  { id: "ape", label: "Hidrografie", items: [
    { id: "water", label: "Lacuri și acumulări", on: true },
    { id: "rivers", label: "Râuri și canale", on: true },
    { id: "streams", label: "Pâraie și șanțuri", on: false },
    { id: "dams", label: "Baraje (contur)", on: false },
  ]},
  { id: "cladiri", label: "Clădiri", items: Object.keys(BUILDING).map((k) => ({ id: "bld:" + k, on: false })) },
  { id: "teritoriu", label: "Teritoriu", items: [
    { id: "places", label: "Localități (nume)", on: true },
    { id: "uat", label: "Limite UAT", on: true },
    { id: "landuse", label: "Păduri și folosința terenului", on: false },
  ]},
];

export const LAYER_PRESETS = [
  {
    id: "baza",
    label: "Hartă CJSU (Bază)",
    short: "Bază CJSU",
    layers: ["uat", "places", "road:dn", "road:dj", "road:dc", "roadlabels", "water", "rivers", "poi:pompieri"],
  },
  {
    id: "snow",
    label: "Iarnă / Înzăpezire",
    short: "❄️ Înzăpezire",
    layers: ["uat", "places", "road:dn", "road:dj", "road:dc", "road:street", "roadlabels", "rail",
      "poi:pompieri", "poi:ambulanta", "poi:spital", "poi:politie", "poi:jandarmerie", "poi:frontiera"],
  },
  {
    id: "flood",
    label: "Inundații / Hidrologie",
    short: "🌊 Inundații",
    layers: ["uat", "places", "water", "rivers", "streams", "dams", "poi:baraj", "road:dn", "road:dj", "road:dc", "road:street", "roadlabels",
      "bld:casa", "bld:bloc", "bld:public", "poi:pompieri", "poi:ambulanta", "poi:jandarmerie", "poi:primarie", "poi:scoala"],
  },
  {
    id: "fire",
    label: "Incendii · toate căile de comunicație",
    short: "🔥 Incendii",
    layers: ["uat", "places", "hidranti", "hidranti_defecti", "poi:sursa_apa", "poi:pompieri", "poi:ambulanta", "poi:spital",
      "landuse", "water", "rivers", ...Object.keys(ROAD).map(key => `road:${key}`), "rail", "roadlabels",
      "bld:bloc", "bld:public", "bld:industrial", "bld:comercial", "bld:casa"],
  },
  {
    id: "storm",
    label: "Furtună / Vijelie",
    short: "⛈️ Furtună",
    layers: ["uat", "places", "road:dn", "road:dj", "road:dc", "road:street", "roadlabels", "landuse", "water", "rivers",
      "poi:pompieri", "poi:ambulanta", "poi:spital", "poi:politie", "poi:jandarmerie", "bld:bloc", "bld:public"],
  },
  {
    id: "all",
    label: "Toate straturile",
    short: "Toate",
    layers: LAYER_GROUPS.flatMap((g) => g.items.map((it) => it.id)),
  },
];

export const LABELS = {
  road: { dn: "Drum național", dj: "Drum județean", dc: "Drum comunal", local: "Drum local",
          street: "Stradă", service: "Drum de acces / serviciu", track: "Drum de exploatare" },
  building: { bloc: "Bloc de locuințe", casa: "Locuință", industrial: "Clădire industrială / depozit",
              public: "Clădire publică", cult: "Lăcaș de cult", comercial: "Clădire comercială / birouri",
              anexa: "Anexă gospodărească", altele: "Clădire" },
  water: { rau: "Râu", acumulare: "Acumulare", iaz: "Iaz", lac: "Lac", bazin: "Bazin", parau: "Pârâu",
           canal: "Canal", sant: "Șanț / canal de desecare", baraj: "Baraj", stavila: "Stăvilar" },
  landuse: { forest: "Pădure", residential: "Zonă locuită", industrial: "Zonă industrială",
             military: "Zonă militară", cemetery: "Cimitir", wetland: "Zonă umedă", park: "Parc",
             sport: "Teren de sport", orchard: "Livadă / vie", grass: "Pajiște" },
  place: { city: "Municipiu", town: "Oraș", village: "Sat", hamlet: "Cătun", suburb: "Cartier",
           neighbourhood: "Cartier", quarter: "Cartier", isolated_dwelling: "Locuință izolată", locality: "Loc" },
  surface: { asphalt: "asfalt", unpaved: "neasfaltat", gravel: "pietruit", fine_gravel: "pietriș",
             ground: "pământ", dirt: "pământ", compacted: "balast compactat", paved: "pavat",
             concrete: "beton", paving_stones: "pavele", sett: "piatră cubică", grass: "iarbă", sand: "nisip" },
};

export function itemLabel(item) {
  if (item.label) return item.label;
  const [kind, key] = item.id.split(":");
  if (kind === "poi") return POI[key].label;
  if (kind === "road") return ROAD[key].label;
  if (kind === "bld") return BUILDING[key];
  return item.id;
}
