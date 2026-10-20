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
- `recipientDomainAllowList` rejects SMTP recipients outside those domains.
- `sendRateLimit` caps submissions per account inside this process. It is not a cluster-wide limit.
- `attachmentsDir`, when set, refuses `savePath` values that escape the directory.

## Network

The optional HTTP transport binds to `127.0.0.1` by default and does not add its own authentication. Do not expose it on a public interface without a reverse proxy that authenticates clients. Stdio does not listen.

Attachment `path` values and `savePath` are local filesystem paths. A client that can call tools can read files the process can read and write files the process can write, subject to `attachmentsDir`.
