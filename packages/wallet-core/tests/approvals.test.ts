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
    expect(formatChiWithXianCost(16, 25)).toBe(`16 (~${(0.64).toLocaleString()} XIAN)`);
    expect(formatChiWithXianCost(16, null)).toBe("16");
  });

  it("omits the XIAN cost when there is no usable chi rate or the cost overflows", () => {
    for (const rate of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(formatChiWithXianCost(500, rate)).toBe("500");
    }
    expect(formatChiWithXianCost(Number.MAX_VALUE, Number.MIN_VALUE)).toBe(
      Number.MAX_VALUE.toLocaleString()
    );
    expect(formatChiWithXianCost("lots", 25)).toBe("lots");
    for (const missing of [null, undefined, "", Number.NaN]) {
      expect(formatChiWithXianCost(missing, 25)).toBeNull();
    }
  });

  it.each(["signTransaction", "sendTransaction", "sendCall"] as const)(
    "renders %s approvals with exact nested runtime values",
    (kind) => {
      const amount = 9007199254740993n;
      const kwargs = { amounts: [amount], memo: new Uint8Array([0, 255]) };
      const call = { contract: "currency", function: "transfer", kwargs };
      const params =
        kind === "sendCall"
          ? { intent: { ...call, chi: 500 } }
          : {
              tx: {
                payload: {
                  ...call,
                  sender: "a".repeat(64),
                  chain_id: "xian-local",
                  nonce: amount,
                  chi_supplied: 500
                }
              }
            };
      const view = buildApprovalView(
        makeRecord(kind, {
          method: `xian_${kind}`,
          params: [params]
        })
      );
      const payload = JSON.parse(view.payload);
      const renderedCall = kind === "sendCall" ? payload.intent : payload.tx.payload;
      expect(renderedCall.kwargs).toEqual({
        amounts: [{ __big_int__: "9007199254740993" }],
        memo: { __bytes__: "00ff" }
      });
      if (kind !== "sendCall") {
        expect(view.details).toContainEqual(
          expect.objectContaining({ label: "Nonce", value: "9007199254740993" })
        );
      }
    }
  );

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

  it("leaves the account and network out of a connect view when they are unknown", () => {
    const view = buildApprovalView(makeRecord("connect", { method: "xian_requestAccounts" }));

    expect(view.details.map((detail) => detail.label)).toEqual(["Site", "Access"]);
    expect(JSON.parse(view.payload)).toEqual({
      origin: "https://app.example",
      account: null,
      chainId: null
    });
  });

  it("shows the exact message to sign whatever shape the request carries it in", () => {
    const view = (params: unknown) =>
      buildApprovalView(
        makeRecord("signMessage", { method: "xian_signMessage", params: params as never }),
        { account: "abc123", chainId: "xian-local" }
      );
    const long = "x".repeat(161);

    expect(view(["plain text"]).payload).toBe("plain text");
    expect(view({ message: "object form" }).payload).toBe("object form");
    expect(view([{}]).payload).toBe("");
    expect(view([{}]).highlights).toEqual([]);
    expect(view(undefined).payload).toBe("");
    expect(view([{ message: long }]).highlights).toEqual([`${"x".repeat(157)}...`]);
    expect(view([{ message: long }]).payload).toBe(long);
    expect(view([{ message: "hi" }]).details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Account", value: "abc123" }),
        expect.objectContaining({ label: "Network", value: "xian-local" }),
        expect.objectContaining({ label: "Length", value: "2 characters" }),
        expect.objectContaining({ label: "Preview", value: "hi" })
      ])
    );
  });

  it.each([
    [
      "signTransaction",
      {
        title: "Sign prepared transaction",
        approveLabel: "Sign transaction",
        highlights: ["currency.transfer"],
        warnings: [
          "Prepared transactions may perform arbitrary contract actions. Inspect the raw payload if anything looks unfamiliar."
        ],
        chiTone: undefined,
        trustLabel: "prepared-signature requests"
      }
    ],
    [
      "sendTransaction",
      {
        title: "Send prepared transaction",
        approveLabel: "Send transaction",
        highlights: ["This request can broadcast immediately after approval."],
        warnings: [
          "Broadcasting a transaction may move funds or execute irreversible contract logic."
        ],
        chiTone: "warning",
        trustLabel: "prepared-transaction broadcasts"
      }
    ]
  ] as const)("describes a %s request with its own wording", (kind, expected) => {
    const tx = {
      payload: {
        contract: "currency",
        function: "transfer",
        kwargs: { amount: 1, to: "bob" },
        sender: "a".repeat(64),
        chain_id: "xian-local",
        nonce: 3,
        chi_supplied: 500
      }
    };
    const view = buildApprovalView(
      makeRecord(kind, { method: `xian_${kind}`, params: [{ tx }] }),
      { account: "a".repeat(64), chainId: "xian-local" }
    );

    expect(view).toMatchObject({
      title: expected.title,
      approveLabel: expected.approveLabel,
      highlights: expected.highlights,
      warnings: expected.warnings,
      payloadLabel: "Raw transaction"
    });
    expect(view.description.length).toBeGreaterThan(0);
    expect(JSON.parse(view.payload)).toEqual({ tx: { payload: expect.objectContaining({ nonce: 3 }) } });
    expect(view.details.find((detail) => detail.label === "Chi")?.tone).toBe(expected.chiTone);
    expect(JSON.stringify(view.trustSuggestion)).toContain(expected.trustLabel);
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

  it("formats unsafe-integer chi exactly as it will be signed", () => {
    expect(formatChiWithXianCost(12345678901234567891n, null)).toBe(
      (12345678901234567891n).toLocaleString()
    );
    expect(formatChiWithXianCost("12345678901234567891", null)).toBe(
      (12345678901234567891n).toLocaleString()
    );
    expect(formatChiWithXianCost(12_000, null)).toBe((12_000).toLocaleString());
    expect(formatChiWithXianCost("lots", null)).toBe("lots");
  });

  it.each([
    ["switchChain", { method: "xian_switchChain", params: [{ chainId: "xian-testnet-5" }] }],
    ["signMessage", { method: "xian_signMessage", params: [{ message: "hello" }] }],
    ["signTransaction", { method: "xian_signTransaction", params: [{ tx: { payload: { contract: "currency", function: "transfer" } } }] }],
    ["sendTransaction", { method: "xian_sendTransaction", params: [{ tx: { payload: { contract: "currency", function: "transfer" } } }] }],
    ["sendCall", { method: "xian_sendCall", params: [{ intent: { contract: "currency", function: "transfer", kwargs: {} } }] }],
    ["watchAsset", { method: "xian_watchAsset", params: [{ options: { contract: "con_token" } }] }]
  ] as const)("names the requesting site in %s approval details", (kind, request) => {
    const view = buildApprovalView(makeRecord(kind, request as PendingApprovalRecord["request"]), {
      account: "abc123",
      chainId: "xian-local"
    });

    expect(view.details?.[0]).toEqual(
      expect.objectContaining({ label: "Site", value: "https://app.example", monospace: true })
    );
  });

  it("names the account that will sign a send-call", () => {
    const view = buildApprovalView(
      makeRecord("sendCall", {
        method: "xian_sendCall",
        params: [{ intent: { contract: "currency", function: "transfer", kwargs: {} } }]
      }),
      { account: "abc123", chainId: "xian-local" }
    );

    expect(view.details).toContainEqual(
      expect.objectContaining({ label: "Account", value: "abc123" })
    );
  });

  it.each([
    ["sendCall", "xian_sendCall", null],
    ["sendCall", "xian_sendCall", { intent: null }],
    ["sendTransaction", "xian_sendTransaction", { tx: null }],
    ["signTransaction", "xian_signTransaction", { tx: { payload: null } }],
    ["watchAsset", "xian_watchAsset", { options: null }]
  ] as const)("builds a %s view from missing nested params (%s)", (kind, method, param) => {
    const view = buildApprovalView(
      makeRecord(kind, { method, params: [param] } as PendingApprovalRecord["request"]),
      { account: "abc123", chainId: "xian-local" }
    );

    expect(view.details?.[0]).toEqual(
      expect.objectContaining({ label: "Site", value: "https://app.example" })
    );
  });

  it("lists each send-call argument with its exact value", () => {
    const view = buildApprovalView(
      makeRecord("sendCall", {
        method: "xian_sendCall",
        params: [{
          intent: {
            contract: "currency",
            function: "transfer",
            kwargs: { to: "bob", amount: 9007199254740993n, memo: { __fixed__: "1.000000000000000000001" } },
            chi: 500
          }
        }]
      }),
      { account: "abc123", chainId: "xian-local" }
    );

    expect(view.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Argument: to", value: "bob" }),
        expect.objectContaining({ label: "Argument: amount", value: "9007199254740993" }),
        expect.objectContaining({ label: "Argument: memo", value: "1.000000000000000000001" })
      ])
    );
  });

  it("lists prepared-transaction arguments", () => {
    const view = buildApprovalView(
      makeRecord("sendTransaction", {
        method: "xian_sendTransaction",
        params: [{ tx: { payload: { contract: "currency", function: "transfer", chi_supplied: 9, kwargs: { to: "bob", flags: [1, 2] } } } }]
      }),
      { account: "abc123", chainId: "xian-local" }
    );

    expect(view.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Argument: to", value: "bob" }),
        expect.objectContaining({ label: "Argument: flags", value: "[\n  1,\n  2\n]" })
      ])
    );
  });

  it("reveals invisible and direction-changing characters in a message", () => {
    const view = buildApprovalView(
      makeRecord("signMessage", {
        method: "xian_signMessage",
        params: [{ message: "pay alice‮ecilab​" }]
      }),
      { account: "abc123", chainId: "xian-local" }
    );

    expect(view.payload).toBe("pay alice[U+202E]ecilab[U+200B]");
    expect(view.highlights).toEqual(["pay alice[U+202E]ecilab[U+200B]"]);
    expect(view.details).toContainEqual(
      expect.objectContaining({ label: "Length", value: "17 characters" })
    );
    expect(view.warnings?.[0]).toMatch(/invisible or text-direction characters/);
  });

  it("reveals hidden characters in call arguments", () => {
    const view = buildApprovalView(
      makeRecord("sendCall", {
        method: "xian_sendCall",
        params: [{ intent: { contract: "currency", function: "transfer", kwargs: { "to⁦": "bob‮" }, chi: 5 } }]
      }),
      { account: "abc123", chainId: "xian-local" }
    );

    expect(view.details).toContainEqual(
      expect.objectContaining({ label: "Argument: to[U+2066]", value: "bob[U+202E]" })
    );
    expect(view.payload).not.toMatch(/[‮⁦]/u);
    expect(view.warnings?.[0]).toMatch(/invisible or text-direction characters/);
  });

  it("does not warn about ordinary text", () => {
    const view = buildApprovalView(
      makeRecord("signMessage", {
        method: "xian_signMessage",
        params: [{ message: "line one\nline two\ttabbed — ünïcode" }]
      }),
      { account: "abc123", chainId: "xian-local" }
    );

    expect(view.payload).toBe("line one\nline two\ttabbed — ünïcode");
    expect(view.warnings?.some((warning) => /invisible/.test(warning))).toBe(false);
  });

  it("flags a send-call without a chi limit and offers no auto-approval", () => {
    const view = buildApprovalView(
      makeRecord("sendCall", {
        method: "xian_sendCall",
        params: [{ intent: { contract: "currency", function: "transfer", kwargs: {} } }]
      }),
      { account: "abc123", chainId: "xian-local", chiRate: 25 }
    );

    expect(view.details).toContainEqual(
      expect.objectContaining({ label: "Chi", value: "Not estimated", tone: "danger" })
    );
    expect(view.trustSuggestion).toBeUndefined();
    expect(view.warnings).toContain(
      "The wallet could not estimate chi for this call. The chi limit will be chosen when it is sent."
    );
  });

  it("names the requested chain from the request when no target is bound", () => {
    const requested = buildApprovalView(
      makeRecord("switchChain", { method: "xian_switchChain", params: [{ chainId: "xian-testnet-5" }] }),
      { chainId: "xian-local" }
    );
    const malformed = buildApprovalView(
      makeRecord("switchChain", { method: "xian_switchChain", params: [{ chainId: 5 }] }),
      { chainId: "xian-local" }
    );

    expect(requested.details).toContainEqual(
      expect.objectContaining({ label: "Requested network", value: "xian-testnet-5" })
    );
    expect(malformed.details?.some((detail) => detail.label === "Requested network")).toBe(false);
    expect(
      buildApprovalView(
        makeRecord("switchChain", { method: "xian_switchChain", params: [{ chainId: "xian-testnet-5" }] })
      ).details
    ).toContainEqual(expect.objectContaining({ label: "Requested network", value: "xian-testnet-5" }));
  });

  it("shows big-integer markers as their exact digits in monospace", () => {
    const view = buildApprovalView(
      makeRecord("sendCall", {
        method: "xian_sendCall",
        params: [{ intent: { contract: "c", function: "f", kwargs: { amount: { __big_int__: "123456789012345678901234" } }, chi: 5 } }]
      }),
      { chainId: "xian-local" }
    );

    expect(view.details).toContainEqual({
      label: "Argument: amount",
      value: "123456789012345678901234",
      monospace: true
    });
  });

  it.each([null, "ab", [1, 2]])("lists no arguments for non-object kwargs %j", (kwargs) => {
    const view = buildApprovalView(
      makeRecord("sendTransaction", {
        method: "xian_sendTransaction",
        params: [{ tx: { payload: { contract: "c", function: "f", chi_supplied: 5, kwargs } } }]
      }),
      { chainId: "xian-local" }
    );

    expect(view.details?.some((detail) => detail.label.startsWith("Argument:"))).toBe(false);
  });

  it("warns about hidden characters that only appear in the raw payload", () => {
    const view = buildApprovalView(
      makeRecord("sendCall", {
        method: "xian_sendCall",
        params: [{ intent: { contract: "c", function: "f", kwargs: {}, chi: 5 }, note: "x‮" }]
      }),
      { chainId: "xian-local" }
    );

    expect(view.warnings?.[0]).toMatch(/invisible or text-direction characters/);
  });
});


describe("approval view details", () => {
  const account = "a".repeat(64);
  const options = { account, chainId: "xian-local" };
  const tx = (payload: Record<string, unknown>) => [{ tx: { payload } }];
  const detail = (view: ReturnType<typeof buildApprovalView>, label: string) =>
    view.details?.find((entry) => entry.label === label);

  it("shows accounts, senders and contracts in monospace in every view", () => {
    const monospaced: Array<[PendingApprovalRecord["kind"], string, unknown, string]> = [
      ["connect", "xian_requestAccounts", undefined, "Account"],
      ["switchChain", "xian_switchChain", [{ chainId: "xian-other" }], "Account"],
      ["signMessage", "xian_signMessage", [{ message: "hi" }], "Account"],
      ["sendCall", "xian_sendCall", [{ intent: { contract: "currency", function: "transfer", chi: 5 } }], "Account"],
      ["sendTransaction", "xian_sendTransaction", tx({ sender: account, contract: "currency" }), "Sender"],
      ["sendTransaction", "xian_sendTransaction", tx({ sender: account, contract: "currency" }), "Contract"],
      ["watchAsset", "xian_watchAsset", [{ options: { contract: "con_token" } }], "Contract"]
    ];
    for (const [kind, method, params, label] of monospaced) {
      const view = buildApprovalView(makeRecord(kind, { method, params: params as never }), options);
      expect([kind, label, detail(view, label)?.monospace]).toEqual([kind, label, true]);
    }
  });

  it("previews even a one-character message and needs no wallet context to do so", () => {
    const view = buildApprovalView(
      makeRecord("signMessage", { method: "xian_signMessage", params: [{ message: "x" }] })
    );
    expect(view.highlights).toEqual(["x"]);
    expect(view.details.map((entry) => entry.label)).toEqual(["Site", "Length", "Preview"]);
  });

  it("names the transaction's own chain, else the wallet's, else none", () => {
    const record = (payload: Record<string, unknown>) =>
      makeRecord("signTransaction", { method: "xian_signTransaction", params: tx(payload) });
    expect(detail(buildApprovalView(record({ chain_id: "xian-tx" }), options), "Network")?.value).toBe("xian-tx");
    expect(detail(buildApprovalView(record({}), options), "Network")?.value).toBe("xian-local");
    expect(detail(buildApprovalView(record({})), "Network")).toBeUndefined();
  });

  it("offers no trust rule for a prepared transaction without a named function", () => {
    const view = buildApprovalView(
      makeRecord("sendTransaction", { method: "xian_sendTransaction", params: tx({ contract: "currency" }) }),
      options
    );
    expect(view.trustSuggestion).toBeUndefined();
    expect(view.highlights).toEqual(["This request can broadcast immediately after approval."]);
  });

  it("counts send-call arguments only when the intent carries an argument object", () => {
    const call = (kwargs: unknown) =>
      buildApprovalView(
        makeRecord("sendCall", {
          method: "xian_sendCall",
          params: [{ intent: { contract: "currency", function: "transfer", chi: 5, kwargs } }]
        }),
        options
      );
    expect(detail(call({ to: "bob", amount: 1 }), "Arguments")?.value).toBe("2 field(s)");
    expect(detail(call(null), "Arguments")).toBeUndefined();
    expect(detail(call("to=bob"), "Arguments")).toBeUndefined();
  });

  it("prices chi at any positive rate, including one chi per XIAN", () => {
    expect(formatChiWithXianCost(500, 1)).toBe("500 (~500 XIAN)");
    expect(formatChiWithXianCost(500, 0.5)).toBe(`500 (~${(1000).toLocaleString()} XIAN)`);
  });
});
