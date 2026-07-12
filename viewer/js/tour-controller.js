/**
 * tour-controller.js — dueño del manifest, del estado del tour y del ciclo
 * de vida de los Scene Engines. Los engines solo renderizan; el controller
 * navega, persiste vistas y coordina el chrome.
 *
 * Contrato de engine (uno por scene.type):
 *   create(ctx, container) -> engine
 *   engine.show(sceneDef, savedView?)  async
 *   engine.hide()
 *   engine.getView() -> objeto serializable | null
 *   engine.capabilities -> { radar?, autopilot?, gyro? }
 *   engine.animateTo?(lookAtDeg, opts)  async   (autopilot, opcional)
 *   engine.destroy?()
 */

import { loadManifest } from './manifest-loader.js';
import { Chrome } from './chrome.js';

const ENGINE_MODULES = {
  pano360: () => import('./engines/engine-pano360.js'),
  potree: () => import('./engines/engine-potree.js'),
  ortho: () => import('./engines/engine-ortho.js'),
  splat: () => import('./engines/engine-splat.js'),
};

// sleep abortable: con señal, resuelve temprano al abortar (nunca rechaza —
// quien espera chequea signal.aborted). Sin señal, es el sleep de siempre.
const sleep = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done() {
    clearTimeout(t);
    signal?.removeEventListener('abort', done);
    resolve();
  }
  signal?.addEventListener('abort', done, { once: true });
});

export class TourController {
  constructor({ tourUrl, debug = false, embed = null, kiosk = false }) {
    this.tourUrl = tourUrl;
    this.baseUrl = tourUrl.slice(0, tourUrl.lastIndexOf('/') + 1);
    this.debug = debug;
    // embed override (?embed=0|1) gana sobre la auto-detección: el preview del
    // Studio es un iframe pero debe comportarse standalone
    this.embedded = embed ?? (window !== window.top);
    // ?kiosk=1 = pantalla limpia sin editar el manifest (OR con manifest.ui.kiosk)
    this.kioskParam = kiosk;
    this.isMobile = matchMedia('(pointer: coarse)').matches;
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.engines = new Map();      // type -> engine instance
    this.containers = new Map();   // type -> element
    this.viewState = new Map();    // sceneId -> view
    this.currentScene = null;
    this.currentEngine = null;
    this._navToken = 0;
    this._listeners = new Map();
    this._autopilot = null;
    // interacción del usuario DENTRO del iframe de la nube (postMessage
    // 'interact' → engine-potree) — el pointerdown de allá no llega a este
    // document, por eso cruza como evento del bus
    this.on('potree-interact', () => this.stopAutopilot());
    this.on('splat-interact', () => this.stopAutopilot());   // gemelo splat (F1.5-L7)
  }

  /* ---------- eventos internos (chrome / hud) ---------- */
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
  }
  emit(event, payload) {
    (this._listeners.get(event) || []).forEach(fn => {
      try { fn(payload); } catch (e) { console.error(`[recorridos] listener ${event}:`, e); }
    });
  }

  /* ---------- assets ---------- */
  resolveAsset(p) {
    if (!p) return p;
    // blob:/data: pasan INTACTOS — el preview del Studio reescribe los assets
    // a object URLs (modo carpeta real) y anteponerles baseUrl los rompía
    // (review adversarial P3, recuperado del refutador caído)
    return p.startsWith('/') || /^(https?|blob|data):/.test(p) ? p : this.baseUrl + p;
  }

  /* ---------- boot ---------- */
  async boot() {
    this.manifest = await loadManifest(this.tourUrl);
    document.title = `${this.manifest.meta.title} · Drone Mapping MX`;
    this._applyTheme();

    this.chrome = new Chrome(this);

    if (this.debug) {
      const { DebugHUD } = await import('./debug-hud.js');
      this.hud = new DebugHUD(this);
    }

    window.addEventListener('popstate', () => {
      // sin hash (entrada inicial) → escena de arranque
      const id = this._parseHash() || this.manifest.start.sceneId;
      if (id !== this.currentScene?.id) this.goTo(id, { fromHistory: true });
    });

    const startId = this._parseHash() || this.manifest.start.sceneId;
    await this.goTo(startId, { fromHistory: true, instant: true });
    // fija el hash de la entrada inicial para que Atrás/Adelante siempre resuelvan
    history.replaceState(null, '', `#scene=${startId}`);
    document.getElementById('loading')?.classList.add('is-done');
    this.emit('ready');
  }

  _applyTheme() {
    const t = this.manifest.branding?.theme || {};
    const root = document.documentElement;
    if (t.accent) root.style.setProperty('--rc-accent', t.accent);
    if (t.bg) root.style.setProperty('--rc-bg', t.bg);
  }

  _parseHash() {
    const m = location.hash.match(/scene=([a-z0-9-]+)/);
    return m && this.manifest?.byId.has(m[1]) ? m[1] : null;
  }

  _writeHash(id, fromHistory) {
    if (fromHistory) return;
    const url = `#scene=${id}`;
    // Embebido: replaceState para que el botón Atrás salga de la página host
    // en un clic en vez de deshacer escena por escena.
    if (this.embedded) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
  }

  /* ---------- engines ---------- */
  _containerFor(type) {
    if (this.containers.has(type)) return this.containers.get(type);
    let el;
    if (type === 'potree') {
      el = document.getElementById('scene-host-potree');
    } else {
      el = document.createElement('div');
      el.className = `rc-engine rc-engine--${type}`;
      el.style.cssText = 'position:absolute;inset:0;display:none;';
      document.getElementById('scene-host').appendChild(el);
    }
    this.containers.set(type, el);
    return el;
  }

  async engineFor(type) {
    if (this.engines.has(type)) return this.engines.get(type);
    const mod = await ENGINE_MODULES[type]();
    const ctx = {
      controller: this,
      manifest: this.manifest,
      resolveAsset: p => this.resolveAsset(p),
      isMobile: this.isMobile,
      embedded: this.embedded,
      reducedMotion: this.reducedMotion,
      debug: this.debug,
      emit: (ev, payload) => this.emit(ev, payload),
      goTo: id => this.goTo(id),
    };
    const engine = mod.create(ctx, this._containerFor(type));
    this.engines.set(type, engine);
    return engine;
  }

  _showContainer(type) {
    for (const [t, el] of this.containers) {
      const on = t === type;
      if (t === 'potree') el.hidden = !on;
      else el.style.display = on ? 'block' : 'none';
    }
  }

  /* ---------- navegación ---------- */
  async goTo(id, { fromHistory = false, instant = false, force = false } = {}) {
    const scene = this.manifest.byId.get(id);
    if (!scene) { console.warn(`[recorridos] escena "${id}" no existe`); return; }
    // force: remontar la escena actual (recuperación tras un fallo de carga)
    if (this.currentScene?.id === id && !force) return;

    const token = ++this._navToken;
    const fade = document.getElementById('fade-layer');
    if (!instant) {
      fade.classList.add('is-active');
      await sleep(this.reducedMotion ? 0 : 220);
      if (token !== this._navToken) return; // navegación superada por otra
    }

    // guardar la vista de la escena actual para restaurarla al volver
    if (this.currentScene && this.currentEngine?.getView) {
      const v = this.currentEngine.getView();
      if (v) this.viewState.set(this.currentScene.id, v);
    }

    let engine;
    // Carga lenta (nube grande, red pobre): avisar en vez de dejar el fade mudo.
    const slowTimer = setTimeout(() => {
      if (token === this._navToken) this.emit('scene-loading', { scene });
    }, 2500);
    try {
      engine = await this.engineFor(scene.type);
      if (token !== this._navToken) return;
      if (this.currentEngine && this.currentEngine !== engine) this.currentEngine.hide();
      this._showContainer(scene.type);
      // boot: SOLO la escena de arranque puede disparar su intro (littlePlanet).
      // instant=true únicamente en el goTo del boot — el flag viaja al engine;
      // sin él, el intro corría en la PRIMERA pano mostrada aunque fuera a
      // mitad del tour (engine perezoso — review adversarial P3).
      await engine.show(scene, this.viewState.get(id) || null, { boot: instant });
    } catch (err) {
      console.error(`[recorridos] error mostrando escena "${id}":`, err);
      fade.classList.remove('is-active');
      // El chrome ofrece Reintentar/Volver; el estado interno queda en la
      // escena anterior (consistente: force permite remontar cualquiera).
      if (token === this._navToken) this.emit('scene-error', { scene, error: err });
      throw err;
    } finally {
      clearTimeout(slowTimer);
    }
    if (token !== this._navToken) return;

    this.currentScene = scene;
    this.currentEngine = engine;
    this._writeHash(id, fromHistory);
    this.emit('scene-changed', { scene, engine });

    fade.classList.remove('is-active');
  }

  /* ---------- autopilot ---------- */
  get autopilotRunning() { return !!this._autopilot; }

  async startAutopilot() {
    const cfg = this.manifest.autopilot;
    if (!cfg?.enabled || !cfg.steps?.length || this._autopilot) return;
    const ac = new AbortController();
    const signal = ac.signal;
    this._autopilot = { ac };
    this.emit('autopilot', { running: true });

    // Cualquier interacción del visitante cancela AL INSTANTE (la señal corta
    // el dwell y la animación en vuelo). Se excluye el propio botón/chip de
    // autopilot: su click es un toggle — cancelarle aquí lo re-arrancaría.
    const cancelPointer = e => {
      if (e.target?.closest?.('#btn-autopilot, #autopilot-chip')) return;
      this.stopAutopilot();
    };
    const NAV_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
                      'PageUp', 'PageDown', '+', '-', 'Escape'];
    const cancelKeys = e => { if (NAV_KEYS.includes(e.key)) this.stopAutopilot(); };
    const cancelWheel = () => this.stopAutopilot();
    document.addEventListener('pointerdown', cancelPointer, { capture: true });
    document.addEventListener('keydown', cancelKeys, { capture: true });
    document.addEventListener('wheel', cancelWheel, { capture: true, passive: true });

    try {
      for (let i = 0; i < cfg.steps.length; i++) {
        const step = cfg.steps[i];
        if (signal.aborted) break;
        this.emit('autopilot-step', { index: i, total: cfg.steps.length });
        await this.goTo(step.sceneId);
        if (signal.aborted) break;
        // si la escena fue podada o falló, goTo no navegó — no animar la equivocada
        if (step.lookAt && this.currentEngine?.animateTo &&
            this.currentScene?.id === step.sceneId) {
          await this.currentEngine.animateTo(step.lookAt, { speed: '6rpm', signal });
        }
        if (signal.aborted) break;
        await sleep((step.dwell ?? 4) * 1000, signal);
      }
    } catch (e) {
      // una escena falló durante el tour: scene-error ya avisó al usuario;
      // el autopilot se detiene sin reventar el handler del botón
      console.warn('[recorridos] autopilot detenido por fallo de escena:', e?.message || e);
    } finally {
      document.removeEventListener('pointerdown', cancelPointer, { capture: true });
      document.removeEventListener('keydown', cancelKeys, { capture: true });
      document.removeEventListener('wheel', cancelWheel, { capture: true });
      // solo limpiar si sigue siendo NUESTRO run (stopAutopilot pudo nulearlo ya,
      // o un nuevo autopilot pudo tomar el relevo durante el unwind)
      if (this._autopilot?.ac === ac) this._autopilot = null;
      this.emit('autopilot', { running: false });
    }
  }

  stopAutopilot() {
    const ap = this._autopilot;
    if (!ap) return;
    // Nulear YA: autopilotRunning=false al instante → el chip se oculta y el
    // botón se resetea aunque un goTo siga en vuelo (nube tarda hasta 45 s).
    // Sin esto el usuario "cancela y el tour igual lo arrastra a la escena"
    // (review adversarial P2). La señal corta dwell/animateTo; el goTo en
    // curso completa pero el loop sale en su próximo check de signal.aborted.
    this._autopilot = null;
    ap.ac.abort();
    this.emit('autopilot', { running: false });
  }
}
