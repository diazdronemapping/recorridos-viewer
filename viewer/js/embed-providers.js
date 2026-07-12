/**
 * embed-providers.js — lista blanca de embeds externos para el panel de info.
 * Compartido: el viewer lo usa para RENDERIZAR (defensa en profundidad) y el
 * Studio para VALIDAR mientras se autora.
 *
 * SEGURIDAD: el src del iframe SIEMPRE lo construimos nosotros a partir del id
 * extraído, o es un passthrough validado por host+path exactos (https only).
 * Una URL fuera de la lista devuelve null y NO se renderiza nada — el HTML del
 * manifest jamás llega crudo a un iframe.
 */

const YT_ID = /^[A-Za-z0-9_-]{6,20}$/;

/** Acepta URL o código <iframe> pegado; devuelve { src, provider } | null. */
export function resolveEmbed(input) {
  if (typeof input !== 'string') return null;
  let raw = input.trim();
  if (!raw) return null;
  // código de inserción pegado → extraer el src y revalidarlo como URL
  const m = raw.match(/<iframe[^>]*\ssrc\s*=\s*["']([^"']+)["']/i);
  if (m) raw = m[1];

  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');

  // YouTube → siempre el dominio sin cookies
  if (['youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'youtu.be'].includes(host)) {
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const p = u.pathname.match(/^\/(?:embed|shorts|live)\/([^/?]+)/);
      if (p) id = p[1];
    }
    if (id && YT_ID.test(id))
      return { src: `https://www.youtube-nocookie.com/embed/${id}?rel=0`, provider: 'YouTube' };
    return null;
  }

  // Vimeo
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const p = u.pathname.match(/^\/(?:video\/)?(\d{6,12})(?:$|\/)/);
    if (p) return { src: `https://player.vimeo.com/video/${p[1]}`, provider: 'Vimeo' };
    return null;
  }

  // Google Maps — SOLO la URL de "Compartir → Insertar mapa" (…/maps/embed?pb=…)
  if (host === 'google.com' && u.pathname.startsWith('/maps/embed')) {
    return { src: u.href, provider: 'Google Maps' };
  }

  // Sketchfab
  if (host === 'sketchfab.com') {
    let id = null;
    const em = u.pathname.match(/^\/models\/([0-9a-f]{16,64})\/embed/i);
    const md = u.pathname.match(/^\/(?:3d-models|models)\/(?:[^/]*-)?([0-9a-f]{16,64})(?:$|\/)/i);
    if (em) id = em[1]; else if (md) id = md[1];
    if (id) return { src: `https://sketchfab.com/models/${id}/embed`, provider: 'Sketchfab' };
    return null;
  }

  // Matterport
  if (host === 'my.matterport.com' && u.pathname.startsWith('/show')) {
    const id = u.searchParams.get('m');
    if (id && /^[A-Za-z0-9]{4,32}$/.test(id))
      return { src: `https://my.matterport.com/show/?m=${id}`, provider: 'Matterport' };
    return null;
  }

  return null;
}

/** Para mensajes de validación del Studio. */
export const EMBED_PROVIDERS_LABEL =
  'YouTube, Vimeo, Google Maps (código "Insertar mapa"), Sketchfab o Matterport';
