# Testing

```bash
npm test                 # unit + integration
npm run test:unit
npm run test:integration
npm run test:coverage    # unit + integration, 90% line threshold on src
npm run build && npm run test:e2e
npm run check            # format, lint, types, docs, coverage, build, e2e, pack smoke
```

Integration tests need a GreenMail container on ports 3143 (IMAP), 3993 (IMAPS), 3025 (SMTP), and 3465 (SMTPS). `test/support/greenmail.ts` reuses a server that is already listening. Otherwise it runs `greenmail/standalone:2.1.3` with user `user`, password `secret`, address `user@example.com`.

In CI the workflow sets `MAIL_IT_IMAP_HOST=127.0.0.1` and publishes those ports from a service container. The tests then wait for the port instead of starting Docker themselves. No external mailbox accounts are required.

A scripted IMAP server in `test/support/scripted-imap.ts` covers authentication failure, a server without MOVE or UIDPLUS, and a UIDVALIDITY change. GreenMail covers the real protocol, including implicit TLS with the default self-signed certificate (rejected unless `tls.rejectUnauthorized` is false).

End-to-end tests spawn `dist/cli.js` over stdio, list tools, and call `mail_list_accounts`. `npm run smoke:pack` installs the `npm pack` tarball and repeats a handshake under Node. `node scripts/pack-smoke.mjs bun` does the same with Bun.

Fixtures in `test/fixtures/messages.ts` include multipart/mixed, multipart/alternative with encoded words, `message/rfc822`, a calendar part, an S/MIME signed wrapper, and a body whose charset is unknown.
