# Wallet Extension App

This app is the current production-oriented Manifest V3 wallet foundation for
Xian. It is built on top of `@xian-tech/provider` and `@xian-tech/wallet-core`.

The extension lives in the `xian-wallet-browser` repo and consumes
`@xian-tech/provider` from the sibling `xian-js` checkout during local development.

It includes:

- an injected `window.xian` provider
- a background worker that keeps key custody away from the page
- versioned extension storage with migration handling
- encrypted private-key and recovery-phrase storage in `chrome.storage.local`
- five-minute unlocked session persistence in `chrome.storage.session` so MV3
  worker suspension does not immediately relock the wallet
- a popup split into overview, connected-app, and security workflows
- an approval window that leads with structured summaries and warnings before
  exposing raw payloads
- durable request and approval tracking so approval flows survive MV3
  service-worker suspension

## Build

From the repo root:

```bash
cd ../xian-js
npm install
npm run build

cd ../xian-wallet-browser
npm install
npm run build --workspace xian-wallet-extension
```

For browser-level wallet checks:

```bash
npx playwright install chromium
npm run test:browser --workspace xian-wallet-extension
npm run test:visual --workspace xian-wallet-extension
```

The unpacked extension output is written to:

```bash
apps/wallet-extension/dist
```

## Load In Chrome Or Chromium

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select `apps/wallet-extension/dist`

## Current Scope

This is the real wallet app foundation, but it is not a finished production
wallet yet.

It currently supports:

- wallet creation and import from a private-key seed or BIP39 recovery phrase
- recovery-phrase reveal with password confirmation
- password-based encryption for local persistence
- shielded `state_snapshot` storage, direct export/removal, and inclusion in
  encrypted wallet backup exports
- built-in and custom network presets with active-network switching
- configured-chain tracking with ready, unreachable, and mismatch states
- per-origin connect permissions
- provider methods for wallet info, asset watching, tx preparation, signing,
  sending, and intent-based send calls
- a reusable wallet controller in `@xian-tech/wallet-core` so future wallet UIs can
  share custody and approval logic

It does not yet include:

- hardware wallets
- transaction history and portfolio views

## Manual Review

- use [../../docs/QA_CHECKLIST.md](../../docs/QA_CHECKLIST.md) for release-path
  functional checks
- use [../../docs/UX_REVIEW.md](../../docs/UX_REVIEW.md) for task-based flow and
  interface review before shipping meaningful UX changes
