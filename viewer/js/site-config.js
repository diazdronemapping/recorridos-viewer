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

const CLOUD_HOST_PROD = 'https://presentacion.dronemapping.mx';

export const CLOUD_HOST = (() => {
  try {
    const qp = new URLSearchParams(location.search).get('cloudhost');
    if (qp) return qp.replace(/\/+$/, '');
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
