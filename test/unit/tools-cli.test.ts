import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { TOOLS } from '../../src/tools/catalog.js';
import { toolsForService } from '../../src/tools/register.js';
import { renderToolText } from '../../src/tools/render.js';
import { helpText, parseArgs, run, shutdownActive } from '../../src/cli.js';
import { MailService } from '../../src/service/mail-service.js';
import { appConfig } from '../support/config.js';
import { FakePool, FakeSession } from '../support/fake-session.js';
import { createLogger } from '../../src/log.js';
import type { SmtpSender } from '../../src/smtp/client.js';

function described(schema: ZodType): boolean {
  if (schema.description) {
    return true;
  }
  const unwrap = (schema as { unwrap?: () => ZodType }).unwrap;
  if (typeof unwrap === 'function') {
    const inner = unwrap.call(schema) as ZodType;
    if (inner.description) {
      return true;
    }
    const element = (inner as { element?: ZodType }).element;
    if (element?.description) {
      return true;
    }
  }
  const element = (schema as { element?: ZodType }).element;
  return Boolean(element?.description);
}

function walk(
  schema: ZodType,
  pathName: string,
  missing: string[],
  seen = new Set<ZodType>(),
): void {
  if (seen.has(schema)) {
    return;
  }
  seen.add(schema);
  const name = schema.constructor.name;
  const unwrap = (schema as { unwrap?: () => ZodType }).unwrap;
  if (unwrap && ['ZodOptional', 'ZodDefault', 'ZodNullable', 'ZodLazy'].includes(name)) {
    walk(unwrap.call(schema) as ZodType, pathName, missing, seen);
    return;
  }
  const element = (schema as { element?: ZodType }).element;
  if (element) {
    walk(element, `${pathName}[]`, missing, seen);
    return;
  }
  const shape = (schema as { shape?: Record<string, ZodType> }).shape;
  if (shape) {
    for (const [key, child] of Object.entries(shape)) {
      if (!described(child)) {
        missing.push(`${pathName}.${key}`);
      }
      walk(child, `${pathName}.${key}`, missing, seen);
    }
  }
}

describe('tool catalog', () => {
  it('gives every tool a long description, annotations, and described inputs', () => {
    expect(TOOLS.length).toBeGreaterThanOrEqual(40);
    const names = new Set<string>();
    const missing: string[] = [];
    for (const tool of TOOLS) {
      expect(names.has(tool.name), tool.name).toBe(false);
      names.add(tool.name);
      expect(tool.name.startsWith('mail_')).toBe(true);
      expect(tool.description.length).toBeGreaterThan(120);
      expect(tool.annotations.openWorldHint).toBeTypeOf('boolean');
      expect(tool.examples.length).toBeGreaterThan(0);
      if (!tool.input.description && Object.keys(tool.input.shape).length > 0) {
        walk(tool.input, tool.name, missing);
      }
      for (const example of tool.examples) {
        const parsed = tool.input.safeParse(JSON.parse(example));
        expect(
          parsed.success,
          `${tool.name} example ${example} ${parsed.success ? '' : JSON.stringify(parsed.error?.issues)}`,
        ).toBe(true);
      }
    }
    expect(missing).toEqual([]);
  });

  it('hides mutating tools when every account is read-only', () => {
    const smtp: SmtpSender = {
      verify: async () => undefined,
      send: async () => ({ accepted: [], rejected: [], pending: [], response: '' }),
      close: () => undefined,
    };
    const mail = new MailService({
      config: appConfig({ readOnly: true, allowSend: false, allowDelete: false }),
      pool: new FakePool(new FakeSession()),
      smtpFactory: async () => smtp,
      logger: createLogger({ level: 'silent' }),
    });
    const names = toolsForService(mail).map((tool) => tool.name);
    expect(names).toContain('mail_list_messages');
    expect(names).not.toContain('mail_send_message');
    expect(names).not.toContain('mail_delete_messages');
  });

  it('renders long base64 payloads as placeholders in the text view', () => {
    const text = renderToolText({ account: 'work', contentBase64: 'A'.repeat(800), ok: true });
    expect(text).toContain('Account: work');
    expect(text).not.toContain('A'.repeat(800));
  });
});

describe('cli', () => {
  it('parses help, version, and rejects unknown flags', async () => {
    expect(helpText()).toContain('mail-mcp');
    expect(parseArgs(['node', 'mail-mcp', '--help']).help).toBe(true);
    expect(parseArgs(['node', 'mail-mcp', '--http', '--port', '4000']).port).toBe(4000);
    expect(() => parseArgs(['node', 'mail-mcp', '--nope'])).toThrow(/Unknown argument/);
    expect(await run(['node', 'mail-mcp', '--help'])).toBe(0);
    expect(await run(['node', 'mail-mcp', '--version'])).toBe(0);
    expect(await run(['node', 'mail-mcp', '--bogus'])).toBe(1);
    expect(await run(['node', 'mail-mcp', '--check'], {})).toBe(1);
    const dir = mkdtempSync(path.join(tmpdir(), 'mail-mcp-check-'));
    const config = path.join(dir, 'mail.json');
    writeFileSync(
      config,
      JSON.stringify({
        accounts: {
          local: {
            email: 'user@example.com',
            user: 'user',
            password: 'secret',
            imap: {
              host: '127.0.0.1',
              port: 1,
              secure: false,
              starttls: 'disabled',
              timeoutMs: 500,
            },
          },
        },
      }),
    );
    expect(
      await run(['node', 'mail-mcp', '--check', '--config', config, '--log-level', 'silent']),
    ).toBe(1);
  });

  it('starts the http transport on an ephemeral port and stops it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mail-mcp-cli-'));
    const config = path.join(dir, 'mail.json');
    writeFileSync(
      config,
      JSON.stringify({
        accounts: {
          local: {
            email: 'user@example.com',
            user: 'user',
            password: 'secret',
            readOnly: true,
            allowSend: false,
            imap: { host: '127.0.0.1', port: 1, secure: false, starttls: 'disabled' },
          },
        },
      }),
    );
    const code = await run([
      'node',
      'mail-mcp',
      '--http',
      '--port',
      '0',
      '--host',
      '127.0.0.1',
      '--config',
      config,
      '--log-level',
      'silent',
    ]);
    expect(code).toBe(0);
    await shutdownActive();
    const stdio = await run(['node', 'mail-mcp', '--config', config, '--log-level', 'silent']);
    expect(stdio).toBe(0);
    await shutdownActive();
  });
});
