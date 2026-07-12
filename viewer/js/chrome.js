/**
 * chrome.js — UI persistente compartida entre escenas: barra superior,
 * menú de escenas con miniaturas, planta+radar, panel de info de hotspots,
 * controles (autopilot · gyro · música · pantalla completa).
 * Los plugins Map/Plan/Gallery de PSV viven DENTRO del contenedor PSV y
 * desaparecerían en escenas Potree/ortho — por eso este chrome es custom.
 */

import { normDeg } from './geo-core.js';
import { resolveEmbed } from './embed-providers.js';

// Badges en lenguaje de cliente (uxV#7): nada de "3D+" ni jerga técnica
const SCENE_BADGE = { pano360: '360', potree: 'NUBE 3D', ortho: 'MAPA', splat: '3D REAL' };

// Strings autorados (títulos, labels) SIEMPRE escapados antes de innerHTML.
const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class Chrome {
  constructor(controller) {
    this.c = controller;
    this.m = controller.manifest;

    this._applyUiFlags();   // antes de construir: decide qué chrome existe
    this._buildTop();
    this._buildMenu();
    this._buildPlan();
    this._bindInfoPanel();
    this._bindControls();

    controller.on('scene-changed', ({ scene, engine }) => this._onSceneChanged(scene, engine));
    controller.on('view', v => this._onView(v));
    controller.on('info', content => this.showInfo(content));
    controller.on('autopilot', ({ running }) => this._onAutopilot(running));
    controller.on('autopilot-step', ({ index, total }) => {
      const step = document.querySelector('#autopilot-chip .rc-autopilot-chip__step');
      if (step) step.textContent = `${index + 1}/${total}`;
    });
    controller.on('scene-loading', ({ scene }) => this._showSceneLoading(scene));
    controller.on('scene-error', ({ scene }) => this._showSceneError(scene));
  }

  /* ---------- flags de UI · modo pantalla limpia (P3) ---------- */
  // kiosk (manifest.ui.kiosk o ?kiosk=1) oculta el chrome no esencial; un flag
  // explícito por elemento (ui.menu:true…) GANA sobre kiosk. El chip de
  // autopilot nunca se oculta: es el control de escape del recorrido automático.
  _uiFlag(name) {
    const u = this.m.ui || {};
    const kiosk = this.c.kioskParam || u.kiosk === true;
    return typeof u[name] === 'boolean' ? u[name] : !kiosk;
  }

  _applyUiFlags() {
    if (!this._uiFlag('title')) document.getElementById('chrome-top').hidden = true;
    if (!this._uiFlag('menu')) {
      document.getElementById('scene-menu').hidden = true;
      document.getElementById('menu-toggle').hidden = true;
    }
    if (!this._uiFlag('controls')) document.getElementById('chrome-controls').hidden = true;
    this._planDisabled = !this._uiFlag('plan');   // _buildPlan lo respeta
  }

  /* ---------- indicador de autopilot (P2) ---------- */
  _onAutopilot(running) {
    const btn = document.getElementById('btn-autopilot');
    if (btn) {
      btn.classList.toggle('is-on', running);
      btn.setAttribute('aria-label',
        running ? 'Detener recorrido automático' : 'Iniciar recorrido automático');
    }
    const live = document.getElementById('autopilot-live');
    if (live) live.textContent =
      running ? 'Recorrido automático iniciado' : 'Recorrido automático detenido';

    const chip = document.getElementById('autopilot-chip');
    if (!chip) return;
    clearTimeout(this._chipTimer);
    if (running) {
      if (!this._chipBound) {
        this._chipBound = true;
        chip.addEventListener('click', () => this.c.stopAutopilot());
      }
      chip.hidden = false;
      // móvil: arranca compacto — el label completo solapa la planta en
      // viewports angostos (review adversarial P2, baja); el aria-live anuncia
      if (this.c.isMobile) chip.classList.add('is-compact');
      else {
        chip.classList.remove('is-compact');
        // a los 4 s el texto se recoge y queda el pulso + progreso (no estorba)
        this._chipTimer = setTimeout(() => chip.classList.add('is-compact'), 4000);
      }
    } else {
      chip.hidden = true;
      chip.classList.remove('is-compact');
      const step = chip.querySelector('.rc-autopilot-chip__step');
      if (step) step.textContent = '';
    }
  }

  /* ---------- carga lenta / fallo de escena (P0 hardening) ---------- */
  _showSceneLoading(scene) {
    const el = document.getElementById('loading');
    if (!el) return;
    const p = el.querySelector('p');
    if (p) p.textContent = `Cargando ${scene.title || 'la escena'}…`;
    el.classList.add('rc-loading--scene');
    el.classList.remove('is-done');
  }

  _hideSceneLoading() {
    const el = document.getElementById('loading');
    if (!el) return;
    el.classList.add('is-done');
    el.classList.remove('rc-loading--scene');
  }

  _showSceneError(scene) {
    this._hideSceneLoading();
    const box = document.getElementById('scene-error');
    if (!box) return;
    document.getElementById('scene-error-msg').textContent =
      `No se pudo cargar «${scene.title || scene.id}».`;

    const retry = document.getElementById('scene-error-retry');
    retry.onclick = () => {
      box.hidden = true;
      this.c.goTo(scene.id, { force: true }).catch(() => {});
    };

    // Volver = remontar la escena que seguía viva antes del intento fallido
    const prev = this.c.currentScene;
    const back = document.getElementById('scene-error-back');
    const canGoBack = !!prev && prev.id !== scene.id;
    back.hidden = !canGoBack;
    if (canGoBack) {
      back.onclick = () => {
        box.hidden = true;
        this.c.goTo(prev.id, { force: true }).catch(() => {});
      };
    }

    // clic en el fondo = cerrar (nunca dejar al usuario atrapado)
    box.onclick = e => { if (e.target === box) box.hidden = true; };

    box.hidden = false;
    retry.focus();
  }

  /* ---------- top bar ---------- */
  _buildTop() {
    document.getElementById('tour-title').textContent = this.m.meta.title;
    const logo = document.getElementById('brand-logo');
    if (this.m.branding?.logo) {
      logo.src = this.c.resolveAsset(this.m.branding.logo);
      logo.hidden = false;
    }
  }

  /* ---------- menú de escenas ---------- */
  _buildMenu() {
    const menu = document.getElementById('scene-menu');
    for (const scene of this.m.scenes) {
      const btn = document.createElement('button');
      btn.className = 'rc-menu__item';
      btn.dataset.sceneId = scene.id;
      btn.setAttribute('aria-label', scene.title);
      const badge = SCENE_BADGE[scene.type] || scene.type;
      // sin thumbnail: fondo de marca (gradiente) en vez de caja gris muda
      if (!scene.thumbnail) btn.classList.add('rc-menu__item--nothumb');
      btn.innerHTML = `
        ${scene.thumbnail ? `<img src="${esc(this.c.resolveAsset(scene.thumbnail))}" alt="" loading="lazy">` : ''}
        <span>${esc(scene.title)}</span>
        <span class="rc-menu__badge">${esc(badge)}</span>`;
      btn.addEventListener('click', () => this.c.goTo(scene.id));
      menu.appendChild(btn);
    }
    const toggle = document.getElementById('menu-toggle');
    toggle.addEventListener('click', () => {
      const hidden = menu.classList.toggle('is-hidden');
      toggle.setAttribute('aria-expanded', String(!hidden));
    });
  }

  /* ---------- planta + radar ---------- */
  _buildPlan() {
    const plan = this.m.plan;
    this.planWidget = document.getElementById('plan-widget');
    if (!plan || !plan.pins?.length || this._planDisabled) return; // sin planta (o kiosk) → widget oculto

    this.planWidget.hidden = false;
    const img = document.getElementById('plan-img');
    if (plan.src) img.src = this.c.resolveAsset(plan.src);

    const [w, h] = plan.size || [1000, 750];
    const svg = document.getElementById('plan-overlay');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.innerHTML = '';

    // cono del radar (dirección de cámara) — debajo de los pins
    this.cone = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    this.cone.setAttribute('class', 'rc-plan__cone');
    this.cone.setAttribute('visibility', 'hidden');
    svg.appendChild(this.cone);

    // Catcher de taps a nivel del SVG (review adversarial P2): con hit-circles
    // por pin, el ÚLTIMO en el DOM se tragaba a sus vecinos del cluster (7/10
    // pins navegaban a pano-10). El tap se resuelve al pin MÁS CERCANO dentro
    // de un umbral de 22px de pantalla (target efectivo 44px, WCAG 2.5.5).
    const catcher = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    catcher.setAttribute('class', 'rc-plan__catch');
    catcher.setAttribute('width', w);
    catcher.setAttribute('height', h);
    catcher.setAttribute('fill', 'transparent');
    svg.insertBefore(catcher, this.cone);
    this._planSvg = svg;
    catcher.addEventListener('click', e => {
      const r = svg.getBoundingClientRect();
      if (!r.width) return;
      const scale = r.width / w;
      const ux = (e.clientX - r.left) / scale;
      const uy = (e.clientY - r.top) / scale;
      const maxD = 22 / scale;
      let best = null, bestD = Infinity;
      for (const [sceneId, pin] of this.pins) {
        const d = Math.hypot(pin.x - ux, pin.y - uy);
        if (d < bestD) { bestD = d; best = sceneId; }
      }
      if (best && bestD <= maxD) this.c.goTo(best);
    });

    this.pins = new Map();
    for (const pin of plan.pins) {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'rc-plan__pin');
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
      const scene = this.m.byId.get(pin.sceneId);
      g.setAttribute('aria-label', scene?.title || pin.sceneId);
      // position validada numérica por manifest-loader; Number() por si acaso
      const [x, y] = pin.position.map(Number);
      const num = pin.sceneId.match(/\d+$/)?.[0]?.replace(/^0/, '') || '';
      // el pin es visual + teclado; el mouse/tap lo resuelve el catcher
      // (pointer-events:none en CSS). vector-effect: el borde no se adelgaza.
      g.innerHTML = `<circle class="rc-plan__pin-dot" cx="${x}" cy="${y}" r="1" vector-effect="non-scaling-stroke"></circle>
                     <text x="${x}" y="${y}">${num}</text>`;
      g.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.c.goTo(pin.sceneId); }
      });
      svg.appendChild(g);
      this.pins.set(pin.sceneId, { g, x, y });
    }

    // Tamaños por escala real (V-PINS sev3): un radio fijo en unidades viewBox
    // (1400) renderizaba pins de 5-8 px con el widget a 200-280 px. Visual
    // 13px coarse / 9px fino · texto ~10.5px. Re-corre al redimensionar
    // (clientWidth ignora el transform del colapso).
    const frame = this.planWidget.querySelector('.rc-plan__frame');
    const coarse = matchMedia('(pointer: coarse)').matches;
    this._sizePins = () => {
      const scale = frame.clientWidth / w;
      if (!scale) return;
      const rVis = (coarse ? 13 : 9) / scale;
      const font = 10.5 / scale;
      for (const { g, y } of this.pins.values()) {
        g.querySelector('.rc-plan__pin-dot').setAttribute('r', rVis.toFixed(1));
        const t = g.querySelector('text');
        t.setAttribute('font-size', font.toFixed(1));
        t.setAttribute('y', (y + font * 0.34).toFixed(1));
      }
    };
    new ResizeObserver(() => this._sizePins()).observe(frame);
    this._sizePins();

    document.getElementById('plan-toggle').addEventListener('click', e => {
      const collapsed = this.planWidget.classList.toggle('is-collapsed');
      e.currentTarget.setAttribute('aria-expanded', String(!collapsed));
    });
  }

  _updateRadar(yawDeg) {
    if (!this.cone || !this.activePin) return;
    const northOffset = this.c.currentScene?.northOffset;
    const radarOn = this.m.plan?.radar !== false;
    if (northOffset == null || !radarOn) { this.cone.setAttribute('visibility', 'hidden'); return; }
    const bearing = normDeg(northOffset + yawDeg - (this.m.plan.bearing || 0));
    const { x, y } = this.activePin;
    const [w] = this.m.plan.size || [1000];
    const len = w * 0.1, half = 26; // largo proporcional a la planta · apertura en grados
    const a1 = (bearing - half) * Math.PI / 180, a2 = (bearing + half) * Math.PI / 180;
    // 0° = norte = arriba (−y en pantalla)
    const p1 = [x + len * Math.sin(a1), y - len * Math.cos(a1)];
    const p2 = [x + len * Math.sin(a2), y - len * Math.cos(a2)];
    this.cone.setAttribute('d', `M${x},${y} L${p1[0]},${p1[1]} A${len},${len} 0 0 1 ${p2[0]},${p2[1]} Z`);
    this.cone.setAttribute('visibility', 'visible');
  }

  _onView(v) {
    this._lastView = v;
    this._updateRadar(v.yawDeg);
  }

  /* ---------- panel de info ---------- */
  _bindInfoPanel() {
    this.panel = document.getElementById('info-panel');
    document.getElementById('info-close').addEventListener('click', () => this.hideInfo());
    // con el visor de imágenes abierto, Escape es SUYO (lo cierra su handler
    // en captura); aquí no debe cerrar además el panel de abajo
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !this._lbOpen()) this.hideInfo();
    });
    // trap de Tab mientras el panel está abierto (role=dialog aria-modal)
    this.panel.addEventListener('keydown', e => {
      if (e.key !== 'Tab') return;
      // iframe incluido: el embed P3 es tab-stop nativo — sin él en la lista
      // quedaba inalcanzable por teclado y rompía el contrato aria-modal
      const focusables = this.panel.querySelectorAll(
        'button, a[href], iframe, video[controls], audio[controls], [tabindex]:not([tabindex="-1"])');
      if (!focusables.length) return;
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    // El Tab DENTRO de un iframe embebido (cross-origin) no llega a este
    // documento: al agotar sus controles el foco escapa del diálogo por atrás.
    // Recaptura por focusin — el único mecanismo que sí cruza esa frontera.
    document.addEventListener('focusin', e => {
      if (this.panel.hidden || !this.panel.classList.contains('is-open')) return;
      if (this.panel.contains(e.target)) return;
      if (this.lb && this.lb.contains(e.target)) return;          // el visor de imágenes es capa legítima
      const errBox = document.getElementById('scene-error');
      if (errBox && !errBox.hidden) return;                        // el overlay de error manda
      document.getElementById('info-close').focus();
    });
  }

  /** Imágenes del contenido en orden de visor: media (si es imagen) + galería. */
  _contentImages(content) {
    const list = [];
    if (content.media?.kind === 'image' && typeof content.media.src === 'string') list.push(content.media.src);
    if (Array.isArray(content.gallery))
      for (const g of content.gallery) if (typeof g === 'string' && g) list.push(g);
    return list;
  }

  showInfo(content) {
    if (!content) return;
    const imgs = this._contentImages(content);
    // popup solo-imagen: el punto pide abrir la imagen en grande, sin panel
    if (content.layout === 'lightbox' && imgs.length) { this.openLightbox(imgs, 0); return; }

    const box = document.getElementById('info-content');
    let html = `<h2>${esc(content.title || '')}</h2>`;
    // data-lb se numera sobre la MISMA lista filtrada de _contentImages —
    // numerar con el índice crudo del array desalineaba el visor cuando el
    // manifest traía entradas inválidas (review adversarial P3)
    let lb = 0;
    if (content.media && typeof content.media.src === 'string') {
      const src = esc(this.c.resolveAsset(content.media.src));
      if (content.media.kind === 'image')
        html += `<button class="rc-info__imgbtn" data-lb="${lb++}" aria-label="Ver imagen en grande"><img src="${src}" alt=""></button>`;
      else if (content.media.kind === 'video') html += `<video src="${src}" controls playsinline></video>`;
      else if (content.media.kind === 'audio') html += `<audio src="${src}" controls></audio>`;
    }
    if (Array.isArray(content.gallery) && content.gallery.length) {
      const items = [];
      for (const g of content.gallery) {
        if (typeof g !== 'string' || !g) continue;
        items.push(`<button class="rc-gallery__item" data-lb="${lb}" aria-label="Ver imagen ${lb + 1} en grande">
               <img src="${esc(this.c.resolveAsset(g))}" alt="" loading="lazy"></button>`);
        lb++;
      }
      if (items.length) html += `<div class="rc-gallery">${items.join('')}</div>`;
    }
    if (content.embed?.url) {
      // resolveEmbed es la defensa: solo proveedores de la lista blanca, con
      // src construido por nosotros. URL no reconocida → no se renderiza nada.
      const emb = resolveEmbed(content.embed.url);
      if (emb) html += `<div class="rc-embed"><iframe src="${esc(emb.src)}" title="${esc(emb.provider)}"
        sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
        allow="autoplay; fullscreen; picture-in-picture"
        referrerpolicy="strict-origin-when-cross-origin" loading="lazy"></iframe></div>`;
    }
    if (content.html) html += content.html;
    box.innerHTML = html;
    if (imgs.length) box.querySelectorAll('[data-lb]').forEach(el =>
      el.addEventListener('click', () => this.openLightbox(imgs, +el.dataset.lb || 0)));
    // el foco entra al panel (WCAG: el diálogo recibe el foco al abrir) y se
    // devuelve al cerrar; el disparador pudo ser un marker que ya no existe
    this._infoReturnFocus = document.activeElement;
    // un hideInfo previo (p. ej. el de scene-changed) pudo dejar agendado
    // hidden=true — sin cancelarlo, el panel se abre y desaparece a los 320 ms
    clearTimeout(this._infoHideTimer);
    this.panel.hidden = false;
    requestAnimationFrame(() => {
      this.panel.classList.add('is-open');
      document.getElementById('info-close').focus();
    });
  }

  hideInfo() {
    const wasOpen = this.panel.classList.contains('is-open');
    this.panel.classList.remove('is-open');
    clearTimeout(this._infoHideTimer);
    this._infoHideTimer = setTimeout(() => { this.panel.hidden = true; }, 320);
    if (!wasOpen) return;
    // devolver el foco a algo estable: el disparador si sigue visible; si era
    // un marker que rotó fuera de cuadro (display:none) → botón del chrome
    const t = this._infoReturnFocus;
    this._infoReturnFocus = null;
    if (t?.isConnected && t.offsetParent !== null) t.focus();
    else if (document.activeElement === document.body ||
             this.panel.contains(document.activeElement)) {
      this._focusFallback();
    }
  }

  // Retorno de foco a algo VISIBLE: en kiosk el menú está oculto y focus()
  // sobre un elemento hidden es no-op (el foco caía a body y el usuario de
  // teclado/lector perdía su posición — review adversarial P3).
  _focusFallback() {
    for (const id of ['menu-toggle', 'btn-autopilot', 'btn-fullscreen', 'btn-fullpage']) {
      const el = document.getElementById(id);
      if (el && !el.hidden && el.offsetParent !== null) { el.focus(); return; }
    }
    const host = document.getElementById('scene-host');
    if (host) { host.tabIndex = -1; host.focus(); }
  }

  /* ---------- visor de imágenes (lightbox) ---------- */
  // la VERDAD de "abierto" es la clase is-open — `hidden` va 250 ms detrás del
  // cierre visual y usarla de guard se comía el segundo Escape en ese lapso
  _lbOpen() { return !!this.lb && this.lb.classList.contains('is-open'); }

  _ensureLightbox() {
    if (this.lb) return this.lb;
    const el = document.createElement('div');
    el.className = 'rc-lightbox';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Imagen ampliada');
    el.innerHTML = `
      <button class="rc-btn rc-lightbox__x" aria-label="Cerrar imagen">&times;</button>
      <button class="rc-btn rc-lightbox__nav rc-lightbox__nav--prev" aria-label="Imagen anterior">&#8249;</button>
      <img class="rc-lightbox__img" alt="">
      <button class="rc-btn rc-lightbox__nav rc-lightbox__nav--next" aria-label="Imagen siguiente">&#8250;</button>
      <span class="rc-lightbox__count"></span>`;
    document.getElementById('app').appendChild(el);
    this.lb = el;

    el.querySelector('.rc-lightbox__x').addEventListener('click', () => this.closeLightbox());
    el.querySelector('.rc-lightbox__nav--prev').addEventListener('click', () => this._lbShow(this._lbIndex - 1));
    el.querySelector('.rc-lightbox__nav--next').addEventListener('click', () => this._lbShow(this._lbIndex + 1));
    el.addEventListener('click', e => { if (e.target === el) this.closeLightbox(); });
    // captura: gana antes que el Escape del panel de info y que el keyboard de PSV
    document.addEventListener('keydown', e => {
      if (!this._lbOpen()) return;
      if (e.key === 'Escape') { e.stopPropagation(); this.closeLightbox(); }
      else if (e.key === 'ArrowLeft') { e.stopPropagation(); this._lbShow(this._lbIndex - 1); }
      else if (e.key === 'ArrowRight') { e.stopPropagation(); this._lbShow(this._lbIndex + 1); }
      else if (e.key === 'Tab') {
        // trap simple entre los controles visibles del visor
        const f = [...el.querySelectorAll('button:not([hidden])')];
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }, true);
    return el;
  }

  openLightbox(paths, index = 0) {
    if (!paths?.length) return;
    const el = this._ensureLightbox();
    this._lbList = paths.map(p => this.c.resolveAsset(p));
    this._lbReturnFocus = document.activeElement;
    clearTimeout(this._lbHideTimer);   // mismo patrón que el panel: timer stale
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('is-open'));
    this._lbShow(index);
    el.querySelector('.rc-lightbox__x').focus();
  }

  _lbShow(i) {
    const n = this._lbList?.length || 0;
    if (!n) return;
    this._lbIndex = ((i % n) + n) % n;
    // .src por PROPIEDAD (no innerHTML): sin contexto de atributo que escapar
    this.lb.querySelector('.rc-lightbox__img').src = this._lbList[this._lbIndex];
    const multi = n > 1;
    this.lb.querySelector('.rc-lightbox__nav--prev').hidden = !multi;
    this.lb.querySelector('.rc-lightbox__nav--next').hidden = !multi;
    this.lb.querySelector('.rc-lightbox__count').textContent = multi ? `${this._lbIndex + 1} / ${n}` : '';
  }

  closeLightbox() {
    if (!this._lbOpen()) return;
    this.lb.classList.remove('is-open');
    const el = this.lb;
    clearTimeout(this._lbHideTimer);
    this._lbHideTimer = setTimeout(() => { el.hidden = true; }, 250);
    const t = this._lbReturnFocus;
    this._lbReturnFocus = null;
    if (t?.isConnected && t.offsetParent !== null) t.focus();
    else if (!this.panel.hidden) document.getElementById('info-close')?.focus();
    else this._focusFallback();
  }

  /* ---------- controles ---------- */
  _bindControls() {
    // autopilot
    const ap = document.getElementById('btn-autopilot');
    if (this.m.autopilot?.enabled && this.m.autopilot.steps?.length) {
      ap.hidden = false;
      ap.addEventListener('click', () => {
        if (this.c.autopilotRunning) this.c.stopAutopilot();
        else this.c.startAutopilot();
      });
    }

    // giroscopio — solo en táctil (isMobile) donde el sensor existe de verdad
    this.gyroBtn = document.getElementById('btn-gyro');
    if (this.c.isMobile && 'DeviceOrientationEvent' in window) {
      this.gyroBtn.addEventListener('click', async () => {
        const engine = this.c.currentEngine;
        if (!engine?.toggleGyro) return;
        try {
          const on = await engine.toggleGyro();
          this.gyroBtn.classList.toggle('is-on', on);
          this.gyroBtn.setAttribute('aria-pressed', String(on));
        } catch {
          this.gyroBtn.hidden = true; // probe falló (permisos/cadena de iframes) — se retira
        }
      });
    }

    // música ambiente (del tour y/o por escena · play tras primer gesto)
    this._setupMusic();

    // pantalla completa: embebido abre el tour top-level (enlace); standalone
    // usa la Fullscreen API (uxV#19 — antes solo existía F11)
    if (this.c.embedded) {
      const fp = document.getElementById('btn-fullpage');
      fp.href = location.href;
      fp.hidden = false;
    } else if (document.documentElement.requestFullscreen) {
      const fs = document.getElementById('btn-fullscreen');
      fs.hidden = false;
      fs.addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen().catch(() => {});
      });
      document.addEventListener('fullscreenchange', () => {
        const on = !!document.fullscreenElement;
        fs.classList.toggle('is-on', on);
        fs.setAttribute('aria-pressed', String(on));
        fs.setAttribute('aria-label', on ? 'Salir de pantalla completa' : 'Pantalla completa');
      });
    }
  }

  /* ---------- música (del tour y por escena · P3) ---------- */
  _setupMusic() {
    this.musicBtn = document.getElementById('btn-music');
    this._userPausedMusic = false;   // intención del visitante — sobrevive al cambio de pista
    this._musicGesture = false;      // política de autoplay: nada suena antes del primer gesto
    // kiosk sin controles: sin botón visible para pausar, la música NO se
    // auto-reproduce (audio inescapable en un stand — WCAG 1.4.2, review P3)
    this._musicOff = !this._uiFlag('controls');
    if (this._musicOff) return;
    const anyMusic = this.m.music?.src || this.m.scenes.some(s => s.music?.src);
    if (!anyMusic) return;
    document.addEventListener('pointerdown', () => {
      this._musicGesture = true;
      this._playMusicIfWanted();
    }, { once: true });
    this.musicBtn.addEventListener('click', () => {
      if (!this.audio) return;
      const on = this.audio.paused;
      this._userPausedMusic = !on;
      if (on) { this._musicGesture = true; this.audio.play().catch(() => {}); this.musicBtn.classList.add('is-on'); }
      else { this.audio.pause(); this.musicBtn.classList.remove('is-on'); }
      this.musicBtn.setAttribute('aria-pressed', String(on));
    });
  }

  _playMusicIfWanted() {
    if (!this.audio || this._userPausedMusic || !this._musicGesture) return;
    this.audio.play().then(() => {
      this.musicBtn.classList.add('is-on');
      this.musicBtn.setAttribute('aria-pressed', 'true');
    }).catch(() => {});
  }

  /** Pista activa = la de la escena si declara una; si no, la del tour. */
  _applyMusic(scene) {
    if (this._musicOff) return;
    const cfg = scene.music?.src ? scene.music : this.m.music;
    const btn = this.musicBtn;
    if (!cfg?.src) {
      if (this.audio) this.audio.pause();
      this._musicSrc = null;
      if (btn) { btn.hidden = true; btn.classList.remove('is-on'); btn.setAttribute('aria-pressed', 'false'); }
      return;
    }
    if (btn) btn.hidden = false;
    const src = this.c.resolveAsset(cfg.src);
    if (src !== this._musicSrc) {
      if (this.audio) this.audio.pause();
      this._musicSrc = src;
      this.audio = new Audio(src);
      this.audio.loop = cfg.loop !== false;
      this.audio.volume = cfg.volume ?? 0.4;
      if (btn) { btn.classList.remove('is-on'); btn.setAttribute('aria-pressed', 'false'); }
      this._playMusicIfWanted();   // marca is-on al resolver play()
    } else if (this.audio) {
      this.audio.loop = cfg.loop !== false;
      this.audio.volume = cfg.volume ?? 0.4;
    }
  }

  /* ---------- cambio de escena ---------- */
  _onSceneChanged(scene, engine) {
    // llegó una escena sana: retirar el error/aviso de carga si estaban visibles
    const errBox = document.getElementById('scene-error');
    if (errBox) errBox.hidden = true;
    this._hideSceneLoading();

    document.getElementById('scene-title').textContent = scene.title;

    document.querySelectorAll('.rc-menu__item').forEach(el => {
      const active = el.dataset.sceneId === scene.id;
      el.classList.toggle('is-active', active);
      if (active) el.setAttribute('aria-current', 'true');
      else el.removeAttribute('aria-current');
    });
    document.querySelector(`.rc-menu__item[data-scene-id="${scene.id}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });

    // gyro visible solo donde aplica — y SOLO en táctil: en desktop la API
    // existe pero no hay sensor (el probe fallaba y el botón moría, V-GYRO)
    this.gyroBtn.hidden = !this.c.isMobile ||
      !('DeviceOrientationEvent' in window) || !engine.capabilities?.gyro;

    this._maybeShowHint(scene);
    this._applyMusic(scene);

    // planta: pin activo + cono según capacidades. Sin pin para la escena
    // (p. ej. Potree/ortho de OTRO sitio) el widget completo se oculta.
    if (this.pins) {
      for (const [sceneId, pin] of this.pins) {
        const active = sceneId === scene.id;
        pin.g.classList.toggle('is-active', active);
        if (active) pin.g.setAttribute('aria-current', 'true');
        else pin.g.removeAttribute('aria-current');
      }
      // el pin activo se re-apila al tope: en el cluster denso los puntos se
      // solapan y el activo debe verse siempre
      const act = this.pins.get(scene.id);
      if (act && this._planSvg) this._planSvg.appendChild(act.g);
      this.activePin = this.pins.get(scene.id) || null;
      this.planWidget.hidden = !this.activePin;
      if (!this.activePin || !engine.capabilities?.radar) this.cone.setAttribute('visibility', 'hidden');
      else if (this._lastView) this._updateRadar(this._lastView.yawDeg);
    }

    this.hideInfo();
    this.closeLightbox();
  }

  /* ---------- hint de primera visita (P2 · uxV#5) ---------- */
  _maybeShowHint(scene) {
    if (scene.type !== 'pano360' || this._hintDone) return;
    this._hintDone = true; // un intento por sesión, aunque localStorage falle
    let seen = null;
    try { seen = localStorage.getItem('dm_rc_hint_v1'); } catch (_) {}
    if (seen) return;
    try { localStorage.setItem('dm_rc_hint_v1', '1'); } catch (_) {}
    const el = document.getElementById('drag-hint');
    if (!el) return;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('is-on'));
    const hide = () => {
      clearTimeout(t);
      document.removeEventListener('pointerdown', hide, { capture: true });
      el.classList.remove('is-on');
      setTimeout(() => { el.hidden = true; }, 350);
    };
    const t = setTimeout(hide, 4000);
    // el hint no bloquea el drag (pointer-events:none) — el primer gesto lo retira
    document.addEventListener('pointerdown', hide, { capture: true, once: true });
  }
}
