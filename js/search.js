// Căutare locală: localități, străzi, adrese, obiective, ape, hidranți și coordonate.
import { POI, LABELS } from "./config.js";

export const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const tokens = (s) => norm(s).split(/[^a-z0-9]+/).filter(Boolean);

const TYPE_WEIGHT = {
  "loc:city": 60, "loc:town": 55, "loc:village": 40, "loc:suburb": 30, "loc:hamlet": 25,
  poi: 28, hid: 26, apa: 20, str: 18, adr: 10,
};

export function typeInfo(type) {
  const [kind, sub] = type.split(":");
  if (kind === "loc") return { label: LABELS.place[sub] || "Localitate", cls: "t-loc" };
  if (kind === "poi") return { label: POI[sub]?.label.replace(/^Subunități ISU$/, "Pompieri") || "Obiectiv", cls: "t-poi", cat: sub };
  if (kind === "apa") return { label: LABELS.water[sub] || "Apă", cls: "t-apa" };
  if (kind === "str") return { label: "Stradă", cls: "t-str" };
  if (kind === "adr") return { label: "Adresă", cls: "t-adr" };
  if (kind === "hid") return { label: "Hidrant", cls: "t-hid" };
  return { label: kind, cls: "" };
}

export class SearchIndex {
  constructor() {
    this.items = [];
  }

  add(rows) {
    for (const [label, type, lon, lat, ctx, bbox, ref] of rows) {
      const lt = tokens(label);
      this.items.push({
        label, type, lon, lat, ctx, bbox, ref,
        lt, ct: tokens(ctx), ln: norm(label),
        w: TYPE_WEIGHT[type] ?? TYPE_WEIGHT[type.split(":")[0]] ?? 0,
      });
    }
  }

  query(q, limit = 14) {
    const qt = tokens(q);
    if (!qt.length) return [];
    const qn = norm(q).trim();
    const out = [];
    for (const it of this.items) {
      let score = it.w;
      let ok = true;
      for (const t of qt) {
        let hit = 0;
        for (let i = 0; i < it.lt.length; i++) {
          const w = it.lt[i];
          if (w === t) { hit = Math.max(hit, i === 0 ? 30 : 22); }
          else if (w.startsWith(t)) { hit = Math.max(hit, i === 0 ? 20 : 14); }
        }
        if (!hit) for (const w of it.ct) if (w.startsWith(t)) { hit = 6; break; }
        if (!hit) { ok = false; break; }
        score += hit;
      }
      if (!ok) continue;
      if (it.ln === qn) score += 40;
      else if (it.ln.startsWith(qn)) score += 15;
      score -= it.label.length * 0.15;
      out.push([score, it]);
    }
    out.sort((a, b) => b[0] - a[0]);
    // nu repeta aceeași etichetă din același loc
    const seen = new Set();
    const res = [];
    for (const [, it] of out) {
      const k = it.ln + "|" + it.ctx + "|" + it.type;
      if (seen.has(k)) continue;
      seen.add(k);
      res.push(it);
      if (res.length >= limit) break;
    }
    return res;
  }
}
