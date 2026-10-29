import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTO_LOCK_STORAGE_KEY,
  PREFERENCES_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  STORAGE_KEY,
  STORAGE_SCHEMA_VERSION,
  claimApprovalExecution,
  clearWalletState,
  clearUnlockedSession,
  loadAutoLock,
  loadUnlockedSession,
  loadWalletShellMode,
  loadApprovalState,
  loadLocalActivityTxs,
  loadRequestState,
  loadWalletState,
  saveWalletState,
  replaceWalletState,
  saveAutoLock,
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

  it("atomically claims an approval once and preserves concurrent request writes", async () => {
    const request = { requestId: "request", origin: "https://dapp.example", request: { method: "xian_requestAccounts" },
      createdAt: 1, updatedAt: 1, status: "pending" as const, approvalId: "approval" };
    const approval = { id: "approval", requestId: "request",
      record: { id: "approval", kind: "connect" as const, origin: request.origin, request: request.request, createdAt: 1 },
      view: { id: "approval", kind: "connect" as const, origin: request.origin, title: "Connect", description: "Connect request", payload: "{}", createdAt: 1 } };
    await Promise.all([saveRequestState(request), saveApprovalState(approval)]);
    const claims = await Promise.all([claimApprovalExecution("approval", 2), claimApprovalExecution("approval", 3)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await loadApprovalState("approval")).toBeNull();
    expect((await loadRequestState("request"))?.execution).toEqual({ startedAt: 2 });
    await Promise.all(Array.from({ length: 8 }, (_, i) => saveRequestState({ ...request, requestId: `other-${i}` })));
    for (let i = 0; i < 8; i++) expect(await loadRequestState(`other-${i}`)).not.toBeNull();
    expect(await claimApprovalExecution("approval", 4)).toBeNull();
  });

  it("loads versioned wallet state from the storage envelope", async () => {
    storage[STORAGE_KEY] = {
      version: STORAGE_SCHEMA_VERSION,
      wallet: {
        publicKey: "a".repeat(64),
        encryptedPrivateKey: "ciphertext",
        walletEncryptionSalt: "salt",
        seedSource: "privateKey",
        rpcUrl: "http://custom-rpc",
        dashboardUrl: "http://custom-dashboard",
        activeNetworkId: "custom-network",
        networkPresets: [
          {
            id: "custom-network",
            name: "Custom network",
            rpcUrl: "http://custom-rpc",
            dashboardUrl: "http://custom-dashboard"
          }
        ],
        watchedAssets: [],
        shieldedWalletSnapshots: [
          {
            id: "snapshot-1",
            label: "Treasury shielded",
            assetId: "con_private",
            syncHint: "0xsync",
            encryptedStateSnapshot: "encrypted-json",
            noteCount: 2,
            commitmentCount: 3,
            lastScannedIndex: 4,
            updatedAt: "2026-01-02T00:00:00.000Z"
          },
          {
            id: "invalid-snapshot",
            label: "Missing encrypted payload"
          }
        ],
        connectedOrigins: ["https://app.example"],
        createdAt: "2026-01-01T00:00:00.000Z"
      },
      providerRequests: {},
      approvals: {}
    };

    const state = await loadWalletState();

    expect(state).toMatchObject({
      publicKey: "a".repeat(64),
      seedSource: "privateKey",
      connectedOrigins: ["https://app.example"],
      shieldedWalletSnapshots: [
        {
          id: "snapshot-1",
          label: "Treasury shielded",
          assetId: "con_private",
          syncHint: "0xsync",
          encryptedStateSnapshot: "encrypted-json",
          noteCount: 2,
          commitmentCount: 3,
          lastScannedIndex: 4,
          updatedAt: "2026-01-02T00:00:00.000Z"
        }
      ],
      activeNetworkId: "custom-network",
      networkPresets: [
        expect.objectContaining({
          id: "custom-network",
          rpcUrl: "http://custom-rpc",
          dashboardUrl: "http://custom-dashboard"
        })
      ]
    });
    expect(storage[STORAGE_KEY]).toMatchObject({
      wallet: expect.objectContaining({
        publicKey: "a".repeat(64),
        walletEncryptionSalt: "salt",
        seedSource: "privateKey",
        activeNetworkId: "custom-network"
      })
    });
  });

  it("replaces only the expected normalized wallet record", async () => {
    storage[STORAGE_KEY] = {
      version: STORAGE_SCHEMA_VERSION,
      wallet: { publicKey: "a".repeat(64), encryptedPrivateKey: "ciphertext", walletEncryptionSalt: "salt" }
    };
    const original = (await loadWalletState())!;
    const upgraded = { ...original, walletEncryptionIterations: 600_000 };
    expect(await replaceWalletState(original, upgraded)).toBe(true);
    await expect(saveWalletState(original)).rejects.toThrow("stale wallet encryption state");
    expect((await loadWalletState())!.walletEncryptionIterations).toBe(600_000);
    const settings = { ...upgraded, createdAt: "new-settings-revision" };
    await saveWalletState(settings);
    expect(await replaceWalletState(upgraded, original)).toBe(false);
    expect((await loadWalletState())!.createdAt).toBe(settings.createdAt);
    await clearWalletState();
    expect(await replaceWalletState(settings, upgraded)).toBe(false);
    expect(await loadWalletState()).toBeNull();
  });

  it("allows an explicit wallet replacement after a stronger imported work factor", async () => {
    storage[STORAGE_KEY] = {
      version: STORAGE_SCHEMA_VERSION,
      wallet: { publicKey: "a".repeat(64), encryptedPrivateKey: "ciphertext", walletEncryptionSalt: "salt", walletEncryptionIterations: 2_000_000 }
    };
    const current = (await loadWalletState())!;
    const replacement = { ...current, publicKey: "b".repeat(64), walletEncryptionIterations: 600_000 };
    await expect(saveWalletState(replacement)).rejects.toThrow("stale wallet encryption state");
    await saveWalletState(replacement, { replace: true });
    expect((await loadWalletState())!.publicKey).toBe(replacement.publicKey);
    expect((await loadWalletState())!.walletEncryptionIterations).toBe(600_000);
  });

  it("rejects stale saves after removal or same-work-factor replacement", async () => {
    storage[STORAGE_KEY] = {
      version: STORAGE_SCHEMA_VERSION,
      wallet: { publicKey: "a".repeat(64), encryptedPrivateKey: "ciphertext", walletEncryptionSalt: "old-salt", walletEncryptionIterations: 600_000 }
    };
    const stale = (await loadWalletState())!;
    await clearWalletState();
    await expect(saveWalletState(stale)).rejects.toThrow("stale wallet encryption state");
    expect(await loadWalletState()).toBeNull();
    const replacement = { ...stale, walletEncryptionSalt: "new-salt" };
    await saveWalletState(replacement, { replace: true });
    await expect(saveWalletState(stale)).rejects.toThrow("stale wallet encryption state");
    expect((await loadWalletState())!.walletEncryptionSalt).toBe("new-salt");
  });

  it.each([250_000, 600_000, undefined, 2_000_001, "600000"])("preserves or rejects stored work factor %s", async (iterations) => {
    storage[STORAGE_KEY] = {
      version: STORAGE_SCHEMA_VERSION,
      wallet: {
        publicKey: "a".repeat(64), encryptedPrivateKey: "ciphertext",
        walletEncryptionSalt: "salt", walletEncryptionIterations: iterations
      }, providerRequests: {}, approvals: {}
    };
    const state = await loadWalletState();
    if (iterations === 2_000_001 || typeof iterations === "string") {
      expect(state).toBeNull();
    } else {
      expect(state).not.toBeNull();
      expect(state?.walletEncryptionIterations).toBe(iterations);
    }
  });

  it("ignores unversioned wallet state", async () => {
    storage[STORAGE_KEY] = {
      publicKey: "a".repeat(64),
      encryptedPrivateKey: "ciphertext",
      walletEncryptionSalt: "salt",
      seedSource: "privateKey",
      createdAt: "2026-01-01T00:00:00.000Z"
    };

    expect(await loadWalletState()).toBeNull();
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
              chi: 500n
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
          chi_supplied: 500n
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
          chi: 500n
        }
      }
    ]);
    expect(request?.result).toEqual({
      payload: {
        nonce: 7n,
        chi_supplied: 500n
      }
    });
    expect(approval?.windowId).toBe(42);
  });

  it("ignores local activity records without canonical tx_hash", async () => {
    storage.xianWalletLocalActivity = {
      "local|http://127.0.0.1:26657|sender": [
        {
          hash: "legacy-hash",
          sender: "sender",
          contract: "currency",
          function: "transfer",
          success: true,
          local: true
        }
      ]
    };

    await expect(
      loadLocalActivityTxs("local|http://127.0.0.1:26657|sender")
    ).resolves.toEqual([]);
  });

  it("round-trips unlocked session state through chrome.storage.session", async () => {
    await saveUnlockedSession({
      publicKey: "22".repeat(32),
      expiresAt: 12345,
      sessionKey: "session-key"
    });

    expect(sessionStorage[SESSION_STORAGE_KEY]).toEqual({
      publicKey: "22".repeat(32),
      expiresAt: 12345,
      sessionKey: "session-key"
    });
    expect(await loadUnlockedSession()).toEqual({
      publicKey: "22".repeat(32),
      expiresAt: 12345,
      sessionKey: "session-key"
    });

    await clearUnlockedSession();
    expect(await loadUnlockedSession()).toBeNull();
  });

  it("clears legacy unlocked sessions that contain raw secrets", async () => {
    sessionStorage[SESSION_STORAGE_KEY] = {
      privateKey: "11".repeat(32),
      mnemonic: "test test test",
      sessionKey: "session-key",
      expiresAt: 12345
    };

    expect(await loadUnlockedSession()).toBeNull();
    expect(sessionStorage[SESSION_STORAGE_KEY]).toBeUndefined();
  });

  it("persists the preferred wallet shell mode", async () => {
    expect(await loadWalletShellMode()).toBe("popup");

    await saveWalletShellMode("sidePanel");

    expect(storage[PREFERENCES_STORAGE_KEY]).toBe("sidePanel");
    expect(await loadWalletShellMode()).toBe("sidePanel");
  });

  it("defaults auto-lock to enabled and persists explicit overrides", async () => {
    expect(await loadAutoLock()).toBe(true);

    await saveAutoLock(false);

    expect(storage[AUTO_LOCK_STORAGE_KEY]).toBe(false);
    expect(await loadAutoLock()).toBe(false);

    await saveAutoLock(true);

    expect(storage[AUTO_LOCK_STORAGE_KEY]).toBe(true);
    expect(await loadAutoLock()).toBe(true);
  });

  it("clears only the wallet state while preserving request history", async () => {
    storage[STORAGE_KEY] = {
      version: STORAGE_SCHEMA_VERSION,
      wallet: {
        publicKey: "a".repeat(64),
        encryptedPrivateKey: "ciphertext",
        walletEncryptionSalt: "salt",
        seedSource: "privateKey",
        rpcUrl: "http://custom-rpc",
        dashboardUrl: "http://custom-dashboard",
        activeNetworkId: "custom-network",
        networkPresets: [
          {
            id: "custom-network",
            name: "Custom network",
            rpcUrl: "http://custom-rpc",
            dashboardUrl: "http://custom-dashboard"
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
