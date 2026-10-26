/* global maplibregl */
import { POI, LAYER_GROUPS, LAYER_PRESETS, LABELS, START_VIEW, itemLabel } from "./config.js?v=20261018-itineraries-v2";
import { buildStyle, PALETTES } from "./style.js?v=20261025-room-scale";
import { buildIcons, iconDataURL } from "./icons.js?v=20261025-room-scale";
import { SearchIndex, typeInfo, norm } from "./search.js";
import { ensureLogin, decryptJSON, logout } from "./auth.js";
import { renderAdmin } from "./admin.js?v=20261025-rivers";
import { formatRestriction } from "./restrictions.js";
import { normalizeSubunitsDoc, mergeSubunitsIntoPois, SUBUNITS_DRAFT_KEY, isNewerSubunitsDocument } from "./subunits.js?v=20261018-itineraries-v2";
import { openCommuneMap, isCommuneMapOpen } from "./commune.js?v=20261019-multi-alerts";
import { initOperations } from "./operations.js?v=20261025-rivers";
import {
  saveSubunitsCloud, subscribeSubunits,
  saveSituationCloud, deleteSituationCloud, subscribeSituations, onCloudStatus,
} from "./cloud-db.js?v=20261025-cloud-guard";
import {
  distance, bearing, direction, circle, fmtDistance, fmtLatLon, fmtStereo, fmtDMS,
  parseCoordinates, makeUatLookup,
} from "./geo.js";
import { courseIndex, courseRows, courseSearchRows } from "./hydrography-layer.js?v=20261026-hydro";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const FC = () => ({ type: "FeatureCollection", features: [] });
const store = {
  get(k, d) { try { const v = localStorage.getItem("hb." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("hb." + k, JSON.stringify(v)); } catch { /* fără stocare */ } },
};

// ------------------------------------------------------------------ stare

const defaults = {};
for (const g of LAYER_GROUPS) for (const it of g.items) defaults[it.id] = it.on;

const savedVisible = store.get("visible.v2", null);
const initialVisible = { ...defaults };
if (savedVisible && typeof savedVisible === "object") {
  for (const k of Object.keys(defaults)) {
    if (typeof savedVisible[k] === "boolean") initialVisible[k] = savedVisible[k];
  }
}

const state = {
  theme: document.documentElement.dataset.theme === "dark" ? "noapte" : "zi",
  basemap: store.get("basemap", "harta") === "satelit" ? "satelit" : "harta",
  visible: initialVisible,
  data: { pois: FC(), hydrants: FC(), hydrography: FC(), admin: FC(), roads: { roads: [] }, localities: [], initialEvents: null },
  overlays: { sel: FC(), analysis: FC(), measure: FC(), pin: FC() },
  hoverUat: "",
  mode: null, // null | "measure" | "pick"
  measure: [],
  analysis: null,
};

const search = new SearchIndex();
let uatAt = () => null;
let stats = null;
let map;
let operations = null;
const icons = buildIcons();

// ------------------------------------------------------------------ pornire

async function loadJSON(path, fallback) {
  try {
    const r = await fetch(path, { cache: "no-cache" });
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch (e) {
    console.warn("Nu pot încărca", path, e);
    return fallback;
  }
}

const HYD_LABEL_KEYS = ["nr", "numar", "nrhidrant", "cod", "id", "indicativ", "denumire", "nume", "name"];

function prepareHydrants(fc) {
  const keys = fc.features.length ? Object.keys(fc.features[0].properties) : [];
  const labelKey = keys.find((k) => HYD_LABEL_KEYS.includes(norm(k).replace(/[^a-z0-9]/g, "")));
  const stareKey = keys.find((k) => ["stare", "starehidrant", "status", "functional"].includes(norm(k).replace(/[^a-z0-9]/g, "")));
  for (const f of fc.features) {
    const v = labelKey ? f.properties[labelKey] : null;
    f.properties._label = v != null && v !== "" ? String(v) : String(f.id + 1);
    if (!f.properties._stare) {
      const sv = norm(stareKey ? f.properties[stareKey] : "");
      f.properties._stare = /nefunc|defect|inactiv|nu func/.test(sv) ? "defect" : /func|activ|ok|bun/.test(sv) ? "ok" : "necunoscut";
    }
  }
  return fc;
}

let session = null;
let geolocate = null;
let lastPosition = null;

/** Descarcă și decriptează un fișier criptat din data/; lipsa lui sau o eroare dau o colecție goală. */
async function loadEncrypted(path, what) {
  try {
    const r = await fetch(path, { cache: "no-cache" });
    if (!r.ok) return FC();
    return await decryptJSON(session.key, await r.json());
  } catch (e) {
    console.warn(`Nu pot decripta ${what}`, e);
    return FC();
  }
}

const loadHydrants = () => loadEncrypted("data/hidranti.enc", "hidranții");

const HYDROGRAPHY_FORMAT = "harta-botosani-hydrography";

/** Cadastrul apelor (ABA) se publică doar criptat; un fișier cu alt format e tratat ca lipsă. */
async function loadHydrography() {
  const fc = await loadEncrypted("data/hidrografie.enc", "hidrografia");
  return fc?.format === HYDROGRAPHY_FORMAT && Array.isArray(fc.features) ? fc : FC();
}

function hydrantSearchRows() {
  return state.data.hydrants.features.map((f) => {
    const p = f.properties;
    const reper = p.Reper || p.reper || p.nume || p.Denumire || "";
    const ctx = [p.Localitate || p.Localitatea, p["Stradă"] || p.Strada, p._uat].filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i).join(", ");
    return [`Hidrant ${p._label}${reper ? " – " + reper : ""}`, "hid", ...f.geometry.coordinates, ctx, null, f.id];
  });
}

function updateDataInfo() {
  const date = stats?.generated ? new Date(stats.generated).toLocaleDateString("ro-RO", { day: "numeric", month: "long", year: "numeric" }) : "–";
  const nh = state.data.hydrants.features.length;
  const nr = state.data.hydrography.features.length;
  $("#data-info").textContent = `Date OSM din ${date} · ${nh ? nh.toLocaleString("ro-RO") + " hidranți" : "fără listă de hidranți"}` +
    (nr ? ` · ${nr.toLocaleString("ro-RO")} râuri (cadastru ABA)` : "");
}

/** Înlocuiește hidranții afișați (folosit de panoul de administrare la import). */
function replaceHydrants(fc) {
  state.data.hydrants = prepareHydrants(fc);
  map?.getSource("hydrants")?.setData(state.data.hydrants);
  search.items = search.items.filter((it) => it.type !== "hid");
  search.add(hydrantSearchRows());
  updateDataInfo();
  renderLayerPanel();
}

/** Înlocuiește hidrografia încărcată (folosit de panoul de administrare, doar în această sesiune). */
function replaceHydrography(fc) {
  state.data.hydrography = fc;
  map?.getSource("hydrography")?.setData(fc);
  search.items = search.items.filter((it) => it.type !== "cad");
  search.add(courseSearchRows(fc));
  updateDataInfo();
  renderLayerPanel();
}

/** Aplică lista de subunități ISU pe hartă; `draft` = păstrată local până la publicarea subunitati.json. */
function replaceSubunits(subunits, { draft = true, updatedAt = new Date().toISOString() } = {}) {
  const nextDoc = normalizeSubunitsDoc({ subunits, updatedAt });
  state.data.subunits = nextDoc.subunits;
  state.data.subunitsUpdatedAt = nextDoc.updatedAt;
  state.data.subunitsDraft = draft ? nextDoc : null;
  try {
    if (state.data.subunitsDraft) localStorage.setItem(SUBUNITS_DRAFT_KEY, JSON.stringify(state.data.subunitsDraft));
    else localStorage.removeItem(SUBUNITS_DRAFT_KEY);
  } catch { /* fără stocare */ }
  state.data.pois = mergeSubunitsIntoPois(state.data.osmPois, subunits);
  map?.getSource("pois")?.setData(state.data.pois);
  renderLayerPanel();
}

let pendingPick = null;
/** Următorul click pe hartă întoarce coordonatele [lon, lat] (folosit în Admin → Subunități ISU). */
function pickPoint(callback) {
  pendingPick = callback || null;
  if (map) map.getCanvas().style.cursor = callback ? "crosshair" : "";
}
function flyToPoint(ll) {
  map?.flyTo({ center: ll, zoom: Math.max(map.getZoom(), 14) });
}
const cloudDb = {
  saveSituation: typeof saveSituationCloud === "function" ? saveSituationCloud : null,
  deleteSituation: typeof deleteSituationCloud === "function" ? deleteSituationCloud : null,
  saveSubunits: typeof saveSubunitsCloud === "function" ? saveSubunitsCloud : null,
  subscribeSubunits: typeof subscribeSubunits === "function" ? subscribeSubunits : null,
  subscribeSituations: typeof subscribeSituations === "function" ? subscribeSituations : null,
  onStatus: typeof onCloudStatus === "function" ? onCloudStatus : null,
};

async function init() {
  session = await ensureLogin();
  $("#who").innerHTML = `<span>${esc(session.name)}${session.role === "admin" ? " · admin" : ""}</span>
    <button id="logout" type="button">Ieșire</button>`;
  $("#logout").addEventListener("click", logout);
  if (session.role === "admin") $("#tb-admin").hidden = false;

  const [pois, hydrants, hydrography, admin, searchRows, st, roadsData, initialEvents, subunitsDoc] = await Promise.all([
    loadJSON("data/pois.geojson", FC()),
    loadHydrants(),
    loadHydrography(),
    loadJSON("data/admin.geojson", FC()),
    loadJSON("data/search.json", []),
    loadJSON("data/stats.json", null),
    loadJSON("data/roads.json", { roads: [] }),
    loadJSON("data/situatii.json?v=20261019-multi-alerts", null),
    loadJSON("data/subunitati.json?v=20261018-itineraries-v2", null),
  ]);
  state.data.osmPois = { ...pois, features: pois.features.filter((f) => f.properties.cat !== "hidrant_osm") };
  state.data.subunitsPublished = normalizeSubunitsDoc(subunitsDoc);
  const draft = (() => { try { return JSON.parse(localStorage.getItem(SUBUNITS_DRAFT_KEY) || "null"); } catch { return null; } })();
  state.data.subunitsDraft = draft && isNewerSubunitsDocument(draft, state.data.subunitsPublished) ? normalizeSubunitsDoc(draft) : null;
  state.data.subunits = (state.data.subunitsDraft || state.data.subunitsPublished).subunits;
  state.data.subunitsUpdatedAt = (state.data.subunitsDraft || state.data.subunitsPublished).updatedAt;
  state.data.pois = mergeSubunitsIntoPois(state.data.osmPois, state.data.subunits);
  state.data.hydrants = prepareHydrants(hydrants);
  state.data.hydrography = hydrography;
  state.data.admin = admin;
  state.data.roads = Array.isArray(roadsData?.roads) ? roadsData : { roads: [] };
  state.data.initialEvents = initialEvents?.format === "harta-botosani-events" ? initialEvents : null;
  state.data.localities = (Array.isArray(searchRows) ? searchRows : [])
    .filter((row) => typeof row[1] === "string" && row[1].startsWith("loc:") && row[1] !== "loc:locality")
    .map((row) => ({ name: row[0], kind: row[1].slice(4), lon: row[2], lat: row[3], ctx: row[4] || "" }));
  stats = st;
  uatAt = makeUatLookup(admin);
  // Warnings key villages by name and UAT: 25 village names repeat in the index.
  for (const place of state.data.localities) place.uat = uatAt(place.lon, place.lat)?.name || "";
  search.add(searchRows.filter((row) => row[1] !== "poi:hidrant_osm"));
  search.add(hydrantSearchRows());
  search.add(courseSearchRows(state.data.hydrography));
  updateDataInfo();

  renderLayerPanel();
  renderAnalysis();
  initSheet();
  initMap();
  const cloud = typeof cloudDb !== "undefined" ? cloudDb : null;

  operations = initOperations({ map, state, uatAt, toast, selectTab, setSheet, applyStyle, renderLayerPanel,
    applyPreset: typeof applyPreset === "function" ? applyPreset : null,
    cloudDb: cloud,
    isMapToolActive: () => Boolean(state.mode || pendingPick),
    stopOtherTools: () => { setMode(null); closeInfo(); closeContextMenu(); } });
  initSearch();
  initUI();
  if (session.role === "admin") {
    renderAdmin($("#tab-admin"), { session, state, uatAt, onHydrants: replaceHydrants, onHydrography: replaceHydrography, toast, copy,
      onSubunits: replaceSubunits, pickPoint, flyToPoint, cloudDb: cloud });
  }

  // Sincronizare în timp real din Firebase Firestore (dacă este activ în browser)
  try {
    if (cloud?.subscribeSubunits) {
      cloud.subscribeSubunits((cloudDoc) => {
        if (Array.isArray(cloudDoc?.subunits) && isNewerSubunitsDocument(cloudDoc, { subunits: state.data.subunits, updatedAt: state.data.subunitsUpdatedAt })) {
          replaceSubunits(cloudDoc.subunits, { draft: false, updatedAt: cloudDoc.updatedAt });
        }
      });
    }
    if (cloud?.subscribeSituations) {
      cloud.subscribeSituations((cloudEvents, meta) => {
        operations?.syncFromCloud?.(cloudEvents, meta);
      });
    }
  } catch { /* context de test fără cloud */ }
}

// ------------------------------------------------------------------ telefon / ecran mic

const MOBILE_MQ = matchMedia("(max-width: 760px), (max-height: 520px)");
const isMobile = () => MOBILE_MQ.matches;
let sheetDragged = false;
let suppressClickUntil = 0;

function setMobileMapOnly(hidden) {
  document.body.classList.toggle("mobile-map-only", hidden);
  const button = $("#mobile-map-toggle");
  button.setAttribute("aria-expanded", String(!hidden));
  button.setAttribute("aria-label", hidden ? "Arată panourile" : "Ascunde panourile");
  button.title = hidden ? "Arată panourile" : "Ascunde panourile";
  if (hidden) {
    $("#results").hidden = true;
    closeInfo();
    closeContextMenu();
  }
}

function applyLayout() {
  const search = $(".search");
  const side = $(".side");
  $("#q").placeholder = isMobile() ? "Caută localitate, stradă, hidrant…" : "Localitate, stradă, adresă, obiectiv, coordonate";
  if (isMobile()) {
    if (search.parentElement !== $("#topbar")) $("#topbar").appendChild(search);
    if (!side.dataset.sheet) side.dataset.sheet = "peek";
  } else {
    if (search.parentElement !== side) side.insertBefore(search, $("#sheet-grip"));
    delete side.dataset.sheet;
    side.style.height = "";
  }
}

function sheetPx(name) {
  const side = $(".side");
  const pad = parseFloat(getComputedStyle(side).paddingBottom) || 0;
  const peek = $("#sheet-grip").offsetHeight + $(".tabs").offsetHeight + pad;
  if (name === "half") return Math.round(window.innerHeight * 0.48);
  if (name === "full") return window.innerHeight - ($("#topbar").getBoundingClientRect().bottom + 8);
  return peek;
}

function setSheet(name) {
  if (!isMobile()) return;
  if (name !== "peek") setMobileMapOnly(false);
  $(".side").dataset.sheet = name;
  if (name !== "peek") $("#results").hidden = true;
}

/** Spațiul ocupat de panouri peste hartă, ca obiectele căutate să nu ajungă sub ele. */
function viewPadding() {
  if (!isMobile()) return { top: 80, bottom: 60, left: 60, right: $("#info").hidden ? 60 : 400 };
  const info = $("#info");
  const chromeHidden = document.body.classList.contains("mobile-map-only");
  const top = chromeHidden ? 16 : Math.round($("#topbar").getBoundingClientRect().bottom + 12);
  const covered = Math.max(chromeHidden ? 0 : sheetPx($(".side").dataset.sheet || "peek"), info.hidden ? 0 : info.offsetHeight);
  const bottom = Math.min(covered + 16, window.innerHeight - top - 120);
  return { top, bottom: Math.max(bottom, 60), left: 16, right: chromeHidden ? 16 : 64 };
}

function initSheet() {
  const side = $(".side");
  let start = null;
  const onDown = (e) => {
    sheetDragged = false;
    if (!isMobile()) return;
    start = { y: e.clientY, h: side.getBoundingClientRect().height, t: performance.now() };
  };
  const onMove = (e) => {
    if (!start) return;
    const dy = e.clientY - start.y;
    if (!sheetDragged && Math.abs(dy) < 8) return;
    sheetDragged = true;
    side.classList.add("dragging");
    side.style.height = Math.max(sheetPx("peek"), Math.min(sheetPx("full"), start.h - dy)) + "px";
  };
  const onUp = (e) => {
    if (!start) return;
    if (sheetDragged) {
      const dy = e.clientY - start.y;
      const v = dy / Math.max(1, performance.now() - start.t);
      const h = start.h - dy;
      const H = { peek: sheetPx("peek"), half: sheetPx("half"), full: sheetPx("full") };
      let target = Object.keys(H).reduce((a, b) => (Math.abs(H[b] - h) < Math.abs(H[a] - h) ? b : a));
      if (v > 0.5) target = h > H.half + 40 ? "half" : "peek";
      else if (v < -0.5) target = h < H.half - 40 ? "half" : "full";
      side.classList.remove("dragging");
      side.style.height = "";
      setSheet(target);
    }
    start = null;
  };
  for (const el of [$("#sheet-grip"), $(".tabs")]) el.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
  $("#sheet-grip").addEventListener("click", () => {
    if (sheetDragged) return;
    const order = { peek: "half", half: "full", full: "peek" };
    setSheet(order[side.dataset.sheet] || "half");
  });
  MOBILE_MQ.addEventListener("change", () => { applyLayout(); map?.resize(); });
  applyLayout();
}

// ------------------------------------------------------------------ hartă

function applyStyle() {
  if (!map) return;
  map.setStyle(buildStyle(state), { diff: true });
}

function setOverlay(name, fc) {
  state.overlays[name] = fc;
  map.getSource(name)?.setData(fc);
}

function initMap() {
  map = new maplibregl.Map({
    container: "map",
    style: buildStyle(state),
    center: START_VIEW.center,
    zoom: START_VIEW.zoom,
    minZoom: 7,
    maxZoom: 19,
    maxBounds: [[24.9, 46.9], [28.4, 48.9]],
    hash: "harta",
    attributionControl: { compact: true },
    locale: {
      "NavigationControl.ZoomIn": "Mărește",
      "NavigationControl.ZoomOut": "Micșorează",
      "NavigationControl.ResetBearing": "Orientează spre nord",
      "AttributionControl.ToggleAttribution": "Surse",
    },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric", maxWidth: 120 }), "bottom-left");
  geolocate = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true, timeout: 15000 },
    trackUserLocation: true, showAccuracyCircle: true, fitBoundsOptions: { maxZoom: 16 },
  });
  map.addControl(geolocate, "top-right");
  geolocate.on("geolocate", (e) => {
    lastPosition = [e.coords.longitude, e.coords.latitude];
    $("#t-loc").setAttribute("aria-pressed", "true");
  });
  geolocate.on("trackuserlocationend", () => $("#t-loc").setAttribute("aria-pressed", "false"));
  geolocate.on("error", (e) => {
    $("#t-loc").setAttribute("aria-pressed", "false");
    toast(e.code === 1 ? "Permite accesul la locație din setările browserului." : "Nu am putut afla poziția. Încearcă din nou.");
  });

  // apăsare lungă pe ecran tactil = meniul de clic dreapta
  let press = null;
  const cancelPress = () => { if (press) { clearTimeout(press.timer); press = null; } };
  map.on("touchstart", (e) => {
    cancelPress();
    if (e.originalEvent.touches.length !== 1) return;
    const ev = { point: e.point, lngLat: e.lngLat, preventDefault() {} };
    press = { x: e.point.x, y: e.point.y, timer: setTimeout(() => {
      press = null;
      suppressClickUntil = Date.now() + 700;
      navigator.vibrate?.(15);
      openContextMenu(ev);
    }, 550) };
  });
  map.on("touchmove", (e) => {
    if (press && Math.hypot(e.point.x - press.x, e.point.y - press.y) > 10) cancelPress();
  });
  map.on("touchend", cancelPress);
  map.on("touchcancel", cancelPress);

  map.on("styleimagemissing", (e) => {
    const ic = icons[e.id];
    if (ic && !map.hasImage(e.id)) map.addImage(e.id, ic.image, ic.options);
  });
  map.once("load", () => $("#loading").remove());
  map.on("error", (e) => {
    if (e?.error?.status === 404) return; // tile lipsă în afara județului
    console.warn(e.error || e);
  });

  let raf = 0;
  map.on("mousemove", (e) => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const { lng, lat } = e.lngLat;
      $("#st-wgs").textContent = fmtLatLon(lng, lat);
      const s = fmtStereo(lng, lat);
      $("#st-s70").textContent = `X ${s.X}  Y ${s.Y}`;
      $("#st-uat").textContent = uatAt(lng, lat)?.name || "în afara județului";
      if (state.mode === "measure" && state.measure.length) drawMeasure([lng, lat]);
    });
  });
  const zoomTxt = () => ($("#st-zoom").textContent = map.getZoom().toFixed(1));
  map.on("zoom", zoomTxt);
  zoomTxt();

  const clickable = ["hydrant-icon", "hydrant-dot", "poi-major", "poi-minor", "pin", "hydro-line"];
  for (const id of clickable) {
    map.on("mouseenter", id, () => { if (!state.mode) map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", id, () => { if (!state.mode) map.getCanvas().style.cursor = ""; });
  }

  map.on("click", onMapClick);
  map.on("dblclick", (e) => {
    if (state.mode === "measure") { e.preventDefault(); finishMeasure(); }
  });
  map.on("contextmenu", (e) => { if (Date.now() > suppressClickUntil) openContextMenu(e); });
  map.on("movestart", closeContextMenu);
}

// prioritatea la clic: ce e deasupra și mai important câștigă
const PICK_ORDER = ["hydrant-icon", "hydrant-dot", "poi-major", "poi-minor", "pin", "buildings", "roads", "tracks", "rail",
  "hydro-line", "hydro-label", "dams", "rivers", "streams", "water", "places", "landuse"];

function onMapClick(e) {
  if (Date.now() < suppressClickUntil) return;
  closeContextMenu();
  if (pendingPick) {
    const cb = pendingPick;
    pendingPick = null;
    map.getCanvas().style.cursor = "";
    cb([e.lngLat.lng, e.lngLat.lat]);
    return;
  }
  if (operations?.handleMapClick(e)) return;
  const ll = [e.lngLat.lng, e.lngLat.lat];
  if (state.mode === "measure") return addMeasurePoint(ll);
  if (state.mode === "pick") { setMode(null); return analyzePoint(ll); }

  const box = [[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]];
  const layers = PICK_ORDER.filter((id) => map.getLayer(id) && map.getLayoutProperty(id, "visibility") !== "none");
  const feats = map.queryRenderedFeatures(box, { layers });
  feats.sort((a, b) => PICK_ORDER.indexOf(a.layer.id) - PICK_ORDER.indexOf(b.layer.id));
  const f = feats[0];
  if (f?.layer.id === "pin" && state.analysis) return selectTab("analiza");
  showInfo(f || null, ll);
}

// ------------------------------------------------------------------ fișa de informații

const ICON = {
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 3 18 18M10.6 5.1A12.5 12.5 0 0 1 12 5c6.5 0 10 7 10 7a19 19 0 0 1-3.1 4.1M6.2 6.2A20 20 0 0 0 2 12s3.5 7 10 7a12 12 0 0 0 5.8-1.8M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>',
  target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/></svg>',
  ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  gps: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M21 3L3 10.5l7.5 3 3 7.5z"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>',
  ruler: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 17L17 3l4 4L7 21z"/><path d="M7 13l2 2M10 10l2 2M13 7l2 2"/></svg>',
};

function osmLink(ref) {
  if (!ref) return null;
  const t = { n: "node", w: "way", r: "relation" }[ref[0]];
  return t ? `https://www.openstreetmap.org/${t}/${ref.slice(1)}` : null;
}

function describe(f) {
  const p = f.properties || {};
  const id = f.layer.id;
  const rows = [];
  const add = (k, v, cls) => { if (v !== undefined && v !== null && v !== "") rows.push([k, v, cls]); };

  if (id.startsWith("hydrant")) {
    for (const [k, v] of Object.entries(p)) {
      if (k.startsWith("_") || k === "Nr") continue;
      if (typeof v === "string" && /^https?:\/\//.test(v)) add(k, `<a href="${esc(v)}" target="_blank" rel="noopener">Deschide</a>`, "html");
      else add(k, v, k === "Stare" && p._stare === "defect" ? "warn" : undefined);
    }
    add("UAT", p._uat);
    const st = { ok: "funcțional", defect: "NEFUNCȚIONAL", necunoscut: "stare nespecificată" }[p._stare] || "";
    return { title: `Hidrant ${p._label}`, kind: `Hidrant ISU · ${st}`, icon: iconDataURL(p._stare === "defect" ? "hidranti-off" : "hidranti", 26), rows };
  }
  if (id.startsWith("poi")) {
    const c = POI[p.cat];
    if (p.official) {
      add("Tip", p.typeLabel); add("Adresă", p.addr); add("Telefon", p.phone);
      add("Tehnică din dotare", p.equipment); add("Efectiv pe tură", p.staff); add("Observații", p.notes);
      return { title: p.name, kind: "Subunitate ISU · listă oficială", icon: iconDataURL(p.cat, 26), rows };
    }
    add("Operator", p.operator); add("Adresă", p.addr); add("Telefon", p.phone); add("Cod", p.ref);
    add("Înălțime", p.height && `${p.height} m`); add("UAT", p.uat);
    if (p.website) add("Site", `<a href="${esc(p.website)}" target="_blank" rel="noopener">${esc(p.website.replace(/^https?:\/\//, ""))}</a>`, "html");
    return { title: p.name || c.label, kind: c.label, icon: iconDataURL(p.cat, 26), rows, osm: p.osm };
  }
  if (id === "buildings" || id === "buildings-bloc-line") {
    add("Nivele", p.levels); add("Adresă", p.addr); add("Înălțime", p.height && `${p.height} m`);
    add("Material", p.material); add("Acoperiș", p.roof);
    if (p.b && p.b !== "yes") add("Etichetă OSM", p.b);
    return { title: p.name || p.addr || LABELS.building[p.kind], kind: LABELS.building[p.kind], rows, osm: p.osm };
  }
  if (id === "roads" || id === "tracks") {
    add("Număr drum", p.ref); add("Denumire", p.name);
    add("Îmbrăcăminte", LABELS.surface[p.surface] || p.surface);
    if (p.bridge) add("Pod", "da");
    if (p.tunnel) add("Tunel", "da");
    if (p.oneway) add("Sens unic", "da");
    add("Tonaj maxim", formatRestriction(p, "maxweight", "t"), "warn");
    add("Înălțime maximă", formatRestriction(p, "maxheight", "m"), "warn");
    add("Lățime maximă", formatRestriction(p, "maxwidth", "m"), "warn");
    const title = [p.ref, p.name].filter(Boolean).join(" · ") || LABELS.road[p.cls];
    return { title, kind: LABELS.road[p.cls] + (p.bridge ? " · pod" : ""), rows, osm: p.osm };
  }
  if (id === "rail") return { title: p.name || "Cale ferată", kind: "Cale ferată", rows };
  if (id === "hydro-line" || id === "hydro-label") {
    // queryRenderedFeatures dă doar bucata din tile și listele ca text JSON: fișa se ia din cadastrul întreg, după cod
    const course = courseIndex(state.data.hydrography).get(p.code) ?? f;
    return { title: course.properties.name, kind: "Curs de apă · cadastrul apelor (ABA)",
      rows: courseRows(course, state.data.hydrography), geometry: course.geometry };
  }
  if (["rivers", "streams", "dams", "water"].includes(id)) {
    add("Suprafață", p.area_ha && `${p.area_ha.toLocaleString("ro-RO")} ha`);
    if (p.intermittent) add("Regim", "temporar (seacă vara)");
    return { title: p.name || LABELS.water[p.kind], kind: LABELS.water[p.kind], rows, osm: p.osm };
  }
  if (id === "places") {
    add("Populație", p.population && p.population.toLocaleString("ro-RO"));
    return { title: p.name, kind: LABELS.place[p.kind] || "Localitate", rows };
  }
  if (id === "landuse") return { title: LABELS.landuse[p.kind], kind: "Folosința terenului", rows };
  return { title: "Obiect", kind: id, rows };
}

function coordsBlock(ll) {
  const [lon, lat] = ll;
  const s = fmtStereo(lon, lat);
  return `<div class="coords">
    <div><span class="k">WGS84</span><span class="v">${fmtLatLon(lon, lat)}</span><button data-copy="${fmtLatLon(lon, lat)}" title="Copiază">${ICON.copy}</button></div>
    <div><span class="k">GMS</span><span class="v">${fmtDMS(lon, lat)}</span><button data-copy="${fmtDMS(lon, lat)}" title="Copiază">${ICON.copy}</button></div>
    <div><span class="k">Stereo 70</span><span class="v">X ${s.X} · Y ${s.Y}</span><button data-copy="X ${s.raw.split(" ")[0]}  Y ${s.raw.split(" ")[1]}" title="Copiază">${ICON.copy}</button></div>
  </div>`;
}

function extLinks(ll) {
  const [lon, lat] = ll.map((v) => v.toFixed(6));
  return `<a class="btn" href="https://www.google.com/maps/search/?api=1&query=${lat},${lon}" target="_blank" rel="noopener">${ICON.ext}Google Maps</a>
    <a class="btn" href="https://www.waze.com/ul?ll=${lat},${lon}&navigate=yes" target="_blank" rel="noopener">${ICON.ext}Waze</a>`;
}

function showInfo(f, clickLL) {
  const box = $("#info");
  let ll = clickLL;
  let d;
  if (f) {
    d = describe(f);
    if (f.geometry.type === "Point") ll = f.geometry.coordinates;
    const geom = f.layer.id === "landuse" ? { type: "Point", coordinates: ll } : d.geometry ?? f.geometry;
    setOverlay("sel", { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: geom }] });
  } else {
    const u = uatAt(...ll);
    d = { title: "Punct pe hartă", kind: u ? `UAT ${u.name}` : "În afara județului", rows: [] };
    setOverlay("sel", { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: ll } }] });
  }
  const uat = uatAt(...ll);
  if (f && !d.rows.some(([k]) => k === "UAT") && uat) d.rows.push(["UAT", uat.name]);
  const osm = osmLink(d.osm);
  const isPlace = f?.layer?.id === "places" && f?.properties?.name;
  box.innerHTML = `
    <div class="info-h">
      ${d.icon ? `<img src="${d.icon}" alt="">` : ""}
      <div class="t"><h2>${esc(d.title)}</h2>${d.kind && d.kind !== d.title ? `<span class="kind">${esc(d.kind)}</span>` : ""}</div>
      <button class="x" data-act="close" aria-label="Închide">×</button>
    </div>
    ${d.rows.length ? `<dl class="attrs">${d.rows.map(([k, v, cls]) =>
      `<dt>${esc(k)}</dt><dd class="${cls === "warn" ? "warn" : ""}">${cls === "html" ? v : esc(v)}</dd>`).join("")}</dl>` : ""}
    ${coordsBlock(ll)}
    <div class="info-a">
      <button class="btn primary" data-act="analyze">${ICON.target}Analizează punctul</button>
      ${isPlace ? `<button class="btn" data-act="focus-place">${ICON.ext}Focalizează satul · ${esc(f.properties.name)}</button>` : ""}
      ${uat ? `<button class="btn commune-trigger" data-act="commune">${ICON.ext}Focalizează UAT · ${esc(uat.name)}</button>` : ""}
      ${extLinks(ll)}
      ${osm ? `<a class="btn" href="${osm}" target="_blank" rel="noopener">${ICON.ext}OSM</a>` : ""}
    </div>`;
  box.hidden = false;
  box.scrollTop = 0;
  setSheet("peek");
  box.onclick = (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    if (b.dataset.copy) copy(b.dataset.copy);
    if (b.dataset.act === "close") closeInfo();
    if (b.dataset.act === "analyze") analyzePoint(ll);
    if (b.dataset.act === "focus-place" && isPlace) {
      state.focusPlace?.({ name: f.properties.name, lon: ll[0], lat: ll[1], uat: uat?.name });
    }
    if (b.dataset.act === "commune") openCommuneMap({ uat, state, icons });
  };
}

function closeInfo() {
  $("#info").hidden = true;
  setOverlay("sel", FC());
}

// ------------------------------------------------------------------ analiza unui punct

const NEAR_GROUPS = [
  { key: "hid", title: "Hidranți ISU utilizabili", n: 5, color: "#c8102e" },
  { key: "pompieri", title: "Subunități ISU", n: 2, color: "#8e1018" },
  { key: "spital", title: "Spitale", n: 2, color: "#b0174a" },
  { key: "ambulanta", title: "Ambulanță", n: 1 },
  { key: "politie", title: "Poliție", n: 2 },
  { key: "jandarmerie", title: "Jandarmerie", n: 1 },
  { key: "sursa_apa", title: "Surse de apă (OSM)", n: 3, color: "#2a8bd0" },
];

function nearest(ll, features, n) {
  return features
    .map((f) => ({ f, d: distance(ll, f.geometry.coordinates) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n);
}

function nearestPlace(ll) {
  let best = null;
  for (const it of search.items) {
    if (!it.type.startsWith("loc:") || it.type === "loc:locality") continue;
    const d = distance(ll, [it.lon, it.lat]);
    if (!best || d < best.d) best = { it, d };
  }
  return best;
}

function analyzePoint(ll, radius = state.analysis?.radius || null) {
  closeContextMenu();
  const uat = uatAt(...ll);
  const groups = [];
  const lines = [];
  for (const g of NEAR_GROUPS) {
    const feats = g.key === "hid" ? state.data.hydrants.features.filter((f) => f.properties._stare !== "defect")
      : state.data.pois.features.filter((f) => f.properties.cat === g.key);
    if (!feats.length) { groups.push({ ...g, items: [] }); continue; }
    const items = nearest(ll, feats, g.n);
    groups.push({ ...g, items });
    if (g.color) {
      const limit = g.key === "hid" ? 3 : g.key === "sursa_apa" ? 1 : 1;
      for (const { f, d } of items.slice(0, limit)) {
        lines.push({ type: "Feature", properties: { role: "link", color: g.color, label: fmtDistance(d) },
          geometry: { type: "LineString", coordinates: [ll, f.geometry.coordinates] } });
      }
    }
  }
  const defectNear = state.data.hydrants.features.filter((f) => f.properties._stare === "defect" && distance(ll, f.geometry.coordinates) <= 500).length;
  state.analysis = { ll, uat: uat?.name || null, place: nearestPlace(ll), groups, lines, radius, inRadius: null, defectNear };
  setOverlay("pin", { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: ll } }] });
  map.setFilter("uat-hover", ["==", ["get", "name"], uat?.name || ""]);
  state.hoverUat = uat?.name || "";
  drawAnalysis();
  renderAnalysis();
  selectTab("analiza");
  $("#tb-analiza").innerHTML = '<span class="t-long">Analiză punct</span><span class="t-short">Analiză</span><span class="badge"></span>';
  if (radius) applyRadius(radius);
  else {
    const pts = [ll, ...lines.map((l) => l.geometry.coordinates[1])];
    fitTo(pts, 15);
  }
}

function fitTo(points, maxZoom) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]],
    { padding: viewPadding(), maxZoom, duration: 600 });
}

function drawAnalysis() {
  const a = state.analysis;
  const feats = a ? [...a.lines] : [];
  if (a?.radius) feats.unshift({ type: "Feature", properties: { role: "radius" }, geometry: circle(a.ll, a.radius) });
  setOverlay("analysis", { type: "FeatureCollection", features: feats });
}

function applyRadius(radius) {
  const a = state.analysis;
  if (!a) return;
  a.radius = radius;
  a.inRadius = radius ? { pending: true } : null;
  drawAnalysis();
  renderAnalysis();
  if (!radius) return;
  const ring = circle(a.ll, radius).coordinates[0];
  fitTo(ring, 17);
  map.once("idle", () => {
    if (state.analysis !== a || a.radius !== radius) return;
    a.inRadius = countInRadius(a.ll, radius);
    renderAnalysis();
  });
}

function countInRadius(ll, radius) {
  const res = { buildings: {}, totalB: 0, blocLevels: 0, pois: {}, hydrants: 0, partial: map.getZoom() < 13 };
  if (!res.partial) {
    const seen = new Set();
    for (const f of map.querySourceFeatures("osm", { sourceLayer: "buildings" })) {
      const p = f.properties;
      const key = p.osm || JSON.stringify(f.geometry.coordinates[0]?.[0]);
      if (seen.has(key)) continue;
      const ring = f.geometry.type === "Polygon" ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
      let x = 0, y = 0;
      for (const c of ring) { x += c[0]; y += c[1]; }
      if (distance(ll, [x / ring.length, y / ring.length]) > radius) continue;
      seen.add(key);
      res.buildings[p.kind] = (res.buildings[p.kind] || 0) + 1;
      res.totalB++;
      if (p.kind === "bloc") res.blocLevels += p.levels || 0;
    }
  }
  for (const f of state.data.pois.features) {
    if (distance(ll, f.geometry.coordinates) <= radius) res.pois[f.properties.cat] = (res.pois[f.properties.cat] || 0) + 1;
  }
  res.hydrantsOff = 0;
  for (const f of state.data.hydrants.features) {
    if (distance(ll, f.geometry.coordinates) > radius) continue;
    if (f.properties._stare === "defect") res.hydrantsOff++; else res.hydrants++;
  }
  return res;
}

function renderAnalysis() {
  const el = $("#tab-analiza");
  const a = state.analysis;
  if (!a) {
    el.innerHTML = `<div class="an-empty"><strong>Niciun punct analizat</strong>
      Alege un punct pe hartă ca să vezi cei mai apropiați hidranți, subunitatea ISU, spitalul și poliția.
      <div class="row-btns" style="justify-content:center">
        <button class="btn primary" data-act="pick">${ICON.target}Alege un punct</button>
        <button class="btn" data-act="here">${ICON.gps}Poziția mea</button>
      </div>
      <p class="muted" style="margin-top:14px">Sau: clic dreapta pe hartă (pe telefon: apasă lung) → Analizează punctul</p></div>`;
    el.onclick = (e) => {
      if (e.target.closest("[data-act=pick]")) { setMode("pick"); setSheet("peek"); }
      if (e.target.closest("[data-act=here]")) analyzeMyPosition();
    };
    return;
  }
  const [lon, lat] = a.ll;
  const place = a.place;
  const placeTxt = place
    ? (place.d < 400 ? `în ${place.it.label}` : `la ${fmtDistance(place.d)} ${direction(bearing([place.it.lon, place.it.lat], a.ll))} de ${place.it.label}`)
    : "";
  const groupHtml = a.groups.map((g) => {
    if (!g.items.length) {
      if (g.key === "hid") return `<h3>${g.title}</h3><p class="muted">Lista de hidranți nu a fost încă adăugată.</p>`;
      return "";
    }
    const icon = g.key === "hid" ? iconDataURL("hidranti", 20) : iconDataURL(g.key, 20);
    const extra = g.key === "hid" && a.defectNear ? `<p class="warnp" style="margin:2px 6px 4px">${a.defectNear} ${a.defectNear === 1 ? "hidrant nefuncțional" : "hidranți nefuncționali"} pe o rază de 500 m (excluși din listă).</p>` : "";
    return `<h3>${g.title}</h3>${extra}<ul class="near">${g.items.map(({ f, d }) => {
      const p = f.properties;
      const name = g.key === "hid" ? `Hidrant ${p._label}` : (p.name || POI[g.key].label);
      const sub = g.key === "hid" ? hydrantSummary(p) : (p.addr || p.uat || "");
      const dir = direction(bearing(a.ll, f.geometry.coordinates));
      return `<li data-ll="${f.geometry.coordinates.join(",")}" data-src="${g.key === "hid" ? "hid" : "poi"}" data-id="${f.id}">
        <img src="${icon}" alt=""><div style="min-width:0"><div class="n-name">${esc(name)}</div><div class="n-sub">${esc(sub)}</div></div>
        <div class="n-d">${fmtDistance(d)}<small>${dir}</small></div></li>`;
    }).join("")}</ul>`;
  }).join("");

  const r = a.inRadius;
  let radiusHtml = "";
  if (a.radius && r?.pending) radiusHtml = `<p class="muted">Se numără clădirile din rază…</p>`;
  else if (a.radius && r) {
    const b = r.buildings;
    const order = ["bloc", "casa", "public", "industrial", "comercial", "cult", "anexa", "altele"];
    const poiRows = Object.entries(r.pois).sort((x, y) => y[1] - x[1])
      .map(([c, n]) => `<dt>${POI[c].label}</dt><dd>${n}</dd>`).join("");
    radiusHtml = `<dl class="stats">
      ${r.partial ? `<dt>Clădiri</dt><dd>–</dd>` : `<dt><b>Clădiri în rază</b></dt><dd>${r.totalB}</dd>
      ${order.filter((k) => b[k]).map((k) => `<dt>${LABELS.building[k]}</dt><dd>${b[k]}</dd>`).join("")}
      ${b.bloc && r.blocLevels ? `<dt>Nivele însumate (blocuri)</dt><dd>${r.blocLevels}</dd>` : ""}`}
      <dt><b>Hidranți ISU utilizabili în rază</b></dt><dd>${r.hydrants}</dd>
      ${r.hydrantsOff ? `<dt>Hidranți nefuncționali în rază</dt><dd>${r.hydrantsOff}</dd>` : ""}
      ${poiRows}
    </dl>
    ${r.partial ? `<p class="muted">Raza e prea mare ca să număr clădirile. Alege o rază mai mică.</p>` :
      `<p class="muted">Clădirile sunt cele cartate în OpenStreetMap; în unele sate lipsesc.</p>`}`;
  }

  el.innerHTML = `<div class="an">
    <h3>Punct analizat</h3>
    <div class="where">${a.uat ? `UAT ${esc(a.uat)}` : "În afara județului"}<small>${esc(placeTxt)}</small></div>
    ${coordsBlock(a.ll).replace('class="coords"', 'class="coords" style="margin:10px 0 0"')}
    ${groupHtml}
    <h3>Zonă în jurul punctului</h3>
    <div class="chips">${[50, 100, 250, 500, 1000, 2000].map((m) =>
      `<button class="chip" data-r="${m}" aria-pressed="${a.radius === m}">${m < 1000 ? m + " m" : m / 1000 + " km"}</button>`).join("")}
      ${a.radius ? `<button class="chip" data-r="0">Fără rază</button>` : ""}</div>
    ${radiusHtml}
    <div class="row-btns">
      <button class="btn" data-act="summary">${ICON.copy}Copiază rezumatul</button>
      ${extLinks(a.ll)}
      <button class="btn" data-act="clear">Șterge analiza</button>
    </div>
  </div>`;
  el.onclick = (e) => {
    const li = e.target.closest("li[data-ll]");
    if (li) {
      const ll2 = li.dataset.ll.split(",").map(Number);
      const src = li.dataset.src === "hid" ? state.data.hydrants : state.data.pois;
      const f = src.features.find((x) => String(x.id) === li.dataset.id);
      if (f) showInfo({ ...f, layer: { id: li.dataset.src === "hid" ? "hydrant-icon" : "poi-major" } }, ll2);
      map.flyTo({ center: ll2, zoom: Math.max(map.getZoom(), 17), duration: 700, padding: viewPadding() });
      return;
    }
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.copy) copy(b.dataset.copy);
    if (b.dataset.r !== undefined) applyRadius(+b.dataset.r || null);
    if (b.dataset.act === "summary") copy(analysisSummary(), "Rezumatul a fost copiat");
    if (b.dataset.act === "clear") clearAnalysis();
  };
}

function hydrantSummary(p) {
  const tip = [p["Poziție"], p.Tip && "tip " + p.Tip].filter(Boolean).join(" ");
  const parts = [p._stare === "necunoscut" ? "stare nespecificată" : null, tip, p.Reper, p.Localitate].filter(Boolean);
  if (parts.length) return parts.join(" · ");
  return Object.entries(p).filter(([k, v]) => !k.startsWith("_") && v !== "" && !/^(x|y|lat|lon|latitudine|longitudine|nr|cod|id)$/i.test(k))
    .slice(0, 3).map(([, v]) => v).join(" · ");
}

function analysisSummary() {
  const a = state.analysis;
  const [lon, lat] = a.ll;
  const s = fmtStereo(lon, lat);
  const out = [`Punct: ${fmtLatLon(lon, lat)} (Stereo 70: X ${s.raw.split(" ")[0]} Y ${s.raw.split(" ")[1]})`];
  if (a.uat) out.push(`UAT: ${a.uat}`);
  if (a.place) out.push(`Localitate apropiată: ${a.place.it.label} (${fmtDistance(a.place.d)})`);
  for (const g of a.groups) {
    if (!g.items.length) continue;
    out.push(`${g.title}: ` + g.items.map(({ f, d }) =>
      `${g.key === "hid" ? "H" + f.properties._label : f.properties.name || POI[g.key].label} ${fmtDistance(d)}`).join("; "));
  }
  if (a.radius && a.inRadius && !a.inRadius.pending) {
    const r = a.inRadius;
    out.push(`Rază ${fmtDistance(a.radius)}: ${r.partial ? "" : r.totalB + " clădiri (" + (r.buildings.bloc || 0) + " blocuri), "}${r.hydrants} hidranți`);
  }
  out.push(`https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lon.toFixed(6)}`);
  out.push("Distanțe în linie dreaptă.");
  return out.join("\n");
}

function analyzeMyPosition() {
  if (!window.isSecureContext || !navigator.geolocation) return toast("Localizarea funcționează doar pe conexiune securizată (https).");
  toast("Se caută poziția…");
  navigator.geolocation.getCurrentPosition(
    (p) => { lastPosition = [p.coords.longitude, p.coords.latitude]; analyzePoint(lastPosition); },
    (err) => toast(err.code === 1 ? "Permite accesul la locație din setările browserului." : "Nu am putut afla poziția. Încearcă din nou."),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
}

function clearAnalysis() {
  state.analysis = null;
  setOverlay("analysis", FC());
  setOverlay("pin", FC());
  map.setFilter("uat-hover", ["==", ["get", "name"], ""]);
  state.hoverUat = "";
  $("#tb-analiza").innerHTML = '<span class="t-long">Analiză punct</span><span class="t-short">Analiză</span>';
  renderAnalysis();
}

// ------------------------------------------------------------------ măsurare

function setMode(mode) {
  operations?.cancelDrawing();
  if (state.mode === "measure" && mode !== "measure") finishMeasure(true);
  state.mode = mode;
  $("#map").classList.toggle("picking", !!mode);
  map.getCanvas().style.cursor = mode ? "crosshair" : "";
  $("#t-masoara").setAttribute("aria-pressed", mode === "measure");
  $("#t-analiza").setAttribute("aria-pressed", mode === "pick");
  const bar = $("#modebar");
  if (mode) setSheet("peek");
  if (mode === "pick") {
    bar.innerHTML = `<span class="mb-t">${isMobile() ? "Atinge harta pe locul de analizat" : "Clic pe hartă pe locul de analizat"}</span> <button data-act="cancel">Anulează</button>`;
    bar.hidden = false;
  } else if (mode === "measure") {
    map.doubleClickZoom.disable();
    state.measure = [];
    drawMeasure();
  } else {
    bar.hidden = true;
    map.doubleClickZoom.enable();
  }
}

function measureTotal(pts) {
  let t = 0;
  for (let i = 1; i < pts.length; i++) t += distance(pts[i - 1], pts[i]);
  return t;
}

function drawMeasure(hover) {
  const pts = state.measure;
  const line = hover && state.mode === "measure" ? [...pts, hover] : pts;
  const feats = [];
  if (line.length > 1) feats.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line } });
  let acc = 0;
  pts.forEach((p, i) => {
    if (i) acc += distance(pts[i - 1], p);
    feats.push({ type: "Feature", properties: i ? { label: fmtDistance(acc) } : {}, geometry: { type: "Point", coordinates: p } });
  });
  setOverlay("measure", { type: "FeatureCollection", features: feats });
  const bar = $("#modebar");
  if (state.mode === "measure") {
    const tot = measureTotal(line);
    bar.innerHTML = pts.length
      ? `<span class="mb-t"><span class="desk-only">Distanță </span><strong>${fmtDistance(tot)}</strong></span>
         <button data-act="undo">Înapoi</button><button data-act="finish">Gata</button><button data-act="cancel">Anulează</button>`
      : `<span class="mb-t">${isMobile() ? "Atinge harta pentru primul punct" : "Clic pe hartă pentru primul punct · dublu clic sau Esc pentru a termina"}</span> <button data-act="cancel">Anulează</button>`;
    bar.hidden = false;
  }
}

function addMeasurePoint(ll) {
  state.measure.push(ll);
  drawMeasure();
}

function finishMeasure(silent) {
  const pts = state.measure;
  const tot = measureTotal(pts);
  state.mode = null;
  $("#map").classList.remove("picking");
  map.getCanvas().style.cursor = "";
  $("#t-masoara").setAttribute("aria-pressed", "false");
  setTimeout(() => map.doubleClickZoom.enable(), 0);
  const bar = $("#modebar");
  if (pts.length > 1 && !silent) {
    bar.innerHTML = `<span class="mb-t"><span class="desk-only">Distanță măsurată </span><strong>${fmtDistance(tot)}</strong></span>
      <button data-copy="${fmtDistance(tot)}">Copiază</button><button data-act="clearmeasure">Șterge</button>`;
    bar.hidden = false;
  } else {
    bar.hidden = true;
    setOverlay("measure", FC());
  }
}

// ------------------------------------------------------------------ meniu contextual

function openContextMenu(e) {
  e.preventDefault();
  const ll = [e.lngLat.lng, e.lngLat.lat];
  const m = $("#ctx");
  const s = fmtStereo(...ll);
  const uat = uatAt(...ll);
  const nearP = nearestPlace(ll);
  const nearPlace = nearP && nearP.d <= 1200 ? nearP.it : null;
  m.innerHTML = `<div class="hd">${fmtLatLon(...ll)}</div>
    <button data-act="analyze">${ICON.target}Analizează punctul</button>
    <button data-act="info">${ICON.info}Coordonate și UAT</button>
    ${nearPlace ? `<button data-act="focus-place">${ICON.ext}Focalizează satul · ${esc(nearPlace.label)}</button>` : ""}
    ${uat ? `<button data-act="commune">${ICON.ext}Focalizează UAT · ${esc(uat.name)}</button>` : ""}
    <button data-act="measure">${ICON.ruler}Măsoară de aici</button>
    <hr>
    <button data-copy="${fmtLatLon(...ll)}">${ICON.copy}Copiază WGS84</button>
    <button data-copy="X ${s.raw.split(" ")[0]}  Y ${s.raw.split(" ")[1]}">${ICON.copy}Copiază Stereo 70</button>
    <button data-act="gmaps">${ICON.ext}Deschide în Google Maps</button>`;
  const wrap = $(".mapwrap").getBoundingClientRect();
  m.hidden = false;
  const x = Math.min(e.point.x, wrap.width - m.offsetWidth - 8);
  const y = Math.min(e.point.y, wrap.height - m.offsetHeight - 40);
  m.style.left = x + "px";
  m.style.top = y + "px";
  m.querySelector("button").focus({ preventScroll: true });
  m.onclick = (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    closeContextMenu();
    if (b.dataset.copy) copy(b.dataset.copy);
    if (b.dataset.act === "analyze") analyzePoint(ll);
    if (b.dataset.act === "info") showInfo(null, ll);
    if (b.dataset.act === "focus-place" && nearPlace) {
      state.focusPlace?.({ name: nearPlace.label, lon: nearPlace.lon, lat: nearPlace.lat, uat: uat?.name });
    }
    if (b.dataset.act === "commune") openCommuneMap({ uat, state, icons });
    if (b.dataset.act === "measure") { setMode("measure"); addMeasurePoint(ll); }
    if (b.dataset.act === "gmaps") window.open(`https://www.google.com/maps/search/?api=1&query=${ll[1].toFixed(6)},${ll[0].toFixed(6)}`, "_blank", "noopener");
  };
}

function closeContextMenu() {
  $("#ctx").hidden = true;
}

// ------------------------------------------------------------------ panoul de straturi

function swatch(item) {
  const p = PALETTES[state.theme];
  const [kind, key] = item.id.split(":");
  if (kind === "poi") return `<img src="${iconDataURL(key, 20)}" alt="">`;
  if (item.id === "hidranti") return `<img src="${iconDataURL("hidranti", 20)}" alt="">`;
  if (item.id === "hidranti_defecti") return `<img src="${iconDataURL("hidranti-off", 20)}" alt="">`;
  if (kind === "road") {
    const dash = key === "track" ? `background:repeating-linear-gradient(90deg,${p.road.track} 0 5px,transparent 5px 8px)` : `background:${p.road[key]}`;
    const h = { dn: 6, dj: 5, dc: 4, local: 4, street: 3, service: 2, track: 3 }[key];
    return `<i class="ln" style="height:${h}px;${dash};box-shadow:0 0 0 1px ${p.casing[key]}"></i>`;
  }
  if (kind === "bld") return `<i class="sq" style="background:${p.bld[key]};box-shadow:inset 0 0 0 1px ${key === "bloc" ? p.bldBlocLine : p.bldLine}"></i>`;
  const solid = {
    rail: `<i class="ln" style="height:3px;background:repeating-linear-gradient(90deg,${p.rail} 0 5px,${p.railDash} 5px 9px);box-shadow:0 0 0 1px ${p.rail}"></i>`,
    roadlabels: `<i class="sq" style="background:#c93a31;width:20px;height:12px;border-radius:3px"></i>`,
    water: `<i class="sq" style="background:${p.water};box-shadow:inset 0 0 0 1px ${p.waterLine}"></i>`,
    rivers: `<i class="ln" style="height:3px;background:${p.waterLine}"></i>`,
    cadastru: `<i class="ln" style="height:3px;background:${p.hydro}"></i>`,
    streams: `<i class="ln" style="height:1.5px;background:${p.waterLine}"></i>`,
    dams: `<i class="ln" style="height:4px;background:#5d5d5d"></i>`,
    places: `<b style="font-size:12px">Aa</b>`,
    uat: `<i class="ln" style="height:0;border-top:2px dashed ${p.uat}"></i>`,
    landuse: `<i class="sq" style="background:${p.forest}"></i>`,
  };
  return solid[item.id] || "";
}

function itemCount(item) {
  const [kind, key] = item.id.split(":");
  if (kind === "poi") return state.data.pois.features.filter((f) => f.properties.cat === key).length;
  if (item.id === "hidranti") return state.data.hydrants.features.filter((f) => f.properties._stare !== "defect").length;
  if (item.id === "hidranti_defecti") return state.data.hydrants.features.filter((f) => f.properties._stare === "defect").length;
  if (item.id === "cadastru") return state.data.hydrography.features.length;
  if (kind === "bld") return stats?.counts?.["cladire_" + key] ?? null;
  return null;
}

function applyPreset(presetId) {
  const p = LAYER_PRESETS.find((x) => x.id === presetId);
  if (!p) return;
  const set = p.layers ? new Set(p.layers) : null;
  for (const g of LAYER_GROUPS) {
    for (const it of g.items) {
      state.visible[it.id] = set ? set.has(it.id) : true;
    }
  }
  store.set("visible.v2", state.visible);
  applyStyle();
  renderLayerPanel();
}

function activePresetId() {
  const allIds = [];
  for (const g of LAYER_GROUPS) for (const it of g.items) allIds.push(it.id);
  for (const p of LAYER_PRESETS) {
    if (!p.layers) {
      if (allIds.every((id) => state.visible[id])) return p.id;
      continue;
    }
    const set = new Set(p.layers);
    if (allIds.every((id) => Boolean(state.visible[id]) === set.has(id))) return p.id;
  }
  return "";
}

function renderLayerPanel() {
  const el = $("#tab-straturi");
  const curPreset = activePresetId();
  const presetsHtml = `<div class="grp preset-grp">
    <div class="grp-h"><h2>Profiluri CJSU (1-click)</h2></div>
    <div class="preset-chips">${LAYER_PRESETS.map((p) =>
      `<button type="button" class="chip" data-preset="${esc(p.id)}" aria-pressed="${curPreset === p.id}" title="${esc(p.hint || "")}">${esc(p.label)}</button>`
    ).join("")}</div>
  </div>`;
  el.innerHTML = presetsHtml + LAYER_GROUPS.map((g) => {
    return `<div class="grp" data-group="${g.id}">
      <div class="grp-h"><h2>${g.label}</h2><button type="button" data-grp="${g.id}"></button></div>
      ${g.items.map((it) => {
        const n = itemCount(it);
        const on = !!state.visible[it.id];
        const missing = { hidranti: "Lista nu a fost încă adăugată.", cadastru: "Cadastrul apelor nu este încărcat." }[it.id];
        const note = missing && !n ? `<div class="note">${missing}</div>` : "";
        return `<label class="li ${on ? "" : "off"}"><input type="checkbox" data-id="${it.id}" ${on ? "checked" : ""}>
          <span class="sw">${swatch(it)}</span><span class="lbl">${itemLabel(it)}</span>
          <span class="cnt">${n != null ? n.toLocaleString("ro-RO") : ""}</span></label>${note}`;
      }).join("")}
    </div>`;
  }).join("");
  renderLayerPanelHeaders();
  el.onchange = (e) => {
    const id = e.target.dataset.id;
    if (!id) return;
    state.visible[id] = e.target.checked;
    store.set("visible.v2", state.visible);
    e.target.closest(".li").classList.toggle("off", !e.target.checked);
    applyStyle();
    renderLayerPanelHeaders();
  };
  el.onclick = (e) => {
    const pb = e.target.closest("button[data-preset]");
    if (pb) {
      applyPreset(pb.dataset.preset);
      return;
    }
    const b = e.target.closest("button[data-grp]");
    if (!b) return;
    const g = LAYER_GROUPS.find((x) => x.id === b.dataset.grp);
    const allOn = g.items.every((it) => state.visible[it.id]);
    for (const it of g.items) state.visible[it.id] = !allOn;
    store.set("visible.v2", state.visible);
    applyStyle();
    renderLayerPanel();
  };
}

function renderLayerPanelHeaders() {
  for (const b of document.querySelectorAll("button[data-grp]")) {
    const g = LAYER_GROUPS.find((x) => x.id === b.dataset.grp);
    const allOn = g.items.every((it) => state.visible[it.id]);
    const label = `${allOn ? "Ascunde tot" : "Arată tot"} · ${g.label}`;
    b.innerHTML = allOn ? ICON.eyeOff : ICON.eye;
    b.title = label;
    b.setAttribute("aria-label", label);
    b.setAttribute("aria-pressed", String(allOn));
  }
}

// ------------------------------------------------------------------ căutare

function initSearch() {
  const input = $("#q");
  const list = $("#results");
  let results = [];
  let active = 0;
  let timer = 0;

  const render = () => {
    if (!input.value.trim()) { list.hidden = true; return; }
    if (!results.length) {
      list.innerHTML = `<li class="empty">Niciun rezultat pentru „${esc(input.value.trim())}”.</li>`;
      list.hidden = false;
      return;
    }
    list.innerHTML = results.map((r, i) => {
      const t = r.coord ? { label: r.kind, cls: "t-coord" } : typeInfo(r.type);
      const ico = t.cat ? `<img src="${iconDataURL(t.cat, 20)}" alt="">` : r.type === "hid" ? `<img src="${iconDataURL("hidranti", 20)}" alt="">` : `<i class="${t.cls}"></i>`;
      return `<li role="option" data-i="${i}" aria-selected="${i === active}">
        <span class="r-ico">${ico}</span>
        <span class="r-main"><div class="r-label">${esc(r.label)}</div>${r.ctx ? `<div class="r-ctx">${esc(r.ctx)}</div>` : ""}</span>
        <span class="r-type">${esc(t.label)}</span></li>`;
    }).join("");
    list.hidden = false;
  };

  const run = () => {
    const q = input.value;
    const c = parseCoordinates(q);
    results = [];
    if (c) {
      const u = uatAt(...c.lonlat);
      results.push({ coord: true, kind: c.kind, label: fmtLatLon(...c.lonlat), ctx: u ? `UAT ${u.name}` : "", lon: c.lonlat[0], lat: c.lonlat[1], type: "coord" });
    }
    results.push(...search.query(q));
    active = 0;
    render();
  };

  const choose = (r) => {
    if (!r) return;
    list.hidden = true;
    input.blur();
    const ll = [r.lon, r.lat];
    const course = r.type === "cad" ? courseIndex(state.data.hydrography).get(r.ref) : null;
    // un râu nu primește pin: fișa îi desenează tot cursul
    setOverlay("pin", r.type === "cad" ? FC()
      : { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: ll } }] });
    if (r.type === "hid") {
      const f = state.data.hydrants.features.find((x) => x.id === r.ref);
      if (f) showInfo({ ...f, layer: { id: "hydrant-icon" } }, ll);
    } else if (r.type?.startsWith("poi:")) {
      const f = state.data.pois.features.find((x) => x.geometry.coordinates[0] === r.lon && x.geometry.coordinates[1] === r.lat);
      if (f) showInfo({ ...f, layer: { id: "poi-major" } }, ll);
    } else if (course) {
      if (!state.visible.cadastru) {
        state.visible.cadastru = true;
        store.set("visible.v2", state.visible);
        applyStyle();
        renderLayerPanel();
      }
      showInfo({ ...course, layer: { id: "hydro-line" } }, ll);
    } else if (r.coord) {
      showInfo(null, ll);
    } else {
      closeInfo();
      setSheet("peek");
    }
    const padding = viewPadding();
    if (r.bbox && r.type !== "adr") {
      map.fitBounds([[r.bbox[0], r.bbox[1]], [r.bbox[2], r.bbox[3]]], { padding, maxZoom: r.type === "cad" ? 13 : 17, duration: 800 });
    } else {
      const z = r.type?.startsWith("loc:city") ? 13 : r.type?.startsWith("loc:town") ? 14 : r.type?.startsWith("loc:") ? 15 : 17.5;
      map.flyTo({ center: ll, zoom: z, duration: 900, padding });
    }
  };

  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 70); });
  input.addEventListener("focus", () => { setSheet("peek"); if (input.value.trim()) render(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { active = Math.min(active + 1, results.length - 1); render(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = Math.max(active - 1, 0); render(); e.preventDefault(); }
    else if (e.key === "Enter") { clearTimeout(timer); if (!results.length) run(); choose(results[active]); }
    else if (e.key === "Escape") { list.hidden = true; input.blur(); }
  });
  list.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li[data-i]");
    if (li) { e.preventDefault(); choose(results[+li.dataset.i]); }
  });
  document.addEventListener("mousedown", (e) => { if (!e.target.closest(".search")) list.hidden = true; });
}

// ------------------------------------------------------------------ interfață generală

function selectTab(name) {
  if (isMobile()) setMobileMapOnly(false);
  if (isMobile() && $(".side").dataset.sheet === "peek") setSheet("half");
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", b.dataset.tab === name);
  for (const t of ["straturi", "situatii", "analiza", "ajutor", "admin"]) $("#tab-" + t).hidden = t !== name;
  store.set("tab", name);
}

let toastTimer = 0;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 1800);
}

async function copy(text, msg = "Copiat: " + text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast(msg.length > 70 ? msg.slice(0, 70) + "…" : msg);
}

function setTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme === "noapte" ? "dark" : "light";
  $("#t-tema-l").textContent = theme === "noapte" ? "Zi" : "Noapte";
  store.set("theme", theme);
  try { localStorage.setItem("hb.theme", theme); } catch { /* */ }
  applyStyle();
  renderLayerPanel();
}

function setBasemap(b) {
  state.basemap = b;
  store.set("basemap", b);
  $("#t-harta").setAttribute("aria-pressed", b === "harta");
  $("#t-satelit").setAttribute("aria-pressed", b === "satelit");
  applyStyle();
}

function exportImage() {
  map.once("render", () => {
    const url = map.getCanvas().toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `harta-botosani-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-")}.png`;
    a.click();
  });
  map.triggerRepaint();
}

function initUI() {
  $("#mobile-map-toggle").addEventListener("click", () => {
    setMobileMapOnly(!document.body.classList.contains("mobile-map-only"));
  });
  $("#t-tema-l").textContent = state.theme === "noapte" ? "Zi" : "Noapte";
  $("#t-harta").setAttribute("aria-pressed", state.basemap === "harta");
  $("#t-satelit").setAttribute("aria-pressed", state.basemap === "satelit");
  const savedTab = store.get("tab", "straturi");
  if (["straturi", "situatii", "analiza", "ajutor"].includes(savedTab) && savedTab !== "straturi") {
    selectTab(savedTab);
  }
  for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => {
    if (sheetDragged) { sheetDragged = false; return; }
    // pe telefon, atingerea filei deja deschise strânge panoul
    if (isMobile() && b.getAttribute("aria-selected") === "true" && $(".side").dataset.sheet !== "peek") return setSheet("peek");
    selectTab(b.dataset.tab);
  });
  $("#t-analiza").addEventListener("click", () => setMode(state.mode === "pick" ? null : "pick"));
  $("#t-masoara").addEventListener("click", () => (state.mode === "measure" ? finishMeasure() : setMode("measure")));
  $("#t-harta").addEventListener("click", () => setBasemap("harta"));
  $("#t-satelit").addEventListener("click", () => setBasemap(state.basemap === "satelit" ? "harta" : "satelit"));
  $("#t-loc").addEventListener("click", () => {
    if (!window.isSecureContext || !navigator.geolocation) return toast("Localizarea funcționează doar pe conexiune securizată (https).");
    if (!geolocate?.trigger()) toast("Localizarea nu este disponibilă în acest browser.");
  });
  $("#t-tema").addEventListener("click", () => setTheme(state.theme === "zi" ? "noapte" : "zi"));
  $("#t-export").addEventListener("click", exportImage);
  $("#t-full").addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  });
  $("#modebar").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.copy) copy(b.dataset.copy);
    const act = b.dataset.act;
    if (act === "cancel") { setMode(null); setOverlay("measure", FC()); $("#modebar").hidden = true; }
    if (act === "undo") { state.measure.pop(); drawMeasure(); }
    if (act === "finish") finishMeasure();
    if (act === "clearmeasure") { $("#modebar").hidden = true; setOverlay("measure", FC()); }
  });
  document.addEventListener("mousedown", (e) => { if (Date.now() > suppressClickUntil && !e.target.closest("#ctx")) closeContextMenu(); });

  document.addEventListener("keydown", (e) => {
    if (isCommuneMapOpen()) return;
    if (operations?.handleKey(e)) return;
    const typing = e.target.matches("input, textarea, select");
    if (e.key === "Escape") {
      closeContextMenu();
      if (state.mode === "measure") finishMeasure();
      else if (state.mode) setMode(null);
      else if (!$("#info").hidden) closeInfo();
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (e.key === "/") { e.preventDefault(); if (isMobile()) setMobileMapOnly(false); $("#q").focus(); $("#q").select(); }
    else if (k === "m") (state.mode === "measure" ? finishMeasure() : setMode("measure"));
    else if (k === "a") setMode(state.mode === "pick" ? null : "pick");
    else if (k === "s") setBasemap(state.basemap === "harta" ? "satelit" : "harta");
    else if (k === "n") setTheme(state.theme === "zi" ? "noapte" : "zi");
  });
}

init().catch((e) => {
  console.error(e);
  const l = $("#loading");
  if (l) { l.classList.add("err"); l.textContent = "Harta nu a putut fi încărcată. Reîncarcă pagina; dacă problema continuă, verifică conexiunea."; }
});
