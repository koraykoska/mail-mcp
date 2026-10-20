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

If the registry rejects that name, switch to the scoped package with one edit: set `"name"` in `package.json` to `@koraykoska/mail-mcp`. Leave `"bin"."mail-mcp"` as `./dist/cli.js`. Publish with `npm publish --access public`. Clients then install `@koraykoska/mail-mcp`; the executable name stays `mail-mcp`. The release workflow reads the name from `package.json`, so it does not need a second change.

## Release

Tag `vX.Y.Z` matching `package.json`. The release workflow runs the full verification again and, only if it passes, publishes to npm with provenance. Pre-release tags such as `v1.2.0-rc.1` publish under the `next` dist-tag. The workflow needs the `NPM_TOKEN` repository secret (automation token with publish rights). Trusted publishing with GitHub OIDC can replace that secret later; the workflow already requests `id-token: write`.

`npm run release -- patch|minor|major|prerelease` bumps the version, updates `CHANGELOG.md`, commits, tags, and pushes. Pushing the tag starts the publish workflow.

## Docs

`docs/TOOLS.md` is generated. After changing a tool, run `npm run docs:tools`.
