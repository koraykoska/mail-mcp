const TAGS = /<[^>]+>/g;
const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Collapse whitespace and cap a preview. */
export function makeSnippet(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/** Very small HTML-to-text used when the html-to-text package is unnecessary (previews). */
function stripTag(html: string, tag: string): string {
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

export function htmlToRoughText(html: string): string {
  return stripTag(stripTag(html, 'style'), 'script')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(TAGS, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
      const lower = entity.toLowerCase();
      if (lower.startsWith('#x')) {
        const code = Number.parseInt(lower.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      if (lower.startsWith('#')) {
        const code = Number.parseInt(lower.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return ENTITIES[lower] ?? match;
    });
}
