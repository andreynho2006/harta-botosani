// Autentificare și criptare, fără server.
//
// Datele sensibile (hidranții) sunt criptate cu o cheie de date (AES-GCM, 256 biți).
// Fiecare utilizator are în users.json o copie a acestei chei, criptată cu o cheie
// derivată din parola lui (PBKDF2-SHA256). Fără o parolă corectă, cheia de date și
// fișierele criptate nu pot fi citite, chiar dacă cineva descarcă fișierele site-ului.

const te = new TextEncoder();
const td = new TextDecoder();
const subtle = crypto.subtle;
export const ITERATIONS = 310000;

export function toB64(bytes) {
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
  return btoa(s);
}
export const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

async function kek(password, salt, iterations) {
  const base = await subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

const dataKey = (raw) => subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);

/** Încearcă parola; întoarce cheia de date (octeți) sau null. */
export async function unlock(entry, password, iterations) {
  try {
    const k = await kek(password, fromB64(entry.salt), iterations);
    const raw = await subtle.decrypt({ name: "AES-GCM", iv: fromB64(entry.iv) }, k, fromB64(entry.wk));
    return new Uint8Array(raw);
  } catch {
    return null;
  }
}

/** Creează intrarea din users.json pentru o parolă nouă. */
export async function wrapFor(raw, password, iterations = ITERATIONS) {
  const salt = rand(16);
  const iv = rand(12);
  const k = await kek(password, salt, iterations);
  const wk = await subtle.encrypt({ name: "AES-GCM", iv }, k, raw);
  return { salt: toB64(salt), iv: toB64(iv), wk: toB64(wk) };
}

export async function encryptJSON(raw, obj) {
  const iv = rand(12);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, await dataKey(raw), te.encode(JSON.stringify(obj)));
  return { v: 1, iv: toB64(iv), ct: toB64(ct) };
}

export async function decryptJSON(raw, box) {
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: fromB64(box.iv) }, await dataKey(raw), fromB64(box.ct));
  return JSON.parse(td.decode(pt));
}

/** Parolă ușor de dictat: 4 grupe de câte 4 caractere, fără caractere confundabile. */
export function generatePassword() {
  const abc = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const b = rand(16);
  const s = Array.from(b, (x) => abc[x % abc.length]).join("");
  return s.match(/.{4}/g).join("-");
}

// ------------------------------------------------------------------ sesiune

const KEY = "hb.session";

function readSession() {
  for (const st of [sessionStorage, localStorage]) {
    try {
      const v = st.getItem(KEY);
      if (v) return JSON.parse(v);
    } catch { return null; }
  }
  return null;
}

function saveSession(s, remember) {
  clearSessions();
  try {
    (remember ? localStorage : sessionStorage).setItem(KEY, JSON.stringify(s));
  } catch { /* fără stocare */ }
}

function clearSessions() {
  for (const st of [sessionStorage, localStorage]) {
    try { st.removeItem(KEY); } catch { /* */ }
  }
}

async function wrapperFingerprint(entry, iterations) {
  const bytes = te.encode(JSON.stringify([iterations, entry.salt, entry.iv, entry.wk]));
  return toB64(await subtle.digest("SHA-256", bytes));
}

export function logout() {
  clearSessions();
  location.reload();
}

export async function loadUsers() {
  const r = await fetch("users.json", { cache: "no-cache" });
  if (!r.ok) throw new Error("users.json lipsește");
  return r.json();
}

/**
 * Arată ecranul de autentificare până la o parolă corectă.
 * Întoarce { u, name, role, key: Uint8Array, users }.
 */
export async function ensureLogin() {
  const users = await loadUsers();
  const entries = Array.isArray(users.users) ? users.users : [];
  const saved = readSession();
  if (saved) {
    const entry = entries.find((x) => x.u === saved.u);
    try {
      if (entry && typeof saved.k === "string" &&
          saved.f === await wrapperFingerprint(entry, users.iterations)) {
        const raw = fromB64(saved.k);
        if (raw.length === 32) return { u: entry.u, name: entry.name, role: entry.role, key: raw, users };
      }
    } catch { /* Invalid sessions require a fresh login. */ }
  }
  clearSessions();

  const el = document.getElementById("login");
  el.hidden = false;
  const form = el.querySelector("form");
  const err = el.querySelector(".lg-err");
  const btn = form.querySelector("button[type=submit]");
  const userIn = form.querySelector("#lg-user");
  setTimeout(() => userIn.focus(), 50);

  return new Promise((resolve) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.hidden = true;
      btn.disabled = true;
      btn.textContent = "Se verifică…";
      const u = userIn.value.trim().toLowerCase();
      const password = form.querySelector("#lg-pass").value;
      const entry = entries.find((x) => x.u === u) || entries[0];
      const raw = await unlock(entry, password, users.iterations);
      btn.disabled = false;
      btn.textContent = "Intră";
      if (!raw || raw.length !== 32 || entry.u !== u) {
        err.hidden = false;
        form.querySelector("#lg-pass").select();
        return;
      }
      const f = await wrapperFingerprint(entry, users.iterations);
      saveSession({ u: entry.u, k: toB64(raw), f }, form.querySelector("#lg-remember").checked);
      el.hidden = true;
      resolve({ u: entry.u, name: entry.name, role: entry.role, key: raw, users });
    });
  });
}
