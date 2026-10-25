import { normalizeAlerts, affectedAlertLocations, resolvePlace, placeKey, placeLabel, legacyNote, countLabel, ALERT_LABELS, ALERT_RANK } from "./operations-alerts.js?v=20261019-multi-alerts";
import { buildAlertGeography, buildAlertLabels, alertOutlined, attachAlertPopups } from "./operations-alert-map.js?v=20261019-multi-alerts";
import { createAlertEditor } from "./operations-alert-editor.js?v=20261025-alert-entry";
import { presentationFeatures, presentationRiskGroups, presentationKindLabel } from "./operations-risks.js?v=20261018-cards";
import { EventStore, CloudStates, createEvent, sanitizeEvent, cleanupLegacyArchive } from "./event-store.js?v=20261025-cloud-state";
import {
  snapToRoad, buildRoadSegment, findRoadRoute, findRoadByRef, sliceRoadByKm, sliceRoadByPlaces,
  projectPointOnRoad, roadNetworkToFeatures, roadsListOf, lineLengthKm,
} from "./road-sketch.js";
import { outsideMask, geometryBounds } from "./commune-geometry.js";
import { circle } from "./geo.js";
import { LAYER_GROUPS, LAYER_PRESETS } from "./config.js?v=20261018-itineraries-v2";
import { localTime, isoTime, dateLabel } from "./operations-time.js";
import { createOperationsCards } from "./operations-cards.js?v=20261018-cards";
import { createInterventionPlanner } from "./intervention-planner.js?v=20261019-unirii-access";

const FC = (features = []) => ({ type: "FeatureCollection", features });
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const TYPES = {
  snow: "Înzăpezire / Viscol",
  flood: "Inundații / Fenomene hidro",
  fire: "Incendiu de amploare / Pădure",
  storm: "Furtună / Vijelie",
  other: "Alt eveniment operativ",
};

export const KINDS = {
  blocked: "Drum impracticabil / blocat",
  snow: "Drum / zonă înzăpezită",
  stranded: "Mașini blocate în zăpadă / trafic",
  houses: "Case înzăpezite / gospodării afectate",
  persons: "Persoane blocate / cazuri medicale critice",
  isolated: "Localitate izolată (fără acces)",
  power: "Localitate fără energie electrică",
  flooded: "Sector / zonă inundată",
  threat: "Zonă posibil inundabilă / amenințată",
  damaged: "Drum deteriorat / restricționat",
  fire: "Perimetru incendiu",
  evacuated: "Zonă / localitate evacuată",
  command: "Punct de Comandă Mobil (PCM)",
  isu: "Forțe / Tehnică ISU",
  police: "Filtru Rutier IPJ / IJJ",
  medical: "Echipaj SAJ / SMURD / PMA",
  utility: "Utilaj SDN / DJDP / SGA / Delgaz",
  shelter: "Punct sprijin / adăpostire sinistrați",
  route_primary: "Itinerar de bază",
  route_backup: "Itinerar de rezervă",
};

const isItinerary = feature => ["route_primary", "route_backup"].includes(feature?.properties?.kind);

const ROAD_KINDS = ["blocked", "snow", "flooded", "damaged"];
const ZONE_KINDS = ["threat", "flooded", "snow", "fire", "evacuated"];
const PLACE_KINDS = ["isolated", "power", "houses", "persons", "flooded", "snow", "evacuated"];
const FORCE_KINDS = ["command", "isu", "police", "medical", "utility", "shelter"];

const MONITORED_CATEGORIES = [
  { kind: "blocked", label: "Drumuri impracticabile / blocate" },
  { kind: "snow", label: "Drumuri / zone înzăpezite" },
  { kind: "stranded", label: "Mașini blocate în zăpadă / trafic" },
  { kind: "houses", label: "Case înzăpezite / gospodării afectate" },
  { kind: "persons", label: "Persoane blocate / cazuri critice" },
  { kind: "isolated", label: "Localități izolate (fără acces)" },
  { kind: "power", label: "Localități fără energie electrică" },
  { kind: "flooded", label: "Sectoare / zone inundate" },
  { kind: "threat", label: "Zone posibil inundabile / amenințate" },
  { kind: "damaged", label: "Drumuri deteriorate / restricționate" },
  { kind: "fire", label: "Perimetre incendiu de amploare" },
  { kind: "evacuated", label: "Zone / localități evacuate" },
];

const DEFAULT_AGENCY = {
  command: "ISU / CJSU Botoșani",
  isu: "ISU Botoșani",
  police: "IPJ / IJJ Botoșani",
  medical: "SAJ / SMURD Botoșani",
  utility: "SDN / DJDP / SGA Botoșani",
  shelter: "CLSU / Primărie",
};

export const AFFECTED_META = {
  stranded: {
    categoryBadge: "Surprinse în mașini / trafic",
    sectionTitle: "🚗 Persoane și autovehicule surprinse în mașini / trafic",
    personsLabel: "Persoane surprinse în mașini",
    shortPersonsLabel: "Surprinse în mașini",
    personsPlaceholder: "Ex. 7 persoane (5 adulți, 2 copii)",
    assetsLabel: "Autovehicule blocate",
    shortAssetsLabel: "Vehicule blocate",
    assetsPlaceholder: "Ex. 3 autoturisme, 1 microbuz",
  },
  houses: {
    categoryBadge: "În case / gospodării afectate",
    sectionTitle: "🏠 Persoane și gospodării afectate (în case)",
    personsLabel: "Persoane în case / gospodării",
    shortPersonsLabel: "Persoane în case",
    personsPlaceholder: "Ex. 5 persoane vârstnice monitorizate",
    assetsLabel: "Case / gospodării afectate",
    shortAssetsLabel: "Gospodării",
    assetsPlaceholder: "Ex. 3 gospodării înzăpezite",
  },
  persons: {
    categoryBadge: "Victime / cazuri medicale critice",
    sectionTitle: "🆘 Victime / persoane blocate sau cazuri medicale",
    personsLabel: "Victime / persoane asistate",
    shortPersonsLabel: "Victime / persoane",
    personsPlaceholder: "Ex. 2 persoane (1 pacient dializat, 1 gravidă)",
    assetsLabel: "Unde se află (casă, auto, teren)",
    shortAssetsLabel: "Locație",
    assetsPlaceholder: "Ex. În locuință izolată / în autoturism",
  },
  isolated: {
    categoryBadge: "Populație în localitate izolată",
    sectionTitle: "🏘️ Populație și gospodării izolate",
    personsLabel: "Populație izolată / afectată",
    shortPersonsLabel: "Populație izolată",
    personsPlaceholder: "Ex. ~120 locuitori (15 vârstnici)",
    assetsLabel: "Gospodării / obiective izolate",
    shortAssetsLabel: "Gospodării izolate",
    assetsPlaceholder: "Ex. 45 gospodării fără acces auto",
  },
  power: {
    categoryBadge: "Consumatori fără energie electrică",
    sectionTitle: "⚡ Populație și gospodării fără curent",
    personsLabel: "Consumatori / persoane afectate",
    shortPersonsLabel: "Consumatori afectați",
    personsPlaceholder: "Ex. ~350 locuitori afectați",
    assetsLabel: "Gospodării / PT nealimentate",
    shortAssetsLabel: "Obiective afectate",
    assetsPlaceholder: "Ex. 140 gospodării, 2 posturi trafo",
  },
  evacuated: {
    categoryBadge: "Persoane evacuate / autoevacuate",
    sectionTitle: "🚨 Persoane și gospodării evacuate",
    personsLabel: "Persoane evacuate / autoevacuate",
    shortPersonsLabel: "Persoane evacuate",
    personsPlaceholder: "Ex. 18 persoane (14 adulți, 4 copii)",
    assetsLabel: "Locuințe / gospodării evacuate",
    shortAssetsLabel: "Locuințe evacuate",
    assetsPlaceholder: "Ex. 7 locuințe evacuate preventiv",
  },
  flooded: {
    categoryBadge: "Gospodării / sector afectat de inundații",
    sectionTitle: "🌊 Persoane și bunuri afectate de inundații",
    personsLabel: "Persoane afectate / izolate de ape",
    shortPersonsLabel: "Persoane afectate",
    personsPlaceholder: "Ex. 6 persoane în gospodării inundate",
    assetsLabel: "Case / curți / anexe inundate",
    shortAssetsLabel: "Bunuri inundate",
    assetsPlaceholder: "Ex. 2 case, 5 curți inundate",
  },
  threat: {
    categoryBadge: "Zonă expusă / amenințată",
    sectionTitle: "⚠️ Populație și obiective în zona de risc",
    personsLabel: "Persoane în zona amenințată",
    shortPersonsLabel: "Persoane în risc",
    personsPlaceholder: "Ex. ~30 persoane avizate",
    assetsLabel: "Gospodării / obiective expuse",
    shortAssetsLabel: "Obiective expuse",
    assetsPlaceholder: "Ex. 12 gospodării în lunca inundabilă",
  },
  fire: {
    categoryBadge: "Victime / bunuri în perimetrul incendiului",
    sectionTitle: "🔥 Victime și bunuri afectate de incendiu",
    personsLabel: "Victime / persoane evacuate",
    shortPersonsLabel: "Victime / evacuați",
    personsPlaceholder: "Ex. 2 persoane asistate medical (fără decese)",
    assetsLabel: "Construcții / suprafață afectată",
    shortAssetsLabel: "Bunuri afectate",
    assetsPlaceholder: "Ex. 2 locuințe, 3 anexe / 10 ha vegetație",
  },
  blocked: {
    categoryBadge: "Sector de drum blocat / închis",
    sectionTitle: "⛔ Persoane și vehicule surprinse pe sectorul blocat (opțional)",
    personsLabel: "Persoane surprinse pe drum",
    shortPersonsLabel: "Persoane pe drum",
    personsPlaceholder: "Ex. 7 persoane în autovehicule (dacă există)",
    assetsLabel: "Autovehicule oprite / blocate",
    shortAssetsLabel: "Vehicule oprite",
    assetsPlaceholder: "Ex. 3 autoturisme, 1 TIR (dacă există)",
  },
  snow: {
    categoryBadge: "Sector / zonă înzăpezită",
    sectionTitle: "❄️ Persoane și vehicule afectate de înzăpezire (opțional)",
    personsLabel: "Persoane surprinse în zăpadă",
    shortPersonsLabel: "Persoane afectate",
    personsPlaceholder: "Ex. 4 persoane în autoturisme (dacă există)",
    assetsLabel: "Autovehicule / gospodării afectate",
    shortAssetsLabel: "Bunuri afectate",
    assetsPlaceholder: "Ex. 2 autoturisme (dacă există)",
  },
  damaged: {
    categoryBadge: "Sector de drum deteriorat / restricționat",
    sectionTitle: "⚠️ Persoane și vehicule afectate pe sector (opțional)",
    personsLabel: "Persoane afectate",
    shortPersonsLabel: "Persoane afectate",
    personsPlaceholder: "Ex. Fără victime (opțional)",
    assetsLabel: "Vehicule / infrastructură afectată",
    shortAssetsLabel: "Infrastructură",
    assetsPlaceholder: "Ex. 1 podeț avariat (opțional)",
  },
};

export function getAffectedMeta(kind) {
  return AFFECTED_META[kind] || {
    categoryBadge: KINDS[kind] || "Situație operativă",
    sectionTitle: "Persoane și bunuri afectate",
    personsLabel: "Victime / persoane afectate",
    shortPersonsLabel: "Persoane afectate",
    personsPlaceholder: "Ex. număr persoane (adulți, copii, vârstnici)",
    assetsLabel: "Vehicule / clădiri / bunuri afectate",
    shortAssetsLabel: "Bunuri afectate",
    assetsPlaceholder: "Ex. autoturisme, gospodării, anexe",
  };
}

const CIVIL_PERSON_RE = /\b(persoan[aăe]|adul[tț]i?|copi[il]|v[aă]rstnic[iăe]?|victim[aăe]|pacien[tț]i?|locuitor[i]?|cet[aă][tț]en[i]?|evacua[tț][iăe]?|sinistra[tț][iăe]?)\b/i;
const FORCE_PERSON_RE = /\b(ofi[tț]er[i]?|subofi[tț]er[i]?|agen[tț]i?|jandarm[i]?|pompier[i]?|militar[i]?|voluntar[i]?|lucr[aă]tor[i]?|operator[i]?|echipaj[e]?|paramedic[i]?)\b/i;
const CIVIL_ASSET_RE = /\b(autoturism[e]?|autovehicul[e]?|ma[sș]in[aăi]|microbuz[e]?|autobuz[e]?|tir(-uri)?|camion|camioane|gospod[aă]ri[ie]|cas[aăe]|locuin[tț][aăe]|anex[aăe]|bloc(uri)?)\b/i;
const FORCE_VEHICLE_RE = /\b(asas|autospecial[aăe]|[sș]enilat[aăe]|utv|autofrez[aăe]|buldoexcavator|ambulan[tț][aăe]|smurd|motopomp[aăe]|barc[aăi]|autocamion)\b/i;

export function normalizeFeatureProperties(p) {
  if (!p || FORCE_KINDS.includes(p.kind)) return p;
  if (p.id === "mark-masini-blocate-1" && !p.affectedPersons && p.personnel === "7 persoane (5 adulți, 2 copii)") {
    p.affectedPersons = "7 persoane (5 adulți, 2 copii)";
    p.affectedAssets = p.vehicles || "3 autoturisme";
    p.source = "ISU Botoșani, IPJ Botoșani, SDN Botoșani";
    p.personnel = "3 subofițeri ISU, 2 agenți IPJ, 1 operator SDN";
    p.vehicles = "1 șenilată ISU, 1 autofreză SDN, 1 autospecială IPJ";
    return p;
  }
  if (p.id === "mark-case-inzapezite-1" && !p.affectedPersons && p.personnel === "5 persoane vârstnice monitorizate") {
    p.affectedPersons = "5 persoane vârstnice monitorizate";
    p.affectedAssets = "3 gospodării înzăpezite";
    p.personnel = "2 lucrători SVSU Vlădeni";
    return p;
  }
  if (!p.affectedPersons && p.personnel && CIVIL_PERSON_RE.test(p.personnel) && !FORCE_PERSON_RE.test(p.personnel)) {
    p.affectedPersons = p.personnel;
    p.personnel = "";
  }
  if (!p.affectedAssets && p.vehicles && CIVIL_ASSET_RE.test(p.vehicles) && !FORCE_VEHICLE_RE.test(p.vehicles)) {
    p.affectedAssets = p.vehicles;
    p.vehicles = "";
  }
  return p;
}

function normalizeEventFeatures(ev) {
  if (!ev?.features?.features) return ev;
  for (const f of ev.features.features) {
    if (f?.properties) normalizeFeatureProperties(f.properties);
  }
  return ev;
}

function formatMarkerDetails(p) {
  if (!p) return "";
  if (FORCE_KINDS.includes(p.kind)) {
    return [
      p.source || DEFAULT_AGENCY[p.kind],
      p.personnel ? `Forțe: ${p.personnel}` : "",
      p.vehicles ? `Mijloace: ${p.vehicles}` : "",
    ].filter(Boolean).join(" · ");
  }
  const meta = getAffectedMeta(p.kind);
  return [
    p.affectedPersons ? `${meta.shortPersonsLabel}: ${p.affectedPersons}` : "",
    p.affectedAssets ? `${meta.shortAssetsLabel}: ${p.affectedAssets}` : "",
    p.source ? `Intervenție: ${p.source}` : "",
    p.personnel ? `Forțe: ${p.personnel}` : "",
    p.vehicles ? `Mijloace: ${p.vehicles}` : "",
  ].filter(Boolean).join(" · ");
}

export const STATUSES = {
  confirmed: "Confirmat",
  reported: "Raportat",
  threat: "Potențial",
  resolved: "Rezolvat / Redeschis",
};

const options = (items, selected) => Object.entries(items).map(([value, label]) => `<option value="${esc(value)}" ${selected === value ? "selected" : ""}>${esc(label)}</option>`).join("");
const pickKinds = (keys) => Object.fromEntries(keys.map(k => [k, KINDS[k]]));
const id = () => globalThis.crypto?.randomUUID?.() ?? `m-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function download(name, archive) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function saveJsonFile(name, archive) {
  const content = JSON.stringify(archive, null, 2);
  if (typeof window.showSaveFilePicker === "function") {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: "Bază de date situații JSON", accept: { "application/json": [".json"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      return true;
    } catch (err) {
      if (err?.name === "AbortError") return false;
    }
  }
  download(name, archive);
  return true;
}

function featureBounds(geometry) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (coords) => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number" && typeof coords[1] === "number") {
      minX = Math.min(minX, coords[0]); minY = Math.min(minY, coords[1]);
      maxX = Math.max(maxX, coords[0]); maxY = Math.max(maxY, coords[1]);
    } else coords.forEach(visit);
  };
  visit(geometry?.coordinates);
  return Number.isFinite(minX) ? [[minX, minY], [maxX, maxY]] : null;
}

const MAP_LABEL_MAX = 32;
const STATUS_WORD = { threat: "Potențial", confirmed: "Confirmat", resolved: "Rezolvat" };
export function shortLabel(text, max = MAP_LABEL_MAX) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}
function withMapLabels(features = []) {
  return features.map(f => {
    const p = f.properties || {};
    const routeName = isItinerary(f) ? `${p.kind === "route_primary" ? "Bază" : "Rezervă"} · ${(p.source || "Subunitate").replace(/^Garda de intervenție /, "G. ").replace(/^Punctul de lucru /, "PL ")}` : "";
    const name = shortLabel(routeName || p.title || p.road || "");
    const status = isItinerary(f) ? `${p.lengthKm ?? "—"} km` : STATUS_WORD[p.status] || "Raportat";
    return { ...f, properties: { ...p, mapLabel: name ? `${name}\n${status}` : status, mapLabelInline: name ? `${name} · ${status}` : status } };
  });
}

function buildEndpointsFC(features = []) {
  const pts = [];
  for (const f of features) {
    if (f.geometry?.type !== "LineString" || f.geometry.coordinates.length < 2) continue;
    const p = f.properties || {};
    const start = f.geometry.coordinates[0];
    const end = f.geometry.coordinates.at(-1);
    const startLabel = p.kmFrom != null ? `km ${p.kmFrom}` : "";
    const endLabel = p.kmTo != null ? `km ${p.kmTo}` : "";
    pts.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: start },
      properties: { id: p.id + "-start", status: p.status, kind: p.kind, label: startLabel },
    });
    pts.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: end },
      properties: { id: p.id + "-end", status: p.status, kind: p.kind, label: endLabel },
    });
  }
  return FC(pts);
}

export function initOperations(ctx) {
  const { map, state, uatAt, toast, selectTab, setSheet, applyStyle, renderLayerPanel, stopOtherTools, applyPreset, cloudDb } = ctx;
  const panel = document.querySelector("#tab-situatii");
  const operationCards = createOperationsCards(panel);
  const storage = ctx.storage ?? globalThis.localStorage;
  const SESSION_KEY = "hb.ops.session.v1";
  const db = new EventStore(storage);
  const cloudStates = new CloudStates(storage);
  let cloudStatus = "offline";
  if (cloudDb?.onStatus) {
    cloudDb.onStatus((s) => {
      cloudStatus = s;
      const el = panel?.querySelector("#ops-cloud-pill");
      if (el) {
        el.className = `ops-cloud-pill is-${s}`;
        el.textContent = s === "connected" ? "🟢 Cloud sincronizat" : s === "connecting" ? "🟡 Conectare Cloud…" : "⚪ Mod local";
      }
    });
  }

  try { cleanupLegacyArchive(storage); }
  catch (e) { console.warn("Nu am putut curăța arhiva din 16.10.2026; datele originale sunt păstrate.", e); }

  // Merge initial seed events from data/situatii.json if available
  if (state.data.initialEvents?.events?.length) {
    try { db.importArchive(state.data.initialEvents); } catch (e) { console.warn("Nu am putut importa situatii.json", e); }
  }

  let active = null, dirty = false, exported = false, mode = null, points = [], startSnap = null, roadPool = [];
  // The warning whose UATs the "area" mode picks; null picks the situation's own zone.
  let areaTarget = null, brushed = null;
  let pending = null, editingId = null, beforePresentation = null, previousOverlays = null;
  let archiveError = "", notice = "", resizeFrame = 0, archiveFilter = "", summaryCollapsed = false, messagesCollapsed = false, legendCollapsed = false, commandsCollapsed = true, hideResolvedInPresentation = false;
  const presentationCollapsedGroups = new Set();
  const isCompactViewport = () => window.innerWidth <= 760 || window.innerHeight <= 520;
  let compactPresentation = isCompactViewport(), lastOpenedPanel = "messages";
  let standaloneFocus = { areas: [], places: [], isolate: true };
  let restoring = false;
  // Edits are autosaved in this browser at once but reach other screens only when published.
  // Each situation's Cloud state (CloudStates) records that gap and the Cloud version its local
  // copy started from, so a colleague's newer copy is told apart from the echo of our own publish.
  let publishing = false, cloudSeen = false;
  // The Cloud version this screen's copy derives from. It equals the stored base unless another
  // tab moved the archive under this screen; a version that arrived that way is still a colleague's.
  let screenBase = null;
  const NO_CLOUD_STATE = Object.freeze({ base: null, unpublished: false, conflict: null, sent: [] });
  const cloudState = () => (active && cloudStates.get(active.id)) || NO_CLOUD_STATE;
  const setCloudState = patch => {
    if (!active) return;
    if (Object.hasOwn(patch, "base")) screenBase = patch.base;
    cloudStates.update(active.id, patch);
  };
  // Ids whose Cloud copy is still our own unconfirmed write, and the last snapshot, replayed
  // when work that held a newer version back is dropped.
  let cloudPending = new Set(), lastSnapshot = null;
  let confirmDeleteId = null, undo = null;
  // With a situation open, "Focalizează UAT / satul" from the map only frames the view:
  // exploring the map in a meeting must not add areas to what is saved and published.
  let viewFocus = null;
  const cloudCopies = new Map(), inFlight = new Set();

  state.operations = {
    features: FC(), draft: FC(), selection: FC(), alerts: FC(), alertLabels: FC(), mask: FC(), endpoints: FC(),
    focusGeometry: null, tintAreas: true,
  };

  const alertEditor = createAlertEditor({
    panel, getActive: () => active, getData: () => state.data,
    onChange: ({ render: rerender = false, geography = false } = {}) => {
      // Warning layers are data-driven: setData is enough unless the isolated outline,
      // which is baked into label filters, gains or loses a UAT.
      changed(); sync(geography && (active?.isolateArea ?? true));
      if (rerender) render();
      if (state.operations.presenting) renderPresentationOverlay();
    },
    onPickMap: alertId => {
      start("area");
      if (mode === "area") { areaTarget = alertId; drawInstructions(); }
    },
  });
  // Warning popups stay quiet while any other map tool owns the pointer.
  attachAlertPopups(map, () => Boolean(active && !mode && !pending && !itinerary.isPicking() && !ctx.isMapToolActive?.()));

  function persistSession() {
    if (restoring) return;
    try {
      storage?.setItem(SESSION_KEY, JSON.stringify({
        active,
        standaloneFocus,
        pending,
        editingId,
        dirty,
        summaryCollapsed,
        messagesCollapsed,
        legendCollapsed,
        commandsCollapsed,
        hideResolvedInPresentation,
      }));
    } catch { /* ignore storage quota errors */ }
  }

  function autoSaveActiveToDb() {
    if (restoring || !active || !String(active.title || "").trim()) return;
    try {
      const snap = sanitizeEvent({
        ...active,
        updatedAt: new Date().toISOString(),
        view: map ? currentView() : active.view,
        visible: { ...state.visible },
      });
      holdMovedArchive();
      // The archive stamps its own time: the screen keeps that one, so the two copies compare equal.
      active.updatedAt = db.save(snap).updatedAt;
      dirty = false;
    } catch { /* keep draft in session storage until valid */ }
  }

  // Another tab may have stored a colleague's Cloud version in the archive since this screen loaded
  // its copy. Before a save replaces it there, it is held as a conflict against the version this
  // screen derives from, so the choice stays with the operator.
  function holdMovedArchive() {
    if (!active) return;
    let stored = null;
    try { stored = db.load(active.id); } catch { return; }
    const { base, conflict } = cloudState();
    if (!stored || conflict || stored.updatedAt === active.updatedAt || stored.updatedAt !== base || base === screenBase) return;
    setCloudState({ base: screenBase, conflict: stored });
    showConflict();
    toast(`Altcineva a publicat o versiune nouă a situației „${stored.title}”. Modificările tale nu au fost înlocuite.`);
  }

  function saveActive() {
    holdMovedArchive();
    return db.save(snapshot());
  }

  // Before a publish: a newer Cloud version this tab already heard is held, whatever another tab
  // did with the shared state meanwhile.
  function holdNewerRemote() {
    const rival = newerRemote();
    if (!rival || cloudState().conflict) return;
    setCloudState({ conflict: rival });
    showConflict();
  }

  function restoreSession() {
    restoring = true;
    try {
      const raw = storage?.getItem(SESSION_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (typeof saved?.summaryCollapsed === "boolean") summaryCollapsed = saved.summaryCollapsed;
      if (typeof saved?.messagesCollapsed === "boolean") messagesCollapsed = saved.messagesCollapsed;
      if (typeof saved?.legendCollapsed === "boolean") legendCollapsed = saved.legendCollapsed;
      if (typeof saved?.commandsCollapsed === "boolean") commandsCollapsed = saved.commandsCollapsed;
      if (typeof saved?.hideResolvedInPresentation === "boolean") hideResolvedInPresentation = saved.hideResolvedInPresentation;
      if (saved?.standaloneFocus && typeof saved.standaloneFocus === "object") {
        standaloneFocus = {
          areas: Array.isArray(saved.standaloneFocus.areas) ? saved.standaloneFocus.areas.filter(Boolean) : [],
          places: Array.isArray(saved.standaloneFocus.places) ? saved.standaloneFocus.places.filter(Boolean) : [],
          isolate: typeof saved.standaloneFocus.isolate === "boolean" ? saved.standaloneFocus.isolate : true,
        };
      }
      if (saved?.active && typeof saved.active === "object") {
        // The archive holds the last saved copy. Every tab writes the same session, so a session
        // copy of another version may be another tab's older one; one of the same version keeps
        // what never reaches the archive (unsaved edits, presentation toggles).
        const fromDb = !saved.dirty && saved.active.id ? db.load(saved.active.id) : null;
        try {
          active = fromDb && fromDb.updatedAt !== saved.active.updatedAt ? fromDb : sanitizeEvent(saved.active);
        } catch {
          active = fromDb || saved.active;
        }
        if (active) {
          normalizeEventFeatures(active);
          active.places = Array.isArray(active.places) ? active.places : [];
          active.areas = Array.isArray(active.areas) ? active.areas : [];
          active.isolateArea = active.isolateArea ?? false;
          active.tintAreas = active.tintAreas ?? true;
        }
      }
      if (saved?.pending && typeof saved.pending === "object" && saved.pending.properties) {
        normalizeFeatureProperties(saved.pending.properties);
        pending = saved.pending;
        editingId = saved.editingId || null;
      }
      dirty = Boolean(saved?.dirty);
      // Sessions saved before 25.10.2026 kept the Cloud state of the open situation only.
      if (active && !cloudStates.get(active.id) && (saved.unpublished || saved.cloudBase || saved.cloudConflict)) {
        cloudStates.update(active.id, {
          base: typeof saved.cloudBase === "string" ? saved.cloudBase : null,
          unpublished: Boolean(saved.unpublished),
          conflict: saved.cloudConflict && typeof saved.cloudConflict === "object" ? saved.cloudConflict : null,
        });
      }
      if (active) {
        const known = cloudStates.get(active.id);
        // A copy that differs from its Cloud base without unpublished work came from elsewhere
        // (an imported file, the seed, an edit whose state could not be stored): it is local work.
        if (known?.base && !known.unpublished && active.updatedAt !== known.base) cloudStates.update(active.id, { unpublished: true });
        screenBase = known?.base ?? null;
      }
    } catch (e) {
      console.warn("Nu am putut restaura sesiunea operativă", e);
    } finally {
      restoring = false;
    }
  }

  const drawbar = document.createElement("div");
  drawbar.className = "ops-drawbar";
  drawbar.hidden = true;
  document.querySelector(".mapwrap").appendChild(drawbar);

  const focusbar = document.createElement("div");
  focusbar.className = "ops-focusbar";
  focusbar.hidden = true;
  document.querySelector(".mapwrap").appendChild(focusbar);

  const presentation = document.createElement("section");
  presentation.className = "ops-presentation";
  presentation.hidden = true;
  document.querySelector(".mapwrap").appendChild(presentation);

  const itinerary = createInterventionPlanner({
    state, map, getActive: () => active, render, toast,
    onPickStart() {
      stopOtherTools(); stopDrawing(); setSheet("peek");
      map.getCanvas().style.cursor = "crosshair";
      drawbar.innerHTML = '<span>Alege intrarea în obiectiv pe hartă.</span><button type="button" class="btn" data-action="cancel-itinerary-pick">Anulează</button>';
      drawbar.hidden = false;
      toast("Alege pe hartă intrarea în obiectivul afectat.");
    },
    onPickEnd() {
      map.getCanvas().style.cursor = "";
      drawbar.hidden = true;
      selectTab("situatii"); setSheet("half");
    },
    onRoutes(result, meta) {
      if (!active || !result.primary) return;
      const group = `itinerary-${meta.unit.id}-${meta.destination.coordinate.map(n => Math.round(n * 1e6)).join("-")}`;
      const routes = [["route_primary", result.primary], ["route_backup", result.alternative]]
        .filter(([, route]) => route).map(([kind, route]) => ({
          type: "Feature", geometry: route.geometry,
          properties: {
            id: id(), kind, status: "reported", routeGroup: group,
            subunitId: meta.unit.id, objectiveId: String(meta.destination.id || "").slice(0, 200),
            origin: [...meta.unit.coordinate], destination: [...meta.destination.coordinate],
            title: `${KINDS[kind]} · ${meta.unit.name} → ${meta.destination.name}`.slice(0, 200),
            source: meta.unit.name, lengthKm: +route.distanceKm.toFixed(2),
            observedAt: new Date().toISOString(),
            notes: "Propunere pe rețeaua hărții; accesul și gabaritul autospecialei trebuie verificate în teren.",
          },
        }));
      const candidate = structuredClone(active);
      candidate.isolateArea = false;
      candidate.features.features = [...candidate.features.features.filter(f => f.properties.routeGroup !== group), ...routes];
      try { sanitizeEvent(candidate); }
      catch { toast("Itinerarul depășește limitele arhivei și nu a fost salvat."); return; }
      active = candidate;
      changed(); sync(true); render(); fit();
    },
  });

  const hoverPop = document.createElement("div");
  hoverPop.className = "ops-hover-pop";
  hoverPop.hidden = true;
  document.querySelector(".mapwrap").appendChild(hoverPop);

  function hideHoverPop() {
    if (!hoverPop.hidden) hoverPop.hidden = true;
  }

  function handleMapHover(event) {
    if (!active || mode || !map?.isStyleLoaded?.()) {
      hideHoverPop();
      return;
    }
    const layers = ["ops-features-point", "ops-features-line", "ops-route-backup", "ops-features-fill"].filter(layer => map.getLayer(layer));
    if (!layers.length) {
      hideHoverPop();
      return;
    }
    const hits = map.queryRenderedFeatures([[event.point.x - 9, event.point.y - 9], [event.point.x + 9, event.point.y + 9]], { layers });
    const hitId = hits[0]?.properties?.id;
    const feature = hitId ? active.features.features.find(f => f.properties.id === hitId) : null;
    if (!feature) {
      hideHoverPop();
      return;
    }
    const p = normalizeFeatureProperties({ ...(feature.properties || {}) });
    const isForce = FORCE_KINDS.includes(p.kind);
    const meta = getAffectedMeta(p.kind);
    const kmTxt = p.kmFrom != null ? `km ${p.kmFrom}${p.kmTo != null ? "–" + p.kmTo : ""}` : "";
    const lenTxt = p.lengthKm ? `${p.lengthKm} km` : "";
    const roadLine = [p.road, kmTxt, lenTxt ? `(${lenTxt})` : ""].filter(Boolean).join(" · ");
    const title = p.title || roadLine || KINDS[p.kind] || "Marcaj operativ";
    const dotKind = p.status === "resolved" ? "resolved" : p.kind;

    const rows = [];
    if (isForce) {
      const agency = p.source || DEFAULT_AGENCY[p.kind] || "—";
      rows.push(["Structură / Instituție", agency]);
      rows.push(["Forțe (efective)", p.personnel || "Nespecificat"]);
      rows.push(["Mijloace (tehnică)", p.vehicles || "Nespecificat"]);
    } else {
      if (p.affectedPersons || p.affectedAssets) {
        rows.push(["Categorie situație", meta.categoryBadge]);
      }
      if (p.affectedPersons) rows.push([meta.personsLabel, p.affectedPersons]);
      if (p.affectedAssets) rows.push([meta.assetsLabel, p.affectedAssets]);
      if (p.source) rows.push(["Structuri intervenție", p.source]);
      if (p.personnel) rows.push(["Forțe (ISU/IPJ/IJJ…)", p.personnel]);
      if (p.vehicles) rows.push(["Mijloace intervenție", p.vehicles]);
    }
    if (roadLine && roadLine !== title) rows.push(["Sector drum", roadLine]);
    if (p.notes) rows.push(["Detalii / Măsuri", p.notes]);

    hoverPop.innerHTML = `
      <div class="ops-hpop-head">
        <span class="ops-dot" data-kind="${esc(dotKind)}"></span>
        <div>
          <strong>${esc(title)}</strong>
          <small>${esc(KINDS[p.kind] || p.kind)} · ${esc(STATUSES[p.status] || p.status)}</small>
        </div>
      </div>
      ${rows.length ? `<dl class="ops-hpop-dl">${rows.map(([k, v]) => `<div><dt>${esc(k)}:</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` : ""}
    `;
    hoverPop.hidden = false;

    const wrap = document.querySelector(".mapwrap");
    const maxW = wrap?.clientWidth || window.innerWidth;
    const maxH = wrap?.clientHeight || window.innerHeight;
    const popW = hoverPop.offsetWidth || 260;
    const popH = hoverPop.offsetHeight || 110;
    const left = Math.min(Math.max(12, event.point.x + 14), Math.max(12, maxW - popW - 12));
    const top = event.point.y - popH - 14 >= 12 ? event.point.y - popH - 14 : Math.min(maxH - popH - 12, event.point.y + 16);
    hoverPop.style.left = `${left}px`;
    hoverPop.style.top = `${top}px`;
  }

  map?.on?.("mousemove", handleMapHover);
  map?.on?.("movestart", hideHoverPop);
  map?.getCanvas?.()?.addEventListener?.("mouseleave", hideHoverPop);

  function message(text) {
    notice = text;
    toast(text);
    const el = panel.querySelector(".ops-notice");
    if (el) el.textContent = text;
  }

  function list() {
    try { archiveError = ""; return db.list(); }
    catch { archiveError = "Arhiva locală nu poate fi citită. Datele existente nu au fost înlocuite; poți exporta situația curentă în JSON."; return []; }
  }

  function changed() {
    dirty = true; setCloudState({ unpublished: true }); exported = false;
    autoSaveActiveToDb();
    persistSession();
    refreshSaveState();
  }

  function refreshSaveState() {
    const badge = panel.querySelector("#ops-save-state");
    if (badge) badge.textContent = saveStateText();
  }

  function saveStateText() {
    if (!active) return "";
    if (alertEditor.rejectedDates().length) return "Interval invalid · e păstrată ultima variantă validă";
    if (dirty) return exported ? "Exportat JSON · nesalvat în browser" : "Modificări nesalvate";
    const { unpublished, base } = cloudState();
    if (unpublished) return `Salvat în acest browser · nepublicat în Cloud · ${dateLabel(active.updatedAt)}`;
    if (base) return `Publicat în Cloud · ${dateLabel(base)}`;
    return `Salvat în acest browser · ${dateLabel(active.updatedAt)}`;
  }

  function currentView() {
    const center = map.getCenter();
    return { center: [center.lng, center.lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
  }

  function ensureActiveEvent(defaultType = "snow", defaultTitle = "") {
    if (active) return active;
    const today = new Date().toLocaleDateString("ro-RO", { day: "numeric", month: "short", year: "numeric" });
    const title = defaultTitle || `Situație operativă CJSU · ${today}`;
    active = createEvent(title, defaultType);
    active.places = [...standaloneFocus.places];
    active.areas = [...standaloneFocus.areas];
    active.isolateArea = standaloneFocus.areas.length > 0 || standaloneFocus.places.length > 0 ? standaloneFocus.isolate : false;
    active.tintAreas = true;
    standaloneFocus = { areas: [], places: [], isolate: true };
    dirty = true; setCloudState({ base: null, unpublished: true, conflict: null }); exported = false;
    autoSaveActiveToDb();
    persistSession();
    return active;
  }

  function snapshot() {
    const metaForm = panel.querySelector("#ops-meta");
    if (metaForm && !metaForm.reportValidity()) throw new Error("Invalid event metadata");
    return sanitizeEvent({
      ...active,
      updatedAt: new Date().toISOString(),
      view: currentView(),
      visible: { ...state.visible },
    });
  }

  function allLocalities() {
    return state.data.localities || [];
  }

  function findLocality(name) {
    if (!name) return null;
    const q = String(name).trim().toLowerCase();
    // Ten names also exist across the border; like warnings, prefer the village inside the county.
    const exact = allLocalities().filter(l => l.name.toLowerCase() === q);
    if (exact.length) return exact.find(l => l.uat) || exact[0];
    const prefix = allLocalities().filter(l => l.name.toLowerCase().startsWith(q));
    return prefix.find(l => l.uat) || prefix[0] || null;
  }

  function selectedGeometry(alerts = buildAlertGeography(active, state.data)) {
    // A view frames only what was explored; the situation's own areas and warnings return with it.
    const warningLocations = viewFocus ? { areas: [], places: [] } : affectedAlertLocations(active);
    const areaNames = new Set(viewFocus ? viewFocus.areas : active ? [...active.areas, ...warningLocations.areas] : standaloneFocus.areas);
    // Focus places keep their name search; warning villages resolve by exact `Name|UAT` key.
    const focusPlaces = (viewFocus ? viewFocus.places : active ? active.places || [] : standaloneFocus.places).map(findLocality);
    const warningPlaces = active ? warningLocations.places.map(entry => resolvePlace(entry, allLocalities())) : [];
    // `alert` marks shapes a code outline already draws, so the focus outline can step aside
    // there and only there: a village the warnings merged into its UAT keeps its circle.
    const outlined = alertOutlined(alerts);
    const uatFeatures = (state.data.admin?.features || [])
      .filter(f => f.properties.kind === "uat" && areaNames.has(f.properties.name))
      .map(f => outlined.uat(f.properties.name) ? { ...f, properties: { ...f.properties, alert: true } } : f);
    const placeFeatures = [];
    for (const loc of new Set([...focusPlaces, ...warningPlaces])) {
      if (loc) {
        const poly = circle([loc.lon, loc.lat], 1600, 48);
        placeFeatures.push({ type: "Feature", properties: { kind: "place-focus", name: loc.name, alert: outlined.place(loc) }, geometry: poly });
      }
    }
    const features = [...uatFeatures, ...placeFeatures];
    const coordinates = features.flatMap(f => f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates);
    return { features, geometry: coordinates.length ? { type: "MultiPolygon", coordinates } : null };
  }

  function renderFocusBar() {
    const areas = viewFocus ? viewFocus.areas : active ? active.areas : standaloneFocus.areas;
    const places = viewFocus ? viewFocus.places : active ? (active.places || []) : standaloneFocus.places;
    const isolate = viewFocus ? viewFocus.isolate : active ? !!active.isolateArea : standaloneFocus.isolate;
    if ((!areas.length && !places.length) || document.body.classList.contains("presenting")) {
      focusbar.hidden = true;
      return;
    }
    const tags = [
      ...areas.map(a => `<button type="button" class="ops-fchip" data-fremove-uat="${esc(a)}" title="Elimină UAT din focalizare">UAT ${esc(a)} ×</button>`),
      ...places.map(p => `<button type="button" class="ops-fchip" data-fremove-place="${esc(p)}" title="Elimină localitatea din focalizare">${esc(p)} ×</button>`),
    ].join("");
    focusbar.innerHTML = `
      <div class="ops-fbar-chips"><strong>${viewFocus ? "Vizualizare:" : "Focus:"}</strong> ${tags}</div>
      <div class="ops-fbar-btns">
        ${viewFocus ? `<button type="button" data-faction="adopt-view" title="Adaugă zona vizualizată în situația deschisă">Adaugă în situație</button>` : ""}
        <button type="button" data-faction="toggle-isolate" aria-pressed="${isolate}">${isolate ? "Exterior mascat" : "Izolează conturul"}</button>
        <button type="button" data-faction="fit">Încadrează</button>
        <button type="button" data-faction="clear-focus">${viewFocus ? "Înapoi la situație" : "Tot județul"}</button>
      </div>`;
    focusbar.hidden = false;
  }

  function sync(refresh = false) {
    const alerts = buildAlertGeography(active, state.data);
    const selected = selectedGeometry(alerts);
    const isolate = viewFocus ? viewFocus.isolate : active ? (active.isolateArea ?? true) : standaloneFocus.isolate;
    const geometry = mode === "area" || !isolate ? null : selected.geometry;
    const allFeatures = active?.features?.features || [];
    const mapFeatures = state.operations.presenting
      ? presentationFeatures(allFeatures, active?.type, hideResolvedInPresentation)
      : allFeatures;
    const activeFeatures = FC(withMapLabels(mapFeatures));
    const draftFeatures = pending ? [pending] : points.length ? [{
      type: "Feature", properties: {},
      geometry: points.length === 1 ? { type: "Point", coordinates: points[0] } : { type: "LineString", coordinates: points },
    }] : [];

    state.operations.features = activeFeatures;
    state.operations.endpoints = buildEndpointsFC([
      ...activeFeatures.features,
      ...(pending?.geometry?.type === "LineString" ? [pending] : []),
    ]);
    state.operations.selection = FC(selected.features);
    state.operations.alerts = alerts;
    state.operations.alertLabels = buildAlertLabels(alerts);
    state.operations.focusGeometry = geometry;
    state.operations.mask = geometry ? outsideMask(geometry) : FC();
    state.operations.draft = FC(draftFeatures);
    state.operations.tintAreas = active ? (active.tintAreas ?? true) : false;

    renderFocusBar();
    persistSession();

    if (refresh) applyStyle();
    else {
      for (const [key, source] of [
        ["features", "ops-features"],
        ["endpoints", "ops-endpoints"],
        ["selection", "ops-selection"],
        ["alerts", "ops-alerts"],
        ["alertLabels", "ops-alert-labels"],
        ["mask", "ops-mask"],
        ["draft", "ops-draft"],
      ]) {
        map.getSource(source)?.setData(state.operations[key]);
      }
    }
  }

  function fitGeometry(geom) {
    const b = featureBounds(geom);
    if (!b || !map) return;
    if (b[0][0] === b[1][0] && b[0][1] === b[1][1]) {
      map.flyTo({ center: b[0], zoom: 14.5, duration: 500 });
    } else {
      map.fitBounds(b, { padding: { top: 90, bottom: 90, left: 60, right: 60 }, maxZoom: 15.5, duration: 500 });
    }
  }

  function fit() {
    if (!map) return;
    const selected = selectedGeometry();
    const allFeatures = viewFocus ? [] : active?.features?.features || [];
    const mapFeatures = state.operations.presenting
      ? presentationFeatures(allFeatures, active?.type, hideResolvedInPresentation)
      : allFeatures;
    const geometries = [
      ...selected.features.map(f => f.geometry),
      ...mapFeatures.map(f => f.geometry),
    ];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const g of geometries) {
      const b = featureBounds(g);
      if (!b) continue;
      minX = Math.min(minX, b[0][0]); minY = Math.min(minY, b[0][1]);
      maxX = Math.max(maxX, b[1][0]); maxY = Math.max(maxY, b[1][1]);
    }
    if (!Number.isFinite(minX)) return;
    const presenting = document.body.classList.contains("presenting");
    const padding = presenting ? presentationPadding() : { top: 80, bottom: 100, left: 28, right: 68 };
    map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    map.fitBounds([[minX, minY], [maxX, maxY]], {
      padding,
      retainPadding: false, maxZoom: 15.5, duration: 450,
    });
  }

  // Wire direct main-map UAT & Locality focus (replaces the old modal dialog)
  state.focusUat = (uat) => {
    if (!uat?.name) return;
    stopOtherTools();
    if (active) {
      // The presentation has no focus bar to leave a view, so there the map is only framed.
      if (!state.operations.presenting) {
        viewFocus ??= { areas: [], places: [], isolate: true };
        if (!viewFocus.areas.includes(uat.name)) viewFocus.areas = [...viewFocus.areas, uat.name];
        sync(true);
      }
    } else {
      if (!standaloneFocus.areas.includes(uat.name)) standaloneFocus.areas = [...standaloneFocus.areas, uat.name];
      standaloneFocus.isolate = true;
      sync(true);
      render();
    }
    const b = geometryBounds(uat.feature?.geometry);
    if (b && map) map.fitBounds(b, { padding: { top: 80, bottom: 80, left: 50, right: 50 }, maxZoom: 14.5, duration: 500 });
    toast(active ? `Vizualizare pe UAT ${uat.name}. Situația deschisă nu a fost modificată.` : `Focalizat pe UAT ${uat.name} (direct pe harta principală)`);
  };

  state.focusPlace = (placeOrName, llArg) => {
    const placeName = typeof placeOrName === "object" ? placeOrName?.name : placeOrName;
    const ll = Array.isArray(llArg) ? llArg : (typeof placeOrName === "object" && Number.isFinite(placeOrName?.lon) && Number.isFinite(placeOrName?.lat) ? [placeOrName.lon, placeOrName.lat] : null);
    if (!placeName) return;
    stopOtherTools();
    if (active) {
      if (!state.operations.presenting) {
        viewFocus ??= { areas: [], places: [], isolate: true };
        if (!viewFocus.places.includes(placeName)) viewFocus.places = [...viewFocus.places, placeName];
        sync(true);
      }
    } else {
      if (!standaloneFocus.places.includes(placeName)) standaloneFocus.places = [...standaloneFocus.places, placeName];
      standaloneFocus.isolate = true;
      sync(true);
      render();
    }
    if (ll && map) map.flyTo({ center: ll, zoom: 14, duration: 500 });
    toast(active ? `Vizualizare pe localitatea ${placeName}. Situația deschisă nu a fost modificată.` : `Focalizat pe localitatea ${placeName}`);
  };

  function stopDrawing() {
    mode = null; points = []; startSnap = null; roadPool = []; areaTarget = null; brushed = null;
    drawbar.hidden = true;
    if (map) map.getCanvas().style.cursor = "";
    sync(true);
  }

  function cancelDrawing() {
    if (!mode) return;
    stopDrawing();
    render();
    reconsiderCloud();
  }

  function start(tool, defaultKind = null) {
    itinerary.cancelPick();
    ensureActiveEvent();
    if (pending && tool !== "retrace-road") {
      return message("Salvează marcajul curent (Adaugă / Actualizează) sau apasă Renunță înainte de a folosi alt instrument.");
    }
    stopOtherTools();
    // Picking UATs edits the situation's own areas, so the map shows those again.
    if (tool === "area") viewFocus = null;
    if (tool === "retrace-road") {
      mode = "road";
      points = []; startSnap = null; roadPool = [];
    } else {
      mode = tool; points = []; startSnap = null; roadPool = []; pending = null; editingId = null;
    }
    state.operations._defaultKind = defaultKind;
    sync(true);
    if (map) map.getCanvas().style.cursor = "crosshair";
    selectTab("situatii"); setSheet("peek");
    drawInstructions();
  }

  function openRoadCreator() {
    ensureActiveEvent();
    if (pending) {
      panel.querySelector("#ops-marker")?.scrollIntoView({ block: "start" });
      return;
    }
    stopOtherTools();
    stopDrawing();
    // Create a pending road marker that can be positioned either by KM, between localities, or by 2 clicks on map
    pending = {
      type: "Feature",
      geometry: null,
      properties: {
        id: id(), kind: "blocked", status: "confirmed", title: "", road: "",
        kmFrom: null, kmTo: null, lengthKm: null,
        source: "", personnel: "", vehicles: "", observedAt: new Date().toISOString(), notes: "",
      },
    };
    editingId = null;
    sync(); render(); selectTab("situatii"); setSheet("half");
    requestAnimationFrame(() => {
      panel.querySelector("#ops-marker")?.scrollIntoView({ block: "start" });
      panel.querySelector('#ops-marker input[name="road"]')?.focus();
    });
  }

  function drawInstructions() {
    const text = mode === "road" ? (startSnap ? `Început ales (${startSnap.road.ref || startSnap.road.name || "drum"}). Alege capătul sectorului pe drum` : "Clic pe drum pentru începutul sectorului (sau introdu direct km în panou)")
      : mode === "area" && areaTarget ? `Clic pe comune / orașe pentru a le adăuga sau elimina din avertizarea „${esc(alertEditor.describe(areaTarget))}”. Cu Shift apăsat, trecerea mouse-ului le adaugă.`
      : mode === "area" ? "Clic pe comune / orașe pe hartă pentru a le adăuga sau elimina din zona situației"
      : mode === "zone" ? `Contur zonă: ${points.length} puncte · minimum 3 puncte`
      : mode === "place" ? "Clic pe o localitate / sat pe hartă (sau alege din listă)"
      : "Clic pe hartă pentru a plasa punctul operativ / forța în teren";
    drawbar.innerHTML = `<span>${text}</span>
      ${mode === "road" ? `<button data-action="switch-to-km" type="button">Introdu după km / localități</button>` : ""}
      ${mode === "zone" && points.length ? `<button data-action="undo" type="button">Înapoi</button>` : ""}
      ${mode === "zone" || mode === "area" ? `<button data-action="finish" type="button">Gata</button>` : ""}
      <button data-action="cancel" type="button">${mode === "area" ? "Închide selecția" : "Anulează"}</button>`;
    drawbar.hidden = false;
  }

  function prepare(geometry, kind, extra = {}) {
    const prevProps = pending?.properties || {};
    const resolvedKind = kind || prevProps.kind || "blocked";
    pending = {
      type: "Feature",
      geometry,
      properties: {
        id: prevProps.id || id(),
        kind: resolvedKind,
        status: prevProps.status || "confirmed",
        title: prevProps.title || "",
        road: extra.road ?? prevProps.road ?? "",
        kmFrom: extra.kmFrom ?? prevProps.kmFrom ?? null,
        kmTo: extra.kmTo ?? prevProps.kmTo ?? null,
        lengthKm: extra.lengthKm ?? prevProps.lengthKm ?? (geometry?.type === "LineString" ? lineLengthKm(geometry.coordinates) : null),
        source: prevProps.source || DEFAULT_AGENCY[resolvedKind] || "",
        personnel: prevProps.personnel || "",
        vehicles: prevProps.vehicles || "",
        observedAt: prevProps.observedAt || new Date().toISOString(),
        notes: prevProps.notes || "",
      },
    };
    stopDrawing();
    sync(); render(); selectTab("situatii"); setSheet("half");
    requestAnimationFrame(() => panel.querySelector("#ops-marker")?.scrollIntoView({ block: "start" }));
  }

  function finishDrawing() {
    if (mode === "area" && areaTarget) {
      // The picked warning is drawn open; the map stays where the operator picked.
      const target = areaTarget;
      stopDrawing(); render(); selectTab("situatii"); setSheet("half");
      panel.querySelector(`[data-warning-id="${CSS.escape(target)}"]`)?.scrollIntoView({ block: "nearest" });
      reconsiderCloud();
      return;
    }
    if (mode === "area") { stopDrawing(); render(); selectTab("situatii"); setSheet("half"); fit(); reconsiderCloud(); return; }
    if (mode === "zone") {
      if (points.length < 3) return message("Alege cel puțin trei puncte pe hartă pentru a închide conturul zonei.");
      const ring = [...points, points[0]];
      prepare({ type: "Polygon", coordinates: [ring] }, state.operations._defaultKind || "threat");
    }
  }

  /** A UAT picked in the "area" mode, for the target warning or the situation's zone; `add` never removes. */
  function pickArea(name, { add = false } = {}) {
    if (areaTarget) {
      if (!alertEditor.pickArea(areaTarget, name, { add })) {
        if (alertEditor.describe(areaTarget)) return;
        // The warning went away meanwhile (removed, or another version loaded).
        cancelDrawing();
        return message("Avertizarea aleasă nu mai există în situație. Selecția pe hartă s-a închis.");
      }
    } else if (active.areas.includes(name)) {
      if (add) return;
      active.areas = active.areas.filter(item => item !== name);
    } else active.areas = [...active.areas, name];
    changed(); sync(true); render(); drawInstructions();
  }

  // Holding Shift while the pointer crosses UATs adds each of them: one stroke instead of many clicks.
  map?.on?.("mousemove", event => {
    if (mode !== "area" || !event.originalEvent?.shiftKey || !event.lngLat) { brushed = null; return; }
    const name = uatAt(event.lngLat.lng, event.lngLat.lat)?.name;
    if (!name || name === brushed) return;
    brushed = name;
    pickArea(name, { add: true });
  });

  function availableRoads() {
    const netFeatures = roadNetworkToFeatures(state.data.roads);
    if (!map?.isStyleLoaded()) return netFeatures;
    const tileFeatures = map.querySourceFeatures("osm", { sourceLayer: "roads" });
    return [...netFeatures, ...tileFeatures];
  }

  function handleMapClick(event) {
    if (document.body.classList.contains("presenting")) return true;
    // A picked or cancelled itinerary point ends work on screen.
    if (itinerary.handleMapClick(event)) { reconsiderCloud(); return true; }
    if (!mode) {
      if (!active || pending) return false;
      const layers = ["ops-features-line", "ops-route-backup", "ops-features-point", "ops-features-fill"].filter(layer => map.getLayer(layer));
      if (!layers.length || !map.isStyleLoaded()) return false;
      const features = map.queryRenderedFeatures([[event.point.x - 8, event.point.y - 8], [event.point.x + 8, event.point.y + 8]], { layers });
      const feature = active.features.features.find(f => f.properties.id === features[0]?.properties.id);
      if (!feature) return false;
      if (isItinerary(feature)) { fitGeometry(feature.geometry); toast(feature.properties.title); return true; }
      pending = structuredClone(feature); editingId = pending.properties.id; sync(); render(); selectTab("situatii"); setSheet("half");
      requestAnimationFrame(() => panel.querySelector("#ops-marker")?.scrollIntoView({ block: "start" }));
      return true;
    }
    const coordinate = [event.lngLat.lng, event.lngLat.lat];
    if (mode === "area") {
      const uat = uatAt(...coordinate);
      if (!uat) { message("Punctul ales este în afara limitelor UAT din județ."); return true; }
      pickArea(uat.name);
    } else if (mode === "point") {
      prepare({ type: "Point", coordinates: coordinate }, state.operations._defaultKind || "command");
    } else if (mode === "place") {
      // Snap to nearest locality
      let best = null;
      for (const loc of allLocalities()) {
        const d = Math.hypot(loc.lon - coordinate[0], loc.lat - coordinate[1]);
        if (!best || d < best.d) best = { loc, d };
      }
      if (best && best.d < 0.05) {
        prepare({ type: "Point", coordinates: [best.loc.lon, best.loc.lat] }, state.operations._defaultKind || "isolated", { road: "" });
        if (pending) pending.properties.title = `${best.loc.name} · ${KINDS[pending.properties.kind]}`;
        render();
      } else {
        prepare({ type: "Point", coordinates: coordinate }, state.operations._defaultKind || "isolated");
      }
    } else if (mode === "zone") {
      points.push(coordinate); sync(); drawInstructions();
    } else if (mode === "road") {
      const available = availableRoads();
      const snapped = snapToRoad(coordinate, available, 250);
      if (!snapped) { message("Alege un punct pe un drum vizibil (DN, DJ, DC sau stradă)."); return true; }
      if (!startSnap) {
        startSnap = snapped; roadPool = available; points = [snapped.coordinate]; sync(); drawInstructions();
        message(`Început ales pe ${snapped.road.ref || snapped.road.name || "drum"}. Clic pe al doilea punct pentru capătul sectorului.`);
      } else {
        // First try exact road slicing on our continuous county road network if both snaps are on a known DN/DJ/DC
        const refName = startSnap.road.ref || snapped.road.ref || "";
        const netRoad = findRoadByRef(state.data.roads, refName);
        let geometry = null, kmFrom = null, kmTo = null, lengthKm = null;
        if (netRoad && (!snapped.road.ref || findRoadByRef(state.data.roads, snapped.road.ref)?.ref === netRoad.ref)) {
          const p1 = projectPointOnRoad(netRoad, startSnap.coordinate);
          const p2 = projectPointOnRoad(netRoad, snapped.coordinate);
          if (p1 && p2) {
            const sliced = sliceRoadByKm(netRoad, Math.min(p1.km, p2.km), Math.max(p1.km, p2.km));
            if (sliced) {
              geometry = sliced.geometry;
              kmFrom = sliced.kmFrom;
              kmTo = sliced.kmTo;
              lengthKm = sliced.lengthKm;
            }
          }
        }
        const pool = [...roadPool, ...available];
        if (!geometry) {
          geometry = buildRoadSegment(startSnap, snapped, pool);
          if (geometry) lengthKm = lineLengthKm(geometry.coordinates);
        }
        if (!geometry) {
          geometry = findRoadRoute(startSnap, snapped, pool);
          if (geometry) lengthKm = lineLengthKm(geometry.coordinates);
        }
        if (!geometry) {
          message("Nu pot uni cele două puncte pe rețeaua de drumuri. Alege puncte pe drumuri conectate sau folosește introducerea după km.");
          return true;
        }
        const r1 = startSnap.road.ref || startSnap.road.name || "";
        const r2 = snapped.road.ref || snapped.road.name || "";
        const roadTitle = (r1 && r2 && r1 !== r2) ? `${r1} ➔ ${r2}` : (r1 || r2 || "Traseu");
        prepare(geometry, state.operations._defaultKind || "blocked", {
          road: roadTitle,
          kmFrom, kmTo, lengthKm,
        });
      }
    }
    return true;
  }

  function roadsDatalistHTML() {
    const roads = roadsListOf(state.data.roads);
    const hasDj29 = roads.some(r => r.ref === "DJ29");
    const items = [
      ...(!hasDj29 ? [`<option value="DJ29">DJ29 / DN29 · Drum județean / național (79.5 km)</option>`] : []),
      ...roads.map(r => {
        const ends = r.places?.length >= 2 ? ` · ${r.places[0].name} – ${r.places.at(-1).name}` : "";
        return `<option value="${esc(r.ref)}">${esc(r.ref)} (${r.lengthKm} km${esc(ends)})</option>`;
      }),
    ];
    return `<datalist id="ops-roads-datalist">${items.join("")}</datalist>`;
  }

  function localitiesDatalistHTML() {
    const locs = allLocalities();
    return `<datalist id="ops-places-datalist">${locs.map(l => `<option value="${esc(l.name)}">${esc(l.name)}${l.ctx ? " (" + esc(l.ctx) + ")" : ""}</option>`).join("")}</datalist>`;
  }

  function uatsDatalistHTML() {
    const uats = (state.data.admin?.features || [])
      .filter(f => f.properties.kind === "uat")
      .map(f => f.properties.name)
      .sort((a, b) => a.localeCompare(b, "ro"));
    return `<datalist id="ops-uats-datalist">${uats.map(u => `<option value="${esc(u)}">UAT ${esc(u)}</option>`).join("")}</datalist>`;
  }

  function agenciesDatalistHTML() {
    const list = [
      "ISU Botoșani",
      "IPJ Botoșani",
      "IJJ Botoșani",
      "IPJ / IJJ Botoșani",
      "STPF Botoșani (Poliția de Frontieră)",
      "SAJ Botoșani",
      "SMURD Botoșani",
      "SDN Botoșani",
      "DJDP Botoșani",
      "SGA Botoșani (Apele Române)",
      "Direcția Silvică Botoșani",
      "Delgaz Grid",
      "Nova Apaserv",
      "CLSU / Primărie",
    ];
    return `<datalist id="ops-agencies-datalist">${list.map(a => `<option value="${esc(a)}"></option>`).join("")}</datalist>`;
  }

  function markerHTML() {
    if (!pending) return "";
    const p = pending.properties;
    const isRoad = !pending.geometry || pending.geometry.type === "LineString" || ROAD_KINDS.includes(p.kind);
    const isZone = pending.geometry?.type === "Polygon";
    const relevant = isRoad && (!pending.geometry || pending.geometry.type === "LineString")
      ? pickKinds(ROAD_KINDS)
      : isZone
      ? pickKinds(ZONE_KINDS)
      : Object.fromEntries(Object.entries(KINDS).filter(([kind]) => !kind.startsWith("route_")));

    const matchedRoad = isRoad && p.road ? findRoadByRef(state.data.roads, p.road) : null;
    const roadPlaces = matchedRoad?.places || [];

    return `<form id="ops-marker" class="ops-card ops-marker-form">
      <div class="ops-card-title">
        <h3>${editingId ? "Editează marcajul operativ" : isRoad ? "⛔ Sector de drum afectat / impracticabil" : isZone ? "▱ Zonă afectată / posibil inundabilă" : "📍 Marcaj operativ / Forțe în teren"}</h3>
      </div>
      <div class="ops-grid">
        <label>Categorie<select name="kind">${options(relevant, p.kind)}</select></label>
        <label>Stare operativă<select name="status">${options(STATUSES, p.status)}</select></label>
      </div>
      ${isRoad ? `
        <div class="ops-road-box">
          <label>Indicativ drum (ex. DJ29, DN29, DJ291, DJ282, DC10)
            <input name="road" list="ops-roads-datalist" maxlength="100" value="${esc(p.road)}" placeholder="Scrie numărul drumului (ex. DJ29, DN29, DJ291…)" autocomplete="off">
          </label>
          ${matchedRoad ? `<p class="ops-road-info">Drum găsit în baza de date: <b>${esc(matchedRoad.ref)}</b> · lungime în județ <b>${matchedRoad.lengthKm} km</b>${roadPlaces.length ? ` · ${roadPlaces.length} localități pe traseu` : ""}</p>` : ""}
          <div class="ops-grid">
            <label>De la km<input name="kmFrom" type="number" min="0" step="any" value="${p.kmFrom ?? ""}" placeholder="Ex. 3"></label>
            <label>Până la km<input name="kmTo" type="number" min="0" step="any" value="${p.kmTo ?? ""}" placeholder="Ex. 6"></label>
          </div>
          ${roadPlaces.length >= 2 ? `
            <div class="ops-grid">
              <label>Sau de la localitatea
                <select id="ops-road-from-place"><option value="">Alege localitatea…</option>${roadPlaces.map(pl => `<option value="${esc(pl.name)}">${esc(pl.name)} (km ${pl.km})</option>`).join("")}</select>
              </label>
              <label>Până la localitatea
                <select id="ops-road-to-place"><option value="">Alege localitatea…</option>${roadPlaces.map(pl => `<option value="${esc(pl.name)}">${esc(pl.name)} (km ${pl.km})</option>`).join("")}</select>
              </label>
            </div>` : ""}
          <div class="ops-actions">
            <button class="btn primary" type="button" data-action="trace-km">Trasează automat pe drum (km / localități)</button>
            <button class="btn" type="button" data-action="retrace-road">Alege cu 2 click-uri pe hartă</button>
          </div>
          <p class="muted">${pending.geometry ? `✓ Sector trasat pe hartă${p.lengthKm ? ` · lungime calculată: <b>${p.lengthKm} km</b>` : ""}.` : "Introdu drumul și kilometrii (ex. DJ29, km 3 – km 6) și apasă «Trasează automat pe drum» sau direct «Adaugă marcajul»."}</p>
        </div>
      ` : ""}
      <label>Denumire afișată pe hartă<input name="title" maxlength="200" value="${esc(p.title)}" placeholder="${isRoad ? "Se completează automat (ex. DJ29 · km 3–6)" : "Ex. Filtru IPJ / Echipaj ISU / Zonă inundabilă"}"></label>
      <div class="ops-grid">
        <label>Instituție / Structură<input name="source" list="ops-agencies-datalist" maxlength="300" value="${esc(p.source)}" placeholder="Ex. ISU / IPJ / IJJ / SAJ / SDN"></label>
        <label>Ora informației<input name="observedAt" type="datetime-local" value="${localTime(p.observedAt)}"></label>
      </div>
      <div class="ops-grid">
        <label>Forțe (oameni / efective)<input name="personnel" maxlength="300" value="${esc(p.personnel || "")}" placeholder="Ex. 1 ofițer, 6 subofițeri / 2 agenți IPJ"></label>
        <label>Mijloace (mașini / tehnică)<input name="vehicles" maxlength="400" value="${esc(p.vehicles || "")}" placeholder="Ex. 1 ASAS, 1 șenilată / 1 autospecială"></label>
      </div>
      <label>Detalii / Măsuri luate în teren<textarea name="notes" maxlength="5000" rows="2" placeholder="Ex. Se acționează cu autofreză SDN și filtru IPJ la intrarea pe sector">${esc(p.notes)}</textarea></label>
      <div class="ops-actions">
        <button class="btn primary" type="submit">${editingId ? "Actualizează marcajul" : "Adaugă pe hartă"}</button>
        <button class="btn" type="button" data-action="discard-mark">Renunță</button>
      </div>
    </form>`;
  }

  function conflictHTML() {
    const { conflict, unpublished } = cloudState();
    if (!active || !conflict) return "";
    return `<div class="ops-conflict" role="alert">
      <p><b>Altcineva a publicat în Cloud o versiune mai nouă a acestei situații (${esc(dateLabel(conflict.updatedAt))}).</b>
      ${unpublished || dirty
        ? "Modificările tale sunt salvate doar în acest browser. Alege ce rămâne: versiunea din Cloud le înlocuiește pe ale tale, iar publicarea ta o înlocuiește pe cea din Cloud."
        : "Ai un marcaj, un instrument sau o dată în lucru. Dacă renunți la ele, versiunea nouă se încarcă singură; dacă le păstrezi, alegi aici ce rămâne."}</p>
      <div class="ops-actions">
        <button class="btn" type="button" data-action="cloud-take">Încarcă versiunea din Cloud</button>
        <button class="btn" type="button" data-action="cloud-overwrite">Publică varianta mea peste ea</button>
      </div>
    </div>`;
  }

  // A snapshot can land while the operator types in a form, so the banner is swapped in place.
  function showConflict() {
    const old = panel.querySelector(".ops-conflict");
    const badge = panel.querySelector("#ops-save-state");
    const html = conflictHTML();
    if (old) old.outerHTML = html;
    else if (badge && html) badge.insertAdjacentHTML("afterend", html);
  }

  function archiveHTML(events) {
    return `<section class="ops-card ops-archive-bar">
      <div class="ops-card-title">
        <h3>Situații precedente (Arhivă: ${events.length})</h3>
        ${active ? `<button type="button" class="lnk" data-action="new">+ Situație nouă</button>` : ""}
      </div>
      ${archiveError ? `<p class="warnp">${esc(archiveError)}</p>` : ""}
      <select id="ops-archive" aria-label="Alege o situație precedentă din arhivă">
        <option value="">— Alege o situație precedentă (${events.length} salvate) —</option>
        ${events.map(e => {
          const roadCount = e.features.features.filter(f => f.geometry.type === "LineString" && !isItinerary(f)).length;
          const uats = e.areas?.length ? ` · ${e.areas.slice(0, 2).join(", ")}${e.areas.length > 2 ? "…" : ""}` : "";
          return `<option value="${esc(e.id)}" ${active?.id === e.id ? "selected" : ""}>${esc(e.title)} (${esc(TYPES[e.type] || e.type)}${roadCount ? `, ${roadCount} drumuri` : ""}${esc(uats)} · ${dateLabel(e.updatedAt)})</option>`;
        }).join("")}
      </select>
      <div class="ops-actions">
        <button class="btn" type="button" data-action="archive-export">Salvează baza (.json)</button>
        <label class="btn file ops-import">Încarcă .json<input id="ops-import" type="file" accept=".json,application/json" hidden></label>
        ${active && confirmDeleteId !== active.id ? `<button class="btn" type="button" data-delete-id="${esc(active.id)}" title="Șterge situația curentă din arhivă">Șterge</button>` : ""}
      </div>
      ${active && confirmDeleteId === active.id ? `<div class="ops-confirm" role="group" aria-label="Confirmă ștergerea situației">
        <p>Ștergi situația „${esc(active.title)}” din acest browser${cloudCopies.has(active.id) ? " și din Cloud" : ""}? O poți pune la loc câteva secunde după ștergere.</p>
        <div class="ops-actions">
          <button class="btn danger" type="button" data-confirm-delete="${esc(active.id)}">Da, șterge</button>
          <button class="btn" type="button" data-action="cancel-delete">Renunță</button>
        </div>
      </div>` : ""}
    </section>`;
  }

  function render() {
    const events = list();
    const roadMarks = active ? active.features.features.filter(f => f.geometry.type === "LineString" && !isItinerary(f)) : [];
    const routeMarks = active ? active.features.features.filter(isItinerary) : [];
    const otherMarks = active ? active.features.features.filter(f => f.geometry.type !== "LineString") : [];

    // The panel is rebuilt from the stored event, which still holds the last accepted interval.
    const rejectedDates = alertEditor.rejectedDates();
    panel.innerHTML = `<div class="ops">
      ${roadsDatalistHTML()}
      ${localitiesDatalistHTML()}
      ${uatsDatalistHTML()}
      ${agenciesDatalistHTML()}
      <div class="ops-top-bar" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span id="ops-cloud-pill" class="ops-cloud-pill ${cloudStatus === "connected" ? "is-connected" : ""}" title="Sincronizare în timp real prin Firebase Firestore">${cloudStatus === "connected" ? "🟢 Cloud sincronizat" : cloudStatus === "connecting" ? "🟡 Conectare Cloud…" : "⚪ Mod local"}</span>
        <p class="ops-notice" role="status" style="margin:0">${esc(notice)}</p>
      </div>

      ${!active ? `
      <section class="ops-card ops-intro">
        <h2>➕ Creează o situație nouă</h2>
        <form id="ops-new">
          <label>Denumirea situației / ședinței CJSU<input name="title" required maxlength="200" placeholder="Ex. Înzăpezire și viscol · Ședință CJSU"></label>
          <label>Tip eveniment<select name="type">${options(TYPES, "snow")}</select></label>
          <button class="btn primary" type="submit">Creează situație nouă</button>
        </form>
        <div class="ops-actions" style="margin-top:10px">
          <button class="btn" type="button" data-action="quick-road">⛔ Marchează rapid drum blocat (km / hartă)</button>
        </div>
        <p class="muted" style="margin-top:8px">Marchează drumuri impracticabile (ex. <b>DJ29 km 3 – km 6</b>), zone posibil inundabile, localități izolate și forțe în teren. Situațiile precedente se găsesc la finalul panoului.</p>
      </section>` : `
      <section class="ops-card" data-ops-card="event">
        <div class="ops-card-title">
          <h2>${esc(active.title)}</h2>
          <button type="button" class="lnk" data-action="new">Închide</button>
        </div>
        <p id="ops-save-state" class="ops-save-state">${esc(saveStateText())}</p>
        ${conflictHTML()}

        <div class="ops-actions ops-top-actions">
          <button class="btn primary" type="button" data-action="save" ${publishing ? "disabled" : ""}>${publishing ? "☁️ Se publică…" : "☁️ Publică în Cloud"}</button>
          <button class="btn primary" type="button" data-action="present">🖥️ Prezintă în ședință</button>
          <button class="btn" type="button" data-action="event-export">Salvează .json</button>
          <button class="btn" type="button" data-action="duplicate">Duplică</button>
        </div>

        <form id="ops-meta" style="margin-top:10px">
          <label>Denumire situație<input data-field="title" maxlength="200" required value="${esc(active.title)}"></label>
          <div class="ops-grid">
            <label>Tip eveniment<select data-field="type">${options(TYPES, active.type)}</select></label>
            <label>Straturi recomandate<button class="btn" type="button" data-action="preset" style="height:38px">Aplică straturi ${esc(TYPES[active.type] || "")}</button></label>
          </div>
          <label>Sinteză operativă / Dispoziții CJSU<textarea data-field="notes" rows="2" maxlength="10000" placeholder="Ex. S-a dispus închiderea temporară a sectoarelor afectate și intervenția SDN/DJDP/ISU">${esc(active.notes)}</textarea></label>
        </form>
      </section>

      ${alertEditor.html()}

      <section class="ops-card" data-ops-card="add">
        <h3>Adaugă pe hartă (Drumuri, Situații, Localități, Forțe)</h3>
        <div class="ops-tools-grid">
          <button class="btn" type="button" data-action="open-itinerary">⇢ Itinerar de bază și de rezervă</button>
          <button class="btn primary" type="button" data-action="open-road-form">⛔ Drum blocat / afectat (după km sau click)</button>
          <button class="btn" type="button" data-action="road">━ Trasează drum cu 2 click-uri pe hartă</button>
          <button class="btn" type="button" data-action="point" data-kind="stranded">🚗 Mașini blocate în zăpadă / trafic</button>
          <button class="btn" type="button" data-action="place" data-kind="houses">🏠 Case înzăpezite / gospodării afectate</button>
          <button class="btn" type="button" data-action="point" data-kind="persons">🆘 Persoane blocate / caz medical critic</button>
          <button class="btn" type="button" data-action="place" data-kind="isolated">🏘️ Localitate izolată / fără curent</button>
          <button class="btn" type="button" data-action="zone" data-kind="threat">▱ Zonă posibil inundabilă / amenințată</button>
          <button class="btn" type="button" data-action="zone" data-kind="flooded">▱ Zonă inundată / afectată</button>
          <button class="btn" type="button" data-action="zone" data-kind="fire">▱ Perimetru incendiu de amploare</button>
          <button class="btn" type="button" data-action="point" data-kind="command">⛺ Punct de Comandă Mobil (PCM)</button>
          <button class="btn" type="button" data-action="point" data-kind="isu">🚒 Echipaj / Tehnică ISU în teren</button>
          <button class="btn" type="button" data-action="point" data-kind="police">🚓 Filtru Rutier IPJ / Jandarmerie</button>
          <button class="btn" type="button" data-action="point" data-kind="utility">🚜 Utilaj Deszăpezire / Ape (SDN/DJDP/SGA)</button>
          <button class="btn" type="button" data-action="point" data-kind="medical">🚑 Punct Medical / SAJ / SMURD</button>
          <button class="btn" type="button" data-action="point" data-kind="shelter">🏫 Punct Sprijin / Adăpostire Evacuați</button>
        </div>
      </section>

      ${itinerary.html()}
      ${routeMarks.length ? `<section class="ops-card" data-ops-card="routes"><h3>Itinerare de deplasare</h3><ul class="ops-marks">${routeMarks.map(f => `<li><button class="ops-mark-main" type="button" data-zoom-mark="${esc(f.properties.id)}"><b><span class="ops-dot" data-kind="${esc(f.properties.kind)}"></span>${esc(f.properties.title)}</b><small>${esc(f.properties.source)} · ${esc(f.properties.lengthKm)} km</small></button><button class="lnk danger" type="button" data-remove="${esc(f.properties.id)}" aria-label="Elimină ${esc(KINDS[f.properties.kind])}">Elimină</button></li>`).join("")}</ul></section>` : ""}
      ${markerHTML()}

      <section class="ops-card" data-ops-card="roads">
        <h3>Drumuri blocate / afectate <span>${roadMarks.length}</span></h3>
        <ul class="ops-marks">${roadMarks.map(f => {
          const p = f.properties;
          const isRes = p.status === "resolved";
          const kmTxt = p.kmFrom != null ? `km ${p.kmFrom}${p.kmTo != null ? "–" + p.kmTo : ""}` : "";
          const lenTxt = p.lengthKm ? `${p.lengthKm} km` : "";
          const forceMeta = [p.source, p.personnel ? `Forțe: ${p.personnel}` : "", p.vehicles ? `Mijloace: ${p.vehicles}` : ""].filter(Boolean).join(" · ");
          return `<li class="${isRes ? "is-resolved" : ""}">
            <button class="ops-mark-main" type="button" data-mark="${esc(p.id)}">
              <b><span class="ops-dot" data-kind="${esc(isRes ? "resolved" : p.kind)}"></span>${esc(p.title || [p.road, kmTxt].filter(Boolean).join(" · ") || KINDS[p.kind])}</b>
              <small>${esc(KINDS[p.kind])} · <b>${esc(STATUSES[p.status])}</b>${lenTxt ? ` · ${esc(lenTxt)}` : ""}${forceMeta ? ` · ${esc(forceMeta)}` : ""} · ${dateLabel(p.observedAt)}</small>
            </button>
            <button class="ops-resolve ${isRes ? "active" : ""}" type="button" data-resolve-mark="${esc(p.id)}" title="${isRes ? "Situație rezolvată (clic pentru reactivare)" : "Marchează situația ca rezolvată / redeschisă"}">✓</button>
            <button class="ops-zoom" type="button" data-zoom-mark="${esc(p.id)}" title="Arată pe hartă">🔍</button>
            <button class="ops-remove" type="button" data-remove="${esc(p.id)}" aria-label="Elimină marcajul">×</button>
          </li>`;
        }).join("") || `<li class="muted">Niciun sector de drum marcat. Apasă «⛔ Drum blocat / afectat» pentru a marca un drum (ex. DJ29 km 3–6).</li>`}</ul>
      </section>

      <section class="ops-card" data-ops-card="marks">
        <h3>Situații, localități și forțe în teren <span>${otherMarks.length}</span></h3>
        <ul class="ops-marks">${otherMarks.map(f => {
          const p = f.properties;
          const isRes = p.status === "resolved";
          const forceMeta = [p.source, p.personnel ? `Forțe: ${p.personnel}` : "", p.vehicles ? `Mijloace: ${p.vehicles}` : ""].filter(Boolean).join(" · ");
          return `<li class="${isRes ? "is-resolved" : ""}">
            <button class="ops-mark-main" type="button" data-mark="${esc(p.id)}">
              <b><span class="ops-dot" data-kind="${esc(isRes ? "resolved" : p.kind)}"></span>${esc(p.title || KINDS[p.kind])}</b>
              <small>${esc(KINDS[p.kind])} · <b>${esc(STATUSES[p.status])}</b>${forceMeta ? ` · ${esc(forceMeta)}` : ""} · ${dateLabel(p.observedAt)}</small>
            </button>
            <button class="ops-resolve ${isRes ? "active" : ""}" type="button" data-resolve-mark="${esc(p.id)}" title="${isRes ? "Situație rezolvată (clic pentru reactivare)" : "Marchează situația ca rezolvată"}">✓</button>
            <button class="ops-zoom" type="button" data-zoom-mark="${esc(p.id)}" title="Arată pe hartă">🔍</button>
            <button class="ops-remove" type="button" data-remove="${esc(p.id)}" aria-label="Elimină marcajul">×</button>
          </li>`;
        }).join("") || `<li class="muted">Nicio zonă sau forță marcată încă.</li>`}</ul>
      </section>

      <section class="ops-card" data-ops-card="focus">
        <h3>Zona afectată / Focalizare pe hartă (UAT și Sate)</h3>
        <p class="muted">Poți focaliza harta pe una sau mai multe comune/orașe (UAT) sau sate afectate, ori pe tot județul.</p>
        <div class="ops-grid">
          <label>Adaugă comună / oraș (UAT)
            <div class="ops-inline-add">
              <input id="ops-add-uat-input" list="ops-uats-datalist" placeholder="Ex. Darabani, Vlădeni…">
              <button class="btn" type="button" data-action="add-uat-btn">+</button>
            </div>
          </label>
          <label>Adaugă sat / localitate
            <div class="ops-inline-add">
              <input id="ops-add-place-input" list="ops-places-datalist" placeholder="Ex. Huțani, Bajura…">
              <button class="btn" type="button" data-action="add-place-btn">+</button>
            </div>
          </label>
        </div>
        <div class="ops-tags">
          ${active.areas.map(name => `<button class="ops-tag" type="button" data-area="${esc(name)}" title="Elimină UAT">UAT ${esc(name)} ×</button>`).join("")}
          ${(active.places || []).map(name => `<button class="ops-tag ops-tag-place" type="button" data-place-remove="${esc(name)}" title="Elimină localitatea">Sat ${esc(name)} ×</button>`).join("")}
          ${!active.areas.length && !(active.places || []).length ? `<span class="muted">Toate UAT-urile vizibile · context județean</span>` : ""}
        </div>
        ${(active.places || []).length ? `<p class="muted">Pentru sate, evidențierea este orientativă în jurul localității. Pentru un contur administrativ exact, selectează comuna sau orașul.</p>` : ""}
        <label class="ops-check"><input type="checkbox" data-toggle="isolateArea" ${active.isolateArea ? "checked" : ""}> Izolează zona selectată (ascunde restul județului pe hartă)</label>
        <label class="ops-check"><input type="checkbox" data-toggle="tintAreas" ${active.tintAreas !== false ? "checked" : ""}> Evidențiază zona afectată în culoarea codului (tentă difuză)</label>
        ${!active.areas.length && !(active.places || []).length ? `<p class="muted" role="note">Localitățile aflate sub cod se aleg separat pentru fiecare avertizare, în cardul „Avertizări și localități sub cod”.</p>` : ""}
        <div class="ops-actions">
          <button class="btn" type="button" data-action="area">Alege UAT-uri cu click pe hartă</button>
          <button class="btn" type="button" data-action="fit">Încadrează zona</button>
          ${active.areas.length || (active.places || []).length ? `<button class="btn" type="button" data-action="clear-areas">Resetează la tot județul</button>` : ""}
        </div>
      </section>
      `}

      <section class="ops-card ops-quick-presets" data-ops-card="presets">
        <h3>Profiluri straturi pentru ședința CJSU</h3>
        <div class="ops-preset-chips">
          ${LAYER_PRESETS.map(pr => `<button type="button" class="chip" data-preset="${esc(pr.id)}" title="${esc(pr.label)}">${esc(pr.short)}</button>`).join("")}
        </div>
      </section>

      ${archiveHTML(events)}
      ${undoHTML()}
    </div>`;
    alertEditor.restoreRejectedDates(rejectedDates);
    operationCards.refresh({ markerId: pending?.properties?.id ?? null });
  }

  function tracePendingRoadFromInputs() {
    if (!pending) return false;
    const form = panel.querySelector("#ops-marker");
    if (!form) return false;
    const roadInput = form.querySelector('input[name="road"]')?.value?.trim() || "";
    const kmFromVal = form.querySelector('input[name="kmFrom"]')?.value;
    const kmToVal = form.querySelector('input[name="kmTo"]')?.value;
    const fromPlace = form.querySelector("#ops-road-from-place")?.value || "";
    const toPlace = form.querySelector("#ops-road-to-place")?.value || "";

    const roadObj = findRoadByRef(state.data.roads, roadInput);
    if (!roadObj) {
      message(`Drumul „${roadInput || "–"}” nu a fost găsit în baza de date rutieră. Alege un drum DN/DJ/DC din listă sau folosește 2 click-uri pe hartă.`);
      return false;
    }

    let sliced = null;
    if (fromPlace && toPlace) {
      sliced = sliceRoadByPlaces(roadObj, fromPlace, toPlace);
      if (!sliced) {
        message("Selectează două localități diferite aflate pe acest drum.");
        return false;
      }
      const kmFromInput = form.querySelector('input[name="kmFrom"]');
      const kmToInput = form.querySelector('input[name="kmTo"]');
      if (kmFromInput) kmFromInput.value = sliced.kmFrom;
      if (kmToInput) kmToInput.value = sliced.kmTo;
    } else if (kmFromVal !== "" && kmFromVal !== null && kmFromVal !== undefined) {
      const kf = Number(kmFromVal);
      const kt = kmToVal !== "" && kmToVal !== null && kmToVal !== undefined ? Number(kmToVal) : kf;
      if (!Number.isFinite(kf) || !Number.isFinite(kt) || kf < 0 || kt < 0) {
        message("Introdu valori numerice valide pentru kilometri (ex. de la km 3 până la km 6).");
        return false;
      }
      if (kt < kf) {
        message("Kilometrul final trebuie să fie mai mare sau egal cu kilometrul de început.");
        return false;
      }
      sliced = sliceRoadByKm(roadObj, kf, kt);
    } else {
      // If user didn't enter km or places, trace the entire road in county
      sliced = sliceRoadByKm(roadObj, 0, roadObj.lengthKm);
    }

    if (!sliced?.geometry) {
      message("Sectorul nu a putut fi calculat pe acest drum.");
      return false;
    }

    pending.geometry = sliced.geometry;
    pending.properties.road = roadInput.toUpperCase().replace(/\s+/g, "");
    pending.properties.kmFrom = sliced.kmFrom;
    pending.properties.kmTo = sliced.kmTo;
    pending.properties.lengthKm = sliced.lengthKm;
    const titleInput = form.querySelector('input[name="title"]');
    if (titleInput && !titleInput.value.trim()) {
      const placeSuffix = sliced.fromPlace && sliced.toPlace ? ` · ${sliced.fromPlace} – ${sliced.toPlace}` : "";
      titleInput.value = `${pending.properties.road} · km ${sliced.kmFrom}–${sliced.kmTo} (${sliced.lengthKm} km)${placeSuffix}`;
      pending.properties.title = titleInput.value;
    }
    sync();
    fitGeometry(pending.geometry);
    message(`Sector trasat pe ${pending.properties.road}: km ${sliced.kmFrom} – km ${sliced.kmTo} (${sliced.lengthKm} km).`);
    return true;
  }

  // The editor keeps a rejected warning date on screen while the old interval stays stored, so
  // keeping the event now (save, export, resolve, add or remove a marker) or replacing it would
  // drop what the operator typed behind a success message. Every such action asks this first.
  function intervalRejected(refusal) {
    if (!alertEditor.revealRejectedInterval()) return false;
    message(`${refusal} Un interval de valabilitate este invalid: corectează data marcată în avertizare.`);
    return true;
  }

  // Firestore answers a write only once the server has it; offline the write just queues and
  // goes out when the network returns. Past this wait the operator hears it is still pending.
  const PUBLISH_WAIT_MS = ctx.publishWaitMs ?? 10000;

  // Resolves to "ok", "failed" or "waiting". A write that answers after the wait reports its
  // final "ok" or "failed" through `onLate`.
  function cloudWrite(run, onLate = () => {}, onSettle = () => {}) {
    const write = Promise.resolve().then(run)
      .then(ok => ok ? "ok" : "failed", error => { console.warn(error); return "failed"; });
    write.then(onSettle);
    let timer;
    const wait = new Promise(resolve => { timer = setTimeout(() => resolve("waiting"), PUBLISH_WAIT_MS); });
    return Promise.race([write, wait]).then(result => {
      clearTimeout(timer);
      // A queued write can still be refused, so the late answer is passed on either way.
      if (result === "waiting") write.then(onLate);
      return result;
    });
  }

  function publishToCloud(event, onLate) {
    cloudStates.markSent(event.id, event.updatedAt);
    inFlight.add(event.id);
    const copy = structuredClone(event);
    return cloudWrite(() => cloudDb.saveSituation(copy), onLate, () => inFlight.delete(event.id));
  }

  // Removing is immediate and stays undoable for a while, so markers need no dialog; only a
  // whole situation, which also leaves the Cloud, is confirmed first.
  const UNDO_MS = 15000;
  function offerUndo(text, restore) {
    clearTimeout(undo?.timer);
    undo = { text, restore, timer: setTimeout(dropUndo, UNDO_MS) };
    const old = panel.querySelector(".ops-undo");
    if (old) old.outerHTML = undoHTML();
    else panel.querySelector(".ops")?.insertAdjacentHTML("beforeend", undoHTML());
  }

  // A marker's way back belongs to the version it was removed from; a deleted situation's does not.
  function dropMarkerUndo() { if (undo?.eventId) dropUndo(); }

  function dropUndo() {
    clearTimeout(undo?.timer);
    undo = null;
    panel.querySelector(".ops-undo")?.remove();
  }

  function undoHTML() {
    return undo ? `<div class="ops-undo" role="status"><span>${esc(undo.text)}</span><button class="btn" type="button" data-action="undo">Anulează</button></div>` : "";
  }

  async function deleteSituation(id) {
    const wasOpen = active?.id === id;
    // A situation just created or duplicated may not have reached the archive yet.
    const local = db.load(id) ?? (wasOpen ? structuredClone(active) : null);
    if (!local) { confirmDeleteId = null; return render(); }
    if (wasOpen && (pending || mode || itinerary.isPicking())) return message("Finalizează sau anulează marcajul în curs înainte de a șterge situația.");
    if (wasOpen && intervalRejected("Situația nu a fost ștearsă.")) return;
    confirmDeleteId = null;
    const cloudCopy = cloudCopies.get(id) ?? null, known = cloudStates.get(id);
    const deletion = { undone: false };
    db.remove(id); cloudStates.remove(id);
    if (wasOpen) closeActive();
    render();
    offerUndo(`Situația „${local.title}” a fost ștearsă.`, () => {
      const restored = restoreSituation(local, cloudCopy, known, wasOpen);
      if (restored !== false) deletion.undone = true;
      return restored;
    });
    if (!cloudCopy || !cloudDb?.deleteSituation) return toast("Situația a fost ștearsă din acest browser.");
    const result = await cloudWrite(() => cloudDb.deleteSituation(id));
    // Undone meanwhile: the answer about the deletion no longer describes what is on screen.
    if (deletion.undone) return;
    if (result === "ok") toast("Situația a fost ștearsă și din Cloud.");
    else if (result === "waiting") message("Situația a fost ștearsă din acest browser; ștergerea din Cloud se trimite când revine conexiunea.");
    else message("Situația a fost ștearsă din acest browser, dar nu și din Cloud, așa că va reapărea la următoarea sincronizare.");
  }

  // Puts back the local copy at once, and the Cloud copy as it was before the deletion. That
  // copy may be a colleague's version the operator had not chosen yet, so it is written back
  // as theirs, not marked as our own publish, and the held conflict comes back with it.
  function restoreSituation(local, cloudCopy, known, wasOpen) {
    if (wasOpen && !canReplaceDraft()) return false;
    try { db.put(local); }
    catch (error) { console.warn(error); message("Situația nu a putut fi pusă la loc în acest browser."); return false; }
    // Someone may have published it again meanwhile: that version stands and is weighed as usual.
    const now = cloudCopies.get(local.id);
    const republished = Boolean(now && cloudCopy && now.updatedAt !== cloudCopy.updatedAt);
    const rewrite = Boolean(cloudCopy && cloudDb?.saveSituation && !republished);
    // Until the Cloud copy is back, the situation is not in the Cloud.
    const state = { ...(known ?? NO_CLOUD_STATE), ...(rewrite ? { unpublished: true } : {}) };
    if (wasOpen) {
      setActive(local, { cloud: state });
      persistSession(); refreshPublishState();
    } else { cloudStates.update(local.id, state); render(); }
    toast(`Situația „${local.title}” a fost pusă la loc.`);
    if (republished && lastSnapshot) syncFromCloud(...lastSnapshot);
    if (!rewrite) return true;
    const copy = structuredClone(cloudCopy);
    const landed = () => {
      // Back as before the deletion, unless it was edited or deleted again meanwhile.
      const open = active?.id === local.id;
      if (!cloudStates.get(local.id) || (open ? active : db.load(local.id))?.updatedAt !== local.updatedAt) return;
      cloudStates.update(local.id, { unpublished: Boolean(known?.unpublished) });
      if (open) { persistSession(); refreshPublishState(); }
    };
    cloudWrite(() => cloudDb.saveSituation(copy), late => late === "ok" ? landed()
      : message("Situația e pusă la loc în acest browser, dar nu și în Cloud: apasă „Publică în Cloud”.")).then(result => {
      if (result === "ok") return landed();
      if (result === "failed") message("Situația e pusă la loc în acest browser, dar nu și în Cloud: apasă „Publică în Cloud”.");
    });
    return true;
  }

  // Our version is in the Cloud: it becomes the base, and stays unpublished only if the
  // operator kept editing while the write was on its way. `from` is the base it was sent from:
  // a local copy that moved to a colleague's version meanwhile is not described by this answer,
  // while one moved only by our own earlier publish still is.
  function markPublished(version, { from = null, overwritten = null } = {}) {
    const open = active?.id === version.id;
    const known = cloudStates.get(version.id) ?? (open ? NO_CLOUD_STATE : null);
    if (!known) return;
    if (known.base !== from && known.base !== version.updatedAt && !known.sent.includes(known.base)) return;
    // The archive copy, which another tab may have edited since: only that copy's version is published.
    let local = open ? active : null;
    try { local = db.load(version.id) ?? local; } catch { /* unreadable archive: weigh the screen */ }
    if (open) screenBase = version.updatedAt;
    cloudStates.update(version.id, {
      base: version.updatedAt,
      ...(local?.updatedAt === version.updatedAt ? { unpublished: false } : {}),
      // Only the version this publish replaced; one that came later still needs a choice.
      ...(known.conflict?.updatedAt === overwritten?.updatedAt ? { conflict: null } : {}),
    });
    if (open) persistSession();
  }

  async function save({ overwrite = false } = {}) {
    if (publishing) return;
    try {
      if (pending || mode) return message("Finalizează adăugarea marcajului curent înainte de a publica situația.");
      if (intervalRejected("Situația nu a fost publicată.")) return;
      if (!overwrite) { holdMovedArchive(); holdNewerRemote(); }
      if (cloudState().conflict && !overwrite) return message("Altcineva a publicat între timp o versiune mai nouă. Alege în caseta de sus dacă o încarci sau o înlocuiești cu varianta ta.");
      active = saveActive(); dirty = false; exported = false;
      // A new version: it is not in the Cloud until the server says so.
      setCloudState({ unpublished: true });
      persistSession();
    } catch (error) {
      console.warn(error);
      return message("Salvarea nu a reușit. Verifică denumirea situației și intervalele avertizărilor; poți salva direct în fișier JSON.");
    }
    if (!cloudDb?.saveSituation) {
      notice = "Situația e salvată în acest browser. Cloud-ul nu e disponibil, deci celelalte ecrane nu o primesc.";
      refreshPublishState(); toast(notice); return;
    }
    const version = { id: active.id, updatedAt: active.updatedAt }, title = active.title;
    const from = cloudState().base, overwritten = overwrite ? cloudState().conflict : null;
    publishing = true; notice = "Se publică în Cloud…"; refreshPublishState();
    const result = await publishToCloud(active, late => {
      if (late !== "ok") {
        if (active?.id !== version.id) return toast(`Situația „${title}” nu a ajuns în Cloud.`);
        notice = "Cloud-ul a refuzat publicarea: situația e salvată doar în acest browser. Apasă din nou „Publică în Cloud”.";
        refreshPublishState(); return toast(notice);
      }
      markPublished(version, { from, overwritten });
      if (active?.id !== version.id) return toast(`Situația „${title}” a ajuns în Cloud.`);
      notice = "Publicarea s-a încheiat: situația a ajuns în Cloud."; refreshPublishState(); toast(notice);
      reconsiderCloud();
    });
    publishing = false;
    // The situation it belongs to is published even if another one is open by now.
    if (result === "ok") markPublished(version, { from, overwritten });
    // Another situation may be open by now: its panel must not carry this answer.
    if (active?.id !== version.id) {
      notice = "";
      refreshPublishState();
      return toast(result === "ok" ? `Situația „${title}” a fost publicată în Cloud.`
        : result === "waiting" ? `Publicarea situației „${title}” așteaptă conexiunea.`
        : `Situația „${title}” nu a ajuns în Cloud. Deschide-o și apasă din nou „Publică în Cloud”.`);
    }
    if (result === "ok") {
      notice = `Situația a fost publicată în Cloud (${dateLabel(version.updatedAt)}). Celelalte ecrane o primesc acum.`;
    } else if (result === "waiting") {
      notice = "Cloud-ul nu a confirmat încă publicarea. Situația e salvată în acest browser, iar publicarea se încheie singură când revine conexiunea.";
    } else {
      notice = "Situația e salvată doar în acest browser: nu a ajuns în Cloud. Verifică conexiunea și apasă din nou „Publică în Cloud”.";
    }
    refreshPublishState(); toast(notice);
    // A colleague's version that came after ours loads now that nothing here is unpublished.
    if (result === "ok") reconsiderCloud();
  }

  // The publish answer can land while the operator types, so only its own lines change.
  function refreshPublishState() {
    const button = panel.querySelector('[data-action="save"]');
    if (button) { button.disabled = publishing; button.textContent = publishing ? "☁️ Se publică…" : "☁️ Publică în Cloud"; }
    refreshSaveState();
    const note = panel.querySelector(".ops-notice");
    if (note) note.textContent = notice;
    showConflict();
  }

  function toggleResolveFeature(featureId) {
    if (!active) return;
    if (pending) return message("Finalizează sau anulează editarea marcajului curent înainte de a schimba starea.");
    if (intervalRejected("Starea situației nu a fost schimbată.")) return;
    const feat = active.features.features.find(f => f.properties.id === featureId);
    if (!feat) return;
    const wasResolved = feat.properties.status === "resolved";
    feat.properties.status = wasResolved ? "confirmed" : "resolved";
    feat.properties.observedAt = new Date().toISOString();
    try {
      active = saveActive(); dirty = false; setCloudState({ unpublished: true });
    } catch { changed(); }
    sync();
    render();
    if (document.body.classList.contains("presenting")) renderPresentationOverlay();
    toast(wasResolved
      ? `Situația „${feat.properties.title || KINDS[feat.properties.kind]}” a fost reactivată.`
      : `Situația „${feat.properties.title || KINDS[feat.properties.kind]}” a fost marcată ca REZOLVATĂ.`);
    // Resolving has always gone straight to every screen, but never over a colleague's newer version.
    if (!dirty) holdNewerRemote();
    if (dirty || cloudState().conflict || !cloudDb?.saveSituation) return;
    const version = { id: active.id, updatedAt: active.updatedAt }, from = cloudState().base;
    const done = () => { markPublished(version, { from }); refreshPublishState(); };
    publishToCloud(active, late => late === "ok" && done()).then(result => {
      if (result === "ok") done();
      else if (result === "failed" && active?.id === version.id) message("Starea marcajului e salvată în acest browser, dar nu a ajuns în Cloud. Apasă „Publică în Cloud” când revine conexiunea.");
    });
  }

  function syncFromCloud(cloudEvents = [], { pending: pendingIds } = {}) {
    if (!Array.isArray(cloudEvents)) return;
    lastSnapshot = [cloudEvents, { pending: pendingIds }];
    cloudPending = pendingIds instanceof Set ? pendingIds : new Set();
    // One malformed document must not stop the sync for every screen: each is checked on its
    // own, and a repeated id keeps its newest version.
    cloudCopies.clear();
    for (const raw of cloudEvents) {
      try {
        const event = sanitizeEvent(raw);
        if (!(cloudCopies.get(event.id)?.updatedAt >= event.updatedAt)) cloudCopies.set(event.id, event);
      } catch (e) { console.warn(`Situația „${raw?.id ?? "fără id"}” din Cloud nu e validă și a fost ignorată:`, e); }
    }
    cloudSeen = true;
    const kept = syncLeftSituations();
    const remote = active ? cloudCopies.get(active.id) : null;
    // Our own write still on its way says nothing about what the server holds.
    const settled = Boolean(remote && !cloudPending.has(remote.id));
    // Another tab of this browser may have saved the situation since this screen loaded it.
    const local = archived();
    if (settled && remote.updatedAt === local.updatedAt && !dirty && (!cloudState().base || cloudState().unpublished)) {
      // The server holds this exact version: our publish landed, even one queued before a reload
      // or sent from another tab.
      setCloudState({ base: remote.updatedAt, unpublished: false });
      persistSession(); refreshSaveState();
    }
    const { unpublished, conflict, base, sent } = cloudState();
    const newer = Boolean(newerRemote(local));
    // The archive holds edits this screen does not show and the Cloud does not have: another tab
    // saved them, even if its state could not be stored. A Cloud version stored there is no work.
    const elsewhere = Boolean(active && local.updatedAt !== active.updatedAt && local.updatedAt !== remote?.updatedAt
      && local.updatedAt !== base && !sent.includes(local.updatedAt));
    // Work that is not in the Cloud yet, or still on screen only, is never replaced silently.
    const held = newer && (unpublished || dirty || busy() || elsewhere);
    // The local copy of unpublished work stays as it is, whatever the timestamps say.
    const keepLocal = active && (held || unpublished || dirty || elsewhere);
    const incoming = [...cloudCopies.values()].filter(event => !kept.has(event.id) && !(keepLocal && event.id === active.id));
    try {
      if (incoming.length) db.importArchive({ format: "harta-botosani-events", version: 1, events: incoming });
    } catch (e) {
      console.warn("Nu s-au putut sincroniza evenimentele din cloud:", e);
    }
    if (held) {
      const fresh = conflict?.updatedAt !== remote.updatedAt;
      setCloudState({ conflict: remote });
      showConflict();
      refreshArchive();
      if (fresh) toast(`Altcineva a publicat o versiune nouă a situației „${remote.title}”. Modificările tale nu au fost înlocuite.`);
      return;
    }
    if (newer) {
      // Stored exactly, so an older timestamp from another computer is not undone by a reload.
      try { active = db.put(remote); } catch (e) { console.warn(e); active = structuredClone(remote); }
      normalizeEventFeatures(active);
      setCloudState({ base: remote.updatedAt, unpublished: false, conflict: null });
      dropMarkerUndo();
      persistSession();
      // Isolation, tint and warning areas are baked into the style, so rebuild it.
      sync(true);
      render();
      if (document.body.classList.contains("presenting")) renderPresentationOverlay();
      toast(`Situația „${active.title}” a fost actualizată în direct din Cloud.`);
      return;
    }
    // Gone from the Cloud, back to our base, or our own version: nothing left to choose.
    if (conflict && (!remote || settled)) { setCloudState({ conflict: null }); showConflict(); }
    refreshArchive();
  }

  // Situations not on screen keep their own Cloud state: a snapshot never replaces their
  // unpublished work, and a colleague's version waits for them as a conflict. A clean one
  // follows the Cloud by its base, stored exactly. Returns the ids the archive must not import.
  function syncLeftSituations() {
    const kept = new Set();
    let here;
    try { here = new Map(db.list().map(event => [event.id, event])); } catch { return kept; }
    for (const [id, known] of cloudStates.entries()) {
      const local = here.get(id);
      if (id === active?.id || !local) continue;
      kept.add(id);
      const remote = cloudCopies.get(id);
      const settled = Boolean(remote && !cloudPending.has(id));
      // Another tab's snapshot may be older than the one a holding screen acted on, so a held
      // version is set here but cleared only by a screen showing the situation.
      if (settled && remote.updatedAt === local.updatedAt && (known.unpublished || remote.updatedAt !== known.base)) {
        // Its local copy is in the Cloud: a publish that landed after the situation was left.
        cloudStates.update(id, { base: remote.updatedAt, unpublished: false, conflict: null });
      } else if (known.unpublished || (known.base && local.updatedAt !== known.base)) {
        // Unpublished work, or a copy changed here outside a publish (an imported file, the seed).
        if (!known.unpublished) cloudStates.update(id, { unpublished: true });
        if (settled && !known.conflict && !known.sent.includes(remote.updatedAt) && remote.updatedAt !== known.base) cloudStates.update(id, { conflict: remote });
      } else if (!known.base) {
        // Nothing known about its Cloud copy yet: the archive merges by timestamp, as before.
        kept.delete(id);
      } else if (known.conflict) {
        // A screen in another tab holds a colleague's version back: it waits for that screen.
      } else if (settled && remote.updatedAt !== known.base) {
        try { db.put(remote); cloudStates.update(id, { base: remote.updatedAt, conflict: null }); }
        catch (e) { console.warn(e); kept.delete(id); }
      }
    }
    return kept;
  }

  // Open forms, drawing tools, a picked itinerary point or a rejected date: work on screen only.
  function busy() {
    return Boolean(pending || mode || itinerary.isPicking() || alertEditor.rejectedDates().length);
  }

  // The archive copy of the open situation, which another tab may have saved since.
  function archived() {
    try { return (active && db.load(active.id)) || active; } catch { return active; /* unreadable archive: weigh the screen */ }
  }

  // A settled Cloud version this screen did not start from and this browser did not send. Clocks
  // differ between computers, so with a known base any other version counts, not only a later
  // timestamp. One that another tab already stored here counts as well.
  function newerRemote(local = archived()) {
    const remote = active ? cloudCopies.get(active.id) : null;
    if (!remote || cloudPending.has(remote.id) || remote.updatedAt === active.updatedAt) return null;
    if (remote.updatedAt === local?.updatedAt) return remote;
    if (cloudState().sent.includes(remote.updatedAt)) return null;
    return (screenBase ? remote.updatedAt !== screenBase : remote.updatedAt > active.updatedAt) ? remote : null;
  }

  // A version held back only by work on screen applies once that work is dropped, and so does
  // one another tab stored meanwhile. The last snapshot may predate our own publish, so without a
  // held version only an archive moved under the screen is replayed.
  function reconsiderCloud() {
    const { conflict, unpublished } = cloudState();
    if (!lastSnapshot || unpublished || dirty || busy()) return;
    const local = archived();
    if (conflict || (local?.updatedAt !== active?.updatedAt && newerRemote(local))) syncFromCloud(...lastSnapshot);
  }

  // Only the archive list follows other situations: rebuilding the panel would wipe what the
  // operator is typing. A list in use waits for the next snapshot.
  function refreshArchive() {
    const bar = panel.querySelector(".ops-archive-bar");
    if (!bar) return render();
    if (bar.contains(document.activeElement)) return;
    bar.outerHTML = archiveHTML(list());
  }

  // `cloud` opens this very version with the given Cloud state: a version taken from the Cloud,
  // or a deleted situation put back.
  function setActive(event, { cloud: given = null } = {}) {
    const copy = cloudCopies.get(event.id), known = given ?? cloudStates.get(event.id);
    // The kept state stays as it was left when it describes this copy: unpublished work, or the
    // base it equals. Otherwise (a first visit, an imported file) it is worked out anew.
    const tracked = Boolean(known && (given || known.unpublished || known.base === event.updatedAt));
    // The Cloud copy wins when the archive here lags behind it, and is stored so the two agree.
    const lagging = !tracked && copy && copy.updatedAt > event.updatedAt;
    if (lagging) { try { db.put(copy); } catch (e) { console.warn(e); } }
    active = structuredClone(lagging ? copy : event);
    active.places = active.places || [];
    active.isolateArea = active.isolateArea ?? false;
    active.tintAreas = active.tintAreas ?? true;
    pending = null; editingId = null; dirty = false; exported = false; notice = ""; confirmDeleteId = null; viewFocus = null;
    if (given) setCloudState(given);
    else if (!tracked) {
      // Without a Cloud copy the situation lives only here, once the Cloud has answered at all;
      // a copy that is still our unconfirmed write is not in the Cloud yet, and is no base.
      const confirmed = copy && !cloudPending.has(copy.id) ? copy : null;
      setCloudState({ base: confirmed?.updatedAt ?? null, conflict: null,
        unpublished: copy ? active.updatedAt > copy.updatedAt || !confirmed : cloudSeen });
    } else {
      screenBase = known.base;
      // Unpublished work weighs the held version against this tab's latest snapshot: one held
      // while the situation was away may be superseded, or gone with the Cloud back at the base.
      if (known.unpublished && copy && !cloudPending.has(copy.id)) {
        const rival = copy.updatedAt !== known.base && !known.sent.includes(copy.updatedAt) ? copy : null;
        if (rival?.updatedAt !== known.conflict?.updatedAt) setCloudState({ conflict: rival });
      }
    }
    dropMarkerUndo();
    stopDrawing();
    for (const key of Object.keys(state.visible)) if (typeof active.visible[key] === "boolean") state.visible[key] = active.visible[key];
    try { storage?.setItem("hb.visible.v2", JSON.stringify(state.visible)); } catch { /* */ }
    sync(true); renderLayerPanel(); render();
    if (active.view && map) map.jumpTo(active.view); else fit();
    selectTab("situatii");
    // A version held back only by work on screen applies now that the screen starts afresh.
    reconsiderCloud();
  }

  function closeActive() {
    active = null; pending = null; editingId = null; confirmDeleteId = null; viewFocus = null; screenBase = null;
    dropMarkerUndo();
    stopDrawing(); sync(true);
  }

  function canReplaceDraft() {
    if (pending || mode || itinerary.isPicking()) {
      message("Finalizează sau anulează marcajul în curs înainte de a schimba situația.");
      return false;
    }
    if (active && intervalRejected("Situația curentă a rămas deschisă.")) return false;
    if (active && dirty) autoSaveActiveToDb();
    return true;
  }

  function exitPresentation() {
    if (!document.body.classList.contains("presenting")) return;
    document.body.classList.remove("presenting"); presentation.hidden = true;
    state.operations.presenting = false;
    if (previousOverlays) { state.overlays = previousOverlays; previousOverlays = null; }
    sync(true); map?.resize(); if (beforePresentation && map) map.jumpTo(beforePresentation);
    renderFocusBar();
    selectTab("situatii");
    panel.querySelector('[data-action="present"]')?.focus({ preventScroll: true });
  }

  function presentationPadding() {
    const container = map.getContainer();
    const bounds = container.getBoundingClientRect();
    const width = bounds.width || container.clientWidth || window.innerWidth;
    const height = bounds.height || container.clientHeight || window.innerHeight;
    const padding = { top: 64, bottom: 64, left: 16, right: 16 };
    for (const panel of presentation.querySelectorAll("[data-pres-panel]")) {
      if (panel.hidden) continue;
      const rect = panel.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      let edge = panel.dataset.presEdge;
      if (compactPresentation) edge = ["messages", "summary"].includes(panel.dataset.presPanel) ? "top" : "bottom";
      if (edge === "top") padding.top = Math.max(padding.top, rect.bottom - bounds.top + 12);
      if (edge === "bottom") padding.bottom = Math.max(padding.bottom, bounds.bottom - rect.top + 12);
      if (edge === "left") padding.left = Math.max(padding.left, rect.right - bounds.left + 12);
      if (edge === "right") padding.right = Math.max(padding.right, bounds.right - rect.left + 12);
    }
    // Always leave a useful map rectangle, even on a very small landscape screen.
    for (const [a, b, size] of [["left", "right", width], ["top", "bottom", height]]) {
      const available = Math.max(0, size - Math.min(120, size * 0.45));
      const total = padding[a] + padding[b];
      if (total > available) { padding[a] *= available / total; padding[b] *= available / total; }
    }
    return padding;
  }

  function renderPresentationOverlay() {
    if (!active) return;
    // Panels, warning banners and the description all scroll on their own; the rebuild below recreates them, so
    // scroll positions and focus are kept by key. A banner's id is its rank (ops-pres-alert, ops-pres-alert-1, ...), which
    // changes when a warning is added, removed or re-ranked, so banners are keyed by their warning instead.
    const presKey = el => el.dataset.presKey || el.id;
    const focused = presentation.contains(document.activeElement) ? { id: presKey(document.activeElement), data: { ...document.activeElement.dataset } } : null;
    const scrollPositions = new Map([...presentation.querySelectorAll("[id]")].filter(el => el.scrollTop).map(el => [presKey(el), el.scrollTop]));
    presentation.dataset.compact = String(compactPresentation);
    presentation.dataset.commandsOpen = String(!commandsCollapsed);
    const panelToggle = (name, label, collapsed, arrow) => `<button class="ops-pres-toggle ops-pres-toggle-${name}" type="button" data-action="pres-toggle-${name}" aria-expanded="${!collapsed}" aria-controls="ops-pres-${name}" aria-label="${collapsed ? "Arată" : "Ascunde"} ${label.toLowerCase()}" title="${collapsed ? "Arată" : "Ascunde"} ${label.toLowerCase()}"><span aria-hidden="true">${arrow}</span><span class="ops-toggle-label">${label}</span></button>`;

    const allFeats = presentationFeatures(active.features.features || [], active.type);
    const nonForceFeats = allFeats.filter(f => !FORCE_KINDS.includes(f.properties.kind) && !isItinerary(f));
    const activeIncidentCount = nonForceFeats.filter(f => f.properties.status !== "resolved").length;
    const resolvedIncidentCount = nonForceFeats.filter(f => f.properties.status === "resolved").length;

    const counts = {};
    allFeats.forEach(f => {
      if (f.properties.status === "resolved") {
        if (!hideResolvedInPresentation) counts.resolved = (counts.resolved || 0) + 1;
      } else {
        counts[f.properties.kind] = (counts[f.properties.kind] || 0) + 1;
      }
    });

    const forcesList = allFeats.filter(f => FORCE_KINDS.includes(f.properties.kind) && f.properties.status !== "resolved");
    const resolvedList = allFeats.filter(f => f.properties.status === "resolved");
    const groupToggle = (key, label, count) => `<button type="button" class="ops-risk-toggle" data-pres-group="${key}" aria-expanded="${!presentationCollapsedGroups.has(key)}" aria-controls="ops-risk-${key}"><span>${esc(label)} (${count})</span><span aria-hidden="true">${presentationCollapsedGroups.has(key) ? "▸" : "▾"}</span></button>`;
    const itemHTML = f => {
      const p = f.properties, resolved = p.status === "resolved";
      const len = p.lengthKm || (f.geometry.type === "LineString" ? lineLengthKm(f.geometry.coordinates) : null);
      return `<li class="${resolved ? "is-resolved" : ""}"><button type="button" class="ops-mon-item-zoom" data-pres-zoom="${esc(p.id)}"><b>${esc(p.title || p.road || presentationKindLabel(p.kind, active.type, KINDS[p.kind]))}</b><small>${resolved ? "✓ REZOLVAT" : esc(STATUSES[p.status])}${len ? ` · ${Number(len).toFixed(1)} km` : ""}${p.notes ? ` — ${esc(p.notes)}` : ""}</small></button><button type="button" class="ops-mon-item-res ${resolved ? "active" : ""}" data-pres-resolve="${esc(p.id)}" title="${resolved ? "Reactivează situația" : "Marchează ca rezolvat"}">${resolved ? "↺" : "✓"}</button></li>`;
    };

    const areaText = [
      ...(active.areas.length ? [`UAT: ${active.areas.join(", ")}`] : []),
      ...((active.places || []).length ? [`Localități: ${active.places.join(", ")}`] : []),
    ].join(" · ") || "Județul Botoșani";
    const hasNotes = Boolean(active.notes && String(active.notes).trim());
    // Most severe first. A village is listed only when its own UAT is not already under the same warning.
    const warnings = normalizeAlerts(active).sort((a, b) => (ALERT_RANK[b.code] || 0) - (ALERT_RANK[a.code] || 0)).map(warning => {
      const areas = new Set(warning.areas);
      const villages = warning.places.map(entry => {
        const place = resolvePlace(entry, allLocalities());
        return !place ? placeLabel(entry) : areas.has(place.uat) ? null : placeLabel(placeKey(place));
      }).filter(Boolean);
      return { ...warning, villages: [...new Set(villages)].filter(name => !areas.has(name)) };
    });
    const shortTime = value => {
      const time = Date.parse(value);
      return Number.isFinite(time) ? new Intl.DateTimeFormat("ro-RO", { timeZone: "Europe/Bucharest", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(time) : "";
    };
    // "de la …" / "până la …" when only one end of the validity is known.
    const span = (from, to, format) => from && to ? `${format(from)} – ${format(to)}` : from ? `de la ${format(from)}` : to ? `până la ${format(to)}` : "";
    // A code-less message from an older archive still shows, on a neutral banner.
    const note = warnings.length ? null : legacyNote(active);
    const scope = warning => [warning.areas.length ? `${warning.areas.length} UAT` : "", warning.villages.length ? countLabel(warning.villages.length, "sat", "sate") : ""].filter(Boolean).join(", ") || "fără localități";

    presentation.innerHTML = `
      ${panelToggle("messages", "Mesaje", messagesCollapsed, messagesCollapsed ? "▼" : "▲")}
      ${panelToggle("summary", "Monitorizare", summaryCollapsed, summaryCollapsed ? "▶" : "◀")}
      ${panelToggle("legend", "Legendă", legendCollapsed, legendCollapsed ? "▲" : "▼")}
      ${panelToggle("commands", "Comenzi", commandsCollapsed, commandsCollapsed ? "▲" : "▼")}
      <button class="ops-pres-exit" type="button" data-action="exit" aria-label="Ieși din prezentare" title="Ieși din prezentare"><span aria-hidden="true">✕</span></button>
      <header id="ops-pres-messages" class="ops-slide-head" data-pres-panel="messages" data-pres-edge="top" ${messagesCollapsed ? "hidden" : ""} aria-label="Mesaje și avertizări">
        <div class="ops-slide-title">
          <span class="ops-slide-eyebrow">ȘEDINȚĂ CJSU · ${esc(TYPES[active.type] || active.type)} · ${esc(areaText)}</span>
          <h1>${esc(active.title)}</h1>
        </div>
        ${hasNotes ? `<div id="ops-pres-message-text" tabindex="0" aria-label="Descriere"><p class="ops-slide-notes">${esc(active.notes)}</p></div>` : ""}
        ${warnings.length ? `<div class="ops-alert-grid">${warnings.map((warning, index) => `<p id="ops-pres-alert${index ? '-' + index : ''}" class="ops-alert" data-code="${esc(warning.code)}" data-pres-key="alert:${esc(warning.id)}" tabindex="0" role="note"><b class="ops-alert-code">${esc(ALERT_LABELS[warning.code] || warning.code)}</b><span class="ops-alert-when">${[warning.source, span(warning.validFrom, warning.validTo, dateLabel) || "Interval nespecificat"].filter(Boolean).map(esc).join(" · ")}</span>${warning.text ? `<span class="ops-alert-text">${esc(warning.text)}</span>` : ""}<span class="ops-alert-areas">${esc([...warning.areas, ...warning.villages].join(", ") || "Fără localități selectate")}</span></p>`).join("")}</div>` : note ? `<div class="ops-alert-grid"><p id="ops-pres-alert" class="ops-alert" data-code="" tabindex="0" role="note"><b class="ops-alert-code">Mesaj</b><span class="ops-alert-when">${[note.source, span(note.validFrom, note.validTo, dateLabel)].filter(Boolean).map(esc).join(" · ")}</span>${note.text ? `<span class="ops-alert-text">${esc(note.text)}</span>` : ""}</p></div>` : ""}

      </header>
      <nav id="ops-pres-commands" class="ops-slide-controls" data-pres-panel="commands" data-pres-edge="right" ${commandsCollapsed ? "hidden" : ""} aria-label="Comenzi prezentare">
        <button class="btn" type="button" data-action="pres-toggle-resolved" aria-pressed="${!hideResolvedInPresentation}" title="Arată sau ascunde pe hartă situațiile rezolvate; lista lor rămâne disponibilă în Monitorizare">${hideResolvedInPresentation ? `Arată rezolvate pe hartă (${resolvedList.length})` : `Ascunde rezolvate de pe hartă (${resolvedList.length})`}</button>
        <button class="btn" type="button" data-action="pres-fit">Încadrează</button>
        <button class="btn" type="button" data-action="pres-isolate">${active.isolateArea ? "Arată tot județul" : "Izolează zona"}</button>
        <button class="btn" type="button" data-action="pres-sat">${state.basemap === "satelit" ? "Hartă" : "Satelit"}</button>
        <button class="btn" type="button" data-action="pres-theme">${state.theme === "noapte" ? "Zi" : "Noapte"}</button>
      </nav>
      <aside id="ops-pres-summary" class="ops-slide-summary" data-pres-panel="summary" data-pres-edge="left" ${summaryCollapsed ? "hidden" : ""} aria-label="Monitorizare situații operative">
          <div class="ops-sum-top">
            <div>
              <strong>Monitorizare situații operative</strong>
              <small>${activeIncidentCount} active · ${resolvedIncidentCount} rezolvate</small>
            </div>
          </div>
          ${presentationRiskGroups(active.type).map(group => {
            const features = allFeats.filter(f => group.kinds.includes(f.properties.kind) && f.properties.status !== "resolved");
            if (!features.length) return "";
            return `<div class="ops-sum-sec ops-risk-group">${groupToggle(group.id, group.label, features.length)}<div id="ops-risk-${group.id}" ${presentationCollapsedGroups.has(group.id) ? "hidden" : ""}><ul class="ops-mon-list">${MONITORED_CATEGORIES.filter(c => group.kinds.includes(c.kind)).map(({kind,label}) => {
              const items = features.filter(f => f.properties.kind === kind);
              if (!items.length) return "";
              return `<li class="ops-mon-cat has-active"><div class="ops-mon-row"><span class="ops-mon-label"><span class="ops-dot" data-kind="${kind}"></span>${esc(presentationKindLabel(kind, active.type, label))}</span><span class="ops-mon-count is-active">${items.length}</span></div><ul class="ops-mon-items">${items.map(itemHTML).join("")}</ul></li>`;
            }).join("")}</ul></div></div>`;
          }).join("") || `<p class="muted">Nicio problemă activă pentru acest tip de eveniment.</p>`}
          <div class="ops-sum-sec ops-risk-group">${groupToggle("resolved", "Situații rezolvate", resolvedList.length)}<div id="ops-risk-resolved" ${presentationCollapsedGroups.has("resolved") ? "hidden" : ""}><ul class="ops-mon-items">${resolvedList.map(itemHTML).join("") || `<li class="muted">Nicio situație rezolvată.</li>`}</ul></div></div>

          <div class="ops-sum-sec">
            ${groupToggle("forces", "🚒 Forțe și mijloace în teren", forcesList.length)}<div id="ops-risk-forces" ${presentationCollapsedGroups.has("forces") ? "hidden" : ""}>
            ${forcesList.length ? `<ul class="ops-forces-list">${forcesList.map(f => {
              const p = f.properties;
              const meta = [p.source || DEFAULT_AGENCY[p.kind] || KINDS[p.kind], p.personnel ? `Forțe: ${p.personnel}` : "", p.vehicles ? `Mijloace: ${p.vehicles}` : ""].filter(Boolean).join(" · ");
              return `<li><button type="button" data-pres-zoom="${esc(p.id)}">
                <span class="ops-dot" data-kind="${esc(p.status === "resolved" ? "resolved" : p.kind)}"></span>
                <div><b>${esc(p.title || KINDS[p.kind])}</b><small>${esc(meta)}</small></div>
              </button></li>`;
            }).join("")}</ul>` : `<p class="muted" style="margin:0;font-size:11.5px">Nicio forță plasată pe hartă (0).</p>`}</div>
          </div>
      </aside>

      <footer id="ops-pres-legend" class="ops-slide-foot" data-pres-panel="legend" data-pres-edge="bottom" ${legendCollapsed ? "hidden" : ""} aria-label="Legenda situației">
        <div class="ops-legend">${warnings.map(warning => `<span class="ops-legend-code" data-code="${esc(warning.code)}"><i aria-hidden="true"></i><b>${esc(ALERT_LABELS[warning.code] || warning.code)}</b> · ${esc(scope(warning))} · ${esc(span(warning.validFrom, warning.validTo, shortTime) || "interval nespecificat")}</span>`).join("")}${Object.entries(counts).map(([kind, count]) => `<span><i data-kind="${esc(kind)}"></i>${esc(kind === "resolved" ? "Rezolvat / Redeschis" : presentationKindLabel(kind, active.type, KINDS[kind]))}: <b>${count}</b></span>`).join("") || `<span>Toate situațiile monitorizate: <b>0 probleme active</b></span>`}</div>
        <span>${dirty ? "Situație în lucru" : "Actualizat " + dateLabel(active.updatedAt)}</span>
      </footer>`;
    for (const el of presentation.querySelectorAll("[id]")) if (scrollPositions.has(presKey(el))) el.scrollTop = scrollPositions.get(presKey(el));
    if (focused) {
      const replacement = focused.id
        ? [...presentation.querySelectorAll("[id]")].find(element => presKey(element) === focused.id)
        : [...presentation.querySelectorAll("button")].find(button => Object.entries(focused.data).every(([key, value]) => button.dataset[key] === value));
      replacement?.focus({ preventScroll: true });
    }
  }

  function applyMetaInput(input) {
    if (!active || !input?.dataset) return false;
    if (input.dataset.field) {
      active[input.dataset.field] = input.value;
      changed();
      return true;
    }
    return false;
  }

  function present() {
    if (pending || mode || itinerary.isPicking()) return message("Finalizează marcajul sau selecția înainte de prezentare.");
    if (!active) return;
    viewFocus = null;
    hideResolvedInPresentation = false;
    compactPresentation = isCompactViewport();
    messagesCollapsed = compactPresentation;
    summaryCollapsed = compactPresentation;
    legendCollapsed = compactPresentation;
    commandsCollapsed = true;
    lastOpenedPanel = "messages";
    beforePresentation = { ...currentView(), padding: map.getPadding() };
    previousOverlays = state.overlays;
    state.overlays = { sel: FC(), analysis: FC(), measure: FC(), pin: FC() };
    state.operations.presenting = true;
    state.operations.labelSize = compactPresentation ? 14 : 18;
    sync(false);
    renderPresentationOverlay();
    presentation.hidden = false;
    focusbar.hidden = true;
    document.body.classList.add("presenting");
    applyStyle();
    requestAnimationFrame(() => { map.resize(); fit(); presentation.querySelector("[data-action=exit]")?.focus(); });
  }

  panel.oninput = (event) => {
    const input = event.target;
    if (alertEditor.handleInput(input)) return;
    if (["coordinate", "name"].includes(input.dataset?.itineraryField) && itinerary.handleChange(input)) return;
    if (input.id === "ops-archive-search") {
      archiveFilter = input.value;
      render();
      const searchEl = panel.querySelector("#ops-archive-search");
      if (searchEl) { searchEl.focus(); searchEl.setSelectionRange(archiveFilter.length, archiveFilter.length); }
      return;
    }
    if (!active) return;
    applyMetaInput(input);
    // When typing a road name inside #ops-marker, refresh the road info & localities dropdowns if it matches a known road
    if (pending && input.name === "road") {
      pending.properties.road = input.value;
      const matched = findRoadByRef(state.data.roads, input.value);
      if (matched && normalizeRoadRef(input.value) === matched.ref) {
        render();
        const roadEl = panel.querySelector('#ops-marker input[name="road"]');
        if (roadEl) { roadEl.focus(); roadEl.setSelectionRange(input.value.length, input.value.length); }
      }
    }
  };

  function normalizeRoadRef(v) {
    return String(v ?? "").trim().toUpperCase().replace(/\s+/g, "");
  }

  panel.onchange = async (event) => {
    const target = event.target;
    // A rejected date changes nothing stored, so the save line is told here.
    if (alertEditor.handleChange(target)) return refreshSaveState();
    if (operationCards.handleChange(target)) return;
    if (itinerary.handleChange(target)) return;
    if (applyMetaInput(target)) return;
    if (target.id === "ops-archive") {
      if (!canReplaceDraft()) { render(); return; }
      const val = target.value;
      if (!val) {
        closeActive(); render();
        return;
      }
      try {
        const saved = db.load(val);
        if (saved) setActive(saved);
      } catch { message("Situația nu a putut fi citită din arhivă."); }
      return;
    }
    if (target.dataset?.toggle && active) {
      if (target.dataset.toggle === "isolateArea") viewFocus = null;
      active[target.dataset.toggle] = target.checked;
      changed();
      sync(true);
      return;
    }
    if (pending && (target.id === "ops-road-from-place" || target.id === "ops-road-to-place")) {
      const fromP = panel.querySelector("#ops-road-from-place")?.value;
      const toP = panel.querySelector("#ops-road-to-place")?.value;
      if (fromP && toP) tracePendingRoadFromInputs();
      return;
    }
    if (pending && target.name === "kind") {
      const prevKind = pending.properties.kind;
      pending.properties.kind = target.value;
      const srcInput = panel.querySelector('#ops-marker input[name="source"]');
      if (srcInput && (!srcInput.value.trim() || srcInput.value === DEFAULT_AGENCY[prevKind])) {
        srcInput.value = DEFAULT_AGENCY[target.value] || "";
        pending.properties.source = srcInput.value;
      }
      sync();
      return;
    }
    if (target.id !== "ops-import") return;
    const file = target.files[0]; if (!file) return;
    if (!canReplaceDraft()) return;
    try {
      if (file.size > 32 * 1024 * 1024) throw new Error("Archive too large");
      const result = db.importArchive(await file.text());
      if (active) { const imported = db.load(active.id); if (imported && imported.updatedAt > active.updatedAt) setActive(imported); }
      else {
        const latest = db.list()[0];
        if (latest) setActive(latest);
      }
      notice = `Baza de date a fost încărcată: ${result.imported} situații adăugate / actualizate (${result.total} în total).`;
      render(); toast(notice);
    } catch (error) {
      console.warn(error);
      message("Importul nu a reușit. Fișierul JSON este invalid sau prea mare. Baza de date existentă a fost păstrată.");
    }
  };

  panel.onsubmit = (event) => {
    event.preventDefault();
    if (event.target.id === "ops-new") {
      const fields = new FormData(event.target);
      try {
        const type = fields.get("type") || "snow";
        active = createEvent(fields.get("title"), type);
        active.places = [];
        active.isolateArea = false;
        active.tintAreas = true;
        dirty = true; setCloudState({ base: null, unpublished: true, conflict: null }); viewFocus = null; exported = false; notice = "";
        dropMarkerUndo();
        if (applyPreset) applyPreset(type);
        // Saved after the preset, so reopening it keeps the layers it starts with.
        autoSaveActiveToDb();
        sync(true); render();
      } catch { message("Introdu o denumire pentru situație."); }
    } else if (event.target.id === "ops-marker" && pending) {
      if (intervalRejected("Marcajul nu a fost adăugat.")) return;
      const fields = new FormData(event.target);
      const kmFromRaw = fields.get("kmFrom");
      const kmToRaw = fields.get("kmTo");
      const hasKmFrom = kmFromRaw !== null && String(kmFromRaw).trim() !== "";
      const hasKmTo = kmToRaw !== null && String(kmToRaw).trim() !== "";
      if (hasKmFrom && hasKmTo && Number(kmToRaw) < Number(kmFromRaw)) {
        return message("Kilometrul final trebuie să fie cel puțin egal cu cel inițial.");
      }

      // If this is a road marker and either geometry wasn't traced yet OR the user edited road/kmFrom/kmTo, auto-trace it!
      const roadStr = (fields.get("road") || "").trim();
      const newKmFrom = hasKmFrom ? Number(kmFromRaw) : null;
      const newKmTo = hasKmTo ? Number(kmToRaw) : null;
      const kmChanged = newKmFrom !== pending.properties.kmFrom || newKmTo !== pending.properties.kmTo || normalizeRoadRef(roadStr) !== normalizeRoadRef(pending.properties.road);

      if ((!pending.geometry || (kmChanged && hasKmFrom)) && roadStr) {
        if (!tracePendingRoadFromInputs()) return;
      }
      if (!pending.geometry) {
        return message("Alege un drum din listă și kilometrii (ex. DJ29, km 3 – km 6) sau trasează sectorul cu 2 click-uri pe hartă.");
      }

      let observedAt;
      try { observedAt = isoTime(fields.get("observedAt")); }
      catch { return message("Alege o oră validă pentru informație, în ora României."); }

      const finalKmFrom = pending.properties.kmFrom ?? newKmFrom;
      const finalKmTo = pending.properties.kmTo ?? newKmTo;
      const finalRoad = (fields.get("road") || pending.properties.road || "").trim().toUpperCase();
      const lengthKm = pending.geometry.type === "LineString" ? lineLengthKm(pending.geometry.coordinates) : null;

      Object.assign(pending.properties, {
        kind: fields.get("kind"),
        status: fields.get("status"),
        road: finalRoad,
        kmFrom: finalKmFrom,
        kmTo: finalKmTo,
        lengthKm,
        source: fields.get("source") || "",
        personnel: fields.get("personnel") || "",
        vehicles: fields.get("vehicles") || "",
        observedAt,
        notes: fields.get("notes") || "",
      });

      const roadTitle = [
        finalRoad,
        finalKmFrom !== null ? `km ${finalKmFrom}${finalKmTo !== null ? "–" + finalKmTo : ""}` : "",
        lengthKm ? `(${lengthKm} km)` : "",
      ].filter(Boolean).join(" · ");
      pending.properties.title = (fields.get("title") || "").trim() || roadTitle || KINDS[pending.properties.kind];

      const features = active.features.features.filter(f => f.properties.id !== editingId);
      const candidate = { ...active, features: FC([...features, pending]) };
      try {
        active = sanitizeEvent(candidate);
        const addedGeom = pending.geometry;
        pending = null; editingId = null;
        // Also auto-save to browser storage so the user never loses road closures
        setCloudState({ unpublished: true });
        try { active = saveActive(); dirty = false; } catch { changed(); }
        sync(); render();
        fitGeometry(addedGeom);
        toast("Marcajul a fost adăugat și salvat în situația curentă.");
      } catch (err) {
        console.warn(err);
        message("Verifică datele marcajului înainte de adăugare.");
      }
    }
  };

  panel.onclick = async (event) => {
    const button = event.target.closest("button"); if (!button) return;
    if (operationCards.handleClick(button)) return;
    // Adding or removing a warning re-renders the panel, which would drop unsubmitted marker input.
    if (button.dataset.alertAction && pending) return message("Finalizează sau anulează marcajul curent înainte de a adăuga sau șterge o avertizare.");
    if (alertEditor.handleClick(button)) return;
    if (button.dataset.action === "open-itinerary" && pending) return message("Finalizează marcajul curent înainte de a calcula itinerarul.");
    if (itinerary.handleClick(button)) { reconsiderCloud(); return; }

    if (button.dataset.preset) {
      if (applyPreset) applyPreset(button.dataset.preset);
      return;
    }
    if (button.dataset.area && active) {
      if (pending) return message("Finalizează marcajul curent înainte de schimbarea zonei.");
      active.areas = active.areas.filter(name => name !== button.dataset.area);
      viewFocus = null;
      changed(); sync(true); render(); return;
    }
    if (button.dataset.placeRemove && active) {
      if (pending) return message("Finalizează marcajul curent înainte de schimbarea zonei.");
      active.places = (active.places || []).filter(name => name !== button.dataset.placeRemove);
      viewFocus = null;
      changed(); sync(true); render(); return;
    }
    if (button.dataset.resolveMark && active) {
      toggleResolveFeature(button.dataset.resolveMark);
      return;
    }
    if (button.dataset.zoomMark && active) {
      const f = active.features.features.find(x => x.properties.id === button.dataset.zoomMark);
      if (f) { setSheet("peek"); fitGeometry(f.geometry); }
      return;
    }
    if (button.dataset.remove && active) {
      if (pending) return message("Finalizează sau anulează editarea marcajului curent.");
      if (intervalRejected("Marcajul nu a fost eliminat.")) return;
      const index = active.features.features.findIndex(f => f.properties.id === button.dataset.remove);
      if (index < 0) return;
      const [removed] = active.features.features.splice(index, 1);
      const eventId = active.id;
      setCloudState({ unpublished: true });
      try { active = saveActive(); dirty = false; } catch { changed(); }
      sync(); render();
      offerUndo(`Marcajul „${removed.properties.title || KINDS[removed.properties.kind]}” a fost eliminat.`, () => {
        if (active?.id !== eventId) { message("Între timp s-a deschis altă situație; marcajul nu mai poate fi pus la loc."); return true; }
        if (pending || mode || itinerary.isPicking()) { message("Finalizează sau anulează marcajul ori instrumentul curent, apoi apasă din nou „Anulează”."); return false; }
        if (intervalRejected("Marcajul nu a fost pus la loc.")) return false;
        const features = active.features.features;
        if (!features.some(f => f.properties.id === removed.properties.id)) features.splice(Math.min(index, features.length), 0, removed);
        setCloudState({ unpublished: true });
        try { active = saveActive(); dirty = false; } catch { changed(); }
        sync(); render();
        toast("Marcajul a fost pus la loc.");
        return true;
      });
      undo.eventId = eventId;
      return;
    }
    if (button.dataset.mark && active) {
      if (pending) return message("Finalizează sau anulează editarea marcajului curent.");
      pending = structuredClone(active.features.features.find(f => f.properties.id === button.dataset.mark));
      editingId = pending.properties.id;
      sync(); render();
      requestAnimationFrame(() => panel.querySelector("#ops-marker")?.scrollIntoView({ block: "start" }));
      return;
    }
    if (button.dataset.openId) {
      if (!canReplaceDraft()) return;
      const saved = db.load(button.dataset.openId);
      if (saved) setActive(saved);
      return;
    }
    if (button.dataset.presentId) {
      if (!canReplaceDraft()) return;
      const saved = db.load(button.dataset.presentId);
      if (saved) { setActive(saved); present(); }
      return;
    }
    if (button.dataset.exportId) {
      const saved = db.load(button.dataset.exportId);
      if (saved) await saveJsonFile(`situatie-${saved.id}.json`, { format: "harta-botosani-events", version: 1, exportedAt: new Date().toISOString(), events: [saved] });
      return;
    }
    if (button.dataset.deleteId) {
      confirmDeleteId = button.dataset.deleteId;
      render();
      // The safe answer takes the focus, so Enter right after "Șterge" deletes nothing.
      panel.querySelector('[data-action="cancel-delete"]')?.focus();
      return;
    }
    if (button.dataset.confirmDelete) return deleteSituation(button.dataset.confirmDelete);

    const action = button.dataset.action;
    if (action === "quick-road" || action === "open-road-form") return openRoadCreator();
    if (action === "trace-km") { tracePendingRoadFromInputs(); render(); return; }
    if (action === "retrace-road") return start("retrace-road", pending?.properties?.kind || "blocked");
    if (["area", "road", "zone", "point", "place"].includes(action)) return start(action, button.dataset.kind || null);

    if (action === "add-uat-btn" && active) {
      const val = panel.querySelector("#ops-add-uat-input")?.value?.trim();
      const match = (state.data.admin?.features || []).find(f => f.properties.kind === "uat" && f.properties.name.toLowerCase() === val?.toLowerCase());
      if (!match) return message("Alege o comună sau un oraș valid din lista județului Botoșani.");
      if (!active.areas.includes(match.properties.name)) active.areas = [...active.areas, match.properties.name];
      viewFocus = null;
      changed(); sync(true); render(); fit();
      return;
    }
    if (action === "add-place-btn" && active) {
      const val = panel.querySelector("#ops-add-place-input")?.value?.trim();
      const loc = findLocality(val);
      if (!loc) return message("Alege un sat / o localitate validă din județul Botoșani.");
      active.places = active.places || [];
      if (!active.places.includes(loc.name)) active.places = [...active.places, loc.name];
      viewFocus = null;
      changed(); sync(true); render(); fit();
      return;
    }
    if (action === "clear-areas" && active) {
      active.areas = []; active.places = []; active.isolateArea = false; viewFocus = null;
      changed(); sync(true); render();
      return;
    }

    if (action === "save") save();
    if (action === "cancel-delete") { confirmDeleteId = null; render(); }
    if (action === "undo" && undo) {
      const { restore } = undo;
      if (restore() !== false) dropUndo();
    }
    if (action === "cloud-overwrite" && active && cloudState().conflict) save({ overwrite: true });
    if (action === "cloud-take" && active && cloudState().conflict) {
      // A queued write would still land after the choice and undo it.
      if (publishing || inFlight.has(active.id) || cloudPending.has(active.id)) return message("Așteaptă răspunsul Cloud-ului la publicarea în curs, apoi alege versiunea.");
      if (pending || mode || itinerary.isPicking()) return message("Finalizează sau anulează marcajul în curs înainte de a încărca versiunea din Cloud.");
      if (intervalRejected("Versiunea din Cloud nu a fost încărcată.")) return;
      const taken = cloudState().conflict;
      try { setActive(db.put(taken), { cloud: { base: taken.updatedAt, unpublished: false, conflict: null } }); }
      catch (error) { console.warn(error); return message("Versiunea din Cloud nu a putut fi salvată în acest browser."); }
      toast(`Ai încărcat versiunea din Cloud a situației „${active.title}”.`);
    }
    // "Încadrează zona" in the panel frames the situation, so a map view ends here.
    if (action === "fit") { if (viewFocus) { viewFocus = null; sync(true); } setSheet("peek"); fit(); }
    if (action === "preset" && active) {
      if (applyPreset) applyPreset(active.type);
      changed();
    }
    if (action === "present") present();
    if (action === "discard-mark") { pending = null; editingId = null; sync(); render(); reconsiderCloud(); }
    if (action === "new" && canReplaceDraft()) { closeActive(); render(); }
    if (action === "open" && canReplaceDraft()) {
      try {
        const saved = db.load(panel.querySelector("#ops-archive").value);
        if (saved) setActive(saved); else message("Alege o situație din listă.");
      } catch { message("Situația nu a putut fi citită din arhivă."); }
    }
    if (action === "duplicate" && canReplaceDraft()) {
      const base = createEvent(active.title + " · copie", active.type);
      active = { ...structuredClone(active), id: base.id, title: base.title, createdAt: base.createdAt, updatedAt: base.updatedAt };
      dirty = true; setCloudState({ base: null, unpublished: true, conflict: null }); exported = false;
      viewFocus = null; confirmDeleteId = null; dropMarkerUndo();
      autoSaveActiveToDb(); persistSession(); sync(true); render();
    }
    if (action === "event-export") {
      try {
        if (pending || mode) return message("Finalizează marcajul curent înainte de salvare JSON.");
        if (intervalRejected("Situația nu a fost exportată.")) return;
        // A clean situation is exported as stored: a new timestamp would make it look unpublished.
        const savedSnap = dirty ? saveActive() : { ...snapshot(), updatedAt: active.updatedAt };
        if (dirty) { active = savedSnap; dirty = false; persistSession(); }
        const ok = await saveJsonFile(`situatie-${active.id}.json`, { format: "harta-botosani-events", version: 1, exportedAt: new Date().toISOString(), events: [savedSnap] });
        if (ok) { exported = true; notice = "Situația a fost salvată în arhivă și în fișierul JSON."; render(); toast(notice); }
      } catch { message("Verifică denumirea și datele situației înainte de export."); }
    }
    if (action === "archive-export") {
      try {
        if (active && intervalRejected("Arhiva nu a fost exportată.")) return;
        if (active && !pending && !mode && dirty) {
          active = saveActive(); dirty = false; persistSession();
        }
        const ok = await saveJsonFile("situatii.json", db.exportArchive());
        if (ok) { message("Baza de date cu toate situațiile (situatii.json) a fost salvată."); render(); }
      } catch { message("Arhiva locală nu poate fi exportată."); }
    }
  };

  drawbar.onclick = (event) => {
    const action = event.target.closest("button")?.dataset.action;
    if (action === "cancel-itinerary-pick") { itinerary.cancelPick(); reconsiderCloud(); }
    if (action === "finish") finishDrawing();
    if (action === "cancel") cancelDrawing();
    if (action === "undo") { points.pop(); sync(); drawInstructions(); }
    if (action === "switch-to-km") { stopDrawing(); openRoadCreator(); }
  };

  focusbar.onclick = (event) => {
    const btn = event.target.closest("button");
    if (!btn) return;
    if (viewFocus) return viewFocusClick(btn);
    if (btn.dataset.fremoveUat) {
      if (active) { active.areas = active.areas.filter(a => a !== btn.dataset.fremoveUat); changed(); }
      else standaloneFocus.areas = standaloneFocus.areas.filter(a => a !== btn.dataset.fremoveUat);
      sync(true); render(); return;
    }
    if (btn.dataset.fremovePlace) {
      if (active) { active.places = (active.places || []).filter(p => p !== btn.dataset.fremovePlace); changed(); }
      else standaloneFocus.places = standaloneFocus.places.filter(p => p !== btn.dataset.fremovePlace);
      sync(true); render(); return;
    }
    const act = btn.dataset.faction;
    if (act === "toggle-isolate") {
      if (active) { active.isolateArea = !active.isolateArea; changed(); }
      else standaloneFocus.isolate = !standaloneFocus.isolate;
      sync(true); render();
    } else if (act === "fit") {
      fit();
    } else if (act === "clear-focus") {
      if (active) { active.areas = []; active.places = []; active.isolateArea = false; changed(); }
      else standaloneFocus = { areas: [], places: [], isolate: true };
      sync(true); render();
    }
  };

  function viewFocusClick(btn) {
    const act = btn.dataset.faction;
    if (btn.dataset.fremoveUat) viewFocus.areas = viewFocus.areas.filter(a => a !== btn.dataset.fremoveUat);
    else if (btn.dataset.fremovePlace) viewFocus.places = viewFocus.places.filter(p => p !== btn.dataset.fremovePlace);
    else if (act === "toggle-isolate") viewFocus.isolate = !viewFocus.isolate;
    else if (act === "fit") return fit();
    else if (act === "clear-focus") viewFocus = null;
    else if (act === "adopt-view") {
      if (pending) return message("Finalizează marcajul curent înainte de schimbarea zonei.");
      active.areas = [...new Set([...active.areas, ...viewFocus.areas])];
      active.places = [...new Set([...(active.places || []), ...viewFocus.places])];
      active.isolateArea = viewFocus.isolate;
      viewFocus = null;
      changed(); sync(true); render();
      return toast("Zona vizualizată a fost adăugată în situație.");
    }
    if (viewFocus && !viewFocus.areas.length && !viewFocus.places.length) viewFocus = null;
    sync(true);
    if (!viewFocus) fit();
  }

  presentation.onclick = (event) => {
    const btn = event.target.closest("button");
    if (!btn) return;
    if (btn.dataset.presResolve && active) {
      toggleResolveFeature(btn.dataset.presResolve);
      return;
    }
    if (btn.dataset.presZoom && active) {
      const f = active.features.features.find(x => x.properties.id === btn.dataset.presZoom);
      if (f) fitGeometry(f.geometry);
      return;
    }
    if (btn.dataset.presGroup) {
      const key = btn.dataset.presGroup;
      presentationCollapsedGroups.has(key) ? presentationCollapsedGroups.delete(key) : presentationCollapsedGroups.add(key);
      renderPresentationOverlay();
      return;
    }
    const act = btn.dataset.action;
    if (act === "exit") exitPresentation();
    else if (act === "pres-fit") fit();
    else if (["pres-toggle-messages", "pres-toggle-summary", "pres-toggle-legend", "pres-toggle-commands"].includes(act)) {
      const panel = act.slice("pres-toggle-".length);
      const collapsed = { messages: messagesCollapsed, summary: summaryCollapsed, legend: legendCollapsed, commands: commandsCollapsed };
      const opening = collapsed[panel];
      if (compactPresentation && opening) for (const name of Object.keys(collapsed)) collapsed[name] = true;
      collapsed[panel] = !opening;
      if (opening) lastOpenedPanel = panel;
      ({ messages: messagesCollapsed, summary: summaryCollapsed, legend: legendCollapsed, commands: commandsCollapsed } = collapsed);
      persistSession();
      renderPresentationOverlay();
      presentation.querySelector(`[data-action="${act}"]`)?.focus({ preventScroll: true });
    } else if (act === "pres-toggle-resolved") {
      hideResolvedInPresentation = !hideResolvedInPresentation;
      persistSession();
      sync();
      renderPresentationOverlay();
    } else if (act === "pres-isolate" && active) { active.isolateArea = !active.isolateArea; sync(true); renderPresentationOverlay(); }
    else if (act === "pres-sat") {
      state.basemap = state.basemap === "satelit" ? "harta" : "satelit";
      applyStyle(); renderPresentationOverlay();
    } else if (act === "pres-theme") {
      state.theme = state.theme === "noapte" ? "zi" : "noapte";
      document.documentElement.dataset.theme = state.theme === "noapte" ? "dark" : "light";
      applyStyle(); renderPresentationOverlay();
    }
  };

  const handleKey = (event) => {
    if (event.key === "Escape" && itinerary.isPicking()) { itinerary.cancelPick(); reconsiderCloud(); event.preventDefault(); return true; }
    if (event.key === "Escape" && document.body.classList.contains("presenting")) { exitPresentation(); event.preventDefault(); return true; }
    if (event.key === "Escape" && mode) { cancelDrawing(); event.preventDefault(); return true; }
    return false;
  };

  window.addEventListener("resize", () => {
    if (!document.body.classList.contains("presenting")) return;
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      const nextCompact = isCompactViewport();
      if (nextCompact && !compactPresentation) {
        const collapsed = { messages: messagesCollapsed, summary: summaryCollapsed, legend: legendCollapsed, commands: commandsCollapsed };
        const keep = !collapsed[lastOpenedPanel] ? lastOpenedPanel : Object.keys(collapsed).find(name => !collapsed[name]);
        for (const name of Object.keys(collapsed)) collapsed[name] = name !== keep;
        ({ messages: messagesCollapsed, summary: summaryCollapsed, legend: legendCollapsed, commands: commandsCollapsed } = collapsed);
      }
      compactPresentation = nextCompact;
      state.operations.labelSize = compactPresentation ? 14 : 18;
      renderPresentationOverlay();
      for (const id of ["ops-features-label", "ops-features-label-line"]) {
        if (map.getLayer(id)) map.setLayoutProperty(id, "text-size", state.operations.labelSize);
      }
      map.resize();
    });
  });

  restoreSession();
  sync(true);
  render();
  return { handleMapClick, handleKey, cancelDrawing: () => { if (itinerary.cancelPick()) reconsiderCloud(); cancelDrawing(); }, isDrawing: () => !!mode || itinerary.isPicking(), sync, openRoadCreator, syncFromCloud };
}
