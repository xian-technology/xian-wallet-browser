import { WalletController, type PersistedApproval } from "@xian-tech/wallet-core";

import { unlockedSessionExpiry } from "./auto-lock";
import { authorizeRuntimeMessage, type MessageSender } from "./message-sender";
import {
  buildTransactionSubmittedMessage,
  localProviderActivity
} from "./provider-transaction";
import { dispatchRuntimeMessage } from "./runtime-dispatch";
import { createRuntimeHandlers } from "./runtime-handlers";
import { countsAsWalletActivity } from "./session-activity";

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
  claimApprovalExecution,
  saveRequestState,
  saveWalletState,
  replaceWalletState,
  saveWalletShellMode,
  deleteRequestState,
  clearUnlockedSession,
  clearWalletState,
  loadAutoLock,
  saveLocalActivityTx
} from "../shared/storage";

const WALLET_METADATA = {
  id: "xian-wallet-shell",
  name: "Xian Wallet",
  rdns: "org.xian.wallet.shell"
};

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

async function recordProviderTransactionActivity(
  notification: WalletTransactionSubmittedRuntimeMessage
): Promise<void> {
  const { txHash } = notification;
  if (!txHash) {
    return;
  }
  const activity = localProviderActivity(
    notification,
    txHash,
    await controller.getPopupState()
  );
  if (activity) {
    await saveLocalActivityTx(activity.networkKey, activity.tx);
  }
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
    replaceState: replaceWalletState,
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
    claimApprovalExecution,
    deleteApprovalState,
    listApprovalStates
  },
  getUnlockedSessionExpiry: async (now) =>
    unlockedSessionExpiry(await loadAutoLock(), now),
  onApprovalRequested: async (approvalId) => {
    void updateApprovalBadge();
    const shellMode = await loadWalletShellMode();
    if (shellMode === "sidePanel") {
      // Side panel is always visible — notify it to show the approval inline
      try {
        await chrome.runtime.sendMessage({ type: "approval_notify", approvalId });
      } catch {
        // Popup/panel not open — fall back to external window
        await openTrackedApprovalWindow(approvalId);
      }
      return;
    }
    await openTrackedApprovalWindow(approvalId);
  },
  onProviderEvent: broadcastProviderEvent
});

const runtimeHandlers = createRuntimeHandlers({
  controller,
  getPopupRuntimeState,
  setShellMode,
  updateApprovalBadge,
  publishProviderTransaction
});

async function openTrackedApprovalWindow(approvalId: string): Promise<void> {
  const windowId = await openApprovalWindow(approvalId);
  approvalWindowIds.set(windowId, approvalId);
  await controller.attachApprovalWindow(approvalId, windowId);
}

async function listOpenWindowIds(): Promise<Set<number>> {
  const windows = (await chrome.windows.getAll()) as Array<{ id?: number }>;
  return new Set(
    windows
      .map((windowInfo) => windowInfo.id)
      .filter((value): value is number => typeof value === "number")
  );
}

async function reconcileApprovalWindow(
  approval: PersistedApproval,
  openWindowIds: Set<number>,
  shellMode: WalletShellMode
): Promise<void> {
  if (typeof approval.windowId === "number") {
    if (openWindowIds.has(approval.windowId)) {
      approvalWindowIds.set(approval.windowId, approval.id);
      return;
    }
    await controller.dismissApproval(approval.id);
    return;
  }

  if (shellMode === "sidePanel") {
    // Side panel handles approvals inline — don't open a window
    return;
  }

  await openTrackedApprovalWindow(approval.id);
}

async function reconcileApprovalWindows(): Promise<void> {
  const shellMode = await loadWalletShellMode();
  const approvals = await controller.listApprovalStates();
  const openWindowIds = await listOpenWindowIds();

  approvalWindowIds.clear();

  for (const approval of approvals) {
    await reconcileApprovalWindow(approval, openWindowIds, shellMode);
  }
}

async function syncApprovalWindows(): Promise<void> {
  if (syncApprovalsPromise) {
    await syncApprovalsPromise;
    return;
  }

  syncApprovalsPromise = reconcileApprovalWindows();

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
    sender: MessageSender,
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
        message = authorizeRuntimeMessage(message, sender, chrome.runtime.id);
        if (countsAsWalletActivity(message.type)) {
          await controller.touchUnlockedSession();
        }
        if (
          message.type !== "approval_get" &&
          message.type !== "approval_resolve"
        ) {
          await syncApprovalWindows();
        }

        sendResponse(ok(await dispatchRuntimeMessage(runtimeHandlers, message)));
      } catch (error) {
        sendResponse(fail(error));
      }
    })();

    return true;
  }
);
