// Pictogramele hărții, desenate pe canvas (nu depind de fișiere externe).
import { POI } from "./config.js?v=20261026-hydro";

// Glife 24×24. Fiecare element: [cale SVG, "fg" = alb sau "bg" = culoarea insignei]
const GLYPHS = {
  pompieri: [["M12 2.2c.9 3.3 4.9 5.6 4.9 10.3a4.9 4.9 0 0 1-9.8 0c0-2.3 1.1-3.9 2.3-5 0 1.7.8 2.9 2 3 0-3 .1-5.6.6-8.3z", "fg"]],
  politie: [["M12 2.5l7.5 2.8v6c0 4.8-3.2 8.9-7.5 10.5-4.3-1.6-7.5-5.7-7.5-10.5v-6z", "fg"],
            ["M12 6.5v11", "bgstroke"]],
  jandarmerie: [["M12 2.5l7.5 2.8v6c0 4.8-3.2 8.9-7.5 10.5-4.3-1.6-7.5-5.7-7.5-10.5v-6z", "fg"],
                ["M12 7.2l1.4 2.9 3.2.5-2.3 2.2.6 3.2L12 14.5 9.1 16l.6-3.2-2.3-2.2 3.2-.5z", "bg"]],
  frontiera: [["M6 3h2v18H6z", "fg"], ["M8.8 4h10.4l-2.4 4 2.4 4H8.8z", "fg"]],
  ambulanta: [["M9.8 3.5h4.4v6.3h6.3v4.4h-6.3v6.3H9.8v-6.3H3.5V9.8h6.3z", "fg"]],
  spital: [["M5.5 4h3.3v6.3h6.4V4h3.3v16h-3.3v-6.4H8.8V20H5.5z", "fg"]],
  medical: [["M10.3 5h3.4v5.3H19v3.4h-5.3V19h-3.4v-5.3H5v-3.4h5.3z", "fg"]],
  primarie: [["M12 2.8l9 4.7v1.8H3V7.5z", "fg"],
             ["M4.5 10.5h2.4v6.8H4.5zM9 10.5h2.4v6.8H9zm3.6 0H15v6.8h-2.4zm4.5 0h2.4v6.8h-2.4z", "fg"],
             ["M3 18.4h18V21H3z", "fg"]],
  scoala: [["M12 4L1.5 9 12 14l8.3-4V16H22V9z", "fg"],
           ["M5.5 12.6v3.6c0 1.8 2.9 3.3 6.5 3.3s6.5-1.5 6.5-3.3v-3.6L12 15.7z", "fg"]],
  gradinita: [["M3.5 12.5h7.5V20H3.5zm9.5 0h7.5V20H13zM8.3 4h7.5v7.5H8.3z", "fg"]],
  carburant: [["M4 3.5h10v17H4zM6 5.5v4.8h6V5.5z", "fg"],
              ["M15 7.5h1.8l3.2 3.2v8a2.4 2.4 0 0 1-4.8 0V14H14v-1.8h2.4a1 1 0 0 1 1 1v5.5a.7.7 0 0 0 1.4 0v-7.3L16.4 9.2H15z", "fg"]],
  baraj: [["M3 5h4.5l2 15H3z", "fg"],
          ["M11 9.5c1.5 0 1.5 1 3 1s1.5-1 3-1 1.5 1 3 1v2.2c-1.5 0-1.5-1-3-1s-1.5 1-3 1-1.5-1-3-1zm0 5c1.5 0 1.5 1 3 1s1.5-1 3-1 1.5 1 3 1v2.2c-1.5 0-1.5-1-3-1s-1.5 1-3 1-1.5-1-3-1z", "fg"]],
  hidrant: [["M9.2 3.5h5.6v2h1.2v2.2h-1.2v2.1h3.4v3.3h-3.4v6.4h1.4v2H7.8v-2h1.4v-6.4H5.8V9.8h3.4V7.7H8V5.5h1.2z", "fg"]],
  sursa_apa: [["M12 2.8c3.4 4.4 5.9 7.6 5.9 10.8a5.9 5.9 0 0 1-11.8 0c0-3.2 2.5-6.4 5.9-10.8z", "fg"]],
};
GLYPHS.hidrant_osm = GLYPHS.hidrant;

const PR = 2; // densitate (ecrane HiDPI)

function badge(color, glyph, { size = 26, shape = "circle", ring = "#ffffff" } = {}) {
  const px = size * PR;
  const c = document.createElement("canvas");
  c.width = c.height = px;
  const g = c.getContext("2d");
  g.scale(PR, PR);
  const r = size / 2;
  g.beginPath();
  if (shape === "circle") g.arc(r, r, r - 1.5, 0, Math.PI * 2);
  else g.roundRect(1.5, 1.5, size - 3, size - 3, 5);
  g.fillStyle = color;
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = ring;
  g.stroke();
  const inner = size * 0.62;
  g.save();
  g.translate(r - inner / 2, r - inner / 2);
  g.scale(inner / 24, inner / 24);
  for (const [d, fill] of glyph) {
    const p = new Path2D(d);
    if (fill === "bgstroke") {
      g.strokeStyle = color;
      g.lineWidth = 1.8;
      g.stroke(p);
    } else {
      g.fillStyle = fill === "fg" ? "#ffffff" : color;
      g.fill(p);
    }
  }
  g.restore();
  return { width: px, height: px, data: g.getImageData(0, 0, px, px).data };
}

function pin(color) {
  const w = 30, h = 40;
  const c = document.createElement("canvas");
  c.width = w * PR;
  c.height = h * PR;
  const g = c.getContext("2d");
  g.scale(PR, PR);
  g.beginPath();
  g.moveTo(15, 38);
  g.bezierCurveTo(10, 30, 3, 23, 3, 15);
  g.arc(15, 15, 12, Math.PI, 0);
  g.bezierCurveTo(27, 23, 20, 30, 15, 38);
  g.closePath();
  g.fillStyle = color;
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = "#fff";
  g.stroke();
  g.beginPath();
  g.arc(15, 15, 4.5, 0, Math.PI * 2);
  g.fillStyle = "#fff";
  g.fill();
  return { width: w * PR, height: h * PR, data: g.getImageData(0, 0, w * PR, h * PR).data };
}

function shield(bg, border) {
  const w = 32, h = 22;
  const c = document.createElement("canvas");
  c.width = w * PR;
  c.height = h * PR;
  const g = c.getContext("2d");
  g.scale(PR, PR);
  g.beginPath();
  g.roundRect(1, 1, w - 2, h - 2, 4);
  g.fillStyle = bg;
  g.fill();
  g.lineWidth = 1.5;
  g.strokeStyle = border;
  g.stroke();
  return {
    image: { width: w * PR, height: h * PR, data: g.getImageData(0, 0, w * PR, h * PR).data },
    options: { pixelRatio: PR, stretchX: [[10 * PR, 22 * PR]], stretchY: [[8 * PR, 14 * PR]], content: [5 * PR, 3 * PR, 27 * PR, 19 * PR] },
  };
}

export function buildIcons() {
  const icons = {};
  for (const [cat, def] of Object.entries(POI)) {
    icons["poi-" + cat] = { image: badge(def.color, GLYPHS[cat] || GLYPHS.medical), options: { pixelRatio: PR } };
  }
  icons["hydrant-isu"] = {
    image: badge("#c8102e", GLYPHS.hidrant, { size: 24, shape: "square" }), options: { pixelRatio: PR },
  };
  icons["hydrant-isu-off"] = {
    image: badge("#6b7079", GLYPHS.hidrant, { size: 24, shape: "square" }), options: { pixelRatio: PR },
  };
  icons["hydrant-isu-unk"] = {
    image: badge("#d08a16", GLYPHS.hidrant, { size: 24, shape: "square" }), options: { pixelRatio: PR },
  };
  icons["pin"] = { image: pin("#c8102e"), options: { pixelRatio: PR } };
  icons["shield-dn"] = shield("#c93a31", "#ffffff");
  icons["shield-dj"] = shield("#f0a23a", "#8a5410");
  icons["shield-dc"] = shield("#f7dc6f", "#8a7a1c");
  icons["shield-neutral"] = shield("#4b5563", "#ffffff"); // drumuri în prezentare, când există coduri
  return icons;
}

/** Imagine mică (data URL) pentru legenda din panou. */
const urlCache = new Map();
export function iconDataURL(cat, size = 20) {
  const ck = cat + "@" + size;
  if (urlCache.has(ck)) return urlCache.get(ck);
  const def = POI[cat];
  const img = cat === "hidranti" ? badge("#c8102e", GLYPHS.hidrant, { size, shape: "square" })
    : cat === "hidranti-off" ? badge("#6b7079", GLYPHS.hidrant, { size, shape: "square" })
    : badge(def.color, GLYPHS[cat] || GLYPHS.medical, { size });
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  c.getContext("2d").putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  const url = c.toDataURL();
  urlCache.set(ck, url);
  return url;
}
