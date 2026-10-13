// Panoul de administrare: utilizatori și lista de hidranți.
// Totul se face în browser; rezultatul sunt două fișiere de urcat în GitHub:
//   web/users.json            (utilizatorii și cheile lor criptate)
//   web/data/hidranti.enc     (hidranții, criptați)
import { wrapFor, encryptJSON, generatePassword, ITERATIONS } from "./auth.js";
import { fromStereo70 } from "./geo.js";

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

// ------------------------------------------------------------------ panoul

export function renderAdmin(el, ctx) {
  const { session } = ctx;
  const users = structuredClone(session.users);
  let dirtyUsers = false;
  let newPasswords = {}; // u -> parolă afișată o singură dată
  let pending = null;    // hidranți importați, încă nesalvați

  const draw = () => {
    el.innerHTML = `<div class="adm">
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
    </div>`;
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

  el.onsubmit = async (e) => {
    if (e.target.id !== "adm-add") return;
    e.preventDefault();
    const u = el.querySelector("#adm-user").value.trim().toLowerCase();
    if (users.users.some((x) => x.u === u)) { ctx.toast("Există deja un utilizator cu acest nume."); return; }
    const password = generatePassword();
    users.users.push({ u, name: el.querySelector("#adm-name").value.trim(), role: el.querySelector("#adm-role").value,
      ...(await wrapFor(session.key, password, users.iterations || ITERATIONS)) });
    newPasswords[u] = password;
    dirtyUsers = true;
    draw();
  };

  el.onchange = async (e) => {
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
    if (!b) return;
    if (b.dataset.copy) ctx.copy(b.dataset.copy);
    if (b.dataset.reset) {
      const x = users.users.find((y) => y.u === b.dataset.reset);
      const password = generatePassword();
      Object.assign(x, await wrapFor(session.key, password, users.iterations || ITERATIONS));
      newPasswords[x.u] = password;
      dirtyUsers = true;
      draw();
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
  };
}
