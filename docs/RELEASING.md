# Releasing

`xian-wallet-browser` follows the same high-level release model as `xian-py`:

- validation runs on pushes and pull requests
- publishing happens only from a git tag
- the release tag format is `vX.Y.Z`, with optional `alpha.N`, `beta.N`, or
  `rc.N` prerelease suffixes
- `release-manifest.json` pins every sibling build input by commit SHA and
  source-package version

## Version Policy

`xian-wallet-browser` is versioned at the repo level.

That means:

- the repo tag is `vX.Y.Z`
- the repo root version must be `X.Y.Z`
- `@xian-tech/wallet-core` must be `X.Y.Z`
- `apps/wallet-extension/package.json` must also carry `X.Y.Z`
- `apps/wallet-extension/public/manifest.json` must carry `X.Y.Z` in
  `version_name` and its deterministic four-part Chrome encoding in `version`

This repo is not lockstepped with `xian-js`.

- `xian-js` and `xian-wallet-browser` release independently
- `@xian-tech/client` and `@xian-tech/provider` are pinned intentionally in
  `packages/wallet-core/package.json`
- when the wallet needs a newer SDK release, update those dependency versions
  explicitly after `xian-js` has published them

## Local Development Vs Release Resolution

For local development, the root `package.json` uses `overrides` so this repo
consumes `@xian-tech/client` and `@xian-tech/provider` from the sibling `../xian-js`
checkout.

For published artifacts, the package manifests resolve those dependencies
normally through npm.

## Tag Workflow

1. If needed, release `xian-js` and its compiler dependency first.
2. Update `package.json`, `packages/wallet-core/package.json`, and
   `apps/wallet-extension/package.json` to the intended release version.
   Update `apps/wallet-extension/public/manifest.json` to the same version.
3. If the wallet depends on a newer SDK release, update
   `packages/wallet-core/package.json` and `apps/wallet-extension/package.json`
   to the new `@xian-tech/client` or `@xian-tech/provider` versions.
4. Update `release-manifest.json` with the exact released `xian-js` and
   `xian-contracting` commits. Every declared package version must match the
   pinned source and the lockfile that consumes it.
5. Run `npm install` and commit the resulting `package-lock.json` update.
6. Run `node scripts/release-context.mjs validate-manifest`.
7. Run `npm ci`, `npm audit --audit-level=critical --omit=dev`, and
   `npm run validate`.
8. Run `npm run test:browser --workspace xian-wallet-extension`.
9. Run `npm run test:visual --workspace xian-wallet-extension`.
10. Commit the release version and manifest changes from a clean tree.
11. Create and push a tag in the form `vX.Y.Z`.

## What The Release Workflow Does

On an accepted release tag, GitHub Actions will:

1. resolve the tag and trigger to one clean immutable wallet source SHA
2. check out the SDK and compiler sources at their manifest commit SHAs
3. verify repo, package, Chrome-manifest, lockfile, and sibling-source versions
4. install locked dependencies, audit, and run unit, browser, and visual gates
5. pack `@xian-tech/wallet-core` and archive the validated extension bundle
6. inspect and upload immutable release artifacts
7. publish only the downloaded wallet-core tarball with trusted publishing
8. create a GitHub release from the same tag and artifacts

## Notes

- Do not tag from a dirty tree.
- Do not use moving or unversioned sibling source for a wallet release. The
  pinned SDK package versions must be the versions consumers install from npm.
- npm trusted publishing must be configured for `@xian-tech/wallet-core`.
- The extension itself is not published to npm; it is attached to the GitHub
  release as a zip artifact.
