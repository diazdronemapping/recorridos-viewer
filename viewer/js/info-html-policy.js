/**
 * info-html-policy.js — allowlist EDITORIAL del HTML de los puntos de
 * información (antes en chrome.js:45-53, movida sin cambios para que el
 * Studio avise al autor de lo que el visor quitará). Única fuente.
 */
export const INFO_HTML_CFG = {
  ALLOWED_TAGS: ['p', 'br', 'hr', 'div', 'span', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                 'strong', 'b', 'em', 'i', 'u', 's', 'small', 'mark', 'sub', 'sup', 'code',
                 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'a', 'img', 'figure', 'figcaption',
                 'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'iframe'],
  ALLOWED_ATTR: ['href', 'target', 'title', 'src', 'alt', 'width', 'height', 'colspan', 'rowspan'],
  ALLOW_DATA_ATTR: false,
  RETURN_DOM_FRAGMENT: true,
};
