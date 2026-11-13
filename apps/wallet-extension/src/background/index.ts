import { WalletController } from "@xian-tech/wallet-core";

import { unlockedSessionExpiry } from "./auto-lock";
import { authorizeRuntimeMessage, type MessageSender } from "./message-sender";
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
  saveLocalActivityTx,
  type StoredLocalActivityTx
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
    tx_hash: notification.txHash,
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

const runtimeHandlers = createRuntimeHandlers({
  controller,
  getPopupRuntimeState,
  setShellMode,
  updateApprovalBadge,
  publishProviderTransaction
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
