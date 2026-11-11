import { fixed } from "@xian-tech/client";
import {
  minimumAmountOutV2,
  selectBestXianDexV2ExactInRoute,
} from "@xian-tech/dex";

import type {
  WalletDexSnapshot,
  WalletDexTokenInfo
} from "@xian-tech/wallet-core";

export const DEX_ROUTER = "con_dex";
export const DEFAULT_SLIPPAGE_BPS = 100;
export const DEFAULT_DEADLINE_MINUTES = 20;

export interface XianDatetime {
  __time__: [number, number, number, number, number, number, number];
}

export type DexQuote = NonNullable<ReturnType<typeof selectBestXianDexV2ExactInRoute>>;

export function runtimeFixedFromString(value: string): ReturnType<typeof fixed> | null {
  try {
    const amount = fixed(value.trim().replace(",", "."));
    return amount.__fixed__.startsWith("-") ? null : amount;
  } catch {
    return null;
  }
}

export function buildDexQuote(
  snapshot: WalletDexSnapshot,
  fromToken: string,
  toToken: string,
  amountIn: string
): DexQuote | null {
  if (!snapshot.available || fromToken === toToken) return null;
  const precisions = new Map(snapshot.tokens.map(token => [token.contract, token.precision]));
  return selectBestXianDexV2ExactInRoute({
    pairs: snapshot.pairs.map(pair => ({
      ...pair,
      precision0: precisions.get(pair.token0),
      precision1: precisions.get(pair.token1),
    })),
    fromToken,
    toToken,
    amountIn,
    feeBps: snapshot.tradeFeeBps,
    maxHops: Math.max(1, snapshot.maxHops),
  });
}

export function tokenByContract(
  snapshot: WalletDexSnapshot | null,
  contract: string
): WalletDexTokenInfo | null {
  return snapshot?.tokens.find((token) => token.contract === contract) ?? null;
}

export function sortedDexTokens(
  snapshot: WalletDexSnapshot | null
): WalletDexTokenInfo[] {
  if (!snapshot) {
    return [];
  }
  return [...snapshot.tokens].sort((a, b) => {
    if (a.contract === "currency") return -1;
    if (b.contract === "currency") return 1;
    return tokenSymbol(a).localeCompare(tokenSymbol(b));
  });
}

export function tokenSymbol(token: WalletDexTokenInfo | null | undefined): string {
  return token?.symbol?.trim() || token?.contract.slice(0, 8).toUpperCase() || "";
}

export function minReceived(quote: DexQuote, slippageBps: number): string {
  return minimumAmountOutV2(quote.amountOut, slippageBps, quote.outputPrecision);
}

export function blockedIntermediateToken(
  snapshot: WalletDexSnapshot,
  quote: DexQuote
): string | null {
  const intermediateTokens = quote.hops.slice(0, -1).map((hop) => hop.toToken);
  return (
    intermediateTokens.find(
      (contract) => tokenByContract(snapshot, contract)?.feeOnTransfer === true
    ) ?? null
  );
}

export function useSupportingFeeRoute(
  snapshot: WalletDexSnapshot,
  quote: DexQuote
): boolean {
  const first = quote.hops[0];
  const last = quote.hops[quote.hops.length - 1];
  if (!first || !last) {
    return false;
  }
  return (
    tokenByContract(snapshot, first.fromToken)?.feeOnTransfer === true ||
    tokenByContract(snapshot, last.toToken)?.feeOnTransfer === true
  );
}

export function deadlineFromNow(minutesFromNow: number): XianDatetime {
  const d = new Date(Date.now() + minutesFromNow * 60_000);
  return {
    __time__: [
      d.getUTCFullYear(),
      d.getUTCMonth() + 1,
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds() * 1000
    ]
  };
}
