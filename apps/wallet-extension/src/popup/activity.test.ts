import { describe, expect, it } from "vitest";

import {
  activityHasTx,
  activityTxTimestampMillis,
  failedActivityMessage,
  mergeActivityTxs,
  OUT_OF_CHI_MESSAGE
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

describe("failed activity message", () => {
  it("explains an out-of-chi failure as a state change since the estimate", () => {
    for (const result of ["Out of chi.", "VmExecutionError('Out of chi.')", { error: "out of chi" }]) {
      expect(failedActivityMessage(activityTx({ success: false, result }))).toBe(OUT_OF_CHI_MESSAGE);
    }
    expect(OUT_OF_CHI_MESSAGE).toMatch(/state changed since the estimate/i);
  });

  it("shows other failures as the node reported them", () => {
    expect(failedActivityMessage(activityTx({ success: false, result: "AssertionError('nope')" }))).toBe(
      "AssertionError('nope')"
    );
    expect(failedActivityMessage(activityTx({ success: false, result: { message: "bad" } }))).toBe("bad");
    expect(failedActivityMessage(activityTx({ success: false, result: { code: 7 } }))).toBe('{"code":7}');
    expect(failedActivityMessage(activityTx({ success: false, result: { result: "inner" } }))).toBe("inner");
    expect(failedActivityMessage(activityTx({ success: false, result: 42 }))).toBeNull();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(failedActivityMessage(activityTx({ success: false, result: circular }))).toBeNull();
    expect(failedActivityMessage(activityTx({ success: false }))).toBeNull();
    expect(failedActivityMessage(activityTx({ success: true, result: "Out of chi." }))).toBeNull();
  });
});
