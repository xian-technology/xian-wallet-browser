import { describe, expect, it } from "vitest";

import { OUT_OF_CHI_MESSAGE } from "./activity";
import { transactionAccepted, transactionFinalStatus } from "./transaction-status";

const sent = { submitted: true, accepted: true, finalized: true, txHash: "TX" };

describe("transaction final status", () => {
  it("reports a receipt whose execution failed as a failure", () => {
    const outOfChi = {
      ...sent,
      receipt: { success: false, message: { status: 1, result: "Out of chi.", chi_used: 500 } }
    };
    expect(transactionAccepted(outOfChi)).toBe(false);
    expect(transactionFinalStatus(outOfChi, { failed: "Swap failed." })).toEqual({
      message: "Swap failed.",
      tone: "danger",
      icon: "danger",
      detail: OUT_OF_CHI_MESSAGE
    });

    const reverted = { ...sent, receipt: { success: false, message: "AssertionError('nope')" } };
    expect(transactionFinalStatus(reverted)).toMatchObject({
      message: "Transaction failed.",
      detail: "AssertionError('nope')"
    });
    expect(transactionFinalStatus({ ...sent, receipt: { success: false } })).toMatchObject({
      message: "Transaction failed.",
      detail: undefined
    });
  });

  it("reports a successful receipt as finalized", () => {
    const ok = { ...sent, receipt: { success: true } };
    expect(transactionAccepted(ok)).toBe(true);
    expect(transactionFinalStatus(ok)).toEqual({
      message: "Transaction finalized.",
      tone: "success",
      icon: "success"
    });
  });

  it("keeps the submission outcomes without a receipt", () => {
    expect(transactionFinalStatus({ ...sent, finalized: false }, { accepted: "Swap accepted." })).toMatchObject({
      message: "Swap accepted.",
      tone: "success"
    });
    expect(transactionAccepted({ ...sent, finalized: false })).toBe(true);
    const rejected = { submitted: true, accepted: false, finalized: false, message: " CheckTx failed " };
    expect(transactionAccepted(rejected)).toBe(false);
    expect(transactionFinalStatus(rejected)).toMatchObject({
      message: "Transaction failed.",
      tone: "danger",
      detail: "CheckTx failed"
    });
    expect(transactionFinalStatus({ submitted: false, accepted: null, finalized: false })).toMatchObject({
      tone: "danger",
      detail: undefined
    });
    expect(transactionFinalStatus({ submitted: true, accepted: null, finalized: false })).toBeNull();
  });

  it("falls back to the default titles for empty labels", () => {
    const empty = { finalized: "", accepted: "", failed: "" };
    expect(transactionFinalStatus(sent, empty)?.message).toBe("Transaction finalized.");
    expect(transactionFinalStatus({ ...sent, finalized: false }, empty)?.message).toBe("Transaction accepted.");
    expect(transactionFinalStatus({ ...sent, receipt: { success: false } }, empty)?.message).toBe(
      "Transaction failed."
    );
  });
});
