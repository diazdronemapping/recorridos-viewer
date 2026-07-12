/**
 * hotspot-icons.js — biblioteca de iconos de hotspot compartida viewer ↔ Studio.
 * SVGs inline (stroke currentColor, viewBox 24, trazo estilo feather) — cero
 * assets externos, consistentes con los iconos del chrome.
 *
 * SEGURIDAD: el `icon` del manifest NUNCA se inyecta al DOM — solo se usa como
 * LLAVE de lookup en este diccionario. Un id desconocido cae al icono por
 * defecto del tipo y no emite clase (anti-XSS + forward-compat con manifests
 * más nuevos que tengan iconos que este viewer no conoce).
 */

const S = inner =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

/* Iconos por defecto según el tipo de hotspot (los históricos del engine). */
export const DEFAULT_ICONS = {
  nav: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  info: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><circle cx="12" cy="8" r="0.5" fill="currentColor"/></svg>',
  link: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  download: S('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/>'),
};

/* Biblioteca elegible desde el Studio (16). Ids CEMENTADOS en el schema. */
export const ICON_LIB = {
  casa:      { label: 'Casa',            svg: S('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>') },
  recamara:  { label: 'Recámara',        svg: S('<path d="M3 18v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5"/><path d="M2 18h20"/><path d="M5 11V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4"/><path d="M7 11h4v0"/>') },
  bano:      { label: 'Baño',            svg: S('<path d="M4 12h16v3a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/><path d="M6 12V5.5A1.5 1.5 0 0 1 7.5 4h1A1.5 1.5 0 0 1 10 5.5V6"/><line x1="8" y1="19" x2="7" y2="21"/><line x1="16" y1="19" x2="17" y2="21"/>') },
  cocina:    { label: 'Cocina',          svg: S('<path d="M7 3v7a2 2 0 0 0 4 0V3"/><line x1="9" y1="12" x2="9" y2="21"/><path d="M17 3c-1.5 1-2 3-2 6v3h3V3z"/><line x1="17" y1="12" x2="17" y2="21"/>') },
  alberca:   { label: 'Alberca',         svg: S('<path d="M2 16c2-1.6 4-1.6 6 0s4 1.6 6 0 4-1.6 6 0"/><path d="M2 20c2-1.6 4-1.6 6 0s4 1.6 6 0 4-1.6 6 0"/><path d="M9 13V6a2 2 0 0 1 4 0"/><path d="M9 9h6"/><path d="M15 13V6a2 2 0 0 1 4 0"/>') },
  cochera:   { label: 'Cochera',         svg: S('<path d="M5 15l1.6-4.5A2 2 0 0 1 8.5 9h7a2 2 0 0 1 1.9 1.5L19 15"/><rect x="4" y="15" width="16" height="4" rx="1"/><circle cx="7.5" cy="19" r="1.2"/><circle cx="16.5" cy="19" r="1.2"/>') },
  arbol:     { label: 'Árbol',           svg: S('<path d="M12 3l5 7h-3l4 6H6l4-6H7z"/><line x1="12" y1="16" x2="12" y2="21"/>') },
  agua:      { label: 'Agua',            svg: S('<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>') },
  luz:       { label: 'Electricidad',    svg: S('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10"/>') },
  camino:    { label: 'Camino / acceso', svg: S('<path d="M4 21 9 3"/><path d="M20 21 15 3"/><line x1="12" y1="7" x2="12" y2="9"/><line x1="12" y1="13" x2="12" y2="15"/><line x1="12" y1="19" x2="12" y2="21"/>') },
  lindero:   { label: 'Lindero',         svg: S('<line x1="5" y1="21" x2="5" y2="3"/><path d="M5 4h12l-2.5 3.5L17 11H5"/>') },
  vista:     { label: 'Vista / mirador', svg: S('<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>') },
  estrella:  { label: 'Destacado',       svg: S('<polygon points="12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 8.9 8.3"/>') },
  alerta:    { label: 'Precaución',      svg: S('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><circle cx="12" cy="16.5" r="0.5" fill="currentColor"/>') },
  documento: { label: 'Documento',       svg: S('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/>') },
  camara:    { label: 'Foto / video',    svg: S('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>') },
};

/** SVG a renderizar: icono elegido si existe en la lib, si no el default del tipo. */
export function iconSvg(iconId, kind) {
  return (iconId && ICON_LIB[iconId]?.svg) || DEFAULT_ICONS[kind] || DEFAULT_ICONS.info;
}

/** Clase extra del marker — SOLO si el id existe en la lib (nunca texto libre). */
export function iconClass(iconId) {
  return iconId && ICON_LIB[iconId] ? ` rc-hotspot--icon-${iconId}` : '';
}
