// Stilul hărții (zi / noapte) construit din datele locale.
import { POI } from "./config.js";

const base = location.href.replace(/[#?].*$/, "").replace(/[^/]*$/, "");

export const PALETTES = {
  zi: {
    land: "#f1eee7", forest: "#d3e3c4", grass: "#e2ebd0", orchard: "#e4e9cc", residential: "#e9e3d9",
    industrial: "#e6e0e8", military: "#efdcd6", cemetery: "#d9e3d2", wetland: "#d7e8e3", park: "#d4e8c2",
    sport: "#cfe7d3",
    water: "#a6cde6", waterLine: "#6fa9d6", waterText: "#2a6594",
    bld: { bloc: "#c6a283", public: "#d6aeb0", industrial: "#cdc8d6", cult: "#d8c59c", comercial: "#dcc8b2",
           casa: "#d9cfc2", anexa: "#e3ddd3", altele: "#d9cfc2" },
    bldLine: "#b8ab9b", bldBlocLine: "#9c7a5c",
    road: { dn: "#d9483b", dj: "#f0a23a", dc: "#f6d55c", local: "#ffffff", street: "#ffffff", service: "#ffffff", track: "#a0815a" },
    casing: { dn: "#9e2c22", dj: "#b06e14", dc: "#b39a2c", local: "#b9b0a3", street: "#c9c0b3", service: "#cfc7bb", track: "#a0815a" },
    bridge: "#3b3b3b", rail: "#6a6a6a", railDash: "#ffffff",
    county: "#7b4a8f", uat: "#9a83a8",
    text: "#2b2b2b", textSoft: "#5b5650", halo: "#ffffff", placeText: "#1e1e1e",
    accent: "#c8102e", measure: "#1f5fbf", select: "#0a84ff",
  },
  noapte: {
    land: "#1a1d21", forest: "#1d2820", grass: "#1f2522", orchard: "#202620", residential: "#22252a",
    industrial: "#25222a", military: "#2b2222", cemetery: "#1e2620", wetland: "#1b2627", park: "#1e2a1f",
    sport: "#1d2a22",
    water: "#16314a", waterLine: "#2d6a96", waterText: "#7fb3dc",
    bld: { bloc: "#5a4637", public: "#4e3540", industrial: "#36343f", cult: "#4a4231", comercial: "#433a32",
           casa: "#33363b", anexa: "#2b2e32", altele: "#33363b" },
    bldLine: "#444950", bldBlocLine: "#7d6350",
    road: { dn: "#c74a3f", dj: "#c88a36", dc: "#b9a447", local: "#6b717a", street: "#565c64", service: "#4a4f56", track: "#7a6446" },
    casing: { dn: "#5c1f1a", dj: "#5a3c12", dc: "#4f4518", local: "#111316", street: "#111316", service: "#111316", track: "#7a6446" },
    bridge: "#000000", rail: "#8b8f96", railDash: "#1a1d21",
    county: "#b58ac8", uat: "#7f6a8e",
    text: "#dfe3e8", textSoft: "#a8afb8", halo: "#14171a", placeText: "#f2f4f6",
    accent: "#ff4d5e", measure: "#5aa2ff", select: "#3fa7ff",
  },
};

const ROAD_ORDER = ["track", "service", "street", "local", "dc", "dj", "dn"];
const byCls = (obj, fallback) => ["match", ["get", "cls"], ...ROAD_ORDER.flatMap((k) => [k, obj[k]]), fallback];

// lățimi (px) pe nivel de zoom
const W = {
  dn: [[6, 1], [10, 2.4], [14, 5.5], [18, 15]],
  dj: [[6, 0.6], [10, 1.7], [14, 4.8], [18, 13]],
  dc: [[6, 0.3], [10, 1], [14, 4], [18, 12]],
  local: [[6, 0.2], [11, 0.8], [14, 3.6], [18, 11]],
  street: [[6, 0.1], [12, 0.6], [14, 2.8], [18, 10]],
  service: [[6, 0.1], [14, 1.2], [18, 6]],
  track: [[6, 0.1], [12, 0.6], [14, 1.3], [18, 3]],
};

function roadWidth(extra = 0) {
  const zooms = [6, 10, 11, 12, 14, 18];
  const at = (pts, z) => {
    if (z <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (z <= pts[i][0]) {
        const [z0, w0] = pts[i - 1], [z1, w1] = pts[i];
        return w0 + ((w1 - w0) * (z - z0)) / (z1 - z0);
      }
    }
    return pts[pts.length - 1][1];
  };
  const stops = zooms.flatMap((z) => {
    const ex = typeof extra === "function" ? extra(z) : extra;
    return [z, ["match", ["get", "cls"], ...ROAD_ORDER.flatMap((k) => [k, +(at(W[k], z) + ex).toFixed(2)]), 1]];
  });
  return ["interpolate", ["exponential", 1.4], ["zoom"], ...stops];
}

const vis = (on) => (on ? "visible" : "none");

/** Filtrele dinamice (ce categorii sunt vizibile) */
export function roadFilter(state) {
  const cls = Object.keys(state.visible).filter((k) => k.startsWith("road:") && state.visible[k]).map((k) => k.slice(5));
  return ["in", ["get", "cls"], ["literal", cls]];
}
export function buildingFilter(state) {
  const kinds = Object.keys(state.visible).filter((k) => k.startsWith("bld:") && state.visible[k]).map((k) => k.slice(4));
  return ["in", ["get", "kind"], ["literal", kinds]];
}
export function poiFilter(state, major) {
  const cats = Object.keys(POI).filter((c) => POI[c].major === major && state.visible["poi:" + c]);
  return ["in", ["get", "cat"], ["literal", cats]];
}

const FONT = ["Noto Sans Regular"];
const FONT_M = ["Noto Sans Medium"];
const FONT_I = ["Noto Sans Italic"];

export function buildStyle(state) {
  const p = PALETTES[state.theme];
  const v = state.visible;
  const sat = state.basemap === "satelit";
  const text = sat ? "#ffffff" : p.text;
  const halo = sat ? "rgba(0,0,0,0.85)" : p.halo;

  return {
    version: 8,
    glyphs: base + "fonts/{fontstack}/{range}.pbf",
    sources: {
      osm: {
        type: "vector", tiles: [base + "tiles/{z}/{x}/{y}.pbf"], minzoom: 6, maxzoom: 15,
        bounds: [25.85, 47.35, 27.55, 48.4],
        attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
      },
      satelit: {
        type: "raster", tileSize: 256, maxzoom: 19,
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        attribution: "Imagini © Esri, Maxar, Earthstar Geographics",
      },
      pois: { type: "geojson", data: state.data.pois },
      hydrants: { type: "geojson", data: state.data.hydrants },
      admin: { type: "geojson", data: state.data.admin },
      sel: { type: "geojson", data: state.overlays.sel },
      analysis: { type: "geojson", data: state.overlays.analysis },
      measure: { type: "geojson", data: state.overlays.measure },
      pin: { type: "geojson", data: state.overlays.pin },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": p.land } },
      { id: "sat", type: "raster", source: "satelit", layout: { visibility: vis(sat) },
        paint: { "raster-opacity": 1, "raster-fade-duration": 150 } },

      { id: "landuse", type: "fill", source: "osm", "source-layer": "landuse",
        layout: { visibility: vis(v.landuse && !sat) },
        paint: { "fill-color": ["match", ["get", "kind"],
          "forest", p.forest, "grass", p.grass, "orchard", p.orchard, "residential", p.residential,
          "industrial", p.industrial, "military", p.military, "cemetery", p.cemetery, "wetland", p.wetland,
          "park", p.park, "sport", p.sport, p.land] } },

      { id: "water", type: "fill", source: "osm", "source-layer": "water", layout: { visibility: vis(v.water) },
        paint: { "fill-color": p.water, "fill-opacity": sat ? 0.55 : 1, "fill-outline-color": p.waterLine } },
      { id: "rivers", type: "line", source: "osm", "source-layer": "waterways",
        filter: ["in", ["get", "kind"], ["literal", ["rau", "canal"]]], layout: { visibility: vis(v.rivers), "line-cap": "round" },
        paint: { "line-color": p.waterLine, "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.8, 11, 2, 15, 5, 18, 10] } },
      { id: "streams", type: "line", source: "osm", "source-layer": "waterways",
        filter: ["in", ["get", "kind"], ["literal", ["parau", "sant"]]], layout: { visibility: vis(v.streams), "line-cap": "round" },
        paint: { "line-color": p.waterLine, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.6, 14, 1.5, 18, 3] } },
      { id: "dams", type: "line", source: "osm", "source-layer": "waterways",
        filter: ["in", ["get", "kind"], ["literal", ["baraj", "stavila"]]], layout: { visibility: vis(v.dams) },
        paint: { "line-color": sat ? "#ffd166" : "#5d5d5d", "line-width": ["interpolate", ["linear"], ["zoom"], 11, 2, 16, 6] } },

      { id: "uat-line", type: "line", source: "osm", "source-layer": "boundaries", filter: ["==", ["get", "kind"], "uat"],
        layout: { visibility: vis(v.uat) },
        paint: { "line-color": sat ? "#f2e6ff" : p.uat, "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.8, 14, 2],
                 "line-dasharray": [4, 2], "line-opacity": 0.85 } },
      { id: "county-line", type: "line", source: "osm", "source-layer": "boundaries", filter: ["==", ["get", "kind"], "judet"],
        paint: { "line-color": sat ? "#f2e6ff" : p.county, "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1.5, 12, 4], "line-opacity": 0.8 } },
      { id: "uat-hover", type: "line", source: "admin", filter: ["==", ["get", "name"], state.hoverUat || ""],
        paint: { "line-color": p.accent, "line-width": 2.5, "line-opacity": 0.7 } },

      { id: "buildings", type: "fill", source: "osm", "source-layer": "buildings", filter: buildingFilter(state),
        paint: { "fill-color": ["match", ["get", "kind"], ...Object.entries(p.bld).flat(), p.bld.altele],
                 "fill-opacity": sat ? 0.25 : 1,
                 "fill-outline-color": ["case", ["==", ["get", "kind"], "bloc"], p.bldBlocLine, p.bldLine] } },
      { id: "buildings-bloc-line", type: "line", source: "osm", "source-layer": "buildings", minzoom: 14,
        filter: ["all", ["==", ["get", "kind"], "bloc"], buildingFilter(state)],
        paint: { "line-color": p.bldBlocLine, "line-width": 1.2 } },

      { id: "roads-casing", type: "line", source: "osm", "source-layer": "roads",
        filter: ["all", roadFilter(state), ["!=", ["get", "cls"], "track"]],
        layout: { "line-cap": "round", "line-join": "round",
                  "line-sort-key": ["index-of", ["get", "cls"], ["literal", ROAD_ORDER]] },
        paint: { "line-color": ["case", ["==", ["get", "bridge"], 1], p.bridge, byCls(p.casing, p.casing.street)],
                 "line-width": roadWidth((z) => (z < 11 ? 0.8 : z < 14 ? 1.4 : 2.2)),
                 "line-opacity": ["interpolate", ["linear"], ["zoom"], 6, 0.6, 10, 1] } },
      { id: "roads", type: "line", source: "osm", "source-layer": "roads",
        filter: ["all", roadFilter(state), ["!=", ["get", "cls"], "track"]],
        layout: { "line-cap": "round", "line-join": "round",
                  "line-sort-key": ["index-of", ["get", "cls"], ["literal", ROAD_ORDER]] },
        paint: { "line-color": byCls(p.road, p.road.street), "line-width": roadWidth(0) } },
      { id: "tracks", type: "line", source: "osm", "source-layer": "roads",
        filter: ["all", ["==", ["get", "cls"], "track"], roadFilter(state)],
        paint: { "line-color": sat ? "#f0d9a8" : p.road.track, "line-width": roadWidth(0), "line-dasharray": [2.5, 1.5] } },
      { id: "oneway", type: "symbol", source: "osm", "source-layer": "roads", minzoom: 16,
        filter: ["all", ["==", ["get", "oneway"], 1], roadFilter(state)],
        layout: { "symbol-placement": "line", "symbol-spacing": 120, "text-field": "→", "text-font": FONT,
                  "text-size": 12, "text-keep-upright": false, "text-rotation-alignment": "map" },
        paint: { "text-color": p.textSoft } },

      { id: "rail", type: "line", source: "osm", "source-layer": "rail", layout: { visibility: vis(v.rail) },
        paint: { "line-color": p.rail, "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1, 14, 3] } },
      { id: "rail-dash", type: "line", source: "osm", "source-layer": "rail", minzoom: 11, layout: { visibility: vis(v.rail) },
        paint: { "line-color": p.railDash, "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1, 14, 1.8], "line-dasharray": [3, 3] } },

      // --- etichete
      { id: "water-label", type: "symbol", source: "osm", "source-layer": "water_labels", layout: {
          "text-field": ["get", "name"], "text-font": FONT_I, "text-size": 12, "text-max-width": 8 },
        paint: { "text-color": sat ? "#d6ecff" : p.waterText, "text-halo-color": halo, "text-halo-width": 1.2 } },
      { id: "river-label", type: "symbol", source: "osm", "source-layer": "waterways", minzoom: 10,
        filter: ["all", ["has", "name"], ["in", ["get", "kind"], ["literal", ["rau", "canal", "parau"]]]],
        layout: { "symbol-placement": "line", "text-field": ["get", "name"], "text-font": FONT_I,
                  "text-size": ["interpolate", ["linear"], ["zoom"], 10, 11, 16, 13], "symbol-spacing": 400 },
        paint: { "text-color": sat ? "#d6ecff" : p.waterText, "text-halo-color": halo, "text-halo-width": 1.2 } },
      { id: "road-name", type: "symbol", source: "osm", "source-layer": "roads", minzoom: 13,
        filter: ["all", ["has", "name"], roadFilter(state)], layout: {
          visibility: vis(v.roadlabels), "symbol-placement": "line", "text-field": ["get", "name"], "text-font": FONT,
          "text-size": ["interpolate", ["linear"], ["zoom"], 13, 10, 17, 13], "symbol-spacing": 350,
          "text-padding": 4 },
        paint: { "text-color": text, "text-halo-color": halo, "text-halo-width": 1.4 } },
      { id: "road-ref", type: "symbol", source: "osm", "source-layer": "roads", minzoom: 8,
        filter: ["all", ["has", "ref"], ["in", ["get", "cls"], ["literal", ["dn", "dj", "dc"]]], roadFilter(state)],
        layout: { visibility: vis(v.roadlabels), "symbol-placement": "line", "symbol-spacing": 500,
                  "text-field": ["get", "ref"], "text-font": FONT_M, "text-size": 10.5,
                  "text-rotation-alignment": "viewport", "icon-rotation-alignment": "viewport",
                  "icon-image": ["concat", "shield-", ["get", "cls"]], "icon-text-fit": "both",
                  "icon-text-fit-padding": [1, 3, 1, 3], "text-padding": 20 },
        paint: { "text-color": ["match", ["get", "cls"], "dn", "#ffffff", "#2b2003"] } },
      // --- selecție, analiză, măsurare (sub pictograme)
      { id: "sel-fill", type: "fill", source: "sel", filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": p.select, "fill-opacity": 0.25 } },
      { id: "sel-line", type: "line", source: "sel", filter: ["!=", ["geometry-type"], "Point"],
        paint: { "line-color": p.select, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 16, 5], "line-opacity": 0.9 } },
      { id: "sel-point", type: "circle", source: "sel", filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 18, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": p.select, "circle-stroke-width": 3 } },
      { id: "an-fill", type: "fill", source: "analysis", filter: ["==", ["get", "role"], "radius"],
        paint: { "fill-color": p.accent, "fill-opacity": 0.05 } },
      { id: "an-radius", type: "line", source: "analysis", filter: ["==", ["get", "role"], "radius"],
        paint: { "line-color": p.accent, "line-width": 2, "line-dasharray": [3, 2] } },
      { id: "an-line", type: "line", source: "analysis", filter: ["==", ["get", "role"], "link"],
        paint: { "line-color": ["coalesce", ["get", "color"], p.accent], "line-width": 2, "line-dasharray": [2, 1.5] } },
      { id: "an-label", type: "symbol", source: "analysis", filter: ["==", ["get", "role"], "link"],
        layout: { "symbol-placement": "line-center", "text-field": ["get", "label"], "text-font": FONT_M, "text-size": 11.5,
                  "text-allow-overlap": false },
        paint: { "text-color": text, "text-halo-color": halo, "text-halo-width": 2 } },
      { id: "measure-line", type: "line", source: "measure", filter: ["==", ["geometry-type"], "LineString"],
        paint: { "line-color": p.measure, "line-width": 3, "line-dasharray": [2, 1] } },
      { id: "measure-pt", type: "circle", source: "measure", filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 4.5, "circle-color": "#ffffff", "circle-stroke-color": p.measure, "circle-stroke-width": 2.5 } },
      { id: "measure-label", type: "symbol", source: "measure", filter: ["has", "label"],
        layout: { "text-field": ["get", "label"], "text-font": FONT_M, "text-size": 12, "text-offset": [0, -1.3],
                  "text-allow-overlap": true },
        paint: { "text-color": text, "text-halo-color": halo, "text-halo-width": 2 } },

      // --- obiective
      { id: "poi-minor", type: "symbol", source: "pois", minzoom: 13, filter: poiFilter(state, false), layout: {
          "icon-image": ["concat", "poi-", ["get", "cat"]],
          "icon-size": ["interpolate", ["linear"], ["zoom"], 13, 0.72, 16, 1], "icon-allow-overlap": true, "icon-ignore-placement": true,
          "text-field": ["step", ["zoom"], "", 15, ["coalesce", ["get", "name"], ""]], "text-font": FONT,
          "text-size": 11, "text-anchor": "left", "text-offset": [1.2, 0], "text-optional": true, "text-max-width": 12 },
        paint: { "text-color": text, "text-halo-color": halo, "text-halo-width": 1.5 } },
      { id: "poi-major", type: "symbol", source: "pois", minzoom: 8, filter: poiFilter(state, true), layout: {
          "icon-image": ["concat", "poi-", ["get", "cat"]],
          "icon-size": ["interpolate", ["linear"], ["zoom"], 8, 0.62, 13, 0.9, 16, 1.05], "icon-allow-overlap": true, "icon-ignore-placement": true,
          "symbol-sort-key": ["match", ["get", "cat"], "pompieri", 0, "spital", 1, "ambulanta", 2, 5],
          "text-field": ["step", ["zoom"], "", 13, ["coalesce", ["get", "name"], ""]], "text-font": FONT_M,
          "text-size": 11.5, "text-anchor": "left", "text-offset": [1.25, 0], "text-optional": true, "text-max-width": 14 },
        paint: { "text-color": text, "text-halo-color": halo, "text-halo-width": 1.6 } },

      { id: "hydrant-dot", type: "circle", source: "hydrants", maxzoom: 14, layout: { visibility: vis(v.hidranti) },
        paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 1.8, 13, 4.5], "circle-color": "#c8102e",
                 "circle-stroke-color": "#ffffff", "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 8, 0.5, 13, 1.5] } },
      { id: "hydrant-icon", type: "symbol", source: "hydrants", minzoom: 14, layout: {
          visibility: vis(v.hidranti), "icon-image": "hydrant-isu", "icon-allow-overlap": true, "icon-ignore-placement": true,
          "icon-size": ["interpolate", ["linear"], ["zoom"], 14, 0.8, 17, 1.05],
          "text-field": ["step", ["zoom"], "", 16, ["coalesce", ["get", "_label"], ""]], "text-font": FONT_M,
          "text-size": 11, "text-anchor": "top", "text-offset": [0, 1.1], "text-optional": true },
        paint: { "text-color": sat ? "#ffffff" : "#a00d25", "text-halo-color": halo, "text-halo-width": 1.6 } },

      { id: "places", type: "symbol", source: "osm", "source-layer": "places", layout: {
          visibility: vis(v.places),
          "text-field": ["get", "name"],
          "text-font": ["match", ["get", "kind"], ["city", "town"], ["literal", FONT_M], ["literal", FONT]],
          "text-size": ["match", ["get", "kind"], "city", 17, "town", 15, "village", 12.5, "suburb", 12, 11],
          "text-transform": ["match", ["get", "kind"], ["city", "town"], "uppercase", "none"],
          "text-letter-spacing": ["match", ["get", "kind"], ["city", "town"], 0.06, 0],
          "symbol-sort-key": ["-", 0, ["coalesce", ["get", "population"], 0]], "text-max-width": 9 },
        paint: { "text-color": sat ? "#ffffff" : p.placeText, "text-halo-color": halo, "text-halo-width": 1.6 } },

      { id: "pin", type: "symbol", source: "pin", layout: { "icon-image": "pin", "icon-anchor": "bottom", "icon-allow-overlap": true } },
    ],
  };
}
