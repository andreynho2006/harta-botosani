// Conectare și sincronizare în timp real cu Google Firebase Firestore.
// Proiect: harta-botosani
// Permite salvarea automată a situațiilor operative CJSU și a subunităților ISU
// direct în Cloud, sincronizându-se instantaneu pe toate ecranele fără descărcare manuală.

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCEc644m0R7UNixARql2IxgGZDR1Y-20Mw",
  authDomain: "harta-botosani.firebaseapp.com",
  projectId: "harta-botosani",
  storageBucket: "harta-botosani.firebasestorage.app",
  messagingSenderId: "153917804703",
  appId: "1:153917804703:web:a18dfa49f8a565e23492aa",
};

let dbInstance = null;
let firestoreLib = null;
let status = "offline"; // 'offline' | 'connecting' | 'connected' | 'error'
const listeners = new Set();

function emitStatus(s, detail = "") {
  status = s;
  for (const fn of listeners) {
    try { fn(status, detail); } catch (e) { console.warn(e); }
  }
}

export function onCloudStatus(fn) {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}

export function getCloudStatus() {
  return status;
}

/** Inițializează Firebase SDK în browser în mod dinamic, fără a bloca rularea offline sau testele Node.js. */
async function getFirestoreDb() {
  if (dbInstance) return { db: dbInstance, fs: firestoreLib };
  if (typeof window === "undefined" || !window.navigator?.onLine) {
    emitStatus("offline");
    return null;
  }
  emitStatus("connecting");
  try {
    const { initializeApp, getApps } = await import("https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js");
    const fs = await import("https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js");
    firestoreLib = fs;
    const app = getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
    try {
      dbInstance = fs.initializeFirestore(app, {
        localCache: fs.persistentLocalCache({
          tabManager: fs.persistentMultipleTabManager(),
        }),
      });
    } catch {
      dbInstance = fs.getFirestore(app);
    }
    emitStatus("connected");
    return { db: dbInstance, fs: firestoreLib };
  } catch (err) {
    console.warn("Nu s-a putut inițializa Firebase Firestore (mod offline activ):", err);
    emitStatus("error", err.message);
    return null;
  }
}

/** Curăță obiectele GeoJSON de valori undefined pentru compatibilitate cu Firestore. */
function sanitizeForFirestore(obj) {
  if (obj === undefined) return null;
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeForFirestore);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = sanitizeForFirestore(v);
  }
  return out;
}

function prepareSituationForFirestore(sit) {
  const clean = sanitizeForFirestore(sit);
  if (clean && clean.features && typeof clean.features === "object") {
    clean.features = JSON.stringify(clean.features);
  }
  return clean;
}

function parseSituationFromFirestore(d) {
  if (!d) return null;
  const out = { ...d };
  if (typeof out.features === "string") {
    try {
      out.features = JSON.parse(out.features);
    } catch (e) {
      console.warn("Eroare la parsarea GeoJSON din Firestore:", e);
    }
  }
  return out;
}

// ------------------------------------------------------------------ Subunități ISU

/** Ascultă în timp real lista oficială a subunităților ISU din Firestore. */
export async function subscribeSubunits(onUpdate) {
  const conn = await getFirestoreDb();
  if (!conn) return () => {};
  const { db, fs } = conn;
  const docRef = fs.doc(db, "config", "subunitati");
  return fs.onSnapshot(docRef, (snap) => {
    if (snap.exists()) {
      const data = snap.data();
      if (Array.isArray(data?.subunits)) onUpdate(data);
    }
  }, (err) => {
    console.warn("Eroare la sincronizarea subunităților din cloud:", err);
  });
}

/** Salvează lista oficială a subunităților în Firestore. */
export async function saveSubunitsCloud(subunitsDoc) {
  const conn = await getFirestoreDb();
  if (!conn) return false;
  const { db, fs } = conn;
  try {
    const clean = sanitizeForFirestore(subunitsDoc);
    await fs.setDoc(fs.doc(db, "config", "subunitati"), {
      ...clean,
      updatedAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    console.warn("Eroare la salvarea subunităților în cloud:", err);
    return false;
  }
}

// ------------------------------------------------------------------ Situații operative CJSU

/** Ascultă în timp real toate situațiile operative CJSU din Firestore. */
export async function subscribeSituations(onUpdateAll) {
  const conn = await getFirestoreDb();
  if (!conn) return () => {};
  const { db, fs } = conn;
  const colRef = fs.collection(db, "situatii");
  return fs.onSnapshot(colRef, (snap) => {
    const events = [];
    snap.forEach((doc) => {
      const d = parseSituationFromFirestore(doc.data());
      if (d && d.id) events.push(d);
    });
    onUpdateAll(events);
  }, (err) => {
    console.warn("Eroare la sincronizarea situațiilor din cloud:", err);
  });
}

/** Salvează o situație operativă în Firestore. */
export async function saveSituationCloud(situation) {
  if (!situation?.id) return false;
  const conn = await getFirestoreDb();
  if (!conn) return false;
  const { db, fs } = conn;
  try {
    const clean = prepareSituationForFirestore(situation);
    await fs.setDoc(fs.doc(db, "situatii", String(situation.id)), clean);
    return true;
  } catch (err) {
    console.warn(`Eroare la salvarea situației ${situation.id} în cloud:`, err);
    return false;
  }
}

/** Șterge o situație din Firestore. */
export async function deleteSituationCloud(situationId) {
  if (!situationId) return false;
  const conn = await getFirestoreDb();
  if (!conn) return false;
  const { db, fs } = conn;
  try {
    await fs.deleteDoc(fs.doc(db, "situatii", String(situationId)));
    return true;
  } catch (err) {
    console.warn(`Eroare la ștergerea situației ${situationId} din cloud:`, err);
    return false;
  }
}

/** Încarcă inițial situațiile din cloud o singură dată. */
export async function fetchSituationsCloud() {
  const conn = await getFirestoreDb();
  if (!conn) return [];
  const { db, fs } = conn;
  try {
    const snap = await fs.getDocs(fs.collection(db, "situatii"));
    const events = [];
    snap.forEach((doc) => {
      const d = parseSituationFromFirestore(doc.data());
      if (d && d.id) events.push(d);
    });
    return events;
  } catch (err) {
    console.warn("Eroare la citirea inițială din cloud:", err);
    return [];
  }
}
