/* global maplibregl */
import { buildStyle, PALETTES } from "./style.js?v=20261026-hydro";
import { addHydroLabelSource, containsPoint, geometryBounds, outsideMask, roadExits } from "./commune-geometry.js?v=20261026-hydro";

const empty = () => ({ type: "FeatureCollection", features: [] });
let dialog;
let activeMap = null;
let resizeObserver = null;

function getDialog() {
  if (dialog) return dialog;
  dialog = document.createElement("dialog");
  dialog.className = "commune-dialog";
  dialog.setAttribute("aria-labelledby", "commune-title");
  dialog.setAttribute("aria-describedby", "commune-caption");
  dialog.innerHTML = `
    <header class="commune-header">
      <div><span class="commune-eyebrow">Hartă separată</span><h2 id="commune-title"></h2></div>
      <button class="commune-close" type="button" aria-label="Închide harta comunei" autofocus>×</button>
    </header>
    <div class="commune-map-wrap">
      <div class="commune-map" aria-label="Harta comunei selectate"></div>
      <p class="commune-loading" role="status">Se încarcă harta comunei…</p>
    </div>
    <footer class="commune-footer">
      <p id="commune-caption">Doar teritoriul ales și localitățile din interior. Ieșiri de drum estompate până la 250 m.</p>
      <button class="btn commune-fit" type="button">Încadrează comuna</button>
    </footer>`;
  document.body.appendChild(dialog);
  dialog.querySelector(".commune-close").onclick = () => dialog.close();
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  dialog.addEventListener("close", () => {
    resizeObserver?.disconnect();
    resizeObserver = null;
    activeMap?.remove();
    activeMap = null;
    dialog.querySelector(".commune-map").replaceChildren();
  });
  return dialog;
}

export function isCommuneMapOpen() {
  return !!dialog?.open;
}

export function buildCommuneStyle(uat, state) {
  const geometry = uat.feature.geometry;
  const p = PALETTES[state.theme];
  const localPoints = (fc) => ({ ...fc, features: fc.features.filter((f) => containsPoint(geometry, f.geometry.coordinates)) });
  const focusState = {
    ...state,
    operations: undefined,
    hoverUat: "",
    data: { ...state.data, pois: localPoints(state.data.pois), hydrants: localPoints(state.data.hydrants),
      admin: { type: "FeatureCollection", features: [uat.feature] } },
    overlays: { sel: empty(), analysis: empty(), measure: empty(), pin: empty() },
  };
  const style = buildStyle(focusState);
  const labels = style.layers.filter((layer) => layer.type === "symbol").map((layer) => {
    // punctele sunt deja decupate pe comună; OSM și cadastrul apelor au tot județul în sursă
    // „within” judecă linia întreagă dintr-un tile: un râu care iese din comună și-ar pierde eticheta și pe bucata dinăuntru,
    // deci etichetele cadastrului vin dintr-o sursă tăiată la graniță
    if (layer.source === "hydrography") return { ...layer, source: addHydroLabelSource(style, geometry) };
    if (layer.source !== "osm") return layer;
    const inside = ["within", geometry];
    return { ...layer, filter: layer.filter ? ["all", layer.filter, inside] : inside };
  });
  style.layers = style.layers.filter((layer) => layer.type !== "symbol" && !["uat-line", "county-line", "uat-hover"].includes(layer.id));
  style.sources["commune-mask"] = { type: "geojson", data: outsideMask(geometry) };
  style.sources["commune-border"] = { type: "geojson", data: uat.feature };
  style.sources["commune-exits"] = { type: "geojson", data: empty() };
  const color = ["match", ["get", "cls"], ...Object.entries(p.road).flat(), p.road.street];
  const width = ["interpolate", ["linear"], ["zoom"], 8, 1.5, 13, 3.5, 18, 10];
  style.layers.push(
    { id: "commune-mask", type: "fill", source: "commune-mask",
      paint: { "fill-color": state.theme === "noapte" ? "#161a1f" : "#eef0f3", "fill-antialias": false } },
    { id: "commune-exits-casing", type: "line", source: "commune-exits",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": p.textSoft, "line-width": width, "line-blur": 2,
        "line-opacity": ["*", ["get", "fade"], 0.35] } },
    { id: "commune-exits", type: "line", source: "commune-exits",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": color, "line-width": width, "line-blur": 1,
        "line-opacity": ["*", ["get", "fade"], 0.75] } },
    { id: "commune-border", type: "line", source: "commune-border",
      paint: { "line-color": p.accent, "line-width": 2, "line-opacity": 0.75, "line-dasharray": [3, 2] } },
    ...labels,
  );
  return style;
}

// Direct main-map focus replaces the separate modal when state.focusUat is wired.
export function openCommuneMap({ uat, state, icons }) {
  if (!uat?.feature?.geometry) return;
  if (typeof state?.focusUat === "function") {
    state.focusUat(uat);
    return;
  }
  const el = getDialog();
  if (el.open) return;
  const geometry = uat.feature.geometry;
  const bounds = geometryBounds(geometry);
  if (!bounds) return;
  const style = buildCommuneStyle(uat, state);
  el.querySelector("#commune-title").textContent = uat.name;
  const loading = el.querySelector(".commune-loading");
  loading.textContent = "Se încarcă harta comunei…";
  loading.hidden = false;
  el.showModal();
  const padding = () => el.clientWidth < 600 ? 34 : 64;
  const fit = () => activeMap?.fitBounds(bounds, { padding: padding(), maxZoom: 15, duration: 350 });
  el.querySelector(".commune-fit").onclick = fit;
  try {
    const focusMap = new maplibregl.Map({
      container: el.querySelector(".commune-map"), style, bounds,
      fitBoundsOptions: { padding: padding(), maxZoom: 15 },
      minZoom: 7, maxZoom: 19,
      attributionControl: { compact: true },
      locale: { "NavigationControl.ZoomIn": "Mărește", "NavigationControl.ZoomOut": "Micșorează",
        "NavigationControl.ResetBearing": "Orientează spre nord", "AttributionControl.ToggleAttribution": "Surse" },
    });
    activeMap = focusMap;
    focusMap.addControl(new maplibregl.NavigationControl(), "top-right");
    focusMap.addControl(new maplibregl.ScaleControl({ unit: "metric", maxWidth: 100 }), "bottom-left");
    focusMap.on("styleimagemissing", (event) => {
      const icon = icons[event.id];
      if (icon && !focusMap.hasImage(event.id)) focusMap.addImage(event.id, icon.image, icon.options);
    });
    focusMap.once("load", () => { loading.hidden = true; });
    let lastCamera = "";
    focusMap.on("idle", () => {
      if (activeMap !== focusMap) return;
      const center = focusMap.getCenter();
      const camera = [center.lng, center.lat, focusMap.getZoom(), focusMap.getBearing(), focusMap.getPitch(), el.clientWidth, el.clientHeight].join("/");
      if (camera === lastCamera) return;
      lastCamera = camera;
      const roads = focusMap.querySourceFeatures("osm", { sourceLayer: "roads" })
        .filter((feature) => state.visible["road:" + feature.properties.cls]);
      focusMap.getSource("commune-exits").setData(roadExits(roads, geometry));
    });
    let lastSize = "";
    resizeObserver = new ResizeObserver(() => {
      const size = `${el.clientWidth}/${el.clientHeight}`;
      if (size === lastSize) return;
      lastSize = size;
      focusMap.resize();
      focusMap.fitBounds(bounds, { padding: padding(), maxZoom: 15, duration: 0 });
    });
    resizeObserver.observe(el.querySelector(".commune-map-wrap"));
  } catch (error) {
    console.error("Cannot open commune map", error);
    loading.textContent = "Harta nu a putut fi deschisă. Închide panoul și încearcă din nou.";
  }
}
