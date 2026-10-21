# Changelog

## Unreleased

- Search AND is one SEARCH with the criteria side by side. A NOT over a UID set, a sequence set, or more than one criterion is computed from UID sets on the client, so the same query matches the same messages on iCloud, Gmail, Dovecot, and GreenMail. A text criterion combined with a UID or a flag is sent as that one SEARCH.
- `PROTOCOL_ERROR` includes the server's `NO` or `BAD` text when the server sent one.
- Bulk flag, copy, move, delete, label, and modify-by-search calls send UID sets in chunks of 25. `limits.bulkBudgetMs` (default 20000, maximum 50000) bounds the whole call, including the wait for a connection and the modify-by-search folder scan. The result adds `complete`, `remaining`, and `stopped` (`budget`, `cancelled`, `connection`, or null). Pass `remaining` back with the same action to resume. `ok` is true only when every requested UID was attempted and succeeded. `mail_modify_by_search` also returns `results` (empty on a dry run). Labels on a server without `X-GM-EXT-1` fail the call with `CAPABILITY_UNSUPPORTED`.
- A move without the MOVE extension copies and expunges only UIDs confirmed by UIDPLUS `COPYUID`. Unconfirmed UIDs stay in the source mailbox and are reported. A duplicate in the destination can remain. Without MOVE and without UIDPLUS the move is `CAPABILITY_UNSUPPORTED`. MOVE and UIDPLUS are available when the server advertises them, or when IMAP4rev2 is active. Advertising IMAP4rev2 next to IMAP4rev1 does not count until `ENABLE IMAP4REV2` takes effect.
- A dropped connection during a bulk chunk stops the call with `stopped: "connection"`. The in-flight chunk and every UID not yet attempted are returned in `remaining`. A UID is `NOT_FOUND` only when a search on a healthy, selected mailbox showed it was absent. A server `NO` or `BAD` stays a per-UID failure and the batch continues.
- An ESEARCH `ALL` set that contains `*` is resolved against the mailbox UIDNEXT and read back with UID FETCH, so a client-side complement does not come back empty.
- When the bulk budget runs out before any chunk starts, the call returns `complete: false`, `stopped: "budget"`, and `remaining` set to every requested UID. For `mail_modify_by_search`, an empty `remaining` with `stopped: "budget"` means the scan did not finish: repeat the same search.

## 0.2.0

- The Gmail `X-GM-THRID` and OBJECTID fast paths keep the earliest in-scope messages when `maxMessages` trips, using the same date, mailbox, and UID order as the header walk. Every id the capability search returned is still walked.
- The Gmail `X-GM-THRID` and OBJECTID fast paths pass every id the capability search returned into the header closure, including a message `maxMessages` did not keep. A folder that cites only that message still appears in `excludedMatches`.
- A later `mail_get_thread` page reuses the first page's `truncated` flag and `rounds`, along with the frozen `excludedMatches` list.
- `excludedMatches` on the cursor is capped at 500 folders, the first in path order. When more match, `excludedMatchesTruncated` is true and a later page reuses that prefix.
- Header threading starts from the earliest id the seed already names, so a parent uid and the Message-ID of a reply that cites it share one search budget even when the cap stops the walk. Each round allows 8 searches. The default of 4 rounds is 32 searches. `maxRounds` raises that ceiling, up to 8 rounds (64 searches).
- A later `mail_get_thread` page reuses the `excludedMatches` list frozen on the first page, including ids that were found only on out-of-scope messages. The Gmail `X-GM-THRID` and OBJECTID fast paths build that list from the same header closure. Hitting `maxMessages` still scans out-of-scope folders. The kept items are the earliest messages, so the set does not depend on which seed started the walk.
- Header threading repeats a search for every id an out-of-scope hit adds until no new id appears, or until 8 searches per round and 32 searches in total. Both seeds that finish under that cap return the same items and the same `truncated` value. A walk stopped by the cap sets `truncated`.
- An `X-` token is rejected when any digit normalization matches an address or routing word: all digits removed, or look-alike digits mapped (`0` as `o`, `1` as `l` and as `i`, `3` as `e`, `4` as `a`, `5` as `s`, `7` as `t`) with the other digits removed. That is a best-effort guard. MTAs and Nodemailer do not read those names as routing headers. It over-blocks `X-From0`, `X-From0-Not`, `X-Enve1ope`, `X-Bounc3`, `X-3nv3l0p3`, and `X-B0unc3`. `X-Sender-IP2`, `X-Notification2`, `X-Photo2`, and `X-Original-Arrival-Time` stay allowed.
- Conversation threading across folders (`mail_get_thread`), with header links by default and an opt-in subject heuristic. Messages that have no Message-ID are not merged.
- Shared folder scope and snapshot pagination for list, search, threads, attachments, correspondents, counts, and dry-run bulk actions. A cursor freezes an upper UID so mail that arrives later does not shift the page. `CURSOR_INVALIDATED` is returned when UIDVALIDITY changes.
- Sending identities: optional `from` on send, reply, forward, and drafts, checked against configured identities and `allowFromDomains`.
- `mail_list_correspondents`, `mail_search_facets`, `mail_count`, `mail_list_attachments`, and `mail_modify_by_search` (dry-run by default).
- Manual connect address (`connectHost` / `connectPort`, `MAIL_IMAP_CONNECT`, `MAIL_SMTP_CONNECT`, `--imap-connect`, `--smtp-connect`) so a tunnel can carry TCP while TLS still verifies the real hostname.
- `MAIL_ACCOUNT` names the account when there is no config file. The CLI requires Node.js 22, and prints how to run `bunx --bun` on an older Node.
- JSON Schema for the config file at `schema/config.schema.json`.
- Snapshot paging keeps a unique row (mailbox, UIDVALIDITY, UID, and part id for attachments). An empty fetch or an expunged anchor continues at the next frozen UID instead of ending the walk. `mail_get_thread` freezes its UID set on the first page.
- Thread nodes are keyed by mailbox and UID. `source` is `server` only when a single folder uses the server THREAD tree. One `threadKey`, from the earliest message with no parent in the set, is returned on the envelope and on every item.
- Header threading keeps a search hit only when the Message-ID, In-Reply-To, or References token matches exactly. A Message-ID seed uses every folder that contains it, plus Sent, Archive, and All.
- `mail_list_correspondents` and the sender and attachment counts of `mail_search_facets` read every match, in batches, up to 10000 messages per folder. Above that cap `truncated` and `partial` are true.
- `mail_modify_by_search` is a write. A non-dry-run that did not load every match fails with `SIZE_LIMIT` and changes nothing.
- `replyTo`, and `From`, `Sender`, `Reply-To`, `To`, `Cc`, and `Bcc` inside `headers`, are checked like `from`. `Message-ID` and `Return-Path` in `headers` are rejected. An identity's `replyTo` is listed and used when the caller does not pass one. A draft send appends the bytes that were sent, without Bcc.
- `folders: all`, globs, and special-use skip `\Noselect` and `\NonExistent` mailboxes. A Message-ID lookup uses that scope first. Selecting one of those paths returns `MAILBOX_NOT_SELECTABLE`.
- `mail_list_threads` reads References, In-Reply-To, and Message-ID from the header, so a server whose ENVELOPE omits In-Reply-To still matches `mail_get_thread`.
- Custom `headers` are an allow-list after the composer's header-name canonicalization. `mail_send_draft` checks the stored From, Sender, Reply-To, Resent-* addresses, and receipt headers on every send. Reply-To is emitted from the parsed address list. `Resent-Bcc` is stripped with `Bcc`.
- A later `mail_get_thread` page re-fetches the frozen mailbox and UID keys and returns `CURSOR_INVALIDATED` when UIDVALIDITY changes. A mailbox and uid seed also searches INBOX.
- A single-folder server SORT honors `maxSortCandidates` / `maxPerFolder` and reports `truncated`.
- `mail_send_draft` always rebuilds `From`, `Sender`, and `Reply-To` from the checked addresses. A display name that contains another address is dropped, comments are removed, and a second copy or a field name with whitespace before the colon is `PERMISSION_DENIED`. `identityReason` is `stored-draft` when `from` is omitted.
- Routing aliases `X-Reply-To`, `X-Confirm-Reading-To`, `X-Sender`, `X-Envelope-From`, `X-Envelope-Sender`, `X-Envelope-To`, `X-Original-From`, `X-Original-Sender`, `X-Original-To`, `X-Original-Recipient`, `X-Apparently-From`, `X-Apparently-To`, and `X-Rcpt-To` are rejected. Other `X-*` headers stay allowed.
- A Message-ID seed with no `folders` uses the same scope as a mailbox and uid seed: the seed mailbox, INBOX, Sent, Archive, and All. Junk and Trash stay out. `excludedMatches` is the same list for both seeds, in path order. A message that exists only in Junk or Trash is left out of the items until `folders` names that mailbox.
- `mail_send_draft` sanitizes display names on `To`, `Cc`, and `Bcc` the same way as `From`, and send, reply, and forward do the same for `To` and `Cc`. Names are NFKC-normalized, and a name that is still an encoded-word is dropped. Allow-listed headers are copied from the raw header block.
- `excludedMatches` is computed after the thread is closed. The id set is every id the walk discovered, including ids that appear only on out-of-scope messages, followed transitively. Every seed of that conversation reports the same path-ordered list. A folder in the scope is never listed.
- A Message-ID that exists only in Junk or Trash is walked in both directions from that copy's Message-ID, In-Reply-To, and References. An in-scope parent and an in-scope reply are returned. The Junk or Trash copy stays in `excludedMatches`. If nothing in scope matches, the items are empty and `excludedMatches` still names that folder. The placeholder seed does not consume a `maxMessages` slot.
- Out-of-scope folders are matched with UID SEARCH in batches, not a full header fetch of every message. An empty mailbox is not searched.
- An `X-` header is lowercased first and split on `-` and `_`, never on camelCase. Each token is normalized before the match: `0` is read as `o` and other digits are removed, so digits are stripped from every token. A token that becomes `from`, `to`, `cc`, `bcc`, or `recipient` is rejected in any position, which rejects `X-From2-Not`, `X-Fr0m`, `X-Envel0pe`, and `X-B0unce`. `sender` is rejected only as the last token or a compact suffix, so `X-Sender-IP`, `X-Sender-IP2`, `X-Notification`, `X-Notification2`, `X-Photo`, and `X-Original-Arrival-Time` stay allowed. A trailing address-bearing name is rejected, as is any token `resent`, `envelope`, `rcpt`, or `bounce`. The compact form is always checked. `X-Report-Abuse-To`, `X-Complaint-To`, `X-Authenticated-Sender`, and `X-Forwarded-To` are rejected on purpose, and so is a non-final `from`, `to`, `cc`, `bcc`, or `recipient` token.
- Header threading searches ids that an out-of-scope hit just added in the same round. A parent uid and the Trash Message-ID seed reach the same in-scope messages inside the default round budget, with the same `truncated` value and the same `excludedMatches` list.
- A display name that contains parentheses or another RFC 5322 special is quoted, so `Bob (work)` round-trips. An unquoted comment is still removed.
- A parenthesized comment on an address is stripped before parsing on send, reply, forward, and draft. `bob@example.com (Eve <eve@evil.test>)` keeps the addr-spec.
- Duplicate allow-listed draft headers are submitted as separate fields and keep the field name from the draft.

## 0.1.0

- Release 0.1.0.

## 0.0.1

- Published on npm as `@koraykoska/mail-mcp`. The executable name is `mail-mcp`.
- Initial IMAP and SMTP client exposed as a Model Context Protocol server.
- Multiple accounts, provider presets, password and OAuth authentication, safety switches, and paged tools for mailboxes, messages, drafts, and sending.
