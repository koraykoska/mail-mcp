# Releasing

The package name is the unscoped `mail-mcp`. The executable name is also `mail-mcp`. npm removes direct publishing with granular and bypass-2FA tokens in January 2027, so this repository never runs `npm publish` and does not store an npm token.

Publishing uses [staged publishing](https://docs.npmjs.com/staged-publishing/) (`npm stage publish`, npm CLI 11.15.0 or newer, Node.js 22.14 or newer). A maintainer approves the stage with 2FA (`npm stage approve <stage-id>` or the Staged Packages tab on npmjs.com) before the version is installable. Pre-release versions (`1.2.0-rc.1`) are staged with the `next` dist-tag. Other versions use `latest`.

Trusted publishing (OIDC, `id-token: write`) can be configured only after the package exists. `npm stage publish` is allowed for a trusted publisher by default. This workflow requests only that action. It does not allow direct `npm publish`. Provenance is requested with `--provenance` and is also generated automatically for a public package published from this public repository through trusted publishing.

## v0.0.1 is the manual bootstrap

`0.0.1` is not published by GitHub Actions. Koray publishes it once from a checkout of the commit whose `package.json` version is `0.0.1`:

1. `npm login` on an account that can create the package, with 2FA enabled.
2. Build the same tree the tests ran, or download the `package-tarball` artifact from the CI workflow for that commit and check it with `sha256sum -c mail-mcp.sha256`.
3. `npm stage publish mail-mcp-0.0.1.tgz --access public`
4. Approve with 2FA: `npm stage approve <stage-id>`, or the Staged Packages tab on npmjs.com. Staging a package that does not exist yet also publishes a public placeholder `0.0.0-stage`. The `0.0.1` bytes stay hidden until approval.
5. On npmjs.com, open `mail-mcp` settings and add a trusted publisher:
   - GitHub Actions
   - Organization or user: `koraykoska`
   - Repository: `mail-mcp`
   - Workflow filename: `release.yml` (the filename only, with the extension)
   - Allowed actions: stage publish (`npm stage publish`). Do not enable direct `npm publish`.
6. The new trusted publisher must complete its first successful publish within 2 days or the configuration expires.
7. Set Publishing access to **Require two-factor authentication and disallow tokens**.

There is no `NPM_TOKEN` secret. Do not create one.

## v0.1.0 is the first tag-triggered release

After the trusted publisher exists:

1. Bump `package.json` from `0.0.1` to `0.1.0` (locally, or with the Release workflow's `workflow_dispatch` bump, which only commits and tags).
2. Tag `v0.1.0` and push the tag. A push made with `GITHUB_TOKEN` does not start another workflow, so push the tag with credentials that trigger Actions.
3. The tag workflow runs the full CI workflow first. Only after that passes does it stage the tarball CI packed, with `npm stage publish <tarball> --access public --provenance --tag latest`.
4. The job summary prints the stage id and the approve commands. The GitHub Release is created as a draft.
5. Approve the stage with 2FA. Then publish the GitHub Release draft.

If OIDC is not configured yet, the stage job fails and points back at the v0.0.1 bootstrap. It does not fall back to a token.

Later versions repeat the v0.1.0 path: bump, tag `vX.Y.Z` matching `package.json`, push the tag, approve the stage.

`workflow_dispatch` only bumps the version, updates `CHANGELOG.md`, commits, tags, and pushes. It does not stage or publish. The tag workflow does that after CI passes.
