import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/log.js';
import { startHttpServer } from '../../src/http.js';
import { createMcpServer } from '../../src/server.js';
import { MailService } from '../../src/service/mail-service.js';
import type { SmtpSender } from '../../src/smtp/client.js';
import { simpleMessage, multipartMixed } from '../fixtures/messages.js';
import { appConfig } from '../support/config.js';
import { FakePool, FakeSession } from '../support/fake-session.js';

async function connected() {
  const session = new FakeSession([
    'IMAP4rev1',
    'MOVE',
    'UIDPLUS',
    'SORT',
    'IDLE',
    'QUOTA',
    'NAMESPACE',
    'ID',
    'CONDSTORE',
    'THREAD',
    'X-GM-EXT-1',
  ]);
  await session.append('INBOX', simpleMessage({ subject: 'Hello', text: 'Body text' }), ['\\Seen']);
  await session.append('INBOX', multipartMixed, []);
  const dir = mkdtempSync(path.join(tmpdir(), 'mail-mcp-save-'));
  const mail = new MailService({
    config: appConfig({ allowPermanentDelete: true }, { attachmentsDir: dir }),
    pool: new FakePool(session),
    logger: createLogger({ level: 'silent' }),
    smtpFactory: async (): Promise<SmtpSender> => ({
      verify: async () => undefined,
      send: async (input) => ({
        accepted: input.envelope.to,
        rejected: [],
        pending: [],
        response: '250 ok',
        messageId: '<sent@example.com>',
      }),
      close() {
        return undefined;
      },
    }),
  });
  const server = createMcpServer(mail);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'unit', version: '0' });
  await client.connect(clientTransport);
  return { client, mail, session, dir, server };
}

describe('MCP session over an in-memory transport', () => {
  it('calls the tool surface, a resource, and both prompts', async () => {
    const { client, dir } = await connected();
    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(30);
    const call = (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args });

    const accounts = await call('mail_list_accounts');
    if (accounts.isError) {
      throw new Error(JSON.stringify(accounts.content));
    }
    expect((await call('mail_verify_connection', { smtp: true, imap: true })).isError).toBeFalsy();
    expect((await call('mail_get_capabilities')).isError).toBeFalsy();
    expect((await call('mail_get_namespaces')).isError).toBeFalsy();
    expect((await call('mail_get_quota')).isError).toBeFalsy();
    expect((await call('mail_get_server_id')).isError).toBeFalsy();
    expect((await call('mail_list_mailboxes')).isError).toBeFalsy();
    expect((await call('mail_get_mailbox_tree')).isError).toBeFalsy();
    expect((await call('mail_get_mailbox_status', { mailbox: 'INBOX' })).isError).toBeFalsy();
    expect((await call('mail_create_mailbox', { mailbox: 'Projects/A' })).isError).toBeFalsy();
    expect(
      (await call('mail_rename_mailbox', { mailbox: 'Projects/A', newName: 'Projects/B' })).isError,
    ).toBeFalsy();
    expect((await call('mail_subscribe_mailbox', { mailbox: 'Projects/B' })).isError).toBeFalsy();
    expect((await call('mail_unsubscribe_mailbox', { mailbox: 'Projects/B' })).isError).toBeFalsy();
    expect((await call('mail_list_subscribed')).isError).toBeFalsy();
    expect((await call('mail_resolve_special_use')).isError).toBeFalsy();
    const listed = await call('mail_list_messages', { mailbox: 'INBOX', limit: 5 });
    expect(listed.isError).toBeFalsy();
    expect(
      (await call('mail_search_messages', { mailbox: 'INBOX', search: { subject: 'Hello' } }))
        .isError,
    ).toBeFalsy();
    expect(
      (await call('mail_get_message', { mailbox: 'INBOX', uid: 1, maxBodyChars: 20 })).isError,
    ).toBeFalsy();
    expect(
      (await call('mail_get_message', { mailbox: 'INBOX', uid: 1, parts: ['1'] })).isError,
    ).toBeFalsy();
    expect((await call('mail_get_raw_message', { mailbox: 'INBOX', uid: 1 })).isError).toBeFalsy();
    expect((await call('mail_get_headers', { mailbox: 'INBOX', uid: 1 })).isError).toBeFalsy();
    expect(
      (await call('mail_get_message_part', { mailbox: 'INBOX', uid: 1, partId: '1' })).isError,
    ).toBeFalsy();
    expect(
      (
        await call('mail_download_attachment', {
          mailbox: 'INBOX',
          uid: 2,
          filename: 'notes.pdf',
          savePath: path.join(dir, 'notes.pdf'),
        })
      ).isError,
    ).toBeFalsy();
    expect((await call('mail_list_threads', { mailbox: 'INBOX', limit: 10 })).isError).toBeFalsy();
    expect(
      (
        await call('mail_set_flags', {
          mailbox: 'INBOX',
          uids: [1],
          flags: ['\\Flagged'],
          operation: 'add',
          unchangedSince: '1',
        })
      ).isError,
    ).toBeFalsy();
    expect(
      (await call('mail_copy_messages', { mailbox: 'INBOX', uids: [1], destination: 'Sent' }))
        .isError,
    ).toBeFalsy();
    expect(
      (await call('mail_move_messages', { mailbox: 'INBOX', uids: [1], destination: 'Archive' }))
        .isError,
    ).toBeFalsy();
    expect(
      (
        await call('mail_append_message', {
          mailbox: 'INBOX',
          to: ['ada@example.com'],
          subject: 'N',
          text: 't',
        })
      ).isError,
    ).toBeFalsy();
    expect(
      (
        await call('mail_set_labels', {
          mailbox: 'INBOX',
          uids: [2],
          labels: ['Work'],
          operation: 'add',
        })
      ).isError,
    ).toBeFalsy();
    expect(
      (
        await call('mail_bulk_modify', {
          mailbox: 'INBOX',
          uids: [2],
          action: 'removeFlags',
          flags: ['\\Seen'],
        })
      ).isError,
    ).toBeFalsy();
    const draft = await call('mail_create_draft', {
      subject: 'D',
      text: 'draft body',
      to: ['ada@example.com'],
    });
    expect(draft.isError).toBeFalsy();
    const draftUid = Number((draft.structuredContent as { uid?: number }).uid);
    expect(
      (await call('mail_update_draft', { uid: draftUid, subject: 'D2', text: 'next' })).isError,
    ).toBeFalsy();
    expect(
      (
        await call('mail_send_message', {
          to: ['ada@example.com'],
          subject: 'S',
          text: 'hi',
          readReceipt: true,
          priority: 'high',
        })
      ).isError,
    ).toBeFalsy();
    expect(
      (await call('mail_reply_message', { mailbox: 'INBOX', uid: 2, text: 're', replyAll: true }))
        .isError,
    ).toBeFalsy();
    expect(
      (
        await call('mail_forward_message', {
          mailbox: 'INBOX',
          uid: 2,
          to: ['bea@example.com'],
          includeAttachments: true,
        })
      ).isError,
    ).toBeFalsy();
    expect((await call('mail_verify_smtp')).isError).toBeFalsy();
    expect((await call('mail_wait_for_changes', { timeoutMs: 1000 })).isError).toBeFalsy();
    const earlyResource = await client.readResource({ uri: 'mail://work/INBOX/2' });
    expect(earlyResource.contents.length).toBeGreaterThan(0);
    expect(
      (await call('mail_delete_messages', { mailbox: 'INBOX', uids: [2] })).isError,
    ).toBeFalsy();
    expect((await call('mail_expunge_mailbox', { mailbox: 'Trash' })).isError).toBeFalsy();
    expect((await call('mail_delete_mailbox', { mailbox: 'Projects/B' })).isError).toBeFalsy();
    const bad = await call('mail_get_capabilities', { account: 'nope' });
    expect(bad.isError).toBe(true);

    const prompts = await client.listPrompts();
    expect(prompts.prompts).toHaveLength(2);
    const summary = await client.getPrompt({ name: 'summarise_inbox', arguments: { limit: '5' } });
    expect(summary.messages[0]?.content).toBeTruthy();
    const reply = await client.getPrompt({
      name: 'draft_reply',
      arguments: { mailbox: 'INBOX', uid: '2', instruction: 'Be brief' },
    });
    expect(JSON.stringify(reply)).toContain('INBOX');
    const resource = await client.readResource({ uri: 'mail://accounts' });
    const first = resource.contents[0];
    expect(first && 'text' in first ? first.text : '').toContain('work');
    await client.close();
  });
});

describe('HTTP transport', () => {
  it('answers a health check and an initialize request', async () => {
    const session = new FakeSession();
    const mail = new MailService({
      config: appConfig(),
      pool: new FakePool(session),
      logger: createLogger({ level: 'silent' }),
      smtpFactory: async () => ({
        verify: async () => undefined,
        send: async () => ({ accepted: [], rejected: [], pending: [], response: '' }),
        close() {
          return undefined;
        },
      }),
    });
    const http = await startHttpServer({
      service: mail,
      logger: createLogger({ level: 'silent' }),
      host: '127.0.0.1',
      port: 0,
    });
    const health = await fetch(http.url.replace(/\/mcp$/, '/health'));
    expect(health.status).toBe(200);
    const missing = await fetch(http.url.replace(/\/mcp$/, '/nope'));
    expect(missing.status).toBe(404);
    const init = await fetch(http.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'http-test', version: '0' },
        },
      }),
    });
    expect(init.status).toBeLessThan(500);
    const sessionHeader = init.headers.get('mcp-session-id');
    await init.text();
    if (sessionHeader) {
      const follow = await fetch(http.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionHeader,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      await follow.text();
    }
    const notInit = await fetch(http.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    });
    expect(notInit.status).toBe(400);
    await notInit.text();
    const denied = await fetch(http.url, { method: 'PUT' });
    expect([400, 405]).toContain(denied.status);
    await http.close();
    await mail.close();
  });
});
