import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MailError } from '../errors.js';
import { confineToRoot, readBoundedFile } from '../fs-sandbox.js';
import { redactText } from '../redact.js';
import type { AppConfig, ResolvedAccount } from '../config/schema.js';
import { requireAccount } from '../config/load.js';
import type { Logger } from '../log.js';
import { SlidingWindowLimiter } from '../rate-limit.js';
import { assertMutation, assertRecipients } from '../safety.js';
import type { ImapPool } from '../imap/pool.js';
import { assertSearchCapabilities, compileSearch, type SearchCriteria } from '../imap/search.js';
import type { SortKey } from '../imap/sort.js';
import {
  cursorLimit,
  folderPayload,
  listHeaders,
  pageKeyList,
  pageLimit,
  pageServerUids,
  pageSummaryRows,
  readPageCursor,
  resolveOrder,
  rowFromSummary,
  rowsFromScans,
  scanFolders,
  scopeFor,
  snapshotOf,
  type PageRequest,
  type SummaryRow,
} from './browse.js';
import {
  parseFolderRequest,
  resolveFolderPaths,
  defaultThreadFolders,
  type ListedFolder,
} from '../folders.js';
import { selectIdentity, type IdentityChoice } from '../identities.js';
import {
  applySubjectHeuristic,
  buildTree,
  chronological,
  closeByHeaders,
  dedupeMessages,
  normalizeMessageId,
  threadKeyFor,
  type ConversationMessage,
  type LinkKind,
} from '../thread/walk.js';
import {
  assertCursorFits,
  DEFAULT_THREAD_MESSAGES,
  DEFAULT_THREAD_ROUNDS,
  DEFAULT_TOP_N,
  encodeSnapshotCursor,
  MAX_THREAD_MESSAGES,
  pageKeys,
  MAX_THREAD_ROUNDS,
  MAX_TOP_N,
  type PageOrder,
} from '../page/snapshot.js';
import { dialTarget } from '../net/connect.js';
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
import {
  flattenThread,
  normalizedSubject,
  threadMessages,
  type ThreadNode,
} from '../mime/thread.js';
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
    page?: PageRequest,
  ): Promise<Record<string, unknown>> {
    const account = this.account(accountId);
    return this.withImap(account, async (session) => {
      const mailboxes = (await session.listMailboxes({ subscribedOnly })).map(publicMailbox);
      const cursor = readPageCursor(page?.cursor);
      const { order } = resolveOrder({ order: page?.order });
      const limit = pageLimit(
        cursorLimit(cursor, page?.limit, account.limits.pageSize),
        account.limits.pageSize,
        account.limits.maxPageSize,
        false,
      );
      const keys = mailboxes.map((item) => String(item.path));
      const paged = pageKeyList(keys, {
        limit,
        order,
        ...(cursor ? { cursor } : {}),
        scope: `mailboxes:${subscribedOnly ? 'sub' : 'all'}`,
        sort: [{ field: 'arrival', reverse: order === 'newest-first' }],
      });
      const byPath = new Map(mailboxes.map((item) => [String(item.path), item]));
      const items = paged.keys.map((key) => byPath.get(key)).filter((item) => item !== undefined);
      return {
        ok: true as const,
        account: account.id,
        mailboxes: items,
        items,
        nextCursor: paged.nextCursor,
        total: paged.total,
        offset: paged.offset,
        truncated: false,
        order,
        snapshot: { folders: [], keys: cursor?.keys ?? [...keys].sort() },
      };
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
    const cursor = readPageCursor(input.cursor);
    const { order } = resolveOrder({ order: input.order });
    const limit = pageLimit(
      cursorLimit(cursor, input.limit, account.limits.pageSize),
      account.limits.pageSize,
      account.limits.maxPageSize,
      false,
    );
    return this.withImap(account, async (session) => {
      const paths = await this.folderPaths(account, session, input);
      const mailbox = paths[0] ?? input.mailbox ?? 'INBOX';
      const maxPerFolder = this.perFolderCap(input.maxPerFolder, account.limits.maxSortCandidates);
      const compiled = compileSearch(input.search);
      assertSearchCapabilities(compiled.requires, (name) => session.hasCapability(name));
      const scope = scopeFor(paths, input.search, maxPerFolder, `threads:${algorithm}`);
      const { scans } = await scanFolders(session, paths, {
        compiled,
        keys: [{ field: 'arrival', reverse: order !== 'oldest-first' }],
        order,
        ...(cursor ? { cursor } : {}),
        maxPerFolder,
        ...(paths.length === 1 && input.uidValidity
          ? { singleUidValidity: input.uidValidity }
          : {}),
        materialize: true,
      });
      const folders = folderPayload(scans);
      let source: 'server' | 'client' = 'client';
      if (
        paths.length === 1 &&
        (session.hasCapability('THREAD') || session.hasCapability(`THREAD=${algorithm}`))
      ) {
        const serverThreads = await session.withMailbox(mailbox, 'read', (box) =>
          box.serverThread(algorithm, compiled),
        );
        if (serverThreads) {
          source = 'server';
        }
      }
      const summaries = scans.flatMap((scan) =>
        scan.summaries.map((summary) => ({
          summary,
          mailbox: scan.mailbox,
          uidValidity: scan.uidValidity,
        })),
      );
      const threads = threadMessages(
        summaries.map((item) => ({
          uid: item.summary.uid,
          messageId: item.summary.messageId,
          inReplyTo: item.summary.inReplyTo,
          references: item.summary.references,
          subject: item.summary.subject,
        })),
        algorithm === 'ORDEREDSUBJECT',
      );
      const byUid = new Map(
        summaries.map((item) => [`${item.mailbox}\0${item.summary.uid}`, item]),
      );
      const link: LinkKind = algorithm === 'ORDEREDSUBJECT' ? 'subject' : 'header';
      const roots = threads
        .map((node) => threadSummary(node, mailbox, byUid, link))
        .filter(
          (item): item is NonNullable<ReturnType<typeof threadSummary>> => item !== undefined,
        );
      const page = pageSummaryRows(roots, {
        limit,
        keys: [{ field: 'date', reverse: order !== 'oldest-first' }],
        order,
        ...(cursor ? { cursor } : {}),
        scope,
        folders,
      });
      const pageUids = new Set(page.items.map((item) => item.uid));
      const omitted = scans.reduce((sum, scan) => sum + scan.omitted, 0);
      const items = page.items.map((item) => {
        const row = item as NonNullable<ReturnType<typeof threadSummary>>;
        return {
          threadKey: row.threadKey,
          messageCount: row.messageCount,
          participants: row.participants,
          lastDate: row.date ?? row.arrival ?? null,
          unreadCount: row.unreadCount,
          mailbox: item.mailbox,
          uid: item.uid,
          uidValidity: item.uidValidity,
          linked: link,
        };
      });
      return {
        ok: true as const,
        account: account.id,
        mailbox,
        uidValidity: folders[0]?.uidValidity ?? '',
        algorithm,
        source,
        total: page.total,
        offset: page.offset,
        omitted,
        truncated: scans.some((scan) => scan.truncated),
        threads: pruneThreads(threads, pageUids),
        uids: page.items.map((item) => item.uid),
        items,
        nextCursor: page.nextCursor,
        order,
        snapshot: snapshotOf(scans),
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
      : await buildRawMessage((await this.outboundFromParts(account, input)).message);
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
    const built = await this.outboundFromParts(account, { ...input, allowEmptyRecipients: true });
    const raw = await buildRawMessage(built.message, {
      keepBcc: true,
    });
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
      ...publicIdentity(built.identity),
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
    const built = await this.outboundFromParts(account, input);
    const identity = input.identityChoice ?? built.identity;
    const message = built.message;
    if (input.identityChoice) {
      message.from = input.identityChoice.address;
    }
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
        ...publicIdentity(identity),
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
    const identity = selectIdentity({
      identities: account.identities,
      accountEmail: account.email,
      allowFromDomains: account.allowFromDomains,
      ...(input.from ? { requested: input.from } : {}),
      ...(!input.from
        ? { recipients: [...original.to, ...original.cc].map((item) => item.address) }
        : {}),
    });
    const sent = await this.send({
      account: account.id,
      from: identity.address,
      identityChoice: identity,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
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
    const original = {
      to: asMail(loaded.parsed.to),
      cc: asMail(loaded.parsed.cc),
    };
    const identity = selectIdentity({
      identities: account.identities,
      accountEmail: account.email,
      allowFromDomains: account.allowFromDomains,
      ...(input.from ? { requested: input.from } : {}),
      ...(!input.from
        ? { recipients: [...original.to, ...original.cc].map((item) => item.address) }
        : {}),
    });
    const sent = await this.send({
      account: account.id,
      from: identity.address,
      identityChoice: identity,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
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

  async sendDraft(
    input: UidInput & {
      appendSent?: boolean;
      from?: string | MailAddress;
      replyTo?: Array<string | MailAddress>;
    },
  ): Promise<Record<string, unknown>> {
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
    const draftedFrom = asMail(parsed.from)[0]?.address ?? account.email;
    const identity = selectIdentity({
      identities: account.identities,
      accountEmail: account.email,
      allowFromDomains: account.allowFromDomains,
      requested: input.from ?? draftedFrom,
    });
    const from = identity.address.address;
    if (account.sendRateLimit) {
      this.limiter.consume(account.id, account.sendRateLimit.max, account.sendRateLimit.windowMs);
    }
    if (!account.smtp) {
      throw new MailError('CONFIG_ERROR', `Account "${account.id}" has no SMTP server configured.`);
    }
    let wire = stripBcc(source);
    if (input.from || input.replyTo) {
      const built = await this.outboundFromParts(account, {
        from: identity.address,
        to: asMail(parsed.to),
        cc: asMail(parsed.cc),
        bcc: asMail(parsed.bcc),
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        subject: parsed.subject,
        ...(parsed.text !== undefined ? { text: parsed.text } : {}),
        ...(parsed.html !== undefined ? { html: parsed.html } : {}),
        attachments: parsed.attachments
          .filter((item) => item.content && !item.inline)
          .map((item) => ({
            ...(item.filename ? { filename: item.filename } : {}),
            contentType: item.contentType,
            contentBase64: item.content?.toString('base64') ?? '',
          })),
        ...(parsed.messageId ? { headers: { 'Message-ID': parsed.messageId } } : {}),
      });
      built.message.from = identity.address;
      wire = stripBcc(await buildRawMessage(built.message));
    }
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
        ...publicIdentity(identity),
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

  async getThread(input: {
    account?: string;
    mailbox?: string;
    uid?: number;
    uidValidity?: string;
    messageId?: string;
    folders?: unknown;
    includeBodies?: boolean;
    onlyUnread?: boolean;
    subjectHeuristic?: boolean;
    maxMessages?: number;
    maxRounds?: number;
    limit?: number;
    cursor?: string;
    order?: PageOrder;
  }): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    if ((input.uid === undefined) === (input.messageId === undefined) && input.uid === undefined) {
      throw new MailError('INVALID_ARGUMENT', 'Pass mailbox and uid, or a messageId.');
    }
    if (input.uid !== undefined && !input.mailbox) {
      throw new MailError('INVALID_ARGUMENT', 'mailbox is required with uid.');
    }
    const maxMessages = bounded(input.maxMessages, DEFAULT_THREAD_MESSAGES, MAX_THREAD_MESSAGES);
    const maxRounds = bounded(input.maxRounds, DEFAULT_THREAD_ROUNDS, MAX_THREAD_ROUNDS);
    const cursor = readPageCursor(input.cursor);
    const { order } = resolveOrder({ ...(input.order ? { order: input.order } : {}) });
    const limit = pageLimit(
      cursorLimit(cursor, input.limit, account.limits.pageSize),
      account.limits.pageSize,
      account.limits.maxPageSize,
      input.includeBodies === true,
    );
    return this.withImap(account, async (session) => {
      const special = await this.special(account, session);
      const seed = await this.seedMessage(session, input);
      const paths =
        input.folders !== undefined
          ? await this.folderPaths(account, session, {
              folders: input.folders,
              mailbox: seed.mailbox,
            })
          : defaultThreadFolders(seed.mailbox, special);
      let messages: ConversationMessage[];
      let rounds = 0;
      let truncated: boolean;
      const fast = await this.fastThread(session, paths, seed, maxMessages);
      if (fast) {
        messages = fast.messages;
        truncated = fast.truncated;
      } else {
        const closed = await closeByHeaders({
          seed,
          folders: paths,
          maxMessages,
          maxRounds,
          search: (folder, ids) => this.searchHeaderIds(session, folder, ids),
        });
        messages = closed.messages;
        rounds = closed.rounds;
        truncated = closed.truncated;
      }
      if (input.subjectHeuristic) {
        const candidates = await this.subjectCandidates(session, paths, seed);
        const applied = applySubjectHeuristic(messages, candidates, maxMessages);
        messages = applied.messages;
        truncated = truncated || applied.truncated;
      }
      const prefer = [
        input.mailbox ?? seed.mailbox,
        'INBOX',
        special.sent ?? '',
        special.archive ?? '',
      ];
      messages = dedupeMessages(messages, prefer);
      if (input.onlyUnread) {
        messages = messages.filter((item) => !item.flags.includes('\\Seen'));
      }
      const ordered = chronological(messages, order !== 'oldest-first');
      const rows: SummaryRow[] = ordered.map((item) => ({
        mailbox: item.mailbox,
        uid: item.uid,
        uidValidity: item.uidValidity,
        date: item.date,
        arrival: item.internalDate,
        subject: item.subject,
        from: item.from[0]?.address,
        to: item.to[0]?.address,
        cc: item.cc[0]?.address,
        summary: {
          uid: item.uid,
          flags: item.flags,
          date: item.date,
          internalDate: item.internalDate,
          subject: item.subject,
          messageId: item.messageId,
          inReplyTo: item.inReplyTo,
          references: item.references,
          from: item.from,
          to: item.to,
          cc: item.cc,
          replyTo: [],
          hasAttachments: item.hasAttachments,
          snippet: item.snippet,
          threadId: item.threadId,
        },
      }));
      const folders = paths.map((mailbox) => ({
        mailbox,
        uidValidity: rows.find((row) => row.mailbox === mailbox)?.uidValidity ?? seed.uidValidity,
        upperUid: 0,
        matched: rows.filter((row) => row.mailbox === mailbox).length,
        scanned: rows.filter((row) => row.mailbox === mailbox).length,
        omitted: 0,
        truncated: false,
      }));
      const scope = scopeFor(
        paths,
        undefined,
        maxMessages,
        `thread:${normalizeMessageId(seed.messageId) || seed.uid}`,
      );
      const page = pageSummaryRows(rows, {
        limit,
        keys: [{ field: 'date', reverse: order !== 'oldest-first' }],
        order,
        ...(cursor ? { cursor } : {}),
        scope,
        folders,
      });
      const items = [];
      for (const row of page.items) {
        const source = ordered.find((item) => item.mailbox === row.mailbox && item.uid === row.uid);
        let text: string | null = null;
        let textTruncated = false;
        if (input.includeBodies && source) {
          const body = await session.withMailbox(row.mailbox, 'read', async (box) => {
            const raw = await box.fetchSource(row.uid, account.limits.maxMessageBytes);
            return raw ? parseRawMessage(raw) : null;
          });
          if (body) {
            const capped = capText(body.text, account.limits.maxBodyChars);
            text = capped.text ?? null;
            textTruncated = capped.truncated;
          }
        }
        items.push({
          mailbox: row.mailbox,
          uid: row.uid,
          uidValidity: row.uidValidity,
          messageId: source?.messageId ?? null,
          from: source?.from ?? [],
          to: source?.to ?? [],
          cc: source?.cc ?? [],
          date: source?.date ?? source?.internalDate ?? null,
          subject: source?.subject ?? null,
          flags: source?.flags ?? [],
          snippet: source?.snippet ?? null,
          hasAttachments: source?.hasAttachments ?? false,
          linked: source?.linked ?? 'header',
          alsoIn: source?.alsoIn ?? [],
          threadKey: threadKeyFor(seed),
          ...(input.includeBodies ? { text, textTruncated } : {}),
        });
      }
      const root = ordered[0] ?? seed;
      return {
        ok: true as const,
        account: account.id,
        threadKey: threadKeyFor(root.messageId ? root : seed),
        tree: buildTree(ordered),
        rounds,
        items,
        messages: items,
        nextCursor: page.nextCursor,
        total: page.total,
        offset: page.offset,
        truncated: truncated || folders.some((folder) => folder.truncated),
        order,
        snapshot: { folders },
      };
    });
  }

  async countMessages(input: ListInput): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    const cursor = readPageCursor(input.cursor);
    const { order } = resolveOrder({ ...(input.order ? { order: input.order } : {}) });
    const limit = pageLimit(
      cursorLimit(cursor, input.limit, account.limits.pageSize),
      account.limits.pageSize,
      account.limits.maxPageSize,
      false,
    );
    return this.withImap(account, async (session) => {
      const paths = await this.folderPaths(account, session, input);
      const scope = scopeFor(paths, input.search, 0, 'count');
      const paged = pageKeyList(paths, {
        limit,
        order,
        ...(cursor ? { cursor } : {}),
        scope,
        sort: [{ field: 'arrival', reverse: order === 'newest-first' }],
      });
      const compiled = input.search ? compileSearch(input.search) : undefined;
      if (compiled) {
        assertSearchCapabilities(compiled.requires, (name) => session.hasCapability(name));
      }
      const items = [];
      for (const mailbox of paged.keys) {
        const status = await session.status(mailbox);
        let matches: number | null = null;
        if (compiled) {
          matches = await session.withMailbox(
            mailbox,
            'read',
            async (box) => (await box.search(compiled)).length,
          );
        }
        items.push({
          mailbox,
          messages: status.messages ?? null,
          unseen: status.unseen ?? null,
          recent: status.recent ?? null,
          uidNext: status.uidNext ?? null,
          uidValidity: status.uidValidity ?? null,
          matches,
        });
      }
      return {
        ok: true as const,
        account: account.id,
        items,
        nextCursor: paged.nextCursor,
        total: paged.total,
        offset: paged.offset,
        truncated: false,
        order,
        snapshot: { folders: [], keys: cursor?.keys ?? [...paths].sort() },
      };
    });
  }

  async listAttachments(input: ListInput): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    const cursor = readPageCursor(input.cursor);
    const { order } = resolveOrder({
      ...(input.sort ? { sort: input.sort } : {}),
      ...(input.order ? { order: input.order } : {}),
    });
    const limit = pageLimit(
      cursorLimit(cursor, input.limit, account.limits.pageSize),
      account.limits.pageSize,
      account.limits.maxPageSize,
      false,
    );
    const maxPerFolder = this.perFolderCap(input.maxPerFolder, account.limits.maxSortCandidates);
    return this.withImap(account, async (session) => {
      const paths = await this.folderPaths(account, session, input);
      const compiled = compileSearch(input.search);
      assertSearchCapabilities(compiled.requires, (name) => session.hasCapability(name));
      const scope = scopeFor(paths, input.search, maxPerFolder, 'attachments');
      const { scans } = await scanFolders(session, paths, {
        compiled,
        keys: [{ field: 'arrival', reverse: order !== 'oldest-first' }],
        order,
        maxPerFolder,
        materialize: true,
      });
      const attachments: SummaryRow[] = [];
      for (const scan of scans) {
        for (const summary of scan.summaries) {
          if (!summary.hasAttachments) {
            continue;
          }
          const structure = await session.withMailbox(scan.mailbox, 'read', (box) =>
            box.fetchStructure(summary.uid),
          );
          for (const part of flattenParts(structure)) {
            attachments.push({
              ...rowFromSummary(scan, summary),
              uid: summary.uid,
              subject: part.filename ?? summary.subject,
              summary,
              partId: part.partId,
              filename: part.filename ?? null,
              contentType: part.contentType,
              partSize: part.contentType ? (summary.size ?? 0) : 0,
            } as SummaryRow);
          }
        }
      }
      const page = pageSummaryRows(attachments, {
        limit,
        keys: [{ field: 'date', reverse: order !== 'oldest-first' }],
        order,
        ...(cursor ? { cursor } : {}),
        scope,
        folders: folderPayload(scans),
      });
      const items = page.items.map((row) => {
        const extra = row as SummaryRow & {
          partId?: string;
          filename?: string | null;
          contentType?: string;
        };
        return {
          mailbox: row.mailbox,
          uid: row.uid,
          uidValidity: row.uidValidity,
          partId: extra.partId ?? '1',
          filename: extra.filename ?? null,
          contentType: extra.contentType ?? 'application/octet-stream',
          size: row.summary.size ?? null,
          subject: row.summary.subject ?? null,
          date: row.date ?? row.arrival ?? null,
        };
      });
      return {
        ok: true as const,
        account: account.id,
        items,
        nextCursor: page.nextCursor,
        total: page.total,
        offset: page.offset,
        truncated: scans.some((scan) => scan.truncated),
        order,
        snapshot: snapshotOf(scans),
      };
    });
  }

  async listCorrespondents(input: ListInput & { top?: number }): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    const cursor = readPageCursor(input.cursor);
    const { order } = resolveOrder({ ...(input.order ? { order: input.order } : {}) });
    const limit = pageLimit(
      cursorLimit(cursor, input.limit, account.limits.pageSize),
      account.limits.pageSize,
      account.limits.maxPageSize,
      false,
    );
    const maxPerFolder = this.perFolderCap(input.maxPerFolder, account.limits.maxSortCandidates);
    return this.withImap(account, async (session) => {
      const paths = await this.folderPaths(account, session, input);
      const compiled = compileSearch(input.search);
      assertSearchCapabilities(compiled.requires, (name) => session.hasCapability(name));
      const { scans } = await scanFolders(session, paths, {
        compiled,
        keys: [{ field: 'arrival', reverse: true }],
        order: 'newest-first',
        maxPerFolder,
        materialize: true,
      });
      const own = new Set(
        ownAddressesOf(account.email, account.identities, account.user).map((item) =>
          item.toLowerCase(),
        ),
      );
      const counts = new Map<string, number>();
      let scanned = 0;
      for (const scan of scans) {
        for (const summary of scan.summaries) {
          scanned += 1;
          for (const address of summary.from) {
            const email = address.address?.trim().toLowerCase();
            if (!email || own.has(email)) {
              continue;
            }
            counts.set(email, (counts.get(email) ?? 0) + 1);
          }
        }
      }
      const ranked = [...counts.entries()].sort((left, right) => {
        if (right[1] !== left[1]) {
          return right[1] - left[1];
        }
        return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
      });
      const scope = scopeFor(paths, input.search, maxPerFolder, 'correspondents');
      const keys = ranked.map((item) => item[0]);
      const frozen = cursor?.keys ?? keys;
      if (cursor) {
        assertCursorFits(cursor, {
          scope,
          order,
          sort: [{ field: 'arrival', reverse: order === 'newest-first' }],
          cap: limit,
          folders: folderPayload(scans).map((folder) => ({
            mailbox: folder.mailbox,
            uidValidity: folder.uidValidity,
          })),
        });
      }
      const slice = pageKeys(frozen, limit, cursor?.anchorKey);
      const byAddress = new Map(ranked);
      const items = slice.keys.map((address) => ({ address, count: byAddress.get(address) ?? 0 }));
      const last = slice.keys[slice.keys.length - 1];
      const nextCursor =
        last && slice.next
          ? encodeSnapshotCursor({
              v: 4,
              order,
              sort: [{ field: 'arrival', reverse: order === 'newest-first' }],
              cap: limit,
              scope,
              folders: folderPayload(scans).map((folder) => ({
                mailbox: folder.mailbox,
                uidValidity: folder.uidValidity,
                upperUid: folder.upperUid,
              })),
              keys: frozen,
              anchorKey: last,
            })
          : null;
      return {
        ok: true as const,
        account: account.id,
        items,
        nextCursor,
        total: frozen.length,
        offset: slice.offset,
        truncated: scans.some((scan) => scan.truncated),
        scanned,
        order,
        snapshot: snapshotOf(scans),
      };
    });
  }

  async searchFacets(input: ListInput & { top?: number }): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    const top = bounded(input.top, DEFAULT_TOP_N, MAX_TOP_N);
    const maxPerFolder = this.perFolderCap(input.maxPerFolder, account.limits.maxSortCandidates);
    return this.withImap(account, async (session) => {
      const paths = await this.folderPaths(account, session, input);
      const compiled = compileSearch(input.search);
      assertSearchCapabilities(compiled.requires, (name) => session.hasCapability(name));
      const folders = [];
      const senders = new Map<string, number>();
      const domains = new Map<string, number>();
      let attachments = 0;
      let scanned = 0;
      let truncated = false;
      for (const mailbox of paths) {
        const row = await session.withMailbox(mailbox, 'read', async (box) => {
          const matched = await box.search(compiled);
          const unseen = await box.search(andFlag(compiled, 'seen', false));
          const flagged = await box.search(andFlag(compiled, 'flagged', true));
          const answered = await box.search(andFlag(compiled, 'answered', true));
          let ids = matched;
          let omitted = 0;
          if (ids.length > maxPerFolder) {
            ids = [...ids].sort((left, right) => left - right).slice(-maxPerFolder);
            omitted = matched.length - ids.length;
            truncated = true;
          }
          const summaries = await box.fetchSummaries(ids, { snippet: false, snippetChars: 0 });
          scanned += summaries.length;
          let folderAttachments = 0;
          for (const summary of summaries) {
            if (summary.hasAttachments) {
              folderAttachments += 1;
              attachments += 1;
            }
            const from = summary.from[0]?.address?.trim().toLowerCase();
            if (from) {
              senders.set(from, (senders.get(from) ?? 0) + 1);
              const domain = from.split('@')[1];
              if (domain) {
                domains.set(domain, (domains.get(domain) ?? 0) + 1);
              }
            }
          }
          return {
            mailbox,
            uidValidity: box.uidValidity,
            total: matched.length,
            unread: unseen.length,
            flagged: flagged.length,
            answered: answered.length,
            hasAttachments: folderAttachments,
            scanned: summaries.length,
            omitted,
            truncated: omitted > 0,
          };
        });
        folders.push(row);
      }
      return {
        ok: true as const,
        account: account.id,
        folders,
        hasAttachments: attachments,
        senders: topCounts(senders, top),
        domains: topCounts(domains, top),
        scanned,
        truncated,
        top,
      };
    });
  }

  async modifyBySearch(
    input: ListInput & {
      action: 'addFlags' | 'removeFlags' | 'move' | 'archive';
      flags?: string[];
      destination?: string;
      dryRun?: boolean;
    },
  ): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    const dryRun = input.dryRun !== false;
    const cursor = readPageCursor(input.cursor);
    const { keys, order } = resolveOrder({
      ...(input.sort ? { sort: input.sort } : {}),
      ...(input.order ? { order: input.order } : {}),
    });
    const limit = pageLimit(
      cursorLimit(cursor, input.limit, account.limits.pageSize),
      account.limits.pageSize,
      account.limits.maxPageSize,
      false,
    );
    const maxPerFolder = this.perFolderCap(input.maxPerFolder, account.limits.maxSortCandidates);
    if (!dryRun) {
      if (input.action === 'move' || input.action === 'archive') {
        assertMutation(account, 'delete');
      } else if (touchesDeleted(normalizeFlags(input.flags ?? []))) {
        assertMutation(account, 'delete');
      } else {
        assertMutation(account, 'message-write');
      }
    }
    return this.withImap(account, async (session) => {
      const paths = await this.folderPaths(account, session, input);
      const compiled = compileSearch(input.search);
      assertSearchCapabilities(compiled.requires, (name) => session.hasCapability(name));
      const scope = scopeFor(paths, input.search, maxPerFolder, `bulk:${input.action}`);
      const { scans } = await scanFolders(session, paths, {
        compiled,
        keys,
        order,
        maxPerFolder,
        materialize: true,
      });
      const matched = scans.reduce((sum, scan) => sum + scan.matched, 0);
      if (!dryRun && matched > account.limits.maxBulk) {
        throw new MailError(
          'SIZE_LIMIT',
          `The search matches ${matched} messages and the bulk maximum is ${account.limits.maxBulk}.`,
          'Narrow the search or raise limits.maxBulk. A dry run can preview them.',
        );
      }
      const rows = rowsFromScans(scans);
      if (!dryRun) {
        const destination =
          input.action === 'archive'
            ? (input.destination ?? (await this.special(account, session)).archive)
            : input.destination;
        if ((input.action === 'move' || input.action === 'archive') && !destination) {
          throw new MailError('NOT_FOUND', 'No destination mailbox could be resolved.');
        }
        for (const scan of scans) {
          const uids = scan.summaries.map((item) => item.uid);
          if (uids.length === 0) {
            continue;
          }
          await session.withMailbox(scan.mailbox, 'write', async (box) => {
            if (input.action === 'addFlags' || input.action === 'removeFlags') {
              await box.setFlags(
                uids,
                normalizeFlags(input.flags ?? []),
                input.action === 'addFlags' ? 'add' : 'remove',
              );
            } else if (destination) {
              await box.move(uids, destination);
            }
          });
        }
      }
      const page = pageSummaryRows(rows, {
        limit,
        keys,
        order,
        ...(cursor ? { cursor } : {}),
        scope,
        folders: folderPayload(scans),
      });
      const items = page.items.map((row) => ({
        mailbox: row.mailbox,
        uid: row.uid,
        uidValidity: row.uidValidity,
        subject: row.summary.subject ?? null,
        date: row.date ?? row.arrival ?? null,
      }));
      return {
        ok: true as const,
        account: account.id,
        dryRun,
        action: input.action,
        matched,
        items,
        nextCursor: dryRun ? page.nextCursor : null,
        total: page.total,
        offset: page.offset,
        truncated: scans.some((scan) => scan.truncated),
        order,
        snapshot: snapshotOf(scans),
      };
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
    const cursor = readPageCursor(input.cursor);
    const { keys, order } = resolveOrder({
      ...(input.sort ? { sort: input.sort } : {}),
      ...(input.order ? { order: input.order } : {}),
    });
    const limit = pageLimit(
      cursorLimit(cursor, input.limit, account.limits.pageSize),
      account.limits.pageSize,
      account.limits.maxPageSize,
      false,
    );
    const maxPerFolder = this.perFolderCap(input.maxPerFolder, account.limits.maxSortCandidates);
    return this.withImap(account, async (session) => {
      const paths = await this.folderPaths(account, session, input);
      const compiled = compileSearch(input.search);
      assertSearchCapabilities(compiled.requires, (name) => session.hasCapability(name));
      const scope = scopeFor(paths, input.search, maxPerFolder, JSON.stringify(keys));
      const { scans, sortSource } = await scanFolders(session, paths, {
        compiled,
        keys,
        order,
        ...(cursor ? { cursor } : {}),
        maxPerFolder,
        ...(paths.length === 1 && input.uidValidity
          ? { singleUidValidity: input.uidValidity }
          : {}),
      });
      const folders = folderPayload(scans);
      const mailbox = paths[0] ?? 'INBOX';
      const single = scans.length === 1 ? scans[0] : undefined;
      const serverUids = single?.serverUids;
      const anchorMissing = Boolean(
        cursor?.anchor && serverUids && !serverUids.includes(cursor.anchor.uid),
      );
      if (serverUids && single && !anchorMissing) {
        const paged = pageServerUids(serverUids, cursor?.anchor?.uid, limit);
        const summaries = await session.withMailbox(single.mailbox, 'read', (box) =>
          box.fetchSummaries(paged.pageUids, {
            snippet: input.includeSnippet !== false,
            snippetChars: input.snippetChars ?? 160,
          }),
        );
        const byUid = new Map(summaries.map((item) => [item.uid, item]));
        const ordered = paged.pageUids
          .map((uid) => byUid.get(uid))
          .filter((item): item is MessageSummary => Boolean(item));
        const rows = ordered.map((summary) => rowFromSummary(single, summary));
        const decorated = await this.decorateRows(session, rows);
        const last = rows[rows.length - 1];
        const more = paged.offset + ordered.length < paged.total;
        const nextCursor =
          last && more
            ? encodeSnapshotCursor({
                v: 4,
                order,
                sort: [...keys],
                cap: limit,
                scope,
                folders: folders.map((folder) => ({
                  mailbox: folder.mailbox,
                  uidValidity: folder.uidValidity,
                  upperUid: folder.upperUid,
                })),
                anchor: {
                  mailbox: last.mailbox,
                  uid: last.uid,
                  date: last.date ?? last.arrival ?? '',
                  field: keys[0]?.field ?? 'arrival',
                  reverse: Boolean(keys[0]?.reverse),
                  value: scalar(last, keys[0]?.field ?? 'arrival'),
                },
              })
            : null;
        if (cursor) {
          assertCursorFits(cursor, { scope, order, sort: keys, cap: limit, folders });
        }
        return this.messagePage(account.id, mailbox, single.uidValidity, {
          total: paged.total,
          offset: paged.offset,
          sort: keys,
          sortSource,
          search: fromSearch,
          messages: decorated,
          nextCursor,
          order,
          truncated: single.truncated,
          snapshot: snapshotOf(scans),
          folders: paths,
        });
      }
      if (single?.serverUids && single.summaries.length === 0) {
        const ids =
          single.serverUids.length > maxPerFolder
            ? single.serverUids.slice(0, maxPerFolder)
            : single.serverUids;
        single.truncated = single.truncated || ids.length < single.serverUids.length;
        single.omitted += single.serverUids.length - ids.length;
        single.summaries = await session.withMailbox(single.mailbox, 'read', (box) =>
          box.fetchSummaries(ids, { snippet: false, snippetChars: 0 }),
        );
        single.scanned = single.summaries.length;
      }
      const page = pageSummaryRows(rowsFromScans(scans), {
        limit,
        keys,
        order,
        ...(cursor ? { cursor } : {}),
        scope,
        folders: folderPayload(scans),
      });
      const snippetRows = await this.withSnippets(session, page.items, input);
      const decorated = await this.decorateRows(session, snippetRows);
      return this.messagePage(account.id, mailbox, folders[0]?.uidValidity ?? '', {
        total: page.total,
        offset: page.offset,
        sort: keys,
        sortSource,
        search: fromSearch,
        messages: decorated,
        nextCursor: page.nextCursor,
        order,
        truncated: scans.some((scan) => scan.truncated),
        snapshot: snapshotOf(scans),
        folders: paths,
      });
    });
  }

  private messagePage(
    accountId: string,
    mailbox: string,
    uidValidity: string,
    page: {
      total: number;
      offset: number;
      sort: readonly SortKey[];
      sortSource: 'server' | 'client';
      search: boolean;
      messages: Array<Record<string, unknown>>;
      nextCursor: string | null;
      order: PageOrder;
      truncated: boolean;
      snapshot: { folders: unknown };
      folders: string[];
    },
  ): Record<string, unknown> {
    return {
      ok: true as const,
      account: accountId,
      mailbox,
      uidValidity,
      total: page.total,
      offset: page.offset,
      sort: page.sort,
      sortSource: page.sortSource,
      search: page.search,
      messages: page.messages,
      items: page.messages,
      nextCursor: page.nextCursor,
      order: page.order,
      truncated: page.truncated,
      snapshot: page.snapshot,
      folders: page.folders,
    };
  }

  private perFolderCap(requested: number | undefined, max: number): number {
    const cap = requested ?? max;
    if (!Number.isInteger(cap) || cap < 1) {
      throw new MailError('INVALID_ARGUMENT', 'maxPerFolder must be a positive integer.');
    }
    if (cap > max) {
      throw new MailError(
        'SIZE_LIMIT',
        `maxPerFolder ${cap} is above the configured maximum of ${max}.`,
        'Raise limits.maxSortCandidates.',
      );
    }
    return cap;
  }

  private async folderPaths(
    account: ResolvedAccount,
    session: ImapSession,
    input: { mailbox?: string; folders?: unknown },
  ): Promise<string[]> {
    if (input.folders === undefined) {
      return [input.mailbox ?? 'INBOX'];
    }
    const listed = await session.listMailboxes();
    const special = await this.special(account, session);
    return resolveFolderPaths(listed.map(listedFolder), special, parseFolderRequest(input.folders))
      .paths;
  }

  private async withSnippets(
    session: ImapSession,
    rows: readonly SummaryRow[],
    input: { includeSnippet?: boolean; snippetChars?: number },
  ): Promise<SummaryRow[]> {
    if (input.includeSnippet === false || rows.length === 0) {
      return [...rows];
    }
    const grouped = groupRows(rows);
    const out: SummaryRow[] = [];
    for (const [mailbox, items] of grouped) {
      const summaries = await session.withMailbox(mailbox, 'read', (box) =>
        box.fetchSummaries(
          items.map((item) => item.uid),
          { snippet: true, snippetChars: input.snippetChars ?? 160 },
        ),
      );
      const byUid = new Map(summaries.map((item) => [item.uid, item]));
      for (const item of items) {
        const summary = byUid.get(item.uid);
        out.push(summary ? { ...item, summary } : item);
      }
    }
    return out;
  }

  private async decorateRows(
    session: ImapSession,
    rows: readonly SummaryRow[],
  ): Promise<Array<Record<string, unknown>>> {
    const grouped = groupRows(rows);
    const headers = new Map<string, ReturnType<typeof listHeaders>>();
    for (const [mailbox, items] of grouped) {
      await session.withMailbox(mailbox, 'read', async (box) => {
        for (const item of items) {
          headers.set(`${mailbox}\0${item.uid}`, listHeaders(await box.fetchHeaders(item.uid)));
        }
      });
    }
    return rows.map((row) =>
      publicSummary(row.summary, {
        mailbox: row.mailbox,
        uidValidity: row.uidValidity,
        ...(headers.get(`${row.mailbox}\0${row.uid}`) ?? {
          listUnsubscribe: null,
          listId: null,
          autoSubmitted: null,
        }),
      }),
    );
  }

  private async seedMessage(
    session: ImapSession,
    input: { mailbox?: string; uid?: number; uidValidity?: string; messageId?: string },
  ): Promise<ConversationMessage> {
    if (input.uid !== undefined && input.mailbox) {
      return session.withMailbox(input.mailbox, 'read', async (box) => {
        this.assertUid(box, input.uidValidity);
        const summary = await this.requireSummary(box, input.uid ?? 0);
        return this.conversationFrom(box, summary, input.mailbox ?? 'INBOX', 'header');
      });
    }
    const id = normalizeMessageId(input.messageId);
    if (!id) {
      throw new MailError('INVALID_ARGUMENT', 'messageId is empty.');
    }
    const listed = await session.listMailboxes();
    for (const mailbox of listed.map((item) => item.path)) {
      const found = await this.searchHeaderIds(session, mailbox, [id]);
      const exact = found.find((item) => normalizeMessageId(item.messageId) === id);
      if (exact) {
        return { ...exact, linked: 'header' };
      }
    }
    throw new MailError('NOT_FOUND', `No message with Message-ID ${input.messageId} was found.`);
  }

  private async conversationFrom(
    box: OpenMailbox,
    summary: MessageSummary,
    mailbox: string,
    linked: LinkKind,
  ): Promise<ConversationMessage> {
    const raw = await box.fetchHeaders(summary.uid);
    const text = raw?.toString('utf8') ?? '';
    const headers = listHeaders(raw);
    const references = summary.references ?? messageIds(headerValue(text, 'references'));
    const inReply = summary.inReplyTo ?? messageIds(headerValue(text, 'in-reply-to'))[0];
    const message: ConversationMessage = {
      mailbox,
      uid: summary.uid,
      uidValidity: box.uidValidity,
      references,
      from: summary.from,
      to: summary.to,
      cc: summary.cc,
      flags: summary.flags,
      hasAttachments: summary.hasAttachments,
      linked,
    };
    const messageId = summary.messageId ?? headerValue(text, 'message-id');
    if (messageId) {
      message.messageId = messageId;
    }
    if (inReply) {
      message.inReplyTo = inReply;
    }
    if (summary.subject) {
      message.subject = summary.subject;
    }
    if (summary.date) {
      message.date = summary.date;
    }
    if (summary.internalDate) {
      message.internalDate = summary.internalDate;
    }
    if (summary.snippet) {
      message.snippet = summary.snippet;
    }
    if (summary.threadId) {
      message.threadId = summary.threadId;
    }
    if (headers.listUnsubscribe) {
      message.listUnsubscribe = headers.listUnsubscribe;
    }
    if (headers.listId) {
      message.listId = headers.listId;
    }
    if (headers.autoSubmitted) {
      message.autoSubmitted = headers.autoSubmitted;
    }
    return message;
  }

  private async searchHeaderIds(
    session: ImapSession,
    folder: string,
    ids: readonly string[],
  ): Promise<ConversationMessage[]> {
    if (ids.length === 0) {
      return [];
    }
    const clauses = ids.flatMap((id) => [
      { header: { name: 'Message-ID', value: id } },
      { header: { name: 'References', value: id } },
      { header: { name: 'In-Reply-To', value: id } },
    ]);
    const criteria: SearchCriteria =
      clauses.length === 1 && clauses[0] ? clauses[0] : { or: clauses };
    const compiled = compileSearch(criteria);
    return session.withMailbox(folder, 'read', async (box) => {
      const uids = await box.search(compiled);
      const summaries = await box.fetchSummaries(uids, { snippet: true, snippetChars: 160 });
      const found: ConversationMessage[] = [];
      for (const summary of summaries) {
        found.push(await this.conversationFrom(box, summary, folder, 'header'));
      }
      return found;
    });
  }

  private async fastThread(
    session: ImapSession,
    folders: readonly string[],
    seed: ConversationMessage,
    maxMessages: number,
  ): Promise<{ messages: ConversationMessage[]; truncated: boolean } | null> {
    if (!seed.threadId) {
      return null;
    }
    const gmail = session.hasCapability('X-GM-EXT-1');
    const objectId = session.hasCapability('OBJECTID');
    if (!gmail && !objectId) {
      return null;
    }
    const linked: LinkKind = gmail ? 'gmail-thrid' : 'objectid';
    const compiled = compileSearch({ threadId: seed.threadId });
    assertSearchCapabilities(compiled.requires, (name) => session.hasCapability(name));
    const messages: ConversationMessage[] = [];
    let truncated = false;
    for (const folder of folders) {
      const found = await session.withMailbox(folder, 'read', async (box) => {
        const uids = await box.search(compiled);
        const summaries = await box.fetchSummaries(uids, { snippet: true, snippetChars: 160 });
        const rows: ConversationMessage[] = [];
        for (const summary of summaries) {
          if (messages.length + rows.length >= maxMessages) {
            truncated = true;
            break;
          }
          rows.push(await this.conversationFrom(box, summary, folder, linked));
        }
        return rows;
      });
      messages.push(...found);
    }
    if (!messages.some((item) => item.mailbox === seed.mailbox && item.uid === seed.uid)) {
      messages.unshift(seed);
    }
    return { messages, truncated };
  }

  private async subjectCandidates(
    session: ImapSession,
    folders: readonly string[],
    seed: ConversationMessage,
  ): Promise<ConversationMessage[]> {
    const subject = normalizedSubject(seed.subject);
    if (!subject) {
      return [];
    }
    const compiled = compileSearch({ subject });
    const found: ConversationMessage[] = [];
    for (const folder of folders) {
      const rows = await session.withMailbox(folder, 'read', async (box) => {
        const uids = (await box.search(compiled)).slice(0, 200);
        const summaries = await box.fetchSummaries(uids, { snippet: false, snippetChars: 0 });
        const messages: ConversationMessage[] = [];
        for (const summary of summaries) {
          messages.push(await this.conversationFrom(box, summary, folder, 'subject'));
        }
        return messages;
      });
      found.push(...rows);
    }
    return found;
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
  ): Promise<{ message: OutboundMessage; identity: IdentityChoice }> {
    const identity = this.resolveFrom(account, input.from);
    const from = identity.address;
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
    return { message, identity };
  }

  private resolveFrom(account: ResolvedAccount, from?: string | MailAddress): IdentityChoice {
    return selectIdentity({
      identities: account.identities,
      accountEmail: account.email,
      allowFromDomains: account.allowFromDomains,
      ...(from ? { requested: from } : {}),
    });
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
      const dial = dialTarget(account.imap);
      return await this.withImap(account, async (session) => ({
        ok: true,
        host: account.imap.host,
        port: account.imap.port,
        secure: account.imap.secure,
        connectHost: dial.host,
        connectPort: dial.port,
        servername: dial.servername,
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
      const dial = dialTarget(account.smtp);
      return {
        ok: true,
        host: account.smtp.host,
        port: account.smtp.port,
        secure: account.smtp.secure,
        connectHost: dial.host,
        connectPort: dial.port,
        servername: dial.servername,
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

function publicSummary(
  summary: MessageSummary,
  extra: {
    mailbox: string;
    uidValidity: string;
    listUnsubscribe: string | null;
    listId: string | null;
    autoSubmitted: string | null;
  },
): Record<string, unknown> {
  return {
    uid: summary.uid,
    mailbox: extra.mailbox,
    uidValidity: extra.uidValidity,
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
    listUnsubscribe: extra.listUnsubscribe,
    listId: extra.listId,
    autoSubmitted: extra.autoSubmitted,
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
    listId: parsed.headers['list-id'] ?? null,
    listUnsubscribe: parsed.headers['list-unsubscribe'] ?? null,
    autoSubmitted: parsed.headers['auto-submitted'] ?? null,
    authenticationResults: parsed.headers['authentication-results'] ?? null,
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

function publicIdentity(choice: IdentityChoice): {
  identity: { id: string | null; email: string; name?: string };
  identityReason: string;
} {
  return {
    identity: {
      id: choice.id,
      email: choice.email,
      ...(choice.name ? { name: choice.name } : {}),
    },
    identityReason: choice.reason,
  };
}

function bounded(value: number | undefined, fallback: number, max: number): number {
  const size = value ?? fallback;
  if (!Number.isInteger(size) || size < 1 || size > max) {
    throw new MailError('INVALID_ARGUMENT', `Value must be an integer from 1 to ${max}.`);
  }
  return size;
}

function andFlag(
  compiled: { query: Record<string, unknown>; requires: Array<'gmail' | 'condstore' | 'objectid'> },
  flag: 'seen' | 'flagged' | 'answered',
  value: boolean,
): { query: Record<string, unknown>; requires: Array<'gmail' | 'condstore' | 'objectid'> } {
  if (Object.keys(compiled.query).length === 1 && compiled.query.all === true) {
    return { query: { [flag]: value }, requires: [...compiled.requires] };
  }
  return {
    query: { not: { or: [{ not: compiled.query }, { not: { [flag]: value } }] } },
    requires: [...compiled.requires],
  };
}

function topCounts(
  counts: Map<string, number>,
  top: number,
): Array<{ value: string; count: number }> {
  return [...counts.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
    })
    .slice(0, top)
    .map(([value, count]) => ({ value, count }));
}

function listedFolder(mailbox: MailboxInfo): ListedFolder {
  return mailbox.specialUse
    ? { path: mailbox.path, specialUse: mailbox.specialUse }
    : { path: mailbox.path };
}

function groupRows(rows: readonly SummaryRow[]): Map<string, SummaryRow[]> {
  const grouped = new Map<string, SummaryRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.mailbox);
    if (list) {
      list.push(row);
    } else {
      grouped.set(row.mailbox, [row]);
    }
  }
  return grouped;
}

function scalar(row: SummaryRow, field: SortKey['field']): string {
  if (field === 'size') {
    return row.size === undefined ? '' : String(row.size);
  }
  return row[field] ?? '';
}

function threadSummary(
  node: ThreadNode,
  mailbox: string,
  byUid: Map<string, { summary: MessageSummary; mailbox: string; uidValidity: string }>,
  link: LinkKind,
):
  | (SummaryRow & {
      participants: string[];
      messageCount: number;
      unreadCount: number;
      threadKey: string;
      linked: LinkKind;
    })
  | undefined {
  const messages = flattenThread([node])
    .map((uid) => byUid.get(`${mailbox}\0${uid}`))
    .filter((item): item is { summary: MessageSummary; mailbox: string; uidValidity: string } =>
      Boolean(item),
    );
  const first = messages[0];
  if (!first) {
    return undefined;
  }
  let latest = first;
  const participants = new Set<string>();
  let unread = 0;
  for (const item of messages) {
    const stamp = item.summary.date || item.summary.internalDate || '';
    const best = latest.summary.date || latest.summary.internalDate || '';
    if (stamp > best) {
      latest = item;
    }
    if (!item.summary.flags.includes('\\Seen')) {
      unread += 1;
    }
    for (const address of [...item.summary.from, ...item.summary.to, ...item.summary.cc]) {
      if (address.address) {
        participants.add(address.address.toLowerCase());
      }
    }
  }
  const row = rowFromSummary(latest, latest.summary);
  row.date = latest.summary.date || latest.summary.internalDate;
  row.arrival = latest.summary.internalDate;
  const rootId = first.summary.messageId;
  return {
    ...row,
    participants: [...participants].sort(),
    messageCount: messages.length,
    unreadCount: unread,
    threadKey: threadKeyFor({
      messageId: rootId,
      mailbox: first.mailbox,
      uid: first.summary.uid,
      uidValidity: first.uidValidity,
    }),
    linked: link,
  };
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
  folders?: unknown;
  search?: SearchCriteria;
  sort?: SortKey[];
  order?: PageOrder;
  limit?: number;
  cursor?: string;
  uidValidity?: string;
  includeSnippet?: boolean;
  snippetChars?: number;
  maxPerFolder?: number;
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
  from?: string | MailAddress;
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
  identityChoice?: IdentityChoice;
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
  from?: string | MailAddress;
  replyTo?: Array<string | MailAddress>;
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
  from?: string | MailAddress;
  replyTo?: Array<string | MailAddress>;
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
