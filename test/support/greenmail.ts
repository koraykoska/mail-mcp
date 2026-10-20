import { connect } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface GreenMailEndpoints {
  host: string;
  imapPort: number;
  imapsPort: number;
  smtpPort: number;
  smtpsPort: number;
  user: string;
  password: string;
  email: string;
}

const DEFAULTS: GreenMailEndpoints = {
  host: process.env.MAIL_IT_IMAP_HOST ?? '127.0.0.1',
  imapPort: Number(process.env.MAIL_IT_IMAP_PORT ?? 3143),
  imapsPort: Number(process.env.MAIL_IT_IMAPS_PORT ?? 3993),
  smtpPort: Number(process.env.MAIL_IT_SMTP_PORT ?? 3025),
  smtpsPort: Number(process.env.MAIL_IT_SMTPS_PORT ?? 3465),
  user: process.env.MAIL_IT_USER ?? 'user',
  password: process.env.MAIL_IT_PASSWORD ?? 'secret',
  email: process.env.MAIL_IT_EMAIL ?? 'user@example.com',
};

export async function ensureGreenMail(): Promise<GreenMailEndpoints> {
  // GreenMail 2.1.14 accepts TCP before the IMAP banner is ready and then
  // closes that socket. Wait for the greeting, not merely an open port.
  if (
    await waitForImap(
      DEFAULTS.host,
      DEFAULTS.imapPort,
      process.env.MAIL_IT_IMAP_HOST ? 30_000 : 500,
    )
  ) {
    return DEFAULTS;
  }
  if (process.env.MAIL_IT_IMAP_HOST) {
    throw new Error(
      `IMAP test server is not accepting connections on ${DEFAULTS.host}:${DEFAULTS.imapPort}`,
    );
  }
  await exec('docker', [
    'run',
    '-d',
    '--name',
    'mail-mcp-greenmail',
    '-p',
    '3025:3025',
    '-p',
    '3143:3143',
    '-p',
    '3465:3465',
    '-p',
    '3993:3993',
    '-e',
    'GREENMAIL_OPTS=-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=user:secret@example.com',
    'greenmail/standalone:2.1.14',
  ]);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await imapGreeting(DEFAULTS.host, DEFAULTS.imapPort)) {
      return DEFAULTS;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('GreenMail did not open port 3143');
}

async function waitForImap(host: string, port: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  do {
    if (await imapGreeting(host, port)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return false;
}

function imapGreeting(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let banner = '';
    const finish = (ready: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(800);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      banner += chunk;
      if (banner.includes('* OK')) {
        finish(true);
      }
    });
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(banner.includes('* OK')));
  });
}
