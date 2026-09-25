/**
 * engine-ortho.js — Scene Engine de ortofoto georreferenciada (Leaflet).
 *
 * - Leaflet + BoundaryCanvas VENDORED (scripts clásicos → window.L), inyectados
 *   una sola vez con paths relativos a viewer/index.html.
 * - Basemap Esri World Imagery (contexto) + ortomosaico TMS recortado al
 *   polígono "bueno" (tiles.clip) vía L.TileLayer.boundaryCanvas, con fallback
 *   a L.tileLayer si el plugin o el fetch fallan.
 * - Capa predio con trazo animado (geo-core.animateDrawPath) y click → panel
 *   de info del chrome (ctx.emit('info', …)); curvas de nivel en toggle.
 * - Hotspots nav/info/link como L.divIcon reutilizando las clases .rc-hotspot.
 *
 * Contrato (tour-controller.js):
 *   create(ctx, container) -> { capabilities, show(sceneDef, savedView), hide(), getView() }
 */

import { animateDrawPath, safeColor } from '../geo-core.js';
import { safeLinkUrl } from '../manifest-loader.js';

/* Tile 1×1 transparente: huecos del borde del ortho sin ícono de imagen rota. */
const BLANK_TILE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const ESRI_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_ATTR = 'Esri · Maxar · Earthstar Geographics';

const LAYER_NAMES = { contours: 'Curvas de nivel', predio: 'Predio' };

const ICONS = {
  nav: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  info: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><circle cx="12" cy="8" r="0.5" fill="currentColor"/></svg>',
  link: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
};

// S2 (auditoría 2026-09-23): L.divIcon asigna este HTML con innerHTML, así que
// todo string del manifest se escapa ANTES de interpolarlo. Dos sinks, ambos de
// contexto HTML: la etiqueta es TEXTO dentro del <span> y el tipo va DENTRO del
// atributo class (comillas dobles); para los dos, el escape de entidades de
// & < > " ' es el correcto (aquí no hay contexto CSS ni URL). El tipo llega crudo
// desde el Studio, que monta este motor sin la poda de tipos de manifest-loader.
// El title del marker NO pasa por aquí: Leaflet lo asigna como propiedad DOM.
const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function markerHtml(kind, label) {
  return `<div class="rc-hotspot rc-hotspot--${esc(kind)}">${ICONS[kind] || ICONS.info}` +
         (label ? `<span class="rc-hotspot__label">${esc(label)}</span>` : '') + `</div>`;
}

/* ---------- carga única del vendor ----------
   Rutas resueltas desde import.meta.url (NO desde el documento) para que el
   motor funcione igual embebido en el viewer o en el Studio (builder). */
const VENDOR = new URL('../../vendor/', import.meta.url).href;
const OWN_CSS = new URL('../../css/engine-ortho.css', import.meta.url).href;

function loadCss(href) {
  return new Promise(resolve => {
    if (document.querySelector(`link[data-rc-ortho-css="${href}"]`)) return resolve();
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.dataset.rcOrthoCss = href;
    l.onload = () => resolve();
    l.onerror = () => { console.warn(`[ortho] CSS no cargó: ${href}`); resolve(); }; // theming: no bloquea
    document.head.appendChild(l);
  });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
    document.head.appendChild(s);
  });
}

let vendorReady = null;
function ensureLeaflet() {
  if (!vendorReady) {
    vendorReady = (async () => {
      const css = Promise.all([
        loadCss(VENDOR + 'leaflet/leaflet.css'),
        loadCss(OWN_CSS),
      ]);
      if (!window.L) await loadScript(VENDOR + 'leaflet/leaflet.js');
      if (!window.L?.TileLayer?.BoundaryCanvas) {
        try { await loadScript(VENDOR + 'leaflet/BoundaryCanvas.js'); }
        catch (e) { console.warn('[ortho] BoundaryCanvas no disponible — ortho sin recorte:', e); }
      }
      await css;
    })();
  }
  return vendorReady;
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} · ${url}`);
  return r.json();
}

/* ---------- engine ---------- */

export function create(ctx, container) {
  let map = null;
  let builtSceneId = null;
  let layersCtl = null;         // control de toggles propio de la escena (NO L.control.layers)
  let sceneLayers = [];         // capas a retirar al reconstruir (tiles, geojson, markers)
  let toggleLayers = [];        // overlays del control (pueden estar ON al salir)
  let homeBounds = null;        // encuadre default (predio > clip)
  let traceLayers = [];         // capas con trace — los <path> se recolectan al animar
  let traceRun = 0;             // token: invalida la limpieza de una animación superada
  let hsMarkers = new Map();    // id del hotspot → L.marker (Studio: highlight; SOLO lookup)
  let hsMarkerList = [];        // TODOS los markers agregados — id duplicado o ausente no debe dejar huérfanos
  let selId = null;             // hotspot resaltado (sobrevive a reconstrucciones)
  // Studio (editMode): show()/refresh() no se enciman — una reconstrucción a
  // medias de otra duplicaría capas. En el visor show() corre sin este candado.
  let busy = 0, idle = Promise.resolve();
  async function exclusive(fn) {
    while (busy) await idle;
    busy++;
    let done; idle = new Promise(r => { done = r; });
    try { return await fn(); } finally { busy--; done(); }
  }

  function createMap() {
    const L = window.L;
    container.innerHTML = ''; // limpia el placeholder del stub si lo hubo
    const el = document.createElement('div');
    el.className = 'rc-ortho-map';
    // Layout crítico INLINE (no en el CSS async): Leaflet congela 'position'
    // al crear el mapa — si el <link> aún no aplicó, fija position:relative
    // inline y el mapa queda con altura 0. isolation contiene los z-index
    // de los panes de Leaflet (400–1000) bajo el chrome del viewer (z 20+).
    el.style.cssText = 'position:absolute;inset:0;background:#1A1A1A;isolation:isolate;';
    container.appendChild(el);

    map = L.map(el, {
      zoomControl: false,
      attributionControl: false,
      zoomSnap: 0.25,
      maxBoundsViscosity: 0.35,
      worldCopyJump: false,
      // Embebido (iframe en Wix): la rueda es del scroll de la página host,
      // no del zoom del mapa — quedan los botones +/− y el pinch táctil.
      scrollWheelZoom: !ctx.embedded,
    });
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    // Attribution SIEMPRE visible (Esri lo exige) — bottomleft para no chocar
    // con el zoom; el margen extra lo da engine-ortho.css.
    L.control.attribution({ position: 'bottomleft', prefix: false }).addTo(map);
    // Studio: la vista del mapa como 'map-view' (no 'view': ese es el radar del
    // 360 en el chrome). moveend cubre también el zoom. El visor no lo escucha.
    if (ctx.editMode) map.on('moveend', () => ctx.emit('map-view', engine.getView()));
  }

  function clearScene() {
    if (!map) return;
    for (const l of sceneLayers) { try { map.removeLayer(l); } catch (_) {} }
    for (const l of toggleLayers) { try { map.removeLayer(l); } catch (_) {} }
    if (layersCtl) { try { map.removeControl(layersCtl); } catch (_) {} }
    for (const m of hsMarkerList) { try { map.removeLayer(m); } catch (_) {} }
    sceneLayers = []; toggleLayers = []; layersCtl = null; hsMarkers = new Map(); hsMarkerList = [];
    homeBounds = null; traceLayers = []; traceRun++;
  }

  async function buildScene(scene) {
    const L = window.L;
    const t = scene.tiles || {};
    map.setMinZoom(Math.max(3, (t.minZoom ?? 5) - 2));
    map.setMaxZoom(t.maxZoom ?? 19);

    /* (1) basemap satélite — contexto fuera del recorte del ortho */
    if (scene.basemap !== false) {
      const sat = L.tileLayer(ESRI_URL, {
        maxZoom: t.maxZoom ?? 23,
        maxNativeZoom: 17, // Esri no tiene imagery >z17 en zonas rurales → sobre-escala
        noWrap: true,
        attribution: ESRI_ATTR,
      }).addTo(map);
      sceneLayers.push(sat);
    }

    /* fetch en paralelo: clip del ortho + geojson de cada capa */
    const layerDefs = scene.layers || [];
    const [clipGeo, ...layerGeos] = await Promise.all([
      t.clip
        ? fetchJson(ctx.resolveAsset(t.clip)).catch(e => { console.warn('[ortho] clip no disponible:', e); return null; })
        : Promise.resolve(null),
      ...layerDefs.map(def =>
        fetchJson(ctx.resolveAsset(def.src)).catch(e => { console.warn(`[ortho] capa "${def.type}" no disponible:`, e); return null; })),
    ]);

    /* (2) ortomosaico TMS, recortado al polígono bueno si hay clip + plugin */
    if (t.url) {
      const url = ctx.resolveAsset(t.url);
      const opts = {
        tms: !!t.tms,
        minZoom: t.minZoom,
        maxNativeZoom: t.maxNativeZoom,
        maxZoom: t.maxZoom,
        noWrap: true,
        errorTileUrl: BLANK_TILE, // huecos del borde → transparente, sin spam visual
        attribution: 'Ortomosaico © Drone Mapping MX',
        // F2-L1: BoundaryCanvas dibuja los tiles en un <canvas>; con tiles
        // cross-origin (viewer en recorridos., tiles en presentacion.) el canvas
        // se TAINTEA y el recorte muere. crossOrigin + CORS * de Pages lo evita;
        // inofensivo en same-origin.
        crossOrigin: true,
      };
      if (clipGeo) {
        try { opts.bounds = L.geoJSON(clipGeo).getBounds().pad(0.05); } catch (_) {}
      }
      let ortho = null;
      if (clipGeo && L.TileLayer?.BoundaryCanvas) {
        try { ortho = L.TileLayer.boundaryCanvas(url, Object.assign({ boundary: clipGeo }, opts)); }
        catch (e) { console.warn('[ortho] boundaryCanvas falló — tiles sin recorte:', e); }
      }
      if (!ortho) ortho = L.tileLayer(url, opts);
      ortho.addTo(map);
      sceneLayers.push(ortho);
    }

    /* (3) capas vectoriales del manifest */
    const overlays = [];
    for (let i = 0; i < layerDefs.length; i++) {
      const def = layerDefs[i];
      const geo = layerGeos[i];
      if (!geo) continue;

      // el estilo del manifest llega a atributos SVG de Leaflet: colores por safeColor,
      // números finitos acotados; lo demás → default (fill inválido = sin relleno)
      const st = def.style && typeof def.style === 'object' ? def.style : {};
      const num = (v, lo, hi, dflt) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
      const fill = safeColor(st.fill, null);
      const layer = L.geoJSON(geo, {
        interactive: def.type === 'predio',
        style: {
          color: safeColor(st.stroke, '#7BC142'),
          weight: num(st.weight, 0, 20, 2),
          opacity: num(st.opacity, 0, 1, 1),
          fill: !!fill,
          fillColor: fill || undefined,
          fillOpacity: fill ? 1 : 0, // la opacidad ya viaja dentro del rgba() del manifest
        },
      });

      if (def.type === 'predio') {
        layer.addTo(map);
        sceneLayers.push(layer);
        const b = layer.getBounds();
        if (b.isValid()) homeBounds = b;
        if (def.popup) layer.on('click', () => ctx.emit('info', def.popup));
        // OJO: aquí el mapa aún NO tiene vista (fitBounds llega en show()) y
        // Leaflet difiere el onAdd real — l._path no existe todavía. Se guarda
        // la CAPA y runTrace() recolecta los <path> cuando ya están en el DOM.
        if (def.trace) traceLayers.push(layer);
      } else if (def.toggle) {
        // lista (no objeto): un label «__proto__» o numérico no pierde ni reordena capas;
        // el nombre solo llega al DOM por textContent (abajo)
        const name = typeof def.label === 'string' && def.label ? def.label : (LAYER_NAMES[def.type] || String(def.type));
        overlays.push([name, layer]); // OFF por default
        toggleLayers.push(layer);
      } else {
        layer.addTo(map);
        sceneLayers.push(layer);
      }
    }
    if (overlays.length) {
      // Toggles propios con label visible (el control genérico de Leaflet
      // escondía "Curvas de nivel" tras un icono anónimo — auditoría uxV#15).
      const Toggles = L.Control.extend({
        options: { position: 'topright' },
        onAdd() {
          const div = L.DomUtil.create('div', 'rc-ortho-toggles');
          for (const [name, layer] of overlays) {
            const btn = L.DomUtil.create('button', 'rc-ortho-toggle', div);
            btn.type = 'button';
            btn.textContent = name; // texto plano — sin innerHTML (XSS)
            btn.setAttribute('aria-pressed', 'false');
            L.DomEvent.on(btn, 'click', e => {
              L.DomEvent.stop(e);
              const on = !map.hasLayer(layer);
              if (on) layer.addTo(map); else map.removeLayer(layer);
              btn.classList.toggle('is-on', on);
              btn.setAttribute('aria-pressed', String(on));
            });
          }
          L.DomEvent.disableClickPropagation(div);
          return div;
        },
      });
      layersCtl = new Toggles().addTo(map);
    }

    /* (4) hotspots nav / info / link */
    buildHotspots(scene);

    /* encuadre default + límites de paneo */
    if (!homeBounds && clipGeo) {
      try { const b = L.geoJSON(clipGeo).getBounds(); if (b.isValid()) homeBounds = b; } catch (_) {}
    }
    if (homeBounds) map.setMaxBounds(homeBounds.pad(2.5));
  }

  function buildHotspots(scene) {
    const L = window.L;
    // Retirar TODO lo agregado en el build anterior, no solo lo que sobrevivió
    // en el Map: un id duplicado o ausente pisa la entrada del Map pero el
    // marker viejo sigue en el mapa — hsMarkerList es la lista completa.
    for (const m of hsMarkerList) { try { map.removeLayer(m); } catch (_) {} }
    hsMarkers = new Map();
    hsMarkerList = [];
    for (const h of scene.hotspots || []) {
      if (!h?.position) continue;
      const kind = h.type || 'info';
      const marker = L.marker(h.position, {
        icon: L.divIcon({
          className: 'rc-ortho-hotspot',
          html: markerHtml(kind, h.label),
          iconSize: [44, 44],
          iconAnchor: [22, 22],
        }),
        keyboard: true,
        title: h.label || '',
      }).addTo(map);
      marker.on('click', () => {
        // Studio: el clic selecciona (como en engine-pano360), no ejecuta
        if (ctx.editMode) { ctx.emit('hotspot-select', h.id); return; }
        if (kind === 'nav' && h.target) ctx.goTo(h.target);
        else if (kind === 'info') ctx.emit('info', h.content);
        else if (kind === 'link') {
          // Task 8a: solo http(s)/mailto/tel — el Studio monta este motor sin manifest-loader
          const u = safeLinkUrl(h.url ?? h.href);
          if (u) window.open(u, '_blank', 'noopener');
        }
      });
      hsMarkers.set(h.id, marker);
      hsMarkerList.push(marker);
    }
    if (selId) markSelected(selId);
  }

  function markSelected(id) {
    for (const [hid, m] of hsMarkers) m.getElement()?.querySelector('.rc-hotspot')?.classList.toggle('is-selected', hid === id);
  }

  function runTrace() {
    if (!traceLayers.length || ctx.reducedMotion) return;
    // Recolectar AHORA: tras fitBounds/setView los paths ya viven en el DOM.
    // Se corre en CADA show() — la revisita (keep-alive) re-anima el trazo.
    const paths = [];
    for (const layer of traceLayers) layer.eachLayer(l => { if (l._path) paths.push(l._path); });
    if (!paths.length) return;
    const run = ++traceRun;
    const DUR = 1600;
    for (const p of paths) animateDrawPath(p, DUR);
    // Leaflet redibuja el atributo d del path al hacer zoom: limpiar el dash al
    // terminar para que el trazo no aparezca "punteado" tras re-proyecciones.
    // El token invalida esta limpieza si otra animación la superó (goTo force).
    setTimeout(() => {
      if (run !== traceRun) return;
      paths.forEach(p => {
        p.style.transition = 'none';
        p.style.strokeDasharray = '';
        p.style.strokeDashoffset = '';
      });
    }, DUR + 200);
  }

  async function showNow(scene, savedView) {
    await ensureLeaflet();
    if (!map) createMap();
    if (builtSceneId !== scene.id) {
      clearScene();
      await buildScene(scene);
      builtSceneId = scene.id;
    }
    // el contenedor pudo estar display:none al crearse el mapa
    map.invalidateSize();

    if (savedView?.center) {
      map.setView(savedView.center, savedView.zoom ?? map.getZoom(), { animate: false });
    } else if (homeBounds) {
      map.fitBounds(homeBounds, { padding: [56, 56], animate: false });
    } else {
      map.setView([0, 0], 3, { animate: false }); // sin datos: no dejar el mapa sin vista
    }
    runTrace();
    if (ctx.debug) console.debug('[ortho] show', scene.id, savedView || '(fit predio)');
  }

  const engine = {
    capabilities: { radar: false, gyro: false, autopilot: false },

    // Visor: igual que siempre. Studio (editMode): serializado con refresh().
    show(scene, savedView) {
      return ctx.editMode ? exclusive(() => showNow(scene, savedView)) : showNow(scene, savedView);
    },

    hide() { /* el controller oculta el contenedor; el mapa persiste (keep-alive) */ },

    // El contenedor cambió de tamaño sin resize de la ventana (Studio: panel
    // de problemas, columnas) — Leaflet solo escucha window.resize.
    resize() { map?.invalidateSize(); },

    getView() {
      if (!map) return null;
      const c = map.getCenter();
      return { center: [+c.lat.toFixed(7), +c.lng.toFixed(7)], zoom: map.getZoom() };
    },

    /* ---- Studio N+ (lote 06). Aditivo: el visor no llama nada de esto. ---- */

    // Sin `force` y misma escena: solo rehace los botones (como el refresh del
    // 360). Con `force` (o escena distinta): reconstruye TODAS las capas sin la
    // caché de builtSceneId — p. ej. tras editar tiles.url — y, si es la misma
    // escena, conserva el encuadre que tenía el usuario.
    refresh(scene, { force = false } = {}) {
      if (!map || !scene) return Promise.resolve();
      return exclusive(async () => {
        if (!map) return;
        const same = builtSceneId === scene.id;
        if (same && !force) { buildHotspots(scene); return; }
        const c = map.getCenter(), z = map.getZoom();
        clearScene();
        builtSceneId = null;
        await buildScene(scene);
        builtSceneId = scene.id;
        map.invalidateSize();
        if (same) map.setView(c, z, { animate: false });
        else if (homeBounds) map.fitBounds(homeBounds, { padding: [56, 56], animate: false });
      });
    },

    highlight(hotspotId) { selId = hotspotId || null; markSelected(selId); },

    // Centro actual del mapa → [lat, lng] (sin redondear, a diferencia de getView).
    getCenter() {
      if (!map) return null;
      const c = map.getCenter();
      return [c.lat, c.lng];
    },

    // Encuadre «a lo ancho» (SPEC §6.8): el predio cubre todo el contenedor.
    fitWide() {
      if (!map || !homeBounds) return;
      map.setView(homeBounds.getCenter(), map.getBoundsZoom(homeBounds, true), { animate: false });
    },

    // Escena construida y sin show()/refresh() en vuelo.
    isReady() { return !!map && !!builtSceneId && !busy; },

    // Punto de pantalla (clientX/Y) → [lat, lng] | null (cargando o fuera).
    pointToPosition(clientX, clientY) {
      if (!this.isReady()) return null;
      const r = container.getBoundingClientRect();
      const x = clientX - r.left, y = clientY - r.top;
      if (!(x >= 0 && y >= 0 && x <= r.width && y <= r.height)) return null;
      const ll = map.containerPointToLatLng([x, y]);
      return Number.isFinite(ll?.lat) && Number.isFinite(ll?.lng) ? [ll.lat, ll.lng] : null;
    },

    // Inversa: [lat, lng] → { x, y, visible } en px del contenedor. Entrada
    // inválida o no finita → visible:false con coordenadas finitas (nunca NaN).
    project(pos) {
      const off = { x: -1e5, y: -1e5, visible: false };
      if (!map || !pos) return off;
      let p;
      try { p = map.latLngToContainerPoint(pos); } catch (_) { return off; }
      if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) return off;
      const sz = map.getSize();
      return { x: p.x, y: p.y, visible: p.x >= 0 && p.x <= sz.x && p.y >= 0 && p.y <= sz.y };
    },

    destroy() {
      clearScene();
      if (map) { try { map.remove(); } catch (_) {} map = null; }
      builtSceneId = null;
      container.innerHTML = '';
    },
  };

  /* referencias de solo-lectura para debug/QA (no forman parte del contrato) */
  Object.defineProperty(engine, '_map', { get: () => map });
  Object.defineProperty(engine, '_layersCtl', { get: () => layersCtl });
  // QA: bounds del predio que calcula buildScene → [[sur, oeste], [norte, este]]
  Object.defineProperty(engine, '_homeBoundsForQA', {
    value: () => homeBounds ? [[homeBounds.getSouth(), homeBounds.getWest()], [homeBounds.getNorth(), homeBounds.getEast()]] : null,
  });

  return engine;
}
