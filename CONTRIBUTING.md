# Contributing

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

`docs/TOOLS.md` is generated. After changing a tool, run `npm run docs:tools`.
