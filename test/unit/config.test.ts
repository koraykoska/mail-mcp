import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { PROVIDERS } from '../../src/config/providers.js';
import { MailError } from '../../src/errors.js';

describe('loadConfig', () => {
  it('loads a single account from the environment', () => {
    const config = loadConfig({
      env: {
        MAIL_IMAP_HOST: 'imap.example.com',
        MAIL_IMAP_PORT: '143',
        MAIL_IMAP_SECURE: 'false',
        MAIL_IMAP_STARTTLS: 'required',
        MAIL_SMTP_HOST: 'smtp.example.com',
        MAIL_SMTP_PORT: '587',
        MAIL_SMTP_SECURE: 'false',
        MAIL_USER: 'ada@example.com',
        MAIL_PASSWORD: 'app-secret',
        MAIL_FROM: 'ada@example.com',
        MAIL_READONLY: 'false',
        MAIL_ALLOW_PERMANENT_DELETE: 'false',
        MAIL_RECIPIENT_DOMAINS: 'example.com, example.org',
        MAIL_LOG_LEVEL: 'debug',
      },
    });
    expect(config.defaultAccount).toBe('default');
    const account = config.accounts.default;
    expect(account?.imap.starttls).toBe('required');
    expect(account?.imap.secure).toBe(false);
    expect(account?.smtp?.port).toBe(587);
    expect(account?.recipientDomainAllowList).toEqual(['example.com', 'example.org']);
    expect(config.secrets).toContain('app-secret');
    expect(config.logLevel).toBe('debug');
  });

  it('applies provider presets and oauth fields from jsonc', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mail-mcp-'));
    const file = path.join(dir, 'mail.jsonc');
    writeFileSync(
      file,
      `{
        // two accounts
        "defaultAccount": "personal",
        "accounts": {
          "personal": {
            "provider": "gmail",
            "email": "ada@gmail.com",
            "auth": {
              "type": "oauth2",
              "refreshToken": "\${GMAIL_REFRESH}",
              "clientId": "id",
              "clientSecret": "\${GMAIL_SECRET:-fallback-secret}"
            }
          },
          "bridge": {
            "provider": "proton-bridge",
            "user": "ada@proton.me",
            "password": "bridge-pass",
            "readOnly": true
          }
        }
      }`,
    );
    const config = loadConfig({
      configPath: file,
      env: { GMAIL_REFRESH: 'refresh-token' },
    });
    expect(config.accounts.personal?.imap.host).toBe(PROVIDERS.gmail.imap.host);
    expect(config.accounts.personal?.appendSent).toBe('auto');
    expect(config.accounts.personal?.auth).toMatchObject({
      type: 'oauth2',
      clientSecret: 'fallback-secret',
    });
    expect(config.accounts.bridge?.imap.port).toBe(1143);
    expect(config.accounts.bridge?.imap.starttls).toBe('required');
    expect(config.accounts.bridge?.readOnly).toBe(true);
    expect(config.secrets.join(' ')).not.toContain('undefined');
  });

  it('rejects missing accounts, bad booleans, and readOnly plus permanent delete', () => {
    expect(() => loadConfig({ env: {} })).toThrow(MailError);
    expect(() =>
      loadConfig({
        env: {
          MAIL_IMAP_HOST: 'imap.example.com',
          MAIL_USER: 'a@b.c',
          MAIL_PASSWORD: 'x',
          MAIL_READONLY: 'sometimes',
        },
      }),
    ).toThrow(/boolean/);
    const dir = mkdtempSync(path.join(tmpdir(), 'mail-mcp-bad-'));
    const file = path.join(dir, 'bad.json');
    writeFileSync(
      file,
      JSON.stringify({
        accounts: {
          a: {
            provider: 'generic',
            email: 'a@example.com',
            password: 'x',
            imap: { host: 'imap.example.com' },
            readOnly: true,
            allowPermanentDelete: true,
          },
        },
      }),
    );
    expect(() => loadConfig({ configPath: file, env: {} })).toThrow(/readOnly/);
  });

  it('accepts xoauth2, explicit cleartext, and rejects incomplete oauth', () => {
    const xoauth = loadConfig({
      env: {
        MAIL_IMAP_HOST: 'imap.example.com',
        MAIL_USER: 'ada@example.com',
        MAIL_AUTH_TYPE: 'xoauth2',
        MAIL_ACCESS_TOKEN: 'token-value',
        MAIL_IMAP_SECURE: 'false',
        MAIL_IMAP_STARTTLS: 'disabled',
        MAIL_SMTP_HOST: 'smtp.example.com',
        MAIL_SMTP_SECURE: 'false',
        MAIL_SMTP_STARTTLS: 'optional',
        MAIL_TLS_CA_FILE: '/tmp/ca.pem',
        MAIL_TLS_SERVERNAME: 'imap.example.com',
        MAIL_POOL_SIZE: '3',
        MAIL_APPEND_SENT: 'false',
      },
    });
    expect(xoauth.accounts.default?.auth).toEqual({ type: 'xoauth2', accessToken: 'token-value' });
    expect(xoauth.accounts.default?.imap.starttls).toBe('disabled');
    expect(xoauth.poolSize).toBe(3);
    expect(() =>
      loadConfig({
        env: {
          MAIL_IMAP_HOST: 'imap.example.com',
          MAIL_USER: 'ada@example.com',
          MAIL_AUTH_TYPE: 'oauth2',
          MAIL_OAUTH_REFRESH_TOKEN: 'r',
        },
      }),
    ).toThrow(/clientId|clientSecret|refreshToken/);
    expect(() =>
      loadConfig({
        env: {
          MAIL_IMAP_HOST: 'imap.example.com',
          MAIL_USER: 'ada@example.com',
          MAIL_PASSWORD: 'x',
          MAIL_LOG_LEVEL: 'loud',
        },
      }),
    ).toThrow(/MAIL_LOG_LEVEL/);
    expect(() =>
      loadConfig({
        env: {
          MAIL_IMAP_HOST: 'imap.example.com',
          MAIL_USER: 'ada@example.com',
          MAIL_PASSWORD: 'x',
          MAIL_PROVIDER: 'nope',
        },
      }),
    ).toThrow(/MAIL_PROVIDER/);
  });

  it('requires defaultAccount when several accounts are present', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mail-mcp-multi-'));
    const file = path.join(dir, 'multi.json');
    writeFileSync(
      file,
      JSON.stringify({
        accounts: {
          a: { email: 'a@example.com', password: 'x', imap: { host: 'h1' } },
          b: { email: 'b@example.com', password: 'y', imap: { host: 'h2' } },
        },
      }),
    );
    expect(() => loadConfig({ configPath: file, env: {} })).toThrow(/defaultAccount/);
  });

  it('resolves identities and rejects two defaults', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mail-mcp-id-'));
    const file = path.join(dir, 'id.json');
    writeFileSync(
      file,
      JSON.stringify({
        accounts: {
          a: {
            email: 'a@example.com',
            password: 'x',
            imap: { host: 'imap.example.com' },
            identities: [
              { email: 'a@example.com', name: 'Ada', replyTo: 'ada@example.com' },
              { id: 'other', email: 'alias@example.com', default: true },
            ],
          },
        },
      }),
    );
    const config = loadConfig({ configPath: file, env: {} });
    expect(config.accounts.a?.identities[0]?.replyTo).toBe('ada@example.com');
    expect(config.accounts.a?.identities.find((item) => item.default)?.id).toBe('other');
    writeFileSync(
      file,
      JSON.stringify({
        accounts: {
          a: {
            email: 'a@example.com',
            password: 'x',
            imap: { host: 'imap.example.com' },
            identities: [
              { email: 'a@example.com', default: true },
              { email: 'b@example.com', default: true },
            ],
          },
        },
      }),
    );
    expect(() => loadConfig({ configPath: file, env: {} })).toThrow(/default identity/);
  });
});
