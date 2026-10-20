# Testing

```bash
npm test                 # unit + integration
npm run test:unit
npm run test:integration
npm run test:coverage    # unit + integration, with line and branch thresholds on src
npm run build && npm run test:e2e
npm run check            # format, lint, types, docs, coverage, build, e2e, pack smoke
```

Integration tests need GreenMail on ports 3143 (IMAP), 3993 (IMAPS), 3025 (SMTP), and 3465 (SMTPS), and Dovecot on 1143 (STARTTLS), 1993 (IMAPS), 2143 (no UIDPLUS), and 2144 (no IDLE). `test/support/greenmail.ts` and `test/support/dovecot.ts` reuse a server that is already listening. Set `MAIL_IT_IMAP_HOST` or `MAIL_DOVECOT_HOST` to point at those ports without the Docker CLI. Otherwise the helpers start `greenmail/standalone:2.1.14` and the image in `docker/dovecot`. GreenMail's user is `user`, password `secret`, address `user@example.com`. Dovecot uses the same password, user `user`, and the certificate in `test/fixtures/certs`.

The scripted IMAP tests do not start GreenMail. They cover authentication failure, a refused SEARCH, a server without MOVE or UIDPLUS, and a UIDVALIDITY change. GreenMail covers a smaller capability set. Dovecot covers THREAD, SORT, ESEARCH, CONDSTORE, QRESYNC, NAMESPACE, ID, SPECIAL-USE, and real STARTTLS, including the UIDPLUS-less and IDLE-less variants.

End-to-end tests spawn the built server over stdio. `node scripts/pack-smoke.mjs node` runs the packed `mail-mcp` command through `npx`, a global install, and the symlink shim. `node scripts/pack-smoke.mjs bun` runs `bunx @koraykoska/mail-mcp`. The packed file is `koraykoska-mail-mcp-<version>.tgz`. Each path prints the version, completes MCP initialize, and calls `mail_list_accounts`.

Fixtures in `test/fixtures/messages.ts` include multipart/mixed, multipart/alternative with encoded words, `message/rfc822`, a calendar part, an S/MIME signed wrapper, and a body whose charset is unknown.
