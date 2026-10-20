import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface DovecotEndpoints {
  host: string;
  imapPort: number;
  imapsPort: number;
  noUidPlusPort: number;
  noIdlePort: number;
  user: string;
  password: string;
  email: string;
  caFile: string;
}

const DEFAULTS: DovecotEndpoints = {
  host: process.env.MAIL_DOVECOT_HOST ?? '127.0.0.1',
  imapPort: Number(process.env.MAIL_DOVECOT_IMAP_PORT ?? 1143),
  imapsPort: Number(process.env.MAIL_DOVECOT_IMAPS_PORT ?? 1993),
  noUidPlusPort: Number(process.env.MAIL_DOVECOT_NOUIDPLUS_PORT ?? 2143),
  noIdlePort: Number(process.env.MAIL_DOVECOT_NOIDLE_PORT ?? 2144),
  user: process.env.MAIL_DOVECOT_USER ?? 'user',
  password: process.env.MAIL_DOVECOT_PASSWORD ?? 'secret',
  email: process.env.MAIL_DOVECOT_EMAIL ?? 'user@example.com',
  caFile: path.join(root, 'test/fixtures/certs/dovecot-cert.pem'),
};

export async function ensureDovecot(): Promise<DovecotEndpoints> {
  if (await portOpen(DEFAULTS.host, DEFAULTS.imapPort)) {
    await waitFor(DEFAULTS.host, DEFAULTS.noUidPlusPort);
    await waitFor(DEFAULTS.host, DEFAULTS.noIdlePort);
    return DEFAULTS;
  }
  if (process.env.MAIL_DOVECOT_HOST) {
    throw new Error(
      `Dovecot is not accepting connections on ${DEFAULTS.host}:${DEFAULTS.imapPort}`,
    );
  }
  await exec(
    'docker',
    ['build', '-f', 'docker/dovecot/Dockerfile', '-t', 'mail-mcp-dovecot', '.'],
    {
      cwd: root,
    },
  );
  await start('mail-mcp-dovecot-full', DEFAULTS.imapPort, DEFAULTS.imapsPort, '');
  await start('mail-mcp-dovecot-nouidplus', DEFAULTS.noUidPlusPort, 0, '-UIDPLUS');
  await start('mail-mcp-dovecot-noidle', DEFAULTS.noIdlePort, 0, '-IDLE');
  await waitFor(DEFAULTS.host, DEFAULTS.imapPort);
  await waitFor(DEFAULTS.host, DEFAULTS.noUidPlusPort);
  await waitFor(DEFAULTS.host, DEFAULTS.noIdlePort);
  return DEFAULTS;
}

async function start(
  name: string,
  imapPort: number,
  imapsPort: number,
  remove: string,
): Promise<void> {
  await exec('docker', ['rm', '-f', name]).catch(() => undefined);
  const args = ['run', '-d', '--name', name, '-p', `${imapPort}:143`];
  if (imapsPort > 0) {
    args.push('-p', `${imapsPort}:993`);
  }
  if (remove) {
    args.push('-e', `IMAP_CAPABILITY_REMOVE=${remove}`);
  }
  args.push('mail-mcp-dovecot');
  await exec('docker', args);
}

async function waitFor(host: string, port: number): Promise<void> {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (await portOpen(host, port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Dovecot did not open ${host}:${port}`);
}

function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (open: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
