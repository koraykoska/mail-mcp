import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MailError } from '../errors.js';
import { confineToRoot, ensureAttachmentsDir, readBoundedFile } from '../fs-sandbox.js';
import { redactText } from '../redact.js';
import type { AppConfig, ResolvedAccount } from '../config/schema.js';
import { requireAccount } from '../config/load.js';
import type { Logger } from '../log.js';
import { SlidingWindowLimiter } from '../rate-limit.js';
import { assertMutation, assertRecipients } from '../safety.js';
import type { ImapPool } from '../imap/pool.js';
import {
  andSearchQuery,
  assertSearchCapabilities,
  compileSearch,
  type SearchCriteria,
} from '../imap/search.js';
import { currentRequestSignal } from '../request-context.js';
import { isolateNotFound, MAX_BULK_BUDGET_MS, runInChunks, type ChunkProgress } from './bulk.js';
import type { SortKey } from '../imap/sort.js';
import {
  cursorLimit,
  folderPayload,
  listHeaders,
  pageKeyList,
  pageLimit,
  fetchSummariesBatched,
  MAX_EXACT_SCAN,
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
  comparePath,
  defaultThreadFolders,
  mailboxSelectable,
  uniquePaths,
  type ListedFolder,
} from '../folders.js';
import { selectIdentity, type IdentityChoice } from '../identities.js';
import {
  applySubjectHeuristic,
  buildTree,
  chronological,
  closeByHeaders,
  conversationThreadKey,
  dedupeMessages,
  keepWithinCap,
  normalizeMessageId,
  type ConversationMessage,
  type LinkKind,
} from '../thread/walk.js';
import {
  assertCursorFits,
  capExcludedFolders,
  decodeSnapshotCursor,
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
import { boundedCommandTimeout } from '../config/schema.js';
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
import {
  assertDraftHeaders,
  guardOutboundHeaders,
  readRawHeaderFields,
  replyAddresses,
} from '../mime/outbound-headers.js';
import { buildReferences, forwardSubject, replySubject } from '../mime/subject.js';
import {
  flattenThread,
  normalizedSubject,
  stampMailbox,
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
        ...(identity.replyTo ? { replyTo: identity.replyTo } : {}),
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
      const target = await this.writeInsideAttachments(input.savePath, file.content);
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
      const summaries = scans.flatMap((scan) =>
        scan.summaries.map((summary) => ({
          summary,
          mailbox: scan.mailbox,
          uidValidity: scan.uidValidity,
        })),
      );
      let source: 'server' | 'client' = 'client';
      let threads: ThreadNode[] = [];
      if (
        paths.length === 1 &&
        (session.hasCapability('THREAD') || session.hasCapability(`THREAD=${algorithm}`))
      ) {
        const serverThreads = await session.withMailbox(mailbox, 'read', (box) =>
          box.serverThread(algorithm, compiled),
        );
        if (serverThreads) {
          source = 'server';
          threads = stampMailbox(serverThreads, mailbox);
        }
      }
      if (source === 'client') {
        threads = threadMessages(
          summaries.map((item) => ({
            uid: item.summary.uid,
            mailbox: item.mailbox,
            messageId: item.summary.messageId,
            inReplyTo: item.summary.inReplyTo,
            references: item.summary.references,
            subject: item.summary.subject,
            date: item.summary.date || item.summary.internalDate,
          })),
          algorithm === 'ORDEREDSUBJECT',
        );
      }
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
      const pageUids = new Set(page.items.map((item) => `${item.mailbox}\0${item.uid}`));
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
    const paused = (): Record<string, unknown> => ({
      ...budgetPaused(input.uids),
      account: account.id,
      mailbox: input.mailbox,
      uids: [],
      operation: input.operation,
      flags,
    });
    return this.withBulk(
      account,
      (session, plan) => {
        if (Date.now() >= plan.budgetDeadline) {
          return Promise.resolve(paused());
        }
        return session.withMailbox(input.mailbox, 'write', async (box) => {
          this.assertUid(box, input.uidValidity);
          if (replaceMayClearDeleted) {
            const summaries = await box.fetchSummaries(input.uids, {
              snippet: false,
              snippetChars: 0,
            });
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
          if (Date.now() >= plan.budgetDeadline) {
            return paused();
          }
          const progress = await runInChunks({
            uids: input.uids,
            budgetMs: Math.max(0, plan.budgetDeadline - Date.now()),
            signal: currentRequestSignal(),
            beforeChunk: () => this.armChunk(session, account, plan, plan.budgetDeadline),
            onChunk: (chunk) =>
              continueChunk(chunk, async () => {
                const update = await box.setFlags(
                  chunk,
                  flags,
                  input.operation,
                  input.unchangedSince,
                );
                return flagResults(chunk, update);
              }),
          });
          return {
            ...progressFields(progress),
            account: account.id,
            mailbox: input.mailbox,
            uids: progress.results.filter((item) => item.ok).map((item) => item.uid),
            operation: input.operation,
            flags,
            results: progress.results,
          };
        });
      },
      { onTimeout: paused },
    );
  }

  async copyOrMove(
    input: TransferInput,
    move: boolean,
    window?: BulkWindow,
  ): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    assertMutation(account, move ? 'delete' : 'message-write');
    this.assertBulk(input.uids, account.limits.maxBulk);
    const paused = (): Record<string, unknown> => ({
      ...budgetPaused(input.uids),
      account: account.id,
      mailbox: input.mailbox,
      destination: input.destination,
      move,
    });
    return this.withBulk(
      account,
      (session, plan) => {
        if (Date.now() >= plan.budgetDeadline) {
          return Promise.resolve(paused());
        }
        return session.withMailbox(input.mailbox, 'write', async (box) => {
          this.assertUid(box, input.uidValidity);
          if (move && !session.moveSupported() && !session.uidPlusSupported()) {
            throw new MailError(
              'CAPABILITY_UNSUPPORTED',
              'This server has neither MOVE nor UIDPLUS. Copying and then expunging would remove every \\Deleted message, not only the requested UIDs.',
              'Use a server with MOVE or UIDPLUS. allowPermanentDelete is not consent to expunge unrelated messages.',
            );
          }
          if (Date.now() >= plan.budgetDeadline) {
            return paused();
          }
          const progress = await runInChunks({
            uids: input.uids,
            budgetMs: Math.max(0, plan.budgetDeadline - Date.now()),
            signal: currentRequestSignal(),
            beforeChunk: () => this.armChunk(session, account, plan, plan.budgetDeadline),
            onChunk: (chunk) =>
              continueChunk(chunk, async () => {
                if (!move) {
                  const map = await box.copy(chunk, input.destination);
                  return chunk.map((uid) => ({
                    uid,
                    ok: true,
                    value: map[String(uid)] ?? null,
                  }));
                }
                const moved = await box.move(chunk, input.destination);
                return chunk.map((uid) => {
                  if (moved.kept.includes(uid)) {
                    return {
                      uid,
                      ok: false,
                      code: 'PROTOCOL_ERROR',
                      message:
                        'The copy was not confirmed with COPYUID, so the original was left in place.',
                    };
                  }
                  return { uid, ok: true, value: moved.map[String(uid)] ?? null };
                });
              }),
          });
          return {
            ...progressFields(progress),
            account: account.id,
            mailbox: input.mailbox,
            destination: input.destination,
            move,
            results: progress.results,
          };
        });
      },
      { onTimeout: paused, ...(window ? { window } : {}) },
    );
  }

  async deleteMessages(input: DeleteInput): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    if (input.permanent) {
      assertMutation(account, 'permanent');
      const paused = (): Record<string, unknown> => ({
        ...budgetPaused(input.uids),
        account: account.id,
        mailbox: input.mailbox,
        permanent: true,
        uids: [],
      });
      return this.withBulk(
        account,
        (session, plan) => {
          if (Date.now() >= plan.budgetDeadline) {
            return Promise.resolve(paused());
          }
          return session.withMailbox(input.mailbox, 'write', async (box) => {
            this.assertUid(box, input.uidValidity);
            if (!session.uidPlusSupported()) {
              throw new MailError(
                'CAPABILITY_UNSUPPORTED',
                'Permanent delete of specific UIDs requires UIDPLUS. Without it, EXPUNGE removes every \\Deleted message in the mailbox.',
                'Move the messages to Trash, or use a server that advertises UIDPLUS.',
              );
            }
            if (Date.now() >= plan.budgetDeadline) {
              return paused();
            }
            const progress = await runInChunks({
              uids: input.uids,
              budgetMs: Math.max(0, plan.budgetDeadline - Date.now()),
              signal: currentRequestSignal(),
              beforeChunk: () => this.armChunk(session, account, plan, plan.budgetDeadline),
              onChunk: (chunk) =>
                continueChunk(chunk, async () => {
                  await box.expunge(chunk);
                  return chunk.map((uid) => ({ uid, ok: true, value: true }));
                }),
            });
            return {
              ...progressFields(progress),
              account: account.id,
              mailbox: input.mailbox,
              permanent: true,
              uids: progress.results.filter((item) => item.ok).map((item) => item.uid),
              results: progress.results,
            };
          });
        },
        { onTimeout: paused },
      );
    }
    assertMutation(account, 'delete');
    const window = this.bulkWindow(account);
    const pausedMove = (): Record<string, unknown> => ({
      ...budgetPaused(input.uids),
      account: account.id,
      mailbox: input.mailbox,
      move: true,
    });
    let trash: string | undefined;
    try {
      trash = await this.withImap(
        account,
        async (session) => (await this.special(account, session)).trash,
        undefined,
        window.poolDeadline,
      );
    } catch (error) {
      if (error instanceof MailError && error.code === 'TIMEOUT') {
        return pausedMove();
      }
      throw error;
    }
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
    return this.copyOrMove({ ...input, destination: trash }, true, window);
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
    this.assertBulk(input.uids, account.limits.maxBulk);
    const paused = (): Record<string, unknown> => ({
      ...budgetPaused(input.uids),
      account: account.id,
      mailbox: input.mailbox,
      uids: [],
      labels: input.labels,
      operation: input.operation,
    });
    return this.withBulk(
      account,
      (session, plan) => {
        if (Date.now() >= plan.budgetDeadline) {
          return Promise.resolve(paused());
        }
        return session.withMailbox(input.mailbox, 'write', async (box) => {
          this.assertUid(box, input.uidValidity);
          if (Date.now() >= plan.budgetDeadline) {
            return paused();
          }
          const progress = await runInChunks({
            uids: input.uids,
            budgetMs: Math.max(0, plan.budgetDeadline - Date.now()),
            signal: currentRequestSignal(),
            beforeChunk: () => this.armChunk(session, account, plan, plan.budgetDeadline),
            onChunk: (chunk) =>
              isolateNotFound(chunk, async (slice) => {
                try {
                  await box.setLabels(slice, input.labels, input.operation);
                  return slice.map((uid) => ({ uid, ok: true }));
                } catch (error) {
                  const mapped =
                    error instanceof MailError
                      ? error
                      : new MailError('PROTOCOL_ERROR', 'The UID operation failed.');
                  if (mapped.code === 'CAPABILITY_UNSUPPORTED') {
                    throw mapped;
                  }
                  if (mapped.code === 'TIMEOUT' || mapped.code === 'CONNECTION_FAILED') {
                    throw mapped;
                  }
                  if (mapped.code === 'NOT_FOUND' && slice.length > 1) {
                    throw mapped;
                  }
                  return slice.map((uid) => ({
                    uid,
                    ok: false,
                    code: mapped.code,
                    message: mapped.message,
                  }));
                }
              }),
          });
          return {
            ...progressFields(progress),
            account: account.id,
            mailbox: input.mailbox,
            uids: progress.results.filter((item) => item.ok).map((item) => item.uid),
            labels: input.labels,
            operation: input.operation,
            results: progress.results,
          };
        });
      },
      { onTimeout: paused },
    );
  }

  async bulk(input: BulkInput): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    this.assertBulk(input.uids, account.limits.maxBulk);
    if ((input.action === 'copy' || input.action === 'move') && !input.destination) {
      throw new MailError('INVALID_ARGUMENT', 'destination is required for copy and move.');
    }
    const window = this.bulkWindow(account);
    const paused = (): Record<string, unknown> => ({
      ...budgetPaused(input.uids),
      account: account.id,
      mailbox: input.mailbox,
      action: input.action,
    });
    let trash: string | undefined;
    if (input.action === 'delete' && !input.permanent) {
      try {
        trash = await this.withImap(
          account,
          async (session) => (await this.special(account, session)).trash,
          undefined,
          window.poolDeadline,
        );
      } catch (error) {
        if (error instanceof MailError && error.code === 'TIMEOUT') {
          return paused();
        }
        throw error;
      }
    }
    if (input.action === 'delete' && !input.permanent) {
      assertMutation(account, 'delete');
      if (!trash) {
        throw new MailError('NOT_FOUND', 'No Trash mailbox could be resolved.');
      }
      if (input.mailbox === trash) {
        throw new MailError(
          'INVALID_ARGUMENT',
          'These messages are already in Trash. Pass permanent true to expunge them.',
        );
      }
    }
    if (
      input.action === 'copy' ||
      input.action === 'addLabels' ||
      input.action === 'removeLabels'
    ) {
      assertMutation(account, 'message-write');
    } else if (input.action === 'move') {
      assertMutation(account, 'delete');
    } else if (input.action === 'delete' && input.permanent) {
      assertMutation(account, 'permanent');
    } else if (
      input.action === 'addFlags' ||
      input.action === 'removeFlags' ||
      input.action === 'setFlags'
    ) {
      const flags = normalizeFlags(input.flags ?? []);
      if (touchesDeleted(flags)) {
        assertMutation(account, 'delete');
      } else if (input.action !== 'setFlags') {
        assertMutation(account, 'message-write');
      }
    }
    return this.withBulk(
      account,
      (session, plan) => {
        if (Date.now() >= plan.budgetDeadline) {
          return Promise.resolve(paused());
        }
        return session.withMailbox(input.mailbox, 'write', async (box) => {
          this.assertUid(box, input.uidValidity);
          if (input.action === 'setFlags' && !touchesDeleted(normalizeFlags(input.flags ?? []))) {
            const summaries = await box.fetchSummaries(input.uids, {
              snippet: false,
              snippetChars: 0,
            });
            const clearsDeleted = summaries.some((item) =>
              item.flags.some((flag) => flag.toLowerCase() === '\\deleted'),
            );
            assertMutation(account, clearsDeleted ? 'delete' : 'message-write');
          }
          if (
            (input.action === 'move' || (input.action === 'delete' && !input.permanent)) &&
            !session.moveSupported() &&
            !session.uidPlusSupported()
          ) {
            throw new MailError(
              'CAPABILITY_UNSUPPORTED',
              'This server has neither MOVE nor UIDPLUS. Copying and then expunging would remove every \\Deleted message, not only the requested UIDs.',
            );
          }
          if (input.action === 'delete' && input.permanent && !session.uidPlusSupported()) {
            throw new MailError(
              'CAPABILITY_UNSUPPORTED',
              'Permanent delete of specific UIDs requires UIDPLUS.',
            );
          }
          if (Date.now() >= plan.budgetDeadline) {
            return paused();
          }
          const progress = await runInChunks({
            uids: input.uids,
            budgetMs: Math.max(0, plan.budgetDeadline - Date.now()),
            signal: currentRequestSignal(),
            beforeChunk: () => this.armChunk(session, account, plan, plan.budgetDeadline),
            onChunk: (chunk) => this.bulkChunk(input, box, session, chunk, trash),
          });
          return {
            ...progressFields(progress),
            account: account.id,
            mailbox: input.mailbox,
            action: input.action,
            results: progress.results,
          };
        });
      },
      { onTimeout: paused, window },
    );
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
    const prior =
      replaceUid === undefined
        ? undefined
        : await this.preservedThreading(account, drafts, replaceUid, input.uidValidity);
    const built = await this.outboundFromParts(account, {
      ...input,
      allowEmptyRecipients: true,
      ...(prior?.threading ?? {}),
    });
    if (input.identityChoice) {
      built.identity = input.identityChoice;
      built.message.from = input.identityChoice.address;
    }
    const raw = await buildRawMessage(built.message, {
      keepBcc: true,
    });
    if (raw.length > account.limits.maxMessageBytes) {
      throw new MailError('SIZE_LIMIT', `Message is ${raw.length} bytes, over maxMessageBytes.`);
    }
    const appended = await this.withImap(account, (session) =>
      session.append(drafts, raw, ['\\Draft']),
    );
    if (replaceUid === undefined) {
      return {
        ok: true as const,
        account: account.id,
        mailbox: drafts,
        ...appended,
        replacedUid: null,
        ...publicIdentity(built.identity),
      };
    }
    // The appended UID can equal the old UID when the mailbox was recreated and
    // UIDVALIDITY changed. Deleting that number would remove the new draft.
    if (appended.uid === replaceUid) {
      return {
        ok: false,
        account: account.id,
        mailbox: drafts,
        ...appended,
        replacedUid: null,
        warning: `Draft UID ${replaceUid} is the message just appended, so it was not deleted. The new draft was kept as UID ${replaceUid}.`,
        ...publicIdentity(built.identity),
      };
    }
    const removal = await this.removeReplacedDraft(account, drafts, replaceUid, prior?.uidValidity);
    const removed = removal === 'removed';
    return {
      ok: removed,
      account: account.id,
      mailbox: drafts,
      ...appended,
      replacedUid: removed ? replaceUid : null,
      ...(removed
        ? {}
        : {
            warning: draftReplaceWarning(removal, drafts, replaceUid, appended.uid),
          }),
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
    const composed = await this.composeReply(input);
    const sent = await this.send({
      ...composed.parts,
      identityChoice: composed.identity,
      appendSent: input.appendSent,
    });
    await this.setFlags({
      account: composed.parts.account,
      mailbox: input.mailbox,
      uidValidity: input.uidValidity,
      uids: [input.uid],
      flags: ['\\Answered'],
      operation: 'add',
    }).catch(() => undefined);
    return sent;
  }

  async saveReplyDraft(input: ReplyDraftInput): Promise<Record<string, unknown>> {
    const composed = await this.composeReply(input);
    return this.saveDraft({
      ...composed.parts,
      identityChoice: composed.identity,
      allowEmptyRecipients: true,
      ...(input.draftsMailbox ? { mailbox: input.draftsMailbox } : {}),
    });
  }

  async forward(input: ForwardInput): Promise<Record<string, unknown>> {
    const composed = await this.composeForward(input);
    const sent = await this.send({
      ...composed.parts,
      identityChoice: composed.identity,
      appendSent: input.appendSent,
    });
    await this.setFlags({
      account: composed.parts.account,
      mailbox: input.mailbox,
      uidValidity: input.uidValidity,
      uids: [input.uid],
      flags: ['$Forwarded'],
      operation: 'add',
    }).catch(() => undefined);
    return sent;
  }

  async saveForwardDraft(input: ForwardDraftInput): Promise<Record<string, unknown>> {
    const composed = await this.composeForward(input);
    return this.saveDraft({
      ...composed.parts,
      identityChoice: composed.identity,
      allowEmptyRecipients: true,
      ...(input.draftsMailbox ? { mailbox: input.draftsMailbox } : {}),
    });
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
    const stored = assertDraftHeaders(readRawHeaderFields(source), (address, label) =>
      assertAllowedSender(account, address, label),
    );
    const parsed = await parseRawMessage(source);
    const recipients = [...stored.to, ...stored.cc, ...stored.bcc];
    assertRecipients(account, recipients);
    const selected = selectIdentity({
      identities: account.identities,
      accountEmail: account.email,
      allowFromDomains: account.allowFromDomains,
      requested: input.from ?? stored.from[0] ?? account.email,
    });
    const identity = input.from ? selected : { ...selected, reason: 'stored-draft' as const };
    const from = identity.address.address;
    const callerReply = input.replyTo ? normalizeRecipients(input.replyTo) : [];
    const chosenReply = replyAddresses(
      callerReply.length > 0
        ? callerReply
        : stored.replyTo.length > 0
          ? stored.replyTo
          : configuredReplyTo(account, identity.email),
    );
    for (const item of chosenReply) {
      assertAllowedSender(account, item.address, 'Reply-To');
    }
    if (!account.smtp) {
      throw new MailError('CONFIG_ERROR', `Account "${account.id}" has no SMTP server configured.`);
    }
    if (account.sendRateLimit) {
      this.limiter.consume(account.id, account.sendRateLimit.max, account.sendRateLimit.windowMs);
    }
    const fromHeader =
      input.from || stored.from.length === 0
        ? [identity.address]
        : stored.from.map((item, index) =>
            index === 0 && !item.name && identity.name ? identity.address : item,
          );
    const built = await this.outboundFromParts(account, {
      from: identity.address,
      to: stored.to,
      cc: stored.cc,
      bcc: stored.bcc,
      ...(chosenReply.length > 0 ? { replyTo: chosenReply } : {}),
      subject: parsed.subject,
      ...(parsed.text !== undefined ? { text: parsed.text } : {}),
      ...(parsed.html !== undefined ? { html: parsed.html } : {}),
      attachments: parsed.attachments
        .filter((item) => item.content)
        .map((item) => ({
          ...(item.filename ? { filename: item.filename } : {}),
          contentType: item.contentType,
          contentBase64: item.content?.toString('base64') ?? '',
          ...(item.cid ? { cid: item.cid } : {}),
          ...(item.inline ? { inline: true } : {}),
        })),
    });
    built.message.from = identity.address;
    built.message.fromHeader = fromHeader;
    if (stored.sender.length > 0) {
      built.message.sender = stored.sender;
    }
    if (parsed.messageId) {
      built.message.messageId = parsed.messageId;
    }
    if (parsed.inReplyTo) {
      built.message.inReplyTo = parsed.inReplyTo;
    }
    if (parsed.references.length > 0) {
      built.message.references = parsed.references.join(' ');
    }
    if (stored.rawHeaders.length > 0) {
      built.message.headerFields = stored.rawHeaders;
    }
    if (Object.keys(stored.kept).length > 0) {
      built.message.headers = { ...(built.message.headers ?? {}), ...stored.kept };
    }
    const wire = stripBcc(await buildRawMessage(built.message));
    const sender = await this.smtpFactory(account);
    try {
      const result = await sender.send({
        raw: wire,
        envelope: { from, to: recipients.map((item) => item.address) },
        eightBit: hasHighOctets(wire),
      });
      let appended: Record<string, unknown> | null = null;
      if (input.appendSent !== false && this.shouldAppend(account)) {
        appended = await this.appendSent(account, wire);
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
      const live = cursor
        ? await this.liveUidValidity(session, cursor.folders)
        : new Map<string, string>();
      const special = await this.special(account, session);
      const seeded = await this.seedMessage(session, account, input);
      const seed = seeded.seed;
      const paths =
        input.folders !== undefined
          ? await this.folderPaths(account, session, {
              folders: input.folders,
              mailbox: seed.mailbox,
            })
          : uniquePaths([
              ...seeded.matchedMailboxes,
              ...defaultThreadFolders(seed.mailbox, special),
              special.inbox ?? 'INBOX',
            ]);
      let messages: ConversationMessage[];
      let outsideMessages: ConversationMessage[] = [];
      let walkedOutside = false;
      let rounds: number;
      let truncated: boolean;
      if (cursor?.keys) {
        messages = await this.fetchFrozenKeys(session, cursor.keys);
        truncated = cursor.truncated === true;
        rounds = cursor.rounds ?? 0;
      } else {
        const fast = await this.fastThread(session, paths, seed, maxMessages);
        if (fast) {
          messages = fast.messages;
          truncated = fast.truncated;
          const closure = await this.outsideClosure(
            account.id,
            session,
            paths,
            threadIdSet(fast.seen, [seed]),
            maxRounds,
          );
          outsideMessages = closure.outside;
          walkedOutside = true;
          rounds = closure.rounds;
          truncated = truncated || closure.truncated;
        } else {
          const closed = await closeByHeaders({
            seed,
            folders: paths,
            maxMessages,
            maxRounds,
            search: (folder, ids) => this.searchHeaderIds(session, folder, ids),
            outside: (ids) => this.outsideMessages(account.id, session, paths, ids),
          });
          messages = closed.messages;
          outsideMessages = closed.outside;
          walkedOutside = true;
          rounds = closed.rounds;
          truncated = closed.truncated;
        }
      }
      // A Trash or Junk copy used only as a Message-ID seed is not an item.
      messages = messages.filter((item) => paths.includes(item.mailbox));
      if (!cursor?.keys && input.subjectHeuristic) {
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
      const threadIds = threadIdSet(messages, [seed, ...outsideMessages]);
      let excludedMatches: Array<{ mailbox: string; count: number }>;
      let excludedMatchesTruncated: boolean;
      if (cursor?.excluded) {
        excludedMatches = cursor.excluded;
        excludedMatchesTruncated = cursor.excludedTruncated === true;
      } else {
        const full = walkedOutside
          ? excludedFromMentions(mentionsByMailbox(outsideMessages), paths, threadIds)
          : await this.excludedFolderHits(account.id, session, paths, threadIds);
        const capped = capExcludedFolders(full);
        excludedMatches = capped.rows;
        excludedMatchesTruncated = capped.truncated;
      }
      if (cursor) {
        messages = messages.filter((item) => {
          const folder = cursor.folders.find((entry) => entry.mailbox === item.mailbox);
          return folder ? item.uid <= folder.upperUid : false;
        });
      }
      if (input.onlyUnread) {
        messages = messages.filter((item) => !item.flags.includes('\\Seen'));
      }
      const frozenKeys = cursor?.keys ?? messages.map((item) => `${item.mailbox}\0${item.uid}`);
      const threadKey = conversationThreadKey(messages.length > 0 ? messages : [seed]);
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
      for (const mailbox of paths) {
        if (live.has(mailbox)) {
          continue;
        }
        const known = ordered.find((item) => item.mailbox === mailbox)?.uidValidity;
        if (known) {
          live.set(mailbox, known);
          continue;
        }
        if (mailbox === seed.mailbox && seed.uidValidity) {
          live.set(mailbox, seed.uidValidity);
          continue;
        }
        try {
          const status = await session.status(mailbox);
          if (status.uidValidity) {
            live.set(mailbox, status.uidValidity);
          }
        } catch (error) {
          if (
            error instanceof MailError &&
            (error.code === 'NOT_FOUND' ||
              error.code === 'MAILBOX_NOT_SELECTABLE' ||
              error.code === 'PROTOCOL_ERROR')
          ) {
            continue;
          }
          throw error;
        }
      }
      const folders = paths.flatMap((mailbox) => {
        const uidValidity = live.get(mailbox);
        if (!uidValidity) {
          return [];
        }
        const stored = cursor?.folders.find((entry) => entry.mailbox === mailbox);
        const inFolder = ordered.filter((item) => item.mailbox === mailbox);
        const upperUid =
          stored?.upperUid ?? inFolder.reduce((highest, item) => Math.max(highest, item.uid), 0);
        return [
          {
            mailbox,
            uidValidity,
            upperUid,
            matched: inFolder.length,
            scanned: inFolder.length,
            omitted: 0,
            truncated: false,
          },
        ];
      });
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
          threadKey,
          ...(input.includeBodies ? { text, textTruncated } : {}),
        });
      }
      const reportedTruncated = truncated || folders.some((folder) => folder.truncated);
      return {
        ok: true as const,
        account: account.id,
        threadKey,
        tree: buildTree(ordered),
        rounds,
        items,
        messages: items,
        nextCursor: withCursorKeys(page.nextCursor, frozenKeys, {
          excluded: excludedMatches,
          excludedTruncated: excludedMatchesTruncated,
          truncated: reportedTruncated,
          rounds,
        }),
        total: page.total,
        offset: page.offset,
        truncated: reportedTruncated,
        order,
        snapshot: { folders },
        excludedMatches,
        excludedMatchesTruncated,
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
        ...(cursor ? { cursor } : {}),
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
        ...(cursor ? { cursor } : {}),
        maxPerFolder,
        materialize: true,
        exactCap: MAX_EXACT_SCAN,
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
        partial: scans.some((scan) => scan.truncated),
        scanned,
        order,
        snapshot: snapshotOf(scans),
      };
    });
  }

  async searchFacets(input: ListInput & { top?: number }): Promise<Record<string, unknown>> {
    const account = this.account(input.account);
    const top = bounded(input.top, DEFAULT_TOP_N, MAX_TOP_N);
    this.perFolderCap(input.maxPerFolder, account.limits.maxSortCandidates);
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
          const orderedIds = [...matched].sort((left, right) => left - right);
          const ids = orderedIds.slice(0, MAX_EXACT_SCAN);
          const omitted = orderedIds.length - ids.length;
          if (omitted > 0) {
            truncated = true;
          }
          const summaries = await fetchSummariesBatched(box, ids, {
            snippet: false,
            snippetChars: 0,
          });
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
        partial: truncated,
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
    const plan = this.bulkWindow(account);
    const bare = (): Record<string, unknown> => ({
      ok: false,
      account: account.id,
      dryRun,
      action: input.action,
      matched: 0,
      complete: false,
      remaining: [],
      stopped: 'budget' as const,
      results: [],
      items: [],
      nextCursor: null,
      total: 0,
      offset: 0,
      truncated: false,
      order,
      snapshot: snapshotOf([]),
    });
    try {
      return await this.withImap(
        account,
        async (session) => {
          if (!dryRun && Date.now() >= plan.budgetDeadline) {
            return bare();
          }
          const paths = await this.folderPaths(account, session, input);
          const compiled = compileSearch(input.search);
          assertSearchCapabilities(compiled.requires, (name) => session.hasCapability(name));
          const scope = scopeFor(paths, input.search, maxPerFolder, `bulk:${input.action}`);
          const { scans, incomplete: scanCut } = await scanFolders(session, paths, {
            compiled,
            keys,
            order,
            ...(cursor ? { cursor } : {}),
            maxPerFolder,
            materialize: true,
            ...(!dryRun ? { deadlineMs: plan.budgetDeadline } : {}),
          });
          const matched = scans.reduce((sum, scan) => sum + scan.matched, 0);
          const folderIncomplete = scans.some(
            (scan) => scan.truncated || scan.summaries.length < scan.matched,
          );
          if (!dryRun && !scanCut && (folderIncomplete || matched > account.limits.maxBulk)) {
            throw new MailError(
              'SIZE_LIMIT',
              folderIncomplete
                ? `The search matches ${matched} messages and this run did not load every one of them.`
                : `The search matches ${matched} messages and the bulk maximum is ${account.limits.maxBulk}.`,
              'Narrow the search or raise the cap. Nothing was changed. A dry run can preview them.',
            );
          }
          const rows = rowsFromScans(scans);
          const applied: Array<{
            mailbox: string;
            uid: number;
            ok: boolean;
            code?: string;
            message?: string;
          }> = [];
          const remaining: Array<{ mailbox: string; uid: number }> = [];
          let stopped: ChunkProgress['stopped'] = null;
          // A scan that stops between folders has not seen every mailbox. Listing
          // only the folders already read would make a resume skip the rest, so
          // the call changes nothing and returns an empty remaining.
          if (!dryRun && scanCut) {
            stopped = 'budget';
          } else if (!dryRun && Date.now() >= plan.budgetDeadline) {
            stopped = 'budget';
            for (const scan of scans) {
              remaining.push(
                ...scan.summaries.map((item) => ({ mailbox: scan.mailbox, uid: item.uid })),
              );
            }
          } else if (!dryRun) {
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
              if (stopped) {
                remaining.push(...uids.map((uid) => ({ mailbox: scan.mailbox, uid })));
                continue;
              }
              await session.withMailbox(scan.mailbox, 'write', async (box) => {
                this.assertUid(box, scan.uidValidity);
                const progress = await runInChunks({
                  uids,
                  budgetMs: Math.max(0, plan.budgetDeadline - Date.now()),
                  signal: currentRequestSignal(),
                  beforeChunk: () => this.armChunk(session, account, plan, plan.budgetDeadline),
                  onChunk: (chunk) =>
                    continueChunk(chunk, async () => {
                      if (input.action === 'addFlags' || input.action === 'removeFlags') {
                        const update = await box.setFlags(
                          chunk,
                          normalizeFlags(input.flags ?? []),
                          input.action === 'addFlags' ? 'add' : 'remove',
                        );
                        return flagResults(chunk, update);
                      }
                      if (!destination) {
                        throw new MailError(
                          'NOT_FOUND',
                          'No destination mailbox could be resolved.',
                        );
                      }
                      if (!session.moveSupported() && !session.uidPlusSupported()) {
                        throw new MailError(
                          'CAPABILITY_UNSUPPORTED',
                          'This server has neither MOVE nor UIDPLUS. Copying and then expunging would remove every \\Deleted message, not only the requested UIDs.',
                        );
                      }
                      const moved = await box.move(chunk, destination);
                      return chunk.map((uid) => {
                        if (moved.kept.includes(uid)) {
                          return {
                            uid,
                            ok: false,
                            code: 'PROTOCOL_ERROR',
                            message:
                              'The copy was not confirmed with COPYUID, so the original was left in place.',
                          };
                        }
                        return { uid, ok: true, value: moved.map[String(uid)] ?? null };
                      });
                    }),
                });
                for (const row of progress.results) {
                  applied.push({
                    mailbox: scan.mailbox,
                    uid: row.uid,
                    ok: row.ok,
                    ...(row.code ? { code: row.code } : {}),
                    ...(row.message ? { message: row.message } : {}),
                  });
                }
                remaining.push(
                  ...progress.remaining.map((uid) => ({ mailbox: scan.mailbox, uid })),
                );
                if (progress.stopped) {
                  stopped = progress.stopped;
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
          session.setCommandTimeout?.(boundedCommandTimeout(account.imap.timeoutMs));
          const applyComplete = dryRun || (remaining.length === 0 && stopped === null);
          return {
            ok: applyComplete && applied.every((item) => item.ok),
            account: account.id,
            dryRun,
            action: input.action,
            matched,
            complete: applyComplete,
            remaining,
            stopped,
            results: applied,
            items,
            nextCursor: dryRun ? page.nextCursor : null,
            total: page.total,
            offset: page.offset,
            truncated: scans.some((scan) => scan.truncated),
            order,
            snapshot: snapshotOf(scans),
          };
        },
        undefined,
        plan.poolDeadline,
      );
    } catch (error) {
      if (!dryRun && error instanceof MailError && error.code === 'TIMEOUT') {
        return bare();
      }
      throw error;
    }
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
      // A capped server SORT freezes its UID window on the first page. Later
      // pages must not re-slice a fresh SORT: expunging a UID inside the
      // window would otherwise pull in the next message past the cap.
      if (cursor?.keys && single) {
        const frozen = frozenSortUids(cursor.keys, single.mailbox);
        if (frozen.length > 0) {
          single.serverUids = frozen;
        }
      }
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
        // The cursor follows the frozen UID list, not the last summary that
        // happened to come back. An expunged UID in this slice does not end the walk.
        const attemptedLast = paged.pageUids[paged.pageUids.length - 1];
        const more = paged.offset + paged.pageUids.length < paged.total;
        const anchorSource = rows.find((row) => row.uid === attemptedLast);
        const nextCursor =
          attemptedLast !== undefined && more
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
                  mailbox: single.mailbox,
                  uid: attemptedLast,
                  uidValidity: single.uidValidity,
                  date: anchorSource?.date ?? anchorSource?.arrival ?? '',
                  field: keys[0]?.field ?? 'arrival',
                  reverse: Boolean(keys[0]?.reverse),
                  value: anchorSource ? scalar(anchorSource, keys[0]?.field ?? 'arrival') : '',
                },
                keys: serverUids.map((uid) => `${single.mailbox}\0${uid}`),
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
      if (single?.serverUids && anchorMissing) {
        // The anchor UID is gone. Resume inside the frozen window. Do not widen
        // it back to the whole mailbox, and do not clear an earlier truncation.
        const ids = single.serverUids;
        single.summaries = await session.withMailbox(single.mailbox, 'read', (box) =>
          fetchSummariesBatched(box, ids, { snippet: false, snippetChars: 0 }),
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

  private async liveUidValidity(
    session: ImapSession,
    folders: ReadonlyArray<{ mailbox: string; uidValidity: string }>,
  ): Promise<Map<string, string>> {
    const live = new Map<string, string>();
    for (const folder of folders) {
      let status: { uidValidity?: string };
      try {
        status = await session.status(folder.mailbox);
      } catch (error) {
        if (
          error instanceof MailError &&
          (error.code === 'NOT_FOUND' ||
            error.code === 'MAILBOX_NOT_SELECTABLE' ||
            error.code === 'PROTOCOL_ERROR')
        ) {
          throw new MailError(
            'CURSOR_INVALIDATED',
            `Mailbox ${folder.mailbox} changed since this cursor was issued.`,
            'The mailbox was recreated. Start again without a cursor.',
          );
        }
        throw error;
      }
      if (!status.uidValidity || status.uidValidity !== folder.uidValidity) {
        throw new MailError(
          'CURSOR_INVALIDATED',
          `UIDVALIDITY for ${folder.mailbox} is ${status.uidValidity ?? 'unknown'}, but this cursor was issued for ${folder.uidValidity}.`,
          'The mailbox was recreated. Start again without a cursor.',
        );
      }
      live.set(folder.mailbox, status.uidValidity);
    }
    return live;
  }

  private async fetchFrozenKeys(
    session: ImapSession,
    keys: readonly string[],
  ): Promise<ConversationMessage[]> {
    const grouped = new Map<string, number[]>();
    for (const key of keys) {
      const splitAt = key.lastIndexOf('\0');
      if (splitAt <= 0) {
        continue;
      }
      const mailbox = key.slice(0, splitAt);
      const uid = Number(key.slice(splitAt + 1));
      if (!Number.isInteger(uid)) {
        continue;
      }
      const list = grouped.get(mailbox) ?? [];
      list.push(uid);
      grouped.set(mailbox, list);
    }
    const messages: ConversationMessage[] = [];
    for (const [mailbox, uids] of grouped) {
      const found = await session.withMailbox(mailbox, 'read', async (box) => {
        const summaries = await box.fetchSummaries(uids, { snippet: true, snippetChars: 160 });
        const rows: ConversationMessage[] = [];
        for (const summary of summaries) {
          rows.push(await this.conversationFrom(box, summary, mailbox, 'header'));
        }
        return rows;
      });
      messages.push(...found);
    }
    return messages;
  }

  private async seedMessage(
    session: ImapSession,
    account: ResolvedAccount,
    input: {
      mailbox?: string;
      uid?: number;
      uidValidity?: string;
      messageId?: string;
      folders?: unknown;
    },
  ): Promise<{
    seed: ConversationMessage;
    matchedMailboxes: string[];
    folderHits: Array<{ mailbox: string; count: number }>;
  }> {
    if (input.uid !== undefined && input.mailbox) {
      const seed = await session.withMailbox(input.mailbox, 'read', async (box) => {
        this.assertUid(box, input.uidValidity);
        const summary = await this.requireSummary(box, input.uid ?? 0);
        return this.conversationFrom(box, summary, input.mailbox ?? 'INBOX', 'header');
      });
      const matched = [seed.mailbox];
      const seedId = normalizeMessageId(seed.messageId);
      if (seedId && input.folders === undefined) {
        const listed = await session.listMailboxes();
        const special = await this.special(account, session);
        const excluded = new Set(
          [special.trash, special.junk, seed.mailbox].filter((item): item is string =>
            Boolean(item),
          ),
        );
        const selectable = listed
          .filter((mailbox) => mailboxSelectable(mailbox) && !excluded.has(mailbox.path))
          .map((mailbox) => mailbox.path);
        const copies = await this.scanHeaderHits(account.id, session, selectable, [seedId]);
        for (const [mailbox, found] of copies) {
          if (found.some((item) => normalizeMessageId(item.messageId) === seedId)) {
            matched.push(mailbox);
          }
        }
      }
      return { seed, matchedMailboxes: uniquePaths(matched), folderHits: [] };
    }
    const id = normalizeMessageId(input.messageId);
    if (!id) {
      throw new MailError('INVALID_ARGUMENT', 'messageId is empty.');
    }
    const listed = await session.listMailboxes();
    const special = await this.special(account, session);
    const excluded = new Set(
      input.folders === undefined
        ? [special.trash, special.junk].filter((item): item is string => Boolean(item))
        : [],
    );
    const candidates =
      input.folders !== undefined
        ? await this.folderPaths(account, session, input)
        : listed.filter((item) => mailboxSelectable(item)).map((item) => item.path);
    const openHits: ConversationMessage[] = [];
    const excludedHits: ConversationMessage[] = [];
    const matchedMailboxes: string[] = [];
    const folderHits: Array<{ mailbox: string; count: number }> = [];
    const scanned = await this.scanHeaderHits(account.id, session, candidates, [id]);
    for (const [mailbox, found] of scanned) {
      folderHits.push({ mailbox, count: found.length });
      const exact = found.filter((item) => normalizeMessageId(item.messageId) === id);
      if (exact.length === 0) {
        continue;
      }
      if (excluded.has(mailbox)) {
        excludedHits.push(...exact);
        continue;
      }
      matchedMailboxes.push(mailbox);
      openHits.push(...exact);
    }
    if (openHits.length === 0) {
      const excludedHit = excludedHits[0];
      if (!excludedHit) {
        throw new MailError(
          'NOT_FOUND',
          `No message with Message-ID ${input.messageId} was found.`,
        );
      }
      // Walk both directions from the excluded copy's ids. The copy stays out of items.
      return {
        seed: closureSeed(excludedHit),
        matchedMailboxes: [],
        folderHits,
      };
    }
    const seed = [...openHits].sort((left, right) => {
      const pref =
        (left.mailbox.toUpperCase() === 'INBOX' ? 0 : 1) -
        (right.mailbox.toUpperCase() === 'INBOX' ? 0 : 1);
      if (pref !== 0) {
        return pref;
      }
      if (left.mailbox < right.mailbox) {
        return -1;
      }
      if (left.mailbox > right.mailbox) {
        return 1;
      }
      return left.uid - right.uid;
    })[0];
    if (!seed) {
      throw new MailError('NOT_FOUND', `No message with Message-ID ${input.messageId} was found.`);
    }
    return {
      seed,
      matchedMailboxes: uniquePaths(matchedMailboxes),
      folderHits,
    };
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

  private async excludedFolderHits(
    accountId: string,
    session: ImapSession,
    paths: readonly string[],
    ids: readonly string[],
  ): Promise<Array<{ mailbox: string; count: number }>> {
    const wanted = [...new Set(ids.map((item) => normalizeMessageId(item)).filter(Boolean))];
    if (wanted.length === 0) {
      return [];
    }
    const inScope = new Set(paths);
    const listed = await session.listMailboxes();
    const mailboxes = listed
      .filter((mailbox) => mailboxSelectable(mailbox) && !inScope.has(mailbox.path))
      .map((mailbox) => mailbox.path);
    const mentions = await this.scanHeaderHits(accountId, session, mailboxes, wanted);
    return excludedFromMentions(mentions, paths, wanted);
  }

  /**
   * Header closure of out-of-scope folders for a fast path that already loaded
   * the in-scope messages. `ids` is every id the capability search returned,
   * including messages maxMessages did not keep. The result is excluded
   * counts, not more items.
   */
  private async outsideClosure(
    accountId: string,
    session: ImapSession,
    paths: readonly string[],
    ids: readonly string[],
    maxRounds: number,
  ): Promise<{ outside: ConversationMessage[]; rounds: number; truncated: boolean }> {
    const probe = await closeByHeaders({
      seed: {
        mailbox: '',
        uid: 0,
        uidValidity: '',
        references: [...ids],
        from: [],
        to: [],
        cc: [],
        flags: [],
        hasAttachments: false,
        linked: 'header',
      },
      folders: [],
      maxMessages: 1,
      maxRounds,
      countFrom: 'ids',
      search: async () => [],
      outside: (batch) => this.outsideMessages(accountId, session, paths, batch),
    });
    return { outside: probe.outside, rounds: probe.rounds, truncated: probe.truncated };
  }

  /** Out-of-scope hits for one walk round. Ids from these messages extend the closure. */
  private async outsideMessages(
    accountId: string,
    session: ImapSession,
    paths: readonly string[],
    ids: readonly string[],
  ): Promise<ConversationMessage[]> {
    const inScope = new Set(paths);
    const listed = await session.listMailboxes();
    const mailboxes = listed
      .filter((mailbox) => mailboxSelectable(mailbox) && !inScope.has(mailbox.path))
      .map((mailbox) => mailbox.path);
    const mentions = await this.scanHeaderHits(accountId, session, mailboxes, ids);
    return [...mentions.values()].flat();
  }

  /**
   * UID SEARCH for threading ids, then fetch only the hits.
   * An empty mailbox is not searched. More than eight mailboxes share the work
   * with a free pool session and two short-lived connections.
   */
  private async scanHeaderHits(
    accountId: string,
    primary: ImapSession,
    mailboxes: readonly string[],
    ids: readonly string[],
  ): Promise<Map<string, ConversationMessage[]>> {
    const found = new Map<string, ConversationMessage[]>();
    if (mailboxes.length === 0) {
      return found;
    }
    const wanted = [...new Set(ids.map((item) => normalizeMessageId(item)).filter(Boolean))];
    const queue = [...mailboxes];
    let next = 0;
    const take = (): string | undefined => {
      const mailbox = queue[next];
      if (mailbox === undefined) {
        return undefined;
      }
      next += 1;
      return mailbox;
    };
    const worker = async (workerSession: ImapSession): Promise<void> => {
      for (;;) {
        const mailbox = take();
        if (!mailbox) {
          return;
        }
        const hit = await this.readHeaderHits(workerSession, mailbox, wanted);
        if (hit.messages.length > 0) {
          found.set(mailbox, hit.messages);
        }
      }
    };
    // Two pooled sessions are not enough once a server has a hundred mailboxes.
    // Each one is a SELECT plus a UID SEARCH, and the whole tool call has to
    // finish inside the account timeout. Extra sessions are closed afterwards.
    const parallel = mailboxes.length > 8;
    await Promise.all([
      worker(primary),
      ...(parallel
        ? [
            this.pool.tryUse?.(accountId, (extra) => worker(extra)),
            this.pool.useTransient?.(accountId, (extra) => worker(extra)),
            this.pool.useTransient?.(accountId, (extra) => worker(extra)),
          ]
        : []),
    ]);
    return found;
  }

  private async searchHeaderIds(
    session: ImapSession,
    folder: string,
    ids: readonly string[],
  ): Promise<ConversationMessage[]> {
    const hit = await this.readHeaderHits(session, folder, ids);
    return hit.messages;
  }

  private async readHeaderHits(
    session: ImapSession,
    folder: string,
    ids: readonly string[],
  ): Promise<{ messages: ConversationMessage[]; empty: boolean }> {
    const wantedIds = [...new Set(ids.map((item) => normalizeMessageId(item)).filter(Boolean))];
    if (wantedIds.length === 0) {
      return { messages: [], empty: false };
    }
    return session.withMailbox(folder, 'read', async (box) => {
      if (box.exists === 0) {
        return { messages: [], empty: true };
      }
      const wanted = new Set(wantedIds);
      const found: ConversationMessage[] = [];
      const seen = new Set<number>();
      for (let offset = 0; offset < wantedIds.length; offset += 8) {
        const batch = wantedIds.slice(offset, offset + 8);
        const clauses = batch.flatMap((item) => [
          { header: { name: 'Message-ID', value: item } },
          { header: { name: 'References', value: item } },
          { header: { name: 'In-Reply-To', value: item } },
        ]);
        const criteria: SearchCriteria =
          clauses.length === 1 && clauses[0] ? clauses[0] : { or: clauses };
        const uids = await box.search(compileSearch(criteria));
        const summaries = await box.fetchSummaries(uids, { snippet: true, snippetChars: 160 });
        for (const summary of summaries) {
          if (seen.has(summary.uid)) {
            continue;
          }
          const message = await this.conversationFrom(box, summary, folder, 'header');
          if (!headerMentions(message, wanted)) {
            continue;
          }
          seen.add(summary.uid);
          found.push(message);
        }
      }
      return { messages: found, empty: false };
    });
  }

  private async fastThread(
    session: ImapSession,
    folders: readonly string[],
    seed: ConversationMessage,
    maxMessages: number,
  ): Promise<{
    messages: ConversationMessage[];
    seen: ConversationMessage[];
    truncated: boolean;
  } | null> {
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
    const seen: ConversationMessage[] = [];
    for (const folder of folders) {
      const found = await session.withMailbox(folder, 'read', async (box) => {
        const uids = await box.search(compiled);
        const summaries = await box.fetchSummaries(uids, { snippet: true, snippetChars: 160 });
        const rows: ConversationMessage[] = [];
        for (const summary of summaries) {
          rows.push(await this.conversationFrom(box, summary, folder, linked));
        }
        return rows;
      });
      seen.push(...found);
    }
    // Same earliest-date, mailbox, UID rule as the header walk. `seen` stays
    // the full capability-search hit list so the closure still counts a
    // folder that cites a message the cap does not keep.
    const sawSeed = seen.some((item) => item.mailbox === seed.mailbox && item.uid === seed.uid);
    const kept = keepWithinCap(sawSeed ? seen : [...seen, seed], maxMessages);
    return { messages: kept.messages, seen, truncated: kept.dropped };
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
    deadlineMs?: number,
  ): Promise<T> {
    const requested = timeoutMs ?? boundedCommandTimeout(account.imap.timeoutMs);
    return this.pool.use(account.id, (session) => fn(session), requested, deadlineMs);
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

  private async composeReply(
    input: ReplyInput,
  ): Promise<{ parts: ComposeParts; identity: IdentityChoice }> {
    const account = this.account(input.account);
    const loaded = await this.loadParsed(account, input);
    const own = ownAddressesOf(account.email, account.identities, account.user);
    const original = {
      from: asMail(loaded.parsed.from),
      to: asMail(loaded.parsed.to),
      cc: asMail(loaded.parsed.cc),
      replyTo: asMail(loaded.parsed.replyTo),
    };
    const planned = input.replyAll ? planReplyAll(original, own) : undefined;
    const to = planned ? planned.to : planReply(original, own);
    const cc = planned ? planned.cc : [];
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
    const references = buildReferences(loaded.parsed.references, loaded.parsed.messageId);
    const parts: ComposeParts = {
      account: account.id,
      from: identity.address,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      to,
      cc,
      subject: input.subject ?? replySubject(loaded.parsed.subject),
      text,
      html,
      ...(input.attachments ? { attachments: input.attachments } : {}),
      ...(loaded.parsed.messageId ? { inReplyTo: loaded.parsed.messageId } : {}),
      ...(references ? { references } : {}),
    };
    return { parts, identity };
  }

  private async composeForward(
    input: ForwardInput,
  ): Promise<{ parts: ComposeParts; identity: IdentityChoice }> {
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
          ...(attachment.filename ? { filename: attachment.filename } : {}),
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
    const parts: ComposeParts = {
      account: account.id,
      from: identity.address,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      to: input.to,
      ...(input.cc ? { cc: input.cc } : {}),
      subject: input.subject ?? forwardSubject(loaded.parsed.subject),
      text,
      html,
      attachments,
    };
    return { parts, identity };
  }

  /**
   * Remove the draft that was replaced. The new UID is never deleted. A later
   * read can show that the old UID is still present, but that does not prove the
   * old body is intact, so a duplicate is kept instead of removing the replacement.
   * The old UID is reported removed only when the delete result says so, or a
   * later read shows it is gone. The UIDVALIDITY from the pre-append read is
   * the expected value for both. When that read fails, the new draft stays and
   * the result does not claim the old UID was removed.
   */
  private async removeReplacedDraft(
    account: ResolvedAccount,
    mailbox: string,
    uid: number,
    uidValidity?: string,
  ): Promise<'removed' | 'present' | 'unknown'> {
    let reported: 'removed' | 'present' | 'unknown';
    try {
      const result = await this.deleteMessages({
        account: account.id,
        mailbox,
        uids: [uid],
        permanent: account.allowPermanentDelete,
        ...(uidValidity ? { uidValidity } : {}),
      });
      reported = classifyRemoval(result, uid);
      if (reported === 'removed') {
        return 'removed';
      }
    } catch {
      reported = 'unknown';
    }
    const seen = await this.draftPresence(account, mailbox, uid, uidValidity);
    if (seen === 'absent') {
      return 'removed';
    }
    if (seen === 'present') {
      return 'present';
    }
    return reported === 'present' ? 'present' : 'unknown';
  }

  private async draftPresence(
    account: ResolvedAccount,
    mailbox: string,
    uid: number,
    uidValidity?: string,
  ): Promise<'present' | 'absent' | 'unknown'> {
    try {
      await this.withMailbox(account, mailbox, 'read', async (box) => {
        this.assertUid(box, uidValidity);
        await this.requireSummary(box, uid);
      });
      return 'present';
    } catch (error) {
      if (error instanceof MailError && error.code === 'NOT_FOUND') {
        return 'absent';
      }
      return 'unknown';
    }
  }

  /**
   * Threading headers already stored on a draft. An update copies these onto the
   * replacement and cannot drop them. Read fails before the new copy is appended.
   */
  private async preservedThreading(
    account: ResolvedAccount,
    mailbox: string,
    uid: number,
    uidValidity?: string,
  ): Promise<{
    threading: { inReplyTo?: string; references?: string };
    uidValidity: string;
  }> {
    const existing = await this.loadParsed(account, {
      account: account.id,
      mailbox,
      uid,
      ...(uidValidity ? { uidValidity } : {}),
    });
    const threading: { inReplyTo?: string; references?: string } = {};
    if (existing.parsed.inReplyTo) {
      threading.inReplyTo = existing.parsed.inReplyTo;
    }
    const references = buildReferences(existing.parsed.references, undefined);
    if (references) {
      threading.references = references;
    }
    return { threading, uidValidity: existing.uidValidity };
  }

  private async attachmentsRoot(): Promise<string> {
    const root = this.config.attachmentsDir;
    if (!root) {
      throw new MailError(
        'PERMISSION_DENIED',
        'Attachment paths require attachmentsDir to be configured.',
        'Set the attachmentsDir config key to the directory attachment files are read from and saved to.',
      );
    }
    return ensureAttachmentsDir(root);
  }

  /** Write `content` at a caller path inside attachmentsDir. Never creates a caller directory. */
  private async writeInsideAttachments(requested: string, content: Buffer): Promise<string> {
    const root = await this.attachmentsRoot();
    const target = await confineToRoot(requested, root);
    const parent = path.dirname(target);
    try {
      const parentInfo = await stat(parent);
      if (!parentInfo.isDirectory()) {
        throw new MailError('INVALID_ARGUMENT', `savePath parent "${parent}" is not a directory.`);
      }
    } catch (error) {
      if (error instanceof MailError) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new MailError(
          'NOT_FOUND',
          `Directory "${parent}" does not exist.`,
          'mail-mcp creates only the configured attachmentsDir. It does not create a directory from savePath. Save the file directly in attachmentsDir, or create the directory yourself.',
        );
      }
      throw new MailError('INVALID_ARGUMENT', 'savePath could not be resolved.');
    }
    try {
      await writeFile(target, content);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new MailError(
          'NOT_FOUND',
          `Directory "${parent}" does not exist.`,
          'mail-mcp creates only the configured attachmentsDir. It does not create a directory from savePath.',
        );
      }
      if (code === 'EISDIR') {
        throw new MailError('INVALID_ARGUMENT', 'savePath is a directory, not a file.');
      }
      throw error;
    }
    return target;
  }

  private async confineAttachments(
    account: ResolvedAccount,
    attachments: OutboundAttachment[],
  ): Promise<OutboundAttachment[]> {
    const needsRoot = attachments.some((attachment) => attachment.path);
    const root = needsRoot ? await this.attachmentsRoot() : undefined;
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
      const requested = attachment.path;
      const file = await confineToRoot(requested, root);
      const content = await readBoundedFile(file, account.limits.maxMessageBytes);
      const named = attachment.filename?.trim();
      const base = path.basename(requested);
      const filename = named || (base && base !== '.' && base !== '..' ? base : undefined);
      const next: OutboundAttachment = {
        ...attachment,
        contentBase64: content.toString('base64'),
        ...(filename ? { filename } : {}),
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
  ): Promise<{ parsed: ParsedMessage; summary: MessageSummary; uidValidity: string }> {
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
      return { parsed: await parseRawMessage(source), summary, uidValidity: box.uidValidity };
    });
  }

  private async outboundFromParts(
    account: ResolvedAccount,
    input: ComposeParts,
  ): Promise<{ message: OutboundMessage; identity: IdentityChoice }> {
    const identity = this.resolveFrom(account, input.from);
    const from = identity.address;
    const to = replyAddresses(normalizeRecipients(input.to));
    if (to.length === 0 && !input.allowEmptyRecipients) {
      throw new MailError('INVALID_ARGUMENT', 'At least one To recipient is required.');
    }
    const message: OutboundMessage = {
      from,
      to,
      subject: input.subject ?? '',
    };
    const cc = replyAddresses(normalizeRecipients(input.cc));
    const bcc = replyAddresses(normalizeRecipients(input.bcc));
    const replyTo = normalizeRecipients(input.replyTo);
    const chosenReply = replyAddresses(
      replyTo.length > 0 ? replyTo : configuredReplyTo(account, identity.email),
    );
    for (const item of chosenReply) {
      assertAllowedSender(account, item.address, 'Reply-To');
    }
    if (cc.length) {
      message.cc = cc;
    }
    if (bcc.length) {
      message.bcc = bcc;
    }
    if (chosenReply.length) {
      message.replyTo = chosenReply;
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
      message.headers = guardOutboundHeaders(input.headers);
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

  private bulkWindow(account: ResolvedAccount): BulkWindow {
    const budgetMs = Math.min(account.limits.bulkBudgetMs, MAX_BULK_BUDGET_MS);
    const start = Date.now();
    const budgetDeadline = start + budgetMs;
    // Acquire and the work share one clock. The pool waits a little past the
    // budget so an in-flight command can return a partial result before the
    // socket is closed, and the whole call stays under 60 seconds.
    const poolDeadline = Math.min(start + 55_000, budgetDeadline + 8_000);
    const slack = Math.max(1_000, poolDeadline - budgetDeadline);
    const commandMs = Math.min(account.imap.timeoutMs, slack);
    return { budgetMs, budgetDeadline, poolDeadline, commandMs };
  }

  private armChunk(
    session: ImapSession,
    account: ResolvedAccount,
    plan: BulkWindow,
    deadline: number,
  ): void {
    const left = Math.min(deadline + 5_000, plan.poolDeadline - 500) - Date.now();
    session.setCommandTimeout?.(
      Math.max(1_000, Math.min(account.imap.timeoutMs, plan.commandMs, Math.max(1_000, left))),
    );
  }

  private async withBulk<T>(
    account: ResolvedAccount,
    fn: (session: ImapSession, plan: BulkWindow) => Promise<T>,
    options?: { onTimeout?: () => T; window?: BulkWindow },
  ): Promise<T> {
    const plan = options?.window ?? this.bulkWindow(account);
    if (Date.now() >= plan.budgetDeadline) {
      if (options?.onTimeout) {
        return options.onTimeout();
      }
      throw new MailError('TIMEOUT', 'The bulk time budget elapsed before the call started.');
    }
    try {
      return await this.withImap(
        account,
        async (session) => {
          try {
            return await fn(session, plan);
          } finally {
            session.setCommandTimeout?.(boundedCommandTimeout(account.imap.timeoutMs));
          }
        },
        undefined,
        plan.poolDeadline,
      );
    } catch (error) {
      if (options?.onTimeout && error instanceof MailError && error.code === 'TIMEOUT') {
        return options.onTimeout();
      }
      throw error;
    }
  }

  private async bulkChunk(
    input: BulkInput,
    box: OpenMailbox,
    session: ImapSession,
    chunk: number[],
    trash: string | undefined,
  ): Promise<
    Array<{ uid: number; ok: boolean; code?: string; message?: string; value?: unknown }>
  > {
    try {
      if (
        input.action === 'addFlags' ||
        input.action === 'removeFlags' ||
        input.action === 'setFlags'
      ) {
        const operation =
          input.action === 'addFlags' ? 'add' : input.action === 'removeFlags' ? 'remove' : 'set';
        const update = await box.setFlags(chunk, normalizeFlags(input.flags ?? []), operation);
        return flagResults(chunk, update);
      }
      if (input.action === 'copy' && input.destination) {
        const map = await box.copy(chunk, input.destination);
        return chunk.map((uid) => ({ uid, ok: true, value: map[String(uid)] ?? null }));
      }
      if ((input.action === 'move' && input.destination) || (input.action === 'delete' && trash)) {
        const destination = input.action === 'move' ? input.destination : trash;
        if (!destination) {
          throw new MailError('INVALID_ARGUMENT', 'destination is required for copy and move.');
        }
        const moved = await box.move(chunk, destination);
        return chunk.map((uid) => {
          if (moved.kept.includes(uid)) {
            return {
              uid,
              ok: false,
              code: 'PROTOCOL_ERROR',
              message:
                'The copy was not confirmed with COPYUID, so the original was left in place.',
            };
          }
          return { uid, ok: true, value: moved.map[String(uid)] ?? null };
        });
      }
      if (input.action === 'delete' && input.permanent) {
        if (!session.uidPlusSupported()) {
          throw new MailError(
            'CAPABILITY_UNSUPPORTED',
            'Permanent delete of specific UIDs requires UIDPLUS.',
          );
        }
        await box.expunge(chunk);
        return chunk.map((uid) => ({ uid, ok: true }));
      }
      return isolateNotFound(chunk, async (slice) => {
        try {
          await box.setLabels(
            slice,
            input.labels ?? [],
            input.action === 'addLabels' ? 'add' : 'remove',
          );
          return slice.map((uid) => ({ uid, ok: true }));
        } catch (error) {
          const mapped =
            error instanceof MailError
              ? error
              : new MailError('PROTOCOL_ERROR', 'The UID operation failed.');
          if (
            mapped.code === 'CAPABILITY_UNSUPPORTED' ||
            mapped.code === 'TIMEOUT' ||
            mapped.code === 'CONNECTION_FAILED' ||
            mapped.code === 'PERMISSION_DENIED' ||
            (mapped.code === 'NOT_FOUND' && slice.length > 1)
          ) {
            throw mapped;
          }
          return slice.map((uid) => ({
            uid,
            ok: false,
            code: mapped.code,
            message: mapped.message,
          }));
        }
      });
    } catch (error) {
      const mapped =
        error instanceof MailError ? error : new MailError('PROTOCOL_ERROR', 'Bulk item failed.');
      if (
        mapped.code === 'TIMEOUT' ||
        mapped.code === 'CONNECTION_FAILED' ||
        mapped.code === 'CAPABILITY_UNSUPPORTED' ||
        mapped.code === 'PERMISSION_DENIED'
      ) {
        throw mapped;
      }
      return chunk.map((uid) => ({ uid, ok: false, code: mapped.code, message: mapped.message }));
    }
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

function closureSeed(source: ConversationMessage): ConversationMessage {
  return {
    mailbox: '',
    uid: 0,
    uidValidity: '',
    messageId: source.messageId,
    inReplyTo: source.inReplyTo,
    references: source.references,
    from: [],
    to: [],
    cc: [],
    flags: [],
    hasAttachments: false,
    linked: 'header',
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
  return andSearchQuery(compiled, { [flag]: value });
}

interface BulkWindow {
  budgetMs: number;
  budgetDeadline: number;
  poolDeadline: number;
  commandMs: number;
}

function budgetPaused(uids: number[]): {
  ok: false;
  complete: false;
  remaining: number[];
  stopped: 'budget';
  results: [];
} {
  return {
    ok: false,
    complete: false,
    remaining: uids,
    stopped: 'budget',
    results: [],
  };
}

async function continueChunk(
  chunk: number[],
  run: () => Promise<
    Array<{ uid: number; ok: boolean; code?: string; message?: string; value?: unknown }>
  >,
): Promise<Array<{ uid: number; ok: boolean; code?: string; message?: string; value?: unknown }>> {
  try {
    return await run();
  } catch (error) {
    const mapped =
      error instanceof MailError
        ? error
        : new MailError('PROTOCOL_ERROR', 'The UID operation failed.');
    if (mapped.code !== 'PROTOCOL_ERROR') {
      throw mapped;
    }
    return chunk.map((uid) => ({
      uid,
      ok: false,
      code: mapped.code,
      message: mapped.message,
    }));
  }
}

function classifyRemoval(
  result: Record<string, unknown>,
  uid: number,
): 'removed' | 'present' | 'unknown' {
  const results = Array.isArray(result.results) ? result.results : [];
  const row = results.find(
    (item): item is { uid?: number; ok?: boolean } =>
      Boolean(item) && typeof item === 'object' && (item as { uid?: unknown }).uid === uid,
  );
  const stopped = result.stopped;
  const finished = result.complete === true && (stopped === null || stopped === undefined);
  if (!finished || !row) {
    return 'unknown';
  }
  return row.ok === true ? 'removed' : 'present';
}

function draftReplaceWarning(
  removal: 'present' | 'unknown',
  mailbox: string,
  oldUid: number,
  newUid: number | undefined,
): string {
  const kept =
    newUid === undefined ? 'The new draft was kept.' : `The new draft was kept as UID ${newUid}.`;
  if (removal === 'present') {
    return `Draft UID ${oldUid} is still in ${mailbox}. ${kept}`;
  }
  return `Could not confirm that draft UID ${oldUid} was removed from ${mailbox}. ${kept} The old draft was left in place if it is still there.`;
}

function progressFields(progress: ChunkProgress): {
  ok: boolean;
  complete: boolean;
  remaining: number[];
  stopped: ChunkProgress['stopped'];
} {
  return {
    ok: progress.complete && progress.results.every((item) => item.ok),
    complete: progress.complete,
    remaining: progress.remaining,
    stopped: progress.stopped,
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
  const folder: ListedFolder = { path: mailbox.path, flags: mailbox.flags };
  if (mailbox.specialUse) {
    folder.specialUse = mailbox.specialUse;
  }
  return folder;
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
    .map((member) => byUid.get(`${member.mailbox || mailbox}\0${member.uid}`))
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
  return {
    ...row,
    participants: [...participants].sort(),
    messageCount: messages.length,
    unreadCount: unread,
    threadKey: conversationThreadKey(
      messages.map((item) => ({
        messageId: item.summary.messageId,
        inReplyTo: item.summary.inReplyTo,
        references: item.summary.references ?? [],
        date: item.summary.date,
        internalDate: item.summary.internalDate,
        mailbox: item.mailbox,
        uid: item.summary.uid,
        uidValidity: item.uidValidity,
      })),
    ),
    linked: link,
  };
}

function pruneThreads(nodes: ThreadNode[], allow: Set<string>): ThreadNode[] {
  const pruned: ThreadNode[] = [];
  for (const node of nodes) {
    const children = pruneThreads(node.children, allow);
    const key = node.uid !== undefined ? `${node.mailbox ?? ''}\0${node.uid}` : '';
    if ((key && allow.has(key)) || children.length > 0) {
      pruned.push({ ...node, children });
    }
  }
  return pruned;
}

function frozenSortUids(keys: readonly string[], mailbox: string): number[] {
  const prefix = `${mailbox}\0`;
  const uids: number[] = [];
  for (const key of keys) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    const uid = Number(key.slice(prefix.length));
    if (Number.isInteger(uid) && uid > 0) {
      uids.push(uid);
    }
  }
  return uids;
}

function withCursorKeys(
  cursor: string | null,
  keys: readonly string[],
  state: {
    excluded?: ReadonlyArray<{ mailbox: string; count: number }>;
    excludedTruncated: boolean;
    truncated: boolean;
    rounds: number;
  },
): string | null {
  if (!cursor) {
    return null;
  }
  const decoded = decodeSnapshotCursor(cursor);
  const capped = state.excluded ? capExcludedFolders(state.excluded) : undefined;
  return encodeSnapshotCursor({
    ...decoded,
    keys: [...keys],
    ...(capped ? { excluded: capped.rows } : {}),
    excludedTruncated: state.excludedTruncated || capped?.truncated === true,
    truncated: state.truncated,
    rounds: state.rounds,
  });
}

function headerMentions(message: ConversationMessage, wanted: ReadonlySet<string>): boolean {
  return mentionIds(message).some((token) => wanted.has(token));
}

function mentionIds(message: ConversationMessage): string[] {
  return [message.messageId, message.inReplyTo, ...message.references]
    .map((item) => normalizeMessageId(item))
    .filter((item) => item.length > 0);
}

/**
 * Every id the closure discovered: item ids, ids those items cite, the seed's
 * ids, and ids that appear only on out-of-scope messages, followed transitively.
 */
function threadIdSet(
  messages: readonly ConversationMessage[],
  extras: readonly ConversationMessage[],
): string[] {
  const ids = new Set<string>();
  for (const message of [...messages, ...extras]) {
    for (const id of mentionIds(message)) {
      ids.add(id);
    }
  }
  return [...ids];
}

function mentionsByMailbox(
  messages: readonly ConversationMessage[],
): Map<string, ConversationMessage[]> {
  const grouped = new Map<string, ConversationMessage[]>();
  for (const message of messages) {
    const list = grouped.get(message.mailbox) ?? [];
    list.push(message);
    grouped.set(message.mailbox, list);
  }
  return grouped;
}

function excludedFromMentions(
  mentions: Map<string, ConversationMessage[]>,
  paths: readonly string[],
  ids: readonly string[],
): Array<{ mailbox: string; count: number }> {
  const wanted = new Set(ids.map((item) => normalizeMessageId(item)).filter(Boolean));
  const inScope = new Set(paths);
  const hits: Array<{ mailbox: string; count: number }> = [];
  for (const [mailbox, messages] of mentions) {
    if (inScope.has(mailbox) || wanted.size === 0) {
      continue;
    }
    const seen = new Set<number>();
    for (const message of messages) {
      if (headerMentions(message, wanted)) {
        seen.add(message.uid);
      }
    }
    if (seen.size > 0) {
      hits.push({ mailbox, count: seen.size });
    }
  }
  hits.sort((left, right) => comparePath(left.mailbox, right.mailbox));
  return hits;
}

function configuredReplyTo(account: ResolvedAccount, email: string): MailAddress[] {
  const identity = account.identities.find(
    (item) => item.email.trim().toLowerCase() === email.trim().toLowerCase(),
  );
  return identity?.replyTo ? parseAddressList(identity.replyTo) : [];
}

function assertAllowedSender(account: ResolvedAccount, address: string, label: string): void {
  try {
    selectIdentity({
      identities: account.identities,
      accountEmail: account.email,
      allowFromDomains: account.allowFromDomains,
      requested: address,
    });
  } catch (error) {
    if (error instanceof MailError && error.code === 'PERMISSION_DENIED') {
      throw new MailError(
        'PERMISSION_DENIED',
        `${label} address ${address} is not a configured identity.`,
        error.hint,
      );
    }
    throw error;
  }
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

export interface ReplyDraftInput extends Omit<ReplyInput, 'appendSent'> {
  /** Drafts mailbox override. `mailbox` stays the source folder. */
  draftsMailbox?: string;
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

export interface ForwardDraftInput extends Omit<ForwardInput, 'appendSent'> {
  /** Drafts mailbox override. `mailbox` stays the source folder. */
  draftsMailbox?: string;
}

export interface DraftInput extends ComposeParts {
  mailbox?: string;
  /** Checked against the Drafts mailbox before the old draft is read or removed. */
  uidValidity?: string;
  /** Set by reply and forward draft saves so the reported reason matches a send. */
  identityChoice?: IdentityChoice;
}
