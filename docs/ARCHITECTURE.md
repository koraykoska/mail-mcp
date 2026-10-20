# Architecture

`mail-mcp` is a Model Context Protocol server. A client speaks JSON-RPC over stdio (or, optionally, streamable HTTP). The server turns those calls into IMAP and SMTP operations on one or more accounts.

## Libraries

| Concern                    | Library                     | Why                                                                                                                                                     |
| -------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP                        | `@modelcontextprotocol/sdk` | Official protocol implementation, including tool schemas, stdio, and streamable HTTP.                                                                   |
| IMAP                       | `imapflow`                  | Maintained client with IDLE, MOVE (and its COPY+EXPUNGE fallback), CONDSTORE, QUOTA, NAMESPACE, ID, Gmail extensions, and modified UTF-7 mailbox names. |
| SMTP and MIME construction | `nodemailer`                | Submission, STARTTLS policy, XOAUTH2, DSN, and the same MIME composer used to build the bytes stored in Sent.                                           |
| Parsing                    | `mailparser`                | RFC 2047 encoded words, charsets, multipart, `message/rfc822`, and attachments.                                                                         |
| HTML rendering             | `html-to-text`              | A readable text alternative for HTML bodies.                                                                                                            |
| Config and tool schemas    | `zod`                       | One schema language for the config file and for MCP input/output.                                                                                       |

The server does not shell out to a desktop mail client and it does not keep a local maildir.

## Process model

`src/cli.ts` parses arguments, loads configuration, and either runs `--check` or connects an MCP server.

- Stdio is the default. Logs go to stderr because stdout is the protocol stream.
- `--http` listens on `/mcp` with one MCP server object per session. Sessions share one mail runtime.
- SIGINT, SIGTERM, and stdio close log out pooled IMAP connections.

## Configuration

`src/config/load.ts` accepts either environment variables (one implicit account id `default`) or a JSON/JSONC file (`--config` or `MAIL_MCP_CONFIG`). `${VAR}` references are substituted before validation. Provider presets in `src/config/providers.ts` fill host, port, and TLS mode when `provider` is set. Plaintext is only used when `secure` is false and `starttls` is explicitly `disabled`. Otherwise a cleartext port upgrades with STARTTLS.

## Sessions

`ImapConnectionPool` keeps up to `poolSize` connections per account (default 2). Each connection is an `ImapFlowSession`. The pool retries an operation once when the failure is a dropped connection or a timeout. Authentication and TLS failures are not retried.

Mailbox commands take `getMailboxLock`, so two operations on one connection cannot interleave. IMAP itself is still one command at a time per connection; the pool is what allows a listing and an IDLE wait to run together.

OAuth2 access tokens are refreshed with the provider token URL (Gmail and Microsoft presets are built in) and cached until shortly before `expires_in`. Passwords and tokens are collected into a secret list and stripped from logs.

## Tools

Tool definitions live in `src/tools/catalog.ts`. That module is the source for both MCP registration and `docs/TOOLS.md`. Handlers call `MailService`, which enforces safety switches, page limits, UIDVALIDITY checks, and recipient allow-lists before touching the network.

Mutating tools are not registered when every account forbids that operation. If at least one account allows it, the tool is registered and the selected account is checked again at call time.

Search criteria are compiled to the object ImapFlow sends. `OR` and `AND` groups become IMAP `NOT`/`OR` trees. SORT and THREAD are used when the server advertises them and the query is "all messages"; otherwise the server sorts or threads on the client from fetched summaries, capped by `limits.maxSortCandidates`.

MOVE without the MOVE extension is refused when the server also lacks UIDPLUS and the account has not opted into permanent delete, because the COPY+EXPUNGE fallback would expunge every `\Deleted` message. ImapFlow performs the fallback when it is allowed.

Gmail accounts skip the Sent APPEND in `appendSent: "auto"` because Gmail stores the sent copy itself.

## Errors

Transport failures are mapped to stable codes in `src/errors.ts`. Tool failures return `isError: true` and a structured `{ error: { code, message, hint } }`. Messages are passed through `redactText` so a password or token that leaked into an upstream error is replaced.

## Tests

Unit tests cover pure modules and `MailService` against an in-memory session. Integration tests speak to GreenMail (real IMAP and SMTP, including implicit TLS) and to a small scripted IMAP server for missing extensions, authentication failure, and UIDVALIDITY changes. End-to-end tests spawn the built `mail-mcp` binary over stdio.
