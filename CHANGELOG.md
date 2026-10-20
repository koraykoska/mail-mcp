# Changelog

## Unreleased

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

## 0.1.0

- Release 0.1.0.

## 0.0.1

- Published on npm as `@koraykoska/mail-mcp`. The executable name is `mail-mcp`.
- Initial IMAP and SMTP client exposed as a Model Context Protocol server.
- Multiple accounts, provider presets, password and OAuth authentication, safety switches, and paged tools for mailboxes, messages, drafts, and sending.
