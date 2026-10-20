import { toJSONSchema } from 'zod';
import { configFileSchema } from './schema.js';

/** JSON Schema (draft-07) for a mail-mcp configuration file. */
export function renderConfigSchema(): string {
  const schema = toJSONSchema(configFileSchema, { target: 'draft-7' });
  return `${JSON.stringify(schema, null, 2)}\n`;
}
