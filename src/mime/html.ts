import sanitizeHtmlLib from 'sanitize-html';
import { htmlToRoughText } from './snippet.js';

/**
 * Allow-list cleaner for HTML that is returned to a client or quoted into a
 * message someone else will open. Tags, attributes, and URL schemes that are
 * not listed are dropped. Entity decoding, whitespace inside schemes, and
 * slash-separated attributes such as `<svg/onload=...>` are handled by the
 * parser before the scheme check. The result is still untrusted markup.
 */
const SANITIZE_OPTIONS: sanitizeHtmlLib.IOptions = {
  allowedTags: [
    'a',
    'abbr',
    'b',
    'blockquote',
    'br',
    'caption',
    'code',
    'dd',
    'del',
    'div',
    'dl',
    'dt',
    'em',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'i',
    'img',
    'ins',
    'li',
    'ol',
    'p',
    'pre',
    's',
    'span',
    'strong',
    'sub',
    'sup',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'u',
    'ul',
  ],
  allowedAttributes: {
    a: ['href', 'name', 'title'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    '*': ['title'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'cid'],
  allowedSchemesByTag: {
    a: ['http', 'https', 'mailto', 'cid'],
    img: ['http', 'https', 'cid'],
  },
  allowedSchemesAppliedToAttributes: [
    'href',
    'src',
    'cite',
    'action',
    'formaction',
    'data',
    'xlink:href',
    'poster',
    'background',
    'ping',
    'srcset',
    'longdesc',
  ],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  parseStyleAttributes: false,
};

export function sanitizeHtml(html: string): string {
  return sanitizeHtmlLib(html, SANITIZE_OPTIONS);
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function quoteHtml(inner: string, fromLabel: string, dateLabel: string): string {
  return `<p>On ${escapeText(dateLabel)}, ${escapeText(fromLabel)} wrote:</p><blockquote>${sanitizeHtml(inner)}</blockquote>`;
}

export function textToHtml(text: string): string {
  return `<p>${escapeText(text).replace(/\n/g, '<br>')}</p>`;
}

/** Visible text of sanitized HTML. Ordinary words such as "data:" are kept. */
export function htmlToSafeText(html: string): string {
  return htmlToRoughText(sanitizeHtml(html));
}
