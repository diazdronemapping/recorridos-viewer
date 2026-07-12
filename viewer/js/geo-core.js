/**
 * geo-core.js — funciones puras de geometría geográfica.
 * Extraídas de artefactos_html/vault-visual/_shared/vault-zonemap.js (v3.10+)
 * para reuso en Recorridos. Coordenadas [lat, lon] en grados WGS84.
 */

export function haversineKm(a, b) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toR, dLon = (b[1] - a[1]) * toR;
  const la1 = a[0] * toR, la2 = b[0] * toR;
  const h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Arco Bézier cuadrático entre dos puntos [lat,lon] (curva rutas ilustrativas). */
export function bezierArc(a, b, bend) {
  const lat1 = a[0], lon1 = a[1], lat2 = b[0], lon2 = b[1];
  const mx = (lat1 + lat2) / 2, my = (lon1 + lon2) / 2;
  const dx = lat2 - lat1, dy = lon2 - lon1;
  const off = (bend == null ? 0.16 : bend);
  const cx = mx - dy * off, cy = my + dx * off;
  const pts = [], N = 30;
  for (let i = 0; i <= N; i++) {
    const t = i / N, u = 1 - t;
    pts.push([u * u * lat1 + 2 * u * t * cx + t * t * lat2,
              u * u * lon1 + 2 * u * t * cy + t * t * lon2]);
  }
  return pts;
}

/**
 * Anima el trazo de un <path> SVG con el patrón stroke-dashoffset
 * (el mismo mecanismo del "dibujo del deslinde" del vault-zonemap).
 * Acepta el elemento path directamente (Leaflet lo expone en layer._path).
 */
export function animateDrawPath(path, durMs = 600) {
  try {
    if (!path) return;
    const len = path.getTotalLength();
    const s = (durMs / 1000).toFixed(2);
    path.style.transition = 'none';
    path.style.strokeDasharray = len;
    path.style.strokeDashoffset = len;
    path.getBoundingClientRect(); // reflow
    path.style.transition = 'stroke-dashoffset ' + s + 's cubic-bezier(.4,0,.2,1)';
    path.style.strokeDashoffset = '0';
  } catch (_) { /* decorativo — nunca debe romper la escena */ }
}

/**
 * Punto a la fracción f (0..1) de la longitud acumulada de una polilínea [[lat,lon],...].
 * Plano local (lon escalado por cos(lat)) para velocidad ~uniforme — motor de
 * "la cámara sigue el trazo".
 */
export function pointAtFraction(geom, f) {
  if (!geom || geom.length < 2) return geom && geom[0];
  const lat0 = geom[0][0], kx = Math.cos(lat0 * Math.PI / 180);
  const segs = []; let total = 0;
  for (let i = 0; i < geom.length - 1; i++) {
    const ax = geom[i][1] * kx, ay = geom[i][0], bx = geom[i + 1][1] * kx, by = geom[i + 1][0];
    const d = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
    segs.push(d); total += d;
  }
  if (total === 0) return geom[0];
  const target = Math.max(0, Math.min(1, f)) * total; let acc = 0;
  for (let j = 0; j < segs.length; j++) {
    if (acc + segs[j] >= target) {
      const t = segs[j] === 0 ? 0 : (target - acc) / segs[j];
      return [geom[j][0] + t * (geom[j + 1][0] - geom[j][0]), geom[j][1] + t * (geom[j + 1][1] - geom[j][1])];
    }
    acc += segs[j];
  }
  return geom[geom.length - 1];
}

/* ---- Subdivisión ilustrativa en n partes de área ~igual (v2 · escenas ortho) ---- */
function _planArea(P) { let a = 0; for (let i = 0, n = P.length; i < n; i++) { const j = (i + 1) % n; a += P[i][0] * P[j][1] - P[j][0] * P[i][1]; } return a / 2; }
function _clipHalf(P, ax, ay, t) {
  const out = [], n = P.length;
  for (let i = 0; i < n; i++) {
    const A = P[i], B = P[(i + 1) % n];
    const da = A[0] * ax + A[1] * ay - t, db = B[0] * ax + B[1] * ay - t;
    if (da <= 0) out.push(A);
    if ((da < 0) !== (db < 0)) { const s = da / (da - db); out.push([A[0] + s * (B[0] - A[0]), A[1] + s * (B[1] - A[1])]); }
  }
  return out;
}
function _crossSeg(P, ax, ay, t) {
  const pts = [], n = P.length;
  for (let i = 0; i < n; i++) {
    const A = P[i], B = P[(i + 1) % n];
    const da = A[0] * ax + A[1] * ay - t, db = B[0] * ax + B[1] * ay - t;
    if ((da < 0) !== (db < 0)) { const s = da / (da - db); pts.push([A[0] + s * (B[0] - A[0]), A[1] + s * (B[1] - A[1])]); }
  }
  return (pts.length >= 2) ? [pts[0], pts[1]] : null;
}

/** Corta un polígono [[lat,lon],...] en n partes de área ~igual. Devuelve los (n-1) segmentos divisorios. */
export function subdivide(coords, n) {
  if (!coords || coords.length < 3 || n < 2) return [];
  const lat0 = coords[0][0], kx = Math.cos(lat0 * Math.PI / 180);
  const P = coords.map(c => [c[1] * kx, c[0]]);
  let bi = 0, bj = 1, bd = -1;
  for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) { const dx = P[j][0] - P[i][0], dy = P[j][1] - P[i][1], d = dx * dx + dy * dy; if (d > bd) { bd = d; bi = i; bj = j; } }
  const vx = P[bj][0] - P[bi][0], vy = P[bj][1] - P[bi][1], vl = Math.sqrt(vx * vx + vy * vy) || 1, ax = vx / vl, ay = vy / vl;
  const ts = P.map(p => p[0] * ax + p[1] * ay);
  const tmin = Math.min.apply(null, ts), tmax = Math.max.apply(null, ts);
  const total = Math.abs(_planArea(P)), cuts = [];
  for (let k = 1; k < n; k++) {
    const target = total * k / n; let lo = tmin, hi = tmax, tc = (lo + hi) / 2;
    for (let it = 0; it < 30; it++) { tc = (lo + hi) / 2; const a = Math.abs(_planArea(_clipHalf(P, ax, ay, tc))); if (a < target) lo = tc; else hi = tc; }
    const seg = _crossSeg(P, ax, ay, tc);
    if (seg) cuts.push([[seg[0][1], seg[0][0] / kx], [seg[1][1], seg[1][0] / kx]]);
  }
  return cuts;
}

/* ---- Utilidades de ángulos (manifest en GRADOS ↔ PSV en radianes) ---- */
export const degToRad = d => d * Math.PI / 180;
export const radToDeg = r => r * 180 / Math.PI;
/** Normaliza grados a (-180, 180]. */
export function normDeg(d) {
  let x = ((d % 360) + 360) % 360;
  return x > 180 ? x - 360 : x;
}
