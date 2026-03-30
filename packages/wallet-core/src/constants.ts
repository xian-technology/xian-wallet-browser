import type { XianWalletCapabilities } from "@xian-tech/provider";

import type { WalletNetworkPreset } from "./types";

export const DEFAULT_RPC_URL = "http://127.0.0.1:26657";
export const DEFAULT_DASHBOARD_URL = "http://127.0.0.1:8080";
export const LOCAL_NETWORK_PRESET_ID = "local-node";
export const LOCAL_NETWORK_PRESET_NAME = "Local node";
export const UNLOCKED_SESSION_TIMEOUT_MS = 5 * 60 * 1000;

export const DEFAULT_NETWORK_PRESETS: WalletNetworkPreset[] = [
  {
    id: LOCAL_NETWORK_PRESET_ID,
    name: LOCAL_NETWORK_PRESET_NAME,
    rpcUrl: DEFAULT_RPC_URL,
    dashboardUrl: DEFAULT_DASHBOARD_URL,
    builtin: true
  }
];

export const DEFAULT_WALLET_CAPABILITIES: XianWalletCapabilities = {
  getWalletInfo: true,
  prepareTransaction: true,
  signMessage: true,
  signTransaction: true,
  sendTransaction: true,
  sendCall: true,
  switchChain: true,
  watchAsset: true
};
