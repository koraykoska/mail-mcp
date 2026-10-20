# Changelog

## Unreleased

- Conversation threading across folders (`mail_get_thread`), with header links by default and an opt-in subject heuristic. Messages that have no Message-ID are not merged.
- Shared folder scope and snapshot pagination for list, search, threads, attachments, correspondents, counts, and dry-run bulk actions. A cursor freezes an upper UID so mail that arrives later does not shift the page. `CURSOR_INVALIDATED` is returned when UIDVALIDITY changes.
- Sending identities: optional `from` on send, reply, forward, and drafts, checked against configured identities and `allowFromDomains`.
- `mail_list_correspondents`, `mail_search_facets`, `mail_count`, `mail_list_attachments`, and `mail_modify_by_search` (dry-run by default).
- Manual connect address (`connectHost` / `connectPort`, `MAIL_IMAP_CONNECT`, `MAIL_SMTP_CONNECT`, `--imap-connect`, `--smtp-connect`) so a tunnel can carry TCP while TLS still verifies the real hostname.
- `MAIL_ACCOUNT` names the account when there is no config file. The CLI requires Node.js 22, and prints how to run `bunx --bun` on an older Node.
- JSON Schema for the config file at `schema/config.schema.json`.

## 0.1.0

- Release 0.1.0.

## 0.0.1

- Published on npm as `@koraykoska/mail-mcp`. The executable name is `mail-mcp`.
- Initial IMAP and SMTP client exposed as a Model Context Protocol server.
- Multiple accounts, provider presets, password and OAuth authentication, safety switches, and paged tools for mailboxes, messages, drafts, and sending.
