import type { XianProviderRequest } from "@xian-tech/provider";
import type {
  ApprovalView,
  PopupState,
  ProviderRequestStartResult,
  ProviderRequestStatusResult,
  WalletCreateResult
} from "@xian-tech/wallet-core";

import type { WalletShellMode } from "./preferences";

export const PAGE_BRIDGE_SOURCE = "xian-wallet-shell";

export interface SerializedError {
  name?: string;
  message: string;
  code?: number;
  data?: unknown;
}

export interface PageProviderRequestMessage {
  source: typeof PAGE_BRIDGE_SOURCE;
  direction: "request";
  id: string;
  request: XianProviderRequest;
}

export interface PageProviderResponseMessage {
  source: typeof PAGE_BRIDGE_SOURCE;
  direction: "response";
  id: string;
  success: boolean;
  result?: unknown;
  error?: SerializedError;
}

export interface PageProviderEventMessage {
  source: typeof PAGE_BRIDGE_SOURCE;
  direction: "event";
  event: string;
  args: unknown[];
}

export type PageBridgeMessage =
  | PageProviderRequestMessage
  | PageProviderResponseMessage
  | PageProviderEventMessage;

export interface ProviderRequestRuntimeMessage {
  type: "provider_request";
  origin: string;
  requestId: string;
  request: XianProviderRequest;
}

export interface ProviderRequestStatusRuntimeMessage {
  type: "provider_request_status";
  requestId: string;
  consume?: boolean;
}

export interface WalletCreateRuntimeMessage {
  type: "wallet_create";
  password: string;
  privateKey?: string;
  mnemonic?: string;
  createWithMnemonic?: boolean;
  networkName?: string;
  expectedChainId?: string;
  rpcUrl?: string;
  dashboardUrl?: string;
}

export interface WalletUnlockRuntimeMessage {
  type: "wallet_unlock";
  password: string;
}

export interface WalletLockRuntimeMessage {
  type: "wallet_lock";
}

export interface WalletRemoveRuntimeMessage {
  type: "wallet_remove";
}

export interface WalletUpdateSettingsRuntimeMessage {
  type: "wallet_update_settings";
  networkName?: string;
  expectedChainId?: string;
  rpcUrl: string;
  dashboardUrl?: string;
}

export interface WalletSaveNetworkPresetRuntimeMessage {
  type: "wallet_save_network_preset";
  id?: string;
  name: string;
  chainId?: string;
  rpcUrl: string;
  dashboardUrl?: string;
  makeActive?: boolean;
}

export interface WalletSwitchNetworkRuntimeMessage {
  type: "wallet_switch_network";
  presetId: string;
}

export interface WalletRemoveNetworkPresetRuntimeMessage {
  type: "wallet_remove_network_preset";
  presetId: string;
}

export interface WalletDisconnectOriginRuntimeMessage {
  type: "wallet_disconnect_origin";
  origin: string;
}

export interface WalletDisconnectAllOriginsRuntimeMessage {
  type: "wallet_disconnect_all_origins";
}

export interface WalletRemoveAssetRuntimeMessage {
  type: "wallet_remove_asset";
  contract: string;
}

export interface WalletGetPopupStateRuntimeMessage {
  type: "wallet_get_popup_state";
}

export interface WalletGetAssetBalancesRuntimeMessage {
  type: "wallet_get_asset_balances";
}

export interface WalletGetDetectedAssetsRuntimeMessage {
  type: "wallet_get_detected_assets";
}

export interface WalletGetTokenMetadataRuntimeMessage {
  type: "wallet_get_token_metadata";
  contract: string;
}

export interface WalletTrackAssetRuntimeMessage {
  type: "wallet_track_asset";
  asset: {
    contract: string;
    name?: string;
    symbol?: string;
    icon?: string;
    decimals?: number;
  };
}

export interface WalletUpdateAssetsRuntimeMessage {
  type: "wallet_update_assets";
  assets: Array<{ contract: string; hidden?: boolean; order?: number }>;
}

export interface WalletUpdateAssetDecimalsRuntimeMessage {
  type: "wallet_update_asset_decimals";
  contract: string;
  decimals: number;
}

export interface WalletEstimateTransactionRuntimeMessage {
  type: "wallet_estimate_transaction";
  contract: string;
  function: string;
  kwargs: Record<string, unknown>;
}

export interface WalletSendDirectTransactionRuntimeMessage {
  type: "wallet_send_direct_transaction";
  contract: string;
  function: string;
  kwargs: Record<string, unknown>;
  stamps?: number;
}

export interface WalletGetContractMethodsRuntimeMessage {
  type: "wallet_get_contract_methods";
  contract: string;
}

export interface WalletAddAccountRuntimeMessage {
  type: "wallet_add_account";
}

export interface WalletSwitchAccountRuntimeMessage {
  type: "wallet_switch_account";
  index: number;
}

export interface WalletRenameAccountRuntimeMessage {
  type: "wallet_rename_account";
  index: number;
  name: string;
}

export interface WalletRemoveAccountRuntimeMessage {
  type: "wallet_remove_account";
  index: number;
}

export interface WalletExportRuntimeMessage {
  type: "wallet_export";
  password: string;
}

export interface WalletImportBackupRuntimeMessage {
  type: "wallet_import_backup";
  backup: {
    version: 1;
    type: "privateKey" | "mnemonic";
    mnemonic?: string;
    privateKey?: string;
    accounts?: Array<{ index: number; name: string }>;
    activeAccountIndex?: number;
    activeNetworkId?: string;
    networkPresets?: Array<{ id: string; name: string; chainId?: string; rpcUrl: string; dashboardUrl?: string }>;
    watchedAssets?: Array<{ contract: string; name?: string; symbol?: string; icon?: string; decimals?: number }>;
  };
  password: string;
}

export interface WalletRevealMnemonicRuntimeMessage {
  type: "wallet_reveal_mnemonic";
  password: string;
}

export interface WalletRevealPrivateKeyRuntimeMessage {
  type: "wallet_reveal_private_key";
  password: string;
}

export interface WalletSetShellModeRuntimeMessage {
  type: "wallet_set_shell_mode";
  shellMode: WalletShellMode;
}

export interface ContactsGetRuntimeMessage {
  type: "contacts_get";
}

export interface ContactsSaveRuntimeMessage {
  type: "contacts_save";
  contacts: Array<{ id: string; name: string; address: string }>;
}

export interface ApprovalGetRuntimeMessage {
  type: "approval_get";
  approvalId: string;
}

export interface ApprovalResolveRuntimeMessage {
  type: "approval_resolve";
  approvalId: string;
  approved: boolean;
}

export interface ProviderEventRuntimeMessage {
  type: "provider_event";
  event: string;
  args: unknown[];
  targetOrigin?: string;
}

export type RuntimeMessage =
  | ProviderRequestRuntimeMessage
  | ProviderRequestStatusRuntimeMessage
  | WalletCreateRuntimeMessage
  | WalletUnlockRuntimeMessage
  | WalletLockRuntimeMessage
  | WalletRemoveRuntimeMessage
  | WalletUpdateSettingsRuntimeMessage
  | WalletSaveNetworkPresetRuntimeMessage
  | WalletSwitchNetworkRuntimeMessage
  | WalletRemoveNetworkPresetRuntimeMessage
  | WalletDisconnectOriginRuntimeMessage
  | WalletDisconnectAllOriginsRuntimeMessage
  | WalletRemoveAssetRuntimeMessage
  | WalletGetPopupStateRuntimeMessage
  | WalletGetAssetBalancesRuntimeMessage
  | WalletGetDetectedAssetsRuntimeMessage
  | WalletGetTokenMetadataRuntimeMessage
  | WalletTrackAssetRuntimeMessage
  | WalletUpdateAssetsRuntimeMessage
  | WalletUpdateAssetDecimalsRuntimeMessage
  | WalletEstimateTransactionRuntimeMessage
  | WalletSendDirectTransactionRuntimeMessage
  | WalletGetContractMethodsRuntimeMessage
  | WalletAddAccountRuntimeMessage
  | WalletSwitchAccountRuntimeMessage
  | WalletRenameAccountRuntimeMessage
  | WalletRemoveAccountRuntimeMessage
  | WalletExportRuntimeMessage
  | WalletImportBackupRuntimeMessage
  | WalletRevealMnemonicRuntimeMessage
  | WalletRevealPrivateKeyRuntimeMessage
  | WalletSetShellModeRuntimeMessage
  | ContactsGetRuntimeMessage
  | ContactsSaveRuntimeMessage
  | ApprovalGetRuntimeMessage
  | ApprovalResolveRuntimeMessage
  | ProviderEventRuntimeMessage;

export type ProviderRequestRuntimeResult =
  | ProviderRequestStartResult
  | ProviderRequestStatusResult;

export type PopupRuntimeState = PopupState & {
  shellMode: WalletShellMode;
};
export type WalletCreateRuntimeResult = Omit<WalletCreateResult, "popupState"> & {
  popupState: PopupRuntimeState;
};

export interface RuntimeFailure {
  ok: false;
  error: SerializedError;
}

export interface RuntimeSuccess<T> {
  ok: true;
  result: T;
}

export type RuntimeResponse<T> = RuntimeSuccess<T> | RuntimeFailure;

export function isPageBridgeMessage(value: unknown): value is PageBridgeMessage {
  return (
    typeof value === "object" &&
    value != null &&
    (value as { source?: string }).source === PAGE_BRIDGE_SOURCE
  );
}

export function serializeError(error: unknown): SerializedError {
  if (typeof error === "object" && error != null) {
    const maybeError = error as {
      name?: unknown;
      message?: unknown;
      code?: unknown;
      data?: unknown;
    };
    return {
      name:
        typeof maybeError.name === "string" ? maybeError.name : "Error",
      message:
        typeof maybeError.message === "string"
          ? maybeError.message
          : String(error),
      code:
        typeof maybeError.code === "number" ? maybeError.code : undefined,
      data: maybeError.data
    };
  }
  return {
    name: "Error",
    message: String(error)
  };
}

export function ok<T>(result: T): RuntimeSuccess<T> {
  return { ok: true, result };
}

export function fail(error: unknown): RuntimeFailure {
  return { ok: false, error: serializeError(error) };
}

export async function sendRuntimeMessage<T>(
  message: RuntimeMessage
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: RuntimeResponse<T>) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response) {
        reject(new Error("extension returned no response"));
        return;
      }
      if (!response.ok) {
        const error = new Error(response.error.message) as Error & {
          code?: number;
          data?: unknown;
          name: string;
        };
        error.name = response.error.name ?? "Error";
        error.code = response.error.code;
        error.data = response.error.data;
        reject(error);
        return;
      }
      resolve(response.result);
    });
  });
}

export function makeBridgeId(): string {
  return globalThis.crypto.randomUUID();
}

export function popupStateBanner(state: PopupState): string {
  if (!state.hasWallet) {
    return "No wallet created yet.";
  }
  if (!state.unlocked) {
    return "Wallet is locked.";
  }
  if (state.networkStatus === "mismatch") {
    return `Wallet unlocked, but ${state.activeNetworkName ?? "the active preset"} does not match the resolved chain.`;
  }
  if (state.networkStatus === "unreachable") {
    return `Wallet unlocked on ${state.activeNetworkName ?? "the active preset"}, but the RPC is currently unreachable.`;
  }
  return `Wallet unlocked on ${state.activeNetworkName ?? "the active preset"} (${state.chainId ?? "unknown chain"}).`;
}
