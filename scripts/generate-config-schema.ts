import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import { renderConfigSchema } from '../src/config/json-schema.js';

const target = fileURLToPath(new URL('../schema/config.schema.json', import.meta.url));
const text = await prettier.format(renderConfigSchema(), { filepath: target });
if (process.argv.includes('--check')) {
  const current = await import('node:fs').then((fs) => fs.readFileSync(target, 'utf8'));
  if (current !== text) {
    process.stderr.write('schema/config.schema.json is out of date.\n');
    process.exit(1);
  }
} else {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
  process.stdout.write(`Wrote ${target}\n`);
}
