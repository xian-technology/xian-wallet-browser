# QA Checklist

Use this checklist before cutting a meaningful wallet release or merging a
high-risk wallet change.

## Automated Gates

Run these from the repo root:

```bash
cd ../xian-js
npm install
npm run build

cd ../xian-wallet-browser
npm install
npm run validate
npx playwright install chromium
npm run test:browser --workspace xian-wallet-extension
npm run test:visual --workspace xian-wallet-extension
```

## Functional Smoke Pass

Use a clean browser profile and a local mock/devnet RPC when testing flows that
broadcast or prepare transactions.

- Create a new wallet with a recovery phrase and confirm the wallet unlocks.
- Import an existing wallet from a mnemonic and confirm the derived public key
  matches expectations.
- Reveal the recovery phrase with the correct password and verify the wrong
  password path fails clearly.
- Lock the wallet and confirm connected pages receive disconnect state.
- Unlock the wallet again and confirm connected pages receive restored
  connection state.
- Leave the wallet idle for more than 5 minutes and confirm it returns to the
  locked state on the next popup open or wallet action.
- Connect a new site and verify the approval window shows the correct site and
  chain summary.
- Reject a connect request and confirm the page receives a provider error.
- Close an approval window without acting and confirm the page receives an
  approval-dismissed error.
- Approve a sign-message request and confirm the payload summary is clear.
- Approve a send-call request against a mock/devnet RPC and confirm the page
  receives a submission with a tx hash.
- Disconnect a connected site and confirm later requests require a new connect
  approval.
- Add a custom network preset, switch to it, and confirm connected pages
  receive `chainChanged`.
- Remove a custom network preset and confirm the wallet falls back cleanly.
- Add a watched asset, verify it appears in the wallet, then remove it.
- Confirm the native `currency` asset cannot be removed.

## Restart And Persistence Checks

- With a connect or sign request pending, reload the extension service worker or
  restart the browser and confirm the approval can still be completed or
  dismissed.
- Confirm connected origins persist across popup closes.
- Confirm watched assets and network presets persist across browser restarts.

## Regression Notes

When a failure happens, record:

- commit SHA
- browser version
- test RPC or devnet endpoint
- exact step that failed
- screenshot or screen recording
- whether the issue reproduces after a fresh browser profile
