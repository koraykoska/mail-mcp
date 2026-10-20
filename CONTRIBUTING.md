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

The published name is the unscoped package `mail-mcp`, and the executable is also `mail-mcp`, so `npx -y mail-mcp` and `bunx mail-mcp` work.

If the registry rejects that name, switch to the scoped package with one edit: set `"name"` in `package.json` to `@koraykoska/mail-mcp`. Leave `"bin"."mail-mcp"` as `./dist/cli.js`. Stage it with `npm stage publish --access public`. Clients then install `@koraykoska/mail-mcp`; the executable name stays `mail-mcp`. The release workflow reads the name from `package.json`, so it does not need a second change.

## Release

See `docs/RELEASING.md`. Short version:

`0.0.1` is the manual bootstrap. `npm login`, then `npm stage publish --access public` of the tested tarball, approve with 2FA, then configure the trusted publisher on npmjs.com (owner `koraykoska`, repository `mail-mcp`, workflow filename `release.yml`, stage publish allowed). That configuration must complete its first CI publish within 2 days. Then set **Require two-factor authentication and disallow tokens**. There is no `NPM_TOKEN`.

`0.1.0` is the first tag-triggered trusted-publishing release. Bump the version, tag `v0.1.0`, push the tag, and approve the staged version the workflow prints. Later tags follow that same path. `workflow_dispatch` only bumps, commits, and tags.

## Docs

`docs/TOOLS.md` is generated. After changing a tool, run `npm run docs:tools`.
