import { EventStore, createEvent, sanitizeEvent } from "./event-store.js";
import { snapToRoad, buildRoadSegment } from "./road-sketch.js";
import { outsideMask } from "./commune-geometry.js";
import { LAYER_GROUPS } from "./config.js";
import { localTime, isoTime, dateLabel } from "./operations-time.js";

const FC = (features = []) => ({ type: "FeatureCollection", features });
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TYPES = { fire: "Incendiu", flood: "Inundații", snow: "Înzăpezire", storm: "Furtună", other: "Alt eveniment" };
const KINDS = { blocked: "Drum impracticabil", flooded: "Inundat", damaged: "Deteriorat", snow: "Înzăpezit", threat: "Zonă amenințată", fire: "Incendiu", command: "Punct de comandă", shelter: "Punct de sprijin / adăpost" };
const STATUSES = { threat: "Potențial", reported: "Raportat", confirmed: "Confirmat", resolved: "Remediat" };
const ALERTS = { "": "Fără cod", yellow: "Cod galben", orange: "Cod portocaliu", red: "Cod roșu", "ro-alert": "RO-Alert" };
const options = (items, selected) => Object.entries(items).map(([value, label]) => `<option value="${esc(value)}" ${selected === value ? "selected" : ""}>${esc(label)}</option>`).join("");
const id = () => crypto.randomUUID();

function download(name, archive) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function initOperations(ctx) {
  const { map, state, uatAt, toast, selectTab, setSheet, applyStyle, renderLayerPanel, stopOtherTools } = ctx;
  const panel = document.querySelector("#tab-situatii");
  const db = new EventStore(ctx.storage);
  let active = null, dirty = false, exported = false, mode = null, points = [], startSnap = null, roadPool = [];
  let pending = null, editingId = null, beforePresentation = null, previousOverlays = null;
  let archiveError = "", notice = "", resizeFrame = 0;
  state.operations = { features: FC(), draft: FC(), selection: FC(), mask: FC(), focusGeometry: null };
  const drawbar = document.createElement("div");
  drawbar.className = "ops-drawbar";
  drawbar.hidden = true;
  document.querySelector(".mapwrap").appendChild(drawbar);
  const presentation = document.createElement("section");
  presentation.className = "ops-presentation";
  presentation.hidden = true;
  document.querySelector(".mapwrap").appendChild(presentation);

  function message(text) { notice = text; toast(text); const el = panel.querySelector(".ops-notice"); if (el) el.textContent = text; }
  function list() {
    try { archiveError = ""; return db.list(); }
    catch { archiveError = "Arhiva locală nu poate fi citită. Datele existente nu au fost înlocuite; poți exporta situația curentă în JSON."; return []; }
  }
  function changed() {
    dirty = true; exported = false;
    const badge = panel.querySelector("#ops-save-state");
    if (badge) badge.textContent = "Modificări nesalvate";
  }
  function currentView() {
    const center = map.getCenter();
    return { center: [center.lng, center.lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
  }
  function snapshot() {
    if (!panel.querySelector("#ops-meta").reportValidity()) throw new Error("Invalid event metadata");
    return sanitizeEvent({ ...active, updatedAt: new Date().toISOString(), view: currentView(), visible: { ...state.visible } });
  }
  function selectedGeometry() {
    const names = new Set(active?.areas || []);
    const features = state.data.admin.features.filter(f => f.properties.kind === "uat" && names.has(f.properties.name));
    const coordinates = features.flatMap(f => f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates);
    return { features, geometry: coordinates.length ? { type: "MultiPolygon", coordinates } : null };
  }
  function sync(refresh = false) {
    const selected = selectedGeometry();
    const geometry = mode === "area" ? null : selected.geometry;
    state.operations.features = active?.features || FC();
    state.operations.selection = FC(selected.features);
    state.operations.focusGeometry = geometry;
    state.operations.mask = geometry ? outsideMask(geometry) : FC();
    state.operations.draft = pending ? FC([pending]) : points.length ? FC([{ type: "Feature", properties: {},
      geometry: points.length === 1 ? { type: "Point", coordinates: points[0] } : { type: "LineString", coordinates: points } }]) : FC();
    if (refresh) applyStyle();
    else for (const [key, source] of [["features", "ops-features"], ["selection", "ops-selection"], ["mask", "ops-mask"], ["draft", "ops-draft"]]) map.getSource(source)?.setData(state.operations[key]);
  }
  function fit() {
    const selected = selectedGeometry();
    const geometries = selected.features.length ? selected.features.map(f => f.geometry) : active?.features.features.map(f => f.geometry) || [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const visit = (coordinates) => {
      if (typeof coordinates[0] === "number") {
        minX = Math.min(minX, coordinates[0]); minY = Math.min(minY, coordinates[1]);
        maxX = Math.max(maxX, coordinates[0]); maxY = Math.max(maxY, coordinates[1]);
      }
      else coordinates.forEach(visit);
    };
    geometries.forEach(g => visit(g.coordinates));
    if (!Number.isFinite(minX)) return;
    const presenting = document.body.classList.contains("presenting");
    const head = presenting ? presentation.querySelector(".ops-slide-head").offsetHeight + 24 : 80;
    const bottom = presenting ? presentation.querySelector(".ops-slide-foot").offsetHeight + 24 : 100;
    const height = map.getContainer().clientHeight;
    map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    map.fitBounds([[minX, minY], [maxX, maxY]], {
      padding: { top: Math.min(head, height * 0.45), bottom: Math.min(bottom, height * 0.3), left: 28, right: 68 }, retainPadding: false, maxZoom: 16, duration: 450,
    });
  }
  function stopDrawing() {
    mode = null; points = []; startSnap = null; roadPool = [];
    drawbar.hidden = true;
    map.getCanvas().style.cursor = "";
    sync(true);
  }
  function cancelDrawing() {
    if (!mode) return;
    stopDrawing();
    render();
  }
  function start(tool) {
    if (!active) return;
    if (pending) return message("Adaugă / actualizează marcajul curent sau apasă Renunță înainte de alt instrument.");
    stopOtherTools();
    mode = tool; points = []; startSnap = null; roadPool = []; pending = null; editingId = null;
    sync(true);
    map.getCanvas().style.cursor = "crosshair";
    selectTab("situatii"); setSheet("peek");
    drawInstructions();
  }
  function drawInstructions() {
    const text = mode === "road" ? (startSnap ? "Alege capătul sectorului pe același drum" : "Alege începutul sectorului pe drum")
      : mode === "area" ? "Alege comune / orașe; apasă din nou pentru a deselecta"
      : mode === "zone" ? `Contur: ${points.length} puncte · minimum 3` : "Alege poziția marcajului";
    drawbar.innerHTML = `<span>${text}</span>${mode === "zone" ? `<button data-action="undo" type="button">Înapoi</button>` : ""}
      ${mode === "zone" || mode === "area" ? `<button data-action="finish" type="button">Gata</button>` : ""}
      <button data-action="cancel" type="button">${mode === "area" ? "Închide selecția" : "Anulează"}</button>`;
    drawbar.hidden = false;
  }
  function prepare(geometry, kind, road = "") {
    pending = { type: "Feature", geometry, properties: { id: id(), kind, status: "reported", title: "", road,
      kmFrom: null, kmTo: null, source: "", observedAt: new Date().toISOString(), notes: "" } };
    stopDrawing();
    sync(); render(); selectTab("situatii"); setSheet("half");
    requestAnimationFrame(() => panel.querySelector("#ops-marker")?.scrollIntoView({ block: "start" }));
  }
  function finishDrawing() {
    if (mode === "area") { stopDrawing(); render(); selectTab("situatii"); setSheet("half"); fit(); return; }
    if (mode === "zone") {
      if (points.length < 3) return message("Alege cel puțin trei puncte pentru contur.");
      const ring = [...points, points[0]];
      prepare({ type: "Polygon", coordinates: [ring] }, "threat");
    }
  }
  function roads() {
    if (!map.isStyleLoaded()) return [];
    return map.querySourceFeatures("osm", { sourceLayer: "roads" }).filter(f => state.visible["road:" + f.properties.cls]);
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
      requestAnimationFrame(() => panel.querySelector("#ops-marker").scrollIntoView({ block: "start" }));
      return true;
    }
    const coordinate = [event.lngLat.lng, event.lngLat.lat];
    if (mode === "area") {
      const uat = uatAt(...coordinate);
      if (!uat) { message("Punctul nu are o limită UAT disponibilă."); return true; }
      active.areas = active.areas.includes(uat.name) ? active.areas.filter(name => name !== uat.name) : [...active.areas, uat.name];
      changed(); sync(); render(); drawInstructions();
    } else if (mode === "point") prepare({ type: "Point", coordinates: coordinate }, "command");
    else if (mode === "zone") { points.push(coordinate); sync(); drawInstructions(); }
    else if (mode === "road") {
      const available = roads();
      const snapped = snapToRoad(coordinate, available, 80);
      if (!snapped) { message("Apropie harta și alege un punct pe un drum vizibil."); return true; }
      if (!startSnap) {
        startSnap = snapped; roadPool = available; points = [snapped.coordinate]; sync(); drawInstructions();
        message(`Început ales: ${snapped.road.ref || snapped.road.name || "drum"}. Alege capătul sectorului.`);
      } else {
        const geometry = buildRoadSegment(startSnap, snapped, [...roadPool, ...available]);
        if (!geometry) { message("Nu pot urmări acest sector pe același drum. Apropie harta sau alege un sector mai scurt."); return true; }
        prepare(geometry, "blocked", startSnap.road.ref || startSnap.road.name || "");
      }
    }
    return true;
  }
  function archiveHTML(events) {
    return `<section class="ops-card"><h3>Arhivă locală <span>${events.length}</span></h3>
      ${archiveError ? `<p class="warnp">${esc(archiveError)}</p>` : ""}
      <label>Evenimente salvate<select id="ops-archive"><option value="">Alege un eveniment…</option>${events.map(e => `<option value="${esc(e.id)}">${esc(e.title)} · ${dateLabel(e.updatedAt)}</option>`).join("")}</select></label>
      <div class="ops-actions"><button class="btn" type="button" data-action="open">Deschide</button><button class="btn" type="button" data-action="archive-export">Exportă arhiva JSON</button></div>
      <label class="btn file ops-import">Importă JSON<input id="ops-import" type="file" accept=".json,application/json" hidden></label>
      <p class="muted">Salvarea este pe acest browser. Fișierul JSON permite păstrarea arhivei și mutarea ei pe alt calculator.</p></section>`;
  }
  function markerHTML() {
    if (!pending) return "";
    const p = pending.properties, isRoad = pending.geometry.type === "LineString";
    const relevant = isRoad ? Object.fromEntries(Object.entries(KINDS).filter(([key]) => ["blocked", "flooded", "damaged", "snow"].includes(key)))
      : pending.geometry.type === "Polygon" ? Object.fromEntries(Object.entries(KINDS).filter(([key]) => ["threat", "flooded", "fire", "snow"].includes(key)))
      : KINDS;
    return `<form id="ops-marker" class="ops-card"><h3>${editingId ? "Editează marcajul" : "Detalii marcaj"}</h3>
      <label>Tip<select name="kind">${options(relevant, p.kind)}</select></label>
      <label>Stare<select name="status">${options(STATUSES, p.status)}</select></label>
      <label>Denumire<input name="title" maxlength="200" value="${esc(p.title)}" placeholder="Ex. DJ29 · sector impracticabil"></label>
      ${isRoad ? `<label>Drum<input name="road" maxlength="100" value="${esc(p.road)}"></label><div class="ops-grid"><label>De la km<input name="kmFrom" type="number" min="0" step="any" value="${p.kmFrom ?? ""}"></label><label>Până la km<input name="kmTo" type="number" min="0" step="any" value="${p.kmTo ?? ""}"></label></div>
        <p class="muted">Kilometrajul este o etichetă. Sectorul este poziționat prin punctele alese pe hartă.</p>` : ""}
      <label>Ora informației<input name="observedAt" type="datetime-local" value="${localTime(p.observedAt)}"></label>
      <label>Sursa informației<input name="source" maxlength="300" value="${esc(p.source)}" placeholder="Ex. raport echipaj / administrator drum"></label>
      <label>Observații<textarea name="notes" maxlength="5000" rows="2">${esc(p.notes)}</textarea></label>
      <div class="ops-actions"><button class="btn primary" type="submit">${editingId ? "Actualizează marcajul" : "Adaugă marcajul"}</button><button class="btn" type="button" data-action="discard-mark">Renunță</button></div></form>`;
  }
  function render() {
    const events = list();
    panel.innerHTML = `<div class="ops"><p class="ops-notice" role="status">${esc(notice)}</p>
      ${!active ? `<section class="ops-card ops-intro"><h2>Situații operative</h2><p>Pregătește harta unui eveniment, marchează sectoarele afectate și păstrează situația în arhivă.</p>
        <form id="ops-new"><label>Denumirea evenimentului<input name="title" required maxlength="200" placeholder="Ex. Înzăpezire · zona Darabani"></label><label>Tip eveniment<select name="type">${options(TYPES, "other")}</select></label><button class="btn primary" type="submit">Creează situația</button></form></section>` : `
      <section class="ops-card"><div class="ops-card-title"><h2>${esc(active.title)}</h2><button type="button" class="lnk" data-action="new">Închide</button></div>
        <p id="ops-save-state" class="ops-save-state">${dirty ? exported ? "Exportat JSON · nesalvat în browser" : "Modificări nesalvate" : `Salvat · ${dateLabel(active.updatedAt)}`}</p>
        <form id="ops-meta"><label>Denumire<input data-field="title" maxlength="200" required value="${esc(active.title)}"></label>
          <label>Tip eveniment<select data-field="type">${options(TYPES, active.type)}</select></label>
          <div class="ops-grid"><label>Avertizare<select data-alert="code">${options(ALERTS, active.alert.code)}</select></label><label>Sursă<input data-alert="source" maxlength="300" value="${esc(active.alert.source)}" placeholder="ANM / IGSU / altă sursă"></label></div>
          <div class="ops-grid"><label>Valabil de la<input data-alert="validFrom" type="datetime-local" value="${localTime(active.alert.validFrom)}"></label><label>Până la<input data-alert="validTo" type="datetime-local" value="${localTime(active.alert.validTo)}"></label></div>
          <label>Mesaj / avertizare<textarea data-alert="text" rows="2" maxlength="5000">${esc(active.alert.text)}</textarea></label>
          <label>Rezumat situație<textarea data-field="notes" rows="2" maxlength="10000">${esc(active.notes)}</textarea></label><p class="muted">Orele sunt afișate în ora României.</p></form>
        <div class="ops-actions"><button class="btn primary" type="button" data-action="save">Salvează situația</button><button class="btn" type="button" data-action="event-export">Exportă situația JSON</button>
          <button class="btn" type="button" data-action="present">Prezintă</button><button class="btn" type="button" data-action="duplicate">Duplică</button></div></section>
      <section class="ops-card"><h3>Zona prezentării</h3><p class="muted">Selectează una sau mai multe comune / orașe. Zonele efectiv afectate se desenează separat.</p>
        <div class="ops-tags">${active.areas.map(name => `<button class="ops-tag" type="button" data-area="${esc(name)}" title="Elimină din selecție">${esc(name)} ×</button>`).join("") || `<span class="muted">Nicio zonă selectată · context județean</span>`}</div>
        <div class="ops-actions"><button class="btn" type="button" data-action="area">Alege pe hartă</button><button class="btn" type="button" data-action="fit">Încadrează</button><button class="btn" type="button" data-action="preset">Straturi pentru eveniment</button></div></section>
      <section class="ops-card"><h3>Adaugă pe hartă</h3><div class="ops-tools"><button class="btn" type="button" data-action="road">━ Drum afectat</button><button class="btn" type="button" data-action="zone">▱ Zonă afectată</button><button class="btn" type="button" data-action="point">● Punct operativ</button></div></section>
      ${markerHTML()}
      <section class="ops-card"><h3>Marcaje <span>${active.features.features.length}</span></h3><ul class="ops-marks">${active.features.features.map(f => {
        const p = f.properties;
        return `<li><button class="ops-mark-main" type="button" data-mark="${esc(p.id)}"><b>${esc(p.title || KINDS[p.kind])}</b><small>${esc(STATUSES[p.status])}${p.source ? ` · ${esc(p.source)}` : ""} · ${dateLabel(p.observedAt)}</small></button><button class="ops-remove" type="button" data-remove="${esc(p.id)}" aria-label="Elimină marcajul">×</button></li>`;
      }).join("") || `<li class="muted">Niciun marcaj adăugat.</li>`}</ul></section>`}
      ${archiveHTML(events)}</div>`;
  }
  function save() {
    try {
      if (pending || mode) return message("Finalizează marcajul sau selecția înainte de salvare.");
      active = db.save(snapshot()); dirty = false; exported = false; notice = "Situația a fost salvată în arhiva acestui browser."; render();
    } catch (error) { console.warn(error); message("Salvarea nu a reușit. Verifică datele; poți păstra situația prin «Exportă situația JSON»."); }
  }
  function setActive(event) {
    active = structuredClone(event); pending = null; editingId = null; dirty = false; exported = false; notice = "";
    stopDrawing();
    for (const key of Object.keys(state.visible)) if (typeof active.visible[key] === "boolean") state.visible[key] = active.visible[key];
    sync(true); renderLayerPanel(); render();
    if (active.view) map.jumpTo(active.view); else fit();
    selectTab("situatii");
  }
  function canReplaceDraft() {
    if ((!dirty || exported) && !pending && !mode) return true;
    message("Salvează sau exportă situația curentă înainte de a deschide alta.");
    return false;
  }
  function exitPresentation() {
    if (!document.body.classList.contains("presenting")) return;
    document.body.classList.remove("presenting"); presentation.hidden = true;
    state.operations.presenting = false;
    if (previousOverlays) { state.overlays = previousOverlays; previousOverlays = null; }
    applyStyle(); map.resize(); if (beforePresentation) map.jumpTo(beforePresentation);
    selectTab("situatii");
  }
  function present() {
    if (pending || mode) return message("Finalizează marcajul sau selecția înainte de prezentare.");
    beforePresentation = { ...currentView(), padding: map.getPadding() };
    previousOverlays = state.overlays;
    state.overlays = { sel: FC(), analysis: FC(), measure: FC(), pin: FC() };
    state.operations.presenting = true;
    state.operations.labelSize = window.innerWidth <= 760 ? 14 : 18;
    const counts = {};
    active.features.features.forEach(f => { const kind = f.properties.status === "resolved" ? "resolved" : f.properties.kind; counts[kind] = (counts[kind] || 0) + 1; });
    presentation.innerHTML = `<header class="ops-slide-head"><div><span class="ops-slide-eyebrow">${esc(TYPES[active.type])} · ${esc(active.areas.join(", ") || "Județul Botoșani")}</span>
      <h1>${esc(active.title)}</h1>${active.notes ? `<p>${esc(active.notes)}</p>` : ""}
      ${active.alert.code || active.alert.text ? `<p class="ops-alert" data-code="${esc(active.alert.code)}"><b>${esc(ALERTS[active.alert.code] || active.alert.code)}</b> ${esc(active.alert.text)}${active.alert.source ? ` · ${esc(active.alert.source)}` : ""}${active.alert.validFrom || active.alert.validTo ? ` · ${dateLabel(active.alert.validFrom)} – ${dateLabel(active.alert.validTo)}` : ""}</p>` : ""}</div>
      <button class="btn" type="button" data-action="exit">Ieși din prezentare</button></header>
      <footer class="ops-slide-foot"><div class="ops-legend">${Object.entries(counts).map(([kind, count]) => `<span><i data-kind="${esc(kind)}"></i>${esc(kind === "resolved" ? "Remediat" : KINDS[kind])}: ${count}</span>`).join("")}</div>
      <span>${dirty ? "Situație nesalvată" : "Actualizat " + dateLabel(active.updatedAt)}</span></footer>`;
    presentation.hidden = false; document.body.classList.add("presenting");
    applyStyle();
    requestAnimationFrame(() => { map.resize(); fit(); presentation.querySelector("button").focus(); });
  }
  panel.oninput = (event) => {
    if (!active) return;
    const input = event.target;
    if (input.dataset.field) { active[input.dataset.field] = input.value; changed(); }
    if (input.dataset.alert) {
      const field = input.dataset.alert;
      try {
        active.alert[field] = field === "validFrom" || field === "validTo" ? isoTime(input.value) : input.value;
        input.setCustomValidity("");
      } catch { input.setCustomValidity("Alege o dată și oră validă în ora României."); return; }
      changed();
    }
  };
  panel.onsubmit = (event) => {
    event.preventDefault();
    if (event.target.id === "ops-new") {
      const fields = new FormData(event.target);
      try { active = createEvent(fields.get("title"), fields.get("type")); dirty = true; exported = false; notice = ""; sync(true); render(); }
      catch { message("Introdu o denumire pentru eveniment."); }
    } else if (event.target.id === "ops-marker" && pending) {
      const fields = new FormData(event.target);
      const kmFrom = fields.get("kmFrom"), kmTo = fields.get("kmTo");
      if (kmFrom && kmTo && Number(kmTo) < Number(kmFrom)) return message("Kilometrul final trebuie să fie cel puțin egal cu cel inițial.");
      let observedAt;
      try { observedAt = isoTime(fields.get("observedAt")); }
      catch { return message("Alege o oră validă pentru informație, în ora României."); }
      Object.assign(pending.properties, { kind: fields.get("kind"), status: fields.get("status"), road: fields.get("road") || "",
        kmFrom: kmFrom ? Number(kmFrom) : null, kmTo: kmTo ? Number(kmTo) : null,
        source: fields.get("source"), observedAt, notes: fields.get("notes") });
      const roadTitle = [pending.properties.road, kmFrom !== null && kmFrom !== "" ? `km ${kmFrom}${kmTo ? "–" + kmTo : ""}` : ""].filter(Boolean).join(" · ");
      pending.properties.title = fields.get("title").trim() || roadTitle || KINDS[pending.properties.kind];
      const features = active.features.features.filter(f => f.properties.id !== editingId);
      const candidate = { ...active, features: FC([...features, pending]) };
      try { active = sanitizeEvent(candidate); pending = null; editingId = null; changed(); sync(); render(); }
      catch { message("Verifică datele marcajului înainte de adăugare."); }
    }
  };
  panel.onchange = async (event) => {
    if (event.target.id !== "ops-import") return;
    const file = event.target.files[0]; if (!file) return;
    if (!canReplaceDraft()) return;
    try {
      if (file.size > 32 * 1024 * 1024) throw new Error("Archive too large");
      const result = db.importArchive(await file.text());
      if (active) { const imported = db.load(active.id); if (imported && imported.updatedAt > active.updatedAt) setActive(imported); }
      notice = `Import: ${result.imported} evenimente adăugate / actualizate; ${result.skipped} versiuni păstrate.`; render(); toast(notice);
    } catch (error) { console.warn(error); message("Importul nu a reușit. Fișier invalid, prea mare sau spațiu local insuficient. Arhiva existentă a fost păstrată."); }
  };
  panel.onclick = (event) => {
    const button = event.target.closest("button"); if (!button) return;
    if (button.dataset.area) { if (pending) return message("Finalizează marcajul curent înainte de schimbarea zonei."); active.areas = active.areas.filter(name => name !== button.dataset.area); changed(); sync(true); render(); return; }
    if (button.dataset.remove) { if (pending) return message("Finalizează sau anulează editarea marcajului curent."); active.features.features = active.features.features.filter(f => f.properties.id !== button.dataset.remove); changed(); sync(); render(); return; }
    if (button.dataset.mark) {
      if (pending) return message("Finalizează sau anulează editarea marcajului curent.");
      pending = structuredClone(active.features.features.find(f => f.properties.id === button.dataset.mark)); editingId = pending.properties.id;
      sync(); render(); requestAnimationFrame(() => panel.querySelector("#ops-marker").scrollIntoView({ block: "start" })); return;
    }
    const action = button.dataset.action;
    if (["area", "road", "zone", "point"].includes(action)) return start(action);
    if (action === "save") save();
    if (action === "fit") { setSheet("peek"); fit(); }
    if (action === "preset") {
      const common = ["places", "uat", "road:dn", "road:dj", "road:dc", "road:street", "roadlabels", "poi:pompieri", "bld:bloc", "bld:public", "bld:industrial", "bld:comercial", "bld:casa"];
      const extras = { fire: ["hidranti", "hidranti_defecti", "poi:sursa_apa", "water", "rivers", "landuse"],
        flood: ["water", "rivers", "streams", "dams", "poi:baraj"], snow: ["rail"], storm: ["water", "rivers", "landuse"], other: [] };
      const enabled = new Set([...common, ...extras[active.type]]);
      for (const group of LAYER_GROUPS) for (const item of group.items) state.visible[item.id] = enabled.has(item.id);
      changed(); applyStyle(); renderLayerPanel(); message("Straturile pentru eveniment au fost aplicate. Le poți ajusta din fila Straturi.");
    }
    if (action === "present") present();
    if (action === "discard-mark") { pending = null; editingId = null; sync(); render(); }
    if (action === "new" && canReplaceDraft()) { active = null; stopDrawing(); render(); }
    if (action === "open" && canReplaceDraft()) {
      try { const saved = db.load(panel.querySelector("#ops-archive").value); if (saved) setActive(saved); else message("Alege un eveniment din arhivă."); }
      catch { message("Evenimentul nu a putut fi citit din arhiva locală."); }
    }
    if (action === "duplicate" && canReplaceDraft()) {
      const base = createEvent(active.title + " · copie", active.type);
      active = { ...structuredClone(active), id: base.id, title: base.title, createdAt: base.createdAt, updatedAt: base.updatedAt };
      dirty = true; exported = false; render();
    }
    if (action === "event-export") {
      try {
        if (pending || mode) return message("Finalizează marcajul sau selecția înainte de export.");
        download(`situatie-${active.id}.json`, { format: "harta-botosani-events", version: 1, exportedAt: new Date().toISOString(), events: [snapshot()] });
        exported = true; notice = "Situația a fost exportată în JSON. Păstrează fișierul pentru arhivă."; render();
      } catch { message("Verifică denumirea și datele situației înainte de export."); }
    }
    if (action === "archive-export") {
      try { download("arhiva-situatii.json", db.exportArchive()); message("Arhiva salvată a fost exportată. Modificările nesalvate nu sunt incluse."); }
      catch { message("Arhiva locală nu poate fi exportată. Folosește exportul situației curente."); }
    }
  };
  drawbar.onclick = (event) => {
    const action = event.target.closest("button")?.dataset.action;
    if (action === "finish") finishDrawing();
    if (action === "cancel") cancelDrawing();
    if (action === "undo") { points.pop(); sync(); drawInstructions(); }
  };
  presentation.onclick = (event) => { if (event.target.closest("[data-action=exit]")) exitPresentation(); };
  const handleKey = (event) => {
    if (event.key === "Escape" && document.body.classList.contains("presenting")) { exitPresentation(); event.preventDefault(); return true; }
    if (event.key === "Escape" && mode) { cancelDrawing(); event.preventDefault(); return true; }
    return false;
  };
  window.addEventListener("beforeunload", (event) => { if ((dirty && !exported) || pending || mode) { event.preventDefault(); event.returnValue = ""; } });
  window.addEventListener("resize", () => {
    if (!document.body.classList.contains("presenting")) return;
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      state.operations.labelSize = window.innerWidth <= 760 ? 14 : 18;
      if (map.getLayer("ops-features-label")) map.setLayoutProperty("ops-features-label", "text-size", state.operations.labelSize);
      map.resize(); fit();
    });
  });
  render();
  return { handleMapClick, handleKey, cancelDrawing, isDrawing: () => !!mode };
}
