import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] === 'bun' ? 'bun' : 'node';
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
  const shim = path.join(dir, 'node_modules', '.bin', 'mail-mcp');
  if (mode === 'node') {
    await exercise('npx', ['--yes', '--package', tarball, 'mail-mcp'], dir);
    const prefix = path.join(dir, 'global');
    execFileSync('npm', ['install', '-g', '--prefix', prefix, tarball], { stdio: 'inherit' });
    await exercise(path.join(prefix, 'bin', 'mail-mcp'), [], dir);
    await exercise(shim, [], dir);
  } else {
    const bun = process.env.BUN_BIN || 'bun';
    await exercise(bun, ['x', '--bun', 'mail-mcp'], dir);
  }
  process.stdout.write(`pack smoke ok (${mode})\n`);
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(tarball, { force: true });
}

async function exercise(command, args, cwd) {
  const version = execFileSync(command, [...args, '--version'], {
    cwd,
    encoding: 'utf8',
    env: process.env,
  });
  if (!/mail-mcp \d+\.\d+\.\d+/.test(version)) {
    throw new Error(`${command} ${args.join(' ')} --version printed ${JSON.stringify(version)}`);
  }
  const transport = new StdioClientTransport({
    command,
    args: [...args, '--log-level', 'silent'],
    cwd,
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
  if (!listed.tools.some((tool) => tool.name === 'mail_list_accounts')) {
    throw new Error(`${command} did not list mail_list_accounts`);
  }
  const result = await client.callTool({ name: 'mail_list_accounts', arguments: {} });
  if (result.isError) {
    throw new Error(`${command} mail_list_accounts failed: ${JSON.stringify(result.content)}`);
  }
  const accounts = result.structuredContent?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error(`${command} mail_list_accounts returned no accounts`);
  }
  const encoded = JSON.stringify(result.structuredContent);
  if (encoded.includes('secret')) {
    throw new Error(`${command} leaked a secret in mail_list_accounts`);
  }
  await client.close();
}
