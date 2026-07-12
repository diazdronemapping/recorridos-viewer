/**
 * engine-potree.js — Scene Engine de nube de puntos (Potree 1.8 en iframe aislado).
 *
 * El 3D vive en ../potree-scene.html (iframe) y se orquesta con el protocolo
 * postMessage v2 (ver docs/protocolo-potree.md):
 *   IFRAME → PADRE  source 'potree-state' · ready / view / tool
 *   PADRE → IFRAME  source 'potree-ctrl'  · setView / getView / setBudget /
 *                   tool / stoptool / clear
 *
 * Decisiones clave:
 * · Iframe NUEVO por nube — NUNCA reasignar .src de un iframe ya insertado
 *   (mete entradas de historial en el top-level y rompe el botón Atrás).
 * · Handshake idempotente: en CADA 'ready' recibido se envía setView. El
 *   reload-once del service worker (deploy Pages) recarga la página del iframe
 *   y re-emite 'ready' — re-aplicamos la vista sin re-crear nada.
 * · Keep-alive: hide() NO destruye el iframe en desktop (los MB del octree ya
 *   descargados se conservan); en móvil se remueve para liberar memoria y se
 *   recrea en el próximo show().
 */

// Primer load real (Pages + reload-once del SW) puede tardar >20 s; el caso
// "nube inaccesible" ya NO llega aquí (preflight fail-fast en show()).
const READY_TIMEOUT_MS = 45000;

export function create(ctx, container) {
  let iframe = null;        // iframe vivo (keep-alive en desktop)
  let cloudKey = null;      // path de la nube que tiene cargada el iframe
  let ready = false;        // el iframe ya emitió su primer 'ready'
  let lastView = null;      // última vista reportada { position:[..3], target:[..3] }
  let desiredView = null;   // vista a aplicar en el próximo 'ready' (savedView ?? initialView)
  let pending = null;       // { resolve, reject, timer } de un show() en vuelo

  const log = (...args) => { if (ctx.debug) console.log('[engine-potree]', ...args); };

  function post(msg) {
    if (iframe && iframe.contentWindow) {
      // '*' como targetOrigin: mismo origen en producción (Pages) y en local
      iframe.contentWindow.postMessage(Object.assign({ source: 'potree-ctrl' }, msg), '*');
    }
  }

  function settle(ok, err) {
    if (!pending) return;
    clearTimeout(pending.timer);
    const { resolve, reject } = pending;
    pending = null;
    ok ? resolve() : reject(err);
  }

  function onMessage(e) {
    if (!iframe || e.source !== iframe.contentWindow) return;
    const d = e.data;
    if (!d || d.source !== 'potree-state') return;

    if (d.action === 'ready') {
      // Idempotente: puede llegar más de una vez (reload-once del SW).
      // Preferimos la última vista conocida del usuario; si no hay, la deseada
      // (savedView ?? initialView del manifest).
      const v = lastView || desiredView;
      if (v) post({ action: 'setView', position: v.position, target: v.target });
      if (!ready) {
        ready = true;
        log('ready · vista inicial aplicada:', v);
        settle(true);
      } else {
        log('ready re-emitido (reload SW) · vista re-aplicada:', v);
      }
    } else if (d.action === 'view') {
      if (Array.isArray(d.position) && d.position.length === 3 &&
          Array.isArray(d.target) && d.target.length === 3) {
        lastView = { position: d.position.slice(), target: d.target.slice() };
      }
    } else if (d.action === 'tool') {
      log('tool =', d.tool ?? null);
      ctx.emit('potree-tool', { tool: d.tool ?? null });
    } else if (d.action === 'interact') {
      // gesto del usuario dentro del iframe — el controller cancela el autopilot
      ctx.emit('potree-interact');
    }
  }
  window.addEventListener('message', onMessage);

  function destroyIframe() {
    if (iframe) { iframe.remove(); iframe = null; }
    cloudKey = null;
    ready = false;
    settle(false, new Error('[engine-potree] iframe destruido durante la carga'));
  }

  function budgetFor(scene) {
    return ctx.isMobile
      ? (scene.cloud.pointBudgetMobile ?? 500000)
      : (scene.cloud.pointBudget ?? 1500000);
  }

  return {
    capabilities: { radar: false, gyro: false, autopilot: false },

    async show(scene, savedView) {
      const path = scene.cloud?.path;
      if (!path) throw new Error(`[engine-potree] escena "${scene.id}" sin cloud.path`);

      desiredView = savedView
        || (scene.initialView
          ? { position: scene.initialView.position.slice(), target: scene.initialView.target.slice() }
          : null);

      // Keep-alive hit: mismo octree ya cargado — no se re-descarga nada.
      if (iframe && cloudKey === path) {
        log('keep-alive · reusando iframe de', path);
        // La cámara quedó donde estaba; solo re-aplicar si el controller trae
        // una vista guardada distinta (idempotente si es la misma).
        if (ready && savedView) {
          post({ action: 'setView', position: savedView.position, target: savedView.target });
        }
        return;
      }

      // Fail-fast (P0): una nube inaccesible no debe costar 45 s de pantalla
      // negra — el metadata.json es pequeño y confirma que el path responde.
      try {
        const r = await fetch(path, { cache: 'no-store' });
        if (!r.ok) throw new Error(String(r.status));
      } catch {
        throw new Error('La nube de puntos no está disponible en este momento.');
      }

      // Nube distinta (o primer show / show tras hide móvil) → iframe NUEVO.
      destroyIframe();
      lastView = null;
      cloudKey = path;

      iframe = document.createElement('iframe');
      // potree-scene.html vive en la raíz de recorridos/ (un nivel arriba de viewer/)
      iframe.src = '../potree-scene.html'
        + '?cloud=' + encodeURIComponent(path)
        + '&controls=external'
        + '&budget=' + budgetFor(scene);
      iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;';
      iframe.title = scene.title || 'Nube de puntos';
      container.appendChild(iframe);
      log('iframe creado ·', iframe.src);

      await new Promise((resolve, reject) => {
        pending = {
          resolve,
          reject,
          timer: setTimeout(() => {
            console.error(`[engine-potree] timeout (${READY_TIMEOUT_MS / 1000} s) esperando 'ready' de ${path}`);
            settle(false, new Error('La nube de puntos tardó demasiado en responder.'));
            destroyIframe();   // permite reintentar con un show() posterior
          }, READY_TIMEOUT_MS),
        };
      });
    },

    hide() {
      if (ctx.isMobile) {
        // Móvil: liberar memoria del octree — el próximo show() recrea el iframe
        // y el controller le pasa la vista guardada (viewState) como savedView.
        log('hide móvil · iframe destruido');
        destroyIframe();
      }
      // Desktop: keep-alive — el controller oculta el contenedor con [hidden];
      // los puntos ya descargados quedan en memoria para el regreso instantáneo.
    },

    getView() {
      // Síncrono: cache del último 'view' recibido (respuesta a getView o
      // emisión espontánea throttled del iframe).
      return lastView
        ? { position: lastView.position.slice(), target: lastView.target.slice() }
        : null;
    },

    destroy() {
      window.removeEventListener('message', onMessage);
      destroyIframe();
    },
  };
}
