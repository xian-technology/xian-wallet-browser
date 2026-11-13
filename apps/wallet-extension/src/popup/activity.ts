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

/** Shown for a transaction that ran out of its exactly estimated chi. */
export const OUT_OF_CHI_MESSAGE =
  "Out of chi: the chain state changed since the estimate. Review the transaction and try again.";

function failureText(result: unknown): string | null {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  const message = record.error ?? record.message ?? record.result ?? null;
  if (typeof message === "string") return message;
  try {
    return JSON.stringify(result);
  } catch {
    return null;
  }
}

/** The user-facing text of a transaction failure result, or null if it has none. */
export function failureMessage(result: unknown): string | null {
  const text = failureText(result);
  // Wallets supply exactly the simulated chi, so running out of it means the
  // state moved between the estimate and execution.
  return text !== null && /out of chi/i.test(text) ? OUT_OF_CHI_MESSAGE : text;
}

/** The message for a failed transaction, or null when it did not fail. */
export function failedActivityMessage(tx: ActivityTx): string | null {
  return tx.success ? null : failureMessage(tx.result);
}
