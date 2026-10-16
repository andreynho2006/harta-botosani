import { EventStore, createEvent, sanitizeEvent } from "./event-store.js";
import {
  snapToRoad, buildRoadSegment, findRoadByRef, sliceRoadByKm, sliceRoadByPlaces,
  projectPointOnRoad, roadNetworkToFeatures, roadsListOf, lineLengthKm,
} from "./road-sketch.js";
import { outsideMask, geometryBounds } from "./commune-geometry.js";
import { circle } from "./geo.js";
import { LAYER_GROUPS, LAYER_PRESETS } from "./config.js";
import { localTime, isoTime, dateLabel } from "./operations-time.js";

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
  flooded: "Sector / zonă inundată",
  damaged: "Drum deteriorat / restricționat",
  threat: "Zonă posibil inundabilă / amenințată",
  fire: "Perimetru incendiu",
  evacuated: "Zonă / localitate evacuată",
  isolated: "Localitate izolată (fără acces)",
  power: "Localitate fără energie electrică",
  command: "Punct de Comandă Mobil (PCM)",
  isu: "Forțe / Tehnică ISU",
  police: "Filtru Rutier IPJ / IJJ",
  medical: "Echipaj SAJ / SMURD / PMA",
  utility: "Utilaj SDN / DJDP / SGA / Delgaz",
  shelter: "Punct sprijin / adăpostire sinistrați",
};

const ROAD_KINDS = ["blocked", "snow", "flooded", "damaged"];
const ZONE_KINDS = ["threat", "flooded", "snow", "fire", "evacuated"];
const PLACE_KINDS = ["isolated", "power", "flooded", "snow", "evacuated"];
const FORCE_KINDS = ["command", "isu", "police", "medical", "utility", "shelter"];

export const STATUSES = {
  confirmed: "Confirmat",
  reported: "Raportat",
  threat: "Potențial",
  resolved: "Remediat / Redeschis",
};

export const ALERTS = {
  "": "Fără cod",
  yellow: "Cod galben ANM / INHGA",
  orange: "Cod portocaliu ANM / INHGA",
  red: "Cod roșu ANM / INHGA",
  "ro-alert": "RO-Alert IGSU",
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

function buildEndpointsFC(features = []) {
  const pts = [];
  for (const f of features) {
    if (f.geometry?.type !== "LineString" || f.geometry.coordinates.length < 2) continue;
    const p = f.properties || {};
    const start = f.geometry.coordinates[0];
    const end = f.geometry.coordinates.at(-1);
    const startLabel = p.kmFrom != null ? `${p.road ? p.road + " " : ""}km ${p.kmFrom}` : (p.road || "Început");
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
  const { map, state, uatAt, toast, selectTab, setSheet, applyStyle, renderLayerPanel, stopOtherTools, applyPreset } = ctx;
  const panel = document.querySelector("#tab-situatii");
  const storage = ctx.storage ?? globalThis.localStorage;
  const SESSION_KEY = "hb.ops.session.v1";
  const db = new EventStore(storage);

  // Merge initial seed events from data/situatii.json if available
  if (state.data.initialEvents?.events?.length) {
    try { db.importArchive(state.data.initialEvents); } catch (e) { console.warn("Nu am putut importa situatii.json", e); }
  }

  let active = null, dirty = false, exported = false, mode = null, points = [], startSnap = null, roadPool = [];
  let pending = null, editingId = null, beforePresentation = null, previousOverlays = null;
  let archiveError = "", notice = "", resizeFrame = 0, archiveFilter = "", summaryCollapsed = false;
  let standaloneFocus = { areas: [], places: [], isolate: true };
  let restoring = false;

  state.operations = {
    features: FC(), draft: FC(), selection: FC(), mask: FC(), endpoints: FC(),
    focusGeometry: null, alertCode: "", tintAreas: true,
  };

  function persistSession() {
    if (restoring) return;
    try {
      storage?.setItem(SESSION_KEY, JSON.stringify({
        active,
        standaloneFocus,
        pending,
        editingId,
        dirty,
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
      db.save(snap);
      dirty = false;
    } catch { /* keep draft in session storage until valid */ }
  }

  function restoreSession() {
    restoring = true;
    try {
      const raw = storage?.getItem(SESSION_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved?.standaloneFocus && typeof saved.standaloneFocus === "object") {
        standaloneFocus = {
          areas: Array.isArray(saved.standaloneFocus.areas) ? saved.standaloneFocus.areas.filter(Boolean) : [],
          places: Array.isArray(saved.standaloneFocus.places) ? saved.standaloneFocus.places.filter(Boolean) : [],
          isolate: typeof saved.standaloneFocus.isolate === "boolean" ? saved.standaloneFocus.isolate : true,
        };
      }
      if (saved?.active && typeof saved.active === "object") {
        try {
          active = sanitizeEvent(saved.active);
        } catch {
          const fromDb = saved.active.id ? db.load(saved.active.id) : null;
          active = fromDb || saved.active;
        }
        if (active) {
          active.places = Array.isArray(active.places) ? active.places : [];
          active.areas = Array.isArray(active.areas) ? active.areas : [];
          active.isolateArea = active.isolateArea ?? false;
          active.tintAreas = active.tintAreas ?? true;
        }
      }
      if (saved?.pending && typeof saved.pending === "object" && saved.pending.properties) {
        pending = saved.pending;
        editingId = saved.editingId || null;
      }
      dirty = Boolean(saved?.dirty);
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
    dirty = true; exported = false;
    autoSaveActiveToDb();
    persistSession();
    const badge = panel.querySelector("#ops-save-state");
    if (badge) badge.textContent = dirty ? "Salvat automat în sesiune" : "Salvat automat";
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
    dirty = true; exported = false;
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
    return allLocalities().find(l => l.name.toLowerCase() === q) ||
           allLocalities().find(l => l.name.toLowerCase().startsWith(q));
  }

  function selectedGeometry() {
    const areaNames = new Set(active ? active.areas : standaloneFocus.areas);
    const placeNames = active ? (active.places || []) : standaloneFocus.places;
    const uatFeatures = (state.data.admin?.features || []).filter(f => f.properties.kind === "uat" && areaNames.has(f.properties.name));
    const placeFeatures = [];
    for (const pName of placeNames) {
      const loc = findLocality(pName);
      if (loc) {
        const poly = circle([loc.lon, loc.lat], 1600, 48);
        placeFeatures.push({ type: "Feature", properties: { kind: "place-focus", name: loc.name }, geometry: poly });
      }
    }
    const features = [...uatFeatures, ...placeFeatures];
    const coordinates = features.flatMap(f => f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates);
    return { features, geometry: coordinates.length ? { type: "MultiPolygon", coordinates } : null };
  }

  function renderFocusBar() {
    const areas = active ? active.areas : standaloneFocus.areas;
    const places = active ? (active.places || []) : standaloneFocus.places;
    const isolate = active ? !!active.isolateArea : standaloneFocus.isolate;
    if ((!areas.length && !places.length) || document.body.classList.contains("presenting")) {
      focusbar.hidden = true;
      return;
    }
    const tags = [
      ...areas.map(a => `<button type="button" class="ops-fchip" data-fremove-uat="${esc(a)}" title="Elimină UAT din focalizare">UAT ${esc(a)} ×</button>`),
      ...places.map(p => `<button type="button" class="ops-fchip" data-fremove-place="${esc(p)}" title="Elimină localitatea din focalizare">${esc(p)} ×</button>`),
    ].join("");
    focusbar.innerHTML = `
      <div class="ops-fbar-chips"><strong>Focus:</strong> ${tags}</div>
      <div class="ops-fbar-btns">
        <button type="button" data-faction="toggle-isolate" aria-pressed="${isolate}">${isolate ? "Exterior mascat" : "Izolează conturul"}</button>
        <button type="button" data-faction="fit">Încadrează</button>
        <button type="button" data-faction="clear-focus">Tot județul</button>
      </div>`;
    focusbar.hidden = false;
  }

  function sync(refresh = false) {
    const selected = selectedGeometry();
    const isolate = active ? (active.isolateArea ?? true) : standaloneFocus.isolate;
    const geometry = mode === "area" || !isolate ? null : selected.geometry;
    const activeFeatures = active?.features || FC();
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
    state.operations.focusGeometry = geometry;
    state.operations.mask = geometry ? outsideMask(geometry) : FC();
    state.operations.draft = FC(draftFeatures);
    state.operations.alertCode = active?.alert?.code || "";
    state.operations.tintAreas = active ? (active.tintAreas ?? true) : false;

    renderFocusBar();
    persistSession();

    if (refresh) applyStyle();
    else {
      for (const [key, source] of [
        ["features", "ops-features"],
        ["endpoints", "ops-endpoints"],
        ["selection", "ops-selection"],
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
    const geometries = [
      ...selected.features.map(f => f.geometry),
      ...(active?.features.features.map(f => f.geometry) || []),
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
    const head = presenting ? (presentation.querySelector(".ops-slide-head")?.offsetHeight || 80) + 24 : 80;
    const bottom = presenting ? (presentation.querySelector(".ops-slide-foot")?.offsetHeight || 70) + 24 : 100;
    const right = presenting && !summaryCollapsed ? Math.min(360, window.innerWidth * 0.35) + 28 : 68;
    const height = map.getContainer().clientHeight || 600;
    map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    map.fitBounds([[minX, minY], [maxX, maxY]], {
      padding: { top: Math.min(head, height * 0.4), bottom: Math.min(bottom, height * 0.3), left: 28, right },
      retainPadding: false, maxZoom: 15.5, duration: 450,
    });
  }

  // Wire direct main-map UAT & Locality focus (replaces the old modal dialog)
  state.focusUat = (uat) => {
    if (!uat?.name) return;
    stopOtherTools();
    if (active) {
      if (!active.areas.includes(uat.name)) active.areas = [...active.areas, uat.name];
      active.isolateArea = true;
      changed();
    } else {
      if (!standaloneFocus.areas.includes(uat.name)) standaloneFocus.areas = [...standaloneFocus.areas, uat.name];
      standaloneFocus.isolate = true;
    }
    sync(true);
    render();
    const b = geometryBounds(uat.feature?.geometry);
    if (b && map) map.fitBounds(b, { padding: { top: 80, bottom: 80, left: 50, right: 50 }, maxZoom: 14.5, duration: 500 });
    toast(`Focalizat pe UAT ${uat.name} (direct pe harta principală)`);
  };

  state.focusPlace = (placeOrName, llArg) => {
    const placeName = typeof placeOrName === "object" ? placeOrName?.name : placeOrName;
    const ll = Array.isArray(llArg) ? llArg : (typeof placeOrName === "object" && Number.isFinite(placeOrName?.lon) && Number.isFinite(placeOrName?.lat) ? [placeOrName.lon, placeOrName.lat] : null);
    if (!placeName) return;
    stopOtherTools();
    if (active) {
      active.places = active.places || [];
      if (!active.places.includes(placeName)) active.places = [...active.places, placeName];
      active.isolateArea = true;
      changed();
    } else {
      if (!standaloneFocus.places.includes(placeName)) standaloneFocus.places = [...standaloneFocus.places, placeName];
      standaloneFocus.isolate = true;
    }
    sync(true);
    render();
    if (ll && map) map.flyTo({ center: ll, zoom: 14, duration: 500 });
    toast(`Focalizat pe localitatea ${placeName}`);
  };

  function stopDrawing() {
    mode = null; points = []; startSnap = null; roadPool = [];
    drawbar.hidden = true;
    if (map) map.getCanvas().style.cursor = "";
    sync(true);
  }

  function cancelDrawing() {
    if (!mode) return;
    stopDrawing();
    render();
  }

  function start(tool, defaultKind = null) {
    ensureActiveEvent();
    if (pending && tool !== "retrace-road") {
      return message("Salvează marcajul curent (Adaugă / Actualizează) sau apasă Renunță înainte de a folosi alt instrument.");
    }
    stopOtherTools();
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
        source: "", observedAt: new Date().toISOString(), notes: "",
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
    pending = {
      type: "Feature",
      geometry,
      properties: {
        id: prevProps.id || id(),
        kind: kind || prevProps.kind || "blocked",
        status: prevProps.status || "confirmed",
        title: prevProps.title || "",
        road: extra.road ?? prevProps.road ?? "",
        kmFrom: extra.kmFrom ?? prevProps.kmFrom ?? null,
        kmTo: extra.kmTo ?? prevProps.kmTo ?? null,
        lengthKm: extra.lengthKm ?? prevProps.lengthKm ?? (geometry?.type === "LineString" ? lineLengthKm(geometry.coordinates) : null),
        source: prevProps.source || "",
        observedAt: prevProps.observedAt || new Date().toISOString(),
        notes: prevProps.notes || "",
      },
    };
    stopDrawing();
    sync(); render(); selectTab("situatii"); setSheet("half");
    requestAnimationFrame(() => panel.querySelector("#ops-marker")?.scrollIntoView({ block: "start" }));
  }

  function finishDrawing() {
    if (mode === "area") { stopDrawing(); render(); selectTab("situatii"); setSheet("half"); fit(); return; }
    if (mode === "zone") {
      if (points.length < 3) return message("Alege cel puțin trei puncte pe hartă pentru a închide conturul zonei.");
      const ring = [...points, points[0]];
      prepare({ type: "Polygon", coordinates: [ring] }, state.operations._defaultKind || "threat");
    }
  }

  function availableRoads() {
    const netFeatures = roadNetworkToFeatures(state.data.roads, state.visible);
    if (!map?.isStyleLoaded()) return netFeatures;
    const tileFeatures = map.querySourceFeatures("osm", { sourceLayer: "roads" }).filter(f => state.visible["road:" + f.properties.cls]);
    return [...netFeatures, ...tileFeatures];
  }

  function handleMapClick(event) {
    if (document.body.classList.contains("presenting")) return true;
    if (!mode) {
      if (!active || pending) return false;
      const layers = ["ops-features-line", "ops-features-point", "ops-features-fill"].filter(layer => map.getLayer(layer));
      if (!layers.length || !map.isStyleLoaded()) return false;
      const features = map.queryRenderedFeatures([[event.point.x - 8, event.point.y - 8], [event.point.x + 8, event.point.y + 8]], { layers });
      const feature = active.features.features.find(f => f.properties.id === features[0]?.properties.id);
      if (!feature) return false;
      pending = structuredClone(feature); editingId = pending.properties.id; sync(); render(); selectTab("situatii"); setSheet("half");
      requestAnimationFrame(() => panel.querySelector("#ops-marker")?.scrollIntoView({ block: "start" }));
      return true;
    }
    const coordinate = [event.lngLat.lng, event.lngLat.lat];
    if (mode === "area") {
      const uat = uatAt(...coordinate);
      if (!uat) { message("Punctul ales este în afara limitelor UAT din județ."); return true; }
      active.areas = active.areas.includes(uat.name) ? active.areas.filter(name => name !== uat.name) : [...active.areas, uat.name];
      changed(); sync(true); render(); drawInstructions();
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
        if (!geometry) {
          geometry = buildRoadSegment(startSnap, snapped, [...roadPool, ...available]);
          if (geometry) lengthKm = lineLengthKm(geometry.coordinates);
        }
        if (!geometry) {
          message("Nu pot uni cele două puncte pe același drum. Alege puncte pe același drum sau folosește introducerea după km.");
          return true;
        }
        prepare(geometry, state.operations._defaultKind || "blocked", {
          road: startSnap.road.ref || startSnap.road.name || "",
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

  function markerHTML() {
    if (!pending) return "";
    const p = pending.properties;
    const isRoad = !pending.geometry || pending.geometry.type === "LineString" || ROAD_KINDS.includes(p.kind);
    const isZone = pending.geometry?.type === "Polygon";
    const relevant = isRoad && (!pending.geometry || pending.geometry.type === "LineString")
      ? pickKinds(ROAD_KINDS)
      : isZone
      ? pickKinds(ZONE_KINDS)
      : KINDS;

    const matchedRoad = isRoad && p.road ? findRoadByRef(state.data.roads, p.road) : null;
    const roadPlaces = matchedRoad?.places || [];

    return `<form id="ops-marker" class="ops-card ops-marker-form">
      <div class="ops-card-title">
        <h3>${editingId ? "Editează marcajul operativ" : isRoad ? "⛔ Sector de drum afectat / impracticabil" : isZone ? "▱ Zonă afectată / posibil inundabilă" : "📍 Marcaj operativ"}</h3>
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
      <label>Denumire afișată pe hartă<input name="title" maxlength="200" value="${esc(p.title)}" placeholder="${isRoad ? "Se completează automat (ex. DJ29 · km 3–6)" : "Ex. Filtru IPJ / Zonă inundabilă / Sat izolat"}"></label>
      <div class="ops-grid">
        <label>Ora informației<input name="observedAt" type="datetime-local" value="${localTime(p.observedAt)}"></label>
        <label>Sursa / Structura<input name="source" maxlength="300" value="${esc(p.source)}" placeholder="Ex. ISU / IPJ / SDN / DJDP / SGA"></label>
      </div>
      <label>Detalii / Măsuri luate în teren<textarea name="notes" maxlength="5000" rows="2" placeholder="Ex. Se acționează cu autofreză SDN și filtru IPJ la intrarea pe sector">${esc(p.notes)}</textarea></label>
      <div class="ops-actions">
        <button class="btn primary" type="submit">${editingId ? "Actualizează marcajul" : "Adaugă pe hartă"}</button>
        <button class="btn" type="button" data-action="discard-mark">Renunță</button>
      </div>
    </form>`;
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
          const roadCount = e.features.features.filter(f => f.geometry.type === "LineString").length;
          const uats = e.areas?.length ? ` · ${e.areas.slice(0, 2).join(", ")}${e.areas.length > 2 ? "…" : ""}` : "";
          return `<option value="${esc(e.id)}" ${active?.id === e.id ? "selected" : ""}>${esc(e.title)} (${esc(TYPES[e.type] || e.type)}${roadCount ? `, ${roadCount} drumuri` : ""}${esc(uats)} · ${dateLabel(e.updatedAt)})</option>`;
        }).join("")}
      </select>
      <div class="ops-actions">
        <button class="btn" type="button" data-action="archive-export">Salvează baza (.json)</button>
        <label class="btn file ops-import">Încarcă .json<input id="ops-import" type="file" accept=".json,application/json" hidden></label>
        ${active ? `<button class="btn" type="button" data-delete-id="${esc(active.id)}" title="Șterge situația curentă din arhivă">Șterge</button>` : ""}
      </div>
    </section>`;
  }

  function render() {
    const events = list();
    const roadMarks = active ? active.features.features.filter(f => f.geometry.type === "LineString") : [];
    const otherMarks = active ? active.features.features.filter(f => f.geometry.type !== "LineString") : [];

    panel.innerHTML = `<div class="ops">
      ${roadsDatalistHTML()}
      ${localitiesDatalistHTML()}
      ${uatsDatalistHTML()}
      <p class="ops-notice" role="status">${esc(notice)}</p>

      ${archiveHTML(events)}

      <section class="ops-card ops-quick-presets">
        <h3>Profiluri straturi pentru ședința CJSU</h3>
        <div class="ops-preset-chips">
          ${LAYER_PRESETS.map(pr => `<button type="button" class="chip" data-preset="${esc(pr.id)}" title="${esc(pr.label)}">${esc(pr.short)}</button>`).join("")}
        </div>
      </section>

      ${!active ? `
      <section class="ops-card ops-intro">
        <h2>Situații operative CJSU</h2>
        <p>Marchează drumuri impracticabile (ex. <b>DJ29 km 3 – km 6</b>), zone posibil inundabile, localități izolate și forțe în teren pentru prezentarea în Comitetul Județean pentru Situații de Urgență.</p>
        <div class="ops-actions" style="margin-bottom:10px">
          <button class="btn primary" type="button" data-action="quick-road">⛔ Marchează rapid drum blocat (km / hartă)</button>
        </div>
        <form id="ops-new">
          <label>Denumirea situației / ședinței CJSU<input name="title" required maxlength="200" placeholder="Ex. Înzăpezire și viscol · Ședință CJSU"></label>
          <label>Tip eveniment<select name="type">${options(TYPES, "snow")}</select></label>
          <button class="btn primary" type="submit">Creează situație nouă</button>
        </form>
      </section>` : `
      <section class="ops-card">
        <div class="ops-card-title">
          <h2>${esc(active.title)}</h2>
          <button type="button" class="lnk" data-action="new">Închide</button>
        </div>
        <p id="ops-save-state" class="ops-save-state">${dirty ? exported ? "Exportat JSON · nesalvat în browser" : "Modificări nesalvate" : `Salvat în baza de date · ${dateLabel(active.updatedAt)}`}</p>

        <div class="ops-actions ops-top-actions">
          <button class="btn primary" type="button" data-action="save">💾 Salvează situația</button>
          <button class="btn primary" type="button" data-action="present">🖥️ Prezintă în ședință</button>
          <button class="btn" type="button" data-action="event-export">Salvează .json</button>
          <button class="btn" type="button" data-action="duplicate">Duplică</button>
        </div>

        <form id="ops-meta" style="margin-top:10px">
          <label>Denumire situație<input data-field="title" maxlength="200" required value="${esc(active.title)}"></label>
          <div class="ops-grid">
            <label>Tip eveniment<select data-field="type">${options(TYPES, active.type)}</select></label>
            <label>Cod ANM / RO-Alert<select data-alert="code">${options(ALERTS, active.alert.code)}</select></label>
          </div>
          <div class="ops-grid">
            <label>Sursă avertizare<input data-alert="source" maxlength="300" value="${esc(active.alert.source)}" placeholder="ANM / INHGA / IGSU RO-Alert"></label>
            <label>Valabil de la<input data-alert="validFrom" type="datetime-local" value="${localTime(active.alert.validFrom)}"></label>
          </div>
          <div class="ops-grid">
            <label>Valabil până la<input data-alert="validTo" type="datetime-local" value="${localTime(active.alert.validTo)}"></label>
            <label>Straturi recomandate<button class="btn" type="button" data-action="preset" style="height:38px">Aplică straturi ${esc(TYPES[active.type] || "")}</button></label>
          </div>
          <label>Fenomene vizate / Mesaj RO-Alert<textarea data-alert="text" rows="2" maxlength="5000" placeholder="Ex. Viscol puternic, intensificări ale vântului 70–85 km/h, troienirea zăpezii">${esc(active.alert.text)}</textarea></label>
          <label>Sinteză operativă / Dispoziții CJSU<textarea data-field="notes" rows="2" maxlength="10000" placeholder="Ex. S-a dispus închiderea temporară a sectoarelor afectate și intervenția SDN/DJDP/ISU">${esc(active.notes)}</textarea></label>
        </form>
      </section>

      <section class="ops-card">
        <h3>Adaugă pe hartă (Drumuri, Zone, Localități, Forțe)</h3>
        <div class="ops-tools-grid">
          <button class="btn primary" type="button" data-action="open-road-form">⛔ Drum blocat / afectat (după km sau click)</button>
          <button class="btn" type="button" data-action="road">━ Trasează drum cu 2 click-uri pe hartă</button>
          <button class="btn" type="button" data-action="zone" data-kind="threat">▱ Zonă posibil inundabilă / amenințată</button>
          <button class="btn" type="button" data-action="zone" data-kind="flooded">▱ Zonă inundată / afectată</button>
          <button class="btn" type="button" data-action="zone" data-kind="fire">▱ Perimetru incendiu de amploare</button>
          <button class="btn" type="button" data-action="place" data-kind="isolated">🏘️ Localitate izolată / fără curent</button>
          <button class="btn" type="button" data-action="point" data-kind="command">⛺ Punct de Comandă Mobil (PCM)</button>
          <button class="btn" type="button" data-action="point" data-kind="isu">🚒 Echipaj / Tehnică ISU în teren</button>
          <button class="btn" type="button" data-action="point" data-kind="police">🚓 Filtru Rutier IPJ / Jandarmerie</button>
          <button class="btn" type="button" data-action="point" data-kind="utility">🚜 Utilaj Deszăpezire / Ape (SDN/DJDP/SGA)</button>
          <button class="btn" type="button" data-action="point" data-kind="medical">🚑 Punct Medical / SAJ / SMURD</button>
          <button class="btn" type="button" data-action="point" data-kind="shelter">🏫 Punct Sprijin / Adăpostire Evacuați</button>
        </div>
      </section>

      ${markerHTML()}

      <section class="ops-card">
        <h3>Drumuri blocate / afectate <span>${roadMarks.length}</span></h3>
        <ul class="ops-marks">${roadMarks.map(f => {
          const p = f.properties;
          const kmTxt = p.kmFrom != null ? `km ${p.kmFrom}${p.kmTo != null ? "–" + p.kmTo : ""}` : "";
          const lenTxt = p.lengthKm ? `${p.lengthKm} km` : "";
          return `<li>
            <button class="ops-mark-main" type="button" data-mark="${esc(p.id)}">
              <b><span class="ops-dot" data-kind="${esc(p.status === "resolved" ? "resolved" : p.kind)}"></span>${esc(p.title || [p.road, kmTxt].filter(Boolean).join(" · ") || KINDS[p.kind])}</b>
              <small>${esc(KINDS[p.kind])} · <b>${esc(STATUSES[p.status])}</b>${lenTxt ? ` · ${esc(lenTxt)}` : ""}${p.source ? ` · ${esc(p.source)}` : ""} · ${dateLabel(p.observedAt)}</small>
            </button>
            <button class="ops-zoom" type="button" data-zoom-mark="${esc(p.id)}" title="Arată pe hartă">🔍</button>
            <button class="ops-remove" type="button" data-remove="${esc(p.id)}" aria-label="Elimină marcajul">×</button>
          </li>`;
        }).join("") || `<li class="muted">Niciun sector de drum marcat. Apasă «⛔ Drum blocat / afectat» pentru a marca un drum (ex. DJ29 km 3–6).</li>`}</ul>
      </section>

      <section class="ops-card">
        <h3>Zone, localități și forțe în teren <span>${otherMarks.length}</span></h3>
        <ul class="ops-marks">${otherMarks.map(f => {
          const p = f.properties;
          return `<li>
            <button class="ops-mark-main" type="button" data-mark="${esc(p.id)}">
              <b><span class="ops-dot" data-kind="${esc(p.status === "resolved" ? "resolved" : p.kind)}"></span>${esc(p.title || KINDS[p.kind])}</b>
              <small>${esc(KINDS[p.kind])} · ${esc(STATUSES[p.status])}${p.source ? ` · ${esc(p.source)}` : ""} · ${dateLabel(p.observedAt)}</small>
            </button>
            <button class="ops-zoom" type="button" data-zoom-mark="${esc(p.id)}" title="Arată pe hartă">🔍</button>
            <button class="ops-remove" type="button" data-remove="${esc(p.id)}" aria-label="Elimină marcajul">×</button>
          </li>`;
        }).join("") || `<li class="muted">Nicio zonă sau forță marcată încă.</li>`}</ul>
      </section>

      <section class="ops-card">
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
        <label class="ops-check"><input type="checkbox" data-toggle="isolateArea" ${active.isolateArea ? "checked" : ""}> Izolează zona selectată (ascunde restul județului pe hartă)</label>
        <label class="ops-check"><input type="checkbox" data-toggle="tintAreas" ${active.tintAreas !== false ? "checked" : ""}> Colorează UAT-urile selectate în culoarea codului de avertizare</label>
        <div class="ops-actions">
          <button class="btn" type="button" data-action="area">Alege UAT-uri cu click pe hartă</button>
          <button class="btn" type="button" data-action="fit">Încadrează zona</button>
          ${active.areas.length || (active.places || []).length ? `<button class="btn" type="button" data-action="clear-areas">Resetează la tot județul</button>` : ""}
        </div>
      </section>
      `}
    </div>`;
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

  function save() {
    try {
      if (pending || mode) return message("Finalizează adăugarea marcajului curent înainte de a salva situația.");
      active = db.save(snapshot()); dirty = false; exported = false;
      persistSession();
      notice = "Situația a fost salvată în baza de date a aplicației.";
      render(); toast(notice);
    } catch (error) {
      console.warn(error);
      message("Salvarea nu a reușit. Verifică denumirea situației; poți salva direct în fișier JSON.");
    }
  }

  function setActive(event) {
    active = structuredClone(event);
    active.places = active.places || [];
    active.isolateArea = active.isolateArea ?? false;
    active.tintAreas = active.tintAreas ?? true;
    pending = null; editingId = null; dirty = false; exported = false; notice = "";
    stopDrawing();
    for (const key of Object.keys(state.visible)) if (typeof active.visible[key] === "boolean") state.visible[key] = active.visible[key];
    try { storage?.setItem("hb.visible.v2", JSON.stringify(state.visible)); } catch { /* */ }
    sync(true); renderLayerPanel(); render();
    if (active.view && map) map.jumpTo(active.view); else fit();
    selectTab("situatii");
  }

  function canReplaceDraft() {
    if (pending || mode) {
      message("Finalizează sau anulează marcajul în curs înainte de a schimba situația.");
      return false;
    }
    if (active && dirty) autoSaveActiveToDb();
    return true;
  }

  function exitPresentation() {
    if (!document.body.classList.contains("presenting")) return;
    document.body.classList.remove("presenting"); presentation.hidden = true;
    state.operations.presenting = false;
    if (previousOverlays) { state.overlays = previousOverlays; previousOverlays = null; }
    applyStyle(); map?.resize(); if (beforePresentation && map) map.jumpTo(beforePresentation);
    renderFocusBar();
    selectTab("situatii");
  }

  function renderPresentationOverlay() {
    if (!active) return;
    const counts = {};
    active.features.features.forEach(f => {
      const kind = f.properties.status === "resolved" ? "resolved" : f.properties.kind;
      counts[kind] = (counts[kind] || 0) + 1;
    });
    const roadsList = active.features.features.filter(f => f.geometry.type === "LineString");
    const zonesAndPlaces = active.features.features.filter(f => f.geometry.type === "Polygon" || PLACE_KINDS.includes(f.properties.kind));
    const forcesList = active.features.features.filter(f => f.geometry.type === "Point" && !PLACE_KINDS.includes(f.properties.kind));
    const totalRoadKm = roadsList.reduce((acc, f) => acc + (Number(f.properties.lengthKm) || lineLengthKm(f.geometry.coordinates) || 0), 0);

    const areaText = [
      ...(active.areas.length ? [`UAT: ${active.areas.join(", ")}`] : []),
      ...((active.places || []).length ? [`Localități: ${active.places.join(", ")}`] : []),
    ].join(" · ") || "Județul Botoșani";

    presentation.innerHTML = `
      <header class="ops-slide-head">
        <div>
          <span class="ops-slide-eyebrow">ȘEDINȚĂ CJSU · ${esc(TYPES[active.type] || active.type)} · ${esc(areaText)}</span>
          <h1>${esc(active.title)}</h1>
          ${active.notes ? `<p>${esc(active.notes)}</p>` : ""}
          ${active.alert.code || active.alert.text ? `
            <p class="ops-alert" data-code="${esc(active.alert.code)}">
              <b>${esc(ALERTS[active.alert.code] || active.alert.code)}</b> ${esc(active.alert.text)}
              ${active.alert.source ? ` · ${esc(active.alert.source)}` : ""}
              ${active.alert.validFrom || active.alert.validTo ? ` · ${dateLabel(active.alert.validFrom)} – ${dateLabel(active.alert.validTo)}` : ""}
            </p>` : ""}
        </div>
        <div class="ops-pres-controls">
          <button class="btn" type="button" data-action="pres-toggle-summary">${summaryCollapsed ? "Arată sinteza" : "Ascunde sinteza"}</button>
          <button class="btn" type="button" data-action="pres-fit">Încadrează</button>
          <button class="btn" type="button" data-action="pres-isolate">${active.isolateArea ? "Arată tot județul" : "Izolează zona"}</button>
          <button class="btn" type="button" data-action="pres-sat">${state.basemap === "satelit" ? "Hartă" : "Satelit"}</button>
          <button class="btn" type="button" data-action="pres-theme">${state.theme === "noapte" ? "Zi" : "Noapte"}</button>
          <button class="btn primary" type="button" data-action="exit">Ieși din prezentare</button>
        </div>
      </header>

      ${!summaryCollapsed ? `
      <aside class="ops-slide-summary">
        <div class="ops-sum-sec">
          <h3>⛔ Drumuri afectate / blocate (${roadsList.length}${totalRoadKm ? ` · ${totalRoadKm.toFixed(1)} km` : ""})</h3>
          ${roadsList.length ? `<ul>${roadsList.map(f => {
            const p = f.properties;
            const len = p.lengthKm || lineLengthKm(f.geometry.coordinates);
            return `<li><button type="button" data-pres-zoom="${esc(p.id)}">
              <span class="ops-dot" data-kind="${esc(p.status === "resolved" ? "resolved" : p.kind)}"></span>
              <div><b>${esc(p.title || p.road || KINDS[p.kind])}</b><small>${esc(STATUSES[p.status])}${len ? ` · ${len} km` : ""}${p.notes ? ` — ${esc(p.notes)}` : ""}</small></div>
            </button></li>`;
          }).join("")}</ul>` : `<p class="muted">Niciun drum blocat raportat.</p>`}
        </div>
        ${zonesAndPlaces.length ? `
        <div class="ops-sum-sec">
          <h3>🌊 Zone și localități afectate (${zonesAndPlaces.length})</h3>
          <ul>${zonesAndPlaces.map(f => {
            const p = f.properties;
            return `<li><button type="button" data-pres-zoom="${esc(p.id)}">
              <span class="ops-dot" data-kind="${esc(p.status === "resolved" ? "resolved" : p.kind)}"></span>
              <div><b>${esc(p.title || KINDS[p.kind])}</b><small>${esc(KINDS[p.kind])} · ${esc(STATUSES[p.status])}</small></div>
            </button></li>`;
          }).join("")}</ul>
        </div>` : ""}
        ${forcesList.length ? `
        <div class="ops-sum-sec">
          <h3>🚒 Forțe și mijloace în teren (${forcesList.length})</h3>
          <ul>${forcesList.map(f => {
            const p = f.properties;
            return `<li><button type="button" data-pres-zoom="${esc(p.id)}">
              <span class="ops-dot" data-kind="${esc(p.status === "resolved" ? "resolved" : p.kind)}"></span>
              <div><b>${esc(p.title || KINDS[p.kind])}</b><small>${esc(KINDS[p.kind])}${p.source ? ` · ${esc(p.source)}` : ""}</small></div>
            </button></li>`;
          }).join("")}</ul>
        </div>` : ""}
      </aside>` : ""}

      <footer class="ops-slide-foot">
        <div class="ops-legend">${Object.entries(counts).map(([kind, count]) => `<span><i data-kind="${esc(kind)}"></i>${esc(kind === "resolved" ? "Remediat / Redeschis" : KINDS[kind])}: <b>${count}</b></span>`).join("")}</div>
        <span>${dirty ? "Situație în lucru" : "Actualizat " + dateLabel(active.updatedAt)}</span>
      </footer>`;
  }

  function present() {
    if (pending || mode) return message("Finalizează marcajul sau selecția înainte de prezentare.");
    if (!active) return;
    beforePresentation = { ...currentView(), padding: map.getPadding() };
    previousOverlays = state.overlays;
    state.overlays = { sel: FC(), analysis: FC(), measure: FC(), pin: FC() };
    state.operations.presenting = true;
    state.operations.labelSize = window.innerWidth <= 760 ? 14 : 18;
    renderPresentationOverlay();
    presentation.hidden = false;
    focusbar.hidden = true;
    document.body.classList.add("presenting");
    applyStyle();
    requestAnimationFrame(() => { map.resize(); fit(); presentation.querySelector("[data-action=exit]")?.focus(); });
  }

  panel.oninput = (event) => {
    const input = event.target;
    if (input.id === "ops-archive-search") {
      archiveFilter = input.value;
      render();
      const searchEl = panel.querySelector("#ops-archive-search");
      if (searchEl) { searchEl.focus(); searchEl.setSelectionRange(archiveFilter.length, archiveFilter.length); }
      return;
    }
    if (!active) return;
    if (input.dataset.field) { active[input.dataset.field] = input.value; changed(); }
    if (input.dataset.alert) {
      const field = input.dataset.alert;
      try {
        active.alert[field] = field === "validFrom" || field === "validTo" ? isoTime(input.value) : input.value;
        input.setCustomValidity("");
      } catch { input.setCustomValidity("Alege o dată și oră validă în ora României."); return; }
      changed();
      if (field === "code") sync(true);
    }
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
    if (target.id === "ops-archive") {
      if (!canReplaceDraft()) { render(); return; }
      const val = target.value;
      if (!val) {
        active = null; pending = null; stopDrawing(); sync(true); render();
        return;
      }
      try {
        const saved = db.load(val);
        if (saved) setActive(saved);
      } catch { message("Situația nu a putut fi citită din arhivă."); }
      return;
    }
    if (target.dataset?.toggle && active) {
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
      pending.properties.kind = target.value;
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
        dirty = true; exported = false; notice = "";
        if (applyPreset) applyPreset(type);
        sync(true); render();
      } catch { message("Introdu o denumire pentru situație."); }
    } else if (event.target.id === "ops-marker" && pending) {
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
        try { active = db.save(snapshot()); dirty = false; } catch { changed(); }
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

    if (button.dataset.preset) {
      if (applyPreset) applyPreset(button.dataset.preset);
      return;
    }
    if (button.dataset.area && active) {
      if (pending) return message("Finalizează marcajul curent înainte de schimbarea zonei.");
      active.areas = active.areas.filter(name => name !== button.dataset.area);
      changed(); sync(true); render(); return;
    }
    if (button.dataset.placeRemove && active) {
      if (pending) return message("Finalizează marcajul curent înainte de schimbarea zonei.");
      active.places = (active.places || []).filter(name => name !== button.dataset.placeRemove);
      changed(); sync(true); render(); return;
    }
    if (button.dataset.zoomMark && active) {
      const f = active.features.features.find(x => x.properties.id === button.dataset.zoomMark);
      if (f) { setSheet("peek"); fitGeometry(f.geometry); }
      return;
    }
    if (button.dataset.remove && active) {
      if (pending) return message("Finalizează sau anulează editarea marcajului curent.");
      active.features.features = active.features.features.filter(f => f.properties.id !== button.dataset.remove);
      try { active = db.save(snapshot()); dirty = false; } catch { changed(); }
      sync(); render(); return;
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
      db.remove(button.dataset.deleteId);
      if (active?.id === button.dataset.deleteId) { active = null; pending = null; stopDrawing(); sync(true); }
      render(); toast("Situația a fost ștearsă din arhiva locală.");
      return;
    }

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
      changed(); sync(true); render(); fit();
      return;
    }
    if (action === "add-place-btn" && active) {
      const val = panel.querySelector("#ops-add-place-input")?.value?.trim();
      const loc = findLocality(val);
      if (!loc) return message("Alege un sat / o localitate validă din județul Botoșani.");
      active.places = active.places || [];
      if (!active.places.includes(loc.name)) active.places = [...active.places, loc.name];
      changed(); sync(true); render(); fit();
      return;
    }
    if (action === "clear-areas" && active) {
      active.areas = []; active.places = []; active.isolateArea = false;
      changed(); sync(true); render();
      return;
    }

    if (action === "save") save();
    if (action === "fit") { setSheet("peek"); fit(); }
    if (action === "preset" && active) {
      if (applyPreset) applyPreset(active.type);
      changed();
    }
    if (action === "present") present();
    if (action === "discard-mark") { pending = null; editingId = null; sync(); render(); }
    if (action === "new" && canReplaceDraft()) { active = null; stopDrawing(); sync(true); render(); }
    if (action === "open" && canReplaceDraft()) {
      try {
        const saved = db.load(panel.querySelector("#ops-archive").value);
        if (saved) setActive(saved); else message("Alege o situație din listă.");
      } catch { message("Situația nu a putut fi citită din arhivă."); }
    }
    if (action === "duplicate" && canReplaceDraft()) {
      const base = createEvent(active.title + " · copie", active.type);
      active = { ...structuredClone(active), id: base.id, title: base.title, createdAt: base.createdAt, updatedAt: base.updatedAt };
      dirty = true; exported = false; render();
    }
    if (action === "event-export") {
      try {
        if (pending || mode) return message("Finalizează marcajul curent înainte de salvare JSON.");
        const savedSnap = db.save(snapshot());
        active = savedSnap; dirty = false;
        const ok = await saveJsonFile(`situatie-${active.id}.json`, { format: "harta-botosani-events", version: 1, exportedAt: new Date().toISOString(), events: [savedSnap] });
        if (ok) { exported = true; notice = "Situația a fost salvată în arhivă și în fișierul JSON."; render(); toast(notice); }
      } catch { message("Verifică denumirea și datele situației înainte de export."); }
    }
    if (action === "archive-export") {
      try {
        if (active && !pending && !mode) { active = db.save(snapshot()); dirty = false; }
        const ok = await saveJsonFile("situatii.json", db.exportArchive());
        if (ok) { message("Baza de date cu toate situațiile (situatii.json) a fost salvată."); render(); }
      } catch { message("Arhiva locală nu poate fi exportată."); }
    }
  };

  drawbar.onclick = (event) => {
    const action = event.target.closest("button")?.dataset.action;
    if (action === "finish") finishDrawing();
    if (action === "cancel") cancelDrawing();
    if (action === "undo") { points.pop(); sync(); drawInstructions(); }
    if (action === "switch-to-km") { stopDrawing(); openRoadCreator(); }
  };

  focusbar.onclick = (event) => {
    const btn = event.target.closest("button");
    if (!btn) return;
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

  presentation.onclick = (event) => {
    const btn = event.target.closest("button");
    if (!btn) return;
    if (btn.dataset.presZoom && active) {
      const f = active.features.features.find(x => x.properties.id === btn.dataset.presZoom);
      if (f) fitGeometry(f.geometry);
      return;
    }
    const act = btn.dataset.action;
    if (act === "exit") exitPresentation();
    else if (act === "pres-fit") fit();
    else if (act === "pres-toggle-summary") { summaryCollapsed = !summaryCollapsed; renderPresentationOverlay(); fit(); }
    else if (act === "pres-isolate" && active) { active.isolateArea = !active.isolateArea; sync(true); renderPresentationOverlay(); }
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
    if (event.key === "Escape" && document.body.classList.contains("presenting")) { exitPresentation(); event.preventDefault(); return true; }
    if (event.key === "Escape" && mode) { cancelDrawing(); event.preventDefault(); return true; }
    return false;
  };

  window.addEventListener("resize", () => {
    if (!document.body.classList.contains("presenting")) return;
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      state.operations.labelSize = window.innerWidth <= 760 ? 14 : 18;
      if (map.getLayer("ops-features-label")) map.setLayoutProperty("ops-features-label", "text-size", state.operations.labelSize);
      map.resize(); fit();
    });
  });

  restoreSession();
  sync(true);
  render();
  return { handleMapClick, handleKey, cancelDrawing, isDrawing: () => !!mode, sync, openRoadCreator };
}
