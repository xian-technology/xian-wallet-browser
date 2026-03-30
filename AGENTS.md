# Repository Guidelines

## Scope
- `xian-wallet-browser` owns the browser-wallet product surface for Xian.
- Keep user-facing wallet UX, extension transport, permissions, recovery flows,
  and durable approval handling in this repo.
- Treat `../xian-js` as the source of truth for `@xian-tech/client` and
  `@xian-tech/provider`.

## Project Layout
- `packages/wallet-core/`: wallet-domain logic shared by browser wallet apps.
- `apps/wallet-extension/`: MV3 extension app that injects `window.xian` and
  renders popup and approval flows.
- `docs/ARCHITECTURE.md`: wallet-repo dependency boundaries.
- `docs/BACKLOG.md`: product follow-up work for the browser wallet line.

## Workflow
- When provider or client contracts change, update `../xian-js` alongside this
  repo instead of forking behavior locally.
- Keep `@xian-tech/wallet-core` UI-agnostic. Extension transport, popup rendering,
  and browser APIs stay in app-level code.
- Prefer explicit network presets, permission prompts, and approval summaries
  over hidden behavior.

## Validation
- Build the sibling SDK first when local file dependencies have changed:
  `cd ../xian-js && npm install && npm run build`
- Install dependencies with `npm install`.
- Type-check with `npm run typecheck`.
- Build packages and apps with `npm run build`.
- Run unit tests with `npm run test`.
- Run browser-level checks with
  `npm run test:browser --workspace xian-wallet-extension`.
- Run visual regression captures with
  `npm run test:visual --workspace xian-wallet-extension`.
