# Architecture

`xian-wallet-browser` owns the browser-wallet product line for Xian.

Current units:

- `@xian-tech/wallet-core`: wallet-domain logic for approvals, permissions,
  encrypted custody, recovery phrases, network presets, and durable
  provider-request handling
- `apps/wallet-extension`: the MV3 browser wallet app built on top of
  `@xian-tech/wallet-core`

External dependencies:

- `@xian-tech/client` from the sibling `xian-js` repo for network access and tx
  signing primitives
- `@xian-tech/provider` from the sibling `xian-js` repo for the injected-provider
  contract and provider error surface

Dependency direction:

- `apps/wallet-extension` depends on `@xian-tech/wallet-core` and `@xian-tech/provider`
- `@xian-tech/wallet-core` may depend on `@xian-tech/client` and `@xian-tech/provider`
- `@xian-tech/wallet-core` must stay UI-agnostic and must not depend on browser
  extension APIs

Design boundaries:

- browser-extension transport and DOM rendering stay in app-level code
- approval policy, permission enforcement, and custody state stay in
  `@xian-tech/wallet-core`
- the repo is browser-product-first, not a general SDK workspace
- if a future hosted wallet or PWA is built, it should live here as another app
