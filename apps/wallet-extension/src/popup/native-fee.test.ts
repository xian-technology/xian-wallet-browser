import { describe, expect, it } from "vitest";

import { nativeSpendShortfall, nativeShortfallMessage } from "./native-fee";

// Execution first reserves the fee (chi / rate XIAN) from the balance; the
// call then spends from what is left. The simulator does not reserve, so a
// spend that only fits without the fee simulates fine and fails on chain.
describe("nativeSpendShortfall", () => {
  it("accepts a spend that leaves exactly the fee", () => {
    // 254 chi at 20 chi per XIAN = 12.7 XIAN.
    expect(nativeSpendShortfall({ balance: "100", amount: "87.3", chi: 254, chiRate: 20 })).toBeNull();
  });

  it("refuses a spend one unit above the fee-free rest, with the fee and the most it can spend", () => {
    expect(
      nativeSpendShortfall({ balance: "100", amount: "87.300000000000000000000000000001", chi: 254, chiRate: 20 })
    ).toEqual({ fee: "12.7", max: "87.25" });
  });

  it("refuses the whole balance (MAX), suggesting it minus the fee and one chi of headroom", () => {
    expect(nativeSpendShortfall({ balance: "100", amount: "100", chi: 255, chiRate: 20 })).toEqual({
      fee: "12.75",
      max: "87.2"
    });
  });

  it("compares a fee that does not terminate exactly", () => {
    // 254 / 7 = 36.285714...; the fit is decided without rounding.
    expect(nativeSpendShortfall({ balance: "100", amount: "63.714285714285714285714285714285", chi: 254, chiRate: 7 })).toBeNull();
    expect(
      nativeSpendShortfall({ balance: "100", amount: "63.714285714285714285714285714286", chi: 254, chiRate: 7 })
    ).toEqual({ fee: "36.285714285714285714285714285715", max: "63.57142857" });
  });

  it("suggests nothing to spend when the balance does not cover the fee", () => {
    expect(nativeSpendShortfall({ balance: "10", amount: "1", chi: 254, chiRate: 20 })).toEqual({
      fee: "12.7",
      max: "0"
    });
  });

  it.each([
    ["an unknown balance", { balance: null, amount: "1", chi: 254, chiRate: 20 }],
    ["an unreadable balance", { balance: "n/a", amount: "1", chi: 254, chiRate: 20 }],
    ["an unknown chi rate", { balance: "1", amount: "1", chi: 254, chiRate: null }],
    ["a non-integer chi rate", { balance: "1", amount: "1", chi: 254, chiRate: 2.5 }],
    ["a zero chi rate", { balance: "1", amount: "1", chi: 254, chiRate: 0 }]
  ])("does not judge with %s", (_case, input) => {
    expect(nativeSpendShortfall(input)).toBeNull();
  });
});

describe("nativeShortfallMessage", () => {
  it("names the fee and the most that can be spent", () => {
    expect(nativeShortfallMessage({ fee: "12.7", max: "87.25" })).toBe(
      "The amount plus the network fee (12.7 XIAN) exceeds your XIAN balance. You can spend at most 87.25 XIAN."
    );
  });

  it("says when the balance does not even cover the fee", () => {
    expect(nativeShortfallMessage({ fee: "12.7", max: "0" })).toBe(
      "Your XIAN balance does not cover the network fee (12.7 XIAN)."
    );
  });
});
