# mail-mcp

IMAP and SMTP mail client as a [Model Context Protocol](https://modelcontextprotocol.io) server. An MCP client can list mailboxes, search and read messages, change flags, manage folders and drafts, and send mail over the same accounts a desktop client would use.

The package name on npm is `@koraykoska/mail-mcp`. The executable is `mail-mcp`.

Node.js 22 or newer is required. On a machine with an older Node, `bunx --bun @koraykoska/mail-mcp` runs on Bun's runtime instead.

```bash
npx -y @koraykoska/mail-mcp --help
bunx --bun @koraykoska/mail-mcp --help
mail-mcp --version
```

## Quick start

One account from the environment, stdio transport. With no config file, `MAIL_ACCOUNT` is the account id (otherwise `default`):

```bash
export MAIL_ACCOUNT=personal
export MAIL_IMAP_HOST=imap.example.com
export MAIL_SMTP_HOST=smtp.example.com
export MAIL_USER=you@example.com
export MAIL_PASSWORD=app-password
mail-mcp
```

Check the connection and exit:

```bash
mail-mcp --check
```

Optional streamable HTTP (loopback by default):

```bash
mail-mcp --http --port 3333
```

Logs are written to stderr. Stdout is reserved for the protocol.

## MCP client configuration

```json
{
  "mcpServers": {
    "mail": {
      "command": "npx",
      "args": ["-y", "@koraykoska/mail-mcp"],
      "env": {
        "MAIL_IMAP_HOST": "imap.example.com",
        "MAIL_IMAP_PORT": "993",
        "MAIL_IMAP_SECURE": "true",
        "MAIL_SMTP_HOST": "smtp.example.com",
        "MAIL_SMTP_PORT": "465",
        "MAIL_SMTP_SECURE": "true",
        "MAIL_USER": "you@example.com",
        "MAIL_PASSWORD": "app-password"
      }
    }
  }
}
```

For several accounts, pass a file:

```json
{
  "mcpServers": {
    "mail": {
      "command": "mail-mcp",
      "args": ["--config", "/home/you/.config/mail-mcp.jsonc"]
    }
  }
}
```

## What you can do

The catalog has 47 tools. With the default safety switches, 46 are registered: `mail_expunge_mailbox` is omitted until an account sets `allowPermanentDelete`. If every account is read-only, or send or delete is off for every account, the matching mutation tools are omitted too. Calls are still checked per account.

Tools cover accounts and identities, server capabilities, namespaces, quota, and ID; mailbox list, tree, status, counts, create, rename, delete, subscribe; message list, search, fetch, raw source, headers, MIME parts, attachments, and threads; flags, copy, move, delete, expunge, append, Gmail labels, and bulk updates, including a dry-run search bulk action; drafts; SMTP send, reply, forward, and draft send; correspondents and search facets; and IDLE (with a polling fallback).

Every tool takes an optional `account`. List tools share one paging model (`limit`, `cursor`, `order`, `items`, `nextCursor`, `total`, `truncated`, `snapshot`). Mutating tools carry MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).

`mail_list_accounts` returns each account's identities. There is no separate identities tool.

Full argument lists: [docs/TOOLS.md](docs/TOOLS.md).

### Paging

`limit` defaults to `limits.pageSize` (25). Summary pages are capped at the lower of 200 and `limits.maxPageSize`. Calls that include message bodies are capped at 20. The first page stores that limit in the cursor. Later pages reuse it when `limit` is omitted.

`order` is `newest-first` (default) or `oldest-first` when `sort` is omitted. When `sort` is set, `order` must agree with the first key. Ties break by date, then folder path (UTF-16 code units), then UID.

The first page records an upper UID of `uidNext - 1` for each folder. Later pages reuse that bound, so mail that arrives afterwards does not shift the walk and is not skipped or duplicated inside it. To see mail that arrived after the snapshot, call again without a cursor. The cursor also freezes the folder scope, the sort, and the page size. A `uidValidity` change returns `CURSOR_INVALIDATED`. A cursor from an older release returns `INVALID_ARGUMENT`. If the last row of a page was expunged, the next page starts at the first row that sorts after it.

`snapshot.folders` reports `scanned`, `omitted`, and `truncated` per folder when a cap cuts the scan.

### Folder scope

There is no config key for a default folder list. The defaults live on the tools:

| Call                                                                                                                                                                                | When `folders` is omitted                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `mail_list_messages`, `mail_search_messages`, `mail_list_threads`, `mail_count`, `mail_list_attachments`, `mail_list_correspondents`, `mail_search_facets`, `mail_modify_by_search` | The single `mailbox` argument, or `INBOX` when that is omitted too. `folders` replaces `mailbox` when set. |
| `mail_get_thread`                                                                                                                                                                   | The seed mailbox plus Sent, Archive, and All. Junk and Trash stay out.                                     |

`folders` may be one mailbox path, a list, a special-use flag such as `\Sent`, a glob such as `Projects/*`, the string `all`, or an object `{ all, mailboxes, specialUse, globs, exclude, includeTrash, includeJunk }`. `all` skips Trash and Junk unless they are named, or `includeTrash` / `includeJunk` is true. Multi-folder reads run one mailbox at a time on one IMAP connection. `maxPerFolder` caps how many messages are scanned in a folder when the server cannot sort the whole snapshot. The default and the maximum are `limits.maxSortCandidates` (5000). A truncated folder reports `truncated`, `omitted`, and `scanned`.

## Configuration

Accounts come from a JSON or JSONC file, environment variables, or both. The checked-in schema is [`schema/config.schema.json`](schema/config.schema.json) (JSON Schema draft-07, generated from the zod schema in `src/config/schema.ts`). Regenerate it with `npx tsx scripts/generate-config-schema.ts`. A unit test fails when the file drifts. The same page is summarized in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

### File location and precedence

The file is whatever `--config` points at, otherwise `MAIL_MCP_CONFIG`. Both are paths, resolved from the process working directory. There is no default path. `--config` wins over `MAIL_MCP_CONFIG`.

The file may contain `//` and `/* */` comments and trailing commas. Unknown keys are rejected.

| Source                                   | What it overrides                                                                                                                                                                                              |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File                                     | Account fields, top-level `logLevel`, `poolSize`, `limits`, `attachmentsDir`, `defaultAccount`.                                                                                                                |
| Environment account variables            | With no file, they create one account whose id is `MAIL_ACCOUNT` or `default`. With a file, they merge into the account id `default` only when `MAIL_IMAP_HOST` is set. They do not overlay any other account. |
| `MAIL_ACCOUNT`                           | With no file, the account id. With a file that omits `defaultAccount`, the default account when that id exists. A file `defaultAccount` wins.                                                                  |
| `MAIL_LOG_LEVEL`, `MAIL_POOL_SIZE`       | Used only when the file omits `logLevel` or `poolSize`.                                                                                                                                                        |
| `MAIL_IMAP_CONNECT`, `MAIL_SMTP_CONNECT` | TCP address of the default account, after the file is resolved. Other accounts keep their own `connectHost`.                                                                                                   |
| `--imap-connect`, `--smtp-connect`       | TCP address of `--account`, or of the default account. Applied after the environment, so the flags win.                                                                                                        |
| `--log-level`                            | Wins over the file and `MAIL_LOG_LEVEL`.                                                                                                                                                                       |
| `--account`                              | Which account `--check` and the connect flags use. Tool calls still pass their own `account`.                                                                                                                  |

There is no CLI flag for hosts, passwords, or safety switches. Those are file or environment values.

### Environment substitution

Before validation, every string in the file is scanned:

| Form              | Result                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `${VAR}`          | The value of `VAR`. A missing or empty variable is a startup error that names `VAR` and the path. |
| `${VAR:-default}` | `VAR` when it is set and non-empty, otherwise the literal default.                                |
| `$${`             | An escape that becomes `${`.                                                                      |

Numbers and booleans are not substituted. Put a number that comes from the environment in a string only where the schema expects a string. Ports and limits are JSON numbers.

### Required keys

The root object may be empty of keys, but the process must end up with at least one account. `defaultAccount` is required when more than one account is configured and `MAIL_ACCOUNT` does not name one of them.

Each account needs an email (`email` or `user`) and a way to log in (a password, or `auth`). `imap.host` is required unless `provider` fills it. `smtp` is optional; send tools fail for that account until it is set. OAuth2 needs `refreshToken`, `clientId`, and `clientSecret`, plus `tokenUrl` when the provider preset has none. `sendRateLimit` needs both `max` and `windowMs`. An identity needs `email`. At most one identity may set `default` to true.

`readOnly` together with `allowPermanentDelete` is rejected at startup.

### Top-level keys

| Key              | Type                                                         | Default                                                 | Required                     | Meaning                                                                                                           |
| ---------------- | ------------------------------------------------------------ | ------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `$schema`        | string                                                       | unset                                                   | no                           | JSON Schema URL. The loader ignores it.                                                                           |
| `defaultAccount` | string                                                       | the only account, or `MAIL_ACCOUNT` when that id exists | when several accounts remain | Account id used when a call omits `account`.                                                                      |
| `logLevel`       | `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent` | `info`                                                  | no                           | Stderr log level.                                                                                                 |
| `poolSize`       | integer 1–8                                                  | `2`                                                     | no                           | IMAP connections kept per account.                                                                                |
| `attachmentsDir` | string                                                       | unset                                                   | no                           | `mail_download_attachment` may only write inside this directory, and attachment `path` reads must stay inside it. |
| `limits`         | object                                                       | see below                                               | no                           | Defaults for every account. An account `limits` object overrides per key.                                         |
| `accounts`       | object of id → account                                       | unset                                                   | no                           | Account ids are the object keys.                                                                                  |

### Limits

Set on the root, on an account, or both. Account keys win. All values are positive integers.

| Key                  | Default           | Meaning                                                                                                                     |
| -------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `pageSize`           | 25                | Page size when a call omits `limit`.                                                                                        |
| `maxPageSize`        | 200               | Largest summary page. The effective cap is the lower of this and 200. Body pages are capped at 20 regardless.               |
| `maxBodyChars`       | 100000            | Text and HTML returned for one message.                                                                                     |
| `maxAttachmentBytes` | 15728640 (15 MiB) | Largest attachment returned or accepted.                                                                                    |
| `maxMessageBytes`    | 36700160 (35 MiB) | Largest raw message fetched or appended.                                                                                    |
| `maxSortCandidates`  | 5000              | Default and maximum for `maxPerFolder`. A folder that exceeds it is truncated and reports `omitted` and `scanned`.          |
| `maxBulk`            | 200               | Most UIDs in one bulk flag, move, or copy, and the most matches `mail_modify_by_search` will change when `dryRun` is false. |

### Accounts and provider presets

| Key                                            | Type                                                                            | Default           | Meaning                                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`                                     | `generic`, `gmail`, `microsoft`, `icloud`, `fastmail`, `yahoo`, `proton-bridge` | `generic`         | Fills IMAP and SMTP host, port, and `secure` when those fields are omitted, and the OAuth token URL for Gmail and Microsoft.             |
| `email`                                        | string                                                                          | `user`            | Mailbox address. Added to the identity list when missing.                                                                                |
| `user`                                         | string                                                                          | `email`           | IMAP and SMTP login name.                                                                                                                |
| `password`                                     | string                                                                          | unset             | Shorthand for `auth.type: "password"`.                                                                                                   |
| `auth`                                         | object                                                                          | password          | See Authentication.                                                                                                                      |
| `imap`, `smtp`                                 | object                                                                          | provider preset   | See Endpoints. SMTP may be omitted.                                                                                                      |
| `identities`                                   | array                                                                           | the account email | See Identities.                                                                                                                          |
| `readOnly`                                     | boolean                                                                         | false             | No mailbox or message changes and no send.                                                                                               |
| `allowSend`                                    | boolean                                                                         | true              | `false` blocks every SMTP submission.                                                                                                    |
| `allowDelete`                                  | boolean                                                                         | true              | `false` blocks delete, move, and mailbox deletion.                                                                                       |
| `allowPermanentDelete`                         | boolean                                                                         | false             | `true` allows expunge and permanent UID delete, and registers `mail_expunge_mailbox`.                                                    |
| `recipientDomainAllowList`                     | string array                                                                    | empty             | Empty allows every domain. Otherwise each SMTP recipient must match a listed domain or its subdomain. A leading `@` is stripped.         |
| `allowFromDomains`                             | string array                                                                    | empty             | Empty means From must be a configured identity. When set, any address at these domains is also allowed. This does not change TLS checks. |
| `sendRateLimit`                                | `{ max, windowMs }`                                                             | unset             | Sliding window of submissions for this process. `max` and `windowMs` are positive integers.                                              |
| `appendSent`                                   | `true`, `false`, `"auto"`                                                       | `"auto"`          | `true` always APPEND to Sent. `false` never does. `"auto"` skips Gmail, which stores Sent itself.                                        |
| `sentMailbox`, `trashMailbox`, `draftsMailbox` | string                                                                          | unset             | Override special-use resolution.                                                                                                         |
| `limits`                                       | partial limits object                                                           | the root limits   | Per-account caps.                                                                                                                        |

Provider hosts, ports, and notes: [docs/PROVIDERS.md](docs/PROVIDERS.md).

| Provider        | IMAP                                  | SMTP                                  |
| --------------- | ------------------------------------- | ------------------------------------- |
| `generic`       | host required, port 993, implicit TLS | host required, port 465, implicit TLS |
| `gmail`         | `imap.gmail.com:993`                  | `smtp.gmail.com:465`                  |
| `microsoft`     | `outlook.office365.com:993`           | `smtp.office365.com:587`, STARTTLS    |
| `icloud`        | `imap.mail.me.com:993`                | `smtp.mail.me.com:587`, STARTTLS      |
| `fastmail`      | `imap.fastmail.com:993`               | `smtp.fastmail.com:465`               |
| `yahoo`         | `imap.mail.yahoo.com:993`             | `smtp.mail.yahoo.com:465`             |
| `proton-bridge` | `127.0.0.1:1143`, STARTTLS            | `127.0.0.1:1025`, STARTTLS            |

### Endpoints (`imap` and `smtp`)

| Key           | Type                               | Default                                                       | Meaning                                                                                                                                                                                                                       |
| ------------- | ---------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`        | string                             | provider host                                                 | Name TLS verifies, unless `tls.servername` is set. Also the TCP host when `connectHost` is omitted.                                                                                                                           |
| `port`        | integer 1–65535                    | provider port, else 993 or 465 when `secure`, else 143 or 587 | Logical port. Also the TCP port when `connectPort` is omitted.                                                                                                                                                                |
| `connectHost` | string                             | `host`                                                        | TCP host when it differs, such as `127.0.0.1` for a tunnel. Certificate checks still use `host`.                                                                                                                              |
| `connectPort` | integer 1–65535                    | `port`                                                        | TCP port when it differs.                                                                                                                                                                                                     |
| `secure`      | boolean                            | provider value, else `true`                                   | `true` is implicit TLS (typically 993 or 465). `false` is cleartext that may upgrade with STARTTLS.                                                                                                                           |
| `starttls`    | `required`, `optional`, `disabled` | `disabled` when `secure` is true; otherwise `required`        | `required` refuses a server that does not offer STARTTLS. `optional` stays on cleartext when the server does not offer it and logs a warning. `disabled` is cleartext and must be explicit. `secure: true` forces `disabled`. |
| `timeoutMs`   | positive integer                   | 30000                                                         | Connect and command budget.                                                                                                                                                                                                   |
| `tls`         | object                             | verify on                                                     | See below.                                                                                                                                                                                                                    |

### TLS

| Key                      | Type    | Default | Meaning                                                                                                         |
| ------------------------ | ------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `tls.rejectUnauthorized` | boolean | `true`  | `false` skips certificate verification. Unsafe outside a trusted local bridge. A tunnel does not turn this off. |
| `tls.caFile`             | string  | unset   | PEM file with one or more extra CA certificates.                                                                |
| `tls.servername`         | string  | `host`  | SNI and certificate name when it should differ from `host`.                                                     |

The same TLS environment variables apply to both endpoints of the env-only account: `MAIL_TLS_REJECT_UNAUTHORIZED`, `MAIL_TLS_CA_FILE`, `MAIL_TLS_SERVERNAME`.

### Authentication

| `auth.type` | When it is chosen                                                | Required fields                                                                                                                                       |
| ----------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `password`  | Default. Also chosen when `password` is set and no token is set. | `auth.password` or the account-level `password`. Use an app password for iCloud, Gmail, Yahoo, and Fastmail.                                          |
| `xoauth2`   | `auth.accessToken` is set and `type` is omitted or `xoauth2`.    | `accessToken`, a bearer token you refresh yourself.                                                                                                   |
| `oauth2`    | `type` is `oauth2`, or `refreshToken` is set.                    | `refreshToken`, `clientId`, `clientSecret`. `tokenUrl` unless the provider preset supplies it (Gmail, Microsoft). Optional `scope` and `accessToken`. |

This server exchanges a refresh token. It does not run a browser login flow. Client ids are created in the provider's developer console.

### Identities

An identity is a From address for one mailbox. Several identities can share one account, for example an iCloud address and a custom domain that Apple sends from the same mailbox.

| Key       | Type    | Default                       | Meaning                                                                                                                       |
| --------- | ------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `id`      | string  | `identity-1`, `identity-2`, … | Stable id returned by `mail_list_accounts` and by send results.                                                               |
| `name`    | string  | unset                         | Display name.                                                                                                                 |
| `email`   | string  | required                      | Address. Compared case-insensitively.                                                                                         |
| `replyTo` | string  | unset                         | Reply-To stored for that identity.                                                                                            |
| `default` | boolean | false                         | The address used when a send omits `from`. Exactly one identity is default. If none is marked, the first becomes the default. |

The account `email` is appended when it is not already in the list. Send, reply, reply-all, forward, draft save, draft update, and draft send take an optional `from` (a string or `{ name, address }`) and an optional `replyTo`. An address that is not an identity is rejected unless `allowFromDomains` contains its domain. Replies and forwards pick an identity only when exactly one configured address appears verbatim in the original To or Cc. Zero matches and several matches both keep the default. Delivered-To and X-Original-To are not consulted. The result includes `identity` and `identityReason`: `explicit`, `single-match`, `default-no-match`, or `default-ambiguous`.

`MAIL_IDENTITIES` is a comma-separated list for the env account. Names are allowed (`Ada Lovelace <ada@example.com>`). Commas inside `<>` are not separators. The first entry is the default.

### Single-account environment

| Variable                                                                                                                   | Purpose                                                                          |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `MAIL_IMAP_HOST`, `MAIL_IMAP_PORT`, `MAIL_IMAP_SECURE`, `MAIL_IMAP_STARTTLS`, `MAIL_IMAP_TIMEOUT_MS`                       | IMAP endpoint.                                                                   |
| `MAIL_SMTP_HOST`, `MAIL_SMTP_PORT`, `MAIL_SMTP_SECURE`, `MAIL_SMTP_STARTTLS`, `MAIL_SMTP_TIMEOUT_MS`                       | SMTP endpoint.                                                                   |
| `MAIL_IMAP_CONNECT`, `MAIL_SMTP_CONNECT`                                                                                   | `host:port` or `[ipv6]:port`. Port required. Overrides the default account.      |
| `MAIL_USER`, `MAIL_PASSWORD`, `MAIL_FROM` or `MAIL_EMAIL`                                                                  | Login and the account email.                                                     |
| `MAIL_IDENTITIES`                                                                                                          | Extra From addresses for the env account.                                        |
| `MAIL_PROVIDER`                                                                                                            | Preset id.                                                                       |
| `MAIL_AUTH_TYPE`                                                                                                           | `password`, `xoauth2`, or `oauth2`.                                              |
| `MAIL_ACCESS_TOKEN`                                                                                                        | XOAUTH2 bearer token.                                                            |
| `MAIL_OAUTH_REFRESH_TOKEN`, `MAIL_OAUTH_CLIENT_ID`, `MAIL_OAUTH_CLIENT_SECRET`, `MAIL_OAUTH_TOKEN_URL`, `MAIL_OAUTH_SCOPE` | Refresh flow.                                                                    |
| `MAIL_READONLY`, `MAIL_ALLOW_SEND`, `MAIL_ALLOW_DELETE`, `MAIL_ALLOW_PERMANENT_DELETE`                                     | Booleans: `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`.                       |
| `MAIL_RECIPIENT_DOMAINS`, `MAIL_ALLOW_FROM_DOMAINS`                                                                        | Comma-separated domains.                                                         |
| `MAIL_SEND_RATE_MAX`, `MAIL_SEND_RATE_WINDOW_MS`                                                                           | Rate limit. Both are required together.                                          |
| `MAIL_APPEND_SENT`                                                                                                         | `true`, `false`, or `auto`.                                                      |
| `MAIL_TLS_REJECT_UNAUTHORIZED`, `MAIL_TLS_CA_FILE`, `MAIL_TLS_SERVERNAME`                                                  | TLS for both endpoints.                                                          |
| `MAIL_LOG_LEVEL`                                                                                                           | `trace` through `silent`.                                                        |
| `MAIL_POOL_SIZE`                                                                                                           | Connection pool size.                                                            |
| `MAIL_ACCOUNT`                                                                                                             | Account id when there is no file. Selects `defaultAccount` when a file omits it. |
| `MAIL_MCP_CONFIG`                                                                                                          | Config file path when `--config` is absent.                                      |
| `MAIL_HTTP_TOKEN`                                                                                                          | Required to listen on a non-loopback `--host`.                                   |

### Example

Three accounts. The iCloud mailbox sends as `user@icloud.com` and as `me@example.com`. Gmail uses OAuth. The work account is generic IMAP with STARTTLS submission and is read-only. Secrets come from the environment. The file is also [examples/config.jsonc](examples/config.jsonc).

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/koraykoska/mail-mcp/main/schema/config.schema.json",
  "defaultAccount": "icloud",
  "logLevel": "info",
  "poolSize": 2,
  "attachmentsDir": "${MAIL_ATTACHMENTS_DIR:-/home/me/mail-attachments}",
  "limits": {
    "pageSize": 25,
    "maxPageSize": 200,
    "maxBodyChars": 100000,
    "maxAttachmentBytes": 15728640,
    "maxMessageBytes": 36700160,
    "maxSortCandidates": 5000,
    "maxBulk": 200,
  },
  "accounts": {
    "icloud": {
      "provider": "icloud",
      "email": "user@icloud.com",
      "user": "user@icloud.com",
      "auth": {
        "type": "password",
        "password": "${ICLOUD_APP_PASSWORD}",
      },
      "identities": [
        {
          "id": "personal",
          "name": "User",
          "email": "user@icloud.com",
          "default": true,
        },
        {
          "id": "custom",
          "name": "User",
          "email": "me@example.com",
          "replyTo": "me@example.com",
        },
      ],
      "readOnly": false,
      "allowSend": true,
      "allowDelete": true,
      "allowPermanentDelete": false,
      "recipientDomainAllowList": ["icloud.com", "example.com"],
      "sendRateLimit": { "max": 20, "windowMs": 60000 },
      "appendSent": true,
    },
    "gmail": {
      "provider": "gmail",
      "email": "user@gmail.com",
      "user": "user@gmail.com",
      "auth": {
        "type": "oauth2",
        "refreshToken": "${GMAIL_REFRESH_TOKEN}",
        "clientId": "${GMAIL_CLIENT_ID}",
        "clientSecret": "${GMAIL_CLIENT_SECRET}",
      },
      "allowSend": true,
      "allowDelete": true,
      "allowPermanentDelete": false,
      "appendSent": "auto",
    },
    "work": {
      "provider": "generic",
      "email": "user@work.example",
      "user": "user@work.example",
      "password": "${WORK_IMAP_PASSWORD}",
      "imap": {
        "host": "imap.work.example",
        "port": 993,
        "secure": true,
        "timeoutMs": 30000,
        "tls": {
          "rejectUnauthorized": true,
          "caFile": "${WORK_CA_FILE:-/etc/ssl/certs/ca-certificates.crt}",
        },
      },
      "smtp": {
        "host": "smtp.work.example",
        "port": 587,
        "secure": false,
        "starttls": "required",
      },
      "readOnly": true,
      "allowSend": false,
      "allowDelete": false,
      "allowPermanentDelete": false,
    },
  },
}
```

## Connecting through a tunnel (manual connect address)

Some networks block outbound IMAP and SMTP. You can still reach the real servers by forwarding those ports through SSH to a small VM that is allowed to connect, while TLS keeps verifying the server's real hostname. The TCP socket opens to the local forward. SNI, the certificate check, and SMTP STARTTLS all use the logical host (`host`, or `tls.servername` when that is set). Certificate verification stays on. The SMTP EHLO name stays `mail-mcp` and is not rewritten to the tunnel address.

Forward iCloud IMAP and submission. `ssh -N` does not open a shell. The local ports are arbitrary; 1993 and 1587 stay off the privileged range:

```bash
ssh -N -L 1993:imap.mail.me.com:993 -L 1587:smtp.mail.me.com:587 user@vm
```

`autossh` restarts the forward when the SSH session drops. `-M 0` uses server-alive probes instead of a monitor port:

```bash
autossh -M 0 -N \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -L 1993:imap.mail.me.com:993 -L 1587:smtp.mail.me.com:587 \
  user@vm
```

A user systemd unit does the same job:

```ini
[Unit]
Description=Mail port forwards
After=network-online.target

[Service]
ExecStart=/usr/bin/ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 1993:imap.mail.me.com:993 -L 1587:smtp.mail.me.com:587 user@vm
Restart=on-failure

[Install]
WantedBy=default.target
```

Matching account. `provider: "icloud"` still supplies the logical hosts. Only the TCP address changes. With a provider preset you can set `connectHost` and `connectPort` and leave `host` and `port` unset:

```jsonc
{
  "accounts": {
    "icloud": {
      "provider": "icloud",
      "email": "user@icloud.com",
      "user": "user@icloud.com",
      "password": "${ICLOUD_APP_PASSWORD}",
      "imap": { "connectHost": "127.0.0.1", "connectPort": 1993 },
      "smtp": { "connectHost": "127.0.0.1", "connectPort": 1587 },
    },
  },
}
```

The same override for the default account, without editing the file:

```bash
export MAIL_IMAP_CONNECT=127.0.0.1:1993
export MAIL_SMTP_CONNECT=127.0.0.1:1587
mail-mcp --config /home/you/.config/mail-mcp.jsonc --check
```

CLI flags win over those variables. `--account` chooses which account they apply to; omitted, they apply to the default account. Other accounts keep the `connectHost` from the file.

```bash
mail-mcp --config /home/you/.config/mail-mcp.jsonc --account icloud \
  --imap-connect 127.0.0.1:1993 --smtp-connect 127.0.0.1:1587 --check
```

IPv6 literals must be bracketed: `MAIL_IMAP_CONNECT=[::1]:1993` or `--imap-connect "[2001:db8::1]:993"`. An unbracketed address with several colons is rejected, and a value with no port is rejected.

The same fields cover other cases where the dial address and the certificate name differ:

- A corporate proxy or jump host. Add `-J user@jump` (or `ProxyJump` in `~/.ssh/config`) to the `ssh -L` command. The mail config still dials `127.0.0.1` and verifies the real hostname.
- A staging server whose certificate uses the production name. Keep `host` as the name on the certificate and set `connectHost` to the staging address.
- An IPv6 literal on the far side of the forward, or as `connectHost` itself (`"::1"` in the file, `[::1]:1993` in the environment).

### What `--check` prints

`mail-mcp --check` and `mail_verify_connection` report the logical endpoint and the TCP target. `host` and `port` are what TLS verifies. `connectHost` and `connectPort` are where the socket connects. `servername` is the SNI name. When no override is set, `connectHost` equals `host` and `connectPort` equals `port`.

```json
{
  "ok": true,
  "account": "icloud",
  "imap": {
    "ok": true,
    "host": "imap.mail.me.com",
    "port": 993,
    "secure": true,
    "connectHost": "127.0.0.1",
    "connectPort": 1993,
    "servername": "imap.mail.me.com"
  },
  "smtp": {
    "ok": true,
    "host": "smtp.mail.me.com",
    "port": 587,
    "secure": false,
    "connectHost": "127.0.0.1",
    "connectPort": 1587,
    "servername": "smtp.mail.me.com"
  }
}
```

### Tunnel errors

| What you see                                    | What it means                                                                                                                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TLS_FAILED`, hostname mismatch                 | `host` is `127.0.0.1` or some other name that is not on the certificate. Put the certificate name in `host` (or `tls.servername`) and the forward in `connectHost` / `connectPort`. |
| `CONNECTION_FAILED` or a timeout                | Nothing is listening on the local port. The SSH session exited, or `-L` published a different port than `connectPort`.                                                              |
| `CONFIG_ERROR` about a port or brackets         | `MAIL_IMAP_CONNECT` / `--imap-connect` is missing `:port`, or an IPv6 literal is unbracketed. Use `[::1]:1993`.                                                                     |
| `AUTH_FAILED` while `connectHost` is the tunnel | The forward is up. The app password or OAuth token is wrong.                                                                                                                        |
| SMTP `TLS_FAILED` on port 587                   | `secure` is true, so the client speaks implicit TLS on a STARTTLS port. iCloud submission is `secure: false` with STARTTLS. The preset already does this.                           |
| `servername` equals `127.0.0.1`                 | `host` was set to the tunnel. TLS is verifying the wrong name.                                                                                                                      |

## Safety

Per account you can set `readOnly`, `allowSend`, `allowDelete`, `allowPermanentDelete` (off by default), a recipient domain allow-list, an extra From-domain list, and a send rate limit. Delete moves to Trash unless permanent delete is explicitly enabled. See [docs/SECURITY.md](docs/SECURITY.md).

## Providers

Presets: Gmail, Outlook / Microsoft 365, iCloud, Fastmail, Yahoo, Proton Bridge, and generic IMAP/SMTP. Password, app passwords, XOAUTH2 access tokens, and OAuth refresh tokens are supported. Details: [docs/PROVIDERS.md](docs/PROVIDERS.md).

## Troubleshooting

| Symptom                  | What to try                                                                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_FAILED`            | App password or OAuth, not the website password. `mail-mcp --check`.                                                                                                               |
| `TLS_FAILED`             | Implicit TLS vs STARTTLS. For a tunnel, compare `host` and `connectHost` in `--check`. Pin `tls.caFile`, or set `tls.rejectUnauthorized` to false only for a trusted local bridge. |
| `CAPABILITY_UNSUPPORTED` | `mail_get_capabilities`. SORT, THREAD, MOVE, and IDLE have fallbacks; Gmail labels and MODSEQ do not.                                                                              |
| `UIDVALIDITY_CHANGED`    | The folder was recreated. List it again.                                                                                                                                           |
| `CURSOR_INVALIDATED`     | The folder's UIDVALIDITY changed, or the cursor was reused with a different scope, sort, or page size. Start again without a cursor.                                               |
| `PERMISSION_DENIED`      | A safety switch blocked the call, or `from` is not a configured identity.                                                                                                          |
| `SIZE_LIMIT`             | Narrow the search, lower `limit`, or raise `limits` in the config. Summary pages cannot exceed 200.                                                                                |
| Empty SMTP send          | The account needs an `smtp` block or a provider preset that includes one.                                                                                                          |

## Development

```bash
npm ci
npm test
npm run check
```

Behavior that must stay true is listed under Principles in [CONTRIBUTING.md](CONTRIBUTING.md). See [docs/TESTING.md](docs/TESTING.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

MIT, copyright Koray Koska.
