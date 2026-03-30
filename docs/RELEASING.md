# Releasing

`xian-wallet-browser` follows the same high-level release model as `xian-py`:

- validation runs on pushes and pull requests
- publishing happens only from a git tag
- the release tag format is `vX.Y.Z`

## Version Policy

`xian-wallet-browser` is versioned at the repo level.

That means:

- the repo tag is `vX.Y.Z`
- the repo root version must be `X.Y.Z`
- `@xian-tech/wallet-core` must be `X.Y.Z`
- `apps/wallet-extension/package.json` must also carry `X.Y.Z`

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

1. If needed, release `xian-js` first.
2. Update `package.json`, `packages/wallet-core/package.json`, and
   `apps/wallet-extension/package.json` to the intended release version.
3. If the wallet depends on a newer SDK release, update
   `packages/wallet-core/package.json` and `apps/wallet-extension/package.json`
   to the new `@xian-tech/client` or `@xian-tech/provider` versions.
4. Run `npm install`.
5. Run `npm run validate`.
6. Run `npm run test:visual --workspace xian-wallet-extension`.
7. Commit the release version changes.
8. Create and push a tag in the form `vX.Y.Z`.

## What The Release Workflow Does

On `v*` tags, GitHub Actions will:

1. check out both `xian-wallet-browser` and sibling `xian-js`
2. build `xian-js`
3. validate `xian-wallet-browser`
4. verify that repo versions match the tag
5. pack `@xian-tech/wallet-core`
6. archive the built extension bundle as a release asset
7. publish `@xian-tech/wallet-core` to npm with trusted publishing
8. create a GitHub release from the same tag

## Notes

- Do not tag from a dirty tree.
- npm trusted publishing must be configured for `@xian-tech/wallet-core`.
- The extension itself is not published to npm; it is attached to the GitHub
  release as a zip artifact.
