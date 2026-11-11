import { describe, expect, it } from "vitest";
import type { WalletDexSnapshot } from "@xian-tech/wallet-core";

import {
  buildDexQuote,
  minReceived,
  runtimeFixedFromString,
  sortedDexTokens,
  tokenSymbol
} from "./dex";

function snapshot(): WalletDexSnapshot {
  return {
    available: true,
    contract: "con_dex",
    pairsContract: "con_pairs",
    tradeFeeBps: 30,
    maxHops: 3,
    pairs: [
      {
        id: 1,
        token0: "currency",
        token1: "con_mid",
        reserve0: "1000",
        reserve1: "1000",
        totalSupply: "1000",
        blockTimestampLast: null,
        creationTime: null
      },
      {
        id: 2,
        token0: "con_mid",
        token1: "con_out",
        reserve0: "1000",
        reserve1: "1000",
        totalSupply: "1000",
        blockTimestampLast: null,
        creationTime: null
      },
      {
        id: 3,
        token0: "currency",
        token1: "con_out",
        reserve0: "1000",
        reserve1: "100",
        totalSupply: "100",
        blockTimestampLast: null,
        creationTime: null
      }
    ],
    tokens: [
      {
        contract: "con_out",
        name: "Output",
        symbol: "OUT",
        logoUrl: null,
        logoSvg: null,
        precision: 8,
        balance: "0",
        allowance: "0",
        feeOnTransfer: false
      },
      {
        contract: "currency",
        name: "Xian",
        symbol: "XIAN",
        logoUrl: null,
        logoSvg: null,
        precision: 8,
        balance: "10",
        allowance: "10",
        feeOnTransfer: false
      }
    ]
  };
}

describe("popup DEX helpers", () => {
  it("selects the best route across direct and multi-hop pools", () => {
    const quote = buildDexQuote(snapshot(), "currency", "con_out", "10");

    expect(quote?.path).toEqual([1, 2]);
    expect(Number(quote?.amountOut)).toBeGreaterThan(9);
    expect(Number(minReceived(quote!, 100))).toBeCloseTo(Number(quote!.amountOut) * 0.99);
  });

  it("sorts currency first and falls back to contract symbols", () => {
    const tokens = sortedDexTokens(snapshot());

    expect(tokens[0]?.contract).toBe("currency");
    expect(tokenSymbol(tokens[1])).toBe("OUT");
  });

  it("preserves all 30 decimal places and rejects unrepresentable amounts", () => {
    const exact = "9007199254740993.000000000000000000000000000001";
    expect(runtimeFixedFromString(exact)).toEqual({ __fixed__: exact });
    expect(runtimeFixedFromString("1e-31")).toBeNull();
    expect(runtimeFixedFromString("0.0000000000000000000000000000001")).toBeNull();
  });
});
