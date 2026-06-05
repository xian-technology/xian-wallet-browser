import { describe, expect, it } from "vitest";
import type { WalletDexSnapshot } from "@xian-tech/wallet-core";

import {
  buildDexQuote,
  minReceived,
  runtimeFixedFromNumber,
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
        reserve0: 1000,
        reserve1: 1000,
        totalSupply: 1000,
        blockTimestampLast: null,
        creationTime: null
      },
      {
        id: 2,
        token0: "con_mid",
        token1: "con_out",
        reserve0: 1000,
        reserve1: 1000,
        totalSupply: 1000,
        blockTimestampLast: null,
        creationTime: null
      },
      {
        id: 3,
        token0: "currency",
        token1: "con_out",
        reserve0: 1000,
        reserve1: 100,
        totalSupply: 100,
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
        balance: 0,
        allowance: 0,
        feeOnTransfer: false
      },
      {
        contract: "currency",
        name: "Xian",
        symbol: "XIAN",
        logoUrl: null,
        logoSvg: null,
        precision: 8,
        balance: 10,
        allowance: 10,
        feeOnTransfer: false
      }
    ]
  };
}

describe("popup DEX helpers", () => {
  it("selects the best route across direct and multi-hop pools", () => {
    const quote = buildDexQuote(snapshot(), "currency", "con_out", 10);

    expect(quote?.path).toEqual([1, 2]);
    expect(quote?.amountOut ?? 0).toBeGreaterThan(9);
    expect(minReceived(quote!, 100)).toBeCloseTo((quote!.amountOut) * 0.99);
  });

  it("sorts currency first and falls back to contract symbols", () => {
    const tokens = sortedDexTokens(snapshot());

    expect(tokens[0]?.contract).toBe("currency");
    expect(tokenSymbol(tokens[1])).toBe("OUT");
  });

  it("encodes DEX decimal amounts as fixed runtime values", () => {
    expect(runtimeFixedFromString("001.2300")).toEqual({ __fixed__: "1.23" });
    expect(runtimeFixedFromNumber(902.2955123456789, { floor: true })).toEqual({
      __fixed__: "902.295512345678"
    });
  });
});
