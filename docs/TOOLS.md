# Tools

Generated from the tool definitions in `src/tools/catalog.ts`. Do not edit by hand.
Run `npm run docs:tools` after changing a tool and commit the result. `npm run docs:check` fails when this file is stale.

The server registers 41 tools. A tool that mutates mail or sends it is omitted only when every configured account forbids that class of operation. Calls are still checked against the selected account.

Results are JSON in `structuredContent` plus a text rendering. Errors use `isError: true` and text only, shaped as `CODE: message` with an optional `Hint:` line. There is no structured error object. Codes:

`AUTH_FAILED`, `TLS_FAILED`, `NOT_FOUND`, `UIDVALIDITY_CHANGED`, `CAPABILITY_UNSUPPORTED`, `PERMISSION_DENIED`, `SIZE_LIMIT`, `TIMEOUT`, `RATE_LIMITED`, `CONFIG_ERROR`, `PROTOCOL_ERROR`, `CONNECTION_FAILED`, `INVALID_ARGUMENT`.

## mail_list_accounts

List configured accounts

List every account this server can use, without secrets. Use it first when more than one account is configured, then pass the id as `account` on later calls. The default account is marked. Read-only metadata: provider, safety switches, whether SMTP is configured, and From identities. Does not open a network connection.

Annotations: readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=false.

### Arguments

- None.

### Examples

```json
{}
```

## mail_verify_connection

Verify IMAP and SMTP

Open the account and authenticate, then close. Use this instead of guessing when a later call fails with AUTH_FAILED, TLS_FAILED, or CONNECTION_FAILED. Set imap or smtp to false to check only one side. A failed login is reported inside the result (ok false plus a code) rather than as a transport crash, so you can show the hint to the user. SMTP is skipped when the account has no smtp block.

Annotations: readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `imap` (optional): Check IMAP. Default true.
- `smtp` (optional): Check SMTP. Default true when SMTP is configured.

### Examples

```json
{"account":"work","smtp":false}
```

## mail_get_capabilities

Get IMAP capabilities

Return the capability tokens advertised after login (RFC 3501 / RFC 9051). Use this before relying on MOVE, SORT, THREAD, IDLE, CONDSTORE, QUOTA, NAMESPACE, ID, SPECIAL-USE, UIDPLUS, or X-GM-EXT-1. Missing tokens mean the matching tool will use a documented fallback or return CAPABILITY_UNSUPPORTED. Example tokens: "IMAP4rev1", "IDLE", "MOVE".

Annotations: readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".

### Examples

```json
{}
```

## mail_get_namespaces

Get IMAP namespaces

Return personal, other-user, and shared namespaces from RFC 2342. When the server has no NAMESPACE capability, the prefix and hierarchy delimiter are inferred from LIST "" "". delimiter is null for a flat namespace. Use the prefix when creating folders outside the personal namespace.

Annotations: readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".

### Examples

```json
{}
```

## mail_get_quota

Get mailbox quota

Return RFC 2087 / RFC 9208 quota resources for the account, or for one mailbox when mailbox is set. STORAGE used and limit are octets (bytes): the wire value is kibibytes and is converted by multiplying by 1024. MESSAGE is a count. QUOTA or QUOTA=RES-* is enough. A limit of 0 can mean unlimited on some servers.

Annotations: readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox` (optional): Optional mailbox path. Omit for the root quota.

### Examples

```json
{"mailbox":"INBOX"}
```

## mail_get_server_id

Get server ID

Return the RFC 2971 ID fields the server sent (name, version, vendor, and anything else it offered). Fails with CAPABILITY_UNSUPPORTED when ID is absent. Useful for deciding provider-specific behaviour such as Gmail sent-mail handling.

Annotations: readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".

### Examples

```json
{}
```

## mail_list_mailboxes

List mailboxes

List mailboxes with SPECIAL-USE flags when the server sends them (\Inbox, \Sent, \Drafts, \Trash, \Junk, \Archive, \All, \Flagged) and whether each is subscribed. Prefer this over mail_get_mailbox_tree when you need a flat list with flags. Paths are Unicode. Set subscribedOnly to true for the LSUB / LIST (SUBSCRIBED) view. Does not create folders.

Annotations: readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `subscribedOnly` (optional): When true, only subscribed mailboxes. Default false (all listed).

### Examples

```json
{"subscribedOnly":true}
```

## mail_get_mailbox_tree

Mailbox tree

Return the mailbox hierarchy as a tree. Each node has path, name, delimiter, flags, specialUse, and folders (children). Use mail_list_mailboxes when you only need a flat list. The root node may have an empty path and only a folders array.

Annotations: readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".

### Examples

```json
{}
```

## mail_get_mailbox_status

Mailbox status

STATUS for one mailbox: messages, unseen, recent, uidNext, uidValidity, highestModseq when CONDSTORE is available, and size when STATUS=SIZE or IMAP4rev2 is available. uidValidity is a decimal string. Call this before a long sequence of UID updates and pass the value back as uidValidity. Counts are numbers of messages, size is octets.

Annotations: readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox`: Mailbox path as returned by mail_list_mailboxes, in Unicode (not modified UTF-7). Nested folders use the server delimiter, often "/" or ".". Examples: "INBOX", "Projects/2026", "Entwürfe".

### Examples

```json
{"mailbox":"INBOX"}
```

## mail_create_mailbox

Create mailbox

Create a mailbox, including parents the server creates implicitly (CREATE of "a/b" often creates "a"). Idempotent on servers that answer "already exists" as success; otherwise a second call returns a protocol error. Blocked when the account is readOnly. Name is Unicode.

Annotations: readOnlyHint=false, destructiveHint=false, idempotentHint=false, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox`: Mailbox path as returned by mail_list_mailboxes, in Unicode (not modified UTF-7). Nested folders use the server delimiter, often "/" or ".". Examples: "INBOX", "Projects/2026", "Entwürfe".

### Examples

```json
{"mailbox":"Projects/2026"}
```

## mail_rename_mailbox

Rename mailbox

Rename a mailbox (RFC 3501 RENAME). Inferior mailboxes usually move with it when the server supports that. INBOX cannot be renamed on many servers; messages are moved instead. Blocked when readOnly. newName is a full path, not just the last segment.

Annotations: readOnlyHint=false, destructiveHint=false, idempotentHint=false, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox`: Existing mailbox path.
- `newName`: New full mailbox path. Example: "Archive/2025".

### Examples

```json
{"mailbox":"Temp","newName":"Archive/Temp"}
```

## mail_delete_mailbox

Delete mailbox

Delete a mailbox and, on most servers, its messages. This is destructive and requires allowDelete. It does not merely unsubscribe. Refusing to delete INBOX is normal. There is no trash for the folder itself.

Annotations: readOnlyHint=false, destructiveHint=true, idempotentHint=false, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox`: Mailbox path as returned by mail_list_mailboxes, in Unicode (not modified UTF-7). Nested folders use the server delimiter, often "/" or ".". Examples: "INBOX", "Projects/2026", "Entwürfe".

### Examples

```json
{"mailbox":"Temp"}
```

## mail_subscribe_mailbox

Subscribe mailbox

SUBSCRIBE a mailbox so it shows up for clients that only list subscriptions. The mailbox must already exist. Blocked when readOnly. Use mail_unsubscribe_mailbox to reverse it.

Annotations: readOnlyHint=false, destructiveHint=false, idempotentHint=true, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox`: Mailbox path as returned by mail_list_mailboxes, in Unicode (not modified UTF-7). Nested folders use the server delimiter, often "/" or ".". Examples: "INBOX", "Projects/2026", "Entwürfe".

### Examples

```json
{"mailbox":"Projects"}
```

## mail_unsubscribe_mailbox

Unsubscribe mailbox

UNSUBSCRIBE a mailbox. The folder and its messages stay. Blocked when readOnly. Listing with subscribedOnly will hide it afterwards.

Annotations: readOnlyHint=false, destructiveHint=false, idempotentHint=true, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox`: Mailbox path as returned by mail_list_mailboxes, in Unicode (not modified UTF-7). Nested folders use the server delimiter, often "/" or ".". Examples: "INBOX", "Projects/2026", "Entwürfe".

### Examples

```json
{"mailbox":"Projects"}
```

## mail_list_subscribed

List subscribed mailboxes

Shortcut for mail_list_mailboxes with subscribedOnly true. Same result shape. Use it when a client only cares about the subscription list.

Annotations: readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".

### Examples

```json
{}
```

## mail_resolve_special_use

Resolve special-use mailboxes

Resolve Inbox, Sent, Drafts, Trash, Junk, Archive, All, and Flagged. Order: account config overrides, SPECIAL-USE flags from the server, then provider name hints (Gmail "[Gmail]/Sent Mail", Outlook "Sent Items", and so on). sources says how each path was chosen: config, extension, or name. Send and delete tools use this automatically. Call it when you need the path yourself.

Annotations: readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".

### Examples

```json
{}
```

## mail_list_messages

List message summaries

Page message summaries in a mailbox. Default mailbox is INBOX. Default sort is arrival descending (newest first) via the SORT extension, with a client-side fallback that refuses mailboxes larger than limits.maxSortCandidates when the server cannot sort. Each summary has uid, flags, size (octets), date, from, to, subject, hasAttachments, and a snippet of about snippetChars characters (default 160). Pass nextCursor back as cursor. Never returns an unbounded mailbox. For criteria use mail_search_messages; a search object is also accepted here. Optional uidValidity detects a recreated mailbox.

Annotations: readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox` (optional): Mailbox path. Default INBOX.
- `search` (optional): Structured IMAP SEARCH. Fields are ANDed. Dates are calendar days in UTC. Use mail_search_messages rather than mail_list_messages when you have criteria. Gmail-only fields fail with CAPABILITY_UNSUPPORTED on other servers.
  - `all` (optional): Match every message. Usually omit this and set a real criterion.
  - `from` (optional): Substring match on the From header. Example: "ada@example.com".
  - `to` (optional): Substring match on To.
  - `cc` (optional): Substring match on Cc.
  - `bcc` (optional): Substring match on Bcc. Many servers do not store Bcc.
  - `subject` (optional): Substring match on Subject.
  - `body` (optional): Substring match on the body, not headers.
  - `text` (optional): Substring match on headers and body.
  - `header` (optional): Match one header field.
    - `name`: Header field name, for example "List-Id" or "Message-ID".
    - `value` (optional): Substring the header must contain. Omit to test only that the header is present.
  - `since` (optional): Internal date on or after this day. YYYY-MM-DD or ISO timestamp. Time of day is ignored.
  - `before` (optional): Internal date before this day (exclusive of the day in IMAP). YYYY-MM-DD.
  - `on` (optional): Internal date on this calendar day. YYYY-MM-DD.
  - `sentSince` (optional): Date header on or after this day. YYYY-MM-DD.
  - `sentBefore` (optional): Date header before this day. YYYY-MM-DD.
  - `sentOn` (optional): Date header on this day. YYYY-MM-DD.
  - `larger` (optional): Message size strictly greater than this many octets.
  - `smaller` (optional): Message size strictly less than this many octets.
  - `seen` (optional): true requires \Seen, false requires the flag to be absent.
  - `answered` (optional): true requires \Answered, false requires it absent.
  - `flagged` (optional): true requires \Flagged, false requires it absent.
  - `deleted` (optional): true requires \Deleted, false requires it absent.
  - `draft` (optional): true requires \Draft, false requires it absent.
  - `recent` (optional): true requires \Recent. Recent is session-specific and often useless after the first look.
  - `keyword` (optional): Custom keyword that must be set, without a leading backslash. Example: "$Forwarded".
  - `unkeyword` (optional): Custom keyword that must be absent.
  - `uid` (optional): UID set. Examples: "10", "10:20", "1,5,9:*".
  - `seq` (optional): Sequence-number set, not UIDs. Prefer uid. Example: "1:10".
  - `modseq` (optional): Decimal MODSEQ. Requires CONDSTORE. Matches messages changed after this value.
  - `emailId` (optional): OBJECTID EMAILID or Gmail X-GM-MSGID. Requires OBJECTID or X-GM-EXT-1.
  - `threadId` (optional): OBJECTID THREADID or Gmail X-GM-THRID.
  - `gmraw` (optional): Gmail X-GM-RAW query, the same language as the Gmail search box. Example: "has:attachment newer_than:7d".
  - `labels` (optional): Gmail label filter. Requires X-GM-EXT-1.
    - `has` (optional): Gmail labels the message must have.
    - `not` (optional): Gmail labels the message must not have.
  - `not` (optional): Negate a nested search object.
  - `or` (optional): Match if any nested object matches. Provide at least two clauses. IMAP OR is binary; longer lists are folded.
  - `and` (optional): Match if every nested object matches. Top-level fields are already ANDed; use this for grouped clauses.
- `sort` (optional): Sort keys, most significant first. Default: arrival descending.
  - `field`: arrival is the internal received date. date is the Date header.
  - `reverse` (optional): true sorts descending. Default false (ascending). Newest-first is arrival + reverse.
- `limit` (optional): Page size. Default is limits.pageSize (25). The schema allows up to 10000; the server rejects values above the configured limits.maxPageSize (default 100).
- `cursor` (optional): Opaque cursor from the previous page's nextCursor. A cursor resumes after the UID it names. If that UID is no longer in the result, the call fails with INVALID_ARGUMENT; repeat the request without a cursor. Cursors are tied to uidValidity. Omit to start at the first page.
- `uidValidity` (optional): Expected UIDVALIDITY decimal string from mail_get_mailbox_status or a previous list. When set, the call fails with UIDVALIDITY_CHANGED if the mailbox was recreated.
- `includeSnippet` (optional): Include a text snippet. Default true. Set false for a faster list.
- `snippetChars` (optional): Maximum snippet length. Default 160.

### Examples

```json
{"mailbox":"INBOX","limit":10}
```

## mail_search_messages

Search messages

Search with the full structured IMAP SEARCH grammar (from, to, cc, bcc, subject, body, text, header, internal and sent dates, larger/smaller, flags and keywords, UID and sequence sets, NOT/OR/AND, MODSEQ, and Gmail X-GM-RAW / thread id / labels when the server supports them). Same paging and summaries as mail_list_messages. Use this tool, not mail_list_messages, when the user describes what to find. An empty search object is rejected. ESEARCH is used internally when ImapFlow can; the result you see is always a paged list plus total.

Annotations: readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox` (optional): Mailbox path as returned by mail_list_mailboxes, in Unicode (not modified UTF-7). Nested folders use the server delimiter, often "/" or ".". Examples: "INBOX", "Projects/2026", "Entwürfe".
- `search`: Structured IMAP SEARCH. Fields are ANDed. Dates are calendar days in UTC. Use mail_search_messages rather than mail_list_messages when you have criteria. Gmail-only fields fail with CAPABILITY_UNSUPPORTED on other servers.
  - `all` (optional): Match every message. Usually omit this and set a real criterion.
  - `from` (optional): Substring match on the From header. Example: "ada@example.com".
  - `to` (optional): Substring match on To.
  - `cc` (optional): Substring match on Cc.
  - `bcc` (optional): Substring match on Bcc. Many servers do not store Bcc.
  - `subject` (optional): Substring match on Subject.
  - `body` (optional): Substring match on the body, not headers.
  - `text` (optional): Substring match on headers and body.
  - `header` (optional): Match one header field.
    - `name`: Header field name, for example "List-Id" or "Message-ID".
    - `value` (optional): Substring the header must contain. Omit to test only that the header is present.
  - `since` (optional): Internal date on or after this day. YYYY-MM-DD or ISO timestamp. Time of day is ignored.
  - `before` (optional): Internal date before this day (exclusive of the day in IMAP). YYYY-MM-DD.
  - `on` (optional): Internal date on this calendar day. YYYY-MM-DD.
  - `sentSince` (optional): Date header on or after this day. YYYY-MM-DD.
  - `sentBefore` (optional): Date header before this day. YYYY-MM-DD.
  - `sentOn` (optional): Date header on this day. YYYY-MM-DD.
  - `larger` (optional): Message size strictly greater than this many octets.
  - `smaller` (optional): Message size strictly less than this many octets.
  - `seen` (optional): true requires \Seen, false requires the flag to be absent.
  - `answered` (optional): true requires \Answered, false requires it absent.
  - `flagged` (optional): true requires \Flagged, false requires it absent.
  - `deleted` (optional): true requires \Deleted, false requires it absent.
  - `draft` (optional): true requires \Draft, false requires it absent.
  - `recent` (optional): true requires \Recent. Recent is session-specific and often useless after the first look.
  - `keyword` (optional): Custom keyword that must be set, without a leading backslash. Example: "$Forwarded".
  - `unkeyword` (optional): Custom keyword that must be absent.
  - `uid` (optional): UID set. Examples: "10", "10:20", "1,5,9:*".
  - `seq` (optional): Sequence-number set, not UIDs. Prefer uid. Example: "1:10".
  - `modseq` (optional): Decimal MODSEQ. Requires CONDSTORE. Matches messages changed after this value.
  - `emailId` (optional): OBJECTID EMAILID or Gmail X-GM-MSGID. Requires OBJECTID or X-GM-EXT-1.
  - `threadId` (optional): OBJECTID THREADID or Gmail X-GM-THRID.
  - `gmraw` (optional): Gmail X-GM-RAW query, the same language as the Gmail search box. Example: "has:attachment newer_than:7d".
  - `labels` (optional): Gmail label filter. Requires X-GM-EXT-1.
    - `has` (optional): Gmail labels the message must have.
    - `not` (optional): Gmail labels the message must not have.
  - `not` (optional): Negate a nested search object.
  - `or` (optional): Match if any nested object matches. Provide at least two clauses. IMAP OR is binary; longer lists are folded.
  - `and` (optional): Match if every nested object matches. Top-level fields are already ANDed; use this for grouped clauses.
- `sort` (optional): 
  - `field`: arrival is the internal received date. date is the Date header.
  - `reverse` (optional): true sorts descending. Default false (ascending). Newest-first is arrival + reverse.
- `limit` (optional): Page size. Default is limits.pageSize (25). The schema allows up to 10000; the server rejects values above the configured limits.maxPageSize (default 100).
- `cursor` (optional): Opaque cursor from the previous page's nextCursor. A cursor resumes after the UID it names. If that UID is no longer in the result, the call fails with INVALID_ARGUMENT; repeat the request without a cursor. Cursors are tied to uidValidity. Omit to start at the first page.
- `uidValidity` (optional): Expected UIDVALIDITY decimal string from mail_get_mailbox_status or a previous list. When set, the call fails with UIDVALIDITY_CHANGED if the mailbox was recreated.
- `includeSnippet` (optional): Include a text snippet. Default true. Set false for a faster search.
- `snippetChars` (optional): Maximum snippet length in characters. Default 160.

### Examples

```json
{"mailbox":"INBOX","search":{"seen":false,"from":"ada@example.com"},"limit":20}
```

## mail_get_message

Get one message

Fetch one message by mailbox and UID and return parsed headers, text, HTML, an HTML-to-text rendering, and an attachment list (part metadata only, no bytes). Bodies are capped at maxBodyChars (default limits.maxBodyChars, 100000) and textTruncated/htmlTruncated say when that happened. Messages larger than maxMessageBytes fail with SIZE_LIMIT unless you pass parts to fetch specific MIME section ids such as "1" or "2.1" without downloading the whole RFC822. Use mail_download_attachment for bytes. Use mail_get_raw_message for the unparsed source.

Annotations: readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox`: Mailbox path as returned by mail_list_mailboxes, in Unicode (not modified UTF-7). Nested folders use the server delimiter, often "/" or ".". Examples: "INBOX", "Projects/2026", "Entwürfe".
- `uid`: IMAP UID of one message. UIDs are only meaningful together with the mailbox uidValidity.
- `uidValidity` (optional): Expected UIDVALIDITY decimal string from mail_get_mailbox_status or a previous list. When set, the call fails with UIDVALIDITY_CHANGED if the mailbox was recreated.
- `maxBodyChars` (optional): Cap for text and HTML, in characters. Default limits.maxBodyChars.
- `parts` (optional): MIME section ids to fetch instead of the whole message. Example: ["1","2"].

### Examples

```json
{"mailbox":"INBOX","uid":41}
```

## mail_get_raw_message

Get raw RFC822

Return the raw RFC822 source of one message as base64. Use this for forensic or re-import work. Refuses messages over maxMessageBytes (or maxBytes when set) with SIZE_LIMIT. Prefer mail_get_message for reading. The base64 alphabet is standard, no line wraps.

Annotations: readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox`: Mailbox path as returned by mail_list_mailboxes, in Unicode (not modified UTF-7). Nested folders use the server delimiter, often "/" or ".". Examples: "INBOX", "Projects/2026", "Entwürfe".
- `uid`: IMAP UID of one message. UIDs are only meaningful together with the mailbox uidValidity.
- `uidValidity` (optional): Expected UIDVALIDITY decimal string from mail_get_mailbox_status or a previous list. When set, the call fails with UIDVALIDITY_CHANGED if the mailbox was recreated.
- `maxBytes` (optional): Override the size cap, in octets.

### Examples

```json
{"mailbox":"INBOX","uid":41}
```

## mail_get_headers

Get message headers

Return the raw header block of one message (HEADER), not the body. Useful for List-Id, Authentication-Results, or References without downloading attachments. Truncated when longer than maxBodyChars; truncated is then true. Header names are not decoded beyond what the server sent; encoded words remain in the raw text.

Annotations: readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox`: Mailbox path as returned by mail_list_mailboxes, in Unicode (not modified UTF-7). Nested folders use the server delimiter, often "/" or ".". Examples: "INBOX", "Projects/2026", "Entwürfe".
- `uid`: IMAP UID of one message. UIDs are only meaningful together with the mailbox uidValidity.
- `uidValidity` (optional): Expected UIDVALIDITY decimal string from mail_get_mailbox_status or a previous list. When set, the call fails with UIDVALIDITY_CHANGED if the mailbox was recreated.

### Examples

```json
{"mailbox":"INBOX","uid":41}
```

## mail_get_message_part

Get one MIME part

Fetch a single MIME section by part id (BODY[section]) without the rest of the message. Text parts return text. Other parts return contentBase64, capped by maxBytes (default maxAttachmentBytes). truncated is true when the cap was hit. Part ids come from mail_get_message. Example part ids: "1", "1.2", "2".

Annotations: readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox`: Mailbox path as returned by mail_list_mailboxes, in Unicode (not modified UTF-7). Nested folders use the server delimiter, often "/" or ".". Examples: "INBOX", "Projects/2026", "Entwürfe".
- `uid`: IMAP UID of one message. UIDs are only meaningful together with the mailbox uidValidity.
- `uidValidity` (optional): Expected UIDVALIDITY decimal string from mail_get_mailbox_status or a previous list. When set, the call fails with UIDVALIDITY_CHANGED if the mailbox was recreated.
- `partId`: MIME section id, for example "2" or "1.1".
- `maxBytes` (optional): Maximum octets to return. Default limits.maxAttachmentBytes.

### Examples

```json
{"mailbox":"INBOX","uid":41,"partId":"2"}
```

## mail_download_attachment

Download an attachment

Download one attachment chosen by filename, Content-ID (cid), or partIndex (0-based index in the attachment list from mail_get_message, not every MIME leaf). Without savePath the bytes are base64 and must be under maxAttachmentBytes or the call fails with SIZE_LIMIT. With savePath the file is written on the machine running this server and the result contains savedPath and no base64. savePath is rejected unless attachmentsDir is configured, and the resolved path must stay inside that directory.

Annotations: readOnlyHint=false, destructiveHint=true, idempotentHint=false, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox`: Mailbox path as returned by mail_list_mailboxes, in Unicode (not modified UTF-7). Nested folders use the server delimiter, often "/" or ".". Examples: "INBOX", "Projects/2026", "Entwürfe".
- `uid`: IMAP UID of one message. UIDs are only meaningful together with the mailbox uidValidity.
- `uidValidity` (optional): Expected UIDVALIDITY decimal string from mail_get_mailbox_status or a previous list. When set, the call fails with UIDVALIDITY_CHANGED if the mailbox was recreated.
- `filename` (optional): Exact filename match.
- `cid` (optional): Content-ID, with or without angle brackets as stored.
- `partIndex` (optional): Index in the attachment array from mail_get_message.
- `savePath` (optional): File path to write. Requires attachmentsDir. The resolved path must stay inside that directory. Parent directories are created.

### Examples

```json
{"mailbox":"INBOX","uid":41,"filename":"notes.pdf","savePath":"/tmp/notes.pdf"}
```

## mail_list_threads

List threads

Group messages into threads. Uses the THREAD extension (REFERENCES by default, or ORDEREDSUBJECT) when the server advertises it and the search is "all"; otherwise threads are built from References and In-Reply-To, with a subject fallback for ORDEREDSUBJECT. The result is a tree plus a paged flat UID list (parent before children). Gmail thread ids, when present on summaries, are a separate field from this tree. Large mailboxes are capped at maxSortCandidates for the client-side path.

Annotations: readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox` (optional): Mailbox path as returned by mail_list_mailboxes, in Unicode (not modified UTF-7). Nested folders use the server delimiter, often "/" or ".". Examples: "INBOX", "Projects/2026", "Entwürfe".
- `search` (optional): Structured IMAP SEARCH. Fields are ANDed. Dates are calendar days in UTC. Use mail_search_messages rather than mail_list_messages when you have criteria. Gmail-only fields fail with CAPABILITY_UNSUPPORTED on other servers.
  - `all` (optional): Match every message. Usually omit this and set a real criterion.
  - `from` (optional): Substring match on the From header. Example: "ada@example.com".
  - `to` (optional): Substring match on To.
  - `cc` (optional): Substring match on Cc.
  - `bcc` (optional): Substring match on Bcc. Many servers do not store Bcc.
  - `subject` (optional): Substring match on Subject.
  - `body` (optional): Substring match on the body, not headers.
  - `text` (optional): Substring match on headers and body.
  - `header` (optional): Match one header field.
    - `name`: Header field name, for example "List-Id" or "Message-ID".
    - `value` (optional): Substring the header must contain. Omit to test only that the header is present.
  - `since` (optional): Internal date on or after this day. YYYY-MM-DD or ISO timestamp. Time of day is ignored.
  - `before` (optional): Internal date before this day (exclusive of the day in IMAP). YYYY-MM-DD.
  - `on` (optional): Internal date on this calendar day. YYYY-MM-DD.
  - `sentSince` (optional): Date header on or after this day. YYYY-MM-DD.
  - `sentBefore` (optional): Date header before this day. YYYY-MM-DD.
  - `sentOn` (optional): Date header on this day. YYYY-MM-DD.
  - `larger` (optional): Message size strictly greater than this many octets.
  - `smaller` (optional): Message size strictly less than this many octets.
  - `seen` (optional): true requires \Seen, false requires the flag to be absent.
  - `answered` (optional): true requires \Answered, false requires it absent.
  - `flagged` (optional): true requires \Flagged, false requires it absent.
  - `deleted` (optional): true requires \Deleted, false requires it absent.
  - `draft` (optional): true requires \Draft, false requires it absent.
  - `recent` (optional): true requires \Recent. Recent is session-specific and often useless after the first look.
  - `keyword` (optional): Custom keyword that must be set, without a leading backslash. Example: "$Forwarded".
  - `unkeyword` (optional): Custom keyword that must be absent.
  - `uid` (optional): UID set. Examples: "10", "10:20", "1,5,9:*".
  - `seq` (optional): Sequence-number set, not UIDs. Prefer uid. Example: "1:10".
  - `modseq` (optional): Decimal MODSEQ. Requires CONDSTORE. Matches messages changed after this value.
  - `emailId` (optional): OBJECTID EMAILID or Gmail X-GM-MSGID. Requires OBJECTID or X-GM-EXT-1.
  - `threadId` (optional): OBJECTID THREADID or Gmail X-GM-THRID.
  - `gmraw` (optional): Gmail X-GM-RAW query, the same language as the Gmail search box. Example: "has:attachment newer_than:7d".
  - `labels` (optional): Gmail label filter. Requires X-GM-EXT-1.
    - `has` (optional): Gmail labels the message must have.
    - `not` (optional): Gmail labels the message must not have.
  - `not` (optional): Negate a nested search object.
  - `or` (optional): Match if any nested object matches. Provide at least two clauses. IMAP OR is binary; longer lists are folded.
  - `and` (optional): Match if every nested object matches. Top-level fields are already ANDed; use this for grouped clauses.
- `algorithm` (optional): Default REFERENCES.
- `limit` (optional): Page size. Default is limits.pageSize (25). The schema allows up to 10000; the server rejects values above the configured limits.maxPageSize (default 100).
- `cursor` (optional): Opaque cursor from the previous page's nextCursor. A cursor resumes after the UID it names. If that UID is no longer in the result, the call fails with INVALID_ARGUMENT; repeat the request without a cursor. Cursors are tied to uidValidity. Omit to start at the first page.
- `uidValidity` (optional): Expected UIDVALIDITY decimal string from mail_get_mailbox_status or a previous list. When set, the call fails with UIDVALIDITY_CHANGED if the mailbox was recreated.

### Examples

```json
{"mailbox":"INBOX","algorithm":"REFERENCES","limit":20}
```

## mail_set_flags

Add, remove, or replace flags

Change flags or keywords on one or more UIDs. operation add is +FLAGS, remove is -FLAGS, set replaces the whole flag set (FLAGS). Adding or removing \Deleted, and a set that would clear \Deleted, require allowDelete. System flags may be written "\\Seen" or "seen". Custom keywords must not contain spaces. unchangedSince is the CONDSTORE UNCHANGEDSINCE mod-sequence; omit it when the server has no CONDSTORE. Blocked when the account is readOnly. Does not expunge. ok is false when any UID failed; uids lists only the UIDs that changed.

Annotations: readOnlyHint=false, destructiveHint=false, idempotentHint=true, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox`: Mailbox path as returned by mail_list_mailboxes, in Unicode (not modified UTF-7). Nested folders use the server delimiter, often "/" or ".". Examples: "INBOX", "Projects/2026", "Entwürfe".
- `uidValidity` (optional): Expected UIDVALIDITY decimal string from mail_get_mailbox_status or a previous list. When set, the call fails with UIDVALIDITY_CHANGED if the mailbox was recreated.
- `uids`: IMAP UIDs to change. The server limit is limits.maxBulk (default 200). Each UID is applied separately so a failure does not hide the others when the tool returns per-item results.
- `flags`: Flags or keywords. Examples: ["\\Seen"], ["\\Flagged","$Forwarded"].
- `operation`: add, remove, or replace.
- `unchangedSince` (optional): CONDSTORE mod-sequence. The update is skipped by the server when the message changed since this value.

### Examples

```json
{"mailbox":"INBOX","uids":[41],"flags":["\\Seen"],"operation":"add"}
```

## mail_copy_messages

Copy messages

COPY UIDs to another mailbox, leaving the originals. Requires the destination to exist. Returns per-UID results and, when UIDPLUS is available, the new UID. Blocked when readOnly. Prefer mail_move_messages when the original should disappear.

Annotations: readOnlyHint=false, destructiveHint=false, idempotentHint=false, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox`: Mailbox path as returned by mail_list_mailboxes, in Unicode (not modified UTF-7). Nested folders use the server delimiter, often "/" or ".". Examples: "INBOX", "Projects/2026", "Entwürfe".
- `uidValidity` (optional): Expected UIDVALIDITY decimal string from mail_get_mailbox_status or a previous list. When set, the call fails with UIDVALIDITY_CHANGED if the mailbox was recreated.
- `uids`: IMAP UIDs to change. The server limit is limits.maxBulk (default 200). Each UID is applied separately so a failure does not hide the others when the tool returns per-item results.
- `destination`: Destination mailbox path. It must already exist.

### Examples

```json
{"mailbox":"INBOX","uids":[41,42],"destination":"Archive"}
```

## mail_move_messages

Move messages

Move UIDs to another mailbox. Uses MOVE when the server advertises it. Otherwise copies, sets \Deleted, and UID EXPUNGEs, which requires UIDPLUS. Without MOVE and UIDPLUS the call is refused, because a plain EXPUNGE would remove every \Deleted message. allowPermanentDelete does not permit that. Requires allowDelete. Destination must exist.

Annotations: readOnlyHint=false, destructiveHint=true, idempotentHint=false, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox`: Mailbox path as returned by mail_list_mailboxes, in Unicode (not modified UTF-7). Nested folders use the server delimiter, often "/" or ".". Examples: "INBOX", "Projects/2026", "Entwürfe".
- `uidValidity` (optional): Expected UIDVALIDITY decimal string from mail_get_mailbox_status or a previous list. When set, the call fails with UIDVALIDITY_CHANGED if the mailbox was recreated.
- `uids`: IMAP UIDs to change. The server limit is limits.maxBulk (default 200). Each UID is applied separately so a failure does not hide the others when the tool returns per-item results.
- `destination`: Destination mailbox path.

### Examples

```json
{"mailbox":"INBOX","uids":[41],"destination":"Archive"}
```

## mail_delete_messages

Delete messages

Delete UIDs. By default they are moved to the resolved Trash mailbox (special-use, config, or a well-known name). permanent true UID EXPUNGEs only those UIDs and requires both allowPermanentDelete and UIDPLUS. Without UIDPLUS the call is refused rather than expunging every \Deleted message. Deleting messages that are already in Trash requires permanent true. Requires allowDelete. Adding \Deleted via mail_set_flags is the same delete permission. Use mail_expunge_mailbox only when you intend to purge every \Deleted message in a mailbox.

Annotations: readOnlyHint=false, destructiveHint=true, idempotentHint=false, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox`: Mailbox path as returned by mail_list_mailboxes, in Unicode (not modified UTF-7). Nested folders use the server delimiter, often "/" or ".". Examples: "INBOX", "Projects/2026", "Entwürfe".
- `uidValidity` (optional): Expected UIDVALIDITY decimal string from mail_get_mailbox_status or a previous list. When set, the call fails with UIDVALIDITY_CHANGED if the mailbox was recreated.
- `uids`: IMAP UIDs to change. The server limit is limits.maxBulk (default 200). Each UID is applied separately so a failure does not hide the others when the tool returns per-item results.
- `permanent` (optional): true expunges immediately. Default false moves to Trash. Requires allowPermanentDelete and UIDPLUS.

### Examples

```json
{"mailbox":"INBOX","uids":[41]}
```

```json
{"mailbox":"Trash","uids":[41],"permanent":true}
```

## mail_expunge_mailbox

Expunge mailbox

EXPUNGE the selected mailbox: permanently remove every message that already has \Deleted. This does not set the flag itself. Requires allowPermanentDelete. Destructive and not limited to one UID. To remove specific UIDs use mail_delete_messages with permanent true, which uses UID EXPUNGE when UIDPLUS is available.

Annotations: readOnlyHint=false, destructiveHint=true, idempotentHint=true, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox`: Mailbox path as returned by mail_list_mailboxes, in Unicode (not modified UTF-7). Nested folders use the server delimiter, often "/" or ".". Examples: "INBOX", "Projects/2026", "Entwürfe".

### Examples

```json
{"mailbox":"INBOX"}
```

## mail_append_message

Append a message

APPEND a message to a mailbox. Provide either rawBase64 (a full RFC822 message) or the same compose fields as mail_send_message (from, to, subject, text, html, attachments). flags default to none; pass ["\\Draft"] to store a draft, or use mail_create_draft. date is the internal date as an ISO timestamp. Blocked when readOnly. The result includes the new UID when the server supports UIDPLUS.

Annotations: readOnlyHint=false, destructiveHint=false, idempotentHint=false, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox`: Mailbox path as returned by mail_list_mailboxes, in Unicode (not modified UTF-7). Nested folders use the server delimiter, often "/" or ".". Examples: "INBOX", "Projects/2026", "Entwürfe".
- `rawBase64` (optional): Full RFC822 message, base64. When set, compose fields are ignored.
- `from` (optional): Mailbox address. Examples: "ada@example.com", "Ada Lovelace <ada@example.com>", "用户@例子.中国".
- `to` (optional): One or more addresses. A single string may also contain a comma-separated list.
- `cc` (optional): One or more addresses. A single string may also contain a comma-separated list.
- `bcc` (optional): One or more addresses. A single string may also contain a comma-separated list.
- `subject` (optional): Subject. Encoded words are applied as needed.
- `text` (optional): Plain text body.
- `html` (optional): HTML body. With text, the message is multipart/alternative.
- `attachments` (optional): 
  - `filename` (optional): File name shown to the recipient. Example: "notes.pdf".
  - `contentType` (optional): MIME type. Example: "application/pdf". Default is guessed from the filename when path is set.
  - `contentBase64` (optional): Base64-encoded bytes. Use this or path, not both. Do not include the data: URL prefix.
  - `path` (optional): Absolute or process-relative filesystem path to read. The server reads the file locally.
  - `cid` (optional): Content-ID for an inline image, without angle brackets. Reference it from HTML as cid:value.
  - `inline` (optional): true sets Content-Disposition: inline. Use with cid for images in HTML.
- `flags` (optional): Flags to store. Example: ["\\Seen"].
- `date` (optional): Internal date, ISO 8601. Default is now.
- `allowEmptyRecipients` (optional): Allow append with no To, for drafts. Default false.

### Examples

```json
{"mailbox":"INBOX","to":["ada@example.com"],"subject":"Note","text":"Hello","allowEmptyRecipients":false}
```

## mail_set_labels

Set Gmail labels

Add, remove, or replace Gmail labels on UIDs. Requires X-GM-EXT-1; other servers return CAPABILITY_UNSUPPORTED. Labels are names such as "Work" or "\\Inbox", not IMAP keywords. operation set replaces the label set. This is not mail_set_flags. ok is false when any UID failed. uids lists only the UIDs that changed. results has one row per requested UID.

Annotations: readOnlyHint=false, destructiveHint=false, idempotentHint=true, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox`: Mailbox path as returned by mail_list_mailboxes, in Unicode (not modified UTF-7). Nested folders use the server delimiter, often "/" or ".". Examples: "INBOX", "Projects/2026", "Entwürfe".
- `uidValidity` (optional): Expected UIDVALIDITY decimal string from mail_get_mailbox_status or a previous list. When set, the call fails with UIDVALIDITY_CHANGED if the mailbox was recreated.
- `uids`: IMAP UIDs to change. The server limit is limits.maxBulk (default 200). Each UID is applied separately so a failure does not hide the others when the tool returns per-item results.
- `labels`: Gmail label names.
- `operation`: add labels, remove labels, or replace the whole label set.

### Examples

```json
{"mailbox":"INBOX","uids":[41],"labels":["Work"],"operation":"add"}
```

## mail_bulk_modify

Bulk modify messages

Apply one action to many UIDs and return a per-UID result. Actions: addFlags, removeFlags, setFlags, copy, move, delete, addLabels, removeLabels. delete uses the Trash move unless permanent is true. copy and move need destination. Flag actions need flags. Label actions need labels and Gmail. The call itself succeeds when the batch was attempted; inspect results[].ok. UIDs above maxBulk are rejected up front.

Annotations: readOnlyHint=false, destructiveHint=true, idempotentHint=false, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox`: Mailbox path as returned by mail_list_mailboxes, in Unicode (not modified UTF-7). Nested folders use the server delimiter, often "/" or ".". Examples: "INBOX", "Projects/2026", "Entwürfe".
- `uidValidity` (optional): Expected UIDVALIDITY decimal string from mail_get_mailbox_status or a previous list. When set, the call fails with UIDVALIDITY_CHANGED if the mailbox was recreated.
- `uids`: IMAP UIDs to change. The server limit is limits.maxBulk (default 200). Each UID is applied separately so a failure does not hide the others when the tool returns per-item results.
- `action`: The single operation applied to every UID.
- `flags` (optional): Flags for addFlags, removeFlags, and setFlags. Example: ["\\Seen"].
- `labels` (optional): Gmail labels for addLabels and removeLabels.
- `destination` (optional): Required for copy and move.
- `permanent` (optional): For delete only. Default false.

### Examples

```json
{"mailbox":"INBOX","uids":[41,42],"action":"addFlags","flags":["\\Seen"]}
```

## mail_create_draft

Create a draft

Build a message and APPEND it to the Drafts mailbox with \Draft. The Drafts path is resolved automatically unless mailbox is set. Recipients may be empty. Does not send. Use mail_update_draft to replace one and mail_send_draft to submit it. Blocked when readOnly.

Annotations: readOnlyHint=false, destructiveHint=false, idempotentHint=false, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox` (optional): Override the resolved Drafts mailbox.
- `from` (optional): Must be one of the account identities. Default identity is used when omitted.
- `to` (optional): One or more addresses. A single string may also contain a comma-separated list.
- `cc` (optional): One or more addresses. A single string may also contain a comma-separated list.
- `bcc` (optional): One or more addresses. A single string may also contain a comma-separated list.
- `replyTo` (optional): One or more addresses. A single string may also contain a comma-separated list.
- `subject` (optional): Draft subject.
- `text` (optional): Plain text body.
- `html` (optional): HTML body.
- `attachments` (optional): 
  - `filename` (optional): File name shown to the recipient. Example: "notes.pdf".
  - `contentType` (optional): MIME type. Example: "application/pdf". Default is guessed from the filename when path is set.
  - `contentBase64` (optional): Base64-encoded bytes. Use this or path, not both. Do not include the data: URL prefix.
  - `path` (optional): Absolute or process-relative filesystem path to read. The server reads the file locally.
  - `cid` (optional): Content-ID for an inline image, without angle brackets. Reference it from HTML as cid:value.
  - `inline` (optional): true sets Content-Disposition: inline. Use with cid for images in HTML.
- `headers` (optional): Extra headers. Do not set Bcc here; use bcc.

### Examples

```json
{"to":["ada@example.com"],"subject":"Draft","text":"Still writing"}
```

## mail_update_draft

Update a draft

Replace a draft: APPEND a new copy, then delete the UID you pass. The delete is a Trash move unless allowPermanentDelete is on, in which case the old UID is expunged. Pass the same compose fields as mail_create_draft. uid is the existing draft.

Annotations: readOnlyHint=false, destructiveHint=false, idempotentHint=false, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox` (optional): Mailbox path as returned by mail_list_mailboxes, in Unicode (not modified UTF-7). Nested folders use the server delimiter, often "/" or ".". Examples: "INBOX", "Projects/2026", "Entwürfe".
- `uid`: UID of the draft to replace.
- `from` (optional): Mailbox address. Examples: "ada@example.com", "Ada Lovelace <ada@example.com>", "用户@例子.中国".
- `to` (optional): One or more addresses. A single string may also contain a comma-separated list.
- `cc` (optional): One or more addresses. A single string may also contain a comma-separated list.
- `bcc` (optional): One or more addresses. A single string may also contain a comma-separated list.
- `subject` (optional): Replacement subject.
- `text` (optional): Replacement plain text body.
- `html` (optional): Replacement HTML body.
- `attachments` (optional): 
  - `filename` (optional): File name shown to the recipient. Example: "notes.pdf".
  - `contentType` (optional): MIME type. Example: "application/pdf". Default is guessed from the filename when path is set.
  - `contentBase64` (optional): Base64-encoded bytes. Use this or path, not both. Do not include the data: URL prefix.
  - `path` (optional): Absolute or process-relative filesystem path to read. The server reads the file locally.
  - `cid` (optional): Content-ID for an inline image, without angle brackets. Reference it from HTML as cid:value.
  - `inline` (optional): true sets Content-Disposition: inline. Use with cid for images in HTML.

### Examples

```json
{"uid":12,"subject":"Draft","text":"Updated"}
```

## mail_delete_draft

Delete a draft

Delete one draft UID. Moves it to Trash unless you are already in Trash. mailbox defaults to the resolved Drafts folder. Requires allowDelete. This does not send the draft.

Annotations: readOnlyHint=false, destructiveHint=true, idempotentHint=true, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox` (optional): Drafts mailbox. Default is the resolved Drafts folder.
- `uid`: IMAP UID of one message. UIDs are only meaningful together with the mailbox uidValidity.

### Examples

```json
{"uid":12}
```

## mail_send_message

Send a message

Submit a message over SMTP (RFC 5321 / RFC 6409). Supports text, HTML (multipart/alternative when both are set), attachments from base64 or a local path, inline cid images, extra headers, priority (high, normal, low), a read receipt (Disposition-Notification-To), and DSN options when the server advertises DSN. from must be a configured identity. recipientDomainAllowList and sendRateLimit are enforced. After a successful send, the message is appended to Sent unless the provider is Gmail (which stores Sent itself) or appendSent is false or the account sets appendSent false. envelopeFrom and envelopeTo override the SMTP envelope without changing headers. Blocked when allowSend is false or readOnly.

Annotations: readOnlyHint=false, destructiveHint=false, idempotentHint=false, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `from` (optional): From identity. Default is the account default identity.
- `to`: One or more addresses. A single string may also contain a comma-separated list.
- `cc` (optional): One or more addresses. A single string may also contain a comma-separated list.
- `bcc` (optional): Envelope recipients. Not stored in the message header by the composer.
- `replyTo` (optional): One or more addresses. A single string may also contain a comma-separated list.
- `subject`: Subject line.
- `text` (optional): Plain text body. Provide text, html, or both.
- `html` (optional): HTML body.
- `attachments` (optional): 
  - `filename` (optional): File name shown to the recipient. Example: "notes.pdf".
  - `contentType` (optional): MIME type. Example: "application/pdf". Default is guessed from the filename when path is set.
  - `contentBase64` (optional): Base64-encoded bytes. Use this or path, not both. Do not include the data: URL prefix.
  - `path` (optional): Absolute or process-relative filesystem path to read. The server reads the file locally.
  - `cid` (optional): Content-ID for an inline image, without angle brackets. Reference it from HTML as cid:value.
  - `inline` (optional): true sets Content-Disposition: inline. Use with cid for images in HTML.
- `headers` (optional): Additional headers, for example {"X-Entity":"42"}.
- `priority` (optional): Sets the priority headers. Default is omitted.
- `readReceipt` (optional): true requests a read receipt to the From address.
- `envelopeFrom` (optional): SMTP MAIL FROM override. Default is the header From.
- `envelopeTo` (optional): SMTP RCPT TO override. Default is to+cc+bcc.
- `dsn` (optional): DSN request. Ignored by servers that do not advertise DSN.
  - `id` (optional): ENVID.
  - `ret` (optional): RET. FULL or HDRS.
  - `notify` (optional): NOTIFY values.
  - `orcpt` (optional): ORCPT. A bare address is sent as rfc822;address.
- `appendSent` (optional): Force or skip the Sent APPEND. Default follows account appendSent (auto skips Gmail).

### Examples

```json
{"to":["ada@example.com"],"subject":"Hello","text":"Hi Ada"}
```

## mail_reply_message

Reply to a message

Reply to a message identified by account, mailbox, and UID. Sets In-Reply-To and References, prefixes the subject with Re: unless it already has a reply prefix (Re, Aw, Sv), and quotes the original plain text (or the HTML rendered to text). replyAll true puts the original From (or Reply-To) in To and the other recipients in Cc, omitting this account. The result is the same shape as mail_send_message. Requires allowSend.

Annotations: readOnlyHint=false, destructiveHint=false, idempotentHint=false, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox`: Mailbox path as returned by mail_list_mailboxes, in Unicode (not modified UTF-7). Nested folders use the server delimiter, often "/" or ".". Examples: "INBOX", "Projects/2026", "Entwürfe".
- `uid`: IMAP UID of one message. UIDs are only meaningful together with the mailbox uidValidity.
- `uidValidity` (optional): Expected UIDVALIDITY decimal string from mail_get_mailbox_status or a previous list. When set, the call fails with UIDVALIDITY_CHANGED if the mailbox was recreated.
- `replyAll` (optional): true replies to all recipients. Default false replies only to From or Reply-To.
- `text` (optional): Your reply, placed above the quoted original.
- `html` (optional): Optional HTML for your reply. Quoting is still done in the text part.
- `subject` (optional): Override the subject. Default is Re: plus the original subject.
- `attachments` (optional): 
  - `filename` (optional): File name shown to the recipient. Example: "notes.pdf".
  - `contentType` (optional): MIME type. Example: "application/pdf". Default is guessed from the filename when path is set.
  - `contentBase64` (optional): Base64-encoded bytes. Use this or path, not both. Do not include the data: URL prefix.
  - `path` (optional): Absolute or process-relative filesystem path to read. The server reads the file locally.
  - `cid` (optional): Content-ID for an inline image, without angle brackets. Reference it from HTML as cid:value.
  - `inline` (optional): true sets Content-Disposition: inline. Use with cid for images in HTML.
- `appendSent` (optional): Force or skip the Sent APPEND. Default follows the account setting.

### Examples

```json
{"mailbox":"INBOX","uid":41,"text":"Thanks, I will look."}
```

## mail_forward_message

Forward a message

Forward a message by UID. Subject gains Fwd: unless it already has a forward prefix. The original text is quoted under a forwarded-message line. includeAttachments defaults to true and reattaches non-inline originals. Inline images are not copied. Pass to (required) and optional cc. Same send result and Sent-append rules as mail_send_message.

Annotations: readOnlyHint=false, destructiveHint=false, idempotentHint=false, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox`: Mailbox path as returned by mail_list_mailboxes, in Unicode (not modified UTF-7). Nested folders use the server delimiter, often "/" or ".". Examples: "INBOX", "Projects/2026", "Entwürfe".
- `uid`: IMAP UID of one message. UIDs are only meaningful together with the mailbox uidValidity.
- `uidValidity` (optional): Expected UIDVALIDITY decimal string from mail_get_mailbox_status or a previous list. When set, the call fails with UIDVALIDITY_CHANGED if the mailbox was recreated.
- `to`: One or more addresses. A single string may also contain a comma-separated list.
- `cc` (optional): One or more addresses. A single string may also contain a comma-separated list.
- `text` (optional): Note placed above the forwarded body.
- `html` (optional): Optional HTML body for the note you add.
- `subject` (optional): Override the subject. Default is Fwd: plus the original.
- `attachments` (optional): Extra attachments, in addition to the originals when includeAttachments is true.
  - `filename` (optional): File name shown to the recipient. Example: "notes.pdf".
  - `contentType` (optional): MIME type. Example: "application/pdf". Default is guessed from the filename when path is set.
  - `contentBase64` (optional): Base64-encoded bytes. Use this or path, not both. Do not include the data: URL prefix.
  - `path` (optional): Absolute or process-relative filesystem path to read. The server reads the file locally.
  - `cid` (optional): Content-ID for an inline image, without angle brackets. Reference it from HTML as cid:value.
  - `inline` (optional): true sets Content-Disposition: inline. Use with cid for images in HTML.
- `includeAttachments` (optional): Include original non-inline attachments. Default true.
- `appendSent` (optional): Force or skip the Sent APPEND. Default follows the account setting.

### Examples

```json
{"mailbox":"INBOX","uid":41,"to":["bea@example.com"],"text":"FYI"}
```

## mail_send_draft

Send a saved draft

Submit the raw RFC822 of a saved draft over SMTP, using its headers as the message and its To/Cc/Bcc as the envelope. mailbox defaults to wherever the draft lives; pass the Drafts path and the draft UID. Does not delete the draft; call mail_delete_draft afterwards if you want it gone. Same safety checks as mail_send_message.

Annotations: readOnlyHint=false, destructiveHint=false, idempotentHint=false, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox`: Mailbox that holds the draft, usually Drafts.
- `uid`: IMAP UID of one message. UIDs are only meaningful together with the mailbox uidValidity.
- `uidValidity` (optional): Expected UIDVALIDITY decimal string from mail_get_mailbox_status or a previous list. When set, the call fails with UIDVALIDITY_CHANGED if the mailbox was recreated.
- `appendSent` (optional): Force or skip the Sent APPEND. Default follows the account setting.

### Examples

```json
{"mailbox":"Drafts","uid":12}
```

## mail_verify_smtp

Verify SMTP

Authenticate to the submission server and disconnect, without sending. Use this when mail_send_message fails and you want to separate SMTP problems from message construction. The result includes ok, and on failure a code such as AUTH_FAILED or TLS_FAILED plus a hint. No message is stored.

Annotations: readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".

### Examples

```json
{}
```

## mail_wait_for_changes

Wait for mailbox changes

Block until the mailbox changes or timeoutMs elapses (default 25000, range 1000 to 120000). Uses IDLE when the server advertises it, otherwise the connection polls. Returns the events seen (exists, expunge, flags) and a fresh STATUS. timedOut is true when nothing changed. idleSupported says which mechanism ran. This is the right tool for "tell me when new mail arrives"; do not poll mail_list_messages in a tight loop. The call holds one pooled connection until it returns.

Annotations: readOnlyHint=true, destructiveHint=false, idempotentHint=false, openWorldHint=true.

### Arguments

- `account` (optional): Account id from mail_list_accounts. Omit to use the configured default account. Example: "work".
- `mailbox` (optional): Mailbox to watch. Default INBOX.
- `timeoutMs` (optional): How long to wait, in milliseconds. Default 25000.

### Examples

```json
{"mailbox":"INBOX","timeoutMs":15000}
```

