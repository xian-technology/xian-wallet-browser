import type { WalletController } from "@xian-tech/wallet-core";

import type {
  PopupRuntimeState,
  ProviderRequestRuntimeMessage
} from "../shared/messages";
import type { WalletShellMode } from "../shared/preferences";
import {
  loadAutoLock,
  loadContacts,
  loadRequestState,
  saveContacts
} from "../shared/storage";
import { setAutoLock } from "./auto-lock";
import { completedProviderRequestMessage } from "./provider-request-notification";
import type { RuntimeHandlerTable } from "./runtime-dispatch";

/** What the runtime handlers need from the background worker. */
export interface RuntimeHandlerContext {
  controller: WalletController;
  getPopupRuntimeState(): Promise<PopupRuntimeState>;
  setShellMode(shellMode: WalletShellMode): Promise<PopupRuntimeState>;
  updateApprovalBadge(): Promise<void>;
  publishProviderTransaction(
    message: ProviderRequestRuntimeMessage,
    result: { status: "fulfilled"; result: unknown },
    autoApproved: boolean
  ): Promise<void>;
}

function walletHandlers({ controller, getPopupRuntimeState }: RuntimeHandlerContext) {
  return {
    wallet_get_popup_state: () => getPopupRuntimeState(),
    wallet_create: async (message) => ({
      ...(await controller.createOrImportWallet(message)),
      popupState: await getPopupRuntimeState()
    }),
    wallet_unlock: (message) => controller.unlockWallet(message.password),
    wallet_lock: () => controller.lockWallet(),
    wallet_remove: () => controller.removeWallet(),
    wallet_add_account: () => controller.addAccount(),
    wallet_switch_account: (message) => controller.switchAccount(message.index),
    wallet_rename_account: (message) =>
      controller.renameAccount(message.index, message.name),
    wallet_remove_account: (message) => controller.removeAccount(message.index),
    wallet_export: (message) => controller.exportWallet(message.password),
    wallet_import_backup: (message) =>
      controller.importWalletBackup(message.backup, message.password),
    wallet_reveal_mnemonic: (message) => controller.revealMnemonic(message.password),
    wallet_reveal_private_key: (message) =>
      controller.revealPrivateKey(message.password)
  } satisfies Partial<RuntimeHandlerTable>;
}

function shieldedSnapshotHandlers({ controller }: RuntimeHandlerContext) {
  return {
    wallet_save_shielded_snapshot: (message) =>
      controller.saveShieldedWalletSnapshot(message.stateSnapshot, message.label),
    wallet_export_shielded_snapshot: (message) =>
      controller.exportShieldedWalletSnapshot(message.snapshotId, message.password),
    wallet_remove_shielded_snapshot: (message) =>
      controller.removeShieldedWalletSnapshot(message.snapshotId),
    wallet_get_shielded_snapshot_history: (message) =>
      controller.getShieldedWalletSnapshotHistory(message.snapshotId, message.limit)
  } satisfies Partial<RuntimeHandlerTable>;
}

function assetHandlers({ controller }: RuntimeHandlerContext) {
  return {
    wallet_get_asset_balances: () => controller.getAssetBalanceSnapshot(),
    wallet_get_detected_assets: () => controller.getDetectedAssets(),
    wallet_get_token_metadata: (message) =>
      controller.getTokenMetadata(message.contract),
    wallet_track_asset: (message) => controller.trackAsset(message.asset),
    wallet_update_assets: (message) => controller.updateAssetSettings(message.assets),
    wallet_update_asset_decimals: (message) =>
      controller.updateWatchedAssetDecimals(message.contract, message.decimals),
    wallet_remove_asset: (message) => controller.removeWatchedAsset(message.contract),
    wallet_get_dex_snapshot: () => controller.getDexSnapshot()
  } satisfies Partial<RuntimeHandlerTable>;
}

function transactionHandlers({ controller }: RuntimeHandlerContext) {
  return {
    wallet_estimate_transaction: (message) =>
      controller.estimateTransactionChi({
        contract: message.contract,
        function: message.function,
        kwargs: message.kwargs
      }),
    wallet_get_chi_rate: () => controller.getChiRate(),
    wallet_send_direct_transaction: (message) =>
      controller.sendDirectTransaction({
        contract: message.contract,
        function: message.function,
        kwargs: message.kwargs,
        chi: message.chi
      }),
    wallet_get_contract_methods: (message) =>
      controller.getContractMethods(message.contract)
  } satisfies Partial<RuntimeHandlerTable>;
}

function networkHandlers({ controller }: RuntimeHandlerContext) {
  return {
    wallet_update_settings: (message) => controller.updateSettings(message),
    wallet_save_network_preset: (message) => controller.saveNetworkPreset(message),
    wallet_switch_network: (message) => controller.switchNetwork(message.presetId),
    wallet_remove_network_preset: (message) =>
      controller.removeNetworkPreset(message.presetId),
    wallet_disconnect_origin: (message) => controller.disconnectOrigin(message.origin),
    wallet_disconnect_all_origins: () => controller.disconnectAllOrigins(),
    wallet_remove_trusted_dapp_policy: (message) =>
      controller.removeTrustedDappPolicy(message.policyId)
  } satisfies Partial<RuntimeHandlerTable>;
}

function preferenceHandlers({ getPopupRuntimeState, setShellMode }: RuntimeHandlerContext) {
  return {
    wallet_set_shell_mode: (message) => setShellMode(message.shellMode),
    wallet_get_auto_lock: () => loadAutoLock(),
    wallet_set_auto_lock: async (message) => {
      await setAutoLock(message.enabled);
      return getPopupRuntimeState();
    },
    contacts_get: () => loadContacts(),
    contacts_save: async (message) => {
      await saveContacts(message.contacts);
      return null;
    }
  } satisfies Partial<RuntimeHandlerTable>;
}

function approvalHandlers({ controller, updateApprovalBadge }: RuntimeHandlerContext) {
  return {
    approval_get: (message) => controller.getApprovalView(message.approvalId),
    approval_resolve: async (message) => {
      const result = await controller.resolveApproval(
        message.approvalId,
        message.approved,
        { trust: message.trust }
      );
      void updateApprovalBadge();
      return result;
    }
  } satisfies Partial<RuntimeHandlerTable>;
}

function providerHandlers({
  controller,
  publishProviderTransaction
}: RuntimeHandlerContext) {
  return {
    provider_request: async (message) => {
      const result = await controller.startProviderRequest(
        message.requestId,
        message.origin,
        message.request,
        { dappMetadata: message.dappMetadata }
      );
      if (result.status === "fulfilled") {
        await publishProviderTransaction(message, result, true);
      }
      return result;
    },
    provider_request_status: async (message) => {
      const storedRequest = await loadRequestState(message.requestId);
      const result = await controller.getProviderRequestStatus(message.requestId, {
        origin: message.origin,
        consume: message.consume
      });
      const completedRequest = completedProviderRequestMessage(
        message,
        storedRequest,
        result
      );
      if (completedRequest && result.status === "fulfilled") {
        await publishProviderTransaction(completedRequest, result, false);
      }
      return result;
    }
  } satisfies Partial<RuntimeHandlerTable>;
}

/** The background's answer to every runtime message type, grouped by area. */
export function createRuntimeHandlers(
  context: RuntimeHandlerContext
): RuntimeHandlerTable {
  return {
    ...walletHandlers(context),
    ...shieldedSnapshotHandlers(context),
    ...assetHandlers(context),
    ...transactionHandlers(context),
    ...networkHandlers(context),
    ...preferenceHandlers(context),
    ...approvalHandlers(context),
    ...providerHandlers(context)
  };
}
