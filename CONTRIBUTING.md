# Contributing

## Principles

Losing a mail is worse than showing one twice.

A message that has no Message-ID is never merged with another message. Pagination never skips a message: if the last row of a page was expunged, the next page continues at the first row that sorts after it, even when that means a later reader can see a row twice. When identity is uncertain, return more and say so.

Related rules:

- Results are deterministic. They depend only on the server state and the arguments of the call.
- There is no stateful "changed since" tracking.
- Heuristics such as subject threading are off unless the caller opts in, and every result says how it was linked.
- TLS certificate verification is never disabled to make a connection succeed. A tunnel changes the TCP address, not the name that is verified.

## Setup

Node.js 22 or newer, npm, and Docker (only for integration tests). Bun is optional and is used in CI and in `scripts/pack-smoke.mjs bun`.

```bash
npm ci
npm run check
```

## Commits

Use a normal feature branch. The repository history is authored as Koray Koska `<koray@koska.family>`.

## Package name

The published name is `@koraykoska/mail-mcp`. The executable stays `mail-mcp`, from `"bin"."mail-mcp"`. Install it with `npx -y @koraykoska/mail-mcp` or `bunx @koraykoska/mail-mcp`. `npm pack` writes `koraykoska-mail-mcp-<version>.tgz`. Stage a release with `npm stage publish <tarball> --access public --provenance`.

## Release

See `docs/RELEASING.md`. Short version:

`0.0.1` is the manual bootstrap. `npm login`, then `npm publish koraykoska-mail-mcp-0.0.1.tgz --access public`, then configure the trusted publisher on the `@koraykoska/mail-mcp` package page (owner `koraykoska`, repository `mail-mcp`, workflow filename `release.yml`, stage publish allowed). That configuration must complete its first CI publish within 2 days. Then set **Require two-factor authentication and disallow tokens**. There is no `NPM_TOKEN`.

`0.1.0` is the first tag-triggered trusted-publishing release. Bump the version on `main`, tag `v0.1.0` locally, push that tag, and approve the staged version the workflow prints. Later tags follow that same path. `workflow_dispatch` only bumps, commits, and pushes the branch. It does not push the tag.

## Docs

`docs/TOOLS.md` is generated. After changing a tool, run `npm run docs:tools`. `schema/config.schema.json` is generated from the zod config schema. After changing that schema, run `npx tsx scripts/generate-config-schema.ts`. The unit suite checks that the file matches.
