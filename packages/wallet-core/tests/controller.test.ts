import { describe, expect, it, vi } from "vitest";

import type {
  TransactionSubmission,
  XianSignedTransaction,
  XianUnsignedTransaction
} from "@xian/provider";

import {
  WalletController,
  type PersistedApproval,
  type StoredProviderRequest,
  type StoredWalletState,
  type WalletControllerStore,
  type WalletNetworkClient
} from "../src/index";

const PRIVATE_KEY = "11".repeat(32);
const ORIGIN = "https://app.example";

interface MemoryStore extends WalletControllerStore {
  current(): StoredWalletState | null;
  currentRequests(): Record<string, StoredProviderRequest>;
  currentApprovals(): Record<string, PersistedApproval>;
}

function createStore(): MemoryStore {
  let state: StoredWalletState | null = null;
  const requests: Record<string, StoredProviderRequest> = {};
  const approvals: Record<string, PersistedApproval> = {};

  return {
    async loadState() {
      return state;
    },
    async saveState(nextState) {
      state = nextState;
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
    buildTx: vi.fn(async (intent) => ({
      payload: {
        chain_id: intent.chainId ?? "xian-local",
        contract: intent.contract,
        function: intent.function,
        kwargs: intent.kwargs,
        nonce: 7,
        sender: intent.sender,
        stamps_supplied: intent.stampsSupplied ?? intent.stamps ?? 50_000
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
        stampsSupplied: tx.payload.stamps_supplied,
        response: {}
      })
    )
  };
}

describe("@xian/wallet-core controller", () => {
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
            stamps: 500
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
        stamps: 500
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

    await controller.startProviderRequest("request-1", ORIGIN, {
      method: "xian_requestAccounts"
    });

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

    const disconnectedState = await controller.disconnectOrigin(ORIGIN);
    expect(disconnectedState.connectedOrigins).toEqual([]);
    expect(onProviderEvent).toHaveBeenLastCalledWith(
      "disconnect",
      [{ code: 4100, message: "wallet disconnected" }],
      ORIGIN
    );
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
          state.activeNetworkId === "mainnet-preset" ? "xian-1" : "xian-local"
        ),
        buildTx: vi.fn(async (intent) => ({
          payload: {
            chain_id: intent.chainId ?? "xian-local",
            contract: intent.contract,
            function: intent.function,
            kwargs: intent.kwargs,
            nonce: 7,
            sender: intent.sender,
            stamps_supplied: intent.stampsSupplied ?? intent.stamps ?? 50_000
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
          stampsSupplied: tx.payload.stamps_supplied,
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
      chainId: "xian-1",
      rpcUrl: "https://rpc.mainnet.example",
      dashboardUrl: "https://dashboard.mainnet.example",
      makeActive: false
    });

    expect(savedState.networkPresets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "mainnet-preset",
          name: "Mainnet",
          chainId: "xian-1"
        })
      ])
    );
    expect(savedState.activeNetworkName).toBe("Local node");

    const switched = await controller.startProviderRequest("request-2", ORIGIN, {
      method: "xian_switchChain",
      params: [{ chainId: "xian-1" }]
    });

    expect(switched).toEqual({
      status: "fulfilled",
      result: null
    });

    const popupState = await controller.getPopupState();
    expect(popupState.activeNetworkId).toBe("mainnet-preset");
    expect(popupState.activeNetworkName).toBe("Mainnet");
    expect(popupState.chainId).toBe("xian-1");
    expect(onProviderEvent).toHaveBeenLastCalledWith(
      "chainChanged",
      ["xian-1"],
      ORIGIN
    );
  });
});
