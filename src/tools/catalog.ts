import { z } from 'zod';
import type { MailService } from '../service/mail-service.js';
import type { MutationKind } from '../safety.js';
import {
  cursorLimit,
  pageKeyList,
  pageLimit,
  readPageCursor,
  resolveOrder,
} from '../service/browse.js';
import type { PageOrder } from '../page/snapshot.js';
import { fields, strictOutput } from './schema.js';

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject<z.ZodRawShape>;
  output: z.ZodObject<z.ZodRawShape>;
  annotations: ToolAnnotations;
  kind: 'read' | MutationKind;
  /** When true, limit, cursor, and order are added and the result uses the shared page envelope. */
  paged?: boolean;
  examples: string[];
  run(args: Record<string, unknown>, service: MailService): Promise<Record<string, unknown>>;
}

const baseOut = {
  ok: fields.ok,
  account: z.string().describe('Account id that handled the call.'),
};

const pageFields = {
  items: z
    .array(z.record(z.string(), z.unknown()))
    .describe(
      'This page. The same cursor model is used for every paged tool: pass nextCursor back as cursor. A new call without a cursor starts a new snapshot and includes mail that arrived after the previous one.',
    ),
  nextCursor: z.string().nullable().describe('Cursor for the next page, or null on the last page.'),
  total: z.number().describe('Rows inside the snapshot, before this page is sliced.'),
  truncated: z
    .boolean()
    .describe(
      'True when a cap omitted matches. omitted and scanned on snapshot.folders say which folder.',
    ),
  snapshot: z
    .record(z.string(), z.unknown())
    .describe(
      'Frozen view from the first page. Message lists store each folder uidValidity and the highest UID that search returned. Later arrivals stay outside this walk.',
    ),
  order: z.enum(['newest-first', 'oldest-first']).describe('Order used for this page.'),
};

function define(tool: ToolDefinition): ToolDefinition {
  if (!tool.paged) {
    return tool;
  }
  return {
    ...tool,
    input: tool.input
      .extend({
        limit: fields.limit,
        cursor: fields.cursor,
        order: fields.order,
      })
      .strict(),
    output: tool.output.extend(pageFields).strict(),
  };
}

const readAnn = (title: string): ToolAnnotations => ({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  ...(title ? {} : {}),
});

void readAnn;

export const TOOLS: ToolDefinition[] = [
  define({
    name: 'mail_list_accounts',
    title: 'List configured accounts',
    description:
      'List every account this server can use, without secrets. Use it first when more than one account is configured, then pass the id as `account` on later calls. The default account is marked. Read-only metadata: provider, safety switches, whether SMTP is configured, and From identities including each identity replyTo. Does not open a network connection.',
    input: z.object({}).describe('No arguments.'),
    output: strictOutput({
      ok: fields.ok,
      accounts: z.array(z.record(z.string(), z.unknown())).describe('Account summaries.'),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    kind: 'read',
    paged: true,
    examples: ['{}'],
    async run(args, service) {
      const accounts = service.listAccounts();
      const input = args as { limit?: number; cursor?: string; order?: PageOrder };
      const cursor = readPageCursor(input.cursor);
      const { order } = resolveOrder(input.order ? { order: input.order } : {});
      const limit = pageLimit(
        cursorLimit(cursor, input.limit, service.config.limits.pageSize),
        service.config.limits.pageSize,
        service.config.limits.maxPageSize,
        false,
      );
      const paged = pageKeyList(
        accounts.map((item) => String(item.id)),
        {
          limit,
          order,
          ...(cursor ? { cursor } : {}),
          scope: 'accounts',
          sort: [{ field: 'arrival', reverse: order === 'newest-first' }],
        },
      );
      const byId = new Map(accounts.map((item) => [String(item.id), item]));
      const items = paged.keys.map((key) => byId.get(key)).filter((item) => item !== undefined);
      return {
        ok: true,
        accounts: items,
        items,
        nextCursor: paged.nextCursor,
        total: paged.total,
        truncated: false,
        order,
        snapshot: { folders: [] },
      };
    },
  }),
  define({
    name: 'mail_verify_connection',
    title: 'Verify IMAP and SMTP',
    description:
      'Open the account and authenticate, then close. Use this instead of guessing when a later call fails with AUTH_FAILED, TLS_FAILED, or CONNECTION_FAILED. Set imap or smtp to false to check only one side. A failed login is reported inside the result (ok false plus a code) rather than as a transport crash, so you can show the hint to the user. SMTP is skipped when the account has no smtp block.',
    input: z.object({
      account: fields.account,
      imap: z.boolean().optional().describe('Check IMAP. Default true.'),
      smtp: z.boolean().optional().describe('Check SMTP. Default true when SMTP is configured.'),
    }),
    output: strictOutput({
      ...baseOut,
      imap: z.record(z.string(), z.unknown()),
      smtp: z.record(z.string(), z.unknown()),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'read',
    examples: ['{"account":"work","smtp":false}'],
    async run(args, service) {
      const input = args as { account?: string; imap?: boolean; smtp?: boolean };
      return service.verify(input.account, { imap: input.imap, smtp: input.smtp });
    },
  }),
  define({
    name: 'mail_get_capabilities',
    title: 'Get IMAP capabilities',
    description:
      'Return the capability tokens advertised after login (RFC 3501 / RFC 9051). Use this before relying on MOVE, SORT, THREAD, IDLE, CONDSTORE, QUOTA, NAMESPACE, ID, SPECIAL-USE, UIDPLUS, or X-GM-EXT-1. Missing tokens mean the matching tool will use a documented fallback or return CAPABILITY_UNSUPPORTED. Example tokens: "IMAP4rev1", "IDLE", "MOVE".',
    input: z.object({ account: fields.account }),
    output: strictOutput({
      ...baseOut,
      capabilities: z.array(z.string()).describe('Capability names.'),
      greeting: z.string().nullable().describe('Server greeting text, or null.'),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'read',
    examples: ['{}'],
    async run(args, service) {
      return service.capabilities((args as { account?: string }).account);
    },
  }),
  define({
    name: 'mail_get_namespaces',
    title: 'Get IMAP namespaces',
    description:
      'Return personal, other-user, and shared namespaces from RFC 2342. When the server has no NAMESPACE capability, the prefix and hierarchy delimiter are inferred from LIST "" "". delimiter is null for a flat namespace. Use the prefix when creating folders outside the personal namespace.',
    input: z.object({ account: fields.account }),
    output: strictOutput({ ...baseOut, namespaces: z.record(z.string(), z.unknown()) }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'read',
    examples: ['{}'],
    async run(args, service) {
      return service.namespaces((args as { account?: string }).account);
    },
  }),
  define({
    name: 'mail_get_quota',
    title: 'Get mailbox quota',
    description:
      'Return RFC 2087 / RFC 9208 quota resources for the account, or for one mailbox when mailbox is set. STORAGE used and limit are octets (bytes): the wire value is kibibytes and is converted by multiplying by 1024. MESSAGE is a count. QUOTA or QUOTA=RES-* is enough. A limit of 0 can mean unlimited on some servers.',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox
        .optional()
        .describe('Optional mailbox path. Omit for the root quota.'),
    }),
    output: strictOutput({ ...baseOut, quota: z.record(z.string(), z.unknown()).nullable() }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'read',
    examples: ['{"mailbox":"INBOX"}'],
    async run(args, service) {
      const input = args as { account?: string; mailbox?: string };
      return service.quota(input.account, input.mailbox);
    },
  }),
  define({
    name: 'mail_get_server_id',
    title: 'Get server ID',
    description:
      'Return the RFC 2971 ID fields the server sent (name, version, vendor, and anything else it offered). Fails with CAPABILITY_UNSUPPORTED when ID is absent. Useful for deciding provider-specific behaviour such as Gmail sent-mail handling.',
    input: z.object({ account: fields.account }),
    output: strictOutput({ ...baseOut, server: z.record(z.string(), z.string()).nullable() }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'read',
    examples: ['{}'],
    async run(args, service) {
      return service.serverId((args as { account?: string }).account);
    },
  }),
  define({
    name: 'mail_list_mailboxes',
    title: 'List mailboxes',
    description:
      'List mailboxes with SPECIAL-USE flags when the server sends them (\\Inbox, \\Sent, \\Drafts, \\Trash, \\Junk, \\Archive, \\All, \\Flagged) and whether each is subscribed. Prefer this over mail_get_mailbox_tree when you need a flat list with flags. Paths are Unicode. Set subscribedOnly to true for the LSUB / LIST (SUBSCRIBED) view. Does not create folders.',
    input: z.object({
      account: fields.account,
      subscribedOnly: z
        .boolean()
        .optional()
        .describe('When true, only subscribed mailboxes. Default false (all listed).'),
    }),
    output: strictOutput({
      ...baseOut,
      mailboxes: z.array(z.record(z.string(), z.unknown())),
      offset: z.number(),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'read',
    paged: true,
    examples: ['{"subscribedOnly":true}'],
    async run(args, service) {
      const input = args as {
        account?: string;
        subscribedOnly?: boolean;
        limit?: number;
        cursor?: string;
        order?: PageOrder;
      };
      return service.listMailboxes(input.account, input.subscribedOnly === true, {
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.order ? { order: input.order } : {}),
      });
    },
  }),
  define({
    name: 'mail_get_mailbox_tree',
    title: 'Mailbox tree',
    description:
      'Return the mailbox hierarchy as a tree. Each node has path, name, delimiter, flags, specialUse, and folders (children). Use mail_list_mailboxes when you only need a flat list. The root node may have an empty path and only a folders array.',
    input: z.object({ account: fields.account }),
    output: strictOutput({ ...baseOut, tree: z.record(z.string(), z.unknown()) }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'read',
    examples: ['{}'],
    async run(args, service) {
      return service.mailboxTree((args as { account?: string }).account);
    },
  }),
  define({
    name: 'mail_get_mailbox_status',
    title: 'Mailbox status',
    description:
      'STATUS for one mailbox: messages, unseen, recent, uidNext, uidValidity, highestModseq when CONDSTORE is available, and size when STATUS=SIZE or IMAP4rev2 is available. uidValidity is a decimal string. Call this before a long sequence of UID updates and pass the value back as uidValidity. Counts are numbers of messages, size is octets.',
    input: z.object({ account: fields.account, mailbox: fields.mailbox }),
    output: strictOutput({ ...baseOut, status: z.record(z.string(), z.unknown()) }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'read',
    examples: ['{"mailbox":"INBOX"}'],
    async run(args, service) {
      const input = args as { account?: string; mailbox: string };
      return service.mailboxStatus(input.account, input.mailbox);
    },
  }),
  define({
    name: 'mail_create_mailbox',
    title: 'Create mailbox',
    description:
      'Create a mailbox, including parents the server creates implicitly (CREATE of "a/b" often creates "a"). Idempotent on servers that answer "already exists" as success; otherwise a second call returns a protocol error. Blocked when the account is readOnly. Name is Unicode.',
    input: z.object({ account: fields.account, mailbox: fields.mailbox }),
    output: strictOutput({ ...baseOut, path: z.string(), created: z.boolean() }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    kind: 'mailbox-write',
    examples: ['{"mailbox":"Projects/2026"}'],
    async run(args, service) {
      const input = args as { account?: string; mailbox: string };
      return service.createMailbox(input.account, input.mailbox);
    },
  }),
  define({
    name: 'mail_rename_mailbox',
    title: 'Rename mailbox',
    description:
      'Rename a mailbox (RFC 3501 RENAME). Inferior mailboxes usually move with it when the server supports that. INBOX cannot be renamed on many servers; messages are moved instead. Blocked when readOnly. newName is a full path, not just the last segment.',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox.describe('Existing mailbox path.'),
      newName: z.string().min(1).describe('New full mailbox path. Example: "Archive/2025".'),
    }),
    output: strictOutput({ ...baseOut, mailbox: z.string(), newName: z.string() }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    kind: 'mailbox-write',
    examples: ['{"mailbox":"Temp","newName":"Archive/Temp"}'],
    async run(args, service) {
      const input = args as { account?: string; mailbox: string; newName: string };
      return service.renameMailbox(input.account, input.mailbox, input.newName);
    },
  }),
  define({
    name: 'mail_delete_mailbox',
    title: 'Delete mailbox',
    description:
      'Delete a mailbox and, on most servers, its messages. This is destructive and requires allowDelete. It does not merely unsubscribe. Refusing to delete INBOX is normal. There is no trash for the folder itself.',
    input: z.object({ account: fields.account, mailbox: fields.mailbox }),
    output: strictOutput({ ...baseOut, mailbox: z.string(), deleted: z.boolean() }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    kind: 'delete',
    examples: ['{"mailbox":"Temp"}'],
    async run(args, service) {
      const input = args as { account?: string; mailbox: string };
      return service.deleteMailbox(input.account, input.mailbox);
    },
  }),
  define({
    name: 'mail_subscribe_mailbox',
    title: 'Subscribe mailbox',
    description:
      'SUBSCRIBE a mailbox so it shows up for clients that only list subscriptions. The mailbox must already exist. Blocked when readOnly. Use mail_unsubscribe_mailbox to reverse it.',
    input: z.object({ account: fields.account, mailbox: fields.mailbox }),
    output: strictOutput({ ...baseOut, mailbox: z.string(), subscribed: z.boolean() }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'mailbox-write',
    examples: ['{"mailbox":"Projects"}'],
    async run(args, service) {
      const input = args as { account?: string; mailbox: string };
      return service.subscribe(input.account, input.mailbox, true);
    },
  }),
  define({
    name: 'mail_unsubscribe_mailbox',
    title: 'Unsubscribe mailbox',
    description:
      'UNSUBSCRIBE a mailbox. The folder and its messages stay. Blocked when readOnly. Listing with subscribedOnly will hide it afterwards.',
    input: z.object({ account: fields.account, mailbox: fields.mailbox }),
    output: strictOutput({ ...baseOut, mailbox: z.string(), subscribed: z.boolean() }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'mailbox-write',
    examples: ['{"mailbox":"Projects"}'],
    async run(args, service) {
      const input = args as { account?: string; mailbox: string };
      return service.subscribe(input.account, input.mailbox, false);
    },
  }),
  define({
    name: 'mail_list_subscribed',
    title: 'List subscribed mailboxes',
    description:
      'Shortcut for mail_list_mailboxes with subscribedOnly true. Same result shape. Use it when a client only cares about the subscription list.',
    input: z.object({ account: fields.account }),
    output: strictOutput({
      ...baseOut,
      mailboxes: z.array(z.record(z.string(), z.unknown())),
      offset: z.number(),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'read',
    paged: true,
    examples: ['{}'],
    async run(args, service) {
      const input = args as {
        account?: string;
        limit?: number;
        cursor?: string;
        order?: PageOrder;
      };
      return service.listMailboxes(input.account, true, {
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.order ? { order: input.order } : {}),
      });
    },
  }),
  define({
    name: 'mail_resolve_special_use',
    title: 'Resolve special-use mailboxes',
    description:
      'Resolve Inbox, Sent, Drafts, Trash, Junk, Archive, All, and Flagged. Order: account config overrides, SPECIAL-USE flags from the server, then provider name hints (Gmail "[Gmail]/Sent Mail", Outlook "Sent Items", and so on). sources says how each path was chosen: config, extension, or name. Send and delete tools use this automatically. Call it when you need the path yourself.',
    input: z.object({ account: fields.account }),
    output: strictOutput({ ...baseOut, special: z.record(z.string(), z.unknown()) }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'read',
    examples: ['{}'],
    async run(args, service) {
      return service.specialUse((args as { account?: string }).account);
    },
  }),
  define({
    name: 'mail_list_messages',
    title: 'List message summaries',
    description:
      'Page message summaries in a mailbox. Default mailbox is INBOX. Default sort is arrival descending (newest first) via the SORT extension, with a client-side fallback. A folder larger than limits.maxSortCandidates is truncated, including a single-folder server SORT: snapshot.folders reports omitted and scanned, and paging continues inside that window. Each summary has uid, flags, size (octets), date, from, to, subject, hasAttachments, and a snippet of about snippetChars characters (default 160). Pass nextCursor back as cursor. Mail that arrives after the first page needs a new call without a cursor. For criteria use mail_search_messages; a search object is also accepted here. Optional uidValidity detects a recreated mailbox. folders all, globs, and special-use skip mailboxes marked \\Noselect or \\NonExistent. Naming one of those paths returns MAILBOX_NOT_SELECTABLE.',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox
        .optional()
        .describe('Mailbox path. Default INBOX. Ignored when folders is set.'),
      folders: fields.folders,
      maxPerFolder: fields.maxPerFolder,
      search: fields.search.optional(),
      sort: z
        .array(fields.sortKey)
        .optional()
        .describe('Sort keys, most significant first. Default: arrival descending.'),
      limit: fields.limit,
      cursor: fields.cursor,
      uidValidity: fields.uidValidity,
      includeSnippet: z
        .boolean()
        .optional()
        .describe('Include a text snippet. Default true. Set false for a faster list.'),
      snippetChars: z
        .number()
        .int()
        .positive()
        .max(2000)
        .optional()
        .describe('Maximum snippet length. Default 160.'),
    }),
    output: strictOutput({
      ...baseOut,
      mailbox: z.string(),
      uidValidity: z.string(),
      total: z.number().describe('Matches before paging.'),
      offset: z.number(),
      sort: z.array(z.object({ field: z.string(), reverse: z.boolean().optional() }).strict()),
      sortSource: z.enum(['server', 'client', 'uid']),
      search: z.boolean(),
      messages: z.array(
        z
          .object({
            uid: z.number(),
            mailbox: z.string(),
            uidValidity: z.string(),
            flags: z.array(z.string()),
            size: z.number().nullable(),
            date: z.string().nullable(),
            internalDate: z.string().nullable(),
            subject: z.string().nullable(),
            from: z.array(
              z.object({ name: z.string().optional(), address: z.string().optional() }).strict(),
            ),
            to: z.array(
              z.object({ name: z.string().optional(), address: z.string().optional() }).strict(),
            ),
            cc: z.array(
              z.object({ name: z.string().optional(), address: z.string().optional() }).strict(),
            ),
            messageId: z.string().nullable(),
            hasAttachments: z.boolean(),
            snippet: z.string().nullable(),
            labels: z.array(z.string()),
            threadId: z.string().nullable(),
            modseq: z.string().nullable(),
            listUnsubscribe: z.string().nullable(),
            listId: z.string().nullable(),
            autoSubmitted: z.string().nullable(),
          })
          .strict(),
      ),
      nextCursor: z.string().nullable(),
      folders: z.array(z.string()).describe('Mailbox paths included in this snapshot.'),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'read',
    paged: true,
    examples: ['{"mailbox":"INBOX","limit":10}'],
    async run(args, service) {
      return service.listMessages(args as never);
    },
  }),
  define({
    name: 'mail_search_messages',
    title: 'Search messages',
    description:
      'Search with the full structured IMAP SEARCH grammar (from, to, cc, bcc, subject, body, text, header, internal and sent dates, larger/smaller, flags and keywords, UID and sequence sets, NOT/OR/AND, MODSEQ, and Gmail X-GM-RAW / thread id / labels when the server supports them). Same paging and summaries as mail_list_messages. Use this tool, not mail_list_messages, when the user describes what to find. An empty search object is rejected. ESEARCH is used internally when ImapFlow can; the result you see is always a paged list plus total.',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox.optional(),
      folders: fields.folders,
      maxPerFolder: fields.maxPerFolder,
      search: fields.search,
      sort: z.array(fields.sortKey).optional(),
      limit: fields.limit,
      cursor: fields.cursor,
      uidValidity: fields.uidValidity,
      includeSnippet: z
        .boolean()
        .optional()
        .describe('Include a text snippet. Default true. Set false for a faster search.'),
      snippetChars: z
        .number()
        .int()
        .positive()
        .max(2000)
        .optional()
        .describe('Maximum snippet length in characters. Default 160.'),
    }),
    output: strictOutput({
      ...baseOut,
      mailbox: z.string(),
      uidValidity: z.string(),
      total: z.number(),
      offset: z.number(),
      sort: z.array(z.object({ field: z.string(), reverse: z.boolean().optional() }).strict()),
      sortSource: z.enum(['server', 'client', 'uid']),
      search: z.boolean(),
      messages: z.array(
        z
          .object({
            uid: z.number(),
            mailbox: z.string(),
            uidValidity: z.string(),
            flags: z.array(z.string()),
            size: z.number().nullable(),
            date: z.string().nullable(),
            internalDate: z.string().nullable(),
            subject: z.string().nullable(),
            from: z.array(
              z.object({ name: z.string().optional(), address: z.string().optional() }).strict(),
            ),
            to: z.array(
              z.object({ name: z.string().optional(), address: z.string().optional() }).strict(),
            ),
            cc: z.array(
              z.object({ name: z.string().optional(), address: z.string().optional() }).strict(),
            ),
            messageId: z.string().nullable(),
            hasAttachments: z.boolean(),
            snippet: z.string().nullable(),
            labels: z.array(z.string()),
            threadId: z.string().nullable(),
            modseq: z.string().nullable(),
            listUnsubscribe: z.string().nullable(),
            listId: z.string().nullable(),
            autoSubmitted: z.string().nullable(),
          })
          .strict(),
      ),
      nextCursor: z.string().nullable(),
      folders: z.array(z.string()).describe('Mailbox paths included in this snapshot.'),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'read',
    paged: true,
    examples: ['{"mailbox":"INBOX","search":{"seen":false,"from":"ada@example.com"},"limit":20}'],
    async run(args, service) {
      return service.searchMessages(args as never);
    },
  }),
  define({
    name: 'mail_get_message',
    title: 'Get one message',
    description:
      'Fetch one message by mailbox and UID and return parsed headers, text, HTML, an HTML-to-text rendering, and an attachment list (part metadata only, no bytes). Bodies are capped at maxBodyChars (default limits.maxBodyChars, 100000) and textTruncated/htmlTruncated say when that happened. Messages larger than maxMessageBytes fail with SIZE_LIMIT unless you pass parts to fetch specific MIME section ids such as "1" or "2.1" without downloading the whole RFC822. Use mail_download_attachment for bytes. Use mail_get_raw_message for the unparsed source.',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox,
      uid: fields.uid,
      uidValidity: fields.uidValidity,
      maxBodyChars: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Cap for text and HTML, in characters. Default limits.maxBodyChars.'),
      parts: z
        .array(z.string())
        .optional()
        .describe('MIME section ids to fetch instead of the whole message. Example: ["1","2"].'),
    }),
    output: strictOutput({
      ...baseOut,
      mailbox: z.string(),
      uid: z.number(),
      uidValidity: z.string(),
      flags: z.array(z.string()),
      size: z.number().optional(),
      internalDate: z.string().nullable().optional(),
      labels: z.array(z.string()).optional(),
      threadId: z.string().nullable().optional(),
      headers: z.record(z.string(), z.unknown()).optional(),
      text: z.string().nullable().optional(),
      textTruncated: z.boolean().optional(),
      html: z.string().nullable().optional(),
      htmlTruncated: z.boolean().optional(),
      htmlAsText: z.string().nullable().optional(),
      attachments: z.array(z.record(z.string(), z.unknown())).optional(),
      structure: z.record(z.string(), z.unknown()).nullable().optional(),
      parts: z.array(z.record(z.string(), z.unknown())).optional(),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'read',
    examples: ['{"mailbox":"INBOX","uid":41}'],
    async run(args, service) {
      return service.getMessage(args as never);
    },
  }),
  define({
    name: 'mail_get_raw_message',
    title: 'Get raw RFC822',
    description:
      'Return the raw RFC822 source of one message as base64. Use this for forensic or re-import work. Refuses messages over maxMessageBytes (or maxBytes when set) with SIZE_LIMIT. Prefer mail_get_message for reading. The base64 alphabet is standard, no line wraps.',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox,
      uid: fields.uid,
      uidValidity: fields.uidValidity,
      maxBytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Override the size cap, in octets.'),
    }),
    output: strictOutput({
      ...baseOut,
      mailbox: z.string(),
      uid: z.number(),
      uidValidity: z.string(),
      bytes: z.number(),
      contentBase64: z.string(),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'read',
    examples: ['{"mailbox":"INBOX","uid":41}'],
    async run(args, service) {
      return service.getSource(args as never);
    },
  }),
  define({
    name: 'mail_get_headers',
    title: 'Get message headers',
    description:
      'Return the raw header block of one message (HEADER), not the body. Useful for List-Id, Authentication-Results, or References without downloading attachments. Truncated when longer than maxBodyChars; truncated is then true. Header names are not decoded beyond what the server sent; encoded words remain in the raw text.',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox,
      uid: fields.uid,
      uidValidity: fields.uidValidity,
    }),
    output: strictOutput({
      ...baseOut,
      mailbox: z.string(),
      uid: z.number(),
      uidValidity: z.string(),
      raw: z.string(),
      truncated: z.boolean(),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'read',
    examples: ['{"mailbox":"INBOX","uid":41}'],
    async run(args, service) {
      return service.getHeaders(args as never);
    },
  }),
  define({
    name: 'mail_get_message_part',
    title: 'Get one MIME part',
    description:
      'Fetch a single MIME section by part id (BODY[section]) without the rest of the message. Text parts return text. Other parts return contentBase64, capped by maxBytes (default maxAttachmentBytes). truncated is true when the cap was hit. Part ids come from mail_get_message. Example part ids: "1", "1.2", "2".',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox,
      uid: fields.uid,
      uidValidity: fields.uidValidity,
      partId: z.string().min(1).describe('MIME section id, for example "2" or "1.1".'),
      maxBytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Maximum octets to return. Default limits.maxAttachmentBytes.'),
    }),
    output: strictOutput({
      ...baseOut,
      mailbox: z.string(),
      uid: z.number(),
      partId: z.string(),
      contentType: z.string(),
      filename: z.string().nullable(),
      bytes: z.number(),
      truncated: z.boolean(),
      text: z.string().nullable(),
      contentBase64: z.string().nullable(),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'read',
    examples: ['{"mailbox":"INBOX","uid":41,"partId":"2"}'],
    async run(args, service) {
      return service.getPart(args as never);
    },
  }),
  define({
    name: 'mail_download_attachment',
    title: 'Download an attachment',
    description:
      'Download one attachment chosen by filename, Content-ID (cid), or partIndex (0-based index in the attachment list from mail_get_message, not every MIME leaf). Without savePath the bytes are base64 and must be under maxAttachmentBytes or the call fails with SIZE_LIMIT. With savePath the file is written on the machine running this server and the result contains savedPath and no base64. savePath is rejected unless attachmentsDir is configured, and the resolved path must stay inside that directory.',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox,
      uid: fields.uid,
      uidValidity: fields.uidValidity,
      filename: z.string().optional().describe('Exact filename match.'),
      cid: z.string().optional().describe('Content-ID, with or without angle brackets as stored.'),
      partIndex: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Index in the attachment array from mail_get_message.'),
      savePath: z
        .string()
        .optional()
        .describe(
          'File path to write. Requires attachmentsDir. The resolved path must stay inside that directory. Parent directories are created.',
        ),
    }),
    output: strictOutput({
      ...baseOut,
      mailbox: z.string(),
      uid: z.number(),
      filename: z.string().nullable(),
      contentType: z.string(),
      bytes: z.number(),
      savedPath: z.string().optional(),
      contentBase64: z.string().optional(),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    kind: 'read',
    examples: ['{"mailbox":"INBOX","uid":41,"filename":"notes.pdf","savePath":"/tmp/notes.pdf"}'],
    async run(args, service) {
      return service.downloadAttachment(args as never);
    },
  }),
  define({
    name: 'mail_list_threads',
    title: 'List threads',
    description:
      'Group messages into threads in one mailbox unless folders is set. source is server only when a single folder uses the server THREAD tree. Several folders are built on the client from the References, In-Reply-To, and Message-ID header fields, not from the ENVELOPE alone, and each node is mailbox plus UID. ORDEREDSUBJECT is the opt-in subject heuristic. Every item carries the same threadKey for that conversation: the earliest message with no parent in the set. A folder larger than maxSortCandidates is truncated and reports omitted and scanned. Later pages stay inside the first page UID bound.',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox.optional(),
      search: fields.search.optional(),
      algorithm: z
        .enum(['REFERENCES', 'ORDEREDSUBJECT'])
        .optional()
        .describe(
          'Default REFERENCES. ORDEREDSUBJECT is the subject heuristic and labels rows as subject.',
        ),
      folders: fields.folders,
      maxPerFolder: fields.maxPerFolder,
      limit: fields.limit,
      cursor: fields.cursor,
      uidValidity: fields.uidValidity,
    }),
    output: strictOutput({
      ...baseOut,
      mailbox: z.string(),
      uidValidity: z.string(),
      algorithm: z.string(),
      source: z.enum(['server', 'client']),
      total: z.number(),
      omitted: z.number(),
      truncated: z.boolean(),
      threads: z.array(z.record(z.string(), z.unknown())),
      uids: z.array(z.number()),
      nextCursor: z.string().nullable(),
      offset: z.number(),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'read',
    paged: true,
    examples: ['{"mailbox":"INBOX","algorithm":"REFERENCES","limit":20}'],
    async run(args, service) {
      return service.listThreads(args as never);
    },
  }),
  define({
    name: 'mail_set_flags',
    title: 'Add, remove, or replace flags',
    description:
      'Change flags or keywords on one or more UIDs. operation add is +FLAGS, remove is -FLAGS, set replaces the whole flag set (FLAGS). Adding or removing \\Deleted, and a set that would clear \\Deleted, require allowDelete. System flags may be written "\\\\Seen" or "seen". Custom keywords must not contain spaces. unchangedSince is the CONDSTORE UNCHANGEDSINCE mod-sequence; omit it when the server has no CONDSTORE. Blocked when the account is readOnly. Does not expunge. ok is false when any UID failed; uids lists only the UIDs that changed.',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox,
      uidValidity: fields.uidValidity,
      uids: fields.uids,
      flags: z
        .array(z.string())
        .min(1)
        .describe('Flags or keywords. Examples: ["\\\\Seen"], ["\\\\Flagged","$Forwarded"].'),
      operation: z.enum(['add', 'remove', 'set']).describe('add, remove, or replace.'),
      unchangedSince: z
        .string()
        .optional()
        .describe(
          'CONDSTORE mod-sequence. The update is skipped by the server when the message changed since this value.',
        ),
    }),
    output: strictOutput({
      ...baseOut,
      mailbox: z.string(),
      uids: z.array(z.number()),
      flags: z.array(z.string()),
      operation: z.string(),
      results: z.array(
        z
          .object({
            uid: z.number(),
            ok: z.boolean(),
            code: z.string().optional(),
            message: z.string().optional(),
          })
          .strict(),
      ),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'message-write',
    examples: ['{"mailbox":"INBOX","uids":[41],"flags":["\\\\Seen"],"operation":"add"}'],
    async run(args, service) {
      return service.setFlags(args as never);
    },
  }),
  define({
    name: 'mail_copy_messages',
    title: 'Copy messages',
    description:
      'COPY UIDs to another mailbox, leaving the originals. Requires the destination to exist. Returns per-UID results and, when UIDPLUS is available, the new UID. Blocked when readOnly. Prefer mail_move_messages when the original should disappear.',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox,
      uidValidity: fields.uidValidity,
      uids: fields.uids,
      destination: fields.mailbox.describe('Destination mailbox path. It must already exist.'),
    }),
    output: strictOutput({
      ...baseOut,
      mailbox: z.string(),
      destination: z.string(),
      move: z.boolean(),
      results: z.array(z.record(z.string(), z.unknown())),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    kind: 'message-write',
    examples: ['{"mailbox":"INBOX","uids":[41,42],"destination":"Archive"}'],
    async run(args, service) {
      return service.copyOrMove(args as never, false);
    },
  }),
  define({
    name: 'mail_move_messages',
    title: 'Move messages',
    description:
      'Move UIDs to another mailbox. Uses MOVE when the server advertises it. Otherwise copies, sets \\Deleted, and UID EXPUNGEs, which requires UIDPLUS. Without MOVE and UIDPLUS the call is refused, because a plain EXPUNGE would remove every \\Deleted message. allowPermanentDelete does not permit that. Requires allowDelete. Destination must exist.',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox,
      uidValidity: fields.uidValidity,
      uids: fields.uids,
      destination: fields.mailbox.describe('Destination mailbox path.'),
    }),
    output: strictOutput({
      ...baseOut,
      mailbox: z.string(),
      destination: z.string(),
      move: z.boolean(),
      results: z.array(z.record(z.string(), z.unknown())),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    kind: 'delete',
    examples: ['{"mailbox":"INBOX","uids":[41],"destination":"Archive"}'],
    async run(args, service) {
      return service.copyOrMove(args as never, true);
    },
  }),
  define({
    name: 'mail_delete_messages',
    title: 'Delete messages',
    description:
      'Delete UIDs. By default they are moved to the resolved Trash mailbox (special-use, config, or a well-known name). permanent true UID EXPUNGEs only those UIDs and requires both allowPermanentDelete and UIDPLUS. Without UIDPLUS the call is refused rather than expunging every \\Deleted message. Deleting messages that are already in Trash requires permanent true. Requires allowDelete. Adding \\Deleted via mail_set_flags is the same delete permission. Use mail_expunge_mailbox only when you intend to purge every \\Deleted message in a mailbox.',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox,
      uidValidity: fields.uidValidity,
      uids: fields.uids,
      permanent: z
        .boolean()
        .optional()
        .describe(
          'true expunges immediately. Default false moves to Trash. Requires allowPermanentDelete and UIDPLUS.',
        ),
    }),
    output: strictOutput({
      ...baseOut,
      mailbox: z.string(),
      permanent: z.boolean().optional(),
      uids: z.array(z.number()).optional(),
      results: z.array(z.record(z.string(), z.unknown())).optional(),
      destination: z.string().optional(),
      move: z.boolean().optional(),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    kind: 'delete',
    examples: [
      '{"mailbox":"INBOX","uids":[41]}',
      '{"mailbox":"Trash","uids":[41],"permanent":true}',
    ],
    async run(args, service) {
      return service.deleteMessages(args as never);
    },
  }),
  define({
    name: 'mail_expunge_mailbox',
    title: 'Expunge mailbox',
    description:
      'EXPUNGE the selected mailbox: permanently remove every message that already has \\Deleted. This does not set the flag itself. Requires allowPermanentDelete. Destructive and not limited to one UID. To remove specific UIDs use mail_delete_messages with permanent true, which uses UID EXPUNGE when UIDPLUS is available.',
    input: z.object({ account: fields.account, mailbox: fields.mailbox }),
    output: strictOutput({ ...baseOut, mailbox: z.string(), expunged: z.boolean() }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'permanent',
    examples: ['{"mailbox":"INBOX"}'],
    async run(args, service) {
      const input = args as { account?: string; mailbox: string };
      return service.expunge(input.account, input.mailbox);
    },
  }),
  define({
    name: 'mail_append_message',
    title: 'Append a message',
    description:
      'APPEND a message to a mailbox. Provide either rawBase64 (a full RFC822 message) or the same compose fields as mail_send_message (from, to, subject, text, html, attachments). flags default to none; pass ["\\\\Draft"] to store a draft, or use mail_create_draft. date is the internal date as an ISO timestamp. Blocked when readOnly. The result includes the new UID when the server supports UIDPLUS.',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox,
      rawBase64: z
        .string()
        .optional()
        .describe('Full RFC822 message, base64. When set, compose fields are ignored.'),
      from: fields.address.optional(),
      to: fields.addressList.optional(),
      cc: fields.addressList.optional(),
      bcc: fields.addressList.optional(),
      subject: z.string().optional().describe('Subject. Encoded words are applied as needed.'),
      text: z.string().optional().describe('Plain text body.'),
      html: z
        .string()
        .optional()
        .describe('HTML body. With text, the message is multipart/alternative.'),
      attachments: z.array(fields.attachment).optional(),
      flags: z.array(z.string()).optional().describe('Flags to store. Example: ["\\\\Seen"].'),
      date: z.string().optional().describe('Internal date, ISO 8601. Default is now.'),
      allowEmptyRecipients: z
        .boolean()
        .optional()
        .describe('Allow append with no To, for drafts. Default false.'),
    }),
    output: strictOutput({
      ...baseOut,
      destination: z.string(),
      uid: z.number().optional(),
      uidValidity: z.string().optional(),
      bytes: z.number(),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    kind: 'message-write',
    examples: [
      '{"mailbox":"INBOX","to":["ada@example.com"],"subject":"Note","text":"Hello","allowEmptyRecipients":false}',
    ],
    async run(args, service) {
      return service.append(args as never);
    },
  }),
  define({
    name: 'mail_set_labels',
    title: 'Set Gmail labels',
    description:
      'Add, remove, or replace Gmail labels on UIDs. Requires X-GM-EXT-1; other servers return CAPABILITY_UNSUPPORTED. Labels are names such as "Work" or "\\\\Inbox", not IMAP keywords. operation set replaces the label set. This is not mail_set_flags. ok is false when any UID failed. uids lists only the UIDs that changed. results has one row per requested UID.',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox,
      uidValidity: fields.uidValidity,
      uids: fields.uids,
      labels: z.array(z.string().min(1)).min(1).describe('Gmail label names.'),
      operation: z
        .enum(['add', 'remove', 'set'])
        .describe('add labels, remove labels, or replace the whole label set.'),
    }),
    output: strictOutput({
      ...baseOut,
      mailbox: z.string(),
      uids: z.array(z.number()),
      labels: z.array(z.string()),
      operation: z.string(),
      results: z.array(
        z
          .object({
            uid: z.number(),
            ok: z.boolean(),
            code: z.string().optional(),
            message: z.string().optional(),
          })
          .strict(),
      ),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'message-write',
    examples: ['{"mailbox":"INBOX","uids":[41],"labels":["Work"],"operation":"add"}'],
    async run(args, service) {
      return service.setLabels(args as never);
    },
  }),
  define({
    name: 'mail_bulk_modify',
    title: 'Bulk modify messages',
    description:
      'Apply one action to many UIDs and return a per-UID result. Actions: addFlags, removeFlags, setFlags, copy, move, delete, addLabels, removeLabels. delete uses the Trash move unless permanent is true. copy and move need destination. Flag actions need flags. Label actions need labels and Gmail. The call itself succeeds when the batch was attempted; inspect results[].ok. UIDs above maxBulk are rejected up front.',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox,
      uidValidity: fields.uidValidity,
      uids: fields.uids,
      action: z
        .enum([
          'addFlags',
          'removeFlags',
          'setFlags',
          'copy',
          'move',
          'delete',
          'addLabels',
          'removeLabels',
        ])
        .describe('The single operation applied to every UID.'),
      flags: z
        .array(z.string())
        .optional()
        .describe('Flags for addFlags, removeFlags, and setFlags. Example: ["\\\\Seen"].'),
      labels: z
        .array(z.string())
        .optional()
        .describe('Gmail labels for addLabels and removeLabels.'),
      destination: z.string().optional().describe('Required for copy and move.'),
      permanent: z.boolean().optional().describe('For delete only. Default false.'),
    }),
    output: strictOutput({
      ...baseOut,
      mailbox: z.string(),
      action: z.string(),
      results: z.array(z.record(z.string(), z.unknown())),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    kind: 'message-write',
    examples: ['{"mailbox":"INBOX","uids":[41,42],"action":"addFlags","flags":["\\\\Seen"]}'],
    async run(args, service) {
      return service.bulk(args as never);
    },
  }),
  define({
    name: 'mail_create_draft',
    title: 'Create a draft',
    description:
      'Build a message and APPEND it to the Drafts mailbox with \\Draft. The Drafts path is resolved automatically unless mailbox is set. Recipients may be empty. Does not send. Use mail_update_draft to replace one and mail_send_draft to submit it. Blocked when readOnly.',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox.optional().describe('Override the resolved Drafts mailbox.'),
      from: fields.address
        .optional()
        .describe('Must be one of the account identities. Default identity is used when omitted.'),
      to: fields.addressList.optional(),
      cc: fields.addressList.optional(),
      bcc: fields.addressList.optional(),
      replyTo: fields.addressList.optional(),
      subject: z.string().optional().describe('Draft subject.'),
      text: z.string().optional().describe('Plain text body.'),
      html: z.string().optional().describe('HTML body.'),
      attachments: z.array(fields.attachment).optional(),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe('Extra headers. Do not set Bcc here; use bcc.'),
    }),
    output: strictOutput({
      ...baseOut,
      mailbox: z.string(),
      uid: z.number().optional(),
      uidValidity: z.string().optional(),
      destination: z.string().optional(),
      bytes: z.number().optional(),
      replacedUid: z.number().nullable().optional(),
      identity: z
        .object({ id: z.string().nullable(), email: z.string(), name: z.string().optional() })
        .strict(),
      identityReason: z.enum(['explicit', 'single-match', 'default-no-match', 'default-ambiguous']),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    kind: 'message-write',
    examples: ['{"to":["ada@example.com"],"subject":"Draft","text":"Still writing"}'],
    async run(args, service) {
      return service.saveDraft({ ...(args as object), allowEmptyRecipients: true } as never);
    },
  }),
  define({
    name: 'mail_update_draft',
    title: 'Update a draft',
    description:
      'Replace a draft: APPEND a new copy, then delete the UID you pass. The delete is a Trash move unless allowPermanentDelete is on, in which case the old UID is expunged. Pass the same compose fields as mail_create_draft. uid is the existing draft.',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox.optional(),
      uid: fields.uid.describe('UID of the draft to replace.'),
      from: fields.address.optional(),
      to: fields.addressList.optional(),
      cc: fields.addressList.optional(),
      bcc: fields.addressList.optional(),
      replyTo: fields.addressList.optional(),
      subject: z.string().optional().describe('Replacement subject.'),
      text: z.string().optional().describe('Replacement plain text body.'),
      html: z.string().optional().describe('Replacement HTML body.'),
      attachments: z.array(fields.attachment).optional(),
    }),
    output: strictOutput({
      ...baseOut,
      mailbox: z.string(),
      uid: z.number().optional(),
      uidValidity: z.string().optional(),
      destination: z.string().optional(),
      bytes: z.number().optional(),
      replacedUid: z.number().nullable(),
      identity: z
        .object({ id: z.string().nullable(), email: z.string(), name: z.string().optional() })
        .strict(),
      identityReason: z.enum(['explicit', 'single-match', 'default-no-match', 'default-ambiguous']),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    kind: 'message-write',
    examples: ['{"uid":12,"subject":"Draft","text":"Updated"}'],
    async run(args, service) {
      const input = args as { uid: number };
      return service.saveDraft(
        { ...(args as object), allowEmptyRecipients: true } as never,
        input.uid,
      );
    },
  }),
  define({
    name: 'mail_delete_draft',
    title: 'Delete a draft',
    description:
      'Delete one draft UID. Moves it to Trash unless you are already in Trash. mailbox defaults to the resolved Drafts folder. Requires allowDelete. This does not send the draft.',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox
        .optional()
        .describe('Drafts mailbox. Default is the resolved Drafts folder.'),
      uid: fields.uid,
    }),
    output: strictOutput({ ...baseOut }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'delete',
    examples: ['{"uid":12}'],
    async run(args, service) {
      const input = args as { account?: string; uid: number; mailbox?: string };
      return service.deleteDraft(input.account, input.uid, input.mailbox);
    },
  }),
  define({
    name: 'mail_send_message',
    title: 'Send a message',
    description:
      'Submit a message over SMTP (RFC 5321 / RFC 6409). Supports text, HTML (multipart/alternative when both are set), attachments from base64 or a local path, inline cid images, extra headers, priority (high, normal, low), a read receipt (Disposition-Notification-To set from the From identity), and DSN options when the server advertises DSN. from and replyTo must be configured identities, or allowFromDomains must list the domain. When replyTo is omitted, the selected identity replyTo is used. headers is an allow-list: X-* plus List-Unsubscribe, List-Unsubscribe-Post, Auto-Submitted, Precedence, Importance, Keywords, and Comments. An X- header is lowercased first and is never split on camelCase. The remainder after X- is split on "-" and "_", and trailing digits are stripped from the last token. It is rejected when that token is to, from, sender, cc, bcc, or recipient, when the trailing tokens are an address-bearing name (reply-to, errors-to, return-path, delivered-to, apparently-to, apparently-from, original-from, original-sender, original-to, original-recipient, receipt-to, read-receipt-to, return-receipt-to, notification-to, disposition-notification-to, confirm-reading-to, reading-to, mdn-to, mail-followup-to, followup-to, mail-reply-to, or rcpt-to), or when any token is resent, envelope, rcpt, or bounce. The same lowercased name, with "-" and "_" and trailing digits removed, is always rejected when it ends with from, sender, recipient, replyto, errorsto, returnpath, deliveredto, receiptto, notificationto, readingto, mdnto, apparentlyto, followupto, originalto, or rcptto, or when it contains resent, envelope, rcpt, or bounce. X-Report-Abuse-To, X-Complaint-To, X-Authenticated-Sender, and X-Forwarded-To are rejected on purpose. Other X-* headers stay allowed. A parenthesized comment on to, cc, bcc, or replyTo is dropped and the addr-spec is kept. From, Sender, Reply-To, To, Cc, Bcc, Message-ID, Return-Path, Resent-*, and receipt or legacy reply headers are rejected; use the structured from, replyTo, to, cc, and bcc fields. Names that contain spaces, controls, or a colon are rejected. recipientDomainAllowList and sendRateLimit are enforced. After a successful send, the message is appended to Sent unless the provider is Gmail (which stores Sent itself) or appendSent is false or the account sets appendSent false. envelopeFrom and envelopeTo override the SMTP envelope without changing headers. Blocked when allowSend is false or readOnly.',
    input: z.object({
      account: fields.account,
      from: fields.address
        .optional()
        .describe('From identity. Default is the account default identity.'),
      to: fields.addressList.min(1),
      cc: fields.addressList.optional(),
      bcc: fields.addressList
        .optional()
        .describe('Envelope recipients. Not stored in the message header by the composer.'),
      replyTo: fields.addressList
        .optional()
        .describe(
          'Reply-To. Omit to use the selected identity replyTo. Must be an identity or an allowFromDomains address. A display name that contains another address is not sent.',
        ),
      subject: z.string().describe('Subject line.'),
      text: z.string().optional().describe('Plain text body. Provide text, html, or both.'),
      html: z.string().optional().describe('HTML body.'),
      attachments: z.array(fields.attachment).optional(),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          'Allow-listed headers only: X-* except routing and receipt aliases. An X- name is lowercased first and is never split on camelCase. The remainder after X- is split on "-" and "_", and trailing digits are stripped from the last token. It is rejected when that token is to, from, sender, cc, bcc, or recipient, when the trailing tokens are reply-to, errors-to, return-path, delivered-to, apparently-to, apparently-from, original-from, original-sender, original-to, original-recipient, receipt-to, read-receipt-to, return-receipt-to, notification-to, disposition-notification-to, confirm-reading-to, reading-to, mdn-to, mail-followup-to, followup-to, mail-reply-to, or rcpt-to, or when any token is resent, envelope, rcpt, or bounce. The same lowercased name, with "-" and "_" and trailing digits removed, is always rejected when it ends with from, sender, recipient, replyto, errorsto, returnpath, deliveredto, receiptto, notificationto, readingto, mdnto, apparentlyto, followupto, originalto, or rcptto, or when it contains resent, envelope, rcpt, or bounce. X-Report-Abuse-To, X-Complaint-To, X-Authenticated-Sender, and X-Forwarded-To are rejected on purpose. Other X-* headers are allowed, plus List-Unsubscribe, List-Unsubscribe-Post, Auto-Submitted, Precedence, Importance, Keywords, and Comments. Address headers are rejected; use from, replyTo, to, cc, and bcc.',
        ),
      priority: z
        .enum(['high', 'normal', 'low'])
        .optional()
        .describe('Sets the priority headers. Default is omitted.'),
      readReceipt: z
        .boolean()
        .optional()
        .describe('true requests a read receipt to the From address.'),
      envelopeFrom: z
        .string()
        .optional()
        .describe('SMTP MAIL FROM override. Default is the header From.'),
      envelopeTo: z
        .array(z.string())
        .optional()
        .describe('SMTP RCPT TO override. Default is to+cc+bcc.'),
      dsn: z
        .object({
          id: z.string().optional().describe('ENVID.'),
          ret: z.enum(['FULL', 'HDRS']).optional().describe('RET. FULL or HDRS.'),
          notify: z
            .array(z.enum(['never', 'success', 'failure', 'delay']))
            .optional()
            .describe('NOTIFY values.'),
          orcpt: z.string().optional().describe('ORCPT. A bare address is sent as rfc822;address.'),
        })
        .optional()
        .describe('DSN request. Ignored by servers that do not advertise DSN.'),
      appendSent: z
        .boolean()
        .optional()
        .describe(
          'Force or skip the Sent APPEND. Default follows account appendSent (auto skips Gmail).',
        ),
    }),
    output: strictOutput({
      ...baseOut,
      bytes: z.number(),
      smtp: z.record(z.string(), z.unknown()),
      sentAppend: z.record(z.string(), z.unknown()).nullable(),
      identity: z
        .object({
          id: z.string().nullable(),
          email: z.string(),
          name: z.string().optional(),
        })
        .strict(),
      identityReason: z.enum(['explicit', 'single-match', 'default-no-match', 'default-ambiguous']),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    kind: 'send',
    examples: ['{"to":["ada@example.com"],"subject":"Hello","text":"Hi Ada"}'],
    async run(args, service) {
      return service.send(args as never);
    },
  }),
  define({
    name: 'mail_reply_message',
    title: 'Reply to a message',
    description:
      'Reply to a message identified by account, mailbox, and UID. Sets In-Reply-To and References, prefixes the subject with Re: unless it already has a reply prefix (Re, Aw, Sv), and quotes the original plain text (or the HTML rendered to text). replyAll true puts the original From (or Reply-To) in To and the other recipients in Cc, omitting this account. An omitted replyTo uses the selected identity replyTo. The result is the same shape as mail_send_message. Requires allowSend.',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox,
      uid: fields.uid,
      uidValidity: fields.uidValidity,
      replyAll: z
        .boolean()
        .optional()
        .describe(
          'true replies to all recipients. Default false replies only to From or Reply-To.',
        ),
      from: fields.address
        .optional()
        .describe(
          'From identity. When omitted, an identity is selected only if exactly one configured address is in the original To or Cc.',
        ),
      replyTo: fields.addressList
        .optional()
        .describe(
          'Reply-To. Omit to use the selected identity replyTo. The address must be an identity or an allowFromDomains address. A display name that contains another address is dropped.',
        ),
      text: z.string().optional().describe('Your reply, placed above the quoted original.'),
      html: z
        .string()
        .optional()
        .describe('Optional HTML for your reply. Quoting is still done in the text part.'),
      subject: z
        .string()
        .optional()
        .describe('Override the subject. Default is Re: plus the original subject.'),
      attachments: z.array(fields.attachment).optional(),
      appendSent: z
        .boolean()
        .optional()
        .describe('Force or skip the Sent APPEND. Default follows the account setting.'),
    }),
    output: strictOutput({
      ...baseOut,
      bytes: z.number(),
      smtp: z.record(z.string(), z.unknown()),
      sentAppend: z.record(z.string(), z.unknown()).nullable(),
      identity: z
        .object({
          id: z.string().nullable(),
          email: z.string(),
          name: z.string().optional(),
        })
        .strict(),
      identityReason: z.enum(['explicit', 'single-match', 'default-no-match', 'default-ambiguous']),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    kind: 'send',
    examples: ['{"mailbox":"INBOX","uid":41,"text":"Thanks, I will look."}'],
    async run(args, service) {
      return service.reply(args as never);
    },
  }),
  define({
    name: 'mail_forward_message',
    title: 'Forward a message',
    description:
      'Forward a message by UID. Subject gains Fwd: unless it already has a forward prefix. The original text is quoted under a forwarded-message line. includeAttachments defaults to true and reattaches non-inline originals. Inline images are not copied. Pass to (required) and optional cc. Same send result and Sent-append rules as mail_send_message.',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox,
      uid: fields.uid,
      uidValidity: fields.uidValidity,
      from: fields.address
        .optional()
        .describe('From identity. Same selection rules as mail_reply_message.'),
      replyTo: fields.addressList.optional(),
      to: fields.addressList.min(1),
      cc: fields.addressList.optional(),
      text: z.string().optional().describe('Note placed above the forwarded body.'),
      html: z.string().optional().describe('Optional HTML body for the note you add.'),
      subject: z
        .string()
        .optional()
        .describe('Override the subject. Default is Fwd: plus the original.'),
      attachments: z
        .array(fields.attachment)
        .optional()
        .describe(
          'Extra attachments, in addition to the originals when includeAttachments is true.',
        ),
      includeAttachments: z
        .boolean()
        .optional()
        .describe('Include original non-inline attachments. Default true.'),
      appendSent: z
        .boolean()
        .optional()
        .describe('Force or skip the Sent APPEND. Default follows the account setting.'),
    }),
    output: strictOutput({
      ...baseOut,
      bytes: z.number(),
      smtp: z.record(z.string(), z.unknown()),
      sentAppend: z.record(z.string(), z.unknown()).nullable(),
      identity: z
        .object({
          id: z.string().nullable(),
          email: z.string(),
          name: z.string().optional(),
        })
        .strict(),
      identityReason: z.enum(['explicit', 'single-match', 'default-no-match', 'default-ambiguous']),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    kind: 'send',
    examples: ['{"mailbox":"INBOX","uid":41,"to":["bea@example.com"],"text":"FYI"}'],
    async run(args, service) {
      return service.forward(args as never);
    },
  }),
  define({
    name: 'mail_send_draft',
    title: 'Send a saved draft',
    description:
      'Submit a saved draft over SMTP. The stored message is parsed on every send and the submitted bytes are rebuilt. From, Sender, and Reply-To are written once from the checked addr-specs, and To, Cc, and Bcc are written the same way. A display name is NFKC-normalized after encoded-word decoding and dropped when it contains @ or <>, when it is still an encoded-word, or when it came from a comment. A parenthesized comment is accepted on To, Cc, and Bcc and on send, reply, and forward, and the addr-spec is kept. Duplicate allow-listed headers stay separate fields, and each keeps the field name from the draft. A second From, Sender, or Reply-To, or a field name that is not an RFC 5322 field name (whitespace before the colon), is PERMISSION_DENIED. Allow-listed headers are copied from the raw header block, original field name and raw value, so List-Unsubscribe, List-Unsubscribe-Post, and Importance survive. Every address on From, Sender, Reply-To, Resent-*, and the receipt or legacy reply headers must be a configured identity. recipientDomainAllowList and sendRateLimit apply. When the draft has no Reply-To, the selected identity replyTo is applied. identityReason is stored-draft when from is omitted, and explicit when from is passed. mailbox defaults to wherever the draft lives; pass the Drafts path and the draft UID. Does not delete the draft; call mail_delete_draft afterwards if you want it gone.',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox.describe('Mailbox that holds the draft, usually Drafts.'),
      uid: fields.uid,
      uidValidity: fields.uidValidity,
      from: fields.address
        .optional()
        .describe('Replace the draft From. Must be an identity or an allowFromDomains address.'),
      replyTo: fields.addressList
        .optional()
        .describe(
          'Replace Reply-To. Omit to keep a stored Reply-To that is an identity, or to apply the identity replyTo when the draft has none.',
        ),
      appendSent: z
        .boolean()
        .optional()
        .describe('Force or skip the Sent APPEND. Default follows the account setting.'),
    }),
    output: strictOutput({
      ...baseOut,
      uid: z.number(),
      smtp: z.record(z.string(), z.unknown()),
      sentAppend: z.record(z.string(), z.unknown()).nullable(),
      identity: z
        .object({ id: z.string().nullable(), email: z.string(), name: z.string().optional() })
        .strict(),
      identityReason: z
        .enum(['explicit', 'single-match', 'default-no-match', 'default-ambiguous', 'stored-draft'])
        .describe(
          'stored-draft when from is omitted and From comes from the draft. explicit when from is passed.',
        ),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    kind: 'send',
    examples: ['{"mailbox":"Drafts","uid":12}'],
    async run(args, service) {
      return service.sendDraft(args as never);
    },
  }),
  define({
    name: 'mail_verify_smtp',
    title: 'Verify SMTP',
    description:
      'Authenticate to the submission server and disconnect, without sending. Use this when mail_send_message fails and you want to separate SMTP problems from message construction. The result includes ok, and on failure a code such as AUTH_FAILED or TLS_FAILED plus a hint. No message is stored.',
    input: z.object({ account: fields.account }),
    output: strictOutput({ ...baseOut, smtp: z.record(z.string(), z.unknown()) }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'read',
    examples: ['{}'],
    async run(args, service) {
      return service.verifySmtp((args as { account?: string }).account);
    },
  }),
  define({
    name: 'mail_wait_for_changes',
    title: 'Wait for mailbox changes',
    description:
      'Block until the mailbox changes or timeoutMs elapses (default 25000, range 1000 to 120000). Uses IDLE when the server advertises it, otherwise the connection polls. Returns the events seen (exists, expunge, flags) and a fresh STATUS. timedOut is true when nothing changed. idleSupported says which mechanism ran. This is the right tool for "tell me when new mail arrives"; do not poll mail_list_messages in a tight loop. The call holds one pooled connection until it returns.',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox.optional().describe('Mailbox to watch. Default INBOX.'),
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(120000)
        .optional()
        .describe('How long to wait, in milliseconds. Default 25000.'),
    }),
    output: strictOutput({
      ...baseOut,
      mailbox: z.string(),
      timedOut: z.boolean(),
      idleSupported: z.boolean(),
      changes: z.array(z.record(z.string(), z.unknown())),
      status: z.record(z.string(), z.unknown()),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    kind: 'read',
    examples: ['{"mailbox":"INBOX","timeoutMs":15000}'],
    async run(args, service) {
      return service.waitForChanges(args as never);
    },
  }),
  define({
    name: 'mail_get_thread',
    title: 'Get a conversation',
    description:
      "Return one conversation, earlier and later messages, across folders. Pass mailbox and uid, or a messageId. With no folders, a Message-ID seed uses the same scope as a mailbox and uid seed: the seed mailbox, INBOX, Sent, Archive, and All. Junk and Trash stay out unless named, and so does every other folder that is not in that scope. After the thread is closed, the id set is every Message-ID of the items, every id they cite in In-Reply-To or References, and the seed's own ids. excludedMatches is one path-ordered list for every seed of that conversation: every selectable folder outside the scope whose messages' Message-ID, In-Reply-To, or References intersect that set, with a count of those messages. An in-scope folder is never listed. An empty list means every match is in scope. A Message-ID whose only exact copy is in Junk or Trash is still walked in both directions from that copy's Message-ID, In-Reply-To, and References, so an in-scope parent and an in-scope reply are items and the Junk or Trash copy stays out. If nothing in scope matches, items are empty and excludedMatches still names that folder; name Junk or Trash in folders to open it. Out-of-scope folders are counted with UID SEARCH in batches of eight ids, not a full header fetch, and an empty mailbox is not searched. Pass folders to include one. Copies of the same Message-ID outside Junk and Trash are included. folders is applied before the Message-ID lookup. \\Noselect and \\NonExistent paths are skipped; naming one returns MAILBOX_NOT_SELECTABLE. Messages are linked by exact Message-ID, In-Reply-To, and References tokens. Gmail X-GM-THRID is used when X-GM-EXT-1 is present, otherwise OBJECTID THREADID. Each item says how it was linked: header, gmail-thrid, objectid, or subject. subject is opt-in via subjectHeuristic. Copies that share a Message-ID collapse; messages with no Message-ID stay separate. alsoIn lists the other folders. The envelope threadKey and every item threadKey are the earliest message with no parent in the set. The first page freezes mailbox and UID keys. Later pages re-fetch those keys, including a child whose linking parent was expunged, and a UIDVALIDITY change returns CURSOR_INVALIDATED. includeBodies caps the page at 20. Identities are listed by mail_list_accounts.",
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox.optional().describe('Required with uid.'),
      uid: fields.uid.optional(),
      uidValidity: fields.uidValidity,
      messageId: z.string().optional().describe('Find the seed by Message-ID instead of uid.'),
      folders: fields.folders,
      includeBodies: z
        .boolean()
        .optional()
        .describe('Include capped plain text. Default false. Page size max 20.'),
      onlyUnread: z.boolean().optional().describe('Keep only messages without \\Seen.'),
      subjectHeuristic: z
        .boolean()
        .optional()
        .describe(
          'Also link messages that share a normalized subject and a participant. Default false. Those items are linked "subject".',
        ),
      maxMessages: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe(
          'Stop after this many in-scope messages. A Junk or Trash Message-ID seed does not consume a slot. Default 100, max 500.',
        ),
      maxRounds: z
        .number()
        .int()
        .positive()
        .max(8)
        .optional()
        .describe('Header-search rounds. Default 4, max 8.'),
    }),
    output: strictOutput({
      ...baseOut,
      threadKey: z.string(),
      tree: z.array(z.record(z.string(), z.unknown())),
      rounds: z.number(),
      messages: z.array(z.record(z.string(), z.unknown())),
      offset: z.number(),
      excludedMatches: z
        .array(
          z
            .object({
              mailbox: z.string(),
              count: z.number().int(),
            })
            .strict(),
        )
        .describe(
          "Folders outside this scope whose Message-ID, In-Reply-To, or References intersect the closed thread. That id set is every item Message-ID, every id the items cite, and the seed's own ids. The same path-ordered list for every seed of the conversation, each with a count of distinct messages. Empty when every match is in scope. An in-scope folder is never listed. A Junk or Trash copy that was not opened is listed here; name that folder in folders to open it.",
        ),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'read',
    paged: true,
    examples: ['{"mailbox":"INBOX","uid":41}'],
    async run(args, service) {
      return service.getThread(args as never);
    },
  }),
  define({
    name: 'mail_count',
    title: 'Count messages per folder',
    description:
      'STATUS counts for each folder in the scope: messages, unseen, recent, uidNext, and uidValidity. When search is set, matches is the SEARCH count for that folder. The folder list is paged. Counts are exact for the folders on this page. A new call without a cursor sees folders created after the snapshot.',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox.optional(),
      folders: fields.folders,
      search: fields.search.optional(),
    }),
    output: strictOutput({ ...baseOut, offset: z.number() }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'read',
    paged: true,
    examples: ['{"folders":"all"}'],
    async run(args, service) {
      return service.countMessages(args as never);
    },
  }),
  define({
    name: 'mail_list_attachments',
    title: 'List attachment metadata',
    description:
      'Page attachment metadata across a folder scope: filename, contentType, size, and partId. No bytes. Each row is one part, so a message with several attachments takes several rows. The cursor keeps mailbox, UIDVALIDITY, UID, and partId, and later pages stay inside the first page UID bound. Messages past the per-folder cap are omitted and truncated is true. Use mail_download_attachment for the bytes of one part.',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox.optional(),
      folders: fields.folders,
      search: fields.search.optional(),
      maxPerFolder: fields.maxPerFolder,
    }),
    output: strictOutput({ ...baseOut, offset: z.number() }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'read',
    paged: true,
    examples: ['{"mailbox":"INBOX","search":{"larger":100000}}'],
    async run(args, service) {
      return service.listAttachments(args as never);
    },
  }),
  define({
    name: 'mail_list_correspondents',
    title: 'List correspondents',
    description:
      'Count exact normalized From addresses over a folder scope and optional search. Own identities are excluded. Ties break by address. Every matching UID is read in batches, up to 10000 messages per folder. Above that cap truncated and partial are true and the counts cover only that prefix, not the whole mailbox. Later pages reuse the first page UID bound. Discover identities with mail_list_accounts.',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox.optional(),
      folders: fields.folders,
      search: fields.search.optional(),
      maxPerFolder: fields.maxPerFolder,
    }),
    output: strictOutput({
      ...baseOut,
      offset: z.number(),
      scanned: z.number(),
      partial: z
        .boolean()
        .describe(
          'True when the counts cover only the scanned prefix of a folder over 10000 matches.',
        ),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'read',
    paged: true,
    examples: ['{"folders":"all","search":{"since":"2026-01-01"}}'],
    async run(args, service) {
      return service.listCorrespondents(args as never);
    },
  }),
  define({
    name: 'mail_search_facets',
    title: 'Count a search',
    description:
      'Counts for a folder scope and optional search: matches, unread, flagged, and answered per folder, plus a has-attachments count and the top sender addresses and domains. top defaults to 10 and maxes at 100. Ties break alphabetically. Flag counts come from SEARCH and stay exact. Sender and attachment counts read every matching UID in batches, up to 10000 per folder. Above that cap truncated and partial are true and those two counts cover only the scanned prefix. This tool does not page.',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox.optional(),
      folders: fields.folders,
      search: fields.search.optional(),
      maxPerFolder: fields.maxPerFolder,
      top: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe('Sender and domain rows. Default 10, max 100.'),
    }),
    output: strictOutput({
      ...baseOut,
      folders: z.array(z.record(z.string(), z.unknown())),
      hasAttachments: z.number(),
      senders: z.array(z.object({ value: z.string(), count: z.number() }).strict()),
      domains: z.array(z.object({ value: z.string(), count: z.number() }).strict()),
      scanned: z.number(),
      truncated: z.boolean(),
      partial: z
        .boolean()
        .describe(
          'True when sender and attachment counts cover only the first 10000 matches in a folder.',
        ),
      top: z.number(),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    kind: 'read',
    examples: ['{"folders":"all","search":{"unkeyword":"$Junk"},"top":10}'],
    async run(args, service) {
      return service.searchFacets(args as never);
    },
  }),
  define({
    name: 'mail_modify_by_search',
    title: 'Modify messages that match a search',
    description:
      'Apply addFlags, removeFlags, move, or archive to every message in a folder scope that matches search. dryRun defaults to true and only pages a preview. A real run is refused with SIZE_LIMIT, and changes nothing, when the match count exceeds limits.maxBulk or any folder is truncated or not fully loaded. move and archive require allowDelete. Adding or removing \\Deleted does too. There is no permanent delete here. The preview uses the shared snapshot cursor. The tool is a write: a readOnly account does not advertise it.',
    input: z.object({
      account: fields.account,
      mailbox: fields.mailbox.optional(),
      folders: fields.folders,
      search: fields.search,
      action: z
        .enum(['addFlags', 'removeFlags', 'move', 'archive'])
        .describe(
          'addFlags and removeFlags use flags. move uses destination. archive moves to the Archive mailbox.',
        ),
      flags: z.array(z.string()).optional().describe('Flags for addFlags or removeFlags.'),
      destination: z
        .string()
        .optional()
        .describe('Target mailbox for move. Archive uses this or the resolved Archive mailbox.'),
      dryRun: z.boolean().optional().describe('Default true. false applies the action.'),
      maxPerFolder: fields.maxPerFolder,
    }),
    output: strictOutput({
      ...baseOut,
      dryRun: z.boolean(),
      action: z.string(),
      matched: z.number(),
      offset: z.number(),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    kind: 'message-write',
    paged: true,
    examples: ['{"mailbox":"INBOX","search":{"seen":true},"action":"archive","dryRun":true}'],
    async run(args, service) {
      return service.modifyBySearch(args as never);
    },
  }),
];

export function toolByName(name: string): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.name === name);
}
