import { describe, expect, it } from "vitest";

import {
  activityHasTx,
  activityTxTimestampMillis,
  mergeActivityTxs
} from "./activity";
import { classifyTx, type ActivityTx } from "./tx-classify";

function activityTx(overrides: Partial<ActivityTx> = {}): ActivityTx {
  return {
    tx_hash: "TX-1",
    sender: "sender",
    contract: "currency",
    function: "transfer",
    success: true,
    ...overrides
  };
}

describe("transaction activity", () => {
  it("replaces a local submission with the canonical BDS tx_hash row", () => {
    const local = activityTx({
      tx_hash: "tx-1",
      local: true,
      local_status: "finalized",
      created_at: "2026-07-18T22:29:45.000Z"
    });
    const indexed = activityTx({
      tx_hash: "TX-1",
      block_height: 5098,
      created_at: "2026-07-18T22:29:44.000Z"
    });

    expect(mergeActivityTxs([indexed], [local])).toEqual([indexed]);
    expect(activityHasTx([indexed], "tx-1")).toBe(true);
  });

  it("converts canonical BDS nanosecond block times to milliseconds", () => {
    expect(activityTxTimestampMillis(activityTx({ block_time: 1_784_413_784_070_844_200 })))
      .toBe(1_784_413_784_070);
  });

  it("classifies canonical BDS string payloads without a local fallback row", () => {
    const indexed = activityTx({
      contract: "con_dex",
      function: "swapExactTokensForTokens",
      payload: JSON.stringify({
        kwargs: { src: "currency", amountIn: { __fixed__: "100000" } }
      })
    });

    expect(classifyTx(indexed)).toMatchObject({ category: "buy", label: "Buy" });
  });
});
