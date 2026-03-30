import { WalletController } from "@xian/wallet-core";

import { fail, ok, type RuntimeMessage } from "../shared/messages";
import {
  deleteApprovalState,
  listApprovalStates,
  listRequestStates,
  loadApprovalState,
  loadRequestState,
  loadWalletState,
  saveApprovalState,
  saveRequestState,
  saveWalletState,
  deleteRequestState
} from "../shared/storage";

const WALLET_METADATA = {
  id: "xian-wallet-shell",
  name: "Xian Wallet Shell",
  rdns: "org.xian.wallet.shell"
};

const approvalWindowIds = new Map<number, string>();
let syncApprovalsPromise: Promise<void> | null = null;

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
    loadRequestState,
    saveRequestState,
    deleteRequestState,
    listRequestStates,
    loadApprovalState,
    saveApprovalState,
    deleteApprovalState,
    listApprovalStates
  },
  onApprovalRequested: async (approvalId) => {
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

      const windowId = await openApprovalWindow(approval.id);
      approvalWindowIds.set(windowId, approval.id);
      await controller.attachApprovalWindow(approval.id, windowId);
    }
  })();

  try {
    await syncApprovalsPromise;
  } finally {
    syncApprovalsPromise = null;
  }
}

void syncApprovalWindows();
chrome.runtime.onStartup?.addListener(() => {
  void syncApprovalWindows();
});

chrome.windows.onRemoved.addListener((windowId: number) => {
  const approvalId = approvalWindowIds.get(windowId);
  if (!approvalId) {
    return;
  }

  approvalWindowIds.delete(windowId);
  void controller.dismissApproval(approvalId);
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
            sendResponse(ok(await controller.getPopupState()));
            return;
          case "wallet_create":
            sendResponse(ok(await controller.createOrImportWallet(message)));
            return;
          case "wallet_unlock":
            sendResponse(ok(await controller.unlockWallet(message.password)));
            return;
          case "wallet_lock":
            sendResponse(ok(await controller.lockWallet()));
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
          case "wallet_reveal_mnemonic":
            sendResponse(ok(await controller.revealMnemonic(message.password)));
            return;
          case "approval_get":
            sendResponse(ok(await controller.getApprovalView(message.approvalId)));
            return;
          case "approval_resolve":
            sendResponse(ok(await controller.resolveApproval(message.approvalId, message.approved)));
            return;
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
