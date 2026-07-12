/**
 * engine-splat.js — Scene Engine 3DGS (Spark 2.1.0 en iframe aislado · F1.5-L7).
 *
 * Clon estructural de engine-potree: el 3D vive en ../splat-scene.html
 * (iframe gemelo, MISMO repo → same-origin en los 4 contextos) y se orquesta
 * con el protocolo postMessage v2:
 *   IFRAME → PADRE  source 'splat-state' · ready / view / interact / error
 *   PADRE → IFRAME  source 'splat-ctrl'  · setView / getView
 *
 * Decisiones heredadas del gemelo potree (mismas razones):
 * · Iframe NUEVO por asset — nunca reasignar .src (historial del top-level).
 * · Handshake idempotente: cada 'ready' recibe setView (reload-once del SW).
 * · Keep-alive desktop / destroy móvil (los MB del splat se conservan o se
 *   liberan según memoria disponible).
 * · `src === null` = motor diferido → placeholder "Próximamente" (santa-maria
 *   live publica una escena splat sin asset — NO romperla).
 */

import { toCloudUrl, SPLAT_SCENE_URL } from '../site-config.js';

// El .sog dev pesa ~38 MB; primer load en Pages con red lenta puede acercarse.
const READY_TIMEOUT_MS = 30000;

// Datos autorados (title/thumbnail) SIEMPRE escapados antes de innerHTML (regla P0).
const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escCssUrl = s => String(s ?? '').replace(/[\\'"()]/g, c => '\\' + c);

const FORMATS = ['sog', 'sogs', 'ply', 'spz', 'splat', 'ksplat'];

/** Formato explícito del manifest o inferido de la extensión de la URL.
 *  blob: no trae extensión — por eso el Studio SIEMPRE declara `format`. */
function formatFor(scene, src) {
  if (FORMATS.includes(scene.format)) return scene.format;
  const m = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(src || '');
  return (m && FORMATS.includes(m[1].toLowerCase())) ? m[1].toLowerCase() : null;
}

export function create(ctx, container) {
  let iframe = null;        // iframe vivo (keep-alive en desktop)
  let iframeOrigin = null;  // origen resuelto (targetOrigin estricto)
  let srcKey = null;        // src del asset que tiene cargado el iframe
  let ready = false;
  let lastView = null;      // última vista { position:[..3], target:[..3] }
  let desiredView = null;   // a aplicar en el próximo 'ready'
  let pending = null;       // { resolve, reject, timer } de un show() en vuelo

  const log = (...args) => { if (ctx.debug) console.log('[engine-splat]', ...args); };

  function post(msg) {
    if (iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage(Object.assign({ source: 'splat-ctrl' }, msg), iframeOrigin || '*');
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
    if (iframeOrigin && e.origin !== iframeOrigin) return;
    const d = e.data;
    if (!d || d.source !== 'splat-state') return;

    if (d.action === 'ready') {
      // Idempotente: puede llegar más de una vez (reload-once del SW).
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
    } else if (d.action === 'interact') {
      ctx.emit('splat-interact');
    } else if (d.action === 'error') {
      // el iframe reporta carga fallida ANTES del timeout — fail-fast
      log('error del iframe:', d.message);
      settle(false, new Error(d.message || 'La vista realista no está disponible.'));
    }
  }
  window.addEventListener('message', onMessage);

  function destroyIframe() {
    if (iframe) { iframe.remove(); iframe = null; }
    iframeOrigin = null;
    srcKey = null;
    ready = false;
    settle(false, new Error('[engine-splat] iframe destruido durante la carga'));
  }

  function renderPlaceholder(scene) {
    const thumb = scene.thumbnail ? ctx.resolveAsset(scene.thumbnail) : null;
    // DOBLE escape (review adversarial P2): escCssUrl para el parser CSS
    // dentro de url('…') y esc() para el parser de ATRIBUTO HTML.
    container.innerHTML = `
      <div class="rc-placeholder" ${thumb ? `style="background-image:url('${esc(escCssUrl(thumb))}')"` : ''}>
        <span class="rc-tag">Próximamente</span>
        <h2>${esc(scene.title)}</h2>
        <p>Vista 3D realista en preparación.
           Mientras tanto, explora el recorrido 360 y la nube de puntos.</p>
      </div>`;
  }

  return {
    capabilities: { radar: false, gyro: false, autopilot: false },

    async show(scene, savedView) {
      // Rama placeholder (src null = motor diferido) — santa-maria live.
      if (scene.src == null) {
        destroyIframe();          // por si se navega de una escena splat real a una diferida
        lastView = null;
        renderPlaceholder(scene);
        return;
      }

      // src: raíz-absoluto /assets/_splat/clouds/ viaja INTACTO (el iframe es
      // same-origin y aplica su propio CLOUD_HOST); assetPath del bundle se
      // resuelve aquí (en preview del Studio puede volverse blob:).
      const src = scene.src.startsWith('/assets/') ? scene.src : ctx.resolveAsset(scene.src);
      const format = formatFor(scene, src);

      desiredView = savedView
        || (scene.initialView
          ? { position: scene.initialView.position.slice(), target: scene.initialView.target.slice() }
          : null);

      // Keep-alive hit: mismo asset ya cargado.
      if (iframe && srcKey === src) {
        log('keep-alive · reusando iframe de', src);
        if (ready && savedView) {
          post({ action: 'setView', position: savedView.position, target: savedView.target });
        }
        return;
      }

      // Fail-fast: un asset inaccesible no debe costar 30 s de pantalla negra.
      // HEAD (sin body — el .sog pesa decenas de MB); blob: no se pre-verifica.
      if (!src.startsWith('blob:')) {
        try {
          const r = await fetch(toCloudUrl(src), { method: 'HEAD', cache: 'no-store' });
          if (!r.ok) throw new Error(String(r.status));
        } catch {
          throw new Error('La vista realista no está disponible en este momento.');
        }
      }

      destroyIframe();
      lastView = null;
      srcKey = src;

      // El contenedor pudo quedar con el placeholder de una escena diferida.
      container.innerHTML = '';

      iframe = document.createElement('iframe');
      const qp = new URLSearchParams();
      qp.set('src', src);
      if (format) qp.set('format', format);
      qp.set('controls', 'external');
      if (scene.render?.maxSh != null) qp.set('maxSh', String(scene.render.maxSh));
      if (scene.render?.background) qp.set('background', String(scene.render.background).replace(/^#/, ''));
      // override QA del host de nubes: se propaga al iframe (como hace el viewer)
      const cloudhost = new URLSearchParams(location.search).get('cloudhost');
      if (cloudhost) qp.set('cloudhost', cloudhost);
      iframe.src = SPLAT_SCENE_URL + '?' + qp.toString();
      iframeOrigin = new URL(iframe.src, location.href).origin;
      iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;';
      iframe.allow = 'fullscreen';
      iframe.title = scene.title || 'Vista realista 3D';
      container.appendChild(iframe);
      log('iframe creado ·', iframe.src);

      await new Promise((resolve, reject) => {
        pending = {
          resolve,
          reject,
          timer: setTimeout(() => {
            console.error(`[engine-splat] timeout (${READY_TIMEOUT_MS / 1000} s) esperando 'ready' de ${src}`);
            settle(false, new Error('La vista realista tardó demasiado en responder.'));
            destroyIframe();   // permite reintentar con un show() posterior
          }, READY_TIMEOUT_MS),
        };
      });
    },

    hide() {
      if (ctx.isMobile) {
        // Móvil: liberar la VRAM/RAM del splat — el próximo show() recrea el
        // iframe y el controller pasa la vista guardada como savedView.
        log('hide móvil · iframe destruido');
        destroyIframe();
      }
      // Desktop: keep-alive — el controller oculta el contenedor con [hidden].
    },

    getView() {
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
