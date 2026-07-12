/**
 * debug-hud.js — HUD de autoría (?debug=1). Es el embrión del builder (Fase 1):
 * lectura en vivo de yaw/pitch/fov, clic-para-copiar posiciones de hotspot,
 * copiar initialView, y asistente de northOffset en 2 pasos.
 *
 * Asistente de norte: (1) identifica en un mapa/satélite el bearing real
 * (grados desde el norte) de un rasgo visible desde el pano; (2) centra la
 * cámara sobre ese rasgo y captura → northOffset = bearing − yaw actual.
 */

import { normDeg } from './geo-core.js';

export class DebugHUD {
  constructor(controller) {
    this.c = controller;
    this.el = document.getElementById('debug-hud');
    this.el.hidden = false;
    this.view = { yawDeg: 0, pitchDeg: 0, fovDeg: 0 };
    this.lastClick = null;

    this._render();
    controller.on('view', v => { this.view = v; this._update(); });
    controller.on('pano-click', p => { this.lastClick = p; this._update(); });
    controller.on('scene-changed', () => this._update());
  }

  _render() {
    this.el.innerHTML = `
      <div class="rc-hud__row"><b>escena</b> <span class="rc-hud__val" id="hud-scene">—</span></div>
      <div class="rc-hud__row"><b>yaw / pitch</b> <span class="rc-hud__val" id="hud-view">—</span></div>
      <div class="rc-hud__row"><b>fov</b> <span class="rc-hud__val" id="hud-fov">—</span></div>
      <div class="rc-hud__row"><b>último clic</b> <span class="rc-hud__val" id="hud-click">—</span></div>
      <div>
        <button id="hud-copy-click" title="Copia la posición del último clic como JSON de hotspot">copiar hotspot</button>
        <button id="hud-copy-view" title="Copia la vista actual como initialView">copiar vista</button>
      </div>
      <div style="margin-top:6px">
        <b>norte:</b> bearing rasgo
        <input id="hud-bearing" type="number" step="0.1" style="width:58px" placeholder="°">
        <button id="hud-north" title="northOffset = bearing − yaw actual (centra antes la cámara en el rasgo)">→ northOffset</button>
      </div>
      <div class="rc-hud__flash" id="hud-flash"></div>`;

    this.el.querySelector('#hud-copy-click').addEventListener('click', () => {
      if (!this.lastClick) return this._flash('haz clic en el pano primero');
      this._copy(`"position": { "yaw": ${this.lastClick.yawDeg.toFixed(1)}, "pitch": ${this.lastClick.pitchDeg.toFixed(1)} }`);
    });
    this.el.querySelector('#hud-copy-view').addEventListener('click', () => {
      const v = this.view;
      this._copy(`"initialView": { "yaw": ${v.yawDeg.toFixed(1)}, "pitch": ${v.pitchDeg.toFixed(1)}, "fov": ${Math.round(v.fovDeg)} }`);
    });
    this.el.querySelector('#hud-north').addEventListener('click', () => {
      const bearing = parseFloat(this.el.querySelector('#hud-bearing').value);
      if (Number.isNaN(bearing)) return this._flash('escribe el bearing del rasgo');
      const off = normDeg(bearing - this.view.yawDeg);
      this._copy(`"northOffset": ${off.toFixed(1)}`);
    });
  }

  _update() {
    this.el.querySelector('#hud-scene').textContent =
      `${this.c.currentScene?.id || '—'}${this.c.embedded ? ' · embed' : ''}`;
    this.el.querySelector('#hud-view').textContent =
      `${this.view.yawDeg.toFixed(1)}° / ${this.view.pitchDeg.toFixed(1)}°`;
    this.el.querySelector('#hud-fov').textContent = `${this.view.fovDeg.toFixed(0)}°`;
    this.el.querySelector('#hud-click').textContent = this.lastClick
      ? `${this.lastClick.yawDeg.toFixed(1)}° / ${this.lastClick.pitchDeg.toFixed(1)}°` : '—';
  }

  async _copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      this._flash('copiado: ' + text.slice(0, 46) + (text.length > 46 ? '…' : ''));
    } catch {
      // clipboard requiere contexto seguro — fallback
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
      this._flash('copiado (fallback)');
    }
  }

  _flash(msg) {
    const f = this.el.querySelector('#hud-flash');
    f.textContent = msg;
    clearTimeout(this._t);
    this._t = setTimeout(() => { f.textContent = ''; }, 2600);
  }
}
