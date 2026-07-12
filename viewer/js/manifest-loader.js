/**
 * manifest-loader.js — carga y normaliza el manifest.json de un tour.
 * Contrato: schema/manifest.schema.json (v1).
 * Forward-compat: tipos de escena/hotspot DESCONOCIDOS se descartan con
 * console.warn — el viewer nunca crashea por un manifest más nuevo.
 */

const KNOWN_SCENE_TYPES = ['pano360', 'potree', 'ortho', 'splat'];
const KNOWN_HOTSPOT_TYPES = {
  pano360: ['nav', 'info', 'link', 'polygon', 'download'],
  potree: ['nav', 'info', 'link'],
  ortho: ['nav', 'info', 'link'],
  splat: [],
};

export async function loadManifest(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`manifest ${res.status} ${res.statusText} (${url})`);
  const raw = await res.json();

  if (raw.manifestVersion !== 1) {
    console.warn(`[recorridos] manifestVersion ${raw.manifestVersion} > 1 — se intenta leer como v1 (forward-compat)`);
  }
  if (!raw.id || !raw.meta?.title || !raw.start?.sceneId || !Array.isArray(raw.scenes)) {
    throw new Error('manifest inválido: faltan id/meta.title/start.sceneId/scenes');
  }

  const scenes = [];
  for (const scene of raw.scenes) {
    if (!KNOWN_SCENE_TYPES.includes(scene.type)) {
      console.warn(`[recorridos] escena "${scene.id}" tipo desconocido "${scene.type}" — ignorada`);
      continue;
    }
    const knownHs = KNOWN_HOTSPOT_TYPES[scene.type];
    const hotspots = (scene.hotspots || []).filter(h => {
      if (!knownHs.includes(h.type)) {
        console.warn(`[recorridos] hotspot "${h.id}" tipo "${h.type}" no soportado en escena ${scene.type} — ignorado`);
        return false;
      }
      return true;
    });
    scenes.push({ ...scene, hotspots });
  }
  if (!scenes.length) throw new Error('manifest sin escenas soportadas');

  const byId = new Map(scenes.map(s => [s.id, s]));
  let startId = raw.start.sceneId;
  if (!byId.has(startId)) {
    console.warn(`[recorridos] start.sceneId "${startId}" no existe — usando la primera escena`);
    startId = scenes[0].id;
  }

  // Poda de referencias huérfanas (fnE#5): descartar una escena (forward-compat)
  // dejaba hotspots nav / pins de planta / pasos de autopilot apuntando a ella
  // — botones muertos que solo hacían console.warn. También guards de FORMA
  // mínimos: un nav sin position o un polygon con <3 vértices crashean el engine.
  for (const scene of scenes) {
    scene.hotspots = scene.hotspots.filter(h => {
      if (h.type === 'polygon') {
        if (!Array.isArray(h.positions) || h.positions.length < 3) {
          console.warn(`[recorridos] hotspot "${h.id}" polygon sin 3+ positions — ignorado`);
          return false;
        }
        return true;
      }
      if (!h.position) {
        console.warn(`[recorridos] hotspot "${h.id}" sin position — ignorado`);
        return false;
      }
      if (h.type === 'nav' && (!h.target || !byId.has(h.target))) {
        console.info(`[recorridos] hotspot "${h.id}" apunta a escena inexistente "${h.target}" — podado`);
        return false;
      }
      if (h.type === 'download' && (typeof h.src !== 'string' || !h.src)) {
        console.warn(`[recorridos] hotspot "${h.id}" de descarga sin archivo — ignorado`);
        return false;
      }
      // descarga = SOLO archivos del recorrido (relativos, raíz del sitio o los
      // blob: que genera el preview). Una URL externa con download cross-origin
      // NAVEGA el frame a la página del atacante (open redirect) — se poda.
      if (h.type === 'download' &&
          (/^\/\//.test(h.src) || (/^[a-z][a-z0-9+.-]*:/i.test(h.src) && !h.src.startsWith('blob:')))) {
        console.warn(`[recorridos] hotspot "${h.id}" de descarga con dirección externa — ignorado (solo archivos del recorrido)`);
        return false;
      }
      return true;
    });
  }
  const plan = raw.plan ? {
    ...raw.plan,
    pins: (raw.plan.pins || []).filter(p => {
      // position DEBE ser [num, num]: se interpola en el SVG de la planta
      if (!Array.isArray(p.position) || p.position.length !== 2 ||
          !p.position.every(Number.isFinite)) {
        console.warn(`[recorridos] pin "${p.sceneId}" con position inválida — podado`);
        return false;
      }
      return byId.has(p.sceneId) ||
        void console.info(`[recorridos] pin de planta hacia escena inexistente "${p.sceneId}" — podado`);
    }),
  } : raw.plan;
  const autopilot = raw.autopilot ? {
    ...raw.autopilot,
    steps: (raw.autopilot.steps || []).filter(st => byId.has(st.sceneId) ||
      void console.info(`[recorridos] paso de autopilot hacia escena inexistente "${st.sceneId}" — podado`)),
  } : { enabled: false, steps: [] };

  return {
    ...raw,
    scenes,
    byId,
    plan,
    start: { ...raw.start, sceneId: startId },
    idle: { autorotateAfter: 12, rpm: 0.4, ...(raw.idle || {}) },
    branding: raw.branding || {},
    autopilot,
  };
}
