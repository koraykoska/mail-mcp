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
- `recipientDomainAllowList` is applied to the SMTP envelope (`envelopeTo` when set, otherwise To, Cc, and Bcc). `envelopeFrom` and a draft's From must be a configured identity, unless `allowFromDomains` lists that address's domain. An empty allow-list means identities only.
- `sendRateLimit` caps submissions per account inside this process. It is not a cluster-wide limit.
- `attachmentsDir` is required for `savePath` writes and for attachment `path` reads. Both are resolved with `realpath` and must stay inside that directory. A `readOnly` account cannot write `savePath`. The byte cap is applied before the file is read or returned.

## Network

The optional HTTP transport binds to `127.0.0.1` by default. A non-loopback `--host` is refused unless `--http-token` or `MAIL_HTTP_TOKEN` is set. When a token is configured it is required on every `/mcp` request, including requests that already carry `mcp-session-id`. `/health` stays open. Request bodies are capped. Stdio does not listen.

HTML returned by the tools, and HTML quoted into a reply or forward, is passed through an allow-list sanitizer. Only a fixed set of tags and the `http`, `https`, `mailto`, and `cid` URL schemes are kept. Event handlers, style, and embedded content are dropped. The text rendering does not delete those scheme names from ordinary prose.

A raw fetch asks for at most `maxMessageBytes + 1` octets. If the server ignores that partial and announces a larger literal, the parser refuses it before those bytes are buffered. The connection is closed and dropped from the pool, and the call fails with `SIZE_LIMIT`. The next call opens a new connection.

Attachment `path` values and `savePath` are local filesystem paths. A client that can call tools can read files the process can read and write files the process can write, subject to `attachmentsDir`.
