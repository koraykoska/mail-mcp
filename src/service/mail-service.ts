import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MailError } from '../errors.js';
import type { AppConfig, Identity, ResolvedAccount } from '../config/schema.js';
import { requireAccount } from '../config/load.js';
import type { Logger } from '../log.js';
import { SlidingWindowLimiter } from '../rate-limit.js';
import { assertMutation, assertRecipients } from '../safety.js';
import { decodeCursor, encodeCursor, clampLimit } from '../pagination.js';
import type { ImapPool } from '../imap/pool.js';
import { assertSearchCapabilities, compileSearch, type SearchCriteria } from '../imap/search.js';
import { sortMessages, type SortKey, type SortableMessage } from '../imap/sort.js';
import { resolveSpecialUse, type ResolvedSpecialUse } from '../imap/special-use.js';
import { normalizeFlags } from '../imap/flags.js';
import type { ImapSession, MailboxInfo, MessageSummary, OpenMailbox } from '../imap/session.js';
import {
  formatAddress,
  parseAddress,
  parseAddressList,
  type MailAddress,
} from '../mime/address.js';
import {
  buildRawMessage,
  envelopeRecipients,
  type OutboundAttachment,
  type OutboundMessage,
} from '../mime/build.js';
import { capText, parseRawMessage, renderHtml, type ParsedMessage } from '../mime/parse.js';
import { headerValue, messageIds } from '../mime/headers.js';
import { buildReferences, forwardSubject, replySubject } from '../mime/subject.js';
import { flattenThread, threadMessages, type ThreadNode } from '../mime/thread.js';
import { ownAddressesOf, planReply, planReplyAll, quotePlain } from '../mime/reply.js';
import type { SmtpSender } from '../smtp/client.js';
import { withTimeout } from '../timeout.js';

export interface ServiceDeps {
  config: AppConfig;
  pool: ImapPool;
  smtpFactory: (account: ResolvedAccount) => Promise<SmtpSender>;
  logger: Logger;
  now?: () => number;
}

export class MailService {
  readonly config: AppConfig;
  private readonly pool: ImapPool;
  private readonly smtpFactory: (account: ResolvedAccount) => Promise<SmtpSender>;
  private readonly logger: Logger;
  private readonly limiter: SlidingWindowLimiter;
  private readonly specialCache = new Map<string, ResolvedSpecialUse>();

  constructor(deps: ServiceDeps) {
    this.config = deps.config;
    this.pool = deps.pool;
    this.smtpFactory = deps.smtpFactory;
    this.logger = deps.logger;
    this.limiter = new SlidingWindowLimiter(deps.now);
  }

  account(id?: string): ResolvedAccount {
    return requireAccount(this.config, id);
  }

  listAccounts(): Array<Record<string, unknown>> {
    return Object.values(this.config.accounts).map((account) => ({
      id: account.id,
      email: account.email,
      provider: account.provider,
      default: account.id === this.config.defaultAccount,
      readOnly: account.readOnly,
      allowSend: account.allowSend,
      allowDelete: account.allowDelete,
      allowPermanentDelete: account.allowPermanentDelete,
      hasSmtp: Boolean(account.smtp),
      identities: account.identities.map((identity) => ({
        id: identity.id,
        email: identity.email,
        name: identity.name,
        default: identity.default,
      })),
    }));
  }

  async verify(
    accountId: string | undefined,
    what: { imap?: boolean; smtp?: boolean },
  ): Promise<Record<string, unknown>> {
    const account = this.account(accountId);
    const checkImap = what.imap !== false;
    const checkSmtp = what.smtp !== false && Boolean(account.smtp);
    const imap = checkImap ? await this.probeImap(account) : { skipped: true };
    const smtp =
      what.smtp === false || !account.smtp ? { skipped: true } : await this.probeSmtp(account);
    const ok = isOk(imap) && isOk(smtp);
    return {
      ok,
      account: account.id,
      imap,
      smtp: checkSmtp || what.smtp ? smtp : { skipped: true },
    };
  }

  async capabilities(accountId?: string): Promise<Record<string, unknown>> {
    const account = this.account(accountId);
    return this.withImap(account, async (session) => ({
      ok: true as const,
      account: account.id,
      capabilities: [...session.capabilities.keys()].sort(),
      greeting: session.greeting() ?? null,
    }));
  }

  async namespaces(accountId?: string): Promise<Record<string, unknown>> {
    const account = this.account(accountId);
    return this.withImap(account, async (session) => ({
      ok: true as const,
      account: account.id,
      namespaces: await session.namespaces(),
    }));
  }

  async quota(accountId: string | undefined, mailbox?: string): Promise<Record<string, unknown>> {
    const account = this.account(accountId);
    return this.withImap(account, async (session) => {
      if (!session.hasCapability('QUOTA')) {
        throw new MailError(
          'CAPABILITY_UNSUPPORTED',
          'The server does not advertise the QUOTA extension.',
        );
      }
      const quota = await session.quota(mailbox);
      return { ok: true as const, account: account.id, quota };
    });
  }

  async serverId(accountId?: string): Promise<Record<string, unknown>> {
    const account = this.account(accountId);
    return this.withImap(account, async (session) => {
      if (!session.hasCapability('ID')) {
        throw new MailError(
          'CAPABILITY_UNSUPPORTED',
          'The server does not advertise the ID extension (RFC 2971).',
        );
      }
      return { ok: true as const, account: account.id, server: session.serverId() };
    });
  }

  async listMailboxes(
    accountId: string | undefined,
    subscribedOnly = false,
  ): Promise<Record<string, unknown>> {
    const account = this.account(accountId);
    return this.withImap(account, async (session) => {
      const mailboxes = await session.listMailboxes({ subscribedOnly });
      return { ok: true as const, account: account.id, mailboxes: mailboxes.map(publicMailbox) };
    });
  }

  async mailboxTree(accountId?: string): Promise<Record<string, unknown>> {
    const account = this.account(accountId);
    return this.withImap(account, async (session) => ({
      ok: true as const,
      account: account.id,
      tree: await session.listTree(),
    }));
  }

  async mailboxStatus(
    accountId: string | undefined,
    mailbox: string,
  ): Promise<Record<string, unknown>> {
    const account = this.account(accountId);
    return this.withImap(account, async (session) => ({
      ok: true as const,
      account: account.id,
      status: await session.status(mailbox),
    }));
  }

  async createMailbox(
    accountId: string | undefined,
    mailbox: string,
  ): Promise<Record<string, unknown>> {
    const account = this.account(accountId);
    assertMutation(account, 'mailbox-write');
    this.specialCache.delete(account.id);
    return this.withImap(account, async (session) => ({
      ok: true as const,
      account: account.id,
      ...(await session.createMailbox(mailbox)),
    }));
  }

  async renameMailbox(
    accountId: string | undefined,
    mailbox: string,
    newName: string,
  ): Promise<Record<string, unknown>> {
    const account = this.account(accountId);
    assertMutation(account, 'mailbox-write');
    this.specialCache.delete(account.id);
    return this.withImap(account, async (session) => {
      await session.renameMailbox(mailbox, newName);
      return { ok: true as const, account: account.id, mailbox, newName };
    });
  }

  async deleteMailbox(
    accountId: string | undefined,
    mailbox: string,
  ): Promise<Record<string, unknown>> {
    const account = this.account(accountId);
    assertMutation(account, 'delete');
    this.specialCache.delete(account.id);
    return this.withImap(account, async (session) => {
      await session.deleteMailbox(mailbox);
      return { ok: true as const, account: account.id, mailbox, deleted: true };
    });
  }

  async subscribe(
    accountId: string | undefined,
    mailbox: string,
    subscribed: boolean,
  ): Promise<Record<string, unknown>> {
    const account = this.account(accountId);
    assertMutation(account, 'mailbox-write');
    return this.withImap(account, async (session) => {
      if (subscribed) {
        await session.subscribe(mailbox);
      } else {
        await session.unsubscribe(mailbox);
      }
      return { ok: true as const, account: account.id, mailbox, subscribed };
    });
  }

  async specialUse(accountId?: string): Promise<Record<string, unknown>> {
    const account = this.account(accountId);
    return this.withImap(account, async (session) => ({
      ok: true as const,
      account: account.id,
      special: await this.special(account, session),
    }));
  }

  async listMessages(input: ListInput): Promise<Record<string, unknown>> {
    return this.queryMessages(input, false);
  }

  async searchMessages(input: ListInput): Promise<Record<string, unknown>> {
    if (!input.search || Object.keys(input.search).length === 0) {
      throw new MailError(
        'INVALID_ARGUMENT',
        'mail_search_messages requires a search object. Use mail_list_messages to page a mailbox.',
      );
    }
    return this.queryMessages(input, true);
  }

  async getMessage(input: GetMessageInput): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    return this.withMailbox(account, input.mailbox, 'read', async (box) => {
      this.assertUid(box, input.uidValidity);
      const summary = await this.requireSummary(box, input.uid);
      if (input.parts && input.parts.length > 0) {
        const structure = await box.fetchStructure(input.uid);
        const parts = await box.fetchParts(
          input.uid,
          input.parts.map((key) => ({
            key,
            maxLength: input.maxBodyChars ?? account.limits.maxBodyChars,
          })),
        );
        return {
          ok: true as const,
          account: account.id,
          mailbox: input.mailbox,
          uid: input.uid,
          uidValidity: box.uidValidity,
          flags: summary.flags,
          structure,
          parts: parts.map((part) => ({
            partId: part.partId,
            contentType: part.contentType ?? null,
            filename: part.filename ?? null,
            size: part.content.length,
            text: part.contentType?.startsWith('text/')
              ? capText(
                  part.content.toString('utf8'),
                  input.maxBodyChars ?? account.limits.maxBodyChars,
                ).text
              : undefined,
            contentBase64: part.contentType?.startsWith('text/')
              ? undefined
              : part.content.toString('base64'),
          })),
        };
      }
      if ((summary.size ?? 0) > account.limits.maxMessageBytes) {
        throw new MailError(
          'SIZE_LIMIT',
          `Message UID ${input.uid} is ${summary.size} bytes, over the maxMessageBytes limit of ${account.limits.maxMessageBytes}.`,
          'Pass parts to fetch specific MIME sections, or raise limits.maxMessageBytes.',
        );
      }
      const source = await box.fetchSource(input.uid);
      if (!source) {
        throw new MailError(
          'NOT_FOUND',
          `Message UID ${input.uid} was not found in ${input.mailbox}.`,
        );
      }
      const parsed = await parseRawMessage(source);
      const maxChars = input.maxBodyChars ?? account.limits.maxBodyChars;
      const text = capText(parsed.text, maxChars);
      const html = capText(parsed.html, maxChars);
      return {
        ok: true as const,
        account: account.id,
        mailbox: input.mailbox,
        uid: input.uid,
        uidValidity: box.uidValidity,
        flags: summary.flags,
        size: summary.size ?? source.length,
        internalDate: summary.internalDate ?? null,
        labels: summary.labels ?? [],
        threadId: summary.threadId ?? null,
        headers: publicHeaders(parsed),
        text: text.text ?? null,
        textTruncated: text.truncated,
        html: html.text ?? null,
        htmlTruncated: html.truncated,
        htmlAsText: parsed.html
          ? capText(parsed.htmlAsText ?? renderHtml(parsed.html), maxChars).text
          : null,
        attachments: parsed.attachments.map((attachment, index) => ({
          index,
          filename: attachment.filename ?? null,
          contentType: attachment.contentType,
          size: attachment.size,
          disposition: attachment.disposition ?? null,
          cid: attachment.cid ?? null,
          inline: attachment.inline,
        })),
      };
    });
  }

  async getSource(input: UidInput & { maxBytes?: number }): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    return this.withMailbox(account, input.mailbox, 'read', async (box) => {
      this.assertUid(box, input.uidValidity);
      const summary = await this.requireSummary(box, input.uid);
      const limit = input.maxBytes ?? account.limits.maxMessageBytes;
      if ((summary.size ?? 0) > limit) {
        throw new MailError(
          'SIZE_LIMIT',
          `Raw message is ${summary.size} bytes and the limit is ${limit}.`,
          'Use mail_get_message or mail_get_message_part instead of the full source.',
        );
      }
      const source = await box.fetchSource(input.uid);
      if (!source) {
        throw new MailError('NOT_FOUND', `Message UID ${input.uid} was not found.`);
      }
      return {
        ok: true as const,
        account: account.id,
        mailbox: input.mailbox,
        uid: input.uid,
        uidValidity: box.uidValidity,
        bytes: source.length,
        contentBase64: source.toString('base64'),
      };
    });
  }

  async getHeaders(input: UidInput): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    return this.withMailbox(account, input.mailbox, 'read', async (box) => {
      this.assertUid(box, input.uidValidity);
      const raw = await box.fetchHeaders(input.uid);
      if (!raw) {
        throw new MailError('NOT_FOUND', `Message UID ${input.uid} was not found.`);
      }
      const text = raw.toString('utf8');
      return {
        ok: true as const,
        account: account.id,
        mailbox: input.mailbox,
        uid: input.uid,
        uidValidity: box.uidValidity,
        raw:
          text.length > account.limits.maxBodyChars
            ? text.slice(0, account.limits.maxBodyChars)
            : text,
        truncated: text.length > account.limits.maxBodyChars,
      };
    });
  }

  async getPart(
    input: UidInput & { partId: string; maxBytes?: number },
  ): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    const maxBytes = input.maxBytes ?? account.limits.maxAttachmentBytes;
    return this.withMailbox(account, input.mailbox, 'read', async (box) => {
      this.assertUid(box, input.uidValidity);
      const parts = await box.fetchParts(input.uid, [{ key: input.partId, maxLength: maxBytes }]);
      const part = parts[0];
      if (!part) {
        throw new MailError(
          'NOT_FOUND',
          `Part "${input.partId}" was not found on UID ${input.uid}.`,
          'Part ids come from mail_get_message attachments or structure, for example "1" or "2.1".',
        );
      }
      const truncated = part.content.length >= maxBytes;
      const isText = (part.contentType ?? '').startsWith('text/');
      return {
        ok: true as const,
        account: account.id,
        mailbox: input.mailbox,
        uid: input.uid,
        partId: part.partId,
        contentType: part.contentType ?? 'application/octet-stream',
        filename: part.filename ?? null,
        bytes: part.content.length,
        truncated,
        text: isText ? part.content.toString('utf8') : null,
        contentBase64: isText ? null : part.content.toString('base64'),
      };
    });
  }

  async downloadAttachment(input: DownloadInput): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    const message = await this.loadParsed(account, input);
    const attachment = pickAttachment(message.parsed, input);
    if (!attachment.content) {
      throw new MailError('NOT_FOUND', 'The attachment had no body.');
    }
    const bytes = attachment.content.length;
    if (input.savePath) {
      const target = resolveSavePath(input.savePath, this.config.attachmentsDir);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, attachment.content);
      return {
        ok: true as const,
        account: account.id,
        mailbox: input.mailbox,
        uid: input.uid,
        filename: attachment.filename ?? null,
        contentType: attachment.contentType,
        bytes,
        savedPath: target,
      };
    }
    if (bytes > account.limits.maxAttachmentBytes) {
      throw new MailError(
        'SIZE_LIMIT',
        `Attachment is ${bytes} bytes, over the inline limit of ${account.limits.maxAttachmentBytes}.`,
        'Pass savePath to write the file instead of returning base64.',
      );
    }
    return {
      ok: true as const,
      account: account.id,
      mailbox: input.mailbox,
      uid: input.uid,
      filename: attachment.filename ?? null,
      contentType: attachment.contentType,
      bytes,
      contentBase64: attachment.content.toString('base64'),
    };
  }

  async listThreads(
    input: ListInput & { algorithm?: 'REFERENCES' | 'ORDEREDSUBJECT' },
  ): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    const algorithm = input.algorithm ?? 'REFERENCES';
    return this.withMailbox(account, input.mailbox ?? 'INBOX', 'read', async (box, session) => {
      this.assertUid(box, input.uidValidity);
      const compiled = compileSearch(input.search);
      assertSearchCapabilities(compiled.requires, (name) => session.hasCapability(name));
      let threads: ThreadNode[] | null = null;
      let source: 'server' | 'client' = 'client';
      if (session.hasCapability('THREAD')) {
        threads = await box.serverThread(algorithm, compiled);
        if (threads) {
          source = 'server';
        }
      }
      if (!threads) {
        const uids = await box.search(compiled);
        const limited = uids.slice(0, account.limits.maxSortCandidates);
        const summaries = await box.fetchSummaries(limited, { snippet: false, snippetChars: 0 });
        const withRefs = await this.attachReferences(box, summaries);
        threads = threadMessages(
          withRefs.map((item) => ({
            uid: item.uid,
            messageId: item.messageId,
            inReplyTo: item.inReplyTo,
            references: item.references,
            subject: item.subject,
          })),
          algorithm === 'ORDEREDSUBJECT',
        );
      }
      const flat = flattenThread(threads);
      const limit = clampLimit(input.limit, account.limits.pageSize, account.limits.maxPageSize);
      const cursor = input.cursor
        ? decodeCursor(input.cursor, box.uidValidity)
        : { v: 1 as const, offset: 0 };
      const pageUids = flat.slice(cursor.offset, cursor.offset + limit);
      const nextOffset = cursor.offset + pageUids.length;
      return {
        ok: true as const,
        account: account.id,
        mailbox: input.mailbox ?? 'INBOX',
        uidValidity: box.uidValidity,
        algorithm,
        source,
        total: flat.length,
        threads,
        uids: pageUids,
        nextCursor:
          nextOffset < flat.length
            ? encodeCursor({ v: 1, offset: nextOffset, uidValidity: box.uidValidity })
            : null,
      };
    });
  }

  async setFlags(input: FlagInput): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    assertMutation(account, 'message-write');
    const flags = normalizeFlags(input.flags);
    return this.withMailbox(account, input.mailbox, 'write', async (box, session) => {
      this.assertUid(box, input.uidValidity);
      if (input.unchangedSince && !session.hasCapability('CONDSTORE')) {
        throw new MailError(
          'CAPABILITY_UNSUPPORTED',
          'unchangedSince requires CONDSTORE.',
          'Omit unchangedSince to update flags without a mod-sequence check.',
        );
      }
      await this.perUid(input.uids, account.limits.maxBulk, async (uid) => {
        await box.setFlags([uid], flags, input.operation, input.unchangedSince);
      });
      return {
        ok: true as const,
        account: account.id,
        mailbox: input.mailbox,
        uids: input.uids,
        operation: input.operation,
        flags,
      };
    });
  }

  async copyOrMove(input: TransferInput, move: boolean): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    assertMutation(account, move ? 'delete' : 'message-write');
    return this.withMailbox(account, input.mailbox, 'write', async (box, session) => {
      this.assertUid(box, input.uidValidity);
      if (
        move &&
        !session.hasCapability('MOVE') &&
        !session.hasCapability('UIDPLUS') &&
        !account.allowPermanentDelete
      ) {
        throw new MailError(
          'CAPABILITY_UNSUPPORTED',
          'This server has neither MOVE nor UIDPLUS. The COPY + EXPUNGE fallback would remove every \\Deleted message in the mailbox.',
          'Use a server with MOVE, or set allowPermanentDelete to accept that fallback.',
        );
      }
      const results = await this.perUid(input.uids, account.limits.maxBulk, async (uid) => {
        const map = move
          ? await box.move([uid], input.destination)
          : await box.copy([uid], input.destination);
        return map[String(uid)] ?? null;
      });
      return {
        ok: true as const,
        account: account.id,
        mailbox: input.mailbox,
        destination: input.destination,
        move,
        results,
      };
    });
  }

  async deleteMessages(input: DeleteInput): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    if (input.permanent) {
      assertMutation(account, 'permanent');
      return this.withMailbox(account, input.mailbox, 'write', async (box) => {
        this.assertUid(box, input.uidValidity);
        await this.perUid(input.uids, account.limits.maxBulk, async (uid) => {
          await box.expunge([uid]);
        });
        return {
          ok: true as const,
          account: account.id,
          mailbox: input.mailbox,
          permanent: true,
          uids: input.uids,
        };
      });
    }
    assertMutation(account, 'delete');
    const trash = await this.withImap(
      account,
      async (session) => (await this.special(account, session)).trash,
    );
    if (!trash) {
      throw new MailError(
        'NOT_FOUND',
        'No Trash mailbox could be resolved.',
        'Create a Trash folder, or set trashMailbox on the account, or call again with permanent true.',
      );
    }
    if (input.mailbox === trash) {
      throw new MailError(
        'INVALID_ARGUMENT',
        'These messages are already in Trash. Pass permanent true to expunge them.',
      );
    }
    return this.copyOrMove({ ...input, destination: trash }, true);
  }

  async expunge(accountId: string | undefined, mailbox: string): Promise<Record<string, unknown>> {
    const account = this.account(accountId);
    assertMutation(account, 'permanent');
    return this.withMailbox(account, mailbox, 'write', async (box) => {
      await box.expunge();
      return { ok: true as const, account: account.id, mailbox, expunged: true };
    });
  }

  async append(input: AppendInput): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    assertMutation(account, 'message-write');
    const raw = input.rawBase64
      ? Buffer.from(input.rawBase64, 'base64')
      : await buildRawMessage(await this.outboundFromParts(account, input));
    if (raw.length > account.limits.maxMessageBytes) {
      throw new MailError('SIZE_LIMIT', `Message is ${raw.length} bytes, over maxMessageBytes.`);
    }
    return this.withImap(account, async (session) => {
      const appended = await session.append(
        input.mailbox,
        raw,
        input.flags,
        input.date ? new Date(input.date) : undefined,
      );
      return { ok: true as const, account: account.id, bytes: raw.length, ...appended };
    });
  }

  async setLabels(input: LabelInput): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    assertMutation(account, 'message-write');
    return this.withMailbox(account, input.mailbox, 'write', async (box) => {
      this.assertUid(box, input.uidValidity);
      await this.perUid(input.uids, account.limits.maxBulk, async (uid) => {
        await box.setLabels([uid], input.labels, input.operation);
      });
      return {
        ok: true as const,
        account: account.id,
        mailbox: input.mailbox,
        uids: input.uids,
        labels: input.labels,
        operation: input.operation,
      };
    });
  }

  async bulk(input: BulkInput): Promise<Record<string, unknown>> {
    const results: Array<Record<string, unknown>> = [];
    for (const uid of input.uids) {
      try {
        if (
          input.action === 'addFlags' ||
          input.action === 'removeFlags' ||
          input.action === 'setFlags'
        ) {
          await this.setFlags({
            account: input.account,
            mailbox: input.mailbox,
            uidValidity: input.uidValidity,
            uids: [uid],
            flags: input.flags ?? [],
            operation:
              input.action === 'addFlags'
                ? 'add'
                : input.action === 'removeFlags'
                  ? 'remove'
                  : 'set',
          });
        } else if (input.action === 'copy' || input.action === 'move') {
          if (!input.destination) {
            throw new MailError('INVALID_ARGUMENT', 'destination is required for copy and move.');
          }
          await this.copyOrMove(
            {
              account: input.account,
              mailbox: input.mailbox,
              uidValidity: input.uidValidity,
              uids: [uid],
              destination: input.destination,
            },
            input.action === 'move',
          );
        } else if (input.action === 'delete') {
          await this.deleteMessages({
            account: input.account,
            mailbox: input.mailbox,
            uidValidity: input.uidValidity,
            uids: [uid],
            permanent: input.permanent ?? false,
          });
        } else {
          await this.setLabels({
            account: input.account,
            mailbox: input.mailbox,
            uidValidity: input.uidValidity,
            uids: [uid],
            labels: input.labels ?? [],
            operation: input.action === 'addLabels' ? 'add' : 'remove',
          });
        }
        results.push({ uid, ok: true });
      } catch (error) {
        const mapped =
          error instanceof MailError ? error : new MailError('PROTOCOL_ERROR', 'Bulk item failed.');
        results.push({ uid, ok: false, code: mapped.code, message: mapped.message });
      }
    }
    return {
      ok: true as const,
      account: this.account(input.account).id,
      mailbox: input.mailbox,
      action: input.action,
      results,
    };
  }

  async saveDraft(input: DraftInput, replaceUid?: number): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    assertMutation(account, 'message-write');
    const drafts = await this.withImap(account, async (session) => {
      if (input.mailbox) {
        return input.mailbox;
      }
      return (await this.special(account, session)).drafts;
    });
    if (!drafts) {
      throw new MailError(
        'NOT_FOUND',
        'No Drafts mailbox could be resolved.',
        'Set draftsMailbox or create a Drafts folder.',
      );
    }
    const raw = await buildRawMessage(await this.outboundFromParts(account, input));
    const appended = await this.withImap(account, (session) =>
      session.append(drafts, raw, ['\\Draft', '\\Seen']),
    );
    if (replaceUid !== undefined) {
      await this.deleteMessages({
        account: account.id,
        mailbox: drafts,
        uids: [replaceUid],
        permanent: account.allowPermanentDelete,
      });
    }
    return {
      ok: true as const,
      account: account.id,
      mailbox: drafts,
      ...appended,
      replacedUid: replaceUid ?? null,
    };
  }

  async deleteDraft(
    accountId: string | undefined,
    uid: number,
    mailbox?: string,
  ): Promise<Record<string, unknown>> {
    const account = this.account(accountId);
    const drafts =
      mailbox ??
      (await this.withImap(
        account,
        async (session) => (await this.special(account, session)).drafts,
      ));
    if (!drafts) {
      throw new MailError('NOT_FOUND', 'No Drafts mailbox could be resolved.');
    }
    return this.deleteMessages({
      account: account.id,
      mailbox: drafts,
      uids: [uid],
      permanent: false,
    });
  }

  async send(input: SendInput): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    assertMutation(account, 'send');
    if (!account.smtp) {
      throw new MailError('CONFIG_ERROR', `Account "${account.id}" has no SMTP server configured.`);
    }
    const message = await this.outboundFromParts(account, input);
    assertRecipients(account, [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])]);
    if (account.sendRateLimit) {
      this.limiter.consume(account.id, account.sendRateLimit.max, account.sendRateLimit.windowMs);
    }
    const raw = await buildRawMessage(message);
    if (raw.length > account.limits.maxMessageBytes) {
      throw new MailError('SIZE_LIMIT', `Message is ${raw.length} bytes, over maxMessageBytes.`);
    }
    const sender = await this.smtpFactory(account);
    try {
      const result = await withTimeout(
        account.smtp.timeoutMs,
        'SMTP send',
        sender.send({
          raw,
          envelope: {
            from: input.envelopeFrom ?? message.from.address,
            to: input.envelopeTo ?? envelopeRecipients(message),
          },
          ...(input.dsn ? { dsn: input.dsn } : {}),
        }),
      );
      let appended: Record<string, unknown> | null = null;
      if (input.appendSent !== false && this.shouldAppend(account)) {
        appended = await this.appendSent(account, raw);
      }
      return {
        ok: true as const,
        account: account.id,
        bytes: raw.length,
        smtp: result,
        sentAppend: appended,
      };
    } finally {
      sender.close();
    }
  }

  async reply(input: ReplyInput): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    const loaded = await this.loadParsed(account, input);
    const own = ownAddressesOf(account.email, account.identities, account.user);
    const original = {
      from: asMail(loaded.parsed.from),
      to: asMail(loaded.parsed.to),
      cc: asMail(loaded.parsed.cc),
      replyTo: asMail(loaded.parsed.replyTo),
    };
    const to = input.replyAll ? planReplyAll(original, own).to : planReply(original, own);
    const cc = input.replyAll ? planReplyAll(original, own).cc : [];
    if (to.length === 0) {
      throw new MailError(
        'INVALID_ARGUMENT',
        'The original message has no reply address that is not this account.',
      );
    }
    const quoted = quotePlain(
      loaded.parsed.text || loaded.parsed.htmlAsText || '',
      formatAddress(original.from[0] ?? { address: 'unknown' }),
      loaded.parsed.date ?? 'an unknown date',
    );
    const text = `${input.text ?? ''}${input.text ? '\n\n' : ''}${quoted}`;
    return this.send({
      account: account.id,
      to,
      cc,
      subject: input.subject ?? replySubject(loaded.parsed.subject),
      text,
      html: input.html,
      attachments: input.attachments,
      inReplyTo: loaded.parsed.messageId,
      references: buildReferences(loaded.parsed.references, loaded.parsed.messageId),
      appendSent: input.appendSent,
    });
  }

  async forward(input: ForwardInput): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    const loaded = await this.loadParsed(account, input);
    const quoted = quotePlain(
      loaded.parsed.text || loaded.parsed.htmlAsText || '',
      formatAddress(asMail(loaded.parsed.from)[0] ?? { address: 'unknown' }),
      loaded.parsed.date ?? 'an unknown date',
    );
    const text = `${input.text ?? ''}${input.text ? '\n\n' : ''}---------- Forwarded message ----------\n${quoted}`;
    const attachments: OutboundAttachment[] = [...(input.attachments ?? [])];
    if (input.includeAttachments !== false) {
      for (const attachment of loaded.parsed.attachments) {
        if (!attachment.content || attachment.inline) {
          continue;
        }
        attachments.push({
          filename: attachment.filename,
          contentType: attachment.contentType,
          contentBase64: attachment.content.toString('base64'),
        });
      }
    }
    return this.send({
      account: account.id,
      to: input.to,
      cc: input.cc,
      subject: input.subject ?? forwardSubject(loaded.parsed.subject),
      text,
      html: input.html,
      attachments,
      appendSent: input.appendSent,
    });
  }

  async sendDraft(input: UidInput & { appendSent?: boolean }): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    assertMutation(account, 'send');
    const source = await this.withMailbox(account, input.mailbox, 'read', async (box) => {
      this.assertUid(box, input.uidValidity);
      return box.fetchSource(input.uid);
    });
    if (!source) {
      throw new MailError('NOT_FOUND', `Draft UID ${input.uid} was not found.`);
    }
    const parsed = await parseRawMessage(source);
    const recipients = [...asMail(parsed.to), ...asMail(parsed.cc), ...asMail(parsed.bcc)];
    assertRecipients(account, recipients);
    if (account.sendRateLimit) {
      this.limiter.consume(account.id, account.sendRateLimit.max, account.sendRateLimit.windowMs);
    }
    if (!account.smtp) {
      throw new MailError('CONFIG_ERROR', `Account "${account.id}" has no SMTP server configured.`);
    }
    const sender = await this.smtpFactory(account);
    try {
      const from = asMail(parsed.from)[0]?.address ?? account.email;
      const result = await sender.send({
        raw: source,
        envelope: { from, to: recipients.map((item) => item.address) },
      });
      let appended: Record<string, unknown> | null = null;
      if (input.appendSent !== false && this.shouldAppend(account)) {
        appended = await this.appendSent(account, source);
      }
      return {
        ok: true as const,
        account: account.id,
        smtp: result,
        sentAppend: appended,
        uid: input.uid,
      };
    } finally {
      sender.close();
    }
  }

  async verifySmtp(accountId?: string): Promise<Record<string, unknown>> {
    const account = this.account(accountId);
    return { ok: true as const, account: account.id, smtp: await this.probeSmtp(account) };
  }

  async waitForChanges(input: {
    account?: string;
    mailbox?: string;
    timeoutMs?: number;
  }): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    const timeoutMs = input.timeoutMs ?? 25_000;
    if (timeoutMs < 1000 || timeoutMs > 120_000) {
      throw new MailError('INVALID_ARGUMENT', 'timeoutMs must be between 1000 and 120000.');
    }
    const mailbox = input.mailbox ?? 'INBOX';
    return this.withImap(account, async (session) => {
      const waited = await withTimeout(
        timeoutMs + 5_000,
        'IDLE',
        session.waitForChanges(mailbox, timeoutMs),
      );
      return { ok: true as const, account: account.id, mailbox, ...waited };
    });
  }

  async close(): Promise<void> {
    await this.pool.close();
  }

  private async queryMessages(
    input: ListInput,
    fromSearch: boolean,
  ): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    const mailbox = input.mailbox ?? 'INBOX';
    return this.withMailbox(account, mailbox, 'read', async (box, session) => {
      this.assertUid(box, input.uidValidity);
      const compiled = compileSearch(input.search);
      assertSearchCapabilities(compiled.requires, (name) => session.hasCapability(name));
      const matched = await box.search(compiled);
      const keys = input.sort ?? [{ field: 'arrival', reverse: true }];
      let ordered: number[];
      let sortSource: 'server' | 'client' | 'uid' = 'uid';
      const serverSorted = await box.serverSort(compiled, keys);
      if (serverSorted) {
        const allow = new Set(matched);
        ordered = serverSorted.filter((uid) => allow.has(uid));
        sortSource = 'server';
      } else if (matched.length > account.limits.maxSortCandidates) {
        throw new MailError(
          'SIZE_LIMIT',
          `This mailbox slice has ${matched.length} matches and the server cannot SORT them. The client-side cap is ${account.limits.maxSortCandidates}.`,
          'Narrow the search, or use a server with the SORT extension.',
        );
      } else {
        const summaries = await box.fetchSummaries(matched, { snippet: false, snippetChars: 0 });
        const sortable: Array<SortableMessage & { uid: number }> = summaries.map((item) => ({
          uid: item.uid,
          arrival: item.internalDate,
          date: item.date,
          from: item.from[0]?.address ?? item.from[0]?.name,
          to: item.to[0]?.address ?? item.to[0]?.name,
          cc: item.cc[0]?.address,
          subject: item.subject,
          size: item.size,
        }));
        ordered = sortMessages(sortable, keys).map((item) => item.uid);
        sortSource = 'client';
      }
      const limit = clampLimit(input.limit, account.limits.pageSize, account.limits.maxPageSize);
      const cursor = input.cursor
        ? decodeCursor(input.cursor, box.uidValidity)
        : { v: 1 as const, offset: 0 };
      const pageUids = ordered.slice(cursor.offset, cursor.offset + limit);
      const messages = await box.fetchSummaries(pageUids, {
        snippet: input.includeSnippet !== false,
        snippetChars: input.snippetChars ?? 160,
      });
      const byUid = new Map(messages.map((item) => [item.uid, item]));
      const orderedMessages = pageUids
        .map((uid) => byUid.get(uid))
        .filter((item): item is MessageSummary => Boolean(item));
      const nextOffset = cursor.offset + pageUids.length;
      return {
        ok: true as const,
        account: account.id,
        mailbox,
        uidValidity: box.uidValidity,
        total: ordered.length,
        offset: cursor.offset,
        sort: keys,
        sortSource,
        search: fromSearch,
        messages: orderedMessages.map(publicSummary),
        nextCursor:
          nextOffset < ordered.length
            ? encodeCursor({ v: 1, offset: nextOffset, uidValidity: box.uidValidity })
            : null,
      };
    });
  }

  private async withImap<T>(
    account: ResolvedAccount,
    fn: (session: ImapSession) => Promise<T>,
  ): Promise<T> {
    return this.pool.use(account.id, (session) =>
      withTimeout(account.imap.timeoutMs, `IMAP ${account.id}`, fn(session)),
    );
  }

  private async withMailbox<T>(
    account: ResolvedAccount,
    mailbox: string,
    mode: 'read' | 'write',
    fn: (box: OpenMailbox, session: ImapSession) => Promise<T>,
  ): Promise<T> {
    return this.withImap(account, (session) =>
      session.withMailbox(mailbox, mode, (box) => fn(box, session)),
    );
  }

  private assertUid(box: OpenMailbox, expected?: string): void {
    if (expected && expected !== box.uidValidity) {
      throw new MailError(
        'UIDVALIDITY_CHANGED',
        `UIDVALIDITY is ${box.uidValidity}, not ${expected}.`,
        'List the mailbox again. UIDs from the previous session are not safe to use.',
      );
    }
  }

  private async requireSummary(box: OpenMailbox, uid: number): Promise<MessageSummary> {
    const rows = await box.fetchSummaries([uid], { snippet: false, snippetChars: 0 });
    const row = rows[0];
    if (!row) {
      throw new MailError('NOT_FOUND', `Message UID ${uid} was not found in ${box.path}.`);
    }
    return row;
  }

  private async special(
    account: ResolvedAccount,
    session: ImapSession,
  ): Promise<ResolvedSpecialUse> {
    const cached = this.specialCache.get(account.id);
    if (cached) {
      return cached;
    }
    const mailboxes = await session.listMailboxes();
    const resolved = resolveSpecialUse(mailboxes, account.provider, {
      sent: account.sentMailbox,
      trash: account.trashMailbox,
      drafts: account.draftsMailbox,
    });
    this.specialCache.set(account.id, resolved);
    return resolved;
  }

  private async attachReferences(
    box: OpenMailbox,
    summaries: MessageSummary[],
  ): Promise<MessageSummary[]> {
    for (const summary of summaries) {
      const raw = await box.fetchHeaders(summary.uid);
      if (!raw) {
        continue;
      }
      const text = raw.toString('utf8');
      summary.references = messageIds(headerValue(text, 'references'));
      if (!summary.inReplyTo) {
        const inReply = headerValue(text, 'in-reply-to');
        if (inReply) {
          summary.inReplyTo = messageIds(inReply)[0];
        }
      }
      if (!summary.messageId) {
        summary.messageId = headerValue(text, 'message-id');
      }
    }
    return summaries;
  }

  private async loadParsed(
    account: ResolvedAccount,
    input: UidInput,
  ): Promise<{ parsed: ParsedMessage; summary: MessageSummary }> {
    return this.withMailbox(account, input.mailbox, 'read', async (box) => {
      this.assertUid(box, input.uidValidity);
      const summary = await this.requireSummary(box, input.uid);
      if ((summary.size ?? 0) > account.limits.maxMessageBytes) {
        throw new MailError('SIZE_LIMIT', `Message UID ${input.uid} exceeds maxMessageBytes.`);
      }
      const source = await box.fetchSource(input.uid);
      if (!source) {
        throw new MailError('NOT_FOUND', `Message UID ${input.uid} was not found.`);
      }
      return { parsed: await parseRawMessage(source), summary };
    });
  }

  private async outboundFromParts(
    account: ResolvedAccount,
    input: ComposeParts,
  ): Promise<OutboundMessage> {
    const from = this.resolveFrom(account, input.from);
    const to = normalizeRecipients(input.to);
    if (to.length === 0 && !input.allowEmptyRecipients) {
      throw new MailError('INVALID_ARGUMENT', 'At least one To recipient is required.');
    }
    const message: OutboundMessage = {
      from,
      to,
      subject: input.subject ?? '',
    };
    const cc = normalizeRecipients(input.cc);
    const bcc = normalizeRecipients(input.bcc);
    const replyTo = normalizeRecipients(input.replyTo);
    if (cc.length) {
      message.cc = cc;
    }
    if (bcc.length) {
      message.bcc = bcc;
    }
    if (replyTo.length) {
      message.replyTo = replyTo;
    }
    if (input.text !== undefined) {
      message.text = input.text;
    }
    if (input.html !== undefined) {
      message.html = input.html;
    }
    if (input.attachments) {
      message.attachments = input.attachments;
    }
    if (input.headers) {
      message.headers = input.headers;
    }
    if (input.inReplyTo) {
      message.inReplyTo = input.inReplyTo;
    }
    if (input.references) {
      message.references = input.references;
    }
    if (input.priority) {
      message.priority = input.priority;
    }
    if (input.readReceipt) {
      message.readReceipt = true;
    }
    return message;
  }

  private resolveFrom(account: ResolvedAccount, from?: string | MailAddress): MailAddress {
    const identity = account.identities.find((item) => item.default) ?? account.identities[0];
    if (!from) {
      return identityToAddress(identity, account.email);
    }
    const parsed = typeof from === 'string' ? parseAddress(from) : from;
    const match = account.identities.find(
      (item) => item.email.toLowerCase() === parsed.address.toLowerCase(),
    );
    if (!match) {
      throw new MailError(
        'PERMISSION_DENIED',
        `From address ${parsed.address} is not a configured identity for account "${account.id}".`,
        `Identities: ${account.identities.map((item) => item.email).join(', ')}.`,
      );
    }
    if (!parsed.name && match.name) {
      parsed.name = match.name;
    }
    return parsed;
  }

  private shouldAppend(account: ResolvedAccount): boolean {
    if (account.appendSent === true) {
      return true;
    }
    if (account.appendSent === false) {
      return false;
    }
    return account.provider !== 'gmail';
  }

  private async appendSent(
    account: ResolvedAccount,
    raw: Buffer,
  ): Promise<Record<string, unknown> | null> {
    try {
      return await this.withImap(account, async (session) => {
        const sent = account.sentMailbox ?? (await this.special(account, session)).sent;
        if (!sent) {
          return { skipped: true, reason: 'No Sent mailbox could be resolved.' };
        }
        const appended = await session.append(sent, raw, ['\\Seen']);
        return { mailbox: sent, ...appended };
      });
    } catch (error) {
      this.logger.warn('sent append failed', {
        account: account.id,
        message: error instanceof Error ? error.message : 'append failed',
      });
      return {
        skipped: true,
        reason: error instanceof MailError ? error.message : 'APPEND failed',
      };
    }
  }

  private async probeImap(account: ResolvedAccount): Promise<Record<string, unknown>> {
    try {
      return await this.withImap(account, async (session) => ({
        ok: true,
        host: account.imap.host,
        port: account.imap.port,
        secure: account.imap.secure,
        capabilities: [...session.capabilities.keys()].sort(),
      }));
    } catch (error) {
      const mapped =
        error instanceof MailError
          ? error
          : new MailError('CONNECTION_FAILED', 'IMAP check failed.');
      return { ok: false, code: mapped.code, message: mapped.message, hint: mapped.hint ?? null };
    }
  }

  private async probeSmtp(account: ResolvedAccount): Promise<Record<string, unknown>> {
    if (!account.smtp) {
      return {
        ok: false,
        code: 'CONFIG_ERROR',
        message: 'No SMTP server is configured.',
        hint: null,
      };
    }
    const sender = await this.smtpFactory(account).catch((error: unknown) => {
      const mapped =
        error instanceof MailError
          ? error
          : new MailError('CONNECTION_FAILED', 'SMTP setup failed.');
      return mapped;
    });
    if (sender instanceof MailError) {
      return { ok: false, code: sender.code, message: sender.message, hint: sender.hint ?? null };
    }
    try {
      await withTimeout(account.smtp.timeoutMs, 'SMTP verify', sender.verify());
      return {
        ok: true,
        host: account.smtp.host,
        port: account.smtp.port,
        secure: account.smtp.secure,
      };
    } catch (error) {
      const mapped =
        error instanceof MailError
          ? error
          : new MailError('CONNECTION_FAILED', 'SMTP check failed.');
      return { ok: false, code: mapped.code, message: mapped.message, hint: mapped.hint ?? null };
    } finally {
      sender.close();
    }
  }

  private async perUid<T>(
    uids: number[],
    max: number,
    fn: (uid: number) => Promise<T>,
  ): Promise<
    Array<
      | { uid: number; ok: true; value: T }
      | { uid: number; ok: false; code: string; message: string }
    >
  > {
    if (uids.length === 0) {
      throw new MailError('INVALID_ARGUMENT', 'uids must contain at least one UID.');
    }
    if (uids.length > max) {
      throw new MailError('SIZE_LIMIT', `Bulk operations accept at most ${max} UIDs.`);
    }
    const results: Array<
      | { uid: number; ok: true; value: T }
      | { uid: number; ok: false; code: string; message: string }
    > = [];
    for (const uid of uids) {
      try {
        results.push({ uid, ok: true, value: await fn(uid) });
      } catch (error) {
        const mapped =
          error instanceof MailError
            ? error
            : new MailError('PROTOCOL_ERROR', 'The UID operation failed.');
        results.push({ uid, ok: false, code: mapped.code, message: mapped.message });
      }
    }
    if (results.every((item) => !item.ok)) {
      const first = results[0];
      throw new MailError(
        (first && !first.ok ? first.code : 'PROTOCOL_ERROR') as MailError['code'],
        first && !first.ok ? first.message : 'Every UID failed.',
      );
    }
    return results;
  }
}

function isOk(value: Record<string, unknown>): boolean {
  if (value.skipped === true) {
    return true;
  }
  return value.ok === true;
}

function publicMailbox(mailbox: MailboxInfo): Record<string, unknown> {
  return {
    path: mailbox.path,
    name: mailbox.name,
    delimiter: mailbox.delimiter,
    flags: mailbox.flags,
    specialUse: mailbox.specialUse ?? null,
    specialUseSource: mailbox.specialUseSource ?? null,
    subscribed: mailbox.subscribed,
    listed: mailbox.listed,
    parentPath: mailbox.parentPath,
  };
}

function publicSummary(summary: MessageSummary): Record<string, unknown> {
  return {
    uid: summary.uid,
    flags: summary.flags,
    size: summary.size ?? null,
    date: summary.date ?? null,
    internalDate: summary.internalDate ?? null,
    subject: summary.subject ?? null,
    from: summary.from,
    to: summary.to,
    cc: summary.cc,
    messageId: summary.messageId ?? null,
    hasAttachments: summary.hasAttachments,
    snippet: summary.snippet ?? null,
    labels: summary.labels ?? [],
    threadId: summary.threadId ?? null,
    modseq: summary.modseq ?? null,
  };
}

function publicHeaders(parsed: ParsedMessage): Record<string, unknown> {
  return {
    subject: parsed.subject ?? null,
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc,
    bcc: parsed.bcc,
    replyTo: parsed.replyTo,
    date: parsed.date ?? null,
    messageId: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo ?? null,
    references: parsed.references,
  };
}

function asMail(addresses: Array<{ name?: string; address?: string }>): MailAddress[] {
  return addresses
    .filter((item): item is { name?: string; address: string } => Boolean(item.address))
    .map((item) =>
      item.name ? { name: item.name, address: item.address } : { address: item.address },
    );
}

function normalizeRecipients(value: Array<string | MailAddress> | undefined): MailAddress[] {
  if (!value) {
    return [];
  }
  const out: MailAddress[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      out.push(...parseAddressList(item));
    } else {
      out.push(item);
    }
  }
  return out;
}

function identityToAddress(identity: Identity | undefined, email: string): MailAddress {
  if (!identity) {
    return { address: email };
  }
  const address: MailAddress = { address: identity.email };
  if (identity.name) {
    address.name = identity.name;
  }
  return address;
}

function pickAttachment(
  parsed: ParsedMessage,
  input: DownloadInput,
): ParsedMessage['attachments'][number] {
  if (input.partIndex !== undefined) {
    const found = parsed.attachments[input.partIndex];
    if (!found) {
      throw new MailError('NOT_FOUND', `Attachment index ${input.partIndex} does not exist.`);
    }
    return found;
  }
  if (input.filename) {
    const found = parsed.attachments.find((item) => item.filename === input.filename);
    if (!found) {
      throw new MailError('NOT_FOUND', `No attachment named "${input.filename}".`);
    }
    return found;
  }
  if (input.cid) {
    const found = parsed.attachments.find((item) => item.cid === input.cid);
    if (!found) {
      throw new MailError('NOT_FOUND', `No attachment with cid "${input.cid}".`);
    }
    return found;
  }
  throw new MailError(
    'INVALID_ARGUMENT',
    'Provide filename, cid, or partIndex to choose an attachment.',
  );
}

export function resolveSavePath(requested: string, root?: string): string {
  if (requested.includes('\0')) {
    throw new MailError('INVALID_ARGUMENT', 'savePath contains a NUL byte.');
  }
  const absolute = path.resolve(requested);
  if (!root) {
    return absolute;
  }
  const rootAbs = path.resolve(root);
  const relative = path.relative(rootAbs, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new MailError(
      'PERMISSION_DENIED',
      'savePath is outside the configured attachmentsDir.',
      `Writes are confined to ${rootAbs}.`,
    );
  }
  return absolute;
}

export interface UidInput {
  account?: string;
  mailbox: string;
  uid: number;
  uidValidity?: string;
}

export interface ListInput {
  account?: string;
  mailbox?: string;
  search?: SearchCriteria;
  sort?: SortKey[];
  limit?: number;
  cursor?: string;
  uidValidity?: string;
  includeSnippet?: boolean;
  snippetChars?: number;
}

export interface GetMessageInput extends UidInput {
  maxBodyChars?: number;
  parts?: string[];
}

export interface DownloadInput extends UidInput {
  filename?: string;
  cid?: string;
  partIndex?: number;
  savePath?: string;
}

export interface FlagInput {
  account?: string;
  mailbox: string;
  uidValidity?: string;
  uids: number[];
  flags: string[];
  operation: 'add' | 'remove' | 'set';
  unchangedSince?: string;
}

export interface TransferInput {
  account?: string;
  mailbox: string;
  uidValidity?: string;
  uids: number[];
  destination: string;
}

export interface DeleteInput {
  account?: string;
  mailbox: string;
  uidValidity?: string;
  uids: number[];
  permanent?: boolean;
}

export interface AppendInput extends ComposeParts {
  account?: string;
  mailbox: string;
  flags?: string[];
  date?: string;
  rawBase64?: string;
}

export interface LabelInput {
  account?: string;
  mailbox: string;
  uidValidity?: string;
  uids: number[];
  labels: string[];
  operation: 'add' | 'remove' | 'set';
}

export interface BulkInput {
  account?: string;
  mailbox: string;
  uidValidity?: string;
  uids: number[];
  action:
    | 'addFlags'
    | 'removeFlags'
    | 'setFlags'
    | 'copy'
    | 'move'
    | 'delete'
    | 'addLabels'
    | 'removeLabels';
  flags?: string[];
  labels?: string[];
  destination?: string;
  permanent?: boolean;
}

export interface ComposeParts {
  account?: string;
  from?: string;
  to?: Array<string | MailAddress>;
  cc?: Array<string | MailAddress>;
  bcc?: Array<string | MailAddress>;
  replyTo?: Array<string | MailAddress>;
  subject?: string;
  text?: string;
  html?: string;
  attachments?: OutboundAttachment[];
  headers?: Record<string, string>;
  inReplyTo?: string;
  references?: string;
  priority?: 'high' | 'normal' | 'low';
  readReceipt?: boolean;
  allowEmptyRecipients?: boolean;
}

export interface SendInput extends ComposeParts {
  envelopeFrom?: string;
  envelopeTo?: string[];
  dsn?: {
    id?: string;
    ret?: 'FULL' | 'HDRS';
    notify?: Array<'never' | 'success' | 'failure' | 'delay'>;
    orcpt?: string;
  };
  appendSent?: boolean;
}

export interface ReplyInput {
  account?: string;
  mailbox: string;
  uid: number;
  uidValidity?: string;
  replyAll?: boolean;
  text?: string;
  html?: string;
  subject?: string;
  attachments?: OutboundAttachment[];
  appendSent?: boolean;
}

export interface ForwardInput {
  account?: string;
  mailbox: string;
  uid: number;
  uidValidity?: string;
  to: Array<string | MailAddress>;
  cc?: Array<string | MailAddress>;
  text?: string;
  html?: string;
  subject?: string;
  attachments?: OutboundAttachment[];
  includeAttachments?: boolean;
  appendSent?: boolean;
}

export interface DraftInput extends ComposeParts {
  mailbox?: string;
}
