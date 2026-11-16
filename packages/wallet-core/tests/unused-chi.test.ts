import { describe, expect, it } from "vitest";

import { buildApprovalView, unusedChiCost, unusedChiWarning } from "../src/approvals";
import type { PendingApprovalRecord } from "../src/types";

// Since execution revision 14 a paid transaction pays the chi it uses plus
// half of the chi it supplies but leaves unused (rounded down).
describe("unusedChiCost", () => {
  it("treats the SDK's 2-chi margin as no cost worth a warning", () => {
    expect(unusedChiCost({ supplied: 257, estimated: 255 })).toEqual({
      supplied: 257,
      estimated: 255,
      unused: 2,
      extraChi: 1,
      severity: "none"
    });
  });

  it("warns when the unused chi costs extra, and escalates once it doubles the fee", () => {
    expect(unusedChiCost({ supplied: 600, estimated: 400 })).toMatchObject({
      unused: 200,
      extraChi: 100,
      severity: "caution"
    });
    expect(unusedChiCost({ supplied: 1_200, estimated: 400 })).toMatchObject({
      extraChi: 400,
      severity: "high"
    });
    expect(unusedChiCost({ supplied: 50_000, estimated: 312 })).toMatchObject({
      unused: 49_688,
      extraChi: 24_844,
      severity: "high"
    });
  });

  it("rounds the charge for an odd unused amount down", () => {
    // 3 unused chi cost 1: still within the margin's cost.
    expect(unusedChiCost({ supplied: 258, estimated: 255 })).toMatchObject({ unused: 3, extraChi: 1, severity: "none" });
    expect(unusedChiCost({ supplied: 601, estimated: 400 })).toMatchObject({ unused: 201, extraChi: 100 });
  });

  it("charges nothing extra when the budget is fully used or short", () => {
    expect(unusedChiCost({ supplied: 255, estimated: 255 })).toMatchObject({ unused: 0, extraChi: 0, severity: "none" });
    expect(unusedChiCost({ supplied: 200, estimated: 255 })).toMatchObject({ unused: 0, severity: "none" });
  });

  it("refuses values that are not chi counts", () => {
    for (const [supplied, estimated] of [
      [1.5, 1],
      [-1, 1],
      [10, 0],
      [0, 10],
      ["10", 5]
    ] as const) {
      expect(unusedChiCost({ supplied: supplied as number, estimated: estimated as number })).toBeNull();
    }
  });
});

describe("unusedChiWarning", () => {
  it("names the unused chi and the extra cost in chi and XIAN", () => {
    const cost = unusedChiCost({ supplied: 600, estimated: 400 })!;
    expect(unusedChiWarning(cost, 20)).toBe(
      `This chi limit leaves 200 chi unused. Half of unused chi is charged: about 100 (~5 XIAN) more than the call needs (400 chi).`
    );
  });

  it("frames a budget that at least doubles the fee as an overpayment", () => {
    const cost = unusedChiCost({ supplied: 50_000, estimated: 312 })!;
    expect(unusedChiWarning(cost, 20)).toBe(
      `This chi limit is ${(160).toLocaleString()}x what the call needs (312 chi). ` +
        `Half of unused chi is charged: about ${(24_844).toLocaleString()} (~${(1_242.2).toLocaleString()} XIAN) extra.`
    );
  });

  it("says nothing when there is nothing to warn about", () => {
    expect(unusedChiWarning(unusedChiCost({ supplied: 257, estimated: 255 })!, 20)).toBeNull();
  });
});

function sendCall(chi: number): PendingApprovalRecord {
  return {
    id: "send-call",
    origin: "https://app.example",
    kind: "sendCall",
    request: {
      method: "xian_sendCall",
      params: [{ intent: { contract: "currency", function: "transfer", kwargs: { to: "bob", amount: "5" }, chi } }]
    },
    createdAt: 1
  };
}

describe("send-call approvals with a site-chosen chi limit", () => {
  it("warn with the quantified extra cost and mark the chi as dangerous", () => {
    const view = buildApprovalView(sendCall(50_000), { chiRate: 20, estimatedChi: 312 });

    expect(view.warnings).toContain(unusedChiWarning(unusedChiCost({ supplied: 50_000, estimated: 312 })!, 20));
    expect(view.details?.find((detail) => detail.label === "Chi")?.tone).toBe("danger");
  });

  it("stay quiet for a chi limit near the estimate", () => {
    const view = buildApprovalView(sendCall(314), { chiRate: 20, estimatedChi: 312 });

    expect(view.warnings?.some((warning) => warning.includes("unused"))).toBe(false);
    expect(view.details?.find((detail) => detail.label === "Chi")?.tone).toBe("warning");
  });
});
