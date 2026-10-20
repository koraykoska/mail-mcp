import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MailError } from '../errors.js';
import { confineToRoot, readBoundedFile } from '../fs-sandbox.js';
import { redactText } from '../redact.js';
import type { AppConfig, Identity, ResolvedAccount } from '../config/schema.js';
import { requireAccount } from '../config/load.js';
import type { Logger } from '../log.js';
import { SlidingWindowLimiter } from '../rate-limit.js';
import { assertMutation, assertRecipients } from '../safety.js';
import {
  decodeCursor,
  encodeCursor,
  clampLimit,
  pageAfterUid,
  pageAnchored,
} from '../pagination.js';
import type { ImapPool } from '../imap/pool.js';
import { assertSearchCapabilities, compileSearch, type SearchCriteria } from '../imap/search.js';
import {
  anchorOf,
  isStrictlyAfter,
  sortMessages,
  type SortKey,
  type SortableMessage,
} from '../imap/sort.js';
import { resolveSpecialUse, type ResolvedSpecialUse } from '../imap/special-use.js';
import { normalizeFlags, touchesDeleted } from '../imap/flags.js';
import type {
  BodyNode,
  ImapSession,
  MailboxInfo,
  MessageSummary,
  OpenMailbox,
} from '../imap/session.js';
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
import { capText, parseRawMessage, type ParsedMessage } from '../mime/parse.js';
import { htmlToSafeText, quoteHtml, sanitizeHtml, textToHtml } from '../mime/html.js';
import { hasHighOctets, stripBcc } from '../mime/transfer.js';
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
          'The server does not advertise QUOTA or QUOTA=RES-*.',
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
          parts: parts.map((part) => {
            const maxChars = input.maxBodyChars ?? account.limits.maxBodyChars;
            const rawText = textFromPart(part.content, part.contentType);
            const text =
              rawText === null ? { text: undefined, truncated: false } : capText(rawText, maxChars);
            return {
              partId: part.partId,
              contentType: part.contentType ?? null,
              filename: part.filename ?? null,
              size: part.content.length,
              truncated: Boolean(part.truncated) || text.truncated,
              text: text.text,
              contentBase64: rawText === null ? part.content.toString('base64') : undefined,
            };
          }),
        };
      }
      const limit = account.limits.maxMessageBytes;
      if ((summary.size ?? 0) > limit) {
        throw new MailError(
          'SIZE_LIMIT',
          `Message UID ${input.uid} is ${summary.size} bytes, over the maxMessageBytes limit of ${limit}.`,
          'Pass parts to fetch specific MIME sections, or raise limits.maxMessageBytes.',
        );
      }
      const source = await box.fetchSource(input.uid, limit + 1);
      if (source && source.length > limit) {
        throw new MailError(
          'SIZE_LIMIT',
          `Message UID ${input.uid} exceeds the maxMessageBytes limit of ${limit}.`,
        );
      }
      if (!source) {
        throw new MailError(
          'NOT_FOUND',
          `Message UID ${input.uid} was not found in ${input.mailbox}.`,
        );
      }
      const parsed = await parseRawMessage(source);
      const maxChars = input.maxBodyChars ?? account.limits.maxBodyChars;
      const text = capText(parsed.text, maxChars);
      const safeHtml = parsed.html ? sanitizeHtml(parsed.html) : undefined;
      const html = capText(safeHtml, maxChars);
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
        htmlAsText: safeHtml ? capText(htmlToSafeText(safeHtml), maxChars).text : null,
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
      const source = await box.fetchSource(input.uid, limit + 1);
      if (source && source.length > limit) {
        throw new MailError('SIZE_LIMIT', `Raw message exceeds the limit of ${limit} bytes.`);
      }
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
      const truncated = Boolean(part.truncated);
      const contentType = part.contentType ?? 'application/octet-stream';
      const text = textFromPart(part.content, contentType);
      const bytes = part.content.length;
      return {
        ok: true as const,
        account: account.id,
        mailbox: input.mailbox,
        uid: input.uid,
        partId: part.partId,
        contentType,
        filename: part.filename ?? null,
        bytes,
        truncated,
        text,
        contentBase64: text === null ? part.content.toString('base64') : null,
      };
    });
  }

  async downloadAttachment(input: DownloadInput): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    if (input.savePath) {
      assertMutation(account, 'message-write');
    }
    return this.withMailbox(account, input.mailbox, 'read', async (box) => {
      this.assertUid(box, input.uidValidity);
      const structure = await box.fetchStructure(input.uid);
      let located: ReturnType<typeof locatePart> | undefined;
      try {
        located = locatePart(structure, input);
      } catch (error) {
        if (!(error instanceof MailError) || error.code !== 'NOT_FOUND') {
          throw error;
        }
        const summary = await this.requireSummary(box, input.uid);
        if ((summary.size ?? 0) > account.limits.maxMessageBytes) {
          throw error;
        }
        const source = await box.fetchSource(input.uid, account.limits.maxMessageBytes + 1);
        if (!source || source.length > account.limits.maxMessageBytes) {
          throw error;
        }
        const parsed = await parseRawMessage(source);
        const attachment = pickAttachment(parsed, input);
        if (!attachment.content) {
          throw new MailError('NOT_FOUND', 'The attachment had no body.');
        }
        if (attachment.content.length > account.limits.maxAttachmentBytes) {
          throw new MailError(
            'SIZE_LIMIT',
            `Attachment is ${attachment.content.length} bytes, over the limit of ${account.limits.maxAttachmentBytes}.`,
          );
        }
        return this.finishDownload(account, input, {
          filename: attachment.filename ?? null,
          contentType: attachment.contentType,
          content: attachment.content,
        });
      }
      const cap = account.limits.maxAttachmentBytes;
      const parts = await box.fetchParts(input.uid, [{ key: located.partId, maxLength: cap + 1 }]);
      const part = parts[0];
      if (!part) {
        throw new MailError('NOT_FOUND', 'The attachment had no body.');
      }
      if (part.content.length > cap || part.truncated) {
        throw new MailError(
          'SIZE_LIMIT',
          `Attachment is over the limit of ${cap} bytes.`,
          'Raise limits.maxAttachmentBytes.',
        );
      }
      return this.finishDownload(account, input, {
        filename: part.filename ?? located.filename ?? null,
        contentType: part.contentType ?? located.contentType,
        content: part.content,
      });
    });
  }

  private async finishDownload(
    account: ResolvedAccount,
    input: DownloadInput,
    file: { filename: string | null; contentType: string; content: Buffer },
  ): Promise<Record<string, unknown>> {
    if (input.savePath) {
      const target = await confineToRoot(
        input.savePath,
        requireAttachmentsDir(this.config.attachmentsDir),
      );
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content);
      return {
        ok: true as const,
        account: account.id,
        mailbox: input.mailbox,
        uid: input.uid,
        filename: file.filename,
        contentType: file.contentType,
        bytes: file.content.length,
        savedPath: target,
      };
    }
    return {
      ok: true as const,
      account: account.id,
      mailbox: input.mailbox,
      uid: input.uid,
      filename: file.filename,
      contentType: file.contentType,
      bytes: file.content.length,
      contentBase64: file.content.toString('base64'),
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
      let omitted = 0;
      if (session.hasCapability('THREAD') || session.hasCapability(`THREAD=${algorithm}`)) {
        threads = await box.serverThread(algorithm, compiled);
        if (threads) {
          source = 'server';
        }
      }
      if (!threads) {
        const uids = await box.search(compiled);
        omitted = Math.max(0, uids.length - account.limits.maxSortCandidates);
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
      const cursor = input.cursor ? decodeCursor(input.cursor, box.uidValidity) : undefined;
      const page =
        cursor?.v === 2
          ? pageAfterUid(flat, limit, cursor.afterUid, box.uidValidity)
          : pageAnchored(
              flat,
              limit,
              {
                position: cursor?.v === 3 ? (cursor.position ?? 0) : 0,
                ...(cursor?.v === 3 && cursor.afterUid !== undefined
                  ? { afterUid: cursor.afterUid }
                  : {}),
              },
              box.uidValidity,
            );
      const pageSet = new Set(page.uids);
      return {
        ok: true as const,
        account: account.id,
        mailbox: input.mailbox ?? 'INBOX',
        uidValidity: box.uidValidity,
        algorithm,
        source,
        total: flat.length,
        omitted,
        truncated: omitted > 0,
        threads: pruneThreads(threads, pageSet),
        uids: page.uids,
        nextCursor: page.nextCursor,
      };
    });
  }

  async setFlags(input: FlagInput): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    const flags = normalizeFlags(input.flags);
    const explicitDelete = touchesDeleted(flags);
    const replaceMayClearDeleted = input.operation === 'set' && !explicitDelete;
    if (explicitDelete) {
      assertMutation(account, 'delete');
    } else if (!replaceMayClearDeleted) {
      assertMutation(account, 'message-write');
    }
    this.assertBulk(input.uids, account.limits.maxBulk);
    return this.withMailbox(account, input.mailbox, 'write', async (box, session) => {
      this.assertUid(box, input.uidValidity);
      if (replaceMayClearDeleted) {
        const summaries = await box.fetchSummaries(input.uids, { snippet: false, snippetChars: 0 });
        const clearsDeleted = summaries.some((item) =>
          item.flags.some((flag) => flag.toLowerCase() === '\\deleted'),
        );
        assertMutation(account, clearsDeleted ? 'delete' : 'message-write');
      }
      if (input.unchangedSince && !session.condstoreEnabled()) {
        throw new MailError(
          'CAPABILITY_UNSUPPORTED',
          'unchangedSince requires CONDSTORE to be enabled.',
          'Omit unchangedSince, or use a server that enables CONDSTORE.',
        );
      }
      const update = await box.setFlags(input.uids, flags, input.operation, input.unchangedSince);
      const results = flagResults(input.uids, update);
      return {
        ok: results.every((item) => item.ok),
        account: account.id,
        mailbox: input.mailbox,
        uids: results.filter((item) => item.ok).map((item) => item.uid),
        operation: input.operation,
        flags,
        results,
      };
    });
  }

  async copyOrMove(input: TransferInput, move: boolean): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    assertMutation(account, move ? 'delete' : 'message-write');
    return this.withMailbox(account, input.mailbox, 'write', async (box, session) => {
      this.assertUid(box, input.uidValidity);
      if (move && !session.hasCapability('MOVE') && !session.hasCapability('UIDPLUS')) {
        throw new MailError(
          'CAPABILITY_UNSUPPORTED',
          'This server has neither MOVE nor UIDPLUS. Copying and then expunging would remove every \\Deleted message, not only the requested UIDs.',
          'Use a server with MOVE or UIDPLUS. allowPermanentDelete is not consent to expunge unrelated messages.',
        );
      }
      const rows = await this.perUid(input.uids, account.limits.maxBulk, async (uid) => {
        const map = move
          ? await box.move([uid], input.destination)
          : await box.copy([uid], input.destination);
        return map[String(uid)] ?? null;
      });
      return {
        ok: rows.every((item) => item.ok),
        account: account.id,
        mailbox: input.mailbox,
        destination: input.destination,
        move,
        results: rows,
      };
    });
  }

  async deleteMessages(input: DeleteInput): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    if (input.permanent) {
      assertMutation(account, 'permanent');
      return this.withMailbox(account, input.mailbox, 'write', async (box, session) => {
        this.assertUid(box, input.uidValidity);
        if (!session.hasCapability('UIDPLUS')) {
          throw new MailError(
            'CAPABILITY_UNSUPPORTED',
            'Permanent delete of specific UIDs requires UIDPLUS. Without it, EXPUNGE removes every \\Deleted message in the mailbox.',
            'Move the messages to Trash, or use a server that advertises UIDPLUS.',
          );
        }
        const rows = await this.perUid(input.uids, account.limits.maxBulk, async (uid) => {
          await box.expunge([uid]);
          return true;
        });
        return {
          ok: rows.every((item) => item.ok),
          account: account.id,
          mailbox: input.mailbox,
          permanent: true,
          uids: rows.filter((item) => item.ok).map((item) => item.uid),
          results: rows,
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
      this.assertBulk(input.uids, account.limits.maxBulk);
      const results: Array<{ uid: number; ok: boolean; code?: string; message?: string }> = [];
      for (const uid of input.uids) {
        try {
          await box.setLabels([uid], input.labels, input.operation);
          results.push({ uid, ok: true });
        } catch (error) {
          const mapped =
            error instanceof MailError
              ? error
              : new MailError('PROTOCOL_ERROR', 'The UID operation failed.');
          results.push({ uid, ok: false, code: mapped.code, message: mapped.message });
        }
      }
      if (results.every((item) => !item.ok && item.code === 'CAPABILITY_UNSUPPORTED')) {
        const first = results[0];
        throw new MailError(
          'CAPABILITY_UNSUPPORTED',
          first?.message ?? 'Gmail labels require the X-GM-EXT-1 extension.',
        );
      }
      return {
        ok: results.every((item) => item.ok),
        account: account.id,
        mailbox: input.mailbox,
        uids: results.filter((item) => item.ok).map((item) => item.uid),
        labels: input.labels,
        operation: input.operation,
        results,
      };
    });
  }

  async bulk(input: BulkInput): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    this.assertBulk(input.uids, account.limits.maxBulk);
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
      ok: results.every((item) => item.ok === true),
      account: account.id,
      mailbox: input.mailbox,
      action: input.action,
      results,
    };
  }

  async saveDraft(input: DraftInput, replaceUid?: number): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    assertMutation(account, 'message-write');
    if (replaceUid !== undefined) {
      assertMutation(account, 'delete');
    }
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
    const raw = await buildRawMessage(
      await this.outboundFromParts(account, { ...input, allowEmptyRecipients: true }),
      {
        keepBcc: true,
      },
    );
    const appended = await this.withImap(account, (session) =>
      session.append(drafts, raw, ['\\Draft']),
    );
    if (replaceUid !== undefined) {
      try {
        await this.deleteMessages({
          account: account.id,
          mailbox: drafts,
          uids: [replaceUid],
          permanent: account.allowPermanentDelete,
        });
      } catch (error) {
        if (appended.uid !== undefined) {
          await this.deleteMessages({
            account: account.id,
            mailbox: drafts,
            uids: [appended.uid],
            permanent: account.allowPermanentDelete,
          }).catch(() => undefined);
        }
        throw error;
      }
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
    const envelopeTo = (input.envelopeTo ?? envelopeRecipients(message)).map((address) =>
      parseAddress(address),
    );
    assertRecipients(account, envelopeTo);
    const envelopeFrom = input.envelopeFrom ?? message.from.address;
    this.assertIdentity(account, envelopeFrom);
    if (account.sendRateLimit) {
      this.limiter.consume(account.id, account.sendRateLimit.max, account.sendRateLimit.windowMs);
    }
    let raw = await buildRawMessage(message);
    raw = stripBcc(raw);
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
            from: envelopeFrom,
            to: envelopeTo.map((item) => item.address),
          },
          eightBit: hasHighOctets(raw),
          ...(input.dsn ? { dsn: input.dsn } : {}),
        }),
        () => sender.close(),
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
    const label = formatAddress(original.from[0] ?? { address: 'unknown' });
    const when = loaded.parsed.date ?? 'an unknown date';
    const quoted = quotePlain(loaded.parsed.text || loaded.parsed.htmlAsText || '', label, when);
    const text = `${input.text ?? ''}${input.text ? '\n\n' : ''}${quoted}`;
    const originalHtml = loaded.parsed.html
      ? quoteHtml(loaded.parsed.html, label, when)
      : quoteHtml(textToHtml(loaded.parsed.text || ''), label, when);
    const html = input.html ? `${input.html}${originalHtml}` : originalHtml;
    const sent = await this.send({
      account: account.id,
      to,
      cc,
      subject: input.subject ?? replySubject(loaded.parsed.subject),
      text,
      html,
      attachments: input.attachments,
      inReplyTo: loaded.parsed.messageId,
      references: buildReferences(loaded.parsed.references, loaded.parsed.messageId),
      appendSent: input.appendSent,
    });
    await this.setFlags({
      account: account.id,
      mailbox: input.mailbox,
      uidValidity: input.uidValidity,
      uids: [input.uid],
      flags: ['\\Answered'],
      operation: 'add',
    }).catch(() => undefined);
    return sent;
  }

  async forward(input: ForwardInput): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    const loaded = await this.loadParsed(account, input);
    const label = formatAddress(asMail(loaded.parsed.from)[0] ?? { address: 'unknown' });
    const when = loaded.parsed.date ?? 'an unknown date';
    const quoted = quotePlain(loaded.parsed.text || loaded.parsed.htmlAsText || '', label, when);
    const text = `${input.text ?? ''}${input.text ? '\n\n' : ''}---------- Forwarded message ----------\n${quoted}`;
    const originalHtml = loaded.parsed.html
      ? quoteHtml(loaded.parsed.html, label, when)
      : quoteHtml(textToHtml(loaded.parsed.text || ''), label, when);
    const html = input.html ? `${input.html}${originalHtml}` : originalHtml;
    const source = await this.withMailbox(account, input.mailbox, 'read', async (box) => {
      const limit = account.limits.maxMessageBytes;
      const raw = await box.fetchSource(input.uid, limit + 1);
      if (raw && raw.length > limit) {
        throw new MailError('SIZE_LIMIT', `Message UID ${input.uid} exceeds maxMessageBytes.`);
      }
      return raw;
    });
    const attachments: OutboundAttachment[] = [...(input.attachments ?? [])];
    if (source) {
      attachments.push({
        filename: 'forwarded.eml',
        contentType: 'message/rfc822',
        contentBase64: source.toString('base64'),
      });
    }
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
    const sent = await this.send({
      account: account.id,
      to: input.to,
      cc: input.cc,
      subject: input.subject ?? forwardSubject(loaded.parsed.subject),
      text,
      html,
      attachments,
      appendSent: input.appendSent,
    });
    await this.setFlags({
      account: account.id,
      mailbox: input.mailbox,
      uidValidity: input.uidValidity,
      uids: [input.uid],
      flags: ['$Forwarded'],
      operation: 'add',
    }).catch(() => undefined);
    return sent;
  }

  async sendDraft(input: UidInput & { appendSent?: boolean }): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    assertMutation(account, 'send');
    const source = await this.withMailbox(account, input.mailbox, 'read', async (box) => {
      this.assertUid(box, input.uidValidity);
      const summary = await this.requireSummary(box, input.uid);
      const limit = account.limits.maxMessageBytes;
      if ((summary.size ?? 0) > limit) {
        throw new MailError('SIZE_LIMIT', `Draft UID ${input.uid} exceeds maxMessageBytes.`);
      }
      const raw = await box.fetchSource(input.uid, limit + 1);
      if (raw && raw.length > limit) {
        throw new MailError('SIZE_LIMIT', `Draft UID ${input.uid} exceeds maxMessageBytes.`);
      }
      return raw;
    });
    if (!source) {
      throw new MailError('NOT_FOUND', `Draft UID ${input.uid} was not found.`);
    }
    const parsed = await parseRawMessage(source);
    const recipients = [...asMail(parsed.to), ...asMail(parsed.cc), ...asMail(parsed.bcc)];
    assertRecipients(account, recipients);
    const from = asMail(parsed.from)[0]?.address ?? account.email;
    this.assertIdentity(account, from);
    if (account.sendRateLimit) {
      this.limiter.consume(account.id, account.sendRateLimit.max, account.sendRateLimit.windowMs);
    }
    if (!account.smtp) {
      throw new MailError('CONFIG_ERROR', `Account "${account.id}" has no SMTP server configured.`);
    }
    const wire = stripBcc(source);
    const sender = await this.smtpFactory(account);
    try {
      const result = await sender.send({
        raw: wire,
        envelope: { from, to: recipients.map((item) => item.address) },
        eightBit: hasHighOctets(wire),
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
    // The wait's own deadline is the command budget. The session also raises
    // the IMAP socket timeout for this call. The pool closes the socket if
    // the wait is still running after a short grace.
    return this.withImap(
      account,
      async (session) => {
        const waited = await session.waitForChanges(mailbox, timeoutMs);
        return { ok: true as const, account: account.id, mailbox, ...waited };
      },
      timeoutMs + 500,
    );
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
      let sortSource: 'server' | 'client' | 'uid' = 'uid';
      const limitForPage = clampLimit(
        input.limit,
        account.limits.pageSize,
        account.limits.maxPageSize,
      );
      const decoded = input.cursor ? decodeCursor(input.cursor, box.uidValidity) : undefined;
      const legacyAfterUid = decoded?.v === 2 ? decoded.afterUid : undefined;
      const anchoredAfterUid = decoded?.v === 3 ? decoded.afterUid : undefined;
      const startIndex = decoded?.v === 3 ? (decoded.position ?? 0) : 0;
      const anchor = decoded?.v === 3 ? decoded.anchor : undefined;
      // ESORT PARTIAL is only safe for a fresh page. A later page has to see the
      // whole ordered result so an expunge above the cursor cannot shift the window.
      const freshPage = legacyAfterUid === undefined && anchoredAfterUid === undefined && !anchor;
      const window =
        session.hasCapability('SORT') && session.hasCapability('ESORT') && freshPage
          ? { start: startIndex + 1, count: limitForPage }
          : undefined;
      const serverSorted = session.hasCapability('SORT')
        ? await box.serverSort(compiled, keys, window)
        : null;
      let pageUids: number[];
      let nextCursor: string | null;
      let offset: number;
      let total: number;
      let anchorLookup: Map<number, SortableMessage> | undefined;
      if (serverSorted) {
        const allow = new Set(matched);
        if (serverSorted.partial && freshPage) {
          pageUids = serverSorted.uids.filter((uid) => allow.has(uid));
          total = matched.length;
          offset = startIndex;
          nextCursor = null;
        } else {
          const ordered = serverSorted.uids.filter((uid) => allow.has(uid));
          if (legacyAfterUid !== undefined) {
            const paged = pageAfterUid(ordered, limitForPage, legacyAfterUid, box.uidValidity);
            pageUids = paged.uids;
            nextCursor = paged.nextCursor;
            offset = paged.offset;
          } else {
            const uidMissing =
              anchoredAfterUid !== undefined && !ordered.includes(anchoredAfterUid);
            if (uidMissing && anchor) {
              const summaries = await box.fetchSummaries(ordered, {
                snippet: false,
                snippetChars: 0,
              });
              anchorLookup = new Map(summaries.map((item) => [item.uid, toSortable(item)]));
            }
            const paged = pageAnchored(
              ordered,
              limitForPage,
              {
                position: startIndex,
                ...(anchoredAfterUid !== undefined ? { afterUid: anchoredAfterUid } : {}),
              },
              box.uidValidity,
              anchorLookup && anchor
                ? (uid) => {
                    const item = anchorLookup?.get(uid);
                    return item ? isStrictlyAfter(item, anchor) : false;
                  }
                : undefined,
            );
            pageUids = paged.uids;
            nextCursor = paged.nextCursor;
            offset = paged.offset;
          }
          total = ordered.length;
        }
        sortSource = 'server';
      } else if (matched.length > account.limits.maxSortCandidates) {
        throw new MailError(
          'SIZE_LIMIT',
          `This mailbox slice has ${matched.length} matches and the server does not advertise SORT. The client-side cap is ${account.limits.maxSortCandidates}.`,
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
        const ordered = sortMessages(sortable, keys).map((item) => item.uid);
        anchorLookup = new Map(sortable.map((item) => [item.uid, item]));
        if (legacyAfterUid !== undefined) {
          const paged = pageAfterUid(ordered, limitForPage, legacyAfterUid, box.uidValidity);
          pageUids = paged.uids;
          nextCursor = paged.nextCursor;
          offset = paged.offset;
        } else {
          const paged = pageAnchored(
            ordered,
            limitForPage,
            {
              position: startIndex,
              ...(anchoredAfterUid !== undefined ? { afterUid: anchoredAfterUid } : {}),
            },
            box.uidValidity,
            anchor
              ? (uid) => {
                  const item = anchorLookup?.get(uid);
                  return item ? isStrictlyAfter(item, anchor) : false;
                }
              : undefined,
          );
          pageUids = paged.uids;
          nextCursor = paged.nextCursor;
          offset = paged.offset;
        }
        total = ordered.length;
        sortSource = 'client';
      }
      const messages = await box.fetchSummaries(pageUids, {
        snippet: input.includeSnippet !== false,
        snippetChars: input.snippetChars ?? 160,
      });
      const byUid = new Map(messages.map((item) => [item.uid, item]));
      const orderedMessages = pageUids
        .map((uid) => byUid.get(uid))
        .filter((item): item is MessageSummary => Boolean(item));
      const next = offset + orderedMessages.length;
      if (
        orderedMessages.length > 0 &&
        orderedMessages.length >= limitForPage &&
        next < total &&
        (nextCursor !== null || (serverSorted?.partial && freshPage))
      ) {
        nextCursor = cursorAfterPage(
          orderedMessages[orderedMessages.length - 1],
          next,
          keys,
          box.uidValidity,
        );
      } else if (serverSorted?.partial && freshPage) {
        nextCursor = null;
      }
      return {
        ok: true as const,
        account: account.id,
        mailbox,
        uidValidity: box.uidValidity,
        total,
        offset,
        sort: keys,
        sortSource,
        search: fromSearch,
        messages: orderedMessages.map(publicSummary),
        nextCursor,
      };
    });
  }

  private async withImap<T>(
    account: ResolvedAccount,
    fn: (session: ImapSession) => Promise<T>,
    timeoutMs?: number,
  ): Promise<T> {
    return this.pool.use(account.id, (session) => fn(session), timeoutMs ?? account.imap.timeoutMs);
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

  private assertIdentity(account: ResolvedAccount, from: string): void {
    this.resolveFrom(account, from);
  }

  private assertBulk(uids: number[], max: number): void {
    if (uids.length === 0) {
      throw new MailError('INVALID_ARGUMENT', 'uids must contain at least one UID.');
    }
    if (uids.length > max) {
      throw new MailError(
        'SIZE_LIMIT',
        `This call has ${uids.length} UIDs and the configured maximum is ${max}.`,
        'Lower the UID list or raise limits.maxBulk.',
      );
    }
  }

  private async confineAttachments(
    account: ResolvedAccount,
    attachments: OutboundAttachment[],
  ): Promise<OutboundAttachment[]> {
    const root = this.config.attachmentsDir;
    const out: OutboundAttachment[] = [];
    for (const attachment of attachments) {
      if (!attachment.path) {
        out.push(attachment);
        continue;
      }
      if (!root) {
        throw new MailError(
          'PERMISSION_DENIED',
          'Attachment path reads require attachmentsDir to be configured.',
        );
      }
      const file = await confineToRoot(attachment.path, root);
      const content = await readBoundedFile(file, account.limits.maxMessageBytes);
      const next: OutboundAttachment = {
        ...attachment,
        contentBase64: content.toString('base64'),
      };
      delete next.path;
      out.push(next);
    }
    return out;
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
      const limit = account.limits.maxMessageBytes;
      const source = await box.fetchSource(input.uid, limit + 1);
      if (source && source.length > limit) {
        throw new MailError('SIZE_LIMIT', `Message UID ${input.uid} exceeds maxMessageBytes.`);
      }
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
      message.attachments = await this.confineAttachments(account, input.attachments);
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
    if (!match && parsed.address.toLowerCase() !== account.email.toLowerCase()) {
      throw new MailError(
        'PERMISSION_DENIED',
        `From address ${parsed.address} is not a configured identity for account "${account.id}".`,
        `Identities: ${account.identities.map((item) => item.email).join(', ')}.`,
      );
    }
    if (!parsed.name && match?.name) {
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
      return {
        ok: false,
        code: mapped.code,
        message: redactText(mapped.message, this.config.secrets),
        hint: mapped.hint ? redactText(mapped.hint, this.config.secrets) : null,
      };
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
      return {
        ok: false,
        code: sender.code,
        message: redactText(sender.message, this.config.secrets),
        hint: sender.hint ? redactText(sender.hint, this.config.secrets) : null,
      };
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
      return {
        ok: false,
        code: mapped.code,
        message: redactText(mapped.message, this.config.secrets),
        hint: mapped.hint ? redactText(mapped.hint, this.config.secrets) : null,
      };
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
    const wanted = stripCid(input.cid);
    const found = parsed.attachments.find((item) => item.cid && stripCid(item.cid) === wanted);
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
    throw new MailError('PERMISSION_DENIED', 'savePath requires attachmentsDir to be configured.');
  }
  const rootAbs = path.resolve(root);
  const relative = path.relative(rootAbs, absolute);
  const parts = relative.split(path.sep).filter((part) => part.length > 0);
  if (parts.includes('..') || path.isAbsolute(relative)) {
    throw new MailError(
      'PERMISSION_DENIED',
      'savePath is outside the configured attachmentsDir.',
      `Writes are confined to ${rootAbs}.`,
    );
  }
  return absolute;
}

function requireAttachmentsDir(root: string | undefined): string {
  if (!root) {
    throw new MailError('PERMISSION_DENIED', 'savePath requires attachmentsDir to be configured.');
  }
  return root;
}

function stripCid(value: string): string {
  return value.trim().replace(/^<|>$/g, '').toLowerCase();
}

function toSortable(item: MessageSummary): SortableMessage {
  return {
    uid: item.uid,
    arrival: item.internalDate,
    date: item.date,
    from: item.from[0]?.address ?? item.from[0]?.name,
    to: item.to[0]?.address ?? item.to[0]?.name,
    cc: item.cc[0]?.address,
    subject: item.subject,
    size: item.size,
  };
}

function cursorAfterPage(
  last: MessageSummary | undefined,
  next: number,
  keys: readonly SortKey[],
  uidValidity: string,
): string | null {
  if (!last) {
    return null;
  }
  const primary = keys[0] ?? { field: 'arrival', reverse: true };
  return encodeCursor({
    v: 3,
    position: next,
    afterUid: last.uid,
    uidValidity,
    anchor: anchorOf(toSortable(last), primary),
  });
}

function flagResults(
  uids: number[],
  update: { updated: number[]; modified: number[]; missing: number[] },
): Array<{ uid: number; ok: boolean; code?: string; message?: string }> {
  const updated = new Set(update.updated);
  const modified = new Set(update.modified);
  const missing = new Set(update.missing);
  return uids.map((uid) => {
    if (updated.has(uid)) {
      return { uid, ok: true };
    }
    if (missing.has(uid)) {
      return { uid, ok: false, code: 'NOT_FOUND', message: `UID ${uid} was not in the mailbox.` };
    }
    if (modified.has(uid)) {
      return {
        uid,
        ok: false,
        code: 'PROTOCOL_ERROR',
        message: `UID ${uid} was not updated because its mod-sequence is newer than unchangedSince.`,
      };
    }
    return { uid, ok: false, code: 'PROTOCOL_ERROR', message: `UID ${uid} was not updated.` };
  });
}

function pruneThreads(nodes: ThreadNode[], allow: Set<number>): ThreadNode[] {
  const pruned: ThreadNode[] = [];
  for (const node of nodes) {
    const children = pruneThreads(node.children, allow);
    if ((node.uid !== undefined && allow.has(node.uid)) || children.length > 0) {
      pruned.push({ ...node, children });
    }
  }
  return pruned;
}

function locatePart(
  structure: BodyNode | null,
  input: DownloadInput,
): { partId: string; filename?: string; contentType: string } {
  const flat = flattenParts(structure);
  if (input.partIndex !== undefined) {
    const found = flat[input.partIndex];
    if (!found) {
      throw new MailError('NOT_FOUND', `Attachment index ${input.partIndex} does not exist.`);
    }
    return found;
  }
  if (input.filename) {
    const found = flat.find((item) => item.filename === input.filename);
    if (!found) {
      throw new MailError('NOT_FOUND', `No attachment named "${input.filename}".`);
    }
    return found;
  }
  if (input.cid) {
    const wanted = stripCid(input.cid);
    const found = flat.find((item) => item.cid && stripCid(item.cid) === wanted);
    if (!found) {
      throw new MailError('NOT_FOUND', `No attachment with cid "${input.cid}".`);
    }
    return found;
  }
  const attachment = flat.find((item) => item.disposition === 'attachment' || item.filename);
  if (!attachment) {
    throw new MailError('NOT_FOUND', 'The message has no attachment.');
  }
  return attachment;
}

function flattenParts(node: BodyNode | null): Array<{
  partId: string;
  filename?: string;
  contentType: string;
  disposition?: string;
  cid?: string;
}> {
  if (!node) {
    return [];
  }
  const self = isAttachmentNode(node)
    ? [
        {
          partId: node.part || '1',
          filename: node.dispositionParameters.filename || node.parameters.name,
          contentType:
            `${node.type}/${node.subtype ?? ''}`.replace(/\/$/, '') || 'application/octet-stream',
          disposition: node.disposition,
          cid: node.id,
        },
      ]
    : [];
  return [...self, ...node.children.flatMap((child) => flattenParts(child))];
}

/** Same attachment set mail_get_message lists: not the text or html body. */
function isAttachmentNode(node: BodyNode): boolean {
  if (node.children.length > 0) {
    return false;
  }
  const type = `${node.type}/${node.subtype ?? ''}`.toLowerCase();
  if (type.startsWith('multipart/')) {
    return false;
  }
  const filename = node.dispositionParameters.filename || node.parameters.name;
  const disposition = (node.disposition ?? '').toLowerCase();
  if (disposition === 'attachment' || filename || node.id) {
    return true;
  }
  return type !== 'text/plain' && type !== 'text/html';
}

function textFromPart(content: Buffer, contentType: string | undefined): string | null {
  const type = (contentType ?? '').toLowerCase();
  if (!type.startsWith('text/')) {
    return null;
  }
  const text = content.toString('utf8');
  return type.startsWith('text/html') ? sanitizeHtml(text) : text;
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
