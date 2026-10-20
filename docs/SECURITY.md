# Security

This process can read and send mail for every account in its configuration. Run it as the user who owns the mailbox, with the smallest set of accounts and switches that the work needs.

## Credentials

- Prefer an app password or OAuth refresh token over the primary account password.
- Put secrets in the environment (`${VAR}` in the file) rather than committing them.
- Logs and tool errors pass through redaction for `password`, `token`, `secret`, `authorization`, bearer tokens, and the exact secret values loaded from the config. Do not echo raw protocol traces on stdout.

## TLS

Implicit TLS is the default for the usual IMAP and submission ports. Cleartext is possible only when `starttls` is `disabled`. Leaving `starttls` unset on a non-TLS port means STARTTLS is required, so a network attacker cannot strip the upgrade.

`tls.rejectUnauthorized: false` disables certificate checks. Use it only for a local Proton Bridge or a lab server, and do not combine it with an account that can send.

## Mutation and sending

- `readOnly` accounts cannot create folders, change flags, append, delete, or send. If every account is read-only, mutating tools are not registered.
- `allowPermanentDelete` defaults to false. Delete moves to Trash. Expunge and permanent UID delete stay off until the flag is set.
- `recipientDomainAllowList` is applied to the SMTP envelope (`envelopeTo` when set, otherwise To, Cc, and Bcc). `envelopeFrom`, `from`, and `replyTo` must be a configured identity, unless `allowFromDomains` lists that address's domain. An empty allow-list means identities only. When `replyTo` is omitted, the selected identity's reply-to address is applied. The sent Reply-To is the parsed address list, so a display name cannot smuggle a second address.
- Custom `headers` are an allow-list checked after the same canonicalization Nodemailer uses (strip `[\s\x00-\x20\x7f:]`, then lowercase). A name that changes under that step, or that is not a token, is rejected. Allowed names are `X-*`, `List-Unsubscribe`, `List-Unsubscribe-Post`, `Auto-Submitted`, `Precedence`, `Importance`, `X-Priority`, `Keywords`, and `Comments`. An `X-` name is split into tokens on `-`, `_`, and camelCase boundaries, using the original spelling so a boundary such as `OriginalFrom` is not flattened first. It is rejected when any suffix of those tokens, joined by `-`, is an address-bearing name: `to`, `from`, `sender`, `cc`, `bcc`, `reply-to`, `errors-to`, `return-path`, `delivered-to`, `apparently-to`, `apparently-from`, `original-from`, `original-to`, `receipt-to`, `read-receipt-to`, `return-receipt-to`, `notification-to`, `disposition-notification-to`, `confirm-reading-to`, `reading-to`, `mdn-to`, `mail-followup-to`, `followup-to`, or `mail-reply-to`. It is also rejected when any token is `resent`, `envelope`, `rcpt`, or `bounce`. A name with no separator and no camelCase is rejected when the compact remainder ends with `from`, `sender`, `replyto`, `errorsto`, `returnpath`, `deliveredto`, `receiptto`, `notificationto`, `readingto`, `mdnto`, `apparentlyto`, `followupto`, or `originalto`. `X-Sender-IP`, `X-Notification`, and `X-GitHub-Notification` stay allowed. Other `X-*` names stay allowed. A parenthesized comment on `to`, `cc`, `bcc`, or `replyTo` is removed before the address is parsed, and the addr-spec is kept. `From`, `Sender`, `Reply-To`, `To`, `Cc`, `Bcc`, `Message-ID`, `Return-Path`, every `Resent-*` field, `Disposition-Notification-To`, `Return-Receipt-To`, `Mail-Reply-To`, `Mail-Followup-To`, `Errors-To`, and `Apparently-From` are rejected with an error that names the structured field (`from`, `replyTo`, `to`, `cc`, `bcc`). Matching an identity does not make `headers.From` legal. `In-Reply-To` and `References` are set only by reply. `Bcc` and `Resent-Bcc` are stripped from submitted bytes.
- `mail_send_draft` parses the raw header block on every send and rebuilds the message. `From`, `Sender`, `Reply-To`, `To`, `Cc`, and `Bcc` are written from the checked addr-specs. Display names are decoded, NFKC-normalized, then dropped when they contain `@` or `<>`, when they are still an encoded-word, or when they came from a comment. Send, reply, forward, and draft all strip a parenthesized comment before parsing, so `bob@example.com (Eve <eve@evil.test>)` is the addr-spec alone. A second copy of `From`, `Sender`, or `Reply-To` is `PERMISSION_DENIED`. A field name that is not an RFC 5322 field name, including whitespace before the colon, is `PERMISSION_DENIED`. Allow-listed headers are copied from the raw header block (original field name and raw value), so `List-Unsubscribe`, `List-Unsubscribe-Post`, and `Importance` are not dropped. Two allow-listed fields with the same name, such as two `Comments` lines, are submitted as two fields, not one comma-joined line, and each keeps the field name from the draft. The same identity, recipient-domain, and rate-limit checks apply to every address on `From`, `Sender`, `Reply-To`, every `Resent-*` address, and the receipt and legacy reply headers. When the draft has no Reply-To, the identity's reply-to address is applied. `identityReason` is `stored-draft` when `from` is omitted.
- `mail_modify_by_search` is a write. A read-only account does not advertise it. A real run that truncated a folder, or that did not load every match, fails with `SIZE_LIMIT` and changes nothing.
- `sendRateLimit` caps submissions per account inside this process. It is not a cluster-wide limit.
- `attachmentsDir` is required for `savePath` writes and for attachment `path` reads. Both are resolved with `realpath` and must stay inside that directory. A `readOnly` account cannot write `savePath`. The byte cap is applied before the file is read or returned.

## Network

The optional HTTP transport binds to `127.0.0.1` by default. A non-loopback `--host` is refused unless `--http-token` or `MAIL_HTTP_TOKEN` is set. When a token is configured it is required on every `/mcp` request, including requests that already carry `mcp-session-id`. `/health` stays open. Request bodies are capped. Stdio does not listen.

HTML returned by the tools, and HTML quoted into a reply or forward, is passed through an allow-list sanitizer. Only a fixed set of tags and the `http`, `https`, `mailto`, and `cid` URL schemes are kept. Event handlers, style, and embedded content are dropped. The text rendering does not delete those scheme names from ordinary prose.

A raw fetch asks for at most `maxMessageBytes + 1` octets. If the server ignores that partial and announces a larger literal, the parser refuses it before those bytes are buffered. The connection is closed and dropped from the pool, and the call fails with `SIZE_LIMIT`. The next call opens a new connection.

Attachment `path` values and `savePath` are local filesystem paths. A client that can call tools can read files the process can read and write files the process can write, subject to `attachmentsDir`.
