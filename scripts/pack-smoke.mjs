import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = process.argv[2] === 'bun' ? 'bun' : 'node';
const packJson = execFileSync('npm', ['pack', '--json', '--ignore-scripts'], {
  cwd: root,
  encoding: 'utf8',
});
const packed = JSON.parse(packJson);
const filename = packed[0]?.filename;
if (!filename) {
  throw new Error('npm pack did not produce a tarball');
}
const tarball = path.join(root, filename);
const dir = mkdtempSync(path.join(tmpdir(), 'mail-mcp-pack-'));
try {
  execFileSync('npm', ['init', '-y'], { cwd: dir, stdio: 'ignore' });
  execFileSync('npm', ['install', '--ignore-scripts', tarball], { cwd: dir, stdio: 'inherit' });
  const bin = path.join(dir, 'node_modules', 'mail-mcp', 'dist', 'cli.js');
  const command = runtime === 'bun' ? bunBin() : process.execPath;
  const version = execFileSync(command, [bin, '--version'], { encoding: 'utf8' });
  if (!/mail-mcp \d+\.\d+\.\d+/.test(version)) {
    throw new Error(`unexpected version output: ${version}`);
  }
  const transport = new StdioClientTransport({
    command,
    args: [bin, '--log-level', 'silent'],
    env: {
      ...process.env,
      MAIL_IMAP_HOST: '127.0.0.1',
      MAIL_IMAP_PORT: '993',
      MAIL_IMAP_SECURE: 'true',
      MAIL_USER: 'user@example.com',
      MAIL_PASSWORD: 'secret',
      MAIL_LOG_LEVEL: 'silent',
    },
  });
  const client = new Client({ name: 'pack-smoke', version: '0.0.0' });
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  if (!names.includes('mail_list_accounts') || !names.includes('mail_send_message')) {
    throw new Error(`MCP handshake did not list tools: ${names.join(', ')}`);
  }
  await client.close();
  process.stdout.write(`pack smoke ok (${runtime})\n`);
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(tarball, { force: true });
}

function bunBin() {
  return process.env.BUN_BIN || 'bun';
}
