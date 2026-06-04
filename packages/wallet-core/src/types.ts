import type {
  XianDappPolicy,
  XianProviderRequest,
  XianWatchedAsset
} from "@xian-tech/provider";

export type WalletSeedSource = "privateKey" | "mnemonic";
export type WalletNetworkStatus = "ready" | "unreachable" | "mismatch";

export interface WalletNetworkPreset {
  id: string;
  name: string;
  chainId?: string;
  rpcUrl: string;
  dashboardUrl?: string;
  allowInsecureHttp?: boolean;
  builtin?: boolean;
}

export interface WalletAccount {
  index: number;
  publicKey: string;
  encryptedPrivateKey: string;
  name: string;
}

export interface StoredShieldedWalletSnapshot {
  id: string;
  label: string;
  assetId: string;
  syncHint: string;
  encryptedStateSnapshot: string;
  noteCount: number;
  commitmentCount: number;
  lastScannedIndex: number;
  updatedAt: string;
}

export interface ShieldedWalletSnapshotSummary {
  id: string;
  label: string;
  assetId: string;
  syncHint: string;
  noteCount: number;
  commitmentCount: number;
  lastScannedIndex: number;
  updatedAt: string;
}

export interface ShieldedWalletHistoryEntry {
  txHash: string | null;
  blockHeight: number | bigint | null;
  function: string | null;
  action: string | null;
  noteIndex: number | bigint | null;
  commitment: string | null;
  hasPayload: boolean;
  createdAt: string | null;
}

export interface ShieldedWalletHistoryStatus {
  snapshotId: string;
  label: string;
  available: boolean;
  hasNewerIndexedHistory: boolean;
  checkedAfterNoteIndex: number;
  newItems: ShieldedWalletHistoryEntry[];
}

export interface StoredWalletState {
  publicKey: string;
  encryptedPrivateKey: string;
  encryptedMnemonic?: string;
  walletEncryptionSalt: string;
  seedSource: WalletSeedSource;
  mnemonicWordCount?: number;
  accounts?: WalletAccount[];
  activeAccountIndex?: number;
  rpcUrl: string;
  dashboardUrl?: string;
  activeNetworkId: string;
  networkPresets: WalletNetworkPreset[];
  watchedAssets: WalletWatchedAsset[];
  assetNetworkStates?: WalletAssetNetworkStates;
  trustedDappPolicies?: XianDappPolicy[];
  connectedDappMetadata?: Record<string, WalletConnectedDappMetadata>;
  shieldedWalletSnapshots?: StoredShieldedWalletSnapshot[];
  connectedOrigins: string[];
  createdAt: string;
}

export interface WalletStateStore {
  loadState(): Promise<StoredWalletState | null>;
  saveState(state: StoredWalletState): Promise<void>;
  clearState(): Promise<void>;
}

export interface WalletSerializedError {
  name?: string;
  message: string;
  code?: number;
  data?: unknown;
}

export interface StoredUnlockedSession {
  publicKey: string;
  expiresAt: number;
  sessionKey?: string;
}

export type StoredProviderRequestStatus =
  | "pending"
  | "fulfilled"
  | "rejected";

export interface StoredProviderRequest {
  requestId: string;
  origin: string;
  request: XianProviderRequest;
  dappMetadata?: WalletConnectedDappMetadata;
  createdAt: number;
  updatedAt: number;
  status: StoredProviderRequestStatus;
  approvalId?: string;
  result?: unknown;
  error?: WalletSerializedError;
}

export interface PersistedApproval {
  id: string;
  requestId: string;
  record: PendingApprovalRecord;
  view: ApprovalView;
  windowId?: number;
}

export interface WalletControllerStore extends WalletStateStore {
  loadUnlockedSession(): Promise<StoredUnlockedSession | null>;
  saveUnlockedSession(state: StoredUnlockedSession): Promise<void>;
  clearUnlockedSession(): Promise<void>;
  loadRequestState(requestId: string): Promise<StoredProviderRequest | null>;
  saveRequestState(state: StoredProviderRequest): Promise<void>;
  deleteRequestState(requestId: string): Promise<void>;
  listRequestStates(): Promise<StoredProviderRequest[]>;
  loadApprovalState(approvalId: string): Promise<PersistedApproval | null>;
  saveApprovalState(state: PersistedApproval): Promise<void>;
  deleteApprovalState(approvalId: string): Promise<void>;
  listApprovalStates(): Promise<PersistedApproval[]>;
}

export interface PopupState {
  hasWallet: boolean;
  unlocked: boolean;
  sessionExpiresAt?: number;
  publicKey?: string;
  rpcUrl: string;
  dashboardUrl?: string;
  chainId?: string;
  resolvedChainId?: string;
  configuredChainId?: string;
  networkStatus: WalletNetworkStatus;
  activeNetworkId?: string;
  activeNetworkName?: string;
  networkPresets: WalletNetworkPreset[];
  watchedAssets: WalletWatchedAsset[];
  assetNetworkStates: WalletAssetNetworkStates;
  detectedAssets: WalletDetectedAsset[];
  /** Maps contract address to raw balance (number as string), or null if fetch failed. */
  assetBalances: Record<string, string | null>;
  /** Maps contract address to fiat display string (e.g. "$12.34"), or null if unavailable. */
  assetFiatValues: Record<string, string | null>;
  connectedOrigins: string[];
  trustedDappPolicies: XianDappPolicy[];
  connectedDappMetadata: Record<string, WalletConnectedDappMetadata>;
  pendingApprovalCount: number;
  pendingApprovals: ApprovalView[];
  hasRecoveryPhrase: boolean;
  seedSource?: WalletSeedSource;
  mnemonicWordCount?: number;
  accounts: Array<{ index: number; publicKey: string; name: string }>;
  activeAccountIndex: number;
  shieldedWalletSnapshots: ShieldedWalletSnapshotSummary[];
  version: string;
}

export interface WalletConnectedDappMetadata {
  name?: string;
  iconUrl?: string;
  lastSeenAt?: number;
}

export type ApprovalKind =
  | "connect"
  | "signMessage"
  | "signTransaction"
  | "sendTransaction"
  | "sendCall"
  | "watchAsset";

export interface PendingApprovalRecord {
  id: string;
  origin: string;
  kind: ApprovalKind;
  request: XianProviderRequest;
  createdAt: number;
}

export interface ApprovalView {
  id: string;
  origin: string;
  kind: ApprovalKind;
  title: string;
  description: string;
  payload: string;
  payloadLabel?: string;
  account?: string;
  chainId?: string;
  createdAt: number;
  approveLabel?: string;
  details?: ApprovalDetail[];
  highlights?: string[];
  warnings?: string[];
  trustSuggestion?: ApprovalTrustSuggestion;
}

export interface ApprovalDetail {
  label: string;
  value: string;
  monospace?: boolean;
  tone?: "default" | "accent" | "warning" | "danger";
}

export interface ApprovalTrustSuggestion {
  label: string;
  description: string;
}

export interface WalletWatchedAsset extends XianWatchedAsset {
  hidden?: boolean;
  order?: number;
}

export type WalletAssetNetworkStatus = "available" | "not_found" | "unknown";

export interface WalletAssetNetworkState {
  status?: WalletAssetNetworkStatus;
  hidden?: boolean;
  lastCheckedAt?: string;
  error?: string;
}

export type WalletAssetNetworkStates = Record<
  string,
  Record<string, WalletAssetNetworkState>
>;

export interface WalletAssetBalanceSnapshot {
  balances: Record<string, string | null>;
  assetNetworkStates: WalletAssetNetworkStates;
}

export interface WalletDetectedAsset extends XianWatchedAsset {
  balance: string | null;
  tracked: boolean;
}

export interface WalletSetupInput {
  password: string;
  privateKey?: string;
  mnemonic?: string;
  createWithMnemonic?: boolean;
  networkName?: string;
  expectedChainId?: string;
  rpcUrl?: string;
  dashboardUrl?: string;
  allowInsecureHttp?: boolean;
}

export interface WalletCreateResult {
  popupState: PopupState;
  generatedMnemonic?: string;
  importedSeedSource: WalletSeedSource;
}

export interface WalletBackupPayload {
  version: 1;
  type: WalletSeedSource;
  mnemonic?: string;
  privateKey?: string;
  accounts?: Array<{ index: number; name: string }>;
  activeAccountIndex?: number;
  activeNetworkId?: string;
  networkPresets?: WalletNetworkPreset[];
  watchedAssets?: Array<{ contract: string; name?: string; symbol?: string; icon?: string; decimals?: number }>;
  assetNetworkStates?: WalletAssetNetworkStates;
  shieldedStateSnapshots?: Array<{
    label: string;
    stateSnapshot: string;
  }>;
}

export interface EncryptedWalletBackup {
  version: 2;
  kind: "xian-wallet-backup";
  encryption: {
    algorithm: "AES-256-GCM";
    kdf: "PBKDF2-SHA256";
    iterations: number;
    salt: string;
    iv: string;
  };
  ciphertext: string;
}

export type WalletBackup = WalletBackupPayload | EncryptedWalletBackup;

export interface WalletSettingsInput {
  networkName?: string;
  expectedChainId?: string;
  rpcUrl: string;
  dashboardUrl?: string;
  allowInsecureHttp?: boolean;
}

export interface WalletNetworkPresetInput {
  id?: string;
  name: string;
  chainId?: string;
  rpcUrl: string;
  dashboardUrl?: string;
  allowInsecureHttp?: boolean;
  makeActive?: boolean;
}

export type ProviderRequestStartResult =
  | {
      status: "pending";
      approvalId: string;
    }
  | {
      status: "fulfilled";
      result: unknown;
    }
  | {
      status: "rejected";
      error: WalletSerializedError;
    };

export type ProviderRequestStatusResult =
  | {
      status: "not_found";
    }
  | {
      status: "pending";
      approvalId?: string;
    }
  | {
      status: "fulfilled";
      result: unknown;
    }
  | {
      status: "rejected";
      error: WalletSerializedError;
    };
