import { writeFileSync } from 'node:fs';
import type { ZodType } from 'zod';
import { TOOLS } from '../src/tools/catalog.js';

const target = new URL('../docs/TOOLS.md', import.meta.url);

function describeInput(schema: ZodType, indent = 0): string[] {
  const lines: string[] = [];
  const pad = '  '.repeat(indent);
  const shape = (schema as { shape?: Record<string, ZodType> }).shape;
  if (!shape) {
    return lines;
  }
  for (const [name, child] of Object.entries(shape)) {
    const optional = child.constructor.name === 'ZodOptional' || child.isOptional?.();
    const description =
      child.description || (child as { unwrap?: () => ZodType }).unwrap?.().description || '';
    lines.push(`${pad}- \`${name}\`${optional ? ' (optional)' : ''}: ${description}`);
    const inner = (child as { unwrap?: () => ZodType }).unwrap?.() ?? child;
    const nested = (inner as { shape?: Record<string, ZodType> }).shape;
    if (nested) {
      lines.push(...describeInput(inner, indent + 1));
    }
    const element = (inner as { element?: ZodType }).element;
    const elementShape = element && (element as { shape?: Record<string, ZodType> }).shape;
    if (elementShape) {
      lines.push(...describeInput(element, indent + 1));
    }
  }
  return lines;
}

export function renderToolsMarkdown(): string {
  const lines: string[] = [
    '# Tools',
    '',
    'Generated from the tool definitions in `src/tools/catalog.ts`. Do not edit by hand.',
    'Run `npm run docs:tools` after changing a tool and commit the result. `npm run docs:check` fails when this file is stale.',
    '',
    `The server registers ${TOOLS.length} tools. A tool that mutates mail or sends it is omitted only when every configured account forbids that class of operation. Calls are still checked against the selected account.`,
    '',
    'Results are JSON in `structuredContent` plus a text rendering. Errors use `isError: true` and a `structuredContent.error.code` from this set:',
    '',
    '`AUTH_FAILED`, `TLS_FAILED`, `NOT_FOUND`, `UIDVALIDITY_CHANGED`, `CAPABILITY_UNSUPPORTED`, `PERMISSION_DENIED`, `SIZE_LIMIT`, `TIMEOUT`, `RATE_LIMITED`, `CONFIG_ERROR`, `PROTOCOL_ERROR`, `CONNECTION_FAILED`, `INVALID_ARGUMENT`.',
    '',
  ];
  for (const tool of TOOLS) {
    lines.push(`## ${tool.name}`, '');
    lines.push(tool.title, '');
    lines.push(tool.description, '');
    lines.push(
      `Annotations: readOnlyHint=${tool.annotations.readOnlyHint}, destructiveHint=${tool.annotations.destructiveHint}, idempotentHint=${tool.annotations.idempotentHint}, openWorldHint=${tool.annotations.openWorldHint}.`,
      '',
    );
    lines.push('### Arguments', '');
    const args = describeInput(tool.input);
    lines.push(args.length > 0 ? args.join('\n') : '- None.', '');
    lines.push('### Examples', '');
    for (const example of tool.examples) {
      lines.push('```json', example, '```', '');
    }
  }
  return `${lines.join('\n')}\n`;
}

const check = process.argv.includes('--check');
const markdown = renderToolsMarkdown();
if (check) {
  const current = await import('node:fs').then((fs) => fs.readFileSync(target, 'utf8'));
  if (current !== markdown) {
    process.stderr.write('docs/TOOLS.md is out of date. Run npm run docs:tools.\n');
    process.exit(1);
  }
} else {
  writeFileSync(target, markdown);
  process.stdout.write(`Wrote ${target.pathname}\n`);
}
