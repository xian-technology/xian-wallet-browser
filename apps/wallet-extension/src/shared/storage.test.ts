import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PREFERENCES_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  STORAGE_KEY,
  STORAGE_SCHEMA_VERSION,
  clearWalletState,
  clearUnlockedSession,
  loadUnlockedSession,
  loadWalletShellMode,
  loadApprovalState,
  loadRequestState,
  loadWalletState,
  saveUnlockedSession,
  saveWalletShellMode,
  saveApprovalState,
  saveRequestState
} from "./storage";

let storage: Record<string, unknown>;
let sessionStorage: Record<string, unknown>;

function installChromeMock(): void {
  vi.stubGlobal("chrome", {
    runtime: {
      lastError: undefined
    },
    storage: {
      local: {
        get(keys: string[], callback: (result: Record<string, unknown>) => void) {
          const [key] = keys;
          if (!key) {
            callback({});
            return;
          }
          callback({ [key]: storage[key] });
        },
        set(value: Record<string, unknown>, callback: () => void) {
          Object.assign(storage, value);
          callback();
        }
      },
      session: {
        get(keys: string[], callback: (result: Record<string, unknown>) => void) {
          const [key] = keys;
          if (!key) {
            callback({});
            return;
          }
          callback({ [key]: sessionStorage[key] });
        },
        set(value: Record<string, unknown>, callback: () => void) {
          Object.assign(sessionStorage, value);
          callback();
        },
        remove(key: string, callback: () => void) {
          delete sessionStorage[key];
          callback();
        }
      }
    }
  });
}

describe("wallet-extension storage", () => {
  beforeEach(() => {
    storage = {};
    sessionStorage = {};
    installChromeMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("migrates legacy wallet state into the versioned envelope", async () => {
    storage[STORAGE_KEY] = {
      publicKey: "a".repeat(64),
      encryptedPrivateKey: "ciphertext",
      rpcUrl: "http://legacy-rpc",
      dashboardUrl: "http://legacy-dashboard",
      watchedAssets: [],
      connectedOrigins: ["https://app.example"],
      createdAt: "2026-01-01T00:00:00.000Z"
    };

    const state = await loadWalletState();

    expect(state).toMatchObject({
      publicKey: "a".repeat(64),
      seedSource: "privateKey",
      connectedOrigins: ["https://app.example"],
      activeNetworkId: "custom-network",
      networkPresets: [
        expect.objectContaining({
          id: "local-node"
        }),
        expect.objectContaining({
          id: "custom-network",
          rpcUrl: "http://legacy-rpc",
          dashboardUrl: "http://legacy-dashboard"
        })
      ]
    });
    expect(storage[STORAGE_KEY]).toMatchObject({
      version: STORAGE_SCHEMA_VERSION,
      wallet: expect.objectContaining({
        publicKey: "a".repeat(64),
        seedSource: "privateKey",
        activeNetworkId: "custom-network"
      })
    });
  });

  it("round-trips bigint data in persisted requests and approvals", async () => {
    await saveRequestState({
      requestId: "request-1",
      origin: "https://app.example",
      request: {
        method: "xian_sendCall",
        params: [
          {
            intent: {
              contract: "currency",
              function: "transfer",
              kwargs: { amount: 5n },
              stamps: 500n
            }
          }
        ]
      },
      createdAt: 1,
      updatedAt: 2,
      status: "fulfilled",
      result: {
        payload: {
          nonce: 7n,
          stamps_supplied: 500n
        }
      }
    });

    await saveApprovalState({
      id: "approval-1",
      requestId: "request-1",
      record: {
        id: "approval-1",
        origin: "https://app.example",
        kind: "sendCall",
        request: {
          method: "xian_sendCall"
        },
        createdAt: 3
      },
      view: {
        id: "approval-1",
        origin: "https://app.example",
        kind: "sendCall",
        title: "Send contract call",
        description: "desc",
        payload: "{}",
        createdAt: 3
      },
      windowId: 42
    });

    const request = await loadRequestState("request-1");
    const approval = await loadApprovalState("approval-1");

    expect(request?.request.params).toEqual([
      {
        intent: {
          contract: "currency",
          function: "transfer",
          kwargs: { amount: 5n },
          stamps: 500n
        }
      }
    ]);
    expect(request?.result).toEqual({
      payload: {
        nonce: 7n,
        stamps_supplied: 500n
      }
    });
    expect(approval?.windowId).toBe(42);
  });

  it("round-trips unlocked session state through chrome.storage.session", async () => {
    await saveUnlockedSession({
      privateKey: "11".repeat(32),
      expiresAt: 12345
    });

    expect(sessionStorage[SESSION_STORAGE_KEY]).toEqual({
      privateKey: "11".repeat(32),
      expiresAt: 12345
    });
    expect(await loadUnlockedSession()).toEqual({
      privateKey: "11".repeat(32),
      expiresAt: 12345
    });

    await clearUnlockedSession();
    expect(await loadUnlockedSession()).toBeNull();
  });

  it("persists the preferred wallet shell mode", async () => {
    expect(await loadWalletShellMode()).toBe("popup");

    await saveWalletShellMode("sidePanel");

    expect(storage[PREFERENCES_STORAGE_KEY]).toBe("sidePanel");
    expect(await loadWalletShellMode()).toBe("sidePanel");
  });

  it("clears only the wallet state while preserving request history", async () => {
    storage[STORAGE_KEY] = {
      version: STORAGE_SCHEMA_VERSION,
      wallet: {
        publicKey: "a".repeat(64),
        encryptedPrivateKey: "ciphertext",
        seedSource: "privateKey",
        rpcUrl: "http://legacy-rpc",
        dashboardUrl: "http://legacy-dashboard",
        activeNetworkId: "custom-network",
        networkPresets: [
          {
            id: "custom-network",
            name: "Custom network",
            rpcUrl: "http://legacy-rpc",
            dashboardUrl: "http://legacy-dashboard"
          }
        ],
        watchedAssets: [],
        connectedOrigins: [],
        createdAt: "2026-01-01T00:00:00.000Z"
      },
      providerRequests: {
        "request-1": {
          requestId: "request-1",
          origin: "https://app.example",
          request: { method: "xian_signMessage", params: [{ message: "hi" }] },
          createdAt: 1,
          updatedAt: 2,
          status: "rejected",
          error: {
            name: "ProviderUnauthorizedError",
            message: "wallet was removed",
            code: 4100
          }
        }
      },
      approvals: {}
    };

    await clearWalletState();

    expect(await loadWalletState()).toBeNull();
    expect(await loadRequestState("request-1")).toEqual(
      expect.objectContaining({
        status: "rejected"
      })
    );
  });
});
