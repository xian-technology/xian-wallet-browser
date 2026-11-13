import { UNLOCKED_SESSION_TIMEOUT_MS } from "@xian-tech/wallet-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { RuntimeMessage } from "../shared/messages";
import type { MessageSender } from "./message-sender";

// Pins the background runtime-message contract the way Chrome drives it: a
// message reaches the registered onMessage listener, the listener answers
// through sendResponse. Wallet-core and extension storage are replaced by
// recording fakes so every message type can be checked for the exact wallet
// call it makes and the exact response it sends.

const CONTROLLER_METHODS = [
  "addAccount",
  "attachApprovalWindow",
  "createOrImportWallet",
  "disconnectAllOrigins",
  "disconnectOrigin",
  "dismissApproval",
  "estimateTransactionChi",
  "exportShieldedWalletSnapshot",
  "exportWallet",
  "getApprovalView",
  "getAssetBalanceSnapshot",
  "getChiRate",
  "getContractMethods",
  "getDetectedAssets",
  "getDexSnapshot",
  "getPopupState",
  "getProviderRequestStatus",
  "getShieldedWalletSnapshotHistory",
  "getTokenMetadata",
  "importWalletBackup",
  "listApprovalStates",
  "lockWallet",
  "removeAccount",
  "removeNetworkPreset",
  "removeShieldedWalletSnapshot",
  "removeTrustedDappPolicy",
  "removeWallet",
  "removeWatchedAsset",
  "renameAccount",
  "resolveApproval",
  "revealMnemonic",
  "revealPrivateKey",
  "saveNetworkPreset",
  "saveShieldedWalletSnapshot",
  "sendDirectTransaction",
  "startProviderRequest",
  "switchAccount",
  "switchNetwork",
  "touchUnlockedSession",
  "trackAsset",
  "unlockWallet",
  "updateAssetSettings",
  "updateSettings",
  "updateWatchedAssetDecimals"
] as const;

type ControllerMethod = (typeof CONTROLLER_METHODS)[number];

const fakes = vi.hoisted(() => {
  const storageNames = [
    "claimApprovalExecution",
    "clearUnlockedSession",
    "clearWalletState",
    "deleteApprovalState",
    "deleteRequestState",
    "listApprovalStates",
    "listRequestStates",
    "loadApprovalState",
    "loadAutoLock",
    "loadContacts",
    "loadRequestState",
    "loadUnlockedSession",
    "loadWalletShellMode",
    "loadWalletState",
    "replaceWalletState",
    "saveApprovalState",
    "saveAutoLock",
    "saveContacts",
    "saveLocalActivityTx",
    "saveRequestState",
    "saveUnlockedSession",
    "saveWalletShellMode",
    "saveWalletState"
  ];
  return {
    controller: {} as Record<string, Mock>,
    storage: Object.fromEntries(storageNames.map((name) => [name, vi.fn()])) as Record<string, Mock>
  };
});

vi.mock("@xian-tech/wallet-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xian-tech/wallet-core")>();
  return {
    ...actual,
    WalletController: vi.fn(function () {
      return fakes.controller;
    })
  };
});

vi.mock("../shared/storage", () => ({ ...fakes.storage }));

const EXTENSION_ID = "wallet-extension-id";
const POPUP: MessageSender = {
  id: EXTENSION_ID,
  url: `chrome-extension://${EXTENSION_ID}/popup.html`
};
const DAPP: MessageSender = {
  id: EXTENSION_ID,
  url: "https://dapp.example/page",
  origin: "https://dapp.example",
  tab: { id: 7 }
};
const POPUP_STATE = {
  hasWallet: true,
  unlocked: true,
  publicKey: "pk_owner",
  activeNetworkId: "local",
  rpcUrl: "http://127.0.0.1:26657"
};

type Listener = (
  message: unknown,
  sender: MessageSender,
  sendResponse: (response: unknown) => void
) => unknown;

let listener: Listener;
const chromeFake = {
  runtime: {
    id: EXTENSION_ID,
    getURL: vi.fn((path: string) => `chrome-extension://${EXTENSION_ID}/${path}`),
    sendMessage: vi.fn(),
    onMessage: { addListener: vi.fn((registered: Listener) => (listener = registered)) },
    onInstalled: { addListener: vi.fn() },
    onStartup: { addListener: vi.fn() }
  },
  action: {
    setBadgeText: vi.fn(),
    setBadgeBackgroundColor: vi.fn(),
    setPopup: vi.fn()
  },
  windows: {
    create: vi.fn(),
    get: vi.fn(),
    getAll: vi.fn(),
    onRemoved: { addListener: vi.fn() }
  },
  tabs: { query: vi.fn(), sendMessage: vi.fn() }
};

function controller(method: ControllerMethod): Mock {
  return fakes.controller[method]!;
}

function storage(name: string): Mock {
  return fakes.storage[name]!;
}

function resetFakes(): void {
  for (const method of CONTROLLER_METHODS) {
    fakes.controller[method] = vi.fn().mockResolvedValue({ from: method });
  }
  controller("getPopupState").mockResolvedValue(POPUP_STATE);
  controller("listApprovalStates").mockResolvedValue([]);
  controller("touchUnlockedSession").mockResolvedValue(undefined);
  for (const fake of Object.values(fakes.storage)) {
    fake.mockReset().mockResolvedValue(undefined);
  }
  storage("listApprovalStates").mockResolvedValue([]);
  storage("loadWalletShellMode").mockResolvedValue("popup");
  storage("loadUnlockedSession").mockResolvedValue(null);
  for (const group of [chromeFake.action, chromeFake.windows, chromeFake.tabs]) {
    for (const fake of Object.values(group)) {
      if (typeof fake === "function") {
        (fake as Mock).mockReset().mockResolvedValue(undefined);
      }
    }
  }
  chromeFake.windows.getAll.mockResolvedValue([]);
  chromeFake.runtime.sendMessage.mockReset().mockResolvedValue(undefined);
}

interface Dispatched {
  returned: unknown;
  response: unknown;
}

function dispatch(message: unknown, sender: MessageSender = POPUP): Promise<Dispatched> {
  return new Promise((resolve) => {
    const box: { returned?: unknown } = {};
    box.returned = listener(message, sender, (response) =>
      resolve({ returned: box.returned, response })
    );
  });
}

function unsupported() {
  return {
    ok: false,
    error: { name: "Error", message: "unsupported runtime message", code: undefined, data: undefined }
  };
}

beforeAll(async () => {
  vi.stubGlobal("chrome", chromeFake);
  resetFakes();
  await import("./index");
});

beforeEach(() => {
  resetFakes();
});

afterEach(() => {
  vi.useRealTimers();
});

// Every message type that is answered by forwarding message fields to one
// wallet controller method and returning its result unchanged.
const CONTROLLER_PASSTHROUGH = {
  wallet_get_asset_balances: [{ type: "wallet_get_asset_balances" }, "getAssetBalanceSnapshot", []],
  wallet_get_detected_assets: [{ type: "wallet_get_detected_assets" }, "getDetectedAssets", []],
  wallet_get_token_metadata: [
    { type: "wallet_get_token_metadata", contract: "con_token" },
    "getTokenMetadata",
    ["con_token"]
  ],
  wallet_track_asset: [
    { type: "wallet_track_asset", asset: { contract: "con_token", symbol: "TOK", decimals: 4 } },
    "trackAsset",
    [{ contract: "con_token", symbol: "TOK", decimals: 4 }]
  ],
  wallet_update_assets: [
    { type: "wallet_update_assets", assets: [{ contract: "currency", hidden: true, order: 2 }] },
    "updateAssetSettings",
    [[{ contract: "currency", hidden: true, order: 2 }]]
  ],
  wallet_update_asset_decimals: [
    { type: "wallet_update_asset_decimals", contract: "con_token", decimals: 6 },
    "updateWatchedAssetDecimals",
    ["con_token", 6]
  ],
  wallet_estimate_transaction: [
    { type: "wallet_estimate_transaction", contract: "currency", function: "transfer", kwargs: { amount: 1 } },
    "estimateTransactionChi",
    [{ contract: "currency", function: "transfer", kwargs: { amount: 1 } }]
  ],
  wallet_get_chi_rate: [{ type: "wallet_get_chi_rate" }, "getChiRate", []],
  wallet_send_direct_transaction: [
    {
      type: "wallet_send_direct_transaction",
      contract: "currency",
      function: "transfer",
      kwargs: { amount: 2 },
      chi: 900
    },
    "sendDirectTransaction",
    [{ contract: "currency", function: "transfer", kwargs: { amount: 2 }, chi: 900 }]
  ],
  wallet_get_contract_methods: [
    { type: "wallet_get_contract_methods", contract: "con_dex" },
    "getContractMethods",
    ["con_dex"]
  ],
  wallet_get_dex_snapshot: [{ type: "wallet_get_dex_snapshot" }, "getDexSnapshot", []],
  wallet_unlock: [{ type: "wallet_unlock", password: "pw" }, "unlockWallet", ["pw"]],
  wallet_lock: [{ type: "wallet_lock" }, "lockWallet", []],
  wallet_remove: [{ type: "wallet_remove" }, "removeWallet", []],
  wallet_update_settings: [
    { type: "wallet_update_settings", rpcUrl: "http://127.0.0.1:26657", networkName: "Local" },
    "updateSettings",
    [{ type: "wallet_update_settings", rpcUrl: "http://127.0.0.1:26657", networkName: "Local" }]
  ],
  wallet_save_network_preset: [
    { type: "wallet_save_network_preset", name: "Local", rpcUrl: "http://127.0.0.1:26657", makeActive: true },
    "saveNetworkPreset",
    [{ type: "wallet_save_network_preset", name: "Local", rpcUrl: "http://127.0.0.1:26657", makeActive: true }]
  ],
  wallet_switch_network: [{ type: "wallet_switch_network", presetId: "local" }, "switchNetwork", ["local"]],
  wallet_remove_network_preset: [
    { type: "wallet_remove_network_preset", presetId: "old" },
    "removeNetworkPreset",
    ["old"]
  ],
  wallet_disconnect_origin: [
    { type: "wallet_disconnect_origin", origin: "https://dapp.example" },
    "disconnectOrigin",
    ["https://dapp.example"]
  ],
  wallet_disconnect_all_origins: [{ type: "wallet_disconnect_all_origins" }, "disconnectAllOrigins", []],
  wallet_remove_trusted_dapp_policy: [
    { type: "wallet_remove_trusted_dapp_policy", policyId: "policy-1" },
    "removeTrustedDappPolicy",
    ["policy-1"]
  ],
  wallet_remove_asset: [{ type: "wallet_remove_asset", contract: "con_token" }, "removeWatchedAsset", ["con_token"]],
  wallet_add_account: [{ type: "wallet_add_account" }, "addAccount", []],
  wallet_switch_account: [{ type: "wallet_switch_account", index: 2 }, "switchAccount", [2]],
  wallet_rename_account: [
    { type: "wallet_rename_account", index: 1, name: "Savings" },
    "renameAccount",
    [1, "Savings"]
  ],
  wallet_remove_account: [{ type: "wallet_remove_account", index: 3 }, "removeAccount", [3]],
  wallet_export: [{ type: "wallet_export", password: "pw" }, "exportWallet", ["pw"]],
  wallet_import_backup: [
    { type: "wallet_import_backup", backup: { version: 1 } as never, password: "pw" },
    "importWalletBackup",
    [{ version: 1 }, "pw"]
  ],
  wallet_save_shielded_snapshot: [
    { type: "wallet_save_shielded_snapshot", stateSnapshot: "snap", label: "Main" },
    "saveShieldedWalletSnapshot",
    ["snap", "Main"]
  ],
  wallet_export_shielded_snapshot: [
    { type: "wallet_export_shielded_snapshot", snapshotId: "s1", password: "pw" },
    "exportShieldedWalletSnapshot",
    ["s1", "pw"]
  ],
  wallet_remove_shielded_snapshot: [
    { type: "wallet_remove_shielded_snapshot", snapshotId: "s1" },
    "removeShieldedWalletSnapshot",
    ["s1"]
  ],
  wallet_get_shielded_snapshot_history: [
    { type: "wallet_get_shielded_snapshot_history", snapshotId: "s1", limit: 25 },
    "getShieldedWalletSnapshotHistory",
    ["s1", 25]
  ],
  wallet_reveal_mnemonic: [{ type: "wallet_reveal_mnemonic", password: "pw" }, "revealMnemonic", ["pw"]],
  wallet_reveal_private_key: [{ type: "wallet_reveal_private_key", password: "pw" }, "revealPrivateKey", ["pw"]],
  approval_get: [{ type: "approval_get", approvalId: "approval-1" }, "getApprovalView", ["approval-1"]]
} satisfies Partial<Record<RuntimeMessage["type"], [RuntimeMessage, ControllerMethod, unknown[]]>>;

// Message types whose behaviour is more than a controller passthrough; each
// has its own test below.
const DEDICATED = [
  "wallet_get_popup_state",
  "wallet_create",
  "wallet_set_shell_mode",
  "wallet_get_auto_lock",
  "wallet_set_auto_lock",
  "contacts_get",
  "contacts_save",
  "approval_resolve",
  "provider_request",
  "provider_request_status",
  "provider_event"
] as const;

// Compile-time guard: adding a RuntimeMessage type without pinning it here
// fails the typecheck.
type PinnedType = keyof typeof CONTROLLER_PASSTHROUGH | (typeof DEDICATED)[number];
const everyTypePinned: [Exclude<RuntimeMessage["type"], PinnedType>] extends [never] ? true : never = true;

describe("background runtime message listener", () => {
  it("pins every runtime message type exactly once", () => {
    expect(everyTypePinned).toBe(true);
    const passthrough = Object.keys(CONTROLLER_PASSTHROUGH);
    expect(passthrough.filter((type) => (DEDICATED as readonly string[]).includes(type))).toEqual([]);
    expect(passthrough.length + DEDICATED.length).toBe(46);
  });

  it.each(Object.entries(CONTROLLER_PASSTHROUGH))(
    "%s forwards to the wallet controller and answers with its result",
    async (_type, [message, method, args]) => {
      const { returned, response } = await dispatch(message);

      expect(returned).toBe(true);
      expect(controller(method)).toHaveBeenCalledTimes(1);
      expect(controller(method).mock.calls[0]).toEqual(args);
      expect(response).toEqual({ ok: true, result: { from: method } });
    }
  );

  it("wallet_get_popup_state answers popup state with the shell mode", async () => {
    storage("loadWalletShellMode").mockResolvedValue("sidePanel");

    const { response } = await dispatch({ type: "wallet_get_popup_state" });

    expect(response).toEqual({ ok: true, result: { ...POPUP_STATE, shellMode: "sidePanel" } });
  });

  it("wallet_create passes the whole message and attaches the runtime popup state", async () => {
    const message = { type: "wallet_create", password: "pw", createWithMnemonic: true };
    controller("createOrImportWallet").mockResolvedValue({ mnemonic: "words", popupState: { stale: true } });

    const { response } = await dispatch(message);

    expect(controller("createOrImportWallet").mock.calls).toEqual([[message]]);
    expect(response).toEqual({
      ok: true,
      result: { mnemonic: "words", popupState: { ...POPUP_STATE, shellMode: "popup" } }
    });
  });

  it.each([
    ["sidePanel", "sidePanel", ""],
    ["popup", "popup", "popup.html"],
    ["bogus", "popup", "popup.html"]
  ])("wallet_set_shell_mode %s stores %s and answers the popup state", async (requested, stored, popup) => {
    storage("loadWalletShellMode").mockResolvedValue(stored);

    const { response } = await dispatch({ type: "wallet_set_shell_mode", shellMode: requested });

    expect(storage("saveWalletShellMode").mock.calls).toEqual([[stored]]);
    expect(chromeFake.action.setPopup).toHaveBeenLastCalledWith({ popup });
    expect(response).toEqual({ ok: true, result: { ...POPUP_STATE, shellMode: stored } });
  });

  it("wallet_get_auto_lock answers the stored preference", async () => {
    storage("loadAutoLock").mockResolvedValue(false);

    const { response } = await dispatch({ type: "wallet_get_auto_lock" });

    expect(response).toEqual({ ok: true, result: false });
  });

  it.each([
    [true, 1_000 + UNLOCKED_SESSION_TIMEOUT_MS],
    [false, Number.MAX_SAFE_INTEGER]
  ])("wallet_set_auto_lock %s saves the preference and moves the session expiry", async (enabled, expiresAt) => {
    vi.useFakeTimers({ now: 1_000, toFake: ["Date"] });
    storage("loadUnlockedSession").mockResolvedValue({ expiresAt: 5, secret: "kept" });

    const { response } = await dispatch({ type: "wallet_set_auto_lock", enabled });

    expect(storage("saveAutoLock").mock.calls).toEqual([[enabled]]);
    expect(storage("saveUnlockedSession").mock.calls).toEqual([[{ expiresAt, secret: "kept" }]]);
    expect(response).toEqual({ ok: true, result: { ...POPUP_STATE, shellMode: "popup" } });
  });

  it("wallet_set_auto_lock without an unlocked session only saves the preference", async () => {
    const { response } = await dispatch({ type: "wallet_set_auto_lock", enabled: true });

    expect(storage("saveAutoLock").mock.calls).toEqual([[true]]);
    expect(storage("saveUnlockedSession")).not.toHaveBeenCalled();
    expect(response).toEqual({ ok: true, result: { ...POPUP_STATE, shellMode: "popup" } });
  });

  it("contacts_get answers the stored contacts", async () => {
    const contacts = [{ id: "1", name: "Ann", address: "pk_ann" }];
    storage("loadContacts").mockResolvedValue(contacts);

    const { response } = await dispatch({ type: "contacts_get" });

    expect(response).toEqual({ ok: true, result: contacts });
  });

  it("contacts_save stores the contacts and answers null", async () => {
    const contacts = [{ id: "1", name: "Ann", address: "pk_ann" }];

    const { response } = await dispatch({ type: "contacts_save", contacts });

    expect(storage("saveContacts").mock.calls).toEqual([[contacts]]);
    expect(response).toEqual({ ok: true, result: null });
  });

  it("approval_resolve resolves with the trust scope and refreshes the badge", async () => {
    storage("listApprovalStates").mockResolvedValue([{ id: "a" }, { id: "b" }]);

    const { response } = await dispatch({
      type: "approval_resolve",
      approvalId: "approval-1",
      approved: true,
      trust: { kind: "exact" }
    });
    await vi.waitFor(() => expect(chromeFake.action.setBadgeText).toHaveBeenCalledWith({ text: "2" }));

    expect(controller("resolveApproval").mock.calls).toEqual([["approval-1", true, { trust: { kind: "exact" } }]]);
    expect(response).toEqual({ ok: true, result: { from: "resolveApproval" } });
  });

  it.each(["approval_get", "approval_resolve"])("%s skips approval-window synchronization", async (type) => {
    await dispatch({ type, approvalId: "approval-1", approved: false });

    expect(controller("listApprovalStates")).not.toHaveBeenCalled();
  });

  it("other messages synchronize approval windows before the handler runs", async () => {
    await dispatch({ type: "wallet_lock" });

    const sync = controller("listApprovalStates").mock.invocationCallOrder[0]!;
    expect(sync).toBeLessThan(controller("lockWallet").mock.invocationCallOrder[0]!);
  });

  it("user commands extend the unlocked session before anything else", async () => {
    await dispatch({ type: "wallet_lock" });

    const touched = controller("touchUnlockedSession").mock.invocationCallOrder[0]!;
    expect(touched).toBeLessThan(controller("listApprovalStates").mock.invocationCallOrder[0]!);
  });

  it("passive reads do not extend the unlocked session", async () => {
    await dispatch({ type: "wallet_get_popup_state" });

    expect(controller("touchUnlockedSession")).not.toHaveBeenCalled();
  });

  it("provider_request binds the sender origin and answers a pending result without publishing", async () => {
    controller("startProviderRequest").mockResolvedValue({ status: "pending", approvalId: "a" });
    const request = { method: "xian_sendTransaction", params: [] };

    const { response } = await dispatch(
      {
        type: "provider_request",
        requestId: "r1",
        origin: "https://forged.example",
        request,
        dappMetadata: { name: "Dapp" }
      },
      DAPP
    );

    expect(controller("startProviderRequest").mock.calls).toEqual([
      ["r1", "https://dapp.example", request, { dappMetadata: { name: "Dapp" } }]
    ]);
    expect(controller("touchUnlockedSession")).not.toHaveBeenCalled();
    expect(chromeFake.runtime.sendMessage).not.toHaveBeenCalled();
    expect(response).toEqual({ ok: true, result: { status: "pending", approvalId: "a" } });
  });

  it("provider_request publishes an auto-approved fulfilled transaction before answering", async () => {
    const result = {
      status: "fulfilled",
      result: { submitted: true, accepted: true, finalized: false, txHash: "HASH" }
    };
    controller("startProviderRequest").mockResolvedValue(result);
    const request = {
      method: "xian_sendCall",
      params: [{ intent: { contract: "currency", function: "transfer", kwargs: { amount: 3 } } }]
    };

    const { response } = await dispatch(
      { type: "provider_request", requestId: "r2", origin: "https://dapp.example", request },
      DAPP
    );

    expect(chromeFake.runtime.sendMessage.mock.calls).toEqual([
      [
        {
          type: "wallet_transaction_submitted",
          origin: "https://dapp.example",
          requestId: "r2",
          method: "xian_sendCall",
          autoApproved: true,
          submitted: true,
          accepted: true,
          finalized: false,
          txHash: "HASH",
          sender: undefined,
          contract: "currency",
          function: "transfer",
          kwargs: { amount: 3 },
          message: undefined,
          execution: undefined
        }
      ]
    ]);
    expect(storage("saveLocalActivityTx").mock.calls[0]?.[0]).toBe("local|http://127.0.0.1:26657|pk_owner");
    expect(response).toEqual({ ok: true, result });
  });

  it("provider_request_status publishes a consumed approval-mediated transaction", async () => {
    const request = {
      method: "xian_sendTransaction",
      params: [{ tx: { payload: { sender: "pk_owner", contract: "currency", function: "approve", kwargs: {} } } }]
    };
    storage("loadRequestState").mockResolvedValue({
      requestId: "r3",
      origin: "https://dapp.example",
      request
    });
    const result = { status: "fulfilled", result: { submitted: true, tx_hash: "H3" } };
    controller("getProviderRequestStatus").mockResolvedValue(result);

    const { response } = await dispatch(
      { type: "provider_request_status", requestId: "r3", origin: "https://forged.example", consume: true },
      DAPP
    );

    expect(storage("loadRequestState").mock.calls).toEqual([["r3"]]);
    expect(controller("getProviderRequestStatus").mock.calls).toEqual([
      ["r3", { origin: "https://dapp.example", consume: true }]
    ]);
    expect(chromeFake.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "wallet_transaction_submitted",
        requestId: "r3",
        autoApproved: false,
        txHash: "H3",
        sender: "pk_owner",
        function: "approve"
      })
    );
    expect(response).toEqual({ ok: true, result });
  });

  it("provider_request_status without consume answers the status without publishing", async () => {
    storage("loadRequestState").mockResolvedValue(null);
    controller("getProviderRequestStatus").mockResolvedValue({ status: "pending" });

    const { response } = await dispatch({ type: "provider_request_status", requestId: "r4" }, DAPP);

    expect(chromeFake.runtime.sendMessage).not.toHaveBeenCalled();
    expect(response).toEqual({ ok: true, result: { status: "pending" } });
  });

  it("provider_request_status does not publish a fulfilled request that is not consumed", async () => {
    storage("loadRequestState").mockResolvedValue({
      requestId: "r5",
      origin: "https://dapp.example",
      request: { method: "xian_sendCall", params: [] }
    });
    const result = { status: "fulfilled", result: { submitted: true, txHash: "H5" } };
    controller("getProviderRequestStatus").mockResolvedValue(result);

    const { response } = await dispatch({ type: "provider_request_status", requestId: "r5" }, DAPP);

    expect(chromeFake.runtime.sendMessage).not.toHaveBeenCalled();
    expect(storage("saveLocalActivityTx")).not.toHaveBeenCalled();
    expect(response).toEqual({ ok: true, result });
  });

  it("provider_event is not handled by the background and is rejected after the shared steps", async () => {
    const { returned, response } = await dispatch({ type: "provider_event", event: "x", args: [] });

    expect(returned).toBe(true);
    expect(controller("touchUnlockedSession")).toHaveBeenCalledTimes(1);
    expect(controller("listApprovalStates")).toHaveBeenCalledTimes(1);
    expect(response).toEqual(unsupported());
  });

  it.each(["wallet_unknown", "constructor", "toString", "__proto__", "hasOwnProperty"])(
    "unknown type %s is rejected as unsupported",
    async (type) => {
      const { response } = await dispatch({ type });

      expect(response).toEqual(unsupported());
    }
  );

  it("ignores its own wallet_transaction_submitted broadcast synchronously", () => {
    const sendResponse = vi.fn();

    const returned = listener({ type: "wallet_transaction_submitted" }, POPUP, sendResponse);

    expect(returned).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
    expect(controller("touchUnlockedSession")).not.toHaveBeenCalled();
  });

  it("rejects an untrusted sender before touching the wallet", async () => {
    const { response } = await dispatch({ type: "wallet_lock" }, { ...POPUP, id: "other-extension" });

    expect(response).toEqual({
      ok: false,
      error: { name: "Error", message: "untrusted runtime sender", code: undefined, data: undefined }
    });
    expect(controller("touchUnlockedSession")).not.toHaveBeenCalled();
    expect(controller("lockWallet")).not.toHaveBeenCalled();
  });

  it("rejects wallet commands from web pages", async () => {
    const { response } = await dispatch({ type: "wallet_export", password: "pw" }, DAPP);

    expect(response).toMatchObject({
      ok: false,
      error: { message: "wallet commands require a packaged wallet page" }
    });
    expect(controller("exportWallet")).not.toHaveBeenCalled();
  });

  it("answers a handler failure with the serialized error", async () => {
    controller("unlockWallet").mockRejectedValue(
      Object.assign(new TypeError("wrong password"), { code: 4100, data: { attempts: 1 } })
    );

    const { response } = await dispatch({ type: "wallet_unlock", password: "bad" });

    expect(response).toEqual({
      ok: false,
      error: { name: "TypeError", message: "wrong password", code: 4100, data: { attempts: 1 } }
    });
  });
});

// Drives a fulfilled, auto-approved provider_request and returns what the
// background broadcast and stored for it.
async function publishFulfilled(
  submission: unknown,
  request: { method: string; params: unknown } = { method: "xian_sendCall", params: [] }
) {
  controller("startProviderRequest").mockResolvedValue({ status: "fulfilled", result: submission });
  const { response } = await dispatch(
    { type: "provider_request", requestId: "rp", origin: "https://dapp.example", request },
    DAPP
  );
  expect(response).toEqual({ ok: true, result: { status: "fulfilled", result: submission } });
  const broadcast = chromeFake.runtime.sendMessage.mock.calls.map(([message]) => message);
  const stored = storage("saveLocalActivityTx").mock.calls;
  return { broadcast, stored };
}

describe("provider transaction publication", () => {
  it.each([
    [{ txHash: "A", tx_hash: "B", hash: "C", receipt: { txHash: "D" } }, "A"],
    [{ txHash: "  ", tx_hash: "B", hash: "C" }, "B"],
    [{ hash: "C", receipt: { txHash: "D" } }, "C"],
    [{ txHash: 5, receipt: { txHash: "D", tx_hash: "E" } }, "D"],
    [{ receipt: { tx_hash: "E", hash: "F" } }, "E"],
    [{ receipt: { hash: "F" } }, "F"],
    [{ receipt: "not-a-record", hash: "" }, undefined],
    [{ receipt: ["D"] }, undefined],
    ["not-a-record", undefined]
  ])("takes the transaction hash of %j as %s", async (submission, txHash) => {
    const { broadcast } = await publishFulfilled(submission);

    expect(broadcast).toHaveLength(1);
    expect(broadcast[0]).toMatchObject({ type: "wallet_transaction_submitted", txHash });
  });

  const requestPayload = { sender: "pk_req", contract: "con_req", function: "fn_req", kwargs: { from: "request" } };
  const sendTransaction = { method: "xian_sendTransaction", params: [{ tx: { payload: requestPayload } }] };
  it.each([
    [
      "the submitted transaction payload",
      { transaction: { payload: { contract: "con_tx", function: "fn_tx" } }, payload: { contract: "con_p" } },
      { sender: "pk_req", contract: "con_tx", function: "fn_tx", kwargs: { from: "request" } }
    ],
    [
      "the submission payload when the transaction has none",
      { transaction: { payload: "x" }, payload: { sender: "pk_p", kwargs: { from: "payload" } } },
      { sender: "pk_p", contract: "con_req", function: "fn_req", kwargs: { from: "payload" } }
    ],
    [
      "the submission payload when there is no transaction",
      { transaction: "x", payload: { function: "fn_p" }, receipt: { transaction: { payload: { function: "fn_r" } } } },
      { sender: "pk_req", contract: "con_req", function: "fn_p", kwargs: { from: "request" } }
    ],
    [
      "the receipt transaction payload as the last resort",
      { receipt: { transaction: { payload: { contract: "con_r", kwargs: { from: "receipt" } } } } },
      { sender: "pk_req", contract: "con_r", function: "fn_req", kwargs: { from: "receipt" } }
    ],
    [
      "the request when the receipt transaction has no payload",
      { receipt: { transaction: { payload: [] } } },
      requestPayload
    ],
    ["the request when the receipt has no transaction", { receipt: { transaction: "x" } }, requestPayload],
    ["the request for a non-record submission", 42, requestPayload],
    [
      "the request, ignoring blank and non-string submission fields",
      { payload: { sender: " ", contract: 7, function: "", kwargs: ["x"] } },
      requestPayload
    ]
  ])("takes transaction details from %s", async (_case, submission, details) => {
    const { broadcast } = await publishFulfilled(submission, sendTransaction);

    expect(broadcast[0]).toMatchObject({ type: "wallet_transaction_submitted", ...details });
  });

  const details = { sender: "pk_x", contract: "con_x", function: "fn_x", kwargs: { k: 1 } };
  it.each([
    ["a call intent", { method: "xian_sendCall", params: [{ intent: details }] }, details],
    ["a bare call", { method: "xian_sendCall", params: [details] }, details],
    ["call params given as an object", { method: "xian_sendCall", params: details }, details],
    ["a transaction payload", { method: "xian_sendTransaction", params: [{ tx: { payload: details } }] }, details],
    ["a bare transaction", { method: "xian_sendTransaction", params: [{ payload: details }] }, details],
    [
      "a payload beside a transaction without one",
      { method: "xian_sendTransaction", params: [{ tx: { chi: 1 }, payload: details }] },
      details
    ],
    ["a transaction without a payload", { method: "xian_sendTransaction", params: [{ tx: {} }] }, {}],
    ["non-record params", { method: "xian_sendCall", params: ["x"] }, {}],
    ["missing params", { method: "xian_sendTransaction", params: undefined }, {}]
  ])("takes request details from %s", async (_case, request, expected) => {
    const { broadcast } = await publishFulfilled({}, request);

    expect(broadcast[0]).toMatchObject({
      sender: undefined,
      contract: undefined,
      function: undefined,
      kwargs: undefined,
      ...expected
    });
  });

  it("forwards submission status, message and receipt execution", async () => {
    const { broadcast } = await publishFulfilled({
      submitted: "yes",
      accepted: null,
      finalized: true,
      message: { note: 1 },
      receipt: { execution: { status: 0 } }
    });

    expect(broadcast[0]).toMatchObject({
      submitted: undefined,
      accepted: null,
      finalized: true,
      message: { note: 1 },
      execution: { status: 0 }
    });
  });

  it("does not publish provider methods that submit nothing", async () => {
    const { broadcast, stored } = await publishFulfilled({ txHash: "A" }, { method: "xian_signMessage", params: [] });

    expect(broadcast).toEqual([]);
    expect(stored).toEqual([]);
  });
});

describe("provider transaction activity", () => {
  const CREATED_AT = new Date(1_700_000_000_000).toISOString();

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_700_000_000_000, toFake: ["Date"] });
  });

  it("stores a finalized transaction of the active account with its defaults", async () => {
    const { stored } = await publishFulfilled({ txHash: "H1", finalized: true, accepted: false });

    expect(stored).toHaveLength(1);
    expect(stored[0]?.[0]).toBe("local|http://127.0.0.1:26657|pk_owner");
    expect(stored[0]?.[1]).toStrictEqual({
      tx_hash: "H1",
      sender: "pk_owner",
      contract: "unknown",
      function: "transaction",
      success: true,
      created_at: CREATED_AT,
      payload: { sender: "pk_owner", contract: "unknown", function: "transaction", kwargs: {} },
      local: true,
      local_status: "finalized"
    });
  });

  it("stores an accepted transaction with its details and message", async () => {
    const { stored } = await publishFulfilled(
      { txHash: "H2", accepted: true, message: "queued" },
      {
        method: "xian_sendCall",
        params: [{ intent: { sender: "pk_owner", contract: "currency", function: "transfer", kwargs: { amount: 1 } } }]
      }
    );

    expect(stored[0]?.[1]).toStrictEqual({
      tx_hash: "H2",
      sender: "pk_owner",
      contract: "currency",
      function: "transfer",
      success: true,
      created_at: CREATED_AT,
      payload: { sender: "pk_owner", contract: "currency", function: "transfer", kwargs: { amount: 1 } },
      local: true,
      local_status: "accepted",
      result: { message: "queued" }
    });
  });

  it("stores an unconfirmed transaction without a local status", async () => {
    controller("getPopupState").mockResolvedValue({ ...POPUP_STATE, activeNetworkId: undefined });

    const { stored } = await publishFulfilled({ txHash: "H3", accepted: null, message: null });

    expect(stored[0]?.[0]).toBe("http://127.0.0.1:26657|http://127.0.0.1:26657|pk_owner");
    expect(stored[0]?.[1]).toStrictEqual({
      tx_hash: "H3",
      sender: "pk_owner",
      contract: "unknown",
      function: "transaction",
      success: false,
      created_at: CREATED_AT,
      payload: { sender: "pk_owner", contract: "unknown", function: "transaction", kwargs: {} },
      local: true,
      result: { message: null }
    });
  });

  it("stores nothing without a transaction hash and never reads wallet state", async () => {
    const { broadcast, stored } = await publishFulfilled({ submitted: true });

    expect(broadcast).toHaveLength(1);
    expect(stored).toEqual([]);
    expect(controller("getPopupState")).not.toHaveBeenCalled();
  });

  it("stores nothing without an active account", async () => {
    controller("getPopupState").mockResolvedValue({ ...POPUP_STATE, publicKey: undefined });

    const { broadcast, stored } = await publishFulfilled({ txHash: "H4" });

    expect(broadcast).toHaveLength(1);
    expect(stored).toEqual([]);
  });

  it("stores nothing for a transaction sent by another account", async () => {
    const { broadcast, stored } = await publishFulfilled(
      { txHash: "H5" },
      { method: "xian_sendCall", params: [{ intent: { sender: "pk_other" } }] }
    );

    expect(broadcast).toHaveLength(1);
    expect(stored).toEqual([]);
  });

  it.each([
    ["reading wallet state", () => controller("getPopupState").mockRejectedValue(new Error("down"))],
    ["storing activity", () => storage("saveLocalActivityTx").mockRejectedValue(new Error("full"))],
    ["broadcasting", () => chromeFake.runtime.sendMessage.mockRejectedValue(new Error("no receiver"))]
  ])("answers the dapp even when %s fails", async (_step, arrange) => {
    arrange();

    await publishFulfilled({ txHash: "H6" });
  });
});

describe("approval window synchronization", () => {
  type RemovedListener = (windowId: number) => void;
  const windowRemoved = (): RemovedListener =>
    chromeFake.windows.onRemoved.addListener.mock.calls[0]![0] as RemovedListener;

  async function closeWindow(windowId: number): Promise<void> {
    chromeFake.windows.get.mockRejectedValue(new Error("gone"));
    windowRemoved()(windowId);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("keeps approvals whose window is open and tracks that window", async () => {
    controller("listApprovalStates").mockResolvedValue([{ id: "a1", windowId: 11 }]);
    chromeFake.windows.getAll.mockResolvedValue([{ id: 11 }, {}]);

    await dispatch({ type: "wallet_lock" });
    expect(controller("dismissApproval")).not.toHaveBeenCalled();
    expect(chromeFake.windows.create).not.toHaveBeenCalled();

    await closeWindow(11);
    expect(controller("dismissApproval").mock.calls).toEqual([["a1"]]);
  });

  it("dismisses approvals whose window was closed", async () => {
    controller("listApprovalStates").mockResolvedValue([{ id: "a2", windowId: 12 }]);
    chromeFake.windows.getAll.mockResolvedValue([{ id: 99 }]);

    await dispatch({ type: "wallet_lock" });

    expect(controller("dismissApproval").mock.calls).toEqual([["a2"]]);
    expect(chromeFake.windows.create).not.toHaveBeenCalled();
  });

  it("opens and attaches a window for an approval without one", async () => {
    controller("listApprovalStates").mockResolvedValue([{ id: "a3" }]);
    chromeFake.windows.create.mockResolvedValue({ id: 22 });

    await dispatch({ type: "wallet_lock" });

    expect(chromeFake.windows.create.mock.calls).toEqual([
      [
        {
          url: `chrome-extension://${EXTENSION_ID}/approval.html?approvalId=a3`,
          type: "popup",
          width: 420,
          height: 640
        }
      ]
    ]);
    expect(controller("attachApprovalWindow").mock.calls).toEqual([["a3", 22]]);

    await closeWindow(22);
    expect(controller("dismissApproval").mock.calls).toEqual([["a3"]]);
  });

  it("leaves window-less approvals to the side panel", async () => {
    storage("loadWalletShellMode").mockResolvedValue("sidePanel");
    controller("listApprovalStates").mockResolvedValue([{ id: "a4" }]);

    await dispatch({ type: "wallet_lock" });

    expect(chromeFake.windows.create).not.toHaveBeenCalled();
    expect(controller("attachApprovalWindow")).not.toHaveBeenCalled();
  });

  it("forgets windows of approvals that are gone", async () => {
    controller("listApprovalStates").mockResolvedValue([{ id: "a5", windowId: 15 }]);
    chromeFake.windows.getAll.mockResolvedValue([{ id: 15 }]);
    await dispatch({ type: "wallet_lock" });
    controller("listApprovalStates").mockResolvedValue([]);
    await dispatch({ type: "wallet_lock" });

    await closeWindow(15);

    expect(controller("dismissApproval")).not.toHaveBeenCalled();
  });

  it("refreshes the badge after synchronizing", async () => {
    storage("listApprovalStates").mockResolvedValue([{ id: "a6" }]);

    await dispatch({ type: "wallet_lock" });
    await vi.waitFor(() => expect(chromeFake.action.setBadgeText).toHaveBeenCalledWith({ text: "1" }));
  });

  it("shares one synchronization between concurrent messages", async () => {
    let release: (approvals: unknown[]) => void = () => undefined;
    controller("listApprovalStates").mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );

    const first = dispatch({ type: "wallet_lock" });
    const second = dispatch({ type: "wallet_remove" });
    await vi.waitFor(() => expect(controller("listApprovalStates")).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    release([]);
    await Promise.all([first, second]);

    expect(controller("listApprovalStates")).toHaveBeenCalledTimes(1);
    expect(controller("lockWallet")).toHaveBeenCalledTimes(1);
    expect(controller("removeWallet")).toHaveBeenCalledTimes(1);
  });

  it("fails the message when an approval window cannot be opened, then recovers", async () => {
    controller("listApprovalStates").mockResolvedValueOnce([{ id: "a7" }]).mockResolvedValue([]);
    chromeFake.windows.create.mockResolvedValue({});

    const { response } = await dispatch({ type: "wallet_lock" });
    const retry = await dispatch({ type: "wallet_lock" });

    expect(response).toMatchObject({ ok: false, error: { message: "failed to open approval window" } });
    expect(controller("lockWallet")).toHaveBeenCalledTimes(1);
    expect(retry.response).toEqual({ ok: true, result: { from: "lockWallet" } });
  });
});
