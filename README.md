# mail-mcp

IMAP and SMTP mail client as a [Model Context Protocol](https://modelcontextprotocol.io) server. An MCP client can list mailboxes, search and read messages, change flags, manage folders and drafts, and send mail over the same accounts a desktop client would use.

The package name on npm is `@koraykoska/mail-mcp`. The executable is `mail-mcp`.

```bash
npx -y @koraykoska/mail-mcp --help
bunx @koraykoska/mail-mcp --help
mail-mcp --version
```

## Quick start

One account from the environment, stdio transport:

```bash
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
      "args": ["--config", "/home/you/.config/mail-mcp.json"]
    }
  }
}
```

## What you can do

Forty-one tools cover accounts, server capabilities, namespaces, quota, and ID; mailbox list, tree, status, create, rename, delete, subscribe; message list, search, fetch, raw source, headers, MIME parts, attachments, and threads; flags, copy, move, delete, expunge, append, Gmail labels, and bulk updates; drafts; SMTP send, reply, forward, and draft send; and IDLE (with a polling fallback).

Every tool takes an optional `account`. Results are paged. Mutating tools carry MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).

Full argument lists: [docs/TOOLS.md](docs/TOOLS.md).

## Safety

Per account you can set `readOnly`, `allowSend`, `allowDelete`, `allowPermanentDelete` (off by default), a recipient domain allow-list, and a send rate limit. Delete moves to Trash unless permanent delete is explicitly enabled. See [docs/SECURITY.md](docs/SECURITY.md) and [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Providers

Presets: Gmail, Outlook / Microsoft 365, iCloud, Fastmail, Yahoo, Proton Bridge, and generic IMAP/SMTP. Password, XOAUTH2 access tokens, and OAuth refresh tokens are supported. Details: [docs/PROVIDERS.md](docs/PROVIDERS.md).

## Troubleshooting

| Symptom                  | What to try                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `AUTH_FAILED`            | App password or OAuth, not the website password. `mail-mcp --check`.                                                  |
| `TLS_FAILED`             | Implicit TLS vs STARTTLS. Pin `tls.caFile`, or set `tls.rejectUnauthorized` to false only for a trusted local bridge. |
| `CAPABILITY_UNSUPPORTED` | `mail_get_capabilities`. SORT, THREAD, MOVE, and IDLE have fallbacks; Gmail labels and MODSEQ do not.                 |
| `UIDVALIDITY_CHANGED`    | The folder was recreated. List it again.                                                                              |
| `PERMISSION_DENIED`      | A safety switch blocked the call.                                                                                     |
| `SIZE_LIMIT`             | Narrow the search, lower `limit`, or raise `limits` in the config.                                                    |
| Empty SMTP send          | The account needs an `smtp` block or a provider preset that includes one.                                             |

## Development

```bash
npm ci
npm test
npm run check
```

See [docs/TESTING.md](docs/TESTING.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT, copyright Koray Koska.
