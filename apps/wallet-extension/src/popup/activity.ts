import type { ActivityTx } from "./tx-classify";

export function normalizedActivityTxHash(hash: string): string {
  return hash.trim().toUpperCase();
}

export function activityTxTimestampMillis(tx: ActivityTx): number {
  const raw = tx.created_at ?? tx.block_time;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (raw > 1e15) {
      return Math.floor(raw / 1_000_000);
    }
    return raw > 1e12 ? raw : raw * 1000;
  }
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

export function mergeActivityTxs(
  indexedTxs: ActivityTx[],
  localTxs: ActivityTx[]
): ActivityTx[] {
  const indexedHashes = new Set(
    indexedTxs.map((tx) => normalizedActivityTxHash(tx.tx_hash))
  );
  const seenLocalHashes = new Set<string>();
  const dedupedLocalTxs = localTxs.filter((tx) => {
    const txHash = normalizedActivityTxHash(tx.tx_hash);
    if (indexedHashes.has(txHash) || seenLocalHashes.has(txHash)) {
      return false;
    }
    seenLocalHashes.add(txHash);
    return true;
  });
  return [...dedupedLocalTxs, ...indexedTxs].sort(
    (left, right) =>
      activityTxTimestampMillis(right) - activityTxTimestampMillis(left)
  );
}

export function isLocalUnindexedTx(tx: ActivityTx): boolean {
  return tx.local === true && tx.block_height == null;
}

export function activityHasTx(txs: ActivityTx[], hash: string): boolean {
  const expectedHash = normalizedActivityTxHash(hash);
  return txs.some(
    (tx) => normalizedActivityTxHash(tx.tx_hash) === expectedHash
  );
}
