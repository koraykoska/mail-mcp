import { htmlToRoughText } from './snippet.js';

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Drop script and style elements, event-handler attributes, and javascript: URLs.
 * The result is still untrusted markup and must not be treated as an application page.
 */
export function sanitizeHtml(html: string): string {
  const withoutBlocks = stripElement(stripElement(html, 'script'), 'style');
  let out = '';
  let index = 0;
  while (index < withoutBlocks.length) {
    const start = withoutBlocks.indexOf('<', index);
    if (start < 0) {
      out += withoutBlocks.slice(index);
      break;
    }
    out += withoutBlocks.slice(index, start);
    const end = withoutBlocks.indexOf('>', start + 1);
    if (end < 0) {
      break;
    }
    out += cleanTag(withoutBlocks.slice(start, end + 1));
    index = end + 1;
  }
  return out;
}

export function quoteHtml(inner: string, fromLabel: string, dateLabel: string): string {
  return `<p>On ${escapeText(dateLabel)}, ${escapeText(fromLabel)} wrote:</p><blockquote>${sanitizeHtml(inner)}</blockquote>`;
}

export function textToHtml(text: string): string {
  return `<p>${escapeText(text).replace(/\n/g, '<br>')}</p>`;
}

export function htmlToSafeText(html: string): string {
  return stripDangerousSchemes(htmlToRoughText(sanitizeHtml(html)));
}

function stripElement(html: string, tag: string): string {
  const lower = html.toLowerCase();
  const open = `<${tag}`;
  const close = `</${tag}`;
  let out = '';
  let index = 0;
  while (index < html.length) {
    const start = lower.indexOf(open, index);
    if (start < 0) {
      out += html.slice(index);
      break;
    }
    out += html.slice(index, start);
    const end = lower.indexOf(close, start + open.length);
    if (end < 0) {
      break;
    }
    const after = lower.indexOf('>', end + close.length);
    index = after < 0 ? html.length : after + 1;
  }
  return out;
}

function cleanTag(tag: string): string {
  if (tag.startsWith('<!')) {
    return '';
  }
  const firstSpace = tag.search(/\s/);
  if (firstSpace < 0) {
    return tag;
  }
  const name = tag.slice(0, firstSpace);
  const body = tag.slice(firstSpace, tag.endsWith('/>') ? tag.length - 2 : tag.length - 1);
  const attributes = keepAttributes(body);
  const close = tag.endsWith('/>') ? ' />' : '>';
  return attributes ? `${name} ${attributes}${close}` : `${name}${close}`;
}

function keepAttributes(body: string): string {
  const kept: string[] = [];
  const pattern = /([^\s=/]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const raw = match[0];
    const name = match[1];
    if (!name || name.startsWith('/') || /^on/i.test(name)) {
      continue;
    }
    const value = attributeValue(raw);
    if (value !== undefined && isDangerousUrl(name, value)) {
      continue;
    }
    kept.push(raw.trim());
  }
  return kept.join(' ');
}

function attributeValue(raw: string): string | undefined {
  const eq = raw.indexOf('=');
  if (eq < 0) {
    return undefined;
  }
  let value = raw.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

function isDangerousUrl(name: string, value: string): boolean {
  if (!/^(href|src|xlink:href|action|formaction|poster|background)$/i.test(name)) {
    return false;
  }
  let stripped = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code > 32) {
      stripped += char;
    }
  }
  return hasDangerousScheme(stripped);
}

const DANGEROUS_SCHEMES = ['javascript:', 'data:', 'vbscript:'];

function hasDangerousScheme(value: string): boolean {
  const scheme = value.toLowerCase();
  return DANGEROUS_SCHEMES.some((prefix) => scheme.startsWith(prefix));
}

function stripDangerousSchemes(value: string): string {
  let out = '';
  let index = 0;
  const lower = value.toLowerCase();
  while (index < value.length) {
    let next = -1;
    let matched = '';
    for (const scheme of DANGEROUS_SCHEMES) {
      const found = lower.indexOf(scheme, index);
      if (found >= 0 && (next < 0 || found < next)) {
        next = found;
        matched = scheme;
      }
    }
    if (next < 0) {
      out += value.slice(index);
      break;
    }
    out += value.slice(index, next);
    index = next + matched.length;
  }
  return out;
}
