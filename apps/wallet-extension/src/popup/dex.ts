import type {
  WalletDexPairInfo,
  WalletDexSnapshot,
  WalletDexTokenInfo
} from "@xian-tech/wallet-core";

export const DEX_ROUTER = "con_dex";
export const DEFAULT_SLIPPAGE_BPS = 100;
export const DEFAULT_DEADLINE_MINUTES = 20;

export interface XianDatetime {
  __time__: [number, number, number, number, number, number, number];
}

export interface RuntimeFixed {
  __fixed__: string;
}

export interface DexQuoteHop {
  pairId: number;
  fromToken: string;
  toToken: string;
  reserveIn: number;
  reserveOut: number;
  amountIn: number;
  amountOut: number;
}

export interface DexQuote {
  amountIn: number;
  amountOut: number;
  hops: DexQuoteHop[];
  path: number[];
  feeBps: number;
  priceImpact: number;
  midPriceOut: number;
}

interface AdjEdge {
  pairId: number;
  other: string;
  reserveSelf: number;
  reserveOther: number;
}

interface CandidatePath {
  pairIds: number[];
  tokens: string[];
  edges: AdjEdge[];
}

function amountOut(
  amountIn: number,
  reserveIn: number,
  reserveOut: number,
  feeBps: number
): number {
  if (amountIn <= 0 || reserveIn <= 0 || reserveOut <= 0) {
    return 0;
  }
  const inWithFee = amountIn * ((10000 - feeBps) / 10000);
  return (inWithFee * reserveOut) / (reserveIn + inWithFee);
}

function normalizeDecimalText(value: string): string | null {
  const trimmed = value.trim().replace(",", ".");
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) {
    return null;
  }
  const [integerPart = "0", fractionPart = ""] = trimmed.split(".");
  const integer = integerPart.replace(/^0+(?=\d)/, "") || "0";
  const fraction = fractionPart.replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer;
}

function formatFixedNumber(value: number, options: { floor?: boolean } = {}): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("DEX amount must be a finite non-negative number");
  }
  const precision = 12;
  const factor = 10 ** precision;
  const normalized = options.floor
    ? Math.floor(value * factor) / factor
    : value;
  const text = normalized.toLocaleString("en-US", {
    useGrouping: false,
    minimumFractionDigits: 0,
    maximumFractionDigits: precision
  });
  return normalizeDecimalText(text) ?? "0";
}

export function runtimeFixedFromNumber(
  value: number,
  options: { floor?: boolean } = {}
): RuntimeFixed {
  return { __fixed__: formatFixedNumber(value, options) };
}

export function runtimeFixedFromString(value: string): RuntimeFixed | null {
  const normalized = normalizeDecimalText(value);
  if (!normalized || !Number.isFinite(Number(normalized))) {
    return null;
  }
  return { __fixed__: normalized };
}

function buildAdjacency(pairs: WalletDexPairInfo[]): Map<string, AdjEdge[]> {
  const adj = new Map<string, AdjEdge[]>();
  const push = (token: string, edge: AdjEdge) => {
    const list = adj.get(token);
    if (list) {
      list.push(edge);
    } else {
      adj.set(token, [edge]);
    }
  };

  for (const pair of pairs) {
    if (pair.reserve0 <= 0 || pair.reserve1 <= 0) {
      continue;
    }
    push(pair.token0, {
      pairId: pair.id,
      other: pair.token1,
      reserveSelf: pair.reserve0,
      reserveOther: pair.reserve1
    });
    push(pair.token1, {
      pairId: pair.id,
      other: pair.token0,
      reserveSelf: pair.reserve1,
      reserveOther: pair.reserve0
    });
  }
  return adj;
}

function enumeratePaths(
  adj: Map<string, AdjEdge[]>,
  from: string,
  to: string,
  maxHops: number
): CandidatePath[] {
  const out: CandidatePath[] = [];
  const visited = new Set<string>([from]);
  const usedPairs = new Set<number>();

  function dfs(current: string, path: CandidatePath) {
    if (path.pairIds.length > 0 && current === to) {
      out.push({
        pairIds: [...path.pairIds],
        tokens: [...path.tokens],
        edges: [...path.edges]
      });
      return;
    }
    if (path.pairIds.length >= maxHops) {
      return;
    }
    const edges = adj.get(current);
    if (!edges) {
      return;
    }
    for (const edge of edges) {
      if (usedPairs.has(edge.pairId)) {
        continue;
      }
      if (visited.has(edge.other) && edge.other !== to) {
        continue;
      }
      usedPairs.add(edge.pairId);
      visited.add(edge.other);
      path.pairIds.push(edge.pairId);
      path.tokens.push(edge.other);
      path.edges.push(edge);
      dfs(edge.other, path);
      path.pairIds.pop();
      path.tokens.pop();
      path.edges.pop();
      usedPairs.delete(edge.pairId);
      if (edge.other !== to) {
        visited.delete(edge.other);
      }
    }
  }

  dfs(from, { pairIds: [], tokens: [from], edges: [] });
  return out;
}

function quotePath(
  candidate: CandidatePath,
  amountInValue: number,
  feeBps: number
): { amountOut: number; hops: DexQuoteHop[]; midPrice: number } {
  let current = amountInValue;
  let mid = 1;
  const hops: DexQuoteHop[] = [];
  for (let i = 0; i < candidate.edges.length; i++) {
    const edge = candidate.edges[i]!;
    const fromToken = candidate.tokens[i]!;
    const toToken = candidate.tokens[i + 1]!;
    const out = amountOut(current, edge.reserveSelf, edge.reserveOther, feeBps);
    if (out <= 0) {
      return { amountOut: 0, hops: [], midPrice: 0 };
    }
    hops.push({
      pairId: edge.pairId,
      fromToken,
      toToken,
      reserveIn: edge.reserveSelf,
      reserveOut: edge.reserveOther,
      amountIn: current,
      amountOut: out
    });
    mid *= edge.reserveOther / edge.reserveSelf;
    current = out;
  }
  return { amountOut: current, hops, midPrice: mid };
}

export function buildDexQuote(
  snapshot: WalletDexSnapshot,
  fromToken: string,
  toToken: string,
  amountInValue: number
): DexQuote | null {
  if (!snapshot.available || amountInValue <= 0 || fromToken === toToken) {
    return null;
  }

  const adj = buildAdjacency(snapshot.pairs);
  const paths = enumeratePaths(
    adj,
    fromToken,
    toToken,
    Math.max(1, snapshot.maxHops)
  );
  let best: DexQuote | null = null;
  for (const candidate of paths) {
    const { amountOut: out, hops, midPrice } = quotePath(
      candidate,
      amountInValue,
      snapshot.tradeFeeBps
    );
    if (out <= 0) {
      continue;
    }
    const executionPrice = out / amountInValue;
    const priceImpact =
      midPrice > 0 ? Math.max(0, 1 - executionPrice / midPrice) : 0;
    const quote: DexQuote = {
      amountIn: amountInValue,
      amountOut: out,
      hops,
      path: candidate.pairIds,
      feeBps: snapshot.tradeFeeBps,
      priceImpact,
      midPriceOut: midPrice
    };
    if (!best || quote.amountOut > best.amountOut) {
      best = quote;
    }
  }
  return best;
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

export function minReceived(quote: DexQuote, slippageBps: number): number {
  return quote.amountOut * (1 - slippageBps / 10000);
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
