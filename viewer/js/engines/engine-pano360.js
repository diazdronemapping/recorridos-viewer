/**
 * engine-pano360.js — Scene Engine de panoramas 360 equirectangulares.
 * Photo Sphere Viewer v5 + Markers/Autorotate/Gyroscope.
 * UNA instancia de Viewer reutilizada entre panos (setPanorama).
 * La navegación entre escenas es del TourController (no VirtualTourPlugin:
 * su modelo de nodos pelea con escenas heterogéneas Potree/ortho).
 */

import { Viewer } from '@photo-sphere-viewer/core';
import { MarkersPlugin } from '@photo-sphere-viewer/markers-plugin';
import { AutorotatePlugin } from '@photo-sphere-viewer/autorotate-plugin';
import { GyroscopePlugin } from '@photo-sphere-viewer/gyroscope-plugin';
import { LinearMipmapLinearFilter } from 'three';
import { degToRad, radToDeg, safeColor } from '../geo-core.js';
import { iconSvg, iconClass } from '../hotspot-icons.js';
import { safeLinkUrl } from '../manifest-loader.js';

const MIN_FOV = 35, MAX_FOV = 100;

// R1 (lote 14 N+, como Panoraven): 90° vertical con tope de 130° horizontal,
// recalculado en cada resize. initialView.fov solo manda con fovOverride:true (H9).
const hFovToVFov = (h, aspect) => radToDeg(2 * Math.atan(Math.tan(degToRad(h) / 2) / aspect));
export function defaultVFov(W, H) {
  const a = W / H;
  return a > 0 && Number.isFinite(a) ? Math.min(90, hFovToVFov(130, a)) : 90;
}

// roll (lote 14 N+, H3): enderezar el horizonte de la foto. Solo número finito,
// acotado a ±10° (un manifest editado a mano con 45 no voltea la esfera).
function rollCorrection(deg) {
  const d = Number.isFinite(deg) ? Math.min(10, Math.max(-10, deg)) : 0;
  return { pan: 0, tilt: 0, roll: degToRad(d) };
}

// panorama parcial: solo los 6 numéricos de recorte llegan a PSV (el manifest
// no se pasa crudo a la librería)
const PANODATA_KEYS = ['fullWidth', 'fullHeight', 'croppedWidth', 'croppedHeight', 'croppedX', 'croppedY'];
function sanitizePanoData(pd) {
  if (!pd || typeof pd !== 'object') return undefined;
  const out = {};
  for (const k of PANODATA_KEYS) if (Number.isFinite(pd[k])) out[k] = pd[k];
  return Object.keys(out).length ? out : undefined;
}

// Los labels vienen de contenido autorado en el Studio — SIEMPRE escapados
// antes de inyectarse en el HTML del marker (XSS/layout roto).
const escHtml = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Estilo por botón (lote 14 N+, índice H1). Del manifest solo pasan valores de
// una lista cerrada: tamaño s/m/l, color #rgb/#rrggbb y giro numérico (solo nav).
// Todo lo demás se ignora — nada del manifest se interpola crudo en class/style.
const HS_SIZES = { s: 36, m: 44, l: 54 };
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
function hotspotDeco(h) {
  const st = h.style && typeof h.style === 'object' ? h.style : {};
  const size = Object.hasOwn(HS_SIZES, st.size) ? st.size : null;
  const vars = [];
  if (typeof st.color === 'string' && HEX_COLOR.test(st.color)) vars.push(`--rc-hs-glass: ${st.color}`);
  if (h.type === 'nav' && Number.isFinite(h.rotation)) {
    const r = Math.round(((h.rotation % 360) + 360) % 360 * 100) / 100;   // normalizado a [0,360)
    vars.push(`--rc-rot: ${r % 360}deg`);
  }
  return { cls: size ? ` rc-hotspot--${size}` : '', style: vars.join('; '), px: HS_SIZES[size] || 44 };
}

function markerHtml(kind, label, iconId, deco = { cls: '', style: '' }) {
  // role/tabindex: los hotspots son operables por teclado (Tab + Enter/Espacio,
  // WCAG 2.1.1). PSV re-crea el DOM en cada setMarkers — los atributos viven
  // en el html (sobreviven) y el keydown va por DELEGACIÓN en el contenedor.
  // iconId jamás se interpola crudo: iconSvg/iconClass son lookups de la lib.
  const aria = label ? ` aria-label="${escHtml(label)}"` : '';
  // kind (el `type` del hotspot) entra a una CLASE solo si es un token simple:
  // manifest-loader.js y el _normalize del Studio ya podan los tipos
  // desconocidos — esto es la defensa en profundidad del sink (Task 7).
  const kindClass = /^[a-z0-9-]+$/i.test(String(kind)) ? kind : 'otro';
  const style = deco.style ? ` style="${escHtml(deco.style)}"` : '';
  return `<div class="rc-hotspot rc-hotspot--${kindClass}${iconClass(iconId)}${deco.cls}"${style} role="button" tabindex="0"${aria}>` +
         iconSvg(iconId, kind) +
         (label ? `<span class="rc-hotspot__label">${escHtml(label)}</span>` : '') + `</div>`;
}

export function create(ctx, container) {
  let viewer = null, markers = null, autorotate = null, gyro = null;
  let currentFov = 70;
  // R1: FOV de la regla para el tamaño actual (null = la escena usa fovOverride
  // o aún no hay escena); en un resize el FOV se escala por regla nueva/ruleFov
  // → sin zoom del visitante queda la regla, con zoom se conserva relativo.
  let ruleFov = null;
  // FOV que el visitante "quiere" sin acotar: si el resize lo recorta a los límites,
  // el siguiente resize parte de aquí (ida y vuelta sin deriva). null = usar currentFov.
  let wantFov = null;
  let gyroOn = false;
  let lastViewEmit = 0;
  // límites de zoom ACTIVOS (scene.fovLimits, P3) — el mapeo fov↔zoom de PSV
  // depende de ellos, por eso viven como estado y no como constantes
  let minFov = MIN_FOV, maxFov = MAX_FOV;
  const fovToZoom = fov => Math.round((maxFov - fov) / (maxFov - minFov) * 100);
  const clampFov = f => Math.min(maxFov, Math.max(minFov, f ?? 70));

  function applyFovLimits(scene) {
    const fl = scene.fovLimits;
    const ok = fl && Number.isFinite(fl.min) && Number.isFinite(fl.max) &&
               fl.min >= 20 && fl.max <= 120 && fl.min < fl.max;
    if (fl && !ok) console.warn(`[recorridos] fovLimits inválidos en "${scene.id}" — se usan ${MIN_FOV}–${MAX_FOV}`);
    minFov = ok ? fl.min : MIN_FOV;
    maxFov = ok ? fl.max : MAX_FOV;
  }

  // R1 en un cambio de tamaño: el FOV se escala por regla nueva/ruleFov (ambas acotadas
  // a los límites de la escena → en reposo la razón es 1). Durante el intro no se toca
  // (dueño de la cámara): se re-aplica al terminar, y también al mostrar cada escena.
  function applyRule(w, h) {
    if (!viewer || ruleFov === null || introTarget || !(w > 0 && h > 0)) return;
    const r = clampFov(defaultVFov(w, h));
    if (Math.abs(r - ruleFov) < 0.01) return;
    // mismo nivel de zoom de PSV (entero) ⇒ el visitante no tocó el zoom desde el último resize
    const base = wantFov !== null && fovToZoom(clampFov(wantFov)) === fovToZoom(currentFov) ? wantFov : currentFov;
    const want = base * r / ruleFov;
    const next = clampFov(want);
    ruleFov = r;
    viewer.zoom(fovToZoom(next));
    currentFov = next;
    wantFov = want;
  }

  function markerDef(h) {
    if (h.type === 'polygon') {
      return {
        id: h.id,
        polygon: h.positions.map(p => [degToRad(p.yaw), degToRad(p.pitch)]),
        svgStyle: {
          // atributos SVG: solo colores de safeColor (sin url()/comillas), si no → default
          fill: safeColor(h.style?.fill, 'rgba(123,193,66,0.16)'),
          stroke: safeColor(h.style?.stroke, 'var(--rc-accent)'),
          'stroke-width': '2.5px',
        },
        data: { kind: 'info', content: h.content },
      };
    }
    const deco = hotspotDeco(h);
    return {
      id: h.id,
      position: { yaw: degToRad(h.position.yaw), pitch: degToRad(h.position.pitch) },
      html: markerHtml(h.type, h.label || (h.type === 'info' ? h.content?.title : null), h.icon, deco),
      size: { width: deco.px, height: deco.px },
      anchor: 'center center',
      data: { kind: h.type, target: h.target, url: h.url, content: h.content,
              src: h.src, filename: h.filename },
    };
  }

  function buildMarkers(scene) {
    const defs = (scene.hotspots || []).map(markerDef);
    // nadir con logo (parche de marca "pegado" al piso del pano)
    const nadir = ctx.manifest.branding?.nadirLogo;
    if (nadir) {
      defs.push({
        id: '__nadir',
        imageLayer: ctx.resolveAsset(nadir),
        // parche plano en el piso: 4 esquinas alrededor del polo (pitch -72°)
        position: [
          { yaw: degToRad(-45), pitch: degToRad(-72) },
          { yaw: degToRad(45), pitch: degToRad(-72) },
          { yaw: degToRad(135), pitch: degToRad(-72) },
          { yaw: degToRad(-135), pitch: degToRad(-72) },
        ],
        data: { kind: 'nadir' },
      });
    }
    return defs;
  }

  // Acción de un hotspot — compartida por click (select-marker) y teclado.
  // En editMode selecciona en el inspector; en viewer ejecuta.
  function activateMarker(marker) {
    if (ctx.editMode) {
      if (!marker.id.startsWith('__')) ctx.emit('hotspot-select', marker.id);
      return;
    }
    const d = marker.data || {};
    if (d.kind === 'nav' && d.target) ctx.goTo(d.target);
    else if (d.kind === 'info' && d.content) ctx.emit('info', d.content);
    else if (d.kind === 'link') {
      // Task 8a: solo http(s)/mailto/tel — el Studio monta este motor sin manifest-loader
      const u = safeLinkUrl(d.url);
      if (u) window.open(u, '_blank', 'noopener');
    }
    else if (d.kind === 'download' && d.src) {
      // descarga directa: mismo origen en el sitio publicado / object URL en el
      // Studio y el preview — en ambos casos el atributo download sí aplica
      const a = document.createElement('a');
      a.href = ctx.resolveAsset(d.src);
      a.download = d.filename || '';
      document.body.appendChild(a); a.click(); a.remove();
    }
  }

  function createViewer(scene, view) {
    viewer = new Viewer({
      container,
      panorama: ctx.resolveAsset(scene.src),
      panoData: sanitizePanoData(scene.panoData),
      sphereCorrection: rollCorrection(scene.roll),
      navbar: false,
      // 'always' escucha en window (flechas/± /PageUp/Dn) — en el Studio va
      // apagado: secuestraría los inputs del inspector (review adversarial R1)
      keyboard: ctx.editMode ? false : 'always',
      defaultYaw: degToRad(view.yaw ?? 0),
      defaultPitch: degToRad(view.pitch ?? 0),
      minFov,
      maxFov,
      defaultZoomLvl: fovToZoom(clampFov(view.fov)),
      // sensación de cámara (manifest.motion) — clamps defensivos
      moveSpeed: Math.min(3, Math.max(0.2, Number(ctx.manifest.motion?.moveSpeed) || 1)),
      moveInertia: ctx.manifest.motion?.inertia !== false,
      // Embebido (iframe en Wix): la rueda es del scroll del host — zoom solo
      // con Ctrl+rueda (PSV muestra su aviso solo, string en lang.ctrlZoom)
      mousewheelCtrlKey: !!ctx.embedded,
      lang: { ctrlZoom: 'Usa Ctrl + rueda para acercar' },
      loadingTxt: 'Cargando panorama…',
      touchmoveTwoFingers: false,
      plugins: [
        [MarkersPlugin, {}],
        [AutorotatePlugin, {
          // editMode: autostartDelay null → initialStart=false; con delay
          // seteado el pano rotaba solo tras 12s AUN con autostartOnIdle:false
          // (bug latente del Studio, review adversarial R5)
          autostartDelay: ctx.editMode ? null : (ctx.manifest.idle?.autorotateAfter ?? 12) * 1000,
          autostartOnIdle: !ctx.editMode, // en el Studio no rota solo (estorba al editar)
          autorotateSpeed: `${ctx.manifest.idle?.rpm ?? 0.4}rpm`,
        }],
        [GyroscopePlugin, { touchmove: true }],
      ],
    });
    markers = viewer.getPlugin(MarkersPlugin);
    autorotate = viewer.getPlugin(AutorotatePlugin);
    gyro = viewer.getPlugin(GyroscopePlugin);
    if (ctx.debug) { window.__psv = viewer; window.__psvMarkers = markers; }
    currentFov = view.fov ?? 70;

    markers.addEventListener('select-marker', ({ marker }) => activateMarker(marker));

    // R2 (lote 14 N+): mipmaps + anisotropía en cada textura nueva (PSV crea la
    // suya sin mipmaps, core.module.js createTexture) → menos moiré al alejar.
    // Respaldo móvil (R-2): táctil con textura máx. <16K → sin mipmaps (8K RGBA
    // con mipmaps ≈ 180 MB de VRAM; riesgo de «WebGL context lost»).
    viewer.addEventListener('panorama-loaded', ({ data }) => {
      const tex = data?.texture, caps = viewer?.renderer?.renderer?.capabilities;
      if (!tex?.isTexture || !caps || tex.generateMipmaps) return;
      if (matchMedia('(pointer: coarse)').matches && caps.maxTextureSize < 16384) return;
      tex.generateMipmaps = true;
      tex.minFilter = LinearMipmapLinearFilter;
      tex.anisotropy = caps.getMaxAnisotropy();
      tex.needsUpdate = true;
    });

    // Teclado en hotspots por DELEGACIÓN (el DOM de markers se re-crea en cada
    // setMarkers/refresh — un listener por elemento moriría). Un click sintético
    // NO dispara select-marker (es pipeline de raycast), por eso se comparte
    // activateMarker. stopPropagation: que Espacio no llegue al keyboard global
    // de PSV en window (toggle de autorotate) — doble acción.
    container.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const hs = e.target?.closest?.('.rc-hotspot');
      if (!hs) return;
      const mEl = e.target.closest('.psv-marker');
      const marker = Object.values(markers?.markers || {})
        .find(m => (m.domElement || m.element) === mEl);
      if (!marker) return;
      e.preventDefault();
      e.stopPropagation();
      activateMarker(marker);
    }, true);

    // keyboard 'always' escucha en window sin filtrar target: si el foco está
    // en un campo de formulario, el pano NO debe moverse ni robar las teclas
    // (el core aborta el manejo si el KeypressEvent llega prevented).
    viewer.addEventListener('key-press', e => {
      const a = document.activeElement;
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' ||
                a.tagName === 'SELECT' || a.isContentEditable)) {
        e.preventDefault();
      }
    });

    viewer.addEventListener('position-updated', ({ position }) => {
      const now = performance.now();
      if (now - lastViewEmit < 80) return; // throttle del radar/HUD
      lastViewEmit = now;
      ctx.emit('view', {
        yawDeg: radToDeg(position.yaw),
        pitchDeg: radToDeg(position.pitch),
        fovDeg: currentFov,
      });
    });
    viewer.addEventListener('zoom-updated', ({ zoomLevel }) => {
      currentFov = maxFov - (zoomLevel / 100) * (maxFov - minFov);
    });
    viewer.addEventListener('size-updated', ({ size }) => applyRule(size.width, size.height));
    viewer.addEventListener('click', ({ data }) => {
      if (!data || data.rightclick) return;
      ctx.emit('pano-click', { yawDeg: radToDeg(data.yaw), pitchDeg: radToDeg(data.pitch) });
    });

    return new Promise((resolve, reject) => {
      viewer.addEventListener('ready', () => resolve(), { once: true });
      viewer.addEventListener('panorama-error', e => reject(e.error || new Error('panorama-error')), { once: true });
    });
  }

  // Entrada "little planet" (P3): arranca mirando al piso con fisheye y zoom
  // abierto, y vuela a la vista inicial. CUALQUIER gesto la corta al instante
  // (patrón del autopilot P2), y CEDE la cámara ante cualquier otro dueño
  // (autopilot/animateTo, cambio de escena) vía introAbort. Solo corre al
  // ABRIR el tour (flag opts.boot del controller) — nunca en el Studio ni con
  // prefers-reduced-motion, y jamás sobre una vista guardada.
  let introAbort = null;
  // Mientras el intro está activo, la pose real (piso + fov máximo) es
  // TRANSITORIA: getView() reporta la vista objetivo para que goTo no la
  // persista como "vista guardada" de la escena (review adversarial P3).
  let introTarget = null;

  // Token de carga (Task 10): solo la ÚLTIMA llamada a show() pinta markers y
  // emite 'view'. Una carga sustituida (PSV resuelve `false` al reemplazar un
  // setPanorama, no rechaza) o invalidada por hide() sale sin tocar nada.
  let loadSeq = 0;
  // Última carga que TERMINÓ de pintar (API de drag del Studio, lote 06):
  // isReady() ⇔ shownSeq === loadSeq — una carga en vuelo o un hide() lo invalidan.
  let shownSeq = -1;

  async function runLittlePlanet(view) {
    if (!viewer) return;
    let aborted = false;
    let anim = null;
    const seq = loadSeq;
    introTarget = { yaw: view.yaw ?? 0, pitch: view.pitch ?? 0, fov: clampFov(view.fov) };
    const abort = () => {
      if (aborted) return;
      aborted = true;
      introTarget = null;           // el usuario tomó la cámara — su pose vuelve a ser la verdad
      cleanup();
      anim?.cancel();               // cancel() RESUELVE (PSV 5.14) — la cámara queda donde va
      viewer?.setOption('fisheye', false);
    };
    introAbort = abort;
    const cleanup = () => {
      document.removeEventListener('pointerdown', abort, { capture: true });
      document.removeEventListener('wheel', abort, { capture: true });
      document.removeEventListener('keydown', abort, { capture: true });
    };
    document.addEventListener('pointerdown', abort, { capture: true, passive: true });
    document.addEventListener('wheel', abort, { capture: true, passive: true });
    document.addEventListener('keydown', abort, { capture: true });
    try {
      viewer.setOption('fisheye', 2);
      viewer.rotate({ yaw: degToRad(view.yaw ?? 0), pitch: degToRad(-89.9) });
      viewer.zoom(0);
      await new Promise(r => setTimeout(r, 700));   // que se lea el "planetita"
      if (aborted || !viewer) return;
      anim = viewer.animate({
        yaw: degToRad(view.yaw ?? 0),
        pitch: degToRad(view.pitch ?? 0),
        zoom: fovToZoom(clampFov(view.fov)),
        speed: '3rpm',
      });
      if (anim) await anim;
      if (aborted || !viewer) return;
      viewer.setOption('fisheye', false);
    } finally {
      cleanup();
      if (introAbort === abort) introAbort = null;
      introTarget = null;
      // un resize durante el intro se ignoró → la regla del tamaño actual (salvo que
      // otra escena ya haya tomado el visor: su show() aplica la suya)
      if (seq === loadSeq) applyRule(container.clientWidth, container.clientHeight);
    }
  }

  return {
    capabilities: { radar: true, gyro: true, autopilot: true },

    async show(scene, savedView, opts) {
      const seq = ++loadSeq;
      const stale = () => seq !== loadSeq;
      introAbort?.();   // navegar mientras el intro corre → el intro cede
      applyFovLimits(scene);
      const override = scene.fovOverride === true && Number.isFinite(scene.initialView?.fov);
      ruleFov = override ? null : clampFov(defaultVFov(container.clientWidth, container.clientHeight));
      wantFov = null;
      const baseRule = ruleFov;   // la regla con la que se calculó view.fov
      const view = savedView || {
        yaw: scene.initialView?.yaw ?? 0,
        pitch: scene.initialView?.pitch ?? 0,
        fov: override ? scene.initialView.fov : ruleFov,
      };
      view.fov = clampFov(view.fov);
      try {
        if (!viewer) {
          await createViewer(scene, view);
        } else {
          viewer.setOptions({ minFov, maxFov });   // antes del pano: el mapeo de zoom depende de ellos
          const loaded = await viewer.setPanorama(ctx.resolveAsset(scene.src), {
            position: { yaw: degToRad(view.yaw), pitch: degToRad(view.pitch) },
            zoom: fovToZoom(view.fov),
            panoData: sanitizePanoData(scene.panoData),
            sphereCorrection: rollCorrection(scene.roll),
            transition: false,
            showLoader: true,
          });
          if (loaded === false || stale()) return;   // otra carga la sustituyó
          currentFov = view.fov;
          // un resize durante la carga movió ruleFov pero setPanorama aplicó el zoom de
          // la regla vieja → volver a esa base; applyRule (abajo) lleva al tamaño actual
          ruleFov = baseRule;
          wantFov = null;
        }
      } catch (e) {
        if (stale()) return;   // el error es de una carga ya sustituida
        throw e;
      }
      if (stale()) return;
      // tras un display:none el tamaño interno quedó en 0 — recalcular antes
      // de proyectar markers (los polígonos darían paths NaN)
      viewer.autoSize();
      applyRule(container.clientWidth, container.clientHeight);
      await new Promise(r => requestAnimationFrame(r));
      if (stale()) return;
      markers.clearMarkers();
      markers.setMarkers(buildMarkers(scene));
      // Reproyectar EXPLÍCITAMENTE: si se navega mientras el intro corre (o la
      // cámara queda estática tras abortar una animación), el RenderEvent del
      // que depende el plugin puede no llegar y los markers quedan display:none
      // hasta el siguiente gesto. renderMarkers() no depende del event loop.
      viewer.needsUpdate();
      markers.renderMarkers?.();
      // primer view para el radar/HUD
      const p = viewer.getPosition();
      ctx.emit('view', { yawDeg: radToDeg(p.yaw), pitchDeg: radToDeg(p.pitch), fovDeg: currentFov });
      shownSeq = seq;

      // intro SIN await: goTo espera show() y retrasaría scene-changed/el fade.
      // opts.boot lo pone SOLO el goTo de arranque del controller — una pano
      // con intro visitada a mitad del tour jamás lo dispara.
      const wantIntro = !!opts?.boot && scene.intro === 'littlePlanet' && !savedView &&
                        !ctx.editMode && !ctx.reducedMotion;
      if (wantIntro) runLittlePlanet(view);
    },

    hide() {
      loadSeq++;        // una carga en vuelo ya no debe pintar en un contenedor oculto
      introAbort?.();
      viewer?.stopAnimation();
      autorotate?.stop();
      if (gyroOn) { gyro?.stop(); gyroOn = false; }
      // el contenedor pasa a display:none → PSV proyectaría los polígonos con
      // tamaño 0 (paths NaN). show() los reconstruye al volver.
      markers?.clearMarkers();
    },

    getView() {
      if (!viewer) return null;
      // intro en vuelo: la pose real es transitoria (piso/fov máx) y el usuario
      // no la eligió — reportar la vista objetivo evita que goTo la persista
      if (introTarget) return { ...introTarget };
      const p = viewer.getPosition();
      return { yaw: radToDeg(p.yaw), pitch: radToDeg(p.pitch), fov: currentFov };
    },

    // Studio: reconstruye los markers de la escena SIN recargar el pano ni
    // mover la cámara (tras agregar/mover/borrar un hotspot).
    refresh(scene) {
      if (!viewer || !markers) return;
      markers.clearMarkers();
      markers.setMarkers(buildMarkers(scene));
    },

    // Studio: reconstruye SOLO el marker de un hotspot (edición en el
    // inspector) — refresh() rehace todos y cada tecla los reconstruía.
    refreshHotspot(scene, hotspotId) {
      if (!viewer || !markers) return;
      const h = (scene.hotspots || []).find(x => x.id === hotspotId);
      let exists = true;
      try { markers.getMarker(hotspotId); } catch { exists = false; }
      if (!h) { if (exists) markers.removeMarker(hotspotId); return; }
      const def = markerDef(h);
      if (!exists) { markers.addMarker(def); return; }
      try { markers.updateMarker(def); }
      catch { markers.removeMarker(hotspotId); markers.addMarker(def); }   // cambió de clase de marker
    },

    // Studio: resalta el hotspot seleccionado.
    highlight(hotspotId) {
      if (!markers) return;
      for (const m of Object.values(markers.markers || {})) {
        const el = m.domElement || m.element;
        if (el && el.classList) el.classList.toggle('is-selected', m.id === hotspotId);
      }
    },

    // Studio (deslizador de horizonte, lote 11): aplica el roll SIN guardarlo;
    // el siguiente show() vuelve al roll del manifest.
    previewRoll(deg) {
      viewer?.setOption('sphereCorrection', rollCorrection(deg));
    },

    /* ---- API de drag (Studio N+, lote 06). Aditiva: el visor no la llama. ---- */

    // ¿Panorama cargado y sin carga en vuelo? (el loader de PSV no está encima)
    isReady() {
      return !!viewer && shownSeq === loadSeq;
    },

    // Punto de pantalla (clientX/Y) → { yaw, pitch } en grados (yaw en (-180, 180]),
    // con el raycast de la cámara real de PSV. null si carga o cae fuera.
    pointToPosition(clientX, clientY) {
      if (!this.isReady()) return null;
      const r = container.getBoundingClientRect();
      const x = clientX - r.left, y = clientY - r.top;
      if (!(x >= 0 && y >= 0 && x <= r.width && y <= r.height)) return null;
      const s = viewer.dataHelper.viewerCoordsToSphericalCoords({ x, y });
      if (!s || !Number.isFinite(s.yaw) || !Number.isFinite(s.pitch)) return null;
      let yaw = radToDeg(s.yaw);
      if (yaw > 180) yaw -= 360;
      return { yaw, pitch: radToDeg(s.pitch) };
    },

    // Inversa: { yaw, pitch } (grados) → { x, y, visible } en px del contenedor.
    // Sin redondear (sphericalCoordsToViewerCoords de PSV redondea al px): misma
    // proyección de la cámara de PSV. Detrás de la cámara o no finito → visible
    // false y coordenadas finitas fuera de pantalla (nunca NaN hacia el DOM).
    project(pos) {
      const off = { x: -1e5, y: -1e5, visible: false };
      if (!viewer || !pos) return off;
      const v = viewer.dataHelper.sphericalCoordsToVector3({ yaw: degToRad(pos.yaw), pitch: degToRad(pos.pitch) });
      if (!(v.dot(viewer.state.direction) > 0)) return off;
      v.project(viewer.renderer.camera);
      const { width: W, height: H } = viewer.state.size;
      const x = (v.x + 1) / 2 * W, y = (1 - v.y) / 2 * H;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return off;
      return { x, y, visible: x >= 0 && x <= W && y >= 0 && y <= H };
    },

    async animateTo(lookAtDeg, { speed = '6rpm', signal } = {}) {
      introAbort?.();   // el autopilot (o un focus) toma la cámara — el intro cede
      if (!viewer || signal?.aborted) return;
      if (gyroOn) return; // el gyro es dueño de la cámara — animar pelearía con él
      const anim = viewer.animate({
        yaw: degToRad(lookAtDeg.yaw),
        pitch: degToRad(lookAtDeg.pitch ?? 0),
        speed,
      });
      if (!anim) return; // BeforeAnimateEvent prevented (teórico)
      // cancel() RESUELVE la animación (PSV 5.14 · Animation.cancel → __resolve(false));
      // la cámara se detiene donde va — no hace falta try/catch.
      const onAbort = () => anim.cancel();
      signal?.addEventListener('abort', onAbort, { once: true });
      try { await anim; } finally { signal?.removeEventListener('abort', onAbort); }
    },

    async toggleGyro() {
      if (!gyro) return false;
      if (gyroOn) { gyro.stop(); gyroOn = false; return false; }
      await gyro.start(); // rechaza si no hay permiso/soporte → chrome oculta el botón
      gyroOn = true;
      return true;
    },

    destroy() {
      viewer?.destroy();
      viewer = markers = autorotate = gyro = null;
    },
  };
}
