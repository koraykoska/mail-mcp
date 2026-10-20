import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../../src/tools/catalog.js';

const bin = path.resolve('dist/cli.js');

describe('stdio MCP server', () => {
  it('lists every tool and calls a read-only tool', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mail-mcp-e2e-'));
    const config = path.join(dir, 'mail.json');
    writeFileSync(
      config,
      JSON.stringify({
        accounts: {
          local: {
            email: 'user@example.com',
            user: 'user',
            password: 'secret',
            imap: { host: '127.0.0.1', port: 1, secure: false, starttls: 'disabled' },
            allowPermanentDelete: true,
            allowDelete: true,
            allowSend: true,
          },
        },
      }),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin, '--config', config, '--log-level', 'silent'],
    });
    const client = new Client({ name: 'mail-mcp-e2e', version: '0.0.0' });
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    for (const tool of TOOLS) {
      expect(names, tool.name).toContain(tool.name);
      const remote = listed.tools.find((item) => item.name === tool.name);
      expect(remote?.description?.length ?? 0).toBeGreaterThan(80);
      expect(remote?.inputSchema.type).toBe('object');
    }
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name).sort()).toEqual([
      'draft_reply',
      'summarise_inbox',
    ]);
    const resources = await client.listResources();
    expect(resources.resources.some((resource) => resource.uri === 'mail://accounts')).toBe(true);
    const accounts = await client.callTool({ name: 'mail_list_accounts', arguments: {} });
    expect(accounts.isError).toBeFalsy();
    const structured = accounts.structuredContent as { accounts?: Array<{ id: string }> };
    expect(structured.accounts?.[0]?.id).toBe('local');
    const missing = await client.callTool({
      name: 'mail_get_capabilities',
      arguments: { account: 'missing' },
    });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.structuredContent)).toContain('INVALID_ARGUMENT');
    await client.close();
  });

  it('answers --help and --version on stdout', async () => {
    const help = await run([bin, '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage:');
    const version = await run([bin, '--version']);
    expect(version.code).toBe(0);
    expect(version.stdout).toMatch(/mail-mcp \d+\.\d+\.\d+/);
  });
});

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
