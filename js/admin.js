// Panoul de administrare: utilizatori, lista de hidranți și cadastrul apelor.
// Totul se face în browser; rezultatul sunt trei fișiere de urcat în GitHub:
//   web/users.json            (utilizatorii și cheile lor criptate)
//   web/data/hidranti.enc     (hidranții, criptați)
//   web/data/hidrografie.enc  (cadastrul apelor ABA, criptat)
import { wrapFor, encryptJSON, generatePassword, ITERATIONS } from "./auth.js";
import { fromStereo70, distance } from "./geo.js";
import { SUBUNIT_TYPES, normalizeSubunit, normalizeSubunitsDoc, subunitsFromOsm, parseCoordinateCandidates } from "./subunits.js?v=20261018-itineraries-v2";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const normKey = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

function download(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ------------------------------------------------------------------ citirea fișierului de hidranți

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v;
  let s = String(v).trim().replace(/\s/g, "");
  if ((s.match(/,/g) || []).length === 1 && !s.includes(".")) s = s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseCSV(text) {
  const first = text.split(/\r?\n/)[0];
  const delim = [";", "\t", ",", "|"].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift().map((h) => h.trim());
  return rows.filter((r) => r.some((c) => c.trim())).map((r) => Object.fromEntries(head.map((h, i) => [h || `col${i + 1}`, (r[i] ?? "").trim()])));
}

async function loadSheetJS() {
  if (window.XLSX) return window.XLSX;
  await new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "vendor/xlsx.full.min.js";
    s.onload = res;
    s.onerror = () => rej(new Error("Nu pot încărca cititorul de Excel."));
    document.head.appendChild(s);
  });
  return window.XLSX;
}

async function readRows(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv") || name.endsWith(".txt")) {
    const buf = await file.arrayBuffer();
    let text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    if (text.includes("�")) text = new TextDecoder("windows-1250").decode(buf);
    return { rows: parseCSV(text.replace(/^﻿/, "")) };
  }
  if (name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".ods")) {
    const XLSX = await loadSheetJS();
    const wb = XLSX.read(await file.arrayBuffer());
    const rows = [];
    for (const sn of wb.SheetNames) rows.push(...XLSX.utils.sheet_to_json(wb.Sheets[sn], { defval: "", raw: true }));
    return { rows };
  }
  if (name.endsWith(".geojson") || name.endsWith(".json")) {
    const fc = JSON.parse(await file.text());
    const feats = fc.features || [fc];
    return { rows: feats.map((f) => f.properties || {}), points: feats.map((f) => (f.geometry?.type === "Point" ? f.geometry.coordinates.slice(0, 2) : null)) };
  }
  if (name.endsWith(".kml")) {
    const doc = new DOMParser().parseFromString(await file.text(), "application/xml");
    const rows = [], points = [];
    for (const pm of doc.getElementsByTagName("Placemark")) {
      const c = pm.getElementsByTagName("coordinates")[0]?.textContent.trim().split(/\s+/)[0];
      if (!c) continue;
      const props = { nume: pm.getElementsByTagName("name")[0]?.textContent.trim() || "" };
      for (const d of pm.getElementsByTagName("Data")) props[d.getAttribute("name")] = d.getElementsByTagName("value")[0]?.textContent || "";
      for (const d of pm.getElementsByTagName("SimpleData")) props[d.getAttribute("name")] = d.textContent;
      rows.push(props);
      points.push(c.split(",").slice(0, 2).map(Number));
    }
    return { rows, points };
  }
  throw new Error("Format necunoscut. Folosește Excel, CSV, GeoJSON sau KML.");
}

const LAT = ["lat", "latitudine", "latitude", "latwgs84", "n"];
const LON = ["lon", "lng", "long", "longitudine", "longitude", "lonwgs84", "e"];
const X = ["x", "xstereo", "xstereo70", "stereo70x", "coordx", "coordonatax", "nord", "northing"];
const Y = ["y", "ystereo", "ystereo70", "stereo70y", "coordy", "coordonatay", "est", "easting"];

function findCol(rows, names) {
  return Object.keys(rows[0] || {}).find((k) => names.includes(normKey(k)));
}

/** Transformă rândurile în puncte; detectează WGS84 sau Stereo 70 și ordinea coordonatelor. */
export async function parseHydrants(file, uatAt) {
  const { rows, points: given } = await readRows(file);
  if (!rows.length) throw new Error("Fișierul nu are rânduri.");
  let candidates;
  let system = "WGS84";
  if (given) candidates = [given];
  else {
    const la = findCol(rows, LAT), lo = findCol(rows, LON), xc = findCol(rows, X), yc = findCol(rows, Y);
    if (la && lo) candidates = [rows.map((r) => [num(r[lo]), num(r[la])])];
    else if (xc && yc) {
      const pairs = rows.map((r) => [num(r[xc]), num(r[yc])]);
      const big = pairs.some(([a, b]) => Math.abs(a) > 1000 || Math.abs(b) > 1000);
      if (big) {
        system = "Stereo 70";
        candidates = [
          pairs.map(([a, b]) => (a && b ? fromStereo70(a, b) : null)),
          pairs.map(([a, b]) => (a && b ? fromStereo70(b, a) : null)),
        ];
      } else {
        candidates = [pairs.map(([a, b]) => [a, b]), pairs.map(([a, b]) => [b, a])];
      }
    } else {
      throw new Error(`Nu găsesc coloanele cu coordonate. Coloane găsite: ${Object.keys(rows[0]).join(", ")}. ` +
        "Redenumește-le în „Lat” și „Lon” (WGS84) sau „X” și „Y” (Stereo 70).");
    }
  }
  const inside = (p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]) && uatAt(p[0], p[1]);
  const best = candidates.map((c) => ({ c, n: c.filter(inside).length })).sort((a, b) => b.n - a.n)[0];
  const features = [];
  const outside = [];
  rows.forEach((r, i) => {
    const p = best.c[i];
    const props = {};
    for (const [k, v] of Object.entries(r)) {
      if (v === "" || v === null || v === undefined || k.startsWith("_")) continue;
      props[String(k).trim()] = v instanceof Date ? v.toLocaleDateString("ro-RO") : v;
    }
    const u = inside(p);
    if (!u) { outside.push(i + 2); return; }
    props._uat = u.name;
    features.push({ type: "Feature", id: features.length, properties: props,
      geometry: { type: "Point", coordinates: [+p[0].toFixed(7), +p[1].toFixed(7)] } });
  });
  return { fc: { type: "FeatureCollection", features }, system, total: rows.length, outside,
    columns: Object.keys(rows[0]) };
}

// ------------------------------------------------------------------ citirea hidrografiei (cadastrul apelor ABA)

const HYDROGRAPHY_FORMAT = "harta-botosani-hydrography";
const isPosition = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) &&
  Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;

/** Lungimea în km a unui rând de linii (LineString sau MultiLineString); null dacă geometria nu e validă. */
function linesKm(geometry) {
  const lines = geometry?.type === "LineString" ? [geometry.coordinates]
    : geometry?.type === "MultiLineString" ? geometry.coordinates : null;
  if (!Array.isArray(lines) || !lines.length) return null;
  let m = 0;
  for (const line of lines) {
    if (!Array.isArray(line) || line.length < 2 || !line.every(isPosition)) return null;
    for (let i = 1; i < line.length; i++) m += distance(line[i - 1], line[i]);
  }
  return m / 1000;
}

/**
 * Validează GeoJSON-ul de hidrografie produs de pipeline/hydrography.py.
 * Întoarce { fc, count, km, uats, source, generated } (km = lungimea albiilor din fișier,
 * uats = câte UAT-uri distincte sunt atinse) sau aruncă un Error cu mesaj în română.
 */
export function readHydrography(text) {
  let fc;
  try { fc = JSON.parse(text); } catch { throw new Error("Fișierul nu este JSON valid."); }
  if (fc?.format !== HYDROGRAPHY_FORMAT) {
    throw new Error("Nu este un fișier de hidrografie (lipsește formatul „harta-botosani-hydrography”). Folosește rezultatul pipeline/hydrography.py.");
  }
  if (fc.version !== 1) throw new Error(`Versiunea ${fc.version ?? "necunoscută"} nu este acceptată; aplicația citește versiunea 1.`);
  if (!Array.isArray(fc.features) || !fc.features.length) throw new Error("Fișierul nu are niciun curs de apă.");
  let km = 0;
  const uats = new Set();
  fc.features.forEach((f, i) => {
    const p = f?.properties;
    const at = `Cursul ${i + 1}${typeof p?.name === "string" && p.name.trim() ? ` (${p.name.trim()})` : ""}`;
    if (f?.type !== "Feature" || !p || typeof p !== "object") throw new Error(`${at}: nu este un obiect GeoJSON valid.`);
    if (typeof p.name !== "string" || !p.name.trim()) throw new Error(`${at}: lipsește numele.`);
    if (typeof p.code !== "string" || !p.code.trim()) throw new Error(`${at}: lipsește codul.`);
    if (!Array.isArray(p.uats) || !p.uats.every((u) => typeof u === "string")) throw new Error(`${at}: lista de UAT-uri nu este validă.`);
    const len = linesKm(f.geometry);
    if (len === null) throw new Error(`${at}: geometria nu este o linie validă.`);
    km += len;
    for (const u of p.uats) uats.add(u);
  });
  return { fc, count: fc.features.length, km, uats: uats.size,
    source: typeof fc.source === "string" ? fc.source : "", generated: typeof fc.generated === "string" ? fc.generated : "" };
}

// ------------------------------------------------------------------ subunități ISU

const EMPTY_FORM = { id: "", name: "", type: "detasament", coords: "", address: "", phone: "", equipment: "", staff: "", notes: "" };

function createSubunitsEditor(ctx) {
  let list = structuredClone(ctx.state.data.subunits || []);
  let form = null;          // null = formular închis; altfel valorile din formular
  let picking = false;
  let container = null;

  const resolveCoords = (text) => {
    const cands = parseCoordinateCandidates(text, fromStereo70)
      .filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[1]) <= 90 && Math.abs(p[0]) <= 180);
    const inside = cands.find((p) => ctx.uatAt(p[0], p[1]));
    const p = inside || cands[0];
    return p ? { lon: p[0], lat: p[1], uat: inside ? ctx.uatAt(p[0], p[1])?.name : null } : null;
  };

  const commit = (next, msg) => {
    list = next;
    ctx.onSubunits?.(list, { draft: true });
    try {
      ctx.cloudDb?.saveSubunits?.({ format: "harta-botosani-subunitati", version: 1, subunits: list });
    } catch (e) { console.warn(e); }
    if (msg) ctx.toast(msg);
    draw();
  };

  const coordPreview = () => {
    if (!form?.coords) return `<span class="muted">Ex. <code>47.7471, 26.6694</code> (din Google Maps), <code>47°44'49"N 26°40'09"E</code> sau Stereo 70 <code>X Y</code></span>`;
    const r = resolveCoords(form.coords);
    if (!r) return `<span class="warnp">Nu recunosc coordonatele.</span>`;
    return r.uat ? `✓ ${r.lat.toFixed(6)}, ${r.lon.toFixed(6)} · UAT ${esc(r.uat)}`
      : `<span class="warnp">${r.lat.toFixed(6)}, ${r.lon.toFixed(6)} · în afara județului${form.type === "vecin" ? " (ok pentru județ vecin)" : ""}</span>`;
  };

  const formHTML = () => `<form class="uform" id="adm-su-form">
      <h4>${form.id ? "Modifică subunitatea" : "Adaugă subunitate"}</h4>
      <label>Denumire *<input name="name" required maxlength="160" value="${esc(form.name)}" placeholder="ex. Detașamentul de Pompieri Dorohoi"></label>
      <label>Tip<select name="type">${Object.entries(SUBUNIT_TYPES).map(([k, v]) => `<option value="${k}" ${form.type === k ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></label>
      <label>Coordonate (punctul de ieșire al autospecialelor) *<input name="coords" required value="${esc(form.coords)}" placeholder="47.7471, 26.6694" autocomplete="off"></label>
      <div class="su-coord" id="adm-su-preview">${coordPreview()}</div>
      <div class="row-btns" style="margin-top:6px">
        <button class="btn" type="button" data-su="pick">${picking ? "Dă click pe hartă… (anulează)" : "📍 Alege pe hartă"}</button>
        ${form.coords && resolveCoords(form.coords) ? `<button class="btn" type="button" data-su="fly-form">Arată pe hartă</button>` : ""}
      </div>
      <label>Adresă<input name="address" maxlength="300" value="${esc(form.address)}" placeholder="ex. Str. Mihai Eminescu nr. 1, Dorohoi"></label>
      <label>Telefon dispecerat<input name="phone" maxlength="80" value="${esc(form.phone)}"></label>
      <label>Tehnică din dotare<textarea name="equipment" rows="2" maxlength="1000" placeholder="ex. 2 ASAS, 1 autoscară 30 m, 1 SMURD, 1 descarcerare">${esc(form.equipment)}</textarea></label>
      <label>Efectiv pe tură (persoane)<input name="staff" type="number" min="0" max="999" value="${esc(form.staff)}"></label>
      <label>Observații<textarea name="notes" rows="2" maxlength="2000">${esc(form.notes)}</textarea></label>
      <div class="row-btns">
        <button class="btn primary" type="submit">${form.id ? "Salvează modificările" : "Adaugă în listă"}</button>
        <button class="btn" type="button" data-su="cancel">Renunță</button>
      </div>
    </form>`;

  const draw = () => {
    if (!container) return;
    const draft = !!ctx.state.data.subunitsDraft;
    const typeCount = (t) => list.filter((s) => s.type === t).length;
    container.innerHTML = `
      <h3>Subunități ISU (puncte de plecare pentru rute)</h3>
      <p class="muted">${list.length ? `${list.length} subunități în lista oficială · ${Object.keys(SUBUNIT_TYPES).filter(typeCount).map((t) => `${typeCount(t)} ${esc(SUBUNIT_TYPES[t].split(" ")[0].toLowerCase())}`).join(", ")}` :
        "Lista oficială e goală – pe hartă apar deocamdată punctele „pompieri” din OpenStreetMap."}</p>
      ${list.length ? `<ul class="ulist">${list.map((s) => `
        <li><div class="u-main"><b>${esc(s.name)}</b><span>${esc(SUBUNIT_TYPES[s.type])} · ${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}${ctx.uatAt(s.lon, s.lat) ? " · " + esc(ctx.uatAt(s.lon, s.lat).name) : ""}</span>
          ${s.equipment ? `<span>🚒 ${esc(s.equipment)}</span>` : ""}</div>
          <div class="u-act"><button class="lnk" type="button" data-su-fly="${esc(s.id)}">Hartă</button>
          <button class="lnk" type="button" data-su-edit="${esc(s.id)}">Modifică</button>
          <button class="lnk danger" type="button" data-su-del="${esc(s.id)}">Șterge</button></div></li>`).join("")}</ul>` : ""}
      ${form ? formHTML() : `<div class="row-btns" style="margin-top:10px">
        <button class="btn primary" type="button" data-su="new">+ Adaugă subunitate</button>
        ${!list.length && subunitsFromOsm(ctx.state.data.osmPois).length ? `<button class="btn" type="button" data-su="from-osm">Preia cele ${subunitsFromOsm(ctx.state.data.osmPois).length} din OSM (apoi le corectez)</button>` : ""}
      </div>`}
      ${draft ? `<div class="save">
        <p><b>Lista e salvată doar în acest browser</b> (o vezi deja pe hartă). Ca s-o vadă toți utilizatorii, descarcă
        <code>subunitati.json</code> și urcă-l în GitHub în <code>web/data/</code>, sau trimite-l lui Claude.</p>
        <div class="row-btns"><button class="btn primary" type="button" data-su="download">Descarcă subunitati.json</button>
        <button class="btn" type="button" data-su="revert">Renunță la modificările locale</button></div></div>` :
        list.length ? `<div class="row-btns"><button class="btn" type="button" data-su="download">Descarcă subunitati.json</button></div>` : ""}
      <div class="row-btns"><label class="btn file">Încarcă subunitati.json<input type="file" id="adm-su-import" accept=".json,application/json" hidden></label></div>`;
  };

  const readForm = (f) => {
    const fd = new FormData(f);
    form = { ...form, ...Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)])) };
  };

  const onClick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const f = container.querySelector("#adm-su-form");
    if (f) readForm(f);
    const act = b.dataset.su;
    if (act === "new") { form = { ...EMPTY_FORM }; draw(); container.querySelector("[name=name]")?.focus(); }
    if (act === "cancel") { form = null; picking = false; draw(); }
    if (act === "pick") {
      if (picking) { picking = false; ctx.pickPoint?.(null); draw(); return; }
      picking = true;
      ctx.toast("Dă click pe hartă exact la ieșirea autospecialelor din subunitate.");
      ctx.pickPoint?.((ll) => {
        picking = false;
        if (!ll || !form) { draw(); return; }
        form.coords = `${ll[1].toFixed(6)}, ${ll[0].toFixed(6)}`;
        draw();
      });
      draw();
    }
    if (act === "fly-form") { const r = resolveCoords(form?.coords); if (r) ctx.flyToPoint?.([r.lon, r.lat]); }
    if (act === "from-osm") commit(subunitsFromOsm(ctx.state.data.osmPois), "Am preluat punctele din OSM. Verifică și corectează fiecare subunitate.");
    if (act === "download") download("subunitati.json", { ...normalizeSubunitsDoc({ subunits: list }), updatedAt: new Date().toISOString() });
    if (act === "revert") {
      list = structuredClone(ctx.state.data.subunitsPublished?.subunits || []);
      ctx.onSubunits?.(list, { draft: false });
      form = null;
      draw();
    }
    if (b.dataset.suFly) { const s = list.find((x) => x.id === b.dataset.suFly); if (s) ctx.flyToPoint?.([s.lon, s.lat]); }
    if (b.dataset.suEdit) {
      const s = list.find((x) => x.id === b.dataset.suEdit);
      if (s) { form = { ...EMPTY_FORM, ...s, coords: `${s.lat}, ${s.lon}`, staff: s.staff ?? "" }; draw(); container.querySelector("#adm-su-form")?.scrollIntoView({ block: "nearest" }); }
    }
    if (b.dataset.suDel) {
      if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Sigur?"; return; }
      commit(list.filter((x) => x.id !== b.dataset.suDel), "Subunitate ștearsă.");
    }
  };

  const onInput = (e) => {
    if (e.target.form?.id !== "adm-su-form") return;
    readForm(e.target.form);
    if (e.target.name === "coords" || e.target.name === "type") container.querySelector("#adm-su-preview").innerHTML = coordPreview();
  };

  const onSubmit = (e) => {
    if (e.target.id !== "adm-su-form") return;
    e.preventDefault();
    e.stopPropagation();
    readForm(e.target);
    const r = resolveCoords(form.coords);
    if (!r) { ctx.toast("Coordonatele nu sunt valide."); return; }
    if (!r.uat && form.type !== "vecin") { ctx.toast("Punctul e în afara județului. Alege tipul „Subunitate județ vecin” sau corectează coordonatele."); return; }
    const s = normalizeSubunit({ ...form, lat: r.lat, lon: r.lon, id: form.id || undefined });
    if (!s) { ctx.toast("Completează denumirea și coordonatele."); return; }
    const next = form.id ? list.map((x) => (x.id === form.id ? s : x)) : [...list, s];
    form = null;
    commit(next, `Subunitatea „${s.name}” a fost ${next.length > list.length ? "adăugată" : "actualizată"} pe hartă.`);
  };

  const onChange = async (e) => {
    if (e.target.id !== "adm-su-import") return;
    e.stopPropagation();
    const file = e.target.files[0];
    if (!file) return;
    try {
      const doc = normalizeSubunitsDoc(JSON.parse(await file.text()));
      if (!doc.subunits.length) throw new Error();
      commit(doc.subunits, `${doc.subunits.length} subunități încărcate.`);
    } catch {
      ctx.toast("Fișierul nu conține o listă validă de subunități.");
    }
  };

  return {
    mount(el) {
      if (!el?.addEventListener) return;
      container = el;
      el.addEventListener("click", onClick);
      el.addEventListener("input", onInput);
      el.addEventListener("submit", onSubmit);
      el.addEventListener("change", onChange);
      draw();
    },
  };
}

// ------------------------------------------------------------------ panoul

export function renderAdmin(el, ctx) {
  const subunitsEditor = createSubunitsEditor(ctx);
  const { session } = ctx;
  const users = structuredClone(session.users);
  if (!Number.isSafeInteger(users.iterations) || users.iterations <= 0) users.iterations = ITERATIONS;
  let dirtyUsers = false;
  const newPasswords = Object.create(null); // u -> parolă afișată o singură dată
  let busy = false;
  let pending = null;    // hidranți importați, încă nesalvați
  let pendingHydro = null; // hidrografie citită din fișier, încă nesalvată

  const draw = () => {
    el.innerHTML = `<div class="adm">
      <div id="adm-su"></div>
      <h3>Utilizatori</h3>
      <ul class="ulist">${users.users.map((x) => `
        <li><div class="u-main"><b>${esc(x.name)}</b><span>${esc(x.u)} · ${x.role === "admin" ? "administrator" : "utilizator"}</span>
          ${newPasswords[x.u] ? `<span class="pw">Parolă nouă: <code>${esc(newPasswords[x.u])}</code>
            <button class="lnk" data-copy="${esc(newPasswords[x.u])}">Copiază</button></span>` : ""}</div>
          <div class="u-act"><button class="lnk" data-reset="${esc(x.u)}">Parolă nouă</button>
          ${x.u !== session.u ? `<button class="lnk danger" data-del="${esc(x.u)}">Șterge</button>` : ""}</div></li>`).join("")}
      </ul>
      <form class="uform" id="adm-add">
        <h4>Adaugă utilizator</h4>
        <label>Nume afișat<input id="adm-name" required placeholder="ex. Ion Popescu"></label>
        <label>Utilizator<input id="adm-user" required pattern="[a-z0-9._-]{3,32}" placeholder="ex. ion.popescu" autocomplete="off"></label>
        <label>Rol<select id="adm-role"><option value="user">Utilizator</option><option value="admin">Administrator</option></select></label>
        <button class="btn primary" type="submit">Adaugă</button>
      </form>
      ${dirtyUsers ? `<div class="save">
        <p><b>Modificările nu sunt încă active.</b> Descarcă <code>users.json</code> și urcă-l în GitHub, în folderul <code>web/</code>
        (înlocuiește fișierul existent). Sau trimite-l lui Claude.</p>
        <button class="btn primary" data-act="dl-users">Descarcă users.json</button></div>` : ""}

      <h3>Hidranți</h3>
      <p class="muted">${ctx.state.data.hydrants.features.length.toLocaleString("ro-RO")} hidranți încărcați acum.</p>
      <label class="btn file">Alege fișierul (Excel, CSV, GeoJSON, KML)<input type="file" id="adm-file" accept=".xlsx,.xls,.ods,.csv,.txt,.geojson,.json,.kml" hidden></label>
      <div id="adm-imp"></div>
      <p class="muted" style="margin-top:14px">Fișierul original nu părăsește calculatorul. Se urcă doar varianta criptată.</p>

      <h3>Hidrografie (cadastrul apelor)</h3>
      <p class="muted" id="adm-hyd-now">${hydroNow()}</p>
      <label class="btn file">Alege fișierul (GeoJSON de hidrografie)<input type="file" id="adm-hydro-file" accept=".geojson,.json" hidden></label>
      <div id="adm-hyd"></div>
      <p class="muted" style="margin-top:14px">Fișierul clar nu părăsește calculatorul. Se urcă doar varianta criptată.</p>
    </div>`;
    subunitsEditor.mount(el.querySelector("#adm-su"));
    drawHydro();
  };

  const hydroNow = () => `${(ctx.state.data.hydrography?.features.length ?? 0).toLocaleString("ro-RO")} râuri încărcate acum.`;

  const drawHydro = (msg) => {
    const box = el.querySelector("#adm-hyd");
    if (!box) return;
    if (msg) { box.innerHTML = msg; return; }
    if (!pendingHydro) { box.innerHTML = ""; return; }
    const h = pendingHydro;
    box.innerHTML = `<dl class="stats">
        <dt>Râuri (cursuri de apă)</dt><dd>${h.count.toLocaleString("ro-RO")}</dd>
        <dt>Lungime în fișier</dt><dd>${Math.round(h.km).toLocaleString("ro-RO")} km</dd>
        <dt>UAT-uri atinse</dt><dd>${h.uats}</dd>
        ${h.source ? `<dt>Sursă</dt><dd>${esc(h.source)}</dd>` : ""}
        ${h.generated ? `<dt>Generat</dt><dd>${esc(h.generated)}</dd>` : ""}
      </dl>
      <div class="row-btns"><button class="btn" data-act="show-hydro">Folosește în această sesiune</button>
      <button class="btn primary" data-act="dl-hydro">Descarcă hidrografie.enc</button></div>
      <p class="muted">Urcă <code>hidrografie.enc</code> în GitHub, în <code>web/data/</code>, sau trimite-l lui Claude.</p>`;
  };

  const drawImport = (msg) => {
    const box = el.querySelector("#adm-imp");
    if (msg) { box.innerHTML = msg; return; }
    if (!pending) { box.innerHTML = ""; return; }
    const p = pending;
    box.innerHTML = `<dl class="stats">
        <dt>Rânduri în fișier</dt><dd>${p.total}</dd>
        <dt>Hidranți în județ</dt><dd>${p.fc.features.length}</dd>
        <dt>Coordonate</dt><dd>${p.system}</dd>
      </dl>
      ${p.outside.length ? `<p class="warnp">${p.outside.length} rânduri ignorate (fără coordonate sau în afara județului): rândurile ${p.outside.slice(0, 12).join(", ")}${p.outside.length > 12 ? "…" : ""}</p>` : ""}
      <p class="muted">Coloane: ${esc(p.columns.join(", "))}</p>
      <div class="row-btns"><button class="btn" data-act="show">Arată pe hartă</button>
      <button class="btn primary" data-act="dl-hyd">Descarcă hidranti.enc</button></div>
      <p class="muted">Urcă <code>hidranti.enc</code> în GitHub, în <code>web/data/</code>, sau trimite-l lui Claude.</p>`;
  };

  draw();

  const updateUsers = async (action) => {
    if (busy) return;
    busy = true;
    const disabled = new Map([...el.querySelectorAll("button, input, select")].map((control) => [control, control.disabled]));
    for (const control of disabled.keys()) control.disabled = true;
    el.setAttribute("aria-busy", "true");
    try {
      await action();
    } catch {
      ctx.toast("Nu am putut actualiza utilizatorii. Încearcă din nou; modificarea nu a fost salvată.");
    } finally {
      busy = false;
      for (const control of el.querySelectorAll("button, input, select")) control.disabled = disabled.get(control) ?? false;
      el.removeAttribute("aria-busy");
    }
  };

  el.onsubmit = async (e) => {
    if (e.target.id !== "adm-add") return;
    e.preventDefault();
    if (busy) return;
    const u = el.querySelector("#adm-user").value.trim().toLowerCase();
    if (users.users.some((x) => x.u === u)) { ctx.toast("Există deja un utilizator cu acest nume."); return; }
    const name = el.querySelector("#adm-name").value.trim();
    const role = el.querySelector("#adm-role").value;
    await updateUsers(async () => {
      const password = generatePassword();
      const wrapped = await wrapFor(session.key, password, users.iterations);
      if (users.users.some((x) => x.u === u)) { ctx.toast("Există deja un utilizator cu acest nume."); return; }
      users.users.push({ u, name, role, ...wrapped });
      newPasswords[u] = password;
      dirtyUsers = true;
      draw();
    });
  };

  el.onchange = async (e) => {
    if (e.target.id === "adm-hydro-file") {
      const f = e.target.files[0];
      if (!f) return;
      drawHydro(`<p class="muted">Se citește ${esc(f.name)}…</p>`);
      try {
        pendingHydro = readHydrography(await f.text());
        drawHydro();
      } catch (err) {
        pendingHydro = null;
        drawHydro(`<p class="warnp">${esc(err.message)}</p>`);
      }
      return;
    }
    if (e.target.id !== "adm-file") return;
    const f = e.target.files[0];
    if (!f) return;
    drawImport(`<p class="muted">Se citește ${esc(f.name)}…</p>`);
    try {
      pending = await parseHydrants(f, ctx.uatAt);
      drawImport();
    } catch (err) {
      pending = null;
      drawImport(`<p class="warnp">${esc(err.message)}</p>`);
    }
  };

  el.onclick = async (e) => {
    const b = e.target.closest("button");
    if (!b || busy || b.disabled) return;
    if (b.dataset.copy) ctx.copy(b.dataset.copy);
    if (b.dataset.reset) {
      const x = users.users.find((y) => y.u === b.dataset.reset);
      if (!x) return;
      await updateUsers(async () => {
        const password = generatePassword();
        const wrapped = await wrapFor(session.key, password, users.iterations);
        Object.assign(x, wrapped);
        newPasswords[x.u] = password;
        dirtyUsers = true;
        draw();
      });
    }
    if (b.dataset.del) {
      if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Sigur? Apasă din nou"; return; }
      users.users = users.users.filter((y) => y.u !== b.dataset.del);
      delete newPasswords[b.dataset.del];
      dirtyUsers = true;
      draw();
    }
    if (b.dataset.act === "dl-users") download("users.json", users);
    if (b.dataset.act === "show" && pending) { ctx.onHydrants(pending.fc); ctx.toast(`${pending.fc.features.length} hidranți afișați (doar în această sesiune)`); }
    if (b.dataset.act === "dl-hyd" && pending) download("hidranti.enc", await encryptJSON(session.key, pending.fc));
    if (b.dataset.act === "show-hydro" && pendingHydro) {
      ctx.onHydrography(pendingHydro.fc);
      el.querySelector("#adm-hyd-now").textContent = hydroNow();
      ctx.toast(`${pendingHydro.count} râuri încărcate (doar în această sesiune)`);
    }
    if (b.dataset.act === "dl-hydro" && pendingHydro) download("hidrografie.enc", await encryptJSON(session.key, pendingHydro.fc));
  };
}
