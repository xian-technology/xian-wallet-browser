# xian-wallet-browser

`xian-wallet-browser` is the browser-wallet product workspace for Xian.

It owns the reusable wallet domain layer plus concrete browser wallet apps. The
official JS / TS SDK still lives in the sibling `xian-js` repo.

## Scope

- `packages/wallet-core/`: reusable wallet-domain logic for custody, recovery,
  approvals, durable request state, and provider enforcement
- `apps/wallet-extension/`: the MV3 browser-extension wallet built on
  `@xian-tech/wallet-core`
- `docs/`: repo-local architecture notes and backlog

## Local Dependency Model

During local development this repo consumes `@xian-tech/client` and
`@xian-tech/provider` from the sibling `../xian-js` checkout.

That means the expected local layout is:

```text
.../xian/
  xian-js/
  xian-wallet-browser/
```

## Setup

Build the SDK workspace first so the local file dependencies are ready:

```bash
cd ../xian-js
npm install
npm run build
```

Then install and validate the wallet repo:

```bash
cd ../xian-wallet-browser
npm install
npm run validate
```

Browser-level wallet checks:

```bash
npx playwright install chromium
npm run test:browser --workspace xian-wallet-extension
npm run test:visual --workspace xian-wallet-extension
```

## Principles

- browser wallets are product code, not SDK examples
- provider and client contract changes should land in `xian-js`
- wallet UX, approvals, permissions, recovery, and storage live here
- keep extension transport and UI outside `@xian-tech/wallet-core`

## Release Model

- releases are tag-based, using `vX.Y.Z`
- versions are lockstepped inside this repo, but not across all JS repos
- `xian-js` and `xian-wallet-browser` release independently
- local development uses root `overrides` to point at sibling `xian-js`, while
  published artifacts resolve SDK dependencies from npm

## Related Repos

- `../xian-js`: official JS / TS SDK workspace
- `../xian-docs-web`: end-user and developer docs
- `../xian-meta/docs/XIAN_JS_SDK_MVP.md`: original JS SDK and wallet split note
- [docs/QA_CHECKLIST.md](docs/QA_CHECKLIST.md)
- [docs/UX_REVIEW.md](docs/UX_REVIEW.md)
- [docs/RELEASING.md](docs/RELEASING.md)
