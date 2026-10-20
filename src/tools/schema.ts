import { z } from 'zod';

const account = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".',
  );

const mailbox = z
  .string()
  .min(1)
  .describe(
    'Mailbox path as returned by mail_list_mailboxes, in Unicode (not modified UTF-7). Nested folders use the server delimiter, often "/" or ".". Examples: "INBOX", "Projects/2026", "Entwürfe".',
  );

const uid = z
  .number()
  .int()
  .positive()
  .describe(
    'IMAP UID of one message. UIDs are only meaningful together with the mailbox uidValidity.',
  );

const uids = z
  .array(uid)
  .min(1)
  .describe(
    'IMAP UIDs to change. The server limit is limits.maxBulk (default 200). Each UID is applied separately so a failure does not hide the others when the tool returns per-item results.',
  );

const uidValidity = z
  .string()
  .regex(/^\d+$/)
  .optional()
  .describe(
    'Expected UIDVALIDITY decimal string from mail_get_mailbox_status or a previous list. When set, the call fails with UIDVALIDITY_CHANGED if the mailbox was recreated.',
  );

export const search: z.ZodType<{
  all?: boolean;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  text?: string;
  header?: { name: string; value?: string };
  since?: string;
  before?: string;
  on?: string;
  sentSince?: string;
  sentBefore?: string;
  sentOn?: string;
  larger?: number;
  smaller?: number;
  seen?: boolean;
  answered?: boolean;
  flagged?: boolean;
  deleted?: boolean;
  draft?: boolean;
  recent?: boolean;
  keyword?: string;
  unkeyword?: string;
  uid?: string;
  seq?: string;
  modseq?: string;
  emailId?: string;
  threadId?: string;
  gmraw?: string;
  labels?: { has?: string[]; not?: string[] };
  not?: unknown;
  or?: unknown[];
  and?: unknown[];
}> = z
  .object({
    all: z
      .boolean()
      .optional()
      .describe('Match every message. Usually omit this and set a real criterion.'),
    from: z
      .string()
      .optional()
      .describe('Substring match on the From header. Example: "ada@example.com".'),
    to: z.string().optional().describe('Substring match on To.'),
    cc: z.string().optional().describe('Substring match on Cc.'),
    bcc: z.string().optional().describe('Substring match on Bcc. Many servers do not store Bcc.'),
    subject: z.string().optional().describe('Substring match on Subject.'),
    body: z.string().optional().describe('Substring match on the body, not headers.'),
    text: z.string().optional().describe('Substring match on headers and body.'),
    header: z
      .object({
        name: z.string().describe('Header field name, for example "List-Id" or "Message-ID".'),
        value: z
          .string()
          .optional()
          .describe(
            'Substring the header must contain. Omit to test only that the header is present.',
          ),
      })
      .optional()
      .describe('Match one header field.'),
    since: z
      .string()
      .optional()
      .describe(
        'Internal date on or after this day. YYYY-MM-DD or ISO timestamp. Time of day is ignored.',
      ),
    before: z
      .string()
      .optional()
      .describe('Internal date before this day (exclusive of the day in IMAP). YYYY-MM-DD.'),
    on: z.string().optional().describe('Internal date on this calendar day. YYYY-MM-DD.'),
    sentSince: z.string().optional().describe('Date header on or after this day. YYYY-MM-DD.'),
    sentBefore: z.string().optional().describe('Date header before this day. YYYY-MM-DD.'),
    sentOn: z.string().optional().describe('Date header on this day. YYYY-MM-DD.'),
    larger: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Message size strictly greater than this many octets.'),
    smaller: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Message size strictly less than this many octets.'),
    seen: z
      .boolean()
      .optional()
      .describe('true requires \\Seen, false requires the flag to be absent.'),
    answered: z
      .boolean()
      .optional()
      .describe('true requires \\Answered, false requires it absent.'),
    flagged: z.boolean().optional().describe('true requires \\Flagged, false requires it absent.'),
    deleted: z.boolean().optional().describe('true requires \\Deleted, false requires it absent.'),
    draft: z.boolean().optional().describe('true requires \\Draft, false requires it absent.'),
    recent: z
      .boolean()
      .optional()
      .describe(
        'true requires \\Recent. Recent is session-specific and often useless after the first look.',
      ),
    keyword: z
      .string()
      .optional()
      .describe(
        'Custom keyword that must be set, without a leading backslash. Example: "$Forwarded".',
      ),
    unkeyword: z.string().optional().describe('Custom keyword that must be absent.'),
    uid: z.string().optional().describe('UID set. Examples: "10", "10:20", "1,5,9:*".'),
    seq: z
      .string()
      .optional()
      .describe('Sequence-number set, not UIDs. Prefer uid. Example: "1:10".'),
    modseq: z
      .string()
      .optional()
      .describe('Decimal MODSEQ. Requires CONDSTORE. Matches messages changed after this value.'),
    emailId: z
      .string()
      .optional()
      .describe('OBJECTID EMAILID or Gmail X-GM-MSGID. Requires OBJECTID or X-GM-EXT-1.'),
    threadId: z.string().optional().describe('OBJECTID THREADID or Gmail X-GM-THRID.'),
    gmraw: z
      .string()
      .optional()
      .describe(
        'Gmail X-GM-RAW query, the same language as the Gmail search box. Example: "has:attachment newer_than:7d".',
      ),
    labels: z
      .object({
        has: z.array(z.string()).optional().describe('Gmail labels the message must have.'),
        not: z.array(z.string()).optional().describe('Gmail labels the message must not have.'),
      })
      .optional()
      .describe('Gmail label filter. Requires X-GM-EXT-1.'),
    not: z
      .lazy(() => search)
      .optional()
      .describe('Negate a nested search object.'),
    or: z
      .array(z.lazy(() => search))
      .optional()
      .describe(
        'Match if any nested object matches. Provide at least two clauses. IMAP OR is binary; longer lists are folded.',
      ),
    and: z
      .array(z.lazy(() => search))
      .optional()
      .describe(
        'Match if every nested object matches. Top-level fields are already ANDed; use this for grouped clauses.',
      ),
  })
  .describe(
    'Structured IMAP SEARCH. Fields are ANDed. Dates are calendar days in UTC. Use mail_search_messages rather than mail_list_messages when you have criteria. Gmail-only fields fail with CAPABILITY_UNSUPPORTED on other servers.',
  );

const sortKey = z
  .object({
    field: z
      .enum(['arrival', 'date', 'from', 'to', 'cc', 'subject', 'size'])
      .describe('arrival is the internal received date. date is the Date header.'),
    reverse: z
      .boolean()
      .optional()
      .describe(
        'true sorts descending. Default false (ascending). Newest-first is arrival + reverse.',
      ),
  })
  .describe('One IMAP SORT key. The first key is the most significant.');

const address = z
  .string()
  .min(3)
  .describe(
    'Mailbox address. Examples: "ada@example.com", "Ada Lovelace <ada@example.com>", "用户@例子.中国".',
  );

const addressList = z
  .array(address)
  .describe('One or more addresses. A single string may also contain a comma-separated list.');

const attachment = z
  .object({
    filename: z
      .string()
      .optional()
      .describe('File name shown to the recipient. Example: "notes.pdf".'),
    contentType: z
      .string()
      .optional()
      .describe(
        'MIME type. Example: "application/pdf". Default is guessed from the filename when path is set.',
      ),
    contentBase64: z
      .string()
      .optional()
      .describe(
        'Base64-encoded bytes. Use this or path, not both. Do not include the data: URL prefix.',
      ),
    path: z
      .string()
      .optional()
      .describe(
        'Absolute or process-relative filesystem path to read. The server reads the file locally.',
      ),
    cid: z
      .string()
      .optional()
      .describe(
        'Content-ID for an inline image, without angle brackets. Reference it from HTML as cid:value.',
      ),
    inline: z
      .boolean()
      .optional()
      .describe('true sets Content-Disposition: inline. Use with cid for images in HTML.'),
  })
  .describe('One attachment or inline part.');

const limit = z
  .number()
  .int()
  .positive()
  .max(10_000)
  .optional()
  .describe(
    'Page size. Default is limits.pageSize (25). The schema allows up to 10000; the server rejects values above the configured limits.maxPageSize (default 100).',
  );

const cursor = z
  .string()
  .optional()
  .describe(
    "Opaque cursor from the previous page's nextCursor. It stores the last returned UID, that message's position, the primary sort key, and the mailbox uidValidity. The next page continues after that UID in a freshly sorted result. If the UID was expunged, the page continues at the first message that sorts strictly after the stored key, so deleting an earlier message does not skip the next one. Messages that compare equal to that key may be repeated or skipped. When the cursor has no sort key, the stored position is used, and adding or removing earlier messages can skip or repeat one. A cursor whose uidValidity no longer matches fails with UIDVALIDITY_CHANGED. Pass the same sort as the call that issued the cursor. Omit to start at the first page.",
  );

const ok = z
  .boolean()
  .describe(
    'True when every requested item succeeded. Per-item failures are inside results when a tool returns them.',
  );

export const fields = {
  account,
  mailbox,
  uid,
  uids,
  uidValidity,
  search,
  sortKey,
  address,
  addressList,
  attachment,
  limit,
  cursor,
  ok,
};

/**
 * Strict tool output. Every returned key must be declared. Error results omit structuredContent
 * so they are not validated against this success shape.
 */
export function strictOutput(shape: z.ZodRawShape): z.ZodObject<z.ZodRawShape> {
  return z.object(shape).strict();
}

/** @deprecated Use strictOutput. Kept as a name alias so older call sites fail closed. */
export const looseOutput = strictOutput;
