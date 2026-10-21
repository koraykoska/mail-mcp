# Configuration

The key-by-key reference, the multi-account example, and the tunnel setup are in the [README](../README.md#configuration). This page is the same rules in shorter form. The JSON Schema is [`schema/config.schema.json`](../schema/config.schema.json).

Accounts come from environment variables, a JSON/JSONC file, or both. A file is selected with `--config path` or `MAIL_MCP_CONFIG`. `--config` wins. When no file is loaded, `MAIL_ACCOUNT` is the account id (otherwise `default`). When a file is loaded, environment account variables are applied only if `MAIL_IMAP_HOST` is also set, and they merge into the account id `default` only. A file `defaultAccount` wins over `MAIL_ACCOUNT`. `MAIL_LOG_LEVEL` and `MAIL_POOL_SIZE` apply only when the file omits those keys. `--log-level` wins over both.

`MAIL_IMAP_CONNECT` and `MAIL_SMTP_CONNECT` (`host:port` or `[ipv6]:port`) replace the TCP address of the default account after the file is resolved. `--imap-connect` and `--smtp-connect` then replace the TCP address of `--account`, or of the default account. Other accounts keep their own `connectHost`. TLS still verifies `host`.

The file may contain `//` and `/* */` comments and trailing commas. Strings may contain `${VAR}` and `${VAR:-default}`. `$${` is an escape that becomes `${`. A missing variable without a default is a startup error that names the variable. `$schema` is optional and ignored by the loader.

## File shape

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/koraykoska/mail-mcp/main/schema/config.schema.json",
  "defaultAccount": "work",
  "logLevel": "info",
  "poolSize": 2,
  "attachmentsDir": "/home/me/mail-attachments",
  "limits": {
    "pageSize": 25,
    "maxPageSize": 200,
    "maxBodyChars": 100000,
    "maxAttachmentBytes": 15728640,
    "maxMessageBytes": 36700160,
    "maxSortCandidates": 5000,
    "maxBulk": 200,
    "bulkBudgetMs": 20000,
  },
  "accounts": {
    "work": {
      "provider": "gmail",
      "email": "ada@example.com",
      "user": "ada@example.com",
      "auth": {
        "type": "oauth2",
        "refreshToken": "${GMAIL_REFRESH_TOKEN}",
        "clientId": "${GMAIL_CLIENT_ID}",
        "clientSecret": "${GMAIL_CLIENT_SECRET}",
      },
      "readOnly": false,
      "allowSend": true,
      "allowDelete": true,
      "allowPermanentDelete": false,
      "recipientDomainAllowList": ["example.com"],
      "allowFromDomains": [],
      "sendRateLimit": { "max": 30, "windowMs": 60000 },
      "appendSent": "auto",
      "identities": [{ "email": "ada@example.com", "name": "Ada", "default": true }],
    },
  },
}
```

A complete three-account file (iCloud with two identities, Gmail, generic IMAP) is [examples/config.jsonc](../examples/config.jsonc). `provider` fills `imap` and `smtp` when those blocks are omitted. See [PROVIDERS.md](PROVIDERS.md).

## Connection fields

| Field                        | Meaning                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`, `port`               | Logical server address. This is the name TLS verifies.                                                                                                                                                                                                                                                                       |
| `connectHost`, `connectPort` | TCP address when it differs, such as a local SSH forward. Certificate checks still use `host`.                                                                                                                                                                                                                               |
| `secure`                     | `true` for implicit TLS (typically 993 or 465).                                                                                                                                                                                                                                                                              |
| `starttls`                   | `required` (default when `secure` is false), `optional`, or `disabled`. `optional` stays on cleartext when the server does not offer STARTTLS. `disabled` is cleartext and must be explicit. `secure: true` forces `disabled`. The process logs a warning when `optional` is set and when `tls.rejectUnauthorized` is false. |
| `timeoutMs`                  | Connect and command budget, default 30000.                                                                                                                                                                                                                                                                                   |
| `tls.rejectUnauthorized`     | Default `true`. `false` skips certificate checks. Unsafe except for a local bridge you trust. A tunnel does not turn this off.                                                                                                                                                                                               |
| `tls.caFile`                 | PEM file of extra CAs.                                                                                                                                                                                                                                                                                                       |
| `tls.servername`             | SNI / certificate name when it differs from `host`.                                                                                                                                                                                                                                                                          |

## Authentication

| `auth.type`          | Required fields                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `password` (default) | `password`, or the account-level `password` shorthand. Use an app password where the provider requires one. |
| `xoauth2`            | `accessToken` (a bearer token you refresh yourself)                                                         |
| `oauth2`             | `refreshToken`, `clientId`, `clientSecret`, and `tokenUrl` unless the provider preset supplies it           |

A top-level `password` is shorthand for password auth.

## Identities

`identities` is a list of `{ id?, name?, email, replyTo?, default? }` for one mailbox. The account email is added when it is missing. Exactly one identity is default; if none is marked, the first becomes the default. Send and draft tools take `from` and `replyTo`. An unknown address is rejected unless `allowFromDomains` lists its domain. Custom `headers` are an allow-list (`X-*`, `List-Unsubscribe`, `List-Unsubscribe-Post`, `Auto-Submitted`, `Precedence`, `Importance`, `Keywords`, `Comments`); address headers belong in the structured fields. When `replyTo` is omitted, the identity's `replyTo` is used, including a draft that has none of its own. Replies pick an identity only when exactly one configured address appears verbatim in To or Cc. `MAIL_IDENTITIES` sets the list for the env account (`Name <addr@example.com>`, commas inside `<>` are not separators).

## Safety

| Field                                          | Default  | Effect                                                                                                                           |
| ---------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `readOnly`                                     | false    | No mailbox or message changes, no send.                                                                                          |
| `allowSend`                                    | true     | `false` blocks every SMTP submission tool.                                                                                       |
| `allowDelete`                                  | true     | `false` blocks delete, move, and mailbox deletion.                                                                               |
| `allowPermanentDelete`                         | false    | `true` allows expunge and permanent UID delete, and registers `mail_expunge_mailbox`.                                            |
| `recipientDomainAllowList`                     | empty    | Empty allows every domain. Otherwise recipients must match a listed domain or its subdomain.                                     |
| `allowFromDomains`                             | empty    | Empty means From must be a configured identity. When set, any address at these domains is also allowed. TLS checks stay enabled. |
| `sendRateLimit`                                | unset    | Sliding window, `max` messages per `windowMs`.                                                                                   |
| `appendSent`                                   | `"auto"` | `true` always APPEND to Sent, `false` never, `"auto"` skips Gmail.                                                               |
| `sentMailbox`, `trashMailbox`, `draftsMailbox` | unset    | Override special-use resolution.                                                                                                 |
| `attachmentsDir`                               | unset    | Required for `savePath` writes and attachment `path` reads. Both must stay inside this directory.                                |

`readOnly` together with `allowPermanentDelete` is rejected at startup.

## Limits

| Key                  | Default  |
| -------------------- | -------- |
| `pageSize`           | 25       |
| `maxPageSize`        | 200      |
| `maxBodyChars`       | 100000   |
| `maxAttachmentBytes` | 15728640 |
| `maxMessageBytes`    | 36700160 |
| `maxSortCandidates`  | 5000     |
| `maxBulk`            | 200      |
| `bulkBudgetMs`       | 20000    |

Account `limits` override the root object per key. Summary pages cannot exceed the lower of `maxPageSize` and 200. Pages that include bodies are capped at 20. `bulkBudgetMs` is the wall-clock budget for one bulk flag, copy, move, delete, label, or modify-by-search call. The call stops between chunks of 25 and returns `complete`, `remaining`, and `stopped`. The maximum is 50000, so the call finishes inside a 60 second request limit. Pass `remaining` back with the same action to continue. A move without MOVE expunges only UIDs confirmed by UIDPLUS `COPYUID`.

## Folder scope

Folder scope is a tool argument, not a config key. List and search tools default to one mailbox (`INBOX` when `mailbox` is omitted). `mail_get_thread` with no `folders` uses the seed mailbox, INBOX, Sent, Archive, and All, and leaves Junk and Trash out. A Message-ID seed and a mailbox plus uid seed of the same message use that same scope. After the thread is closed, both seeds report the same `excludedMatches` list, in mailbox path order. The id set is every id the walk discovered, including every Message-ID of the items, every id they cite in In-Reply-To or References, the seed's own ids, and every id that appears only on an out-of-scope message, followed transitively. A selectable folder outside the scope is listed when one of its messages has a Message-ID, In-Reply-To, or References token in that set. A folder in the scope is never listed. A Message-ID whose only exact copy is in Junk or Trash is walked in both directions from that copy's Message-ID, In-Reply-To, and References, so an in-scope parent and an in-scope reply are returned and the Junk or Trash copy stays in `excludedMatches`. If nothing in scope matches, the items are empty and `excludedMatches` still names that folder; naming it in `folders` opens it. Out-of-scope folders are not fetched in full. Each one is a UID SEARCH for Message-ID, In-Reply-To, and References, in batches of eight ids, and only the hits are fetched. An empty mailbox is not searched. When more than eight mailboxes are out of scope, the searches share the pooled session and two extra connections. A header walk starts from the earliest id the seed already names and may search those folders again as new ids appear. It stops after 8 searches per round. The default of 4 rounds is 32 searches, and maxRounds raises that ceiling up to 8 rounds (64 searches). The first page freezes truncated, rounds, and excludedMatches. The stored folder list is at most 500 entries; excludedMatchesTruncated is true when the list was cut. Later pages reuse those values. The account timeout still bounds the whole call. `folders: "all"` skips Trash and Junk unless they are named or `includeTrash` / `includeJunk` is set.

## Single-account environment

| Variable                                                                                                                   | Purpose                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `MAIL_IMAP_HOST`, `MAIL_IMAP_PORT`, `MAIL_IMAP_SECURE`, `MAIL_IMAP_STARTTLS`, `MAIL_IMAP_TIMEOUT_MS`                       | IMAP endpoint                                                                             |
| `MAIL_SMTP_HOST`, `MAIL_SMTP_PORT`, `MAIL_SMTP_SECURE`, `MAIL_SMTP_STARTTLS`, `MAIL_SMTP_TIMEOUT_MS`                       | SMTP endpoint                                                                             |
| `MAIL_IMAP_CONNECT`, `MAIL_SMTP_CONNECT`                                                                                   | TCP `host:port` or `[ipv6]:port` for the default account                                  |
| `MAIL_USER`, `MAIL_PASSWORD`, `MAIL_FROM` or `MAIL_EMAIL`                                                                  | Login and identity                                                                        |
| `MAIL_IDENTITIES`                                                                                                          | Comma-separated From addresses for the env account                                        |
| `MAIL_PROVIDER`                                                                                                            | Preset id                                                                                 |
| `MAIL_AUTH_TYPE`                                                                                                           | `password`, `xoauth2`, or `oauth2`                                                        |
| `MAIL_ACCESS_TOKEN`                                                                                                        | XOAUTH2 bearer token                                                                      |
| `MAIL_OAUTH_REFRESH_TOKEN`, `MAIL_OAUTH_CLIENT_ID`, `MAIL_OAUTH_CLIENT_SECRET`, `MAIL_OAUTH_TOKEN_URL`, `MAIL_OAUTH_SCOPE` | Refresh flow                                                                              |
| `MAIL_READONLY`, `MAIL_ALLOW_SEND`, `MAIL_ALLOW_DELETE`, `MAIL_ALLOW_PERMANENT_DELETE`                                     | Booleans (`true`/`false`/`1`/`0`)                                                         |
| `MAIL_RECIPIENT_DOMAINS`, `MAIL_ALLOW_FROM_DOMAINS`                                                                        | Comma-separated domains                                                                   |
| `MAIL_SEND_RATE_MAX`, `MAIL_SEND_RATE_WINDOW_MS`                                                                           | Rate limit                                                                                |
| `MAIL_APPEND_SENT`                                                                                                         | `true`, `false`, or `auto`                                                                |
| `MAIL_TLS_REJECT_UNAUTHORIZED`, `MAIL_TLS_CA_FILE`, `MAIL_TLS_SERVERNAME`                                                  | TLS                                                                                       |
| `MAIL_LOG_LEVEL`                                                                                                           | `trace` through `silent`                                                                  |
| `MAIL_POOL_SIZE`                                                                                                           | Connection pool size                                                                      |
| `MAIL_ACCOUNT`                                                                                                             | Account id when there is no file. Selects the default when a file omits `defaultAccount`. |
| `MAIL_MCP_CONFIG`                                                                                                          | File path when `--config` is absent                                                       |

## MCP client snippet

Any client that launches a local stdio server can use:

```json
{
  "mcpServers": {
    "mail": {
      "command": "mail-mcp",
      "env": {
        "MAIL_IMAP_HOST": "imap.example.com",
        "MAIL_SMTP_HOST": "smtp.example.com",
        "MAIL_USER": "you@example.com",
        "MAIL_PASSWORD": "app-password"
      }
    }
  }
}
```

`npx -y @koraykoska/mail-mcp` or `bunx --bun @koraykoska/mail-mcp` can replace a global `mail-mcp` install. Add `--config` and the file path to `args` when you use a file. Node.js 22 or newer is required unless Bun is the runtime.
