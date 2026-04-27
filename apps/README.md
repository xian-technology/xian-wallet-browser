# Apps

This folder contains user-facing browser wallet applications built on top of
`@xian-tech/wallet-core`.

Current apps:

- `wallet-extension/`: the Manifest V3 Xian browser wallet app

```mermaid
flowchart LR
  WalletCore["@xian-tech/wallet-core"] --> Extension["wallet-extension"]
  Extension --> Browser["Browser extension runtime"]
  Extension --> Provider["Injected Xian provider"]
```
