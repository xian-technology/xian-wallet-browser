# Packages

This folder contains the publishable packages of the browser-wallet
workspace.

## Contents

- `wallet-core/`: `@xian-tech/wallet-core` — UI-agnostic wallet domain logic
  for custody, recovery, approvals, durable request state, and provider
  enforcement.

## Notes

- Keep wallet-core transport- and UI-agnostic. MV3 background / content /
  popup code belongs in `../apps/wallet-extension/`.

## Next

- Start with [`wallet-core/README.md`](wallet-core/README.md).
