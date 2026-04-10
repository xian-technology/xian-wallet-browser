import {
  UNLOCKED_SESSION_TIMEOUT_MS,
  WalletController
} from "@xian-tech/wallet-core";

import { fail, ok, type RuntimeMessage } from "../shared/messages";
import {
  DEFAULT_WALLET_SHELL_MODE,
  type WalletShellMode
} from "../shared/preferences";
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
  saveAutoLock
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

  approvalWindowIds.delete(windowId);
  void controller.dismissApproval(approvalId).then(() => updateApprovalBadge());
});

chrome.runtime.onMessage.addListener(
  (
    message: RuntimeMessage,
    _sender: unknown,
    sendResponse: (response: ReturnType<typeof ok> | ReturnType<typeof fail>) => void
  ) => {
    void (async () => {
      try {
        await syncApprovalWindows();

        switch (message.type) {
          case "wallet_get_popup_state":
            sendResponse(ok(await getPopupRuntimeState()));
            return;
          case "wallet_get_asset_balances":
            sendResponse(ok(await controller.getAssetBalances()));
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
            sendResponse(ok(await controller.estimateTransactionStamps({
              contract: message.contract,
              function: message.function,
              kwargs: message.kwargs
            })));
            return;
          case "wallet_get_stamp_rate":
            sendResponse(ok(await controller.getStampRate()));
            return;
          case "wallet_send_direct_transaction":
            sendResponse(ok(await controller.sendDirectTransaction({
              contract: message.contract,
              function: message.function,
              kwargs: message.kwargs,
              stamps: message.stamps
            })));
            return;
          case "wallet_get_contract_methods":
            sendResponse(ok(await controller.getContractMethods(message.contract)));
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
            // If disabling auto-lock, extend current session to far future
            if (!message.enabled) {
              const session = await loadUnlockedSession();
              if (session) {
                session.expiresAt = DISABLED_AUTO_LOCK_EXPIRES_AT;
                await saveUnlockedSession(session);
              }
            }
            sendResponse(ok(null));
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
            const result = await controller.resolveApproval(message.approvalId, message.approved);
            void updateApprovalBadge();
            sendResponse(ok(result));
            return;
          }
          case "provider_request":
            sendResponse(
              ok(
                await controller.startProviderRequest(
                  message.requestId,
                  message.origin,
                  message.request
                )
              )
            );
            return;
          case "provider_request_status":
            sendResponse(
              ok(
                await controller.getProviderRequestStatus(message.requestId, {
                  consume: message.consume
                })
              )
            );
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
