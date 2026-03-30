# Architecture

`xian-wallet-browser` owns the browser-wallet product line for Xian.

Current units:

- `@xian/wallet-core`: wallet-domain logic for approvals, permissions,
  encrypted custody, recovery phrases, network presets, and durable
  provider-request handling
- `apps/wallet-extension`: the MV3 browser wallet app built on top of
  `@xian/wallet-core`

External dependencies:

- `@xian/client` from the sibling `xian-js` repo for network access and tx
  signing primitives
- `@xian/provider` from the sibling `xian-js` repo for the injected-provider
  contract and provider error surface

Dependency direction:

- `apps/wallet-extension` depends on `@xian/wallet-core` and `@xian/provider`
- `@xian/wallet-core` may depend on `@xian/client` and `@xian/provider`
- `@xian/wallet-core` must stay UI-agnostic and must not depend on browser
  extension APIs

Design boundaries:

- browser-extension transport and DOM rendering stay in app-level code
- approval policy, permission enforcement, and custody state stay in
  `@xian/wallet-core`
- the repo is browser-product-first, not a general SDK workspace
- if a future hosted wallet or PWA is built, it should live here as another app
