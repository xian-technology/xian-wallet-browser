import { describe, expect, it } from "vitest";

import { buildApprovalView, formatChiWithXianCost } from "../src/approvals";
import type { PendingApprovalRecord } from "../src/types";

function makeRecord(
  kind: PendingApprovalRecord["kind"],
  request: PendingApprovalRecord["request"]
): PendingApprovalRecord {
  return {
    id: `${kind}-approval`,
    origin: "https://app.example",
    kind,
    request,
    createdAt: 123
  };
}

describe("@xian-tech/wallet-core approvals", () => {
  it("formats chi with the same approximate XIAN cost label used by send review", () => {
    expect(formatChiWithXianCost(500, 25)).toBe("500 (~20 XIAN)");
    expect(formatChiWithXianCost(16, 25)).toBe("16 (~0.64 XIAN)");
    expect(formatChiWithXianCost(16, null)).toBe("16");
  });

  it("builds a structured connect approval view", () => {
    const view = buildApprovalView(
      makeRecord("connect", {
        method: "xian_requestAccounts"
      }),
      {
        account: "abc123",
        chainId: "xian-testnet-5"
      }
    );

    expect(view.approveLabel).toBe("Connect");
    expect(view.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Site", value: "https://app.example" }),
        expect.objectContaining({ label: "Account", value: "abc123" })
      ])
    );
    expect(view.warnings).toContain(
      "Only connect sites you trust. You can revoke site access from the wallet at any time."
    );
  });

  it("builds a chain-switch view that names both reviewed networks", () => {
    const view = buildApprovalView(
      makeRecord("switchChain", {
        method: "xian_switchChain",
        params: [{ chainId: "xian-testnet-5" }]
      }),
      {
        account: "abc123",
        chainId: "xian-local",
        targetChainId: "xian-testnet-5"
      }
    );

    expect(view).toMatchObject({
      title: "Switch network",
      approveLabel: "Switch network",
      account: "abc123",
      chainId: "xian-local"
    });
    expect(view.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Current network",
          value: "xian-local"
        }),
        expect.objectContaining({
          label: "Requested network",
          value: "xian-testnet-5"
        })
      ])
    );
  });

  it("builds a structured send-call approval view", () => {
    const view = buildApprovalView(
      makeRecord("sendCall", {
        method: "xian_sendCall",
        params: [
          {
            intent: {
              contract: "currency",
              function: "transfer",
              kwargs: {
                to: "bob",
                amount: "5"
              },
              chi: 500
            }
          }
        ]
      }),
      {
        account: "abc123",
        chainId: "xian-testnet-5",
        chiRate: 25
      }
    );

    expect(view.approveLabel).toBe("Approve call");
    expect(view.payloadLabel).toBe("Raw call intent");
    expect(view.highlights).toContain("currency.transfer");
    expect(
      view.details?.find((detail) => detail.label === "Contract")?.monospace
    ).toBeUndefined();
    expect(view.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Contract", value: "currency" }),
        expect.objectContaining({ label: "Function", value: "transfer" }),
        expect.objectContaining({ label: "Chi", value: "500 (~20 XIAN)" }),
        expect.objectContaining({ label: "Arguments", value: "2 field(s)" })
      ])
    );
  });
});
