# Releasing

The package name is `@koraykoska/mail-mcp`. The executable name is `mail-mcp`. `npm pack` names the tarball `koraykoska-mail-mcp-<version>.tgz`. npm removes direct publishing with granular and bypass-2FA tokens in January 2027, so after the bootstrap this repository stages releases and does not store an npm token.

Publishing uses [staged publishing](https://docs.npmjs.com/staged-publishing/) (`npm stage publish`, npm CLI 11.15.0 or newer, Node.js 22.14 or newer). A maintainer approves the stage with 2FA (`npm stage approve <stage-id>` or the Staged Packages tab on npmjs.com) before the version is installable. Pre-release versions (`1.2.0-rc.1`) are staged with the `next` dist-tag. Other versions use `latest`.

Trusted publishing (OIDC, `id-token: write`) can be configured only after the package exists. Configure it on the scoped package page for `@koraykoska/mail-mcp`, not on an unscoped name. `npm stage publish` is allowed for a trusted publisher by default. This workflow requests only that action. It does not allow direct `npm publish`. Provenance is requested with `--provenance` and is also generated automatically for a public package published from this public repository through trusted publishing.

## v0.0.1 is the manual bootstrap

`0.0.1` is not published by GitHub Actions. Koray publishes it once from a checkout of the commit whose `package.json` version is `0.0.1`:

1. `npm login` on an account that can create `@koraykoska/mail-mcp`, with 2FA enabled.
2. Build the same tree the tests ran, or download the `package-tarball` artifact from the CI workflow for that commit and check it with `sha256sum -c koraykoska-mail-mcp.sha256`.
3. `npm publish koraykoska-mail-mcp-0.0.1.tgz --access public`
4. On the scoped package page for `@koraykoska/mail-mcp`, add a trusted publisher:
   - GitHub Actions
   - Organization or user: `koraykoska`
   - Repository: `mail-mcp`
   - Workflow filename: `release.yml` (the filename only, with the extension)
   - Allowed actions: stage publish (`npm stage publish`). Do not enable direct `npm publish`.
5. The new trusted publisher must complete its first successful publish within 2 days or the configuration expires.
6. Set Publishing access to **Require two-factor authentication and disallow tokens**.

There is no `NPM_TOKEN` secret. Do not create one.

## v0.1.0 is the first tag-triggered release

After the trusted publisher exists on the `@koraykoska/mail-mcp` package page:

1. Bump `package.json` from `0.0.1` to `0.1.0` on `main`. The Release workflow's `workflow_dispatch` bump can commit that change and push the branch. It does not create or push the tag.
2. On that commit, tag locally and push the tag with credentials that can start Actions: `git tag v0.1.0` then `git push origin v0.1.0`. A `GITHUB_TOKEN` push does not start the tag workflow, so the bump job never pushes the tag.
3. The tag workflow runs the full CI workflow first. Only after that passes does it stage the tarball CI packed, with `npm stage publish <tarball> --access public --provenance --tag latest`.
4. The job summary prints the stage id and the approve commands. The GitHub Release is created as a draft.
5. Approve the stage with 2FA. Then publish the GitHub Release draft.

If OIDC is not configured yet, the stage job fails and points back at the v0.0.1 bootstrap. It does not fall back to a token.

Later versions repeat the v0.1.0 path: bump the version on the default branch, tag `vX.Y.Z` locally so it matches `package.json`, push that tag, and approve the stage.

`workflow_dispatch` only bumps the version, updates `CHANGELOG.md`, commits, and pushes the branch. It prints the `git tag` and `git push origin vX.Y.Z` commands and stops there. It does not stage or publish. The tag workflow does that after CI passes.
