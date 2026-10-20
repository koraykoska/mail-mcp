# Configuration

Accounts come from environment variables, a JSON/JSONC file, or both. A file is selected with `--config path` or `MAIL_MCP_CONFIG`. When a file is loaded, environment account variables are applied only if `MAIL_IMAP_HOST` is also set; they merge into the account id `default`.

The file may contain `//` and `/* */` comments and trailing commas. Strings may contain `${VAR}` and `${VAR:-default}`. `$${` is an escape that becomes `${`. A missing variable without a default is a startup error that names the variable.

## File shape

```jsonc
{
  "defaultAccount": "work",
  "logLevel": "info",
  "poolSize": 2,
  "attachmentsDir": "/home/me/mail-attachments",
  "limits": {
    "pageSize": 25,
    "maxPageSize": 100,
    "maxBodyChars": 100000,
    "maxAttachmentBytes": 15728640,
    "maxMessageBytes": 36700160,
    "maxSortCandidates": 5000,
    "maxBulk": 200,
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
      "sendRateLimit": { "max": 30, "windowMs": 60000 },
      "appendSent": "auto",
      "identities": [{ "email": "ada@example.com", "name": "Ada", "default": true }],
    },
  },
}
```

`provider` fills `imap` and `smtp` when those blocks are omitted. See `docs/PROVIDERS.md`.

## Connection fields

| Field                    | Meaning                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `host`, `port`           | Server address.                                                                                                       |
| `secure`                 | `true` for implicit TLS (typically 993 or 465).                                                                       |
| `starttls`               | `required` (default when `secure` is false), `optional`, or `disabled`. `disabled` is cleartext and must be explicit. |
| `timeoutMs`              | Connect and command budget, default 30000.                                                                            |
| `tls.rejectUnauthorized` | Default `true`. `false` skips certificate checks. Unsafe except for a local bridge you trust.                         |
| `tls.caFile`             | PEM file of extra CAs.                                                                                                |
| `tls.servername`         | SNI / certificate name when it differs from `host`.                                                                   |

## Authentication

| `auth.type`          | Required fields                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `password` (default) | `password`, or the account-level `password` shorthand                                             |
| `xoauth2`            | `accessToken` (a bearer token you refresh yourself)                                               |
| `oauth2`             | `refreshToken`, `clientId`, `clientSecret`, and `tokenUrl` unless the provider preset supplies it |

A top-level `password` is shorthand for password auth.

## Safety

| Field                                          | Default  | Effect                                                                                       |
| ---------------------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `readOnly`                                     | false    | No mailbox or message changes, no send.                                                      |
| `allowSend`                                    | true     | `false` blocks every SMTP submission tool.                                                   |
| `allowDelete`                                  | true     | `false` blocks delete, move, and mailbox deletion.                                           |
| `allowPermanentDelete`                         | false    | `true` allows expunge and permanent UID delete.                                              |
| `recipientDomainAllowList`                     | empty    | Empty allows every domain. Otherwise recipients must match a listed domain or its subdomain. |
| `sendRateLimit`                                | unset    | Sliding window, `max` messages per `windowMs`.                                               |
| `appendSent`                                   | `"auto"` | `true` always APPEND to Sent, `false` never, `"auto"` skips Gmail.                           |
| `sentMailbox`, `trashMailbox`, `draftsMailbox` | unset    | Override special-use resolution.                                                             |
| `attachmentsDir`                               | unset    | When set, `savePath` must stay inside this directory.                                        |

`readOnly` together with `allowPermanentDelete` is rejected at startup.

## Single-account environment

| Variable                                                                                                                   | Purpose                                        |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `MAIL_IMAP_HOST`, `MAIL_IMAP_PORT`, `MAIL_IMAP_SECURE`, `MAIL_IMAP_STARTTLS`, `MAIL_IMAP_TIMEOUT_MS`                       | IMAP endpoint                                  |
| `MAIL_SMTP_HOST`, `MAIL_SMTP_PORT`, `MAIL_SMTP_SECURE`, `MAIL_SMTP_STARTTLS`, `MAIL_SMTP_TIMEOUT_MS`                       | SMTP endpoint                                  |
| `MAIL_USER`, `MAIL_PASSWORD`, `MAIL_FROM` or `MAIL_EMAIL`                                                                  | Login and identity                             |
| `MAIL_PROVIDER`                                                                                                            | Preset id                                      |
| `MAIL_AUTH_TYPE`                                                                                                           | `password`, `xoauth2`, or `oauth2`             |
| `MAIL_ACCESS_TOKEN`                                                                                                        | XOAUTH2 bearer token                           |
| `MAIL_OAUTH_REFRESH_TOKEN`, `MAIL_OAUTH_CLIENT_ID`, `MAIL_OAUTH_CLIENT_SECRET`, `MAIL_OAUTH_TOKEN_URL`, `MAIL_OAUTH_SCOPE` | Refresh flow                                   |
| `MAIL_READONLY`, `MAIL_ALLOW_SEND`, `MAIL_ALLOW_DELETE`, `MAIL_ALLOW_PERMANENT_DELETE`                                     | Booleans (`true`/`false`/`1`/`0`)              |
| `MAIL_RECIPIENT_DOMAINS`                                                                                                   | Comma-separated domains                        |
| `MAIL_SEND_RATE_MAX`, `MAIL_SEND_RATE_WINDOW_MS`                                                                           | Rate limit                                     |
| `MAIL_APPEND_SENT`                                                                                                         | `true`, `false`, or `auto`                     |
| `MAIL_TLS_REJECT_UNAUTHORIZED`, `MAIL_TLS_CA_FILE`, `MAIL_TLS_SERVERNAME`                                                  | TLS                                            |
| `MAIL_LOG_LEVEL`                                                                                                           | `trace` through `silent`                       |
| `MAIL_POOL_SIZE`                                                                                                           | Connection pool size                           |
| `MAIL_ACCOUNT`                                                                                                             | Default account id when a file defines several |

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

`npx -y mail-mcp` or `bunx mail-mcp` can replace a global `mail-mcp` install. Add `--config` and the file path to `args` when you use a file.
