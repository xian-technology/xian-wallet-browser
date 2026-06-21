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

## Shared Agent Practices
- Keep changes clean, modular, and professional. Prefer small, cohesive modules, clear naming, explicit boundaries, and tests over quick patches.
- When code behavior, public APIs, user workflows, operator workflows, or configuration semantics change, check whether `../xian-docs-web` needs corresponding documentation updates. If this repo is `xian-docs-web`, update the relevant published docs in place. Write durable user/developer documentation, not a changelog entry.
- For any non-trivial code change, update the local graph before final verification when `graphify-out/graph.json` exists. Run `graphify update .` from the repo root, or `graphify update . --force` when deletions or refactors intentionally shrink the graph.
- After updating the graph, check cross-repo impact before finishing: query the local `graphify-out/graph.json`, inspect paths with `graphify path` or `graphify explain`, and note any affected sibling repos.
- If graphify or dependency analysis shows affected sibling repos, update those repos in the same change when the impact is real and the fix is in scope.
- Treat `graphify-out/` as a generated local artifact. Do not commit it.
