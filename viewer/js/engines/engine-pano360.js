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
import { degToRad, radToDeg } from '../geo-core.js';
import { iconSvg, iconClass } from '../hotspot-icons.js';

const MIN_FOV = 30, MAX_FOV = 90;

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

function markerHtml(kind, label, iconId) {
  // role/tabindex: los hotspots son operables por teclado (Tab + Enter/Espacio,
  // WCAG 2.1.1). PSV re-crea el DOM en cada setMarkers — los atributos viven
  // en el html (sobreviven) y el keydown va por DELEGACIÓN en el contenedor.
  // iconId jamás se interpola crudo: iconSvg/iconClass son lookups de la lib.
  const aria = label ? ` aria-label="${escHtml(label)}"` : '';
  return `<div class="rc-hotspot rc-hotspot--${kind}${iconClass(iconId)}" role="button" tabindex="0"${aria}>` +
         iconSvg(iconId, kind) +
         (label ? `<span class="rc-hotspot__label">${escHtml(label)}</span>` : '') + `</div>`;
}

export function create(ctx, container) {
  let viewer = null, markers = null, autorotate = null, gyro = null;
  let currentFov = 70;
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

  function buildMarkers(scene) {
    const defs = [];
    for (const h of scene.hotspots || []) {
      if (h.type === 'polygon') {
        defs.push({
          id: h.id,
          polygon: h.positions.map(p => [degToRad(p.yaw), degToRad(p.pitch)]),
          svgStyle: {
            fill: h.style?.fill || 'rgba(123,193,66,0.16)',
            stroke: h.style?.stroke || 'var(--rc-accent)',
            'stroke-width': '2.5px',
          },
          data: { kind: 'info', content: h.content },
        });
        continue;
      }
      defs.push({
        id: h.id,
        position: { yaw: degToRad(h.position.yaw), pitch: degToRad(h.position.pitch) },
        html: markerHtml(h.type, h.label || (h.type === 'info' ? h.content?.title : null), h.icon),
        size: { width: 44, height: 44 },
        anchor: 'center center',
        data: { kind: h.type, target: h.target, url: h.url, content: h.content,
                src: h.src, filename: h.filename },
      });
    }
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
    else if (d.kind === 'link' && d.url) window.open(d.url, '_blank', 'noopener');
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

  async function runLittlePlanet(view) {
    if (!viewer) return;
    let aborted = false;
    let anim = null;
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
    }
  }

  return {
    capabilities: { radar: true, gyro: true, autopilot: true },

    async show(scene, savedView, opts) {
      introAbort?.();   // navegar mientras el intro corre → el intro cede
      applyFovLimits(scene);
      const view = savedView || {
        yaw: scene.initialView?.yaw ?? 0,
        pitch: scene.initialView?.pitch ?? 0,
        fov: scene.initialView?.fov ?? 70,
      };
      view.fov = clampFov(view.fov);
      if (!viewer) {
        await createViewer(scene, view);
      } else {
        viewer.setOptions({ minFov, maxFov });   // antes del pano: el mapeo de zoom depende de ellos
        await viewer.setPanorama(ctx.resolveAsset(scene.src), {
          position: { yaw: degToRad(view.yaw), pitch: degToRad(view.pitch) },
          zoom: fovToZoom(view.fov),
          panoData: sanitizePanoData(scene.panoData),
          transition: false,
          showLoader: true,
        });
        currentFov = view.fov;
      }
      // tras un display:none el tamaño interno quedó en 0 — recalcular antes
      // de proyectar markers (los polígonos darían paths NaN)
      viewer.autoSize();
      await new Promise(r => requestAnimationFrame(r));
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

      // intro SIN await: goTo espera show() y retrasaría scene-changed/el fade.
      // opts.boot lo pone SOLO el goTo de arranque del controller — una pano
      // con intro visitada a mitad del tour jamás lo dispara.
      const wantIntro = !!opts?.boot && scene.intro === 'littlePlanet' && !savedView &&
                        !ctx.editMode && !ctx.reducedMotion;
      if (wantIntro) runLittlePlanet(view);
    },

    hide() {
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

    // Studio: resalta el hotspot seleccionado.
    highlight(hotspotId) {
      if (!markers) return;
      for (const m of Object.values(markers.markers || {})) {
        const el = m.domElement || m.element;
        if (el && el.classList) el.classList.toggle('is-selected', m.id === hotspotId);
      }
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
