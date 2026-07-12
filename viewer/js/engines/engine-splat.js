/**
 * engine-splat.js — placeholder del tipo de escena `splat` (Gaussian Splatting).
 * El manifest YA declara el tipo; el renderer 3DGS llega en Fase 1.5
 * (Spark vs GaussianSplats3D · input = export comprimido de PostShot).
 */

// Datos autorados (title/thumbnail) SIEMPRE escapados antes de innerHTML (regla P0).
const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escCssUrl = s => String(s ?? '').replace(/[\\'"()]/g, c => '\\' + c);

export function create(ctx, container) {
  return {
    capabilities: { radar: false, gyro: false, autopilot: false },

    async show(scene) {
      const thumb = scene.thumbnail ? ctx.resolveAsset(scene.thumbnail) : null;
      // DOBLE escape (review adversarial P2): escCssUrl para el parser CSS
      // dentro de url('…') y esc() para el parser de ATRIBUTO HTML — solo
      // escCssUrl dejaba que una comilla doble cerrara el atributo (XSS).
      container.innerHTML = `
        <div class="rc-placeholder" ${thumb ? `style="background-image:url('${esc(escCssUrl(thumb))}')"` : ''}>
          <span class="rc-tag">Próximamente</span>
          <h2>${esc(scene.title)}</h2>
          <p>Vista 3D realista en preparación.
             Mientras tanto, explora el recorrido 360 y la nube de puntos.</p>
        </div>`;
    },

    hide() {},
    getView() { return null; },
  };
}
