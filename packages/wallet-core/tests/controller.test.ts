import { describe, expect, it, vi } from "vitest";

import type {
  TransactionSubmission,
  XianSignedTransaction,
  XianUnsignedTransaction
} from "@xian-tech/provider";

import {
  decryptWalletBackup,
  UNLOCKED_SESSION_TIMEOUT_MS,
  WalletController,
  type PersistedApproval,
  type StoredProviderRequest,
  type StoredUnlockedSession,
  type StoredWalletState,
  type WalletControllerStore,
  type WalletNetworkClient
} from "../src/index";

const PRIVATE_KEY = "11".repeat(32);
const ORIGIN = "https://app.example";
const SHIELDED_STATE_SNAPSHOT = JSON.stringify({
  asset_id: "con_private",
  owner_secret: "0x" + "22".repeat(32),
  viewing_private_key: "33".repeat(32),
  notes: [],
  commitments: [],
  last_scanned_index: 0
});

interface MemoryStore extends WalletControllerStore {
  current(): StoredWalletState | null;
  currentSession(): StoredUnlockedSession | null;
  currentRequests(): Record<string, StoredProviderRequest>;
  currentApprovals(): Record<string, PersistedApproval>;
}

function createStore(): MemoryStore {
  let state: StoredWalletState | null = null;
  let unlockedSession: StoredUnlockedSession | null = null;
  const requests: Record<string, StoredProviderRequest> = {};
  const approvals: Record<string, PersistedApproval> = {};

  return {
    async loadState() {
      return state;
    },
    async saveState(nextState) {
      state = nextState;
    },
    async clearState() {
      state = null;
    },
    async loadUnlockedSession() {
      return unlockedSession;
    },
    async saveUnlockedSession(nextState) {
      unlockedSession = nextState;
    },
    async clearUnlockedSession() {
      unlockedSession = null;
    },
    async loadRequestState(requestId) {
      return requests[requestId] ?? null;
    },
    async saveRequestState(nextState) {
      requests[nextState.requestId] = nextState;
    },
    async deleteRequestState(requestId) {
      delete requests[requestId];
    },
    async listRequestStates() {
      return Object.values(requests);
    },
    async loadApprovalState(approvalId) {
      return approvals[approvalId] ?? null;
    },
    async saveApprovalState(nextState) {
      approvals[nextState.id] = nextState;
    },
    async deleteApprovalState(approvalId) {
      delete approvals[approvalId];
    },
    async listApprovalStates() {
      return Object.values(approvals);
    },
    current() {
      return state;
    },
    currentSession() {
      return unlockedSession;
    },
    currentRequests() {
      return requests;
    },
    currentApprovals() {
      return approvals;
    }
  };
}

function createClient(): WalletNetworkClient {
  return {
    getChainId: vi.fn(async () => "xian-local"),
    getBalance: vi.fn(async () => "12"),
    getTokenBalances: vi.fn(async () => ({
      available: true,
      address: "alice",
      items: [
        {
          contract: "currency",
          balance: "12",
          name: "Xian",
          symbol: "XIAN",
          logoUrl: "https://example.com/xian.svg"
        },
        {
          contract: "con_token",
          balance: "8",
          name: "Example",
          symbol: "EXP",
          logoUrl: null
        }
      ],
      total: 2,
      limit: 100,
      offset: 0
    })),
    getTokenMetadata: vi.fn(async (contract: string) => ({
      contract,
      name: contract === "currency" ? "Xian" : "Example",
      symbol: contract === "currency" ? "XIAN" : "EXP",
      logoUrl: null,
      logoSvg: null
    })),
    getShieldedWalletHistory: vi.fn(async () => ({
      available: true,
      items: [],
      limit: 5,
      afterNoteIndex: 0
    })),
    estimateChi: vi.fn(async () => ({
      estimated: 12_000
    })),
    getContractMethods: vi.fn(async () => []),
    buildTx: vi.fn(async (intent) => ({
      payload: {
        chain_id: intent.chainId ?? "xian-local",
        contract: intent.contract,
        function: intent.function,
        kwargs: intent.kwargs,
        nonce: 7,
        sender: intent.sender,
        chi_supplied: intent.chiSupplied ?? intent.chi ?? 50_000
      }
    })),
    signTx: vi.fn(async (tx) => ({
      payload: tx.payload,
      metadata: {
        signature: "signed"
      }
    })),
    broadcastTx: vi.fn(
      async (tx): Promise<TransactionSubmission> => ({
        submitted: true,
        accepted: true,
        finalized: false,
        txHash: "ABC123",
        mode: "checktx",
        nonce: tx.payload.nonce,
        chiSupplied: tx.payload.chi_supplied,
        response: {}
      })
    )
  };
}

describe("@xian-tech/wallet-core controller", () => {
  it("creates connect approvals and emits provider lifecycle events", async () => {
    const store = createStore();
    const client = createClient();
    const onApprovalRequested = vi.fn(async () => undefined);
    const onProviderEvent = vi.fn(async () => undefined);
    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client,
      onApprovalRequested,
      onProviderEvent,
      createId: vi.fn(() => "approval-1"),
      now: vi.fn(() => 123)
    });

    const created = await controller.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });
    expect(created.popupState.hasWallet).toBe(true);

    const start = await controller.startProviderRequest("request-1", ORIGIN, {
      method: "xian_requestAccounts"
    });

    expect(start).toEqual({
      status: "pending",
      approvalId: "approval-1"
    });
    expect(onApprovalRequested).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({
        id: "approval-1",
        kind: "connect",
        origin: ORIGIN
      })
    );
    await expect(controller.getApprovalView("approval-1")).resolves.toMatchObject({
      title: "Connect wallet"
    });

    await controller.resolveApproval("approval-1", true);
    const status = await controller.getProviderRequestStatus("request-1");
    const account = (status.status === "fulfilled"
      ? (status.result as string[])[0]
      : undefined);

    expect(account).toBe(store.current()?.publicKey);
    expect(onProviderEvent).toHaveBeenNthCalledWith(
      1,
      "connect",
      [{ chainId: "xian-local" }],
      ORIGIN
    );
    expect(onProviderEvent).toHaveBeenNthCalledWith(
      2,
      "accountsChanged",
      [[account]],
      ORIGIN
    );
    expect(onProviderEvent).toHaveBeenNthCalledWith(
      3,
      "chainChanged",
      ["xian-local"],
      ORIGIN
    );
  });

  it("does not expose provider request state across origins", async () => {
    const store = createStore();
    const client = createClient();
    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client,
      onApprovalRequested: vi.fn(async () => undefined),
      createId: vi.fn(() => "approval-1")
    });

    await controller.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });
    await controller.startProviderRequest("request-1", ORIGIN, {
      method: "xian_requestAccounts"
    });

    await expect(
      controller.getProviderRequestStatus("request-1", {
        origin: "https://evil.example"
      })
    ).resolves.toEqual({ status: "not_found" });
    await expect(
      controller.startProviderRequest("request-1", "https://evil.example", {
        method: "xian_accounts"
      })
    ).resolves.toEqual({
      status: "rejected",
      error: {
        name: "Error",
        message: "request id is already in use by a different origin"
      }
    });
  });

  it("persists approvals and request results across controller instances", async () => {
    const store = createStore();
    const client = createClient();
    const createId = vi
      .fn()
      .mockReturnValueOnce("approval-1")
      .mockReturnValueOnce("approval-2");

    const controllerA = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client,
      onApprovalRequested: vi.fn(async () => undefined),
      onProviderEvent: vi.fn(async () => undefined),
      createId
    });

    const created = await controllerA.createOrImportWallet({
      password: "secret",
      createWithMnemonic: true
    });
    expect(created.importedSeedSource).toBe("mnemonic");
    expect(created.generatedMnemonic).toBeDefined();
    expect(await controllerA.revealMnemonic("secret")).toBe(created.generatedMnemonic);

    await controllerA.startProviderRequest("request-1", ORIGIN, {
      method: "xian_requestAccounts"
    });
    await controllerA.resolveApproval("approval-1", true);

    const start = await controllerA.startProviderRequest("request-2", ORIGIN, {
      method: "xian_sendCall",
      params: [
        {
          intent: {
            contract: "currency",
            function: "transfer",
            kwargs: { to: "bob", amount: "5" },
            chi: 500
          }
        }
      ]
    });
    expect(start).toEqual({
      status: "pending",
      approvalId: "approval-2"
    });

    const controllerB = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client,
      onApprovalRequested: vi.fn(async () => undefined)
    });

    await controllerB.unlockWallet("secret");
    await expect(controllerB.getApprovalView("approval-2")).resolves.toMatchObject({
      title: "Send contract call"
    });

    await controllerB.resolveApproval("approval-2", true);
    const status = await controllerB.getProviderRequestStatus("request-2");

    expect(status.status).toBe("fulfilled");
    expect((status.status === "fulfilled"
      ? (status.result as TransactionSubmission).txHash
      : null)).toBe("ABC123");
    expect(client.buildTx).toHaveBeenCalledWith(
      expect.objectContaining({
        contract: "currency",
        function: "transfer",
        kwargs: { to: "bob", amount: "5" },
        chainId: "xian-local",
        chi: 500
      })
    );
    expect(client.signTx).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          sender: store.current()?.publicKey
        })
      }) as XianUnsignedTransaction,
      expect.objectContaining({ address: store.current()?.publicKey })
    );
    expect(client.broadcastTx).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          sender: store.current()?.publicKey
        }),
        metadata: expect.objectContaining({
          signature: "signed"
        })
      }) as XianSignedTransaction,
      {
        mode: undefined,
        waitForTx: undefined,
        timeoutMs: undefined,
        pollIntervalMs: undefined
      }
    );
  });

  it("estimates missing send-call chi before showing and executing approvals", async () => {
    const store = createStore();
    const client = createClient();
    vi.mocked(client.estimateChi).mockResolvedValue({ estimated: 500 });
    client.getChiRate = vi.fn(async () => 25);
    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client,
      onApprovalRequested: vi.fn(async () => undefined),
      createId: vi
        .fn()
        .mockReturnValueOnce("approval-connect")
        .mockReturnValueOnce("approval-send")
    });

    await controller.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });

    await controller.startProviderRequest("request-connect", ORIGIN, {
      method: "xian_requestAccounts"
    });
    await controller.resolveApproval("approval-connect", true);

    await expect(
      controller.startProviderRequest("request-send", ORIGIN, {
        method: "xian_sendCall",
        params: [
          {
            intent: {
              contract: "submission",
              function: "submit_contract",
              kwargs: { name: "demo", code: "print(1)" }
            }
          }
        ]
      })
    ).resolves.toEqual({
      status: "pending",
      approvalId: "approval-send"
    });

    expect(client.estimateChi).toHaveBeenCalledWith({
      sender: store.current()?.publicKey,
      contract: "submission",
      function: "submit_contract",
      kwargs: { name: "demo", code: "print(1)" }
    });
    await expect(controller.getApprovalView("approval-send")).resolves.toEqual(
      expect.objectContaining({
        title: "Send contract call",
        details: expect.arrayContaining([
          expect.objectContaining({
            label: "Contract",
            value: "submission",
            monospace: undefined
          }),
          expect.objectContaining({
            label: "Chi",
            value: "500 (~20 XIAN)"
          })
        ])
      })
    );

    await controller.resolveApproval("approval-send", true);
    expect(client.buildTx).toHaveBeenCalledWith(
      expect.objectContaining({
        contract: "submission",
        function: "submit_contract",
        kwargs: { name: "demo", code: "print(1)" },
        chi: 500
      })
    );
  });

  it("includes pending approval views in popup state and can disconnect origins", async () => {
    const store = createStore();
    const client = createClient();
    const onProviderEvent = vi.fn(async () => undefined);
    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client,
      onApprovalRequested: vi.fn(async () => undefined),
      onProviderEvent,
      createId: vi.fn(() => "approval-1")
    });

    await controller.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });

    await controller.startProviderRequest(
      "request-1",
      ORIGIN,
      {
        method: "xian_requestAccounts"
      },
      {
        dappMetadata: {
          name: "Swap Example",
          iconUrl: "https://app.example/icon.svg"
        }
      }
    );

    const popupWhilePending = await controller.getPopupState();
    expect(popupWhilePending.pendingApprovalCount).toBe(1);
    expect(popupWhilePending.pendingApprovals).toEqual([
      expect.objectContaining({
        id: "approval-1",
        title: "Connect wallet",
        approveLabel: "Connect"
      })
    ]);

    await controller.resolveApproval("approval-1", true);
    const connectedState = await controller.getPopupState();
    expect(connectedState.connectedOrigins).toEqual([ORIGIN]);
    expect(connectedState.connectedDappMetadata[ORIGIN]).toEqual(
      expect.objectContaining({
        name: "Swap Example",
        iconUrl: "https://app.example/icon.svg",
        lastSeenAt: expect.any(Number)
      })
    );

    const disconnectedState = await controller.disconnectOrigin(ORIGIN);
    expect(disconnectedState.connectedOrigins).toEqual([]);
    expect(disconnectedState.connectedDappMetadata).toEqual({});
    expect(onProviderEvent).toHaveBeenLastCalledWith(
      "disconnect",
      [{ code: 4100, message: "wallet disconnected" }],
      ORIGIN
    );
  });

  it("auto-approves dapp transactions that match a trusted policy", async () => {
    const store = createStore();
    const client = createClient();
    const onApprovalRequested = vi.fn(async () => undefined);
    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client,
      onApprovalRequested,
      createId: vi
        .fn()
        .mockReturnValueOnce("approval-connect")
        .mockReturnValueOnce("approval-send")
        .mockReturnValueOnce("policy-1")
        .mockReturnValueOnce("approval-changed")
        .mockReturnValueOnce("approval-different"),
      now: vi.fn(() => 1_000)
    });

    await controller.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });

    await controller.startProviderRequest("request-connect", ORIGIN, {
      method: "xian_requestAccounts"
    });
    await controller.resolveApproval("approval-connect", true);

    const trustedRequest = {
      method: "xian_sendCall",
      params: [
        {
          intent: {
            contract: "currency",
            function: "transfer",
            kwargs: { to: "bob", amount: "5" },
            chi: 500
          }
        }
      ]
    };
    await expect(
      controller.startProviderRequest("request-first-send", ORIGIN, trustedRequest)
    ).resolves.toEqual({
      status: "pending",
      approvalId: "approval-send"
    });

    await controller.resolveApproval("approval-send", true, { trust: true });
    expect(store.current()?.trustedDappPolicies).toEqual([
      expect.objectContaining({
        id: "policy-1",
        origin: ORIGIN,
        chainId: "xian-local",
        methods: ["xian_sendCall"],
        contract: "currency",
        function: "transfer",
        maxChi: 500,
        argumentScope: "exact",
        kwargs: { to: "bob", amount: "5" }
      })
    ]);

    await expect(
      controller.startProviderRequest("request-trusted-send", ORIGIN, trustedRequest)
    ).resolves.toMatchObject({
      status: "fulfilled",
      result: expect.objectContaining({
        txHash: "ABC123"
      })
    });

    expect(onApprovalRequested).toHaveBeenCalledTimes(2);
    expect(store.current()?.trustedDappPolicies?.[0]).toEqual(
      expect.objectContaining({
        useCount: 1,
        lastUsedAt: 1_000
      })
    );

    await expect(
      controller.startProviderRequest("request-changed-send", ORIGIN, {
        method: "xian_sendCall",
        params: [
          {
            intent: {
              contract: "currency",
              function: "transfer",
              kwargs: { to: "mallory", amount: "500" },
              chi: 500
            }
          }
        ]
      })
    ).resolves.toEqual({
      status: "pending",
      approvalId: "approval-changed"
    });

    await expect(
      controller.startProviderRequest("request-different-send", ORIGIN, {
        method: "xian_sendCall",
        params: [
          {
            intent: {
              contract: "currency",
              function: "approve",
              kwargs: {},
              chi: 500
            }
          }
        ]
      })
    ).resolves.toEqual({
      status: "pending",
      approvalId: "approval-different"
    });
  });

  it("auto-approves changed arguments only for explicit broad trusted policies", async () => {
    const store = createStore();
    const client = createClient();
    const onApprovalRequested = vi.fn(async () => undefined);
    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client,
      onApprovalRequested,
      createId: vi
        .fn()
        .mockReturnValueOnce("approval-connect")
        .mockReturnValueOnce("approval-send")
        .mockReturnValueOnce("policy-1"),
      now: vi.fn(() => 1_000)
    });

    await controller.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });

    await controller.startProviderRequest("request-connect", ORIGIN, {
      method: "xian_requestAccounts"
    });
    await controller.resolveApproval("approval-connect", true);

    const trustedRequest = {
      method: "xian_sendCall",
      params: [
        {
          intent: {
            contract: "currency",
            function: "transfer",
            kwargs: { to: "bob", amount: "5" },
            chi: 500
          }
        }
      ]
    };
    await expect(
      controller.startProviderRequest("request-first-send", ORIGIN, trustedRequest)
    ).resolves.toEqual({
      status: "pending",
      approvalId: "approval-send"
    });

    await controller.resolveApproval("approval-send", true, { trust: "any" });
    expect(store.current()?.trustedDappPolicies).toEqual([
      expect.objectContaining({
        id: "policy-1",
        contract: "currency",
        function: "transfer",
        argumentScope: "any",
        kwargs: undefined
      })
    ]);

    await expect(
      controller.startProviderRequest("request-changed-send", ORIGIN, {
        method: "xian_sendCall",
        params: [
          {
            intent: {
              contract: "currency",
              function: "transfer",
              kwargs: { to: "mallory", amount: "500" },
              chi: 500
            }
          }
        ]
      })
    ).resolves.toMatchObject({
      status: "fulfilled",
      result: expect.objectContaining({
        txHash: "ABC123"
      })
    });

    expect(onApprovalRequested).toHaveBeenCalledTimes(2);
  });

  it("removes watched assets while keeping the native asset pinned", async () => {
    const store = createStore();
    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => createClient(),
      onApprovalRequested: vi.fn(async () => undefined)
    });

    await controller.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });

    await store.saveState({
      ...(store.current() as StoredWalletState),
      watchedAssets: [
        {
          contract: "currency",
          name: "Xian",
          symbol: "XIAN"
        },
        {
          contract: "con_token",
          name: "Example",
          symbol: "EXP"
        }
      ]
    });

    const nextState = await controller.removeWatchedAsset("con_token");
    expect(nextState.watchedAssets).toEqual([
      expect.objectContaining({
        contract: "currency"
      })
    ]);

    await expect(controller.removeWatchedAsset("currency")).rejects.toThrow(
      "native XIAN asset is pinned"
    );
  });

  it("surfaces detected assets without auto-tracking them", async () => {
    const store = createStore();
    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => createClient(),
      onApprovalRequested: vi.fn(async () => undefined)
    });

    await controller.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });

    const popupState = await controller.getPopupState();
    const detectedAssets = await controller.getDetectedAssets();

    expect(popupState.watchedAssets).toEqual([
      expect.objectContaining({ contract: "currency" })
    ]);
    expect(detectedAssets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contract: "currency",
          tracked: true,
          balance: "12"
        }),
        expect.objectContaining({
          contract: "con_token",
          tracked: false,
          balance: "8"
        })
      ])
    );
  });

  it("tracks detected assets explicitly through the wallet controller", async () => {
    const store = createStore();
    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => createClient(),
      onApprovalRequested: vi.fn(async () => undefined)
    });

    await controller.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });

    const popupState = await controller.trackAsset({
      contract: "con_token",
      name: "Example",
      symbol: "EXP"
    });

    expect(popupState.watchedAssets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contract: "currency"
        }),
        expect.objectContaining({
          contract: "con_token",
          name: "Example",
          symbol: "EXP"
        })
      ])
    );
  });

  it("normalizes JSON-encoded detected token metadata from indexed balances", async () => {
    const store = createStore();
    const client = createClient();
    client.getTokenBalances = vi.fn(async () => ({
      available: true,
      address: "alice",
      items: [
        {
          contract: "con_json_token",
          balance: "1000000",
          name: '"My Token"',
          symbol: '"MTK"',
          logoUrl: '""'
        }
      ],
      total: 1,
      limit: 100,
      offset: 0
    }));
    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client,
      onApprovalRequested: vi.fn(async () => undefined)
    });

    await controller.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });

    await expect(controller.getDetectedAssets()).resolves.toEqual([
      {
        contract: "con_json_token",
        name: "My Token",
        symbol: "MTK",
        icon: undefined,
        balance: "1000000",
        tracked: false
      }
    ]);
  });

  it("marks watched assets unavailable when the active network is missing the contract", async () => {
    const store = createStore();
    const client = createClient();
    client.getBalance = vi.fn(async (_address, options) =>
      options?.contract === "con_missing"
        ? "ImportError('Module con_missing not found')"
        : "12"
    );
    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client,
      onApprovalRequested: vi.fn(async () => undefined)
    });

    await controller.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });
    await controller.trackAsset({
      contract: "con_missing",
      name: "Missing",
      symbol: "MISS",
      icon: "https://example.com/missing.svg"
    });

    const snapshot = await controller.getAssetBalanceSnapshot();
    expect(snapshot.balances.con_missing).toBeNull();
    expect(
      snapshot.assetNetworkStates["local-node"]?.con_missing?.status
    ).toBe("not_found");
    expect((store.current() as StoredWalletState).watchedAssets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ contract: "con_missing" })
      ])
    );
  });

  it("falls back to on-chain SVG metadata when no logo URL exists", async () => {
    const store = createStore();
    const client = createClient();
    client.getTokenMetadata = vi.fn(async (contract: string) => ({
      contract,
      name: "Example",
      symbol: "EXP",
      logoUrl: null,
      logoSvg: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'></svg>"
    }));

    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client
    });

    await controller.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });

    await expect(controller.getTokenMetadata("con_token")).resolves.toEqual({
      contract: "con_token",
      name: "Example",
      symbol: "EXP",
      logoUrl: null,
      logoSvg: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'></svg>"
    });

    const popupState = await controller.trackAsset({
      contract: "con_token",
      name: "Example",
      symbol: "EXP"
    });

    expect(popupState.watchedAssets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contract: "con_token",
          icon: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'></svg>"
        })
      ])
    );
  });

  it("detects DEX deployment and returns trade snapshot state", async () => {
    const store = createStore();
    const client = createClient();
    client.getContractMethods = vi.fn(async (contract: string) =>
      contract === "con_dex"
        ? [
            { name: "swapExactTokensForTokens", arguments: [] },
            {
              name: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
              arguments: []
            }
          ]
        : []
    );
    client.getState = vi.fn(
      async (contract: string, variable: string, keys: string[] = []) => {
        if (contract === "con_pairs" && variable === "pairs_num") return 1;
        if (contract === "con_pairs" && variable === "pairs") {
          const [, field] = keys;
          if (field === "token0") return "currency";
          if (field === "token1") return "con_token";
          if (field === "reserve0") return "100";
          if (field === "reserve1") return "50";
          if (field === "totalSupply") return "70";
          if (field === "blockTimestampLast") return "2026-01-01T00:00:00Z";
          if (field === "creationTime") return "2026-01-01T00:00:00Z";
        }
        if (variable === "metadata" && keys[0] === "precision") return 8;
        if (variable === "approvals" && keys[1] === "con_dex") {
          return contract === "currency" ? "25" : "0";
        }
        if (
          contract === "con_dex" &&
          variable === "fee_on_transfer_tokens" &&
          keys[0] === "con_token"
        ) {
          return true;
        }
        return null;
      }
    );
    client.call = vi.fn(async () => 30);
    client.getBalance = vi.fn(async (_address, options) =>
      options?.contract === "currency" ? "42" : "7"
    );
    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client,
      now: vi.fn(() => 123)
    });

    await controller.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });

    const snapshot = await controller.getDexSnapshot();

    expect(snapshot.available).toBe(true);
    expect(snapshot.pairs).toEqual([
      expect.objectContaining({
        id: 1,
        token0: "currency",
        token1: "con_token",
        reserve0: 100,
        reserve1: 50
      })
    ]);
    expect(snapshot.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contract: "currency",
          balance: 42,
          allowance: 25,
          feeOnTransfer: false
        }),
        expect.objectContaining({
          contract: "con_token",
          balance: 7,
          allowance: 0,
          feeOnTransfer: true
        })
      ])
    );
  });

  it("reports DEX unavailable when con_dex swap exports are missing", async () => {
    const store = createStore();
    const client = createClient();
    client.getContractMethods = vi.fn(async () => []);
    client.getState = vi.fn(async () => null);
    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client,
      now: vi.fn(() => 123)
    });

    await controller.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });

    const snapshot = await controller.getDexSnapshot();

    expect(snapshot.available).toBe(false);
    expect(snapshot.reason).toContain("con_dex");
    expect(snapshot.pairs).toEqual([]);
    expect(snapshot.tokens).toEqual([]);
  });

  it("filters contract methods to exported functions when source metadata is available", async () => {
    const store = createStore();
    const client = createClient();
    client.getContractMethods = vi.fn(async () => [
      {
        name: "transfer",
        arguments: [
          { name: "amount", type: "float" },
          { name: "to", type: "str" }
        ]
      },
      {
        name: "balance_of",
        arguments: [{ name: "address", type: "str" }]
      },
      {
        name: "private_helper",
        arguments: []
      }
    ]);
    client.getContractSource = vi.fn(async () => `
@export
def transfer(amount: float, to: str):
    pass

@export(typecheck=False)
def balance_of(address: str):
    return 0

def private_helper():
    return "hidden"
`);

    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client
    });

    await controller.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });

    await expect(controller.getContractMethods("currency")).resolves.toEqual([
      {
        name: "transfer",
        arguments: [
          { name: "amount", type: "float" },
          { name: "to", type: "str" }
        ]
      },
      {
        name: "balance_of",
        arguments: [{ name: "address", type: "str" }]
      }
    ]);
  });

  it("filters contract methods to exported functions when IR metadata is available", async () => {
    const store = createStore();
    const client = createClient();
    client.getContractMethods = vi.fn(async () => [
      {
        name: "seed",
        arguments: [{ name: "vk", type: "str" }]
      },
      {
        name: "transfer",
        arguments: [
          { name: "amount", type: "float" },
          { name: "to", type: "str" }
        ]
      },
      {
        name: "balance_of",
        arguments: [{ name: "address", type: "str" }]
      },
      {
        name: "private_helper",
        arguments: []
      }
    ]);
    client.getContractIr = vi.fn(async () =>
      JSON.stringify({
        vm_profile: "xian_vm_v1",
        functions: [
          { name: "seed", visibility: "construct" },
          { name: "transfer", visibility: "export" },
          { name: "balance_of", decorators: [{ name: "export" }] },
          { name: "private_helper", visibility: "private" }
        ]
      })
    );
    client.getContractSource = vi.fn(async () => {
      throw new Error("source should not be needed when IR has export metadata");
    });

    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client
    });

    await controller.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });

    await expect(controller.getContractMethods("currency")).resolves.toEqual([
      {
        name: "transfer",
        arguments: [
          { name: "amount", type: "float" },
          { name: "to", type: "str" }
        ]
      },
      {
        name: "balance_of",
        arguments: [{ name: "address", type: "str" }]
      }
    ]);
    expect(client.getContractSource).not.toHaveBeenCalled();
  });

  it("falls back to source metadata when contract IR has no export flags", async () => {
    const store = createStore();
    const client = createClient();
    client.getContractMethods = vi.fn(async () => [
      {
        name: "seed",
        arguments: []
      },
      {
        name: "transfer",
        arguments: [
          { name: "amount", type: "float" },
          { name: "to", type: "str" }
        ]
      },
      {
        name: "private_helper",
        arguments: []
      }
    ]);
    client.getContractIr = vi.fn(async () =>
      JSON.stringify({
        vm_profile: "xian_vm_v1",
        functions: [
          { name: "seed", parameters: [] },
          { name: "transfer", parameters: [] },
          { name: "private_helper", parameters: [] }
        ]
      })
    );
    client.getContractSource = vi.fn(async () => `
@construct
def seed():
    pass

@export
def transfer(amount: float, to: str):
    pass

def private_helper():
    return "hidden"
`);

    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client
    });

    await controller.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });

    await expect(controller.getContractMethods("currency")).resolves.toEqual([
      {
        name: "transfer",
        arguments: [
          { name: "amount", type: "float" },
          { name: "to", type: "str" }
        ]
      }
    ]);
    expect(client.getContractSource).toHaveBeenCalledWith("currency");
  });

  it("saves network presets and switches chains through configured presets", async () => {
    const store = createStore();
    const onProviderEvent = vi.fn(async () => undefined);
    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: (state) => ({
        getChainId: vi.fn(async () =>
          state.activeNetworkId === "mainnet-preset" ? "xian-local-1" : "xian-local"
        ),
        getBalance: vi.fn(async () => "12"),
        getTokenBalances: vi.fn(async () => ({
          available: true,
          address: state.publicKey,
          items: [],
          total: 0,
          limit: 100,
          offset: 0
        })),
        getTokenMetadata: vi.fn(async (contract: string) => ({
          contract,
          name: contract,
          symbol: contract.toUpperCase(),
          logoUrl: null,
          logoSvg: null
        })),
        estimateChi: vi.fn(async () => ({
          estimated: 12_000
        })),
        getContractMethods: vi.fn(async () => []),
        buildTx: vi.fn(async (intent) => ({
          payload: {
            chain_id: intent.chainId ?? "xian-local",
            contract: intent.contract,
            function: intent.function,
            kwargs: intent.kwargs,
            nonce: 7,
            sender: intent.sender,
            chi_supplied: intent.chiSupplied ?? intent.chi ?? 50_000
          }
        })),
        signTx: vi.fn(async (tx) => ({
          payload: tx.payload,
          metadata: { signature: "signed" }
        })),
        broadcastTx: vi.fn(async (tx) => ({
          submitted: true,
          accepted: true,
          finalized: false,
          txHash: "ABC123",
          mode: "checktx",
          nonce: tx.payload.nonce,
          chiSupplied: tx.payload.chi_supplied,
          response: {}
        }))
      }),
      onApprovalRequested: vi.fn(async () => undefined),
      onProviderEvent,
      createId: vi
        .fn()
        .mockReturnValueOnce("approval-1")
        .mockReturnValueOnce("mainnet-preset")
    });

    await controller.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });

    await controller.startProviderRequest("request-1", ORIGIN, {
      method: "xian_requestAccounts"
    });
    await controller.resolveApproval("approval-1", true);

    const savedState = await controller.saveNetworkPreset({
      name: "Mainnet",
      chainId: "xian-local-1",
      rpcUrl: "https://rpc.mainnet.example",
      dashboardUrl: "https://dashboard.mainnet.example",
      makeActive: false
    });

    expect(savedState.networkPresets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "mainnet-preset",
          name: "Mainnet",
          chainId: "xian-local-1"
        })
      ])
    );
    expect(savedState.activeNetworkName).toBe("Local node");

    const switched = await controller.startProviderRequest("request-2", ORIGIN, {
      method: "xian_switchChain",
      params: [{ chainId: "xian-local-1" }]
    });

    expect(switched).toEqual({
      status: "fulfilled",
      result: null
    });

    const popupState = await controller.getPopupState();
    expect(popupState.activeNetworkId).toBe("mainnet-preset");
    expect(popupState.activeNetworkName).toBe("Mainnet");
    expect(popupState.chainId).toBe("xian-local-1");
    expect(onProviderEvent).toHaveBeenLastCalledWith(
      "chainChanged",
      ["xian-local-1"],
      ORIGIN
    );
  });

  it("rejects dismissed approvals after restart and preserves the rejection status", async () => {
    const store = createStore();
    const client = createClient();
    const createId = vi
      .fn()
      .mockReturnValueOnce("approval-connect")
      .mockReturnValueOnce("approval-sign");

    const controllerA = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client,
      onApprovalRequested: vi.fn(async () => undefined),
      createId
    });

    await controllerA.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });

    await controllerA.startProviderRequest("request-connect", ORIGIN, {
      method: "xian_requestAccounts"
    });
    await controllerA.resolveApproval("approval-connect", true);

    const start = await controllerA.startProviderRequest("request-sign", ORIGIN, {
      method: "xian_signMessage",
      params: [{ message: "sign me" }]
    });

    expect(start).toEqual({
      status: "pending",
      approvalId: "approval-sign"
    });

    const controllerB = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client,
      onApprovalRequested: vi.fn(async () => undefined)
    });

    await controllerB.unlockWallet("secret");
    await expect(controllerB.getApprovalView("approval-sign")).resolves.toMatchObject({
      title: "Sign message"
    });
    await expect(controllerB.dismissApproval("approval-sign")).resolves.toBe(true);

    await expect(controllerB.getProviderRequestStatus("request-sign")).resolves.toEqual({
      status: "rejected",
      error: expect.objectContaining({
        code: 4100,
        message: "approval dismissed",
        name: "ProviderUnauthorizedError"
      })
    });
    await expect(controllerB.dismissApproval("approval-sign")).resolves.toBe(false);
  });

  it("locks and unlocks the wallet while enforcing reconnect and password checks", async () => {
    const store = createStore();
    const client = createClient();
    const onProviderEvent = vi.fn(async () => undefined);
    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client,
      onApprovalRequested: vi.fn(async () => undefined),
      onProviderEvent,
      createId: vi.fn(() => "approval-connect")
    });

    await controller.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });

    await controller.startProviderRequest("request-connect", ORIGIN, {
      method: "xian_requestAccounts"
    });
    await controller.resolveApproval("approval-connect", true);

    const locked = await controller.lockWallet();
    expect(locked.unlocked).toBe(false);
    expect(onProviderEvent).toHaveBeenNthCalledWith(
      4,
      "accountsChanged",
      [[]],
      ORIGIN
    );
    expect(onProviderEvent).toHaveBeenNthCalledWith(
      5,
      "disconnect",
      [{ code: 4100, message: "wallet disconnected" }],
      ORIGIN
    );

    await expect(controller.unlockWallet("wrong-secret")).rejects.toThrow(
      "invalid password"
    );

    await expect(
      controller.startProviderRequest("request-sign-locked", ORIGIN, {
        method: "xian_signMessage",
        params: [{ message: "sign me" }]
      })
    ).resolves.toEqual({
      status: "rejected",
      error: expect.objectContaining({
        code: 4100,
        message: "wallet is locked",
        name: "ProviderUnauthorizedError"
      })
    });

    const accountsWhileLocked = await controller.startProviderRequest(
      "request-accounts-locked",
      ORIGIN,
      {
        method: "xian_accounts"
      }
    );
    expect(accountsWhileLocked).toEqual({
      status: "fulfilled",
      result: []
    });

    const unlocked = await controller.unlockWallet("secret");
    expect(unlocked.unlocked).toBe(true);
    expect(onProviderEvent).toHaveBeenNthCalledWith(
      6,
      "connect",
      [{ chainId: "xian-local" }],
      ORIGIN
    );
    expect(onProviderEvent).toHaveBeenNthCalledWith(
      7,
      "accountsChanged",
      [[store.current()?.publicKey]],
      ORIGIN
    );
    expect(onProviderEvent).toHaveBeenNthCalledWith(
      8,
      "chainChanged",
      ["xian-local"],
      ORIGIN
    );
  });

  it("unlocks without waiting for reconnect lifecycle broadcasts", async () => {
    const store = createStore();
    const client = createClient();
    const controllerA = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client,
      onApprovalRequested: vi.fn(async () => undefined)
    });

    await controllerA.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });
    await store.saveState({
      ...(store.current() as StoredWalletState),
      connectedOrigins: [ORIGIN]
    });
    await store.clearUnlockedSession();

    const controllerB = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client,
      onApprovalRequested: vi.fn(async () => undefined),
      onProviderEvent: vi.fn(() => new Promise<void>(() => undefined))
    });

    const unlocked = await Promise.race([
      controllerB.unlockWallet("secret"),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("unlock timed out"));
        }, 250);
      })
    ]);

    expect(unlocked.unlocked).toBe(true);
  });

  it("treats stalled chain id lookups as unreachable in popup state", async () => {
    const store = createStore();
    const client = createClient();
    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client,
      onApprovalRequested: vi.fn(async () => undefined)
    });

    await controller.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });

    vi.useFakeTimers();
    try {
      vi.mocked(client.getChainId).mockImplementation(
        () => new Promise<string>(() => undefined)
      );

      const popupPromise = controller.getPopupState();
      await vi.runOnlyPendingTimersAsync();

      await expect(popupPromise).resolves.toMatchObject({
        hasWallet: true,
        unlocked: true,
        resolvedChainId: undefined,
        networkStatus: "unreachable"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires a new connect approval after a site disconnects", async () => {
    const store = createStore();
    const client = createClient();
    const createId = vi
      .fn()
      .mockReturnValueOnce("approval-connect")
      .mockReturnValueOnce("approval-reconnect");
    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client,
      onApprovalRequested: vi.fn(async () => undefined),
      createId
    });

    await controller.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });

    await controller.startProviderRequest("request-connect", ORIGIN, {
      method: "xian_requestAccounts"
    });
    await controller.resolveApproval("approval-connect", true);
    await controller.disconnectOrigin(ORIGIN);

    await expect(
      controller.startProviderRequest("request-sign", ORIGIN, {
        method: "xian_signMessage",
        params: [{ message: "hello again" }]
      })
    ).resolves.toEqual({
      status: "rejected",
      error: expect.objectContaining({
        code: 4100,
        message: "site is not connected to this wallet",
        name: "ProviderUnauthorizedError"
      })
    });

    await expect(
      controller.startProviderRequest("request-reconnect", ORIGIN, {
        method: "xian_requestAccounts"
      })
    ).resolves.toEqual({
      status: "pending",
      approvalId: "approval-reconnect"
    });
  });

  it("restores a valid unlocked session after controller restart and locks after expiry", async () => {
    const store = createStore();
    const client = createClient();
    const baseNow = 1_000_000;

    const controllerA = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client,
      onApprovalRequested: vi.fn(async () => undefined),
      now: vi.fn(() => baseNow)
    });

    const created = await controllerA.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });

    expect(store.currentSession()).toMatchObject({
      publicKey: created.popupState.publicKey,
      expiresAt: baseNow + 5 * 60 * 1000
    });
    expect(store.currentSession()).not.toHaveProperty("privateKey");
    expect(store.currentSession()).not.toHaveProperty("mnemonic");
    expect(store.currentSession()).toHaveProperty("sessionKey", expect.any(String));

    const controllerB = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client,
      onApprovalRequested: vi.fn(async () => undefined),
      now: vi.fn(() => baseNow + 60_000)
    });

    const popupAfterRestart = await controllerB.getPopupState();
    expect(popupAfterRestart.unlocked).toBe(true);
    expect(popupAfterRestart.publicKey).toBe(created.popupState.publicKey);
    expect(store.currentSession()).toMatchObject({
      publicKey: created.popupState.publicKey,
      expiresAt: baseNow + 5 * 60 * 1000
    });

    const controllerC = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client,
      onApprovalRequested: vi.fn(async () => undefined),
      now: vi.fn(() => baseNow + 5 * 60 * 1000 + 1)
    });

    const popupAfterExpiry = await controllerC.getPopupState();
    expect(popupAfterExpiry.unlocked).toBe(false);
    expect(store.currentSession()).toBeNull();
  });

  it("expires the active in-memory session and reports locked popup state", async () => {
    const store = createStore();
    const client = createClient();
    const baseNow = 1_000_000;
    let now = baseNow;
    const onProviderEvent = vi.fn(async () => undefined);
    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client,
      onApprovalRequested: vi.fn(async () => undefined),
      onProviderEvent,
      createId: vi.fn(() => "approval-connect"),
      now: vi.fn(() => now)
    });

    const created = await controller.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });

    expect(created.popupState).toMatchObject({
      unlocked: true,
      sessionExpiresAt: baseNow + UNLOCKED_SESSION_TIMEOUT_MS
    });

    await controller.startProviderRequest("request-connect", ORIGIN, {
      method: "xian_requestAccounts"
    });
    await controller.resolveApproval("approval-connect", true);

    now = baseNow + UNLOCKED_SESSION_TIMEOUT_MS + 1;

    const popupAfterExpiry = await controller.getPopupState();
    expect(popupAfterExpiry.unlocked).toBe(false);
    expect(popupAfterExpiry.sessionExpiresAt).toBeUndefined();
    expect(store.currentSession()).toBeNull();
    expect(onProviderEvent).toHaveBeenNthCalledWith(
      4,
      "accountsChanged",
      [[]],
      ORIGIN
    );
    expect(onProviderEvent).toHaveBeenNthCalledWith(
      5,
      "disconnect",
      [{ code: 4100, message: "wallet disconnected" }],
      ORIGIN
    );

    await expect(
      controller.startProviderRequest("request-sign-expired", ORIGIN, {
        method: "xian_signMessage",
        params: [{ message: "sign me" }]
      })
    ).resolves.toEqual({
      status: "rejected",
      error: expect.objectContaining({
        code: 4100,
        message: "wallet is locked",
        name: "ProviderUnauthorizedError"
      })
    });
  });

  it("keeps the current session unlocked when auto-lock is disabled and restores five-minute expiry on the next unlock", async () => {
    const store = createStore();
    const client = createClient();
    const baseNow = 1_000_000;
    let now = baseNow;
    let autoLockEnabled = false;
    const getUnlockedSessionExpiry = vi.fn((currentNow: number) =>
      autoLockEnabled ? currentNow + UNLOCKED_SESSION_TIMEOUT_MS : Number.MAX_SAFE_INTEGER
    );

    const controllerA = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client,
      onApprovalRequested: vi.fn(async () => undefined),
      now: vi.fn(() => now),
      getUnlockedSessionExpiry
    });

    const created = await controllerA.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });

    expect(store.currentSession()).toMatchObject({
      publicKey: created.popupState.publicKey,
      expiresAt: Number.MAX_SAFE_INTEGER
    });

    now = baseNow + 10 * 60 * 1000;
    autoLockEnabled = true;

    await controllerA.sendDirectTransaction({
      contract: "currency",
      function: "transfer",
      kwargs: { to: "bob", amount: "5" }
    });

    expect(store.currentSession()).toMatchObject({
      publicKey: created.popupState.publicKey,
      expiresAt: Number.MAX_SAFE_INTEGER
    });

    await controllerA.lockWallet();

    const relockNow = baseNow + 11 * 60 * 1000;
    const controllerC = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client,
      onApprovalRequested: vi.fn(async () => undefined),
      now: vi.fn(() => relockNow),
      getUnlockedSessionExpiry
    });

    await controllerC.unlockWallet("secret");

    expect(store.currentSession()).toMatchObject({
      expiresAt: relockNow + UNLOCKED_SESSION_TIMEOUT_MS
    });
    expect(store.currentSession()).not.toHaveProperty("privateKey");
    expect(store.currentSession()).not.toHaveProperty("mnemonic");
    expect(store.currentSession()).toHaveProperty("sessionKey", expect.any(String));
  });

  it("stores shielded snapshots, includes them in wallet backups, and restores them on import", async () => {
    const store = createStore();
    const createId = vi
      .fn()
      .mockReturnValueOnce("snapshot-1")
      .mockReturnValueOnce("imported-snapshot-1");
    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => createClient(),
      onApprovalRequested: vi.fn(async () => undefined),
      createId
    });

    await controller.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });

    const saved = await controller.saveShieldedWalletSnapshot(
      SHIELDED_STATE_SNAPSHOT,
      "Treasury shielded"
    );
    expect(saved.shieldedWalletSnapshots).toEqual([
      expect.objectContaining({
        id: "snapshot-1",
        label: "Treasury shielded",
        assetId: "con_private",
        noteCount: 0,
        commitmentCount: 0
      })
    ]);

    const backup = await controller.exportWallet("backup-pass");
    expect(backup.version).toBe(2);
    expect(JSON.stringify(backup)).not.toContain(PRIVATE_KEY);
    expect(JSON.stringify(backup)).not.toContain(SHIELDED_STATE_SNAPSHOT);
    await expect(decryptWalletBackup(backup, "wrong-pass")).rejects.toThrow(
      "invalid password"
    );

    const decryptedBackup = await decryptWalletBackup(backup, "backup-pass");
    expect(decryptedBackup.shieldedStateSnapshots).toEqual([
      {
        label: "Treasury shielded",
        stateSnapshot: JSON.stringify(JSON.parse(SHIELDED_STATE_SNAPSHOT))
      }
    ]);

    const importStore = createStore();
    const importingController = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store: importStore,
      createClient: () => createClient(),
      onApprovalRequested: vi.fn(async () => undefined),
      createId
    });

    const imported = await importingController.importWalletBackup(backup, "backup-pass");
    expect(imported.shieldedWalletSnapshots).toEqual([
      expect.objectContaining({
        id: "imported-snapshot-1",
        label: "Treasury shielded",
        assetId: "con_private"
      })
    ]);

    const exportedSnapshot =
      await importingController.exportShieldedWalletSnapshot(
        "imported-snapshot-1",
        "restored"
      );
    expect(exportedSnapshot).toEqual({
      label: "Treasury shielded",
      stateSnapshot: JSON.stringify(JSON.parse(SHIELDED_STATE_SNAPSHOT))
    });

    const afterRemoval =
      await importingController.removeShieldedWalletSnapshot(
        "imported-snapshot-1"
      );
    expect(afterRemoval.shieldedWalletSnapshots).toEqual([]);
  });

  it("surfaces whether indexed shielded history has advanced past a stored snapshot", async () => {
    const store = createStore();
    const client = createClient();
    client.getShieldedWalletHistory = vi.fn(async () => ({
      available: true,
      items: [
        {
          eventId: 10,
          txHash: "TX-1",
          blockHeight: 12,
          txIndex: 0,
          contract: "con_private",
          function: "transfer_shielded",
          action: "transfer",
          outputIndex: 0,
          noteIndex: 1,
          commitment: "0xabc",
          newRoot: "0xroot",
          payloadHash: "0xhash",
          tagKind: "sync_hint",
          tagValue: "0xtag",
          outputPayload: "0xpayload",
          createdAt: "2026-04-10T12:00:00Z",
          raw: {}
        }
      ],
      limit: 3,
      afterNoteIndex: 0
    }));
    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client,
      onApprovalRequested: vi.fn(async () => undefined),
      createId: vi.fn(() => "snapshot-1")
    });

    await controller.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });
    await controller.saveShieldedWalletSnapshot(
      SHIELDED_STATE_SNAPSHOT,
      "Treasury shielded"
    );

    await expect(
      controller.getShieldedWalletSnapshotHistory("snapshot-1", 3)
    ).resolves.toEqual({
      snapshotId: "snapshot-1",
      label: "Treasury shielded",
      available: true,
      hasNewerIndexedHistory: true,
      checkedAfterNoteIndex: 0,
      newItems: [
        {
          txHash: "TX-1",
          blockHeight: 12,
          function: "transfer_shielded",
          action: "transfer",
          noteIndex: 1,
          commitment: "0xabc",
          hasPayload: true,
          createdAt: "2026-04-10T12:00:00Z"
        }
      ]
    });
  });

  it("re-syncs the unlocked signer when the active account is removed", async () => {
    const store = createStore();
    const client = createClient();
    const onProviderEvent = vi.fn(async () => undefined);
    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => client,
      onApprovalRequested: vi.fn(async () => undefined),
      onProviderEvent,
      createId: vi.fn(() => "approval-connect")
    });

    const created = await controller.createOrImportWallet({
      password: "secret",
      createWithMnemonic: true
    });
    const primaryPublicKey = created.popupState.publicKey;

    await controller.startProviderRequest("request-connect", ORIGIN, {
      method: "xian_requestAccounts"
    });
    await controller.resolveApproval("approval-connect", true);
    const addedAccountState = await controller.addAccount();
    expect(addedAccountState.publicKey).not.toBe(primaryPublicKey);

    onProviderEvent.mockClear();

    const nextState = await controller.removeAccount(
      addedAccountState.activeAccountIndex
    );
    expect(nextState.publicKey).toBe(primaryPublicKey);
    expect(nextState.unlocked).toBe(true);

    await controller.sendDirectTransaction({
      contract: "currency",
      function: "transfer",
      kwargs: { to: "bob", amount: "5" }
    });

    expect(client.buildTx).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sender: primaryPublicKey
      })
    );
    expect(onProviderEvent).toHaveBeenCalledWith(
      "accountsChanged",
      [[primaryPublicKey]],
      ORIGIN
    );
  });

  it("round-trips the active account and network through wallet backups", async () => {
    const store = createStore();
    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => createClient(),
      onApprovalRequested: vi.fn(async () => undefined),
      createId: vi.fn(() => "mainnet-preset")
    });

    await controller.createOrImportWallet({
      password: "secret",
      createWithMnemonic: true
    });
    const accountTwo = await controller.addAccount();

    await controller.saveNetworkPreset({
      name: "Mainnet",
      chainId: "xian-local-1",
      rpcUrl: "https://rpc.mainnet.example",
      dashboardUrl: "https://dashboard.mainnet.example",
      makeActive: true
    });

    const backup = await controller.exportWallet("backup-pass");
    const decryptedBackup = await decryptWalletBackup(backup, "backup-pass");
    expect(decryptedBackup.activeAccountIndex).toBe(accountTwo.activeAccountIndex);
    expect(decryptedBackup.activeNetworkId).toBe("mainnet-preset");

    const restored = await controller.importWalletBackup(backup, "backup-pass");
    expect(restored.activeAccountIndex).toBe(accountTwo.activeAccountIndex);
    expect(restored.publicKey).toBe(accountTwo.publicKey);
    expect(restored.activeNetworkId).toBe("mainnet-preset");
    expect(store.currentSession()).toMatchObject({
      publicKey: restored.publicKey
    });
    expect(store.currentSession()).not.toHaveProperty("privateKey");
    expect(store.currentSession()).not.toHaveProperty("mnemonic");
    expect(store.currentSession()).toHaveProperty("sessionKey", expect.any(String));

    await expect(controller.addAccount()).resolves.toMatchObject({
      activeAccountIndex: 2
    });
  });

  it("requires explicit opt-in for remote HTTP network presets", async () => {
    const store = createStore();
    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => createClient(),
      onApprovalRequested: vi.fn(async () => undefined),
      createId: vi.fn(() => "lan-preset")
    });

    await controller.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });

    await expect(
      controller.saveNetworkPreset({
        name: "LAN node",
        rpcUrl: "http://192.168.1.10:26657"
      })
    ).rejects.toThrow("HTTP RPC URLs are disabled");

    const updated = await controller.saveNetworkPreset({
      name: "LAN node",
      rpcUrl: "http://192.168.1.10:26657",
      allowInsecureHttp: true,
      makeActive: true
    });

    expect(updated.networkPresets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "lan-preset",
          rpcUrl: "http://192.168.1.10:26657",
          allowInsecureHttp: true
        })
      ])
    );
  });

  it("rejects pending requests when the wallet is replaced", async () => {
    const store = createStore();
    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => createClient(),
      onApprovalRequested: vi.fn(async () => undefined),
      createId: vi.fn(() => "approval-1")
    });

    await controller.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });
    await controller.startProviderRequest("request-connect", ORIGIN, {
      method: "xian_requestAccounts"
    });
    await controller.resolveApproval("approval-1", true);

    await controller.startProviderRequest("request-sign", ORIGIN, {
      method: "xian_signMessage",
      params: [{ message: "replace me" }]
    });

    await controller.createOrImportWallet({
      password: "secret-2",
      privateKey: "22".repeat(32)
    });

    await expect(controller.getApprovalView("approval-1")).rejects.toThrow(
      "approval request not found"
    );
    await expect(controller.getProviderRequestStatus("request-sign")).resolves.toEqual({
      status: "rejected",
      error: expect.objectContaining({
        code: 4100,
        message: "wallet was replaced",
        name: "ProviderUnauthorizedError"
      })
    });
  });

  it("rejects pending requests when the wallet is removed", async () => {
    const store = createStore();
    const controller = new WalletController({
      wallet: {
        id: "xian-wallet",
        name: "Xian Wallet",
        rdns: "org.xian.wallet"
      },
      version: "0.1.0-test",
      store,
      createClient: () => createClient(),
      onApprovalRequested: vi.fn(async () => undefined),
      createId: vi.fn(() => "approval-1")
    });

    await controller.createOrImportWallet({
      password: "secret",
      privateKey: PRIVATE_KEY
    });
    await controller.startProviderRequest("request-connect", ORIGIN, {
      method: "xian_requestAccounts"
    });
    await controller.resolveApproval("approval-1", true);

    await controller.startProviderRequest("request-sign", ORIGIN, {
      method: "xian_signMessage",
      params: [{ message: "remove me" }]
    });

    await controller.removeWallet();

    await expect(controller.getApprovalView("approval-1")).rejects.toThrow(
      "approval request not found"
    );
    await expect(controller.getProviderRequestStatus("request-sign")).resolves.toEqual({
      status: "rejected",
      error: expect.objectContaining({
        code: 4100,
        message: "wallet was removed",
        name: "ProviderUnauthorizedError"
      })
    });
  });
});
