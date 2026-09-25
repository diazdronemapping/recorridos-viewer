/**
 * site-config.js — única fuente de verdad del host de assets pesados (F2-L1).
 *
 * El viewer puede correr en 4 contextos y las nubes Potree (12 GB) + ortho
 * tiles viven SIEMPRE en presentacion.dronemapping.mx (junto a su service
 * worker de chunks, que debe ser same-origin con octree.bin):
 *
 *   1. recorridos.dronemapping.mx (deploy nuevo)  → cross-origin a presentacion
 *   2. presentacion…/recorridos-viewer/ (ventana pre-DNS) → same-origin,
 *      pero potree-scene.html no existe en ese path → usar /recorridos/
 *   3. presentacion…/recorridos/ (deploy viejo, transición) → same-origin, relativo
 *   4. localhost:8178 (dev + preview del Studio; el repo fuente tiene
 *      assets/_potree/ en la raíz)               → same-origin, relativo
 *
 * QA desde cualquier contexto: ?cloudhost=https://presentacion.dronemapping.mx
 * CORS verificado 2026-07-12: GitHub Pages sirve Access-Control-Allow-Origin:*.
 */

export const CLOUD_HOST_PROD = 'https://presentacion.dronemapping.mx';

/** R2-01 (review Ola 2): ?cloudhost= es un override de QA, no una puerta a
 *  cualquier host. Solo vale un ORIGEN (sin ruta, query ni fragmento) que sea
 *  el propio sitio o el host de nubes de producción; lo demás se ignora.
 *  Devuelve el origen normalizado o null. Espejo en splat-scene.html. */
export function allowedCloudHost(raw) {
  if (typeof raw !== 'string' || !/^https?:\/\//i.test(raw) || /[\s\\]/.test(raw)) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) return null;
  return (u.origin === location.origin || u.origin === CLOUD_HOST_PROD) ? u.origin : null;
}

/** R2-01: ?manifest= (preview del Studio y catálogo local) solo carga un
 *  manifest del MISMO origen — ruta relativa o raíz-absoluta, o el blob: que
 *  genera el propio sitio. Un manifest ajeno pondría contenido de un tercero
 *  bajo el dominio y el chrome del sitio (y en localhost, junto al API del
 *  Studio). Devuelve la URL absoluta o null. */
export function resolveManifestParam(raw) {
  if (typeof raw !== 'string' || !raw || /[\u0000- \\]/.test(raw)) return null;
  let u;
  try { u = new URL(raw, location.href); } catch { return null; }
  if (u.protocol === 'blob:') return u.origin === location.origin ? u.href : null;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.origin === location.origin ? u.href : null;
}

export const CLOUD_HOST = (() => {
  try {
    const qp = new URLSearchParams(location.search).get('cloudhost');
    if (qp) {
      const ok = allowedCloudHost(qp);
      if (ok) return ok;
      console.warn('[recorridos] ?cloudhost= ignorado: solo se acepta este sitio o ' + CLOUD_HOST_PROD);
    }
    return location.hostname === 'recorridos.dronemapping.mx' ? CLOUD_HOST_PROD : '';
  } catch { return ''; }
})();

/** Rutas raíz-absolutas de assets compartidos (/assets/_potree/, /assets/_splat/)
 *  → absolutas al host de nubes cuando el viewer corre en otro origen.
 *  Todo lo demás (bundle del tour, blob:, http…) pasa intacto. */
export function toCloudUrl(p) {
  return (CLOUD_HOST && typeof p === 'string' && p.startsWith('/assets/'))
    ? CLOUD_HOST + p : p;
}

/** URL del host del iframe de nube. El ?cloud= viaja raíz-absoluto intacto:
 *  potree-scene.html lo valida contra su whitelist y lo resuelve en SU origen. */
export const POTREE_SCENE_URL = (() => {
  if (CLOUD_HOST) return CLOUD_HOST + '/recorridos/potree-scene.html';
  try {
    // Ventana pre-DNS: el viewer se sirve bajo /recorridos-viewer/ (project
    // site sin dominio) donde NO hay potree-scene.html — el de producción
    // same-origin sí existe en /recorridos/.
    if (location.pathname.startsWith('/recorridos-viewer/')) {
      return '/recorridos/potree-scene.html';
    }
  } catch { /* entornos sin location (tests) */ }
  // Deploy viejo y dev local: potree-scene.html es hermano de viewer/.
  return new URL('../../potree-scene.html', import.meta.url).href;
})();

/** URL del iframe gemelo splat (F1.5-L7). A diferencia de potree-scene (que
 *  vive en presentacion junto a las nubes), splat-scene.html se despliega EN
 *  este repo → siempre hermano de viewer/, same-origin en los 4 contextos.
 *  Los .sog compartidos de /assets/_splat/clouds/ sí cruzan a presentacion —
 *  eso lo resuelve la propia página con su CLOUD_HOST (fetch CORS *). */
export const SPLAT_SCENE_URL = new URL('../../splat-scene.html', import.meta.url).href;
