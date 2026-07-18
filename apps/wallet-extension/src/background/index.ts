import {
  UNLOCKED_SESSION_TIMEOUT_MS,
  WalletController
} from "@xian-tech/wallet-core";

import {
  fail,
  ok,
  type ProviderRequestRuntimeMessage,
  type RuntimeMessage,
  type WalletTransactionSubmittedRuntimeMessage
} from "../shared/messages";
import {
  DEFAULT_WALLET_SHELL_MODE,
  type WalletShellMode
} from "../shared/preferences";
import { completedProviderRequestMessage } from "./provider-request-notification";
import {
  deleteApprovalState,
  listApprovalStates,
  listRequestStates,
  loadUnlockedSession,
  loadApprovalState,
  loadRequestState,
  loadWalletState,
  loadWalletShellMode,
  saveUnlockedSession,
  saveApprovalState,
  saveRequestState,
  saveWalletState,
  saveWalletShellMode,
  deleteRequestState,
  clearUnlockedSession,
  clearWalletState,
  loadContacts,
  saveContacts,
  loadAutoLock,
  saveAutoLock,
  saveLocalActivityTx,
  type StoredLocalActivityTx
} from "../shared/storage";

const WALLET_METADATA = {
  id: "xian-wallet-shell",
  name: "Xian Wallet",
  rdns: "org.xian.wallet.shell"
};

const DISABLED_AUTO_LOCK_EXPIRES_AT = Number.MAX_SAFE_INTEGER;

const approvalWindowIds = new Map<number, string>();

async function updateApprovalBadge(): Promise<void> {
  try {
    const approvals = await listApprovalStates();
    const count = approvals.length;
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#ff4d4f" });
  } catch {
    // Badge API may not be available in all contexts
  }
}
let syncApprovalsPromise: Promise<void> | null = null;

async function applyShellMode(shellMode: WalletShellMode): Promise<void> {
  const popup = shellMode === "sidePanel" ? "" : "popup.html";
  await chrome.action.setPopup({ popup });

  if (!chrome.sidePanel) {
    return;
  }

  await chrome.sidePanel.setOptions({
    path: "popup.html",
    enabled: true
  });
  await chrome.sidePanel.setPanelBehavior({
    openPanelOnActionClick: shellMode === "sidePanel"
  });
}

async function getPopupRuntimeState() {
  const [popupState, shellMode] = await Promise.all([
    controller.getPopupState(),
    loadWalletShellMode()
  ]);
  return {
    ...popupState,
    shellMode
  };
}

async function setShellMode(shellMode: WalletShellMode) {
  const normalized = shellMode === "sidePanel" ? "sidePanel" : DEFAULT_WALLET_SHELL_MODE;
  await saveWalletShellMode(normalized);
  await applyShellMode(normalized);
  return getPopupRuntimeState();
}

async function openApprovalWindow(approvalId: string): Promise<number> {
  const url = chrome.runtime.getURL(`approval.html?approvalId=${approvalId}`);
  const created = await chrome.windows.create({
    url,
    type: "popup",
    width: 420,
    height: 640
  });
  if (typeof created?.id !== "number") {
    throw new Error("failed to open approval window");
  }
  return created.id;
}

async function broadcastProviderEvent(
  event: string,
  args: unknown[],
  targetOrigin?: string
): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs
      .filter((tab: { id?: number }) => typeof tab.id === "number")
      .map(async (tab: { id: number }) => {
        try {
          await chrome.tabs.sendMessage(tab.id, {
            type: "provider_event",
            event,
            args,
            targetOrigin
          });
        } catch {
          // Ignore tabs without a ready content script.
        }
      })
  );
}

type SubmittedProviderMethod = "xian_sendTransaction" | "xian_sendCall";

interface ProviderTransactionDetails {
  sender?: string;
  contract?: string;
  function?: string;
  kwargs?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readBooleanOrNull(value: unknown): boolean | null | undefined {
  return value === null || typeof value === "boolean" ? value : undefined;
}

function isSubmittedProviderMethod(
  method: string
): method is SubmittedProviderMethod {
  return method === "xian_sendTransaction" || method === "xian_sendCall";
}

function firstParamRecord(params: unknown): Record<string, unknown> {
  if (Array.isArray(params)) {
    const first = params[0];
    return isRecord(first) ? first : {};
  }
  return isRecord(params) ? params : {};
}

function detailsFromPayload(value: unknown): ProviderTransactionDetails {
  const payload = isRecord(value) ? value : {};
  const kwargs = isRecord(payload.kwargs) ? payload.kwargs : undefined;
  return {
    sender: readString(payload.sender),
    contract: readString(payload.contract),
    function: readString(payload.function),
    kwargs
  };
}

function detailsFromProviderRequest(
  request: ProviderRequestRuntimeMessage["request"]
): ProviderTransactionDetails {
  const params = firstParamRecord(request.params);

  if (request.method === "xian_sendCall") {
    const intent = isRecord(params.intent) ? params.intent : params;
    return detailsFromPayload(intent);
  }

  if (request.method === "xian_sendTransaction") {
    const tx = isRecord(params.tx) ? params.tx : params;
    const payload = isRecord(tx.payload)
      ? tx.payload
      : isRecord(params.payload)
        ? params.payload
        : {};
    return detailsFromPayload(payload);
  }

  return {};
}

function receiptFromSubmission(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  return isRecord(value.receipt) ? value.receipt : null;
}

function executionFromSubmission(value: unknown): unknown {
  const receipt = receiptFromSubmission(value);
  return receipt ? receipt.execution : undefined;
}

function txHashFromSubmission(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const receipt = receiptFromSubmission(value);
  return (
    readString(value.txHash) ??
    readString(value.tx_hash) ??
    readString(value.hash) ??
    readString(receipt?.txHash) ??
    readString(receipt?.tx_hash) ??
    readString(receipt?.hash)
  );
}

function detailsFromSubmission(value: unknown): ProviderTransactionDetails {
  if (!isRecord(value)) {
    return {};
  }
  const receipt = receiptFromSubmission(value);
  const receiptTransaction = isRecord(receipt?.transaction)
    ? receipt.transaction
    : null;
  const receiptPayload = isRecord(receiptTransaction?.payload)
    ? receiptTransaction.payload
    : null;
  const transaction = isRecord(value.transaction) ? value.transaction : null;
  const payload = isRecord(transaction?.payload)
    ? transaction.payload
    : isRecord(value.payload)
      ? value.payload
      : receiptPayload;

  return detailsFromPayload(payload);
}

function buildTransactionSubmittedMessage(
  runtimeMessage: ProviderRequestRuntimeMessage,
  result: { status: "fulfilled"; result: unknown },
  autoApproved: boolean
): WalletTransactionSubmittedRuntimeMessage | null {
  const method = runtimeMessage.request.method;
  if (!isSubmittedProviderMethod(method)) {
    return null;
  }

  const submission = isRecord(result.result) ? result.result : {};
  const requestDetails = detailsFromProviderRequest(runtimeMessage.request);
  const submissionDetails = detailsFromSubmission(submission);

  return {
    type: "wallet_transaction_submitted",
    origin: runtimeMessage.origin,
    requestId: runtimeMessage.requestId,
    method,
    autoApproved,
    submitted: readBoolean(submission.submitted),
    accepted: readBooleanOrNull(submission.accepted),
    finalized: readBoolean(submission.finalized),
    txHash: txHashFromSubmission(submission),
    sender: submissionDetails.sender ?? requestDetails.sender,
    contract: submissionDetails.contract ?? requestDetails.contract,
    function: submissionDetails.function ?? requestDetails.function,
    kwargs: submissionDetails.kwargs ?? requestDetails.kwargs,
    message: submission.message,
    execution: executionFromSubmission(submission)
  };
}

async function recordProviderTransactionActivity(
  notification: WalletTransactionSubmittedRuntimeMessage
): Promise<void> {
  if (!notification.txHash) {
    return;
  }

  const state = await controller.getPopupState();
  if (!state.publicKey) {
    return;
  }

  const sender = notification.sender ?? state.publicKey;
  if (sender !== state.publicKey) {
    return;
  }

  const contract = notification.contract ?? "unknown";
  const functionName = notification.function ?? "transaction";
  const tx: StoredLocalActivityTx = {
    hash: notification.txHash,
    sender,
    contract,
    function: functionName,
    success: notification.finalized === true || notification.accepted === true,
    created_at: new Date().toISOString(),
    payload: {
      sender,
      contract,
      function: functionName,
      kwargs: notification.kwargs ?? {}
    },
    local: true
  };

  if (notification.finalized === true) {
    tx.local_status = "finalized";
  } else if (notification.accepted === true) {
    tx.local_status = "accepted";
  }
  if (notification.message !== undefined) {
    tx.result = { message: notification.message };
  }

  const networkKey = `${state.activeNetworkId ?? state.rpcUrl}|${state.rpcUrl}|${sender}`;
  await saveLocalActivityTx(networkKey, tx);
}

async function publishProviderTransaction(
  runtimeMessage: ProviderRequestRuntimeMessage,
  result: { status: "fulfilled"; result: unknown },
  autoApproved: boolean
): Promise<void> {
  const notification = buildTransactionSubmittedMessage(
    runtimeMessage,
    result,
    autoApproved
  );
  if (!notification) {
    return;
  }

  try {
    await recordProviderTransactionActivity(notification);
  } catch {
    // Activity fallback is best-effort; the dapp response must not depend on it.
  }

  try {
    await chrome.runtime.sendMessage(notification);
  } catch {
    // Popup/side panel may not be open.
  }
}

const controller = new WalletController({
  wallet: WALLET_METADATA,
  version: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.1.0",
  store: {
    loadState: loadWalletState,
    saveState: saveWalletState,
    clearState: clearWalletState,
    loadUnlockedSession,
    saveUnlockedSession,
    clearUnlockedSession,
    loadRequestState,
    saveRequestState,
    deleteRequestState,
    listRequestStates,
    loadApprovalState,
    saveApprovalState,
    deleteApprovalState,
    listApprovalStates
  },
  getUnlockedSessionExpiry: async (now) =>
    (await loadAutoLock())
      ? now + UNLOCKED_SESSION_TIMEOUT_MS
      : DISABLED_AUTO_LOCK_EXPIRES_AT,
  onApprovalRequested: async (approvalId) => {
    void updateApprovalBadge();
    const shellMode = await loadWalletShellMode();
    if (shellMode === "sidePanel") {
      // Side panel is always visible — notify it to show the approval inline
      try {
        await chrome.runtime.sendMessage({ type: "approval_notify", approvalId });
      } catch {
        // Popup/panel not open — fall back to external window
        const windowId = await openApprovalWindow(approvalId);
        approvalWindowIds.set(windowId, approvalId);
        await controller.attachApprovalWindow(approvalId, windowId);
      }
      return;
    }
    const windowId = await openApprovalWindow(approvalId);
    approvalWindowIds.set(windowId, approvalId);
    await controller.attachApprovalWindow(approvalId, windowId);
  },
  onProviderEvent: broadcastProviderEvent
});

async function syncApprovalWindows(): Promise<void> {
  if (syncApprovalsPromise) {
    await syncApprovalsPromise;
    return;
  }

  syncApprovalsPromise = (async () => {
    const shellMode = await loadWalletShellMode();
    const approvals = await controller.listApprovalStates();
    const windows = (await chrome.windows.getAll()) as Array<{ id?: number }>;
    const openWindowIds = new Set(
      windows
        .map((windowInfo) => windowInfo.id)
        .filter((value): value is number => typeof value === "number")
    );

    approvalWindowIds.clear();

    for (const approval of approvals) {
      if (typeof approval.windowId === "number") {
        if (openWindowIds.has(approval.windowId)) {
          approvalWindowIds.set(approval.windowId, approval.id);
          continue;
        }
        await controller.dismissApproval(approval.id);
        continue;
      }

      if (shellMode === "sidePanel") {
        // Side panel handles approvals inline — don't open a window
        continue;
      }

      const windowId = await openApprovalWindow(approval.id);
      approvalWindowIds.set(windowId, approval.id);
      await controller.attachApprovalWindow(approval.id, windowId);
    }
  })();

  try {
    await syncApprovalsPromise;
  } finally {
    syncApprovalsPromise = null;
    void updateApprovalBadge();
  }
}

void syncApprovalWindows();
void loadWalletShellMode()
  .then((shellMode) => applyShellMode(shellMode))
  .catch(() => applyShellMode(DEFAULT_WALLET_SHELL_MODE));

chrome.runtime.onInstalled.addListener(() => {
  void loadWalletShellMode()
    .then((shellMode) => applyShellMode(shellMode))
    .catch(() => applyShellMode(DEFAULT_WALLET_SHELL_MODE));
});

chrome.runtime.onStartup?.addListener(() => {
  void syncApprovalWindows();
  void loadWalletShellMode()
    .then((shellMode) => applyShellMode(shellMode))
    .catch(() => applyShellMode(DEFAULT_WALLET_SHELL_MODE));
});

chrome.windows.onRemoved.addListener((windowId: number) => {
  const approvalId = approvalWindowIds.get(windowId);
  if (!approvalId) {
    return;
  }

  void (async () => {
    try {
      await chrome.windows.get(windowId);
      return;
    } catch {
      // The removed window is still gone; dismiss the matching approval below.
    }
    if (approvalWindowIds.get(windowId) !== approvalId) {
      return;
    }
    approvalWindowIds.delete(windowId);
    await controller.dismissApproval(approvalId);
    await updateApprovalBadge();
  })();
});

chrome.runtime.onMessage.addListener(
  (
    message: RuntimeMessage,
    _sender: unknown,
    sendResponse: (response: ReturnType<typeof ok> | ReturnType<typeof fail>) => void
  ) => {
    // This message is broadcast by this background worker for popup/side-panel
    // consumers. Do not feed it back through request synchronization here.
    if (
      (message as RuntimeMessage | WalletTransactionSubmittedRuntimeMessage).type ===
      "wallet_transaction_submitted"
    ) {
      return false;
    }

    void (async () => {
      try {
        if (
          message.type !== "approval_get" &&
          message.type !== "approval_resolve"
        ) {
          await syncApprovalWindows();
        }

        switch (message.type) {
          case "wallet_get_popup_state":
            sendResponse(ok(await getPopupRuntimeState()));
            return;
          case "wallet_get_asset_balances":
            sendResponse(ok(await controller.getAssetBalanceSnapshot()));
            return;
          case "wallet_get_detected_assets":
            sendResponse(ok(await controller.getDetectedAssets()));
            return;
          case "wallet_get_token_metadata":
            sendResponse(ok(await controller.getTokenMetadata(message.contract)));
            return;
          case "wallet_track_asset":
            sendResponse(ok(await controller.trackAsset(message.asset)));
            return;
          case "wallet_update_assets":
            sendResponse(ok(await controller.updateAssetSettings(message.assets)));
            return;
          case "wallet_update_asset_decimals":
            sendResponse(ok(await controller.updateWatchedAssetDecimals(message.contract, message.decimals)));
            return;
          case "wallet_estimate_transaction":
            sendResponse(ok(await controller.estimateTransactionChi({
              contract: message.contract,
              function: message.function,
              kwargs: message.kwargs
            })));
            return;
          case "wallet_get_chi_rate":
            sendResponse(ok(await controller.getChiRate()));
            return;
          case "wallet_send_direct_transaction":
            sendResponse(ok(await controller.sendDirectTransaction({
              contract: message.contract,
              function: message.function,
              kwargs: message.kwargs,
              chi: message.chi
            })));
            return;
          case "wallet_get_contract_methods":
            sendResponse(ok(await controller.getContractMethods(message.contract)));
            return;
          case "wallet_get_dex_snapshot":
            sendResponse(ok(await controller.getDexSnapshot()));
            return;
          case "wallet_create":
            {
              const created = await controller.createOrImportWallet(message);
              sendResponse(
                ok({
                  ...created,
                  popupState: await getPopupRuntimeState()
                })
              );
            }
            return;
          case "wallet_unlock":
            sendResponse(ok(await controller.unlockWallet(message.password)));
            return;
          case "wallet_lock":
            sendResponse(ok(await controller.lockWallet()));
            return;
          case "wallet_remove":
            sendResponse(ok(await controller.removeWallet()));
            return;
          case "wallet_update_settings":
            sendResponse(ok(await controller.updateSettings(message)));
            return;
          case "wallet_save_network_preset":
            sendResponse(ok(await controller.saveNetworkPreset(message)));
            return;
          case "wallet_switch_network":
            sendResponse(ok(await controller.switchNetwork(message.presetId)));
            return;
          case "wallet_remove_network_preset":
            sendResponse(ok(await controller.removeNetworkPreset(message.presetId)));
            return;
          case "wallet_disconnect_origin":
            sendResponse(ok(await controller.disconnectOrigin(message.origin)));
            return;
          case "wallet_disconnect_all_origins":
            sendResponse(ok(await controller.disconnectAllOrigins()));
            return;
          case "wallet_remove_trusted_dapp_policy":
            sendResponse(ok(await controller.removeTrustedDappPolicy(message.policyId)));
            return;
          case "wallet_remove_asset":
            sendResponse(ok(await controller.removeWatchedAsset(message.contract)));
            return;
          case "wallet_add_account":
            sendResponse(ok(await controller.addAccount()));
            return;
          case "wallet_switch_account":
            sendResponse(ok(await controller.switchAccount(message.index)));
            return;
          case "wallet_rename_account":
            sendResponse(ok(await controller.renameAccount(message.index, message.name)));
            return;
          case "wallet_remove_account":
            sendResponse(ok(await controller.removeAccount(message.index)));
            return;
          case "wallet_export":
            sendResponse(ok(await controller.exportWallet(message.password)));
            return;
          case "wallet_import_backup":
            sendResponse(ok(await controller.importWalletBackup(message.backup, message.password)));
            return;
          case "wallet_save_shielded_snapshot":
            sendResponse(
              ok(
                await controller.saveShieldedWalletSnapshot(
                  message.stateSnapshot,
                  message.label
                )
              )
            );
            return;
          case "wallet_export_shielded_snapshot":
            sendResponse(
              ok(
                await controller.exportShieldedWalletSnapshot(
                  message.snapshotId,
                  message.password
                )
              )
            );
            return;
          case "wallet_remove_shielded_snapshot":
            sendResponse(
              ok(
                await controller.removeShieldedWalletSnapshot(
                  message.snapshotId
                )
              )
            );
            return;
          case "wallet_get_shielded_snapshot_history":
            sendResponse(
              ok(
                await controller.getShieldedWalletSnapshotHistory(
                  message.snapshotId,
                  message.limit
                )
              )
            );
            return;
          case "wallet_reveal_mnemonic":
            sendResponse(ok(await controller.revealMnemonic(message.password)));
            return;
          case "wallet_reveal_private_key":
            sendResponse(ok(await controller.revealPrivateKey(message.password)));
            return;
          case "wallet_set_shell_mode":
            sendResponse(ok(await setShellMode(message.shellMode)));
            return;
          case "wallet_get_auto_lock":
            sendResponse(ok(await loadAutoLock()));
            return;
          case "wallet_set_auto_lock":
            await saveAutoLock(message.enabled);
            {
              const session = await loadUnlockedSession();
              if (session) {
                session.expiresAt = message.enabled
                  ? Date.now() + UNLOCKED_SESSION_TIMEOUT_MS
                  : DISABLED_AUTO_LOCK_EXPIRES_AT;
                await saveUnlockedSession(session);
              }
            }
            sendResponse(ok(await getPopupRuntimeState()));
            return;
          case "contacts_get":
            sendResponse(ok(await loadContacts()));
            return;
          case "contacts_save":
            await saveContacts(message.contacts);
            sendResponse(ok(null));
            return;
          case "approval_get":
            sendResponse(ok(await controller.getApprovalView(message.approvalId)));
            return;
          case "approval_resolve": {
            const result = await controller.resolveApproval(
              message.approvalId,
              message.approved,
              { trust: message.trust }
            );
            void updateApprovalBadge();
            sendResponse(ok(result));
            return;
          }
          case "provider_request":
            {
              const result = await controller.startProviderRequest(
                message.requestId,
                message.origin,
                message.request,
                { dappMetadata: message.dappMetadata }
              );
              if (result.status === "fulfilled") {
                await publishProviderTransaction(message, result, true);
              }
              sendResponse(ok(result));
            }
            return;
          case "provider_request_status":
            {
              const storedRequest = await loadRequestState(message.requestId);
              const result = await controller.getProviderRequestStatus(
                message.requestId,
                {
                  origin: message.origin,
                  consume: message.consume
                }
              );
              const completedRequest = completedProviderRequestMessage(
                message,
                storedRequest,
                result
              );
              if (completedRequest && result.status === "fulfilled") {
                await publishProviderTransaction(completedRequest, result, false);
              }
              sendResponse(ok(result));
            }
            return;
          default:
            throw new Error("unsupported runtime message");
        }
      } catch (error) {
        sendResponse(fail(error));
      }
    })();

    return true;
  }
);
