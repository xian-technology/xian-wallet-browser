import {
  Ed25519Signer,
  shieldedSyncHintFromViewingPrivateKey,
  type XianShieldedWalletHistoryResult,
  XianClient
} from "@xian-tech/client";
import {
  createXianDappPolicyForRequest,
  findMatchingXianDappPolicy,
  ProviderChainMismatchError,
  ProviderUnauthorizedError,
  ProviderUnsupportedMethodError,
  xianDappPoliciesHaveSameScope,
  type BroadcastMode,
  type TransactionSubmission,
  type XianDappPolicy,
  type XianDappPolicyArgumentScope,
  type XianProviderRequest,
  type XianSignedTransaction,
  type XianTransactionIntent,
  type XianUnsignedTransaction,
  type XianWalletCapabilities,
  type XianWalletDescriptor,
  type XianWalletInfo,
  type XianWatchAssetRequest
} from "@xian-tech/provider";

import { approvalKindFromMethod, buildApprovalView } from "./approvals.js";
import {
  DEFAULT_NETWORK_PRESETS,
  DEFAULT_DASHBOARD_URL,
  DEFAULT_RPC_URL,
  LOCAL_NETWORK_PRESET_NAME,
  DEFAULT_WALLET_CAPABILITIES,
  LOCAL_NETWORK_PRESET_ID,
  UNLOCKED_SESSION_TIMEOUT_MS
} from "./constants.js";
import {
  createWalletSessionKey,
  decryptSecretTextWithSessionKey,
  createWalletSecret,
  decryptMnemonicWithSessionKey,
  decryptPrivateKeyWithSessionKey,
  decryptWalletBackup,
  deriveWalletSessionKey,
  derivePrivateKeyFromMnemonic,
  encryptSecretTextWithSessionKey,
  encryptMnemonicWithSessionKey,
  encryptPrivateKeyWithSessionKey,
  encryptWalletBackupPayload,
  isUnsafeMessageToSign
} from "./crypto.js";
import type {
  ApprovalView,
  PendingApprovalRecord,
  PersistedApproval,
  PopupState,
  ProviderRequestStartResult,
  ProviderRequestStatusResult,
  ShieldedWalletHistoryStatus,
  ShieldedWalletSnapshotSummary,
  StoredProviderRequest,
  StoredShieldedWalletSnapshot,
  StoredUnlockedSession,
  StoredWalletState,
  WalletAccount,
  WalletBackup,
  WalletBackupPayload,
  WalletControllerStore,
  WalletCreateResult,
  WalletDetectedAsset,
  WalletDexPairInfo,
  WalletDexSnapshot,
  WalletDexTokenInfo,
  WalletAssetBalanceSnapshot,
  WalletAssetNetworkState,
  WalletAssetNetworkStates,
  WalletConnectedDappMetadata,
  WalletNetworkPreset,
  WalletNetworkPresetInput,
  WalletNetworkStatus,
  WalletSerializedError,
  WalletSettingsInput,
  WalletSetupInput,
  WalletStateStore
} from "./types.js";

interface RequestWaiter {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

const SAFE_CHAIN_ID_LOOKUP_TIMEOUT_MS = 2_000;
const TRUSTED_DAPP_POLICY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DAPP_METADATA_TEXT_LENGTH = 120;
const MAX_DAPP_ICON_URL_LENGTH = 2048;
const DEX_ROUTER_CONTRACT = "con_dex";
const DEX_PAIRS_CONTRACT = "con_pairs";
const DEFAULT_DEX_FEE_BPS = 30;
const ZERO_DEX_FEE_BPS = 0;
const DEX_MAX_HOPS = 3;
const DEX_REQUIRED_SWAP_EXPORTS = new Set([
  "swapExactTokensForTokens",
  "swapExactTokensForTokensSupportingFeeOnTransferTokens"
]);

export interface WalletNetworkClient {
  getChainId(): Promise<string>;
  getChiRate?(): Promise<number | string | bigint | null>;
  getState?(contract: string, variable: string, keys?: string[]): Promise<unknown>;
  call?(request: {
    sender: string;
    contract: string;
    function: string;
    kwargs: Record<string, unknown>;
  }): Promise<unknown>;
  getBalance(address: string, options?: { contract?: string }): Promise<unknown>;
  getTokenBalances(
    address: string,
    options?: { limit?: number; offset?: number; includeZero?: boolean }
  ): Promise<{
    available: boolean;
    address: string;
    items: Array<{
      contract: string;
      balance: string | null;
      name: string | null;
      symbol: string | null;
      logoUrl: string | null;
    }>;
    total: number;
    limit: number;
    offset: number;
  }>;
  getTokenMetadata(contract: string): Promise<{
    contract: string;
    name: string | null;
    symbol: string | null;
    logoUrl: string | null;
    logoSvg: string | null;
  }>;
  getShieldedWalletHistory?(
    tagValue: string,
    options?: {
      kind?: string;
      limit?: number;
      afterNoteIndex?: number;
    }
  ): Promise<XianShieldedWalletHistoryResult>;
  estimateChi(request: {
    sender: string;
    contract: string;
    function: string;
    kwargs: Record<string, unknown>;
  }): Promise<{ estimated: number }>;
  getContractMethods(contract: string): Promise<{ name: string; arguments: { name: string; type: string }[] }[]>;
  getContractSource?(contract: string): Promise<string | null>;
  getContractIr?(contract: string): Promise<string | null>;
  buildTx(intent: {
    sender: string;
    contract: string;
    function: string;
    kwargs: Record<string, unknown>;
    chainId?: string;
    chi?: number | bigint;
    chiSupplied?: number | bigint;
  }): Promise<XianUnsignedTransaction>;
  signTx(
    tx: XianUnsignedTransaction,
    signer: Ed25519Signer
  ): Promise<XianSignedTransaction>;
  broadcastTx(
    tx: XianSignedTransaction,
    options?: {
      mode?: BroadcastMode;
      waitForTx?: boolean;
      timeoutMs?: number;
      pollIntervalMs?: number;
    }
  ): Promise<TransactionSubmission>;
}

export interface WalletControllerOptions {
  wallet: XianWalletDescriptor;
  version: string;
  store: WalletControllerStore;
  createClient?(state: StoredWalletState): WalletNetworkClient;
  onProviderEvent?(
    event: string,
    args: unknown[],
    targetOrigin?: string
  ): Promise<void> | void;
  onApprovalRequested?(
    approvalId: string,
    view: ApprovalView
  ): Promise<void> | void;
  createId?(): string;
  getUnlockedSessionExpiry?(now: number): Promise<number> | number;
  now?(): number;
}

function firstParamObject(
  params: unknown[] | Record<string, unknown> | undefined
): Record<string, unknown> {
  if (Array.isArray(params)) {
    return (params[0] ?? {}) as Record<string, unknown>;
  }
  return (params ?? {}) as Record<string, unknown>;
}

function parseIntentNumber(
  value: unknown,
  fieldName: string
): number | bigint | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new TypeError(`${fieldName} must be a non-negative integer`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError(`${fieldName} must be a non-negative integer`);
    }
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = BigInt(value);
    return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : parsed;
  }
  throw new TypeError(`${fieldName} must be a non-negative integer`);
}

function trimOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        url.hostname === "::1" ||
        /^127(?:\.\d{1,3}){3}$/.test(url.hostname))
    );
  } catch {
    return false;
  }
}

function assertRpcTransportAllowed(
  rpcUrl: string,
  allowInsecureHttp: boolean | undefined
): void {
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    throw new TypeError("network preset rpcUrl must be a valid URL");
  }
  if (
    parsed.protocol === "http:" &&
    !allowInsecureHttp &&
    !isLoopbackHttpUrl(rpcUrl)
  ) {
    throw new Error(
      "HTTP RPC URLs are disabled for this network. Enable HTTP data transfers only for endpoints you trust."
    );
  }
}

function trimOptionalIndexedString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string") {
      return trimOptionalString(parsed);
    }
    if (parsed == null) {
      return undefined;
    }
    if (typeof parsed === "number" || typeof parsed === "boolean") {
      return String(parsed);
    }
  } catch {
    // BDS versions that already return plain text should pass through unchanged.
  }
  return trimmed;
}

function trimNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function messageFromUnknown(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function numberFromUnknown(value: unknown, fallback = 0): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fallback;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return fallback;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function isMissingContractResult(value: unknown): boolean {
  const message = messageFromUnknown(value);
  return /ImportError\(['"]Module\s+[^'"]+\s+not found['"]\)/i.test(message) ||
    /Module\s+\S+\s+not found/i.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null;
}

function readExportDecoratorFlag(value: unknown): boolean | null {
  if (typeof value === "string") {
    return value === "export";
  }
  if (Array.isArray(value)) {
    let sawDecorator = false;
    for (const entry of value) {
      const flag = readExportDecoratorFlag(entry);
      if (flag == null) {
        continue;
      }
      sawDecorator = true;
      if (flag) {
        return true;
      }
    }
    return sawDecorator ? false : null;
  }
  if (isRecord(value)) {
    const name = value.name ?? value.id;
    return typeof name === "string" ? name === "export" : null;
  }
  return null;
}

function normalizeAssetNetworkStates(value: unknown): WalletAssetNetworkStates {
  if (!isRecord(value)) {
    return {};
  }

  const states: WalletAssetNetworkStates = {};
  for (const [networkId, rawNetworkState] of Object.entries(value)) {
    if (!networkId || !isRecord(rawNetworkState)) {
      continue;
    }

    const networkState: Record<string, WalletAssetNetworkState> = {};
    for (const [contract, rawAssetState] of Object.entries(rawNetworkState)) {
      if (!contract || !isRecord(rawAssetState)) {
        continue;
      }

      const status = rawAssetState.status;
      const normalized: WalletAssetNetworkState = {};
      if (
        status === "available" ||
        status === "not_found" ||
        status === "unknown"
      ) {
        normalized.status = status;
      }
      if (typeof rawAssetState.hidden === "boolean") {
        normalized.hidden = rawAssetState.hidden;
      }
      if (typeof rawAssetState.lastCheckedAt === "string") {
        normalized.lastCheckedAt = rawAssetState.lastCheckedAt;
      }
      if (typeof rawAssetState.error === "string") {
        normalized.error = rawAssetState.error;
      }

      if (Object.keys(normalized).length > 0) {
        networkState[contract] = normalized;
      }
    }

    if (Object.keys(networkState).length > 0) {
      states[networkId] = networkState;
    }
  }
  return states;
}

function normalizeTrustedDappPolicies(value: unknown): XianDappPolicy[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry): XianDappPolicy[] => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.origin !== "string" ||
      typeof entry.account !== "string" ||
      typeof entry.chainId !== "string" ||
      !Array.isArray(entry.methods) ||
      typeof entry.createdAt !== "number"
    ) {
      return [];
    }

    const methods = entry.methods.filter(
      (method): method is XianDappPolicy["methods"][number] =>
        method === "xian_signTransaction" ||
        method === "xian_sendTransaction" ||
        method === "xian_sendCall"
    );
    if (methods.length === 0) {
      return [];
    }

    return [
      {
        id: entry.id,
        origin: entry.origin,
        account: entry.account,
        chainId: entry.chainId,
        methods,
        contract: trimNullableString(entry.contract) ?? undefined,
        function: trimNullableString(entry.function) ?? undefined,
        maxChi:
          typeof entry.maxChi === "number" ||
          typeof entry.maxChi === "bigint" ||
          typeof entry.maxChi === "string"
            ? entry.maxChi
            : undefined,
        argumentScope: entry.argumentScope === "any" ? "any" : "exact",
        kwargs: isRecord(entry.kwargs) ? entry.kwargs : undefined,
        label: trimNullableString(entry.label) ?? undefined,
        createdAt: entry.createdAt,
        updatedAt:
          typeof entry.updatedAt === "number" ? entry.updatedAt : undefined,
        expiresAt:
          typeof entry.expiresAt === "number" ? entry.expiresAt : undefined,
        lastUsedAt:
          typeof entry.lastUsedAt === "number" ? entry.lastUsedAt : undefined,
        useCount: typeof entry.useCount === "number" ? entry.useCount : undefined
      }
    ];
  });
}

function trimMetadataText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0
    ? trimmed.slice(0, MAX_DAPP_METADATA_TEXT_LENGTH)
    : undefined;
}

function normalizeDappIconUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_DAPP_ICON_URL_LENGTH
  ) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeConnectedDappMetadataEntry(
  value: unknown,
  options?: { now?: number }
): WalletConnectedDappMetadata | null {
  if (!isRecord(value)) {
    return null;
  }

  const metadata: WalletConnectedDappMetadata = {};
  const name = trimMetadataText(value.name);
  const iconUrl = normalizeDappIconUrl(value.iconUrl);
  if (name) {
    metadata.name = name;
  }
  if (iconUrl) {
    metadata.iconUrl = iconUrl;
  }
  if (typeof value.lastSeenAt === "number" && Number.isFinite(value.lastSeenAt)) {
    metadata.lastSeenAt = value.lastSeenAt;
  } else if (typeof options?.now === "number") {
    metadata.lastSeenAt = options.now;
  }

  return Object.keys(metadata).length > 0 ? metadata : null;
}

function normalizeConnectedDappMetadata(
  value: unknown,
  connectedOrigins?: Iterable<string>
): Record<string, WalletConnectedDappMetadata> {
  if (!isRecord(value)) {
    return {};
  }

  const allowedOrigins = connectedOrigins
    ? new Set(connectedOrigins)
    : undefined;
  const metadata: Record<string, WalletConnectedDappMetadata> = {};
  for (const [origin, entry] of Object.entries(value)) {
    if (allowedOrigins && !allowedOrigins.has(origin)) {
      continue;
    }
    const normalized = normalizeConnectedDappMetadataEntry(entry);
    if (normalized) {
      metadata[origin] = normalized;
    }
  }
  return metadata;
}

function readExportedFunctionNamesFromIr(
  contractIr: string | null
): Set<string> | null {
  if (!contractIr) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contractIr);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.functions)) {
    return null;
  }

  const exported = new Set<string>();
  let sawExportMetadata = false;
  for (const entry of parsed.functions) {
    if (!isRecord(entry) || typeof entry.name !== "string") {
      continue;
    }
    if (entry.name.startsWith("__")) {
      continue;
    }

    let isExported = false;
    if (typeof entry.visibility === "string") {
      sawExportMetadata = true;
      isExported = entry.visibility === "export";
    }

    for (const decoratorValue of [entry.decorator, entry.decorators]) {
      const decoratorFlag = readExportDecoratorFlag(decoratorValue);
      if (decoratorFlag == null) {
        continue;
      }
      sawExportMetadata = true;
      isExported = isExported || decoratorFlag;
    }

    if (isExported) {
      exported.add(entry.name);
    }
  }
  return sawExportMetadata ? exported : null;
}

function readExportedFunctionNamesFromSource(
  source: string | null
): Set<string> | null {
  if (!source) {
    return null;
  }

  const exported = new Set<string>();
  let pendingExport = false;

  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    if (/^@export(?:\s*(?:\(|$))/.test(trimmed)) {
      pendingExport = true;
      continue;
    }
    if (trimmed.startsWith("@")) {
      pendingExport = false;
      continue;
    }

    const match = /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(
      trimmed
    );
    if (match) {
      const name = match[1]!;
      if (pendingExport && !name.startsWith("__")) {
        exported.add(name);
      }
      pendingExport = false;
      continue;
    }

    pendingExport = false;
  }

  return exported;
}

function normalizeTrackedAsset(
  asset: XianWatchAssetRequest["options"]
): XianWatchAssetRequest["options"] {
  return {
    contract: asset.contract.trim(),
    name: trimOptionalString(asset.name),
    symbol: trimOptionalString(asset.symbol),
    icon: trimOptionalString(asset.icon),
    decimals: asset.decimals
  };
}

function createLocalNetworkPreset(): WalletNetworkPreset {
  const preset = DEFAULT_NETWORK_PRESETS[0];
  if (preset) {
    return {
      ...preset
    };
  }
  return {
    id: LOCAL_NETWORK_PRESET_ID,
    name: LOCAL_NETWORK_PRESET_NAME,
    rpcUrl: DEFAULT_RPC_URL,
    dashboardUrl: DEFAULT_DASHBOARD_URL,
    builtin: true
  };
}

function normalizePresetInputValue(
  preset: Partial<WalletNetworkPreset>,
  fallback: {
    id: string;
    name: string;
    rpcUrl: string;
    dashboardUrl?: string;
    allowInsecureHttp?: boolean;
    builtin?: boolean;
  }
): WalletNetworkPreset {
  const rpcUrl = trimOptionalString(preset.rpcUrl) ?? fallback.rpcUrl;
  const allowInsecureHttp =
    preset.allowInsecureHttp === true || fallback.allowInsecureHttp === true;
  return {
    id: trimOptionalString(preset.id) ?? fallback.id,
    name: trimOptionalString(preset.name) ?? fallback.name,
    chainId: trimOptionalString(preset.chainId),
    rpcUrl,
    dashboardUrl:
      trimOptionalString(preset.dashboardUrl) ??
      trimOptionalString(fallback.dashboardUrl),
    allowInsecureHttp,
    builtin: preset.builtin ?? fallback.builtin
  };
}

function normalizeStoredWalletNetworks(state: StoredWalletState): StoredWalletState {
  const localPreset = createLocalNetworkPreset();
  const rawPresets = Array.isArray(state.networkPresets) ? state.networkPresets : [];
  const assetNetworkStates = normalizeAssetNetworkStates(
    (state as { assetNetworkStates?: unknown }).assetNetworkStates
  );
  const trustedDappPolicies = normalizeTrustedDappPolicies(
    (state as { trustedDappPolicies?: unknown }).trustedDappPolicies
  );
  const connectedDappMetadata = normalizeConnectedDappMetadata(
    (state as { connectedDappMetadata?: unknown }).connectedDappMetadata,
    state.connectedOrigins
  );

  if (rawPresets.length === 0) {
    const rpcUrl = trimOptionalString(state.rpcUrl) ?? DEFAULT_RPC_URL;
    const dashboardUrl =
      trimOptionalString(state.dashboardUrl) ?? DEFAULT_DASHBOARD_URL;
    const isLocalDefault =
      rpcUrl === localPreset.rpcUrl &&
      (dashboardUrl ?? "") === (localPreset.dashboardUrl ?? "");

    if (isLocalDefault) {
      return {
        ...state,
        rpcUrl: localPreset.rpcUrl,
        dashboardUrl: localPreset.dashboardUrl,
        activeNetworkId: localPreset.id,
        networkPresets: [localPreset],
        assetNetworkStates,
        trustedDappPolicies,
        connectedDappMetadata
      };
    }

    const customPreset = normalizePresetInputValue(
      {
        id: "custom-network",
        name: "Custom network",
        rpcUrl,
        dashboardUrl
      },
      {
        id: "custom-network",
        name: "Custom network",
        rpcUrl,
        dashboardUrl
      }
    );

    return {
      ...state,
      rpcUrl: customPreset.rpcUrl,
      dashboardUrl: customPreset.dashboardUrl,
      activeNetworkId: customPreset.id,
      networkPresets: [localPreset, customPreset],
      assetNetworkStates,
      trustedDappPolicies,
      connectedDappMetadata
    };
  }

  const presets = new Map<string, WalletNetworkPreset>();
  for (const rawPreset of rawPresets) {
    const preset = normalizePresetInputValue(rawPreset, {
      id: trimOptionalString(rawPreset.id) ?? "network",
      name: trimOptionalString(rawPreset.name) ?? "Network",
      rpcUrl: trimOptionalString(rawPreset.rpcUrl) ?? DEFAULT_RPC_URL,
      dashboardUrl: trimOptionalString(rawPreset.dashboardUrl),
      builtin: rawPreset.builtin
    });
    presets.set(preset.id, preset);
  }

  if (!presets.has(LOCAL_NETWORK_PRESET_ID)) {
    presets.set(LOCAL_NETWORK_PRESET_ID, localPreset);
  }

  const activeNetworkId =
    trimOptionalString(state.activeNetworkId) &&
    presets.has(trimOptionalString(state.activeNetworkId) as string)
      ? (trimOptionalString(state.activeNetworkId) as string)
      : (presets.values().next().value as WalletNetworkPreset).id;

  const activePreset = presets.get(activeNetworkId) ?? localPreset;
  return {
    ...state,
    rpcUrl: activePreset.rpcUrl,
    dashboardUrl: activePreset.dashboardUrl,
    activeNetworkId,
    networkPresets: [...presets.values()],
    assetNetworkStates,
    trustedDappPolicies,
    connectedDappMetadata
  };
}

function updateAssetNetworkStateInWallet(
  state: StoredWalletState,
  networkId: string,
  contract: string,
  update: WalletAssetNetworkState
): { state: StoredWalletState; changed: boolean } {
  const currentStates = normalizeAssetNetworkStates(state.assetNetworkStates);
  const currentNetwork = currentStates[networkId] ?? {};
  const currentAsset = currentNetwork[contract] ?? {};
  const nextAsset = { ...currentAsset, ...update };

  if (nextAsset.status === "available" || nextAsset.status === "unknown") {
    delete nextAsset.error;
  }

  if (JSON.stringify(currentAsset) === JSON.stringify(nextAsset)) {
    return { state, changed: false };
  }

  return {
    state: {
      ...state,
      assetNetworkStates: {
        ...currentStates,
        [networkId]: {
          ...currentNetwork,
          [contract]: nextAsset
        }
      }
    },
    changed: true
  };
}

function normalizeApprovalTrustScope(
  trust: boolean | XianDappPolicyArgumentScope | undefined
): XianDappPolicyArgumentScope | null {
  if (trust === true) {
    return "exact";
  }
  if (trust === "exact" || trust === "any") {
    return trust;
  }
  return null;
}

function removeAssetNetworkStateFromWallet(
  state: StoredWalletState,
  contract: string
): StoredWalletState {
  const currentStates = normalizeAssetNetworkStates(state.assetNetworkStates);
  let changed = false;
  const assetNetworkStates = Object.fromEntries(
    Object.entries(currentStates).flatMap(([networkId, networkState]) => {
      if (!(contract in networkState)) {
        return [[networkId, networkState]];
      }
      changed = true;
      const nextNetworkState = { ...networkState };
      delete nextNetworkState[contract];
      return Object.keys(nextNetworkState).length > 0
        ? [[networkId, nextNetworkState]]
        : [];
    })
  );

  return changed ? { ...state, assetNetworkStates } : state;
}

interface ParsedShieldedWalletSnapshot {
  normalizedSnapshot: string;
  assetId: string;
  syncHint: string;
  noteCount: number;
  commitmentCount: number;
  lastScannedIndex: number;
}

function parseShieldedWalletSnapshot(
  stateSnapshot: string
): ParsedShieldedWalletSnapshot {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stateSnapshot);
  } catch {
    throw new Error("shielded wallet snapshot must be valid JSON");
  }

  if (typeof decoded !== "object" || decoded == null || Array.isArray(decoded)) {
    throw new Error("shielded wallet snapshot must be a JSON object");
  }

  const record = decoded as Record<string, unknown>;
  const assetId =
    typeof record.asset_id === "string" ? trimOptionalString(record.asset_id) : undefined;
  if (!assetId) {
    throw new Error("shielded wallet snapshot must contain asset_id");
  }
  if (typeof record.owner_secret !== "string" || record.owner_secret.length === 0) {
    throw new Error("shielded wallet snapshot must contain owner_secret");
  }
  if (
    typeof record.viewing_private_key !== "string" ||
    record.viewing_private_key.length === 0
  ) {
    throw new Error(
      "shielded wallet snapshot must contain viewing_private_key"
    );
  }

  const notes = record.notes ?? [];
  if (!Array.isArray(notes)) {
    throw new Error("shielded wallet snapshot notes must be an array");
  }

  const commitments = record.commitments ?? [];
  if (!Array.isArray(commitments) || commitments.some((value) => typeof value !== "string")) {
    throw new Error(
      "shielded wallet snapshot commitments must be an array of strings"
    );
  }

  const lastScannedValue = record.last_scanned_index;
  const lastScannedIndex =
    typeof lastScannedValue === "number" &&
    Number.isInteger(lastScannedValue) &&
    lastScannedValue >= 0
      ? lastScannedValue
      : commitments.length;

  return {
    normalizedSnapshot: JSON.stringify(record),
    assetId,
    syncHint: shieldedSyncHintFromViewingPrivateKey(record.viewing_private_key),
    noteCount: notes.length,
    commitmentCount: commitments.length,
    lastScannedIndex,
  };
}

function shieldedWalletSnapshotSummary(
  record: StoredShieldedWalletSnapshot
): ShieldedWalletSnapshotSummary {
  return {
    id: record.id,
    label: record.label,
    assetId: record.assetId,
    syncHint: record.syncHint,
    noteCount: record.noteCount,
    commitmentCount: record.commitmentCount,
    lastScannedIndex: record.lastScannedIndex,
    updatedAt: record.updatedAt,
  };
}

function hydrateError(error: WalletSerializedError): Error {
  const hydrated = new Error(error.message) as Error & {
    code?: number;
    data?: unknown;
    name: string;
  };
  hydrated.name = error.name ?? "Error";
  hydrated.code = error.code;
  hydrated.data = error.data;
  return hydrated;
}

export class WalletController {
  private readonly requestWaiters = new Map<string, RequestWaiter>();
  private unlockedPrivateKey: string | null = null;
  private unlockedSigner: Ed25519Signer | null = null;
  private unlockedSessionKey: string | null = null;
  private unlockedMnemonic: string | null = null;
  private unlockedSessionExpiresAt: number | null = null;

  constructor(private readonly options: WalletControllerOptions) {}

  private get store(): WalletControllerStore {
    return this.options.store;
  }

  private providerCapabilities(): XianWalletCapabilities {
    return { ...DEFAULT_WALLET_CAPABILITIES };
  }

  private createId(): string {
    return this.options.createId?.() ?? globalThis.crypto.randomUUID();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private serializeError(error: unknown): WalletSerializedError {
    if (typeof error === "object" && error != null) {
      const candidate = error as {
        name?: unknown;
        message?: unknown;
        code?: unknown;
        data?: unknown;
      };
      return {
        name: typeof candidate.name === "string" ? candidate.name : "Error",
        message:
          typeof candidate.message === "string"
            ? candidate.message
            : String(error),
        code: typeof candidate.code === "number" ? candidate.code : undefined,
        data: candidate.data
      };
    }
    return {
      name: "Error",
      message: String(error)
    };
  }

  private async restoreUnlockedSession(): Promise<boolean> {
    const session = await this.store.loadUnlockedSession();
    if (!session) {
      this.unlockedPrivateKey = null;
      this.unlockedSigner = null;
      this.unlockedMnemonic = null;
      this.unlockedSessionKey = null;
      this.unlockedSessionExpiresAt = null;
      return false;
    }

    if (session.expiresAt <= this.now()) {
      await this.expireUnlockedSession();
      return false;
    }

    if ((!this.unlockedPrivateKey || !this.unlockedSessionKey) && session.sessionKey) {
      const state = await this.loadWalletState();
      if (!state || state.publicKey !== session.publicKey) {
        await this.clearUnlockedSession();
        return false;
      }
      try {
        const privateKey = await decryptPrivateKeyWithSessionKey(
          state.encryptedPrivateKey,
          session.sessionKey
        );
        const signer = new Ed25519Signer(privateKey);
        if (signer.address !== session.publicKey) {
          await this.clearUnlockedSession();
          return false;
        }
        this.unlockedPrivateKey = privateKey;
        this.unlockedSigner = signer;
        this.unlockedSessionKey = session.sessionKey;
        if (state.encryptedMnemonic) {
          this.unlockedMnemonic = await decryptMnemonicWithSessionKey(
            state.encryptedMnemonic,
            session.sessionKey
          ).catch(() => null);
        } else {
          this.unlockedMnemonic = null;
        }
      } catch {
        await this.clearUnlockedSession();
        return false;
      }
    }

    if (!this.unlockedPrivateKey || !this.unlockedSessionKey) {
      await this.clearUnlockedSession();
      return false;
    }

    if (!this.unlockedSigner) {
      this.unlockedSigner = new Ed25519Signer(this.unlockedPrivateKey);
    }
    if (this.unlockedSigner.address !== session.publicKey) {
      await this.clearUnlockedSession();
      return false;
    }

    this.unlockedSessionExpiresAt = session.expiresAt;
    return true;
  }

  private async resolveUnlockedSessionExpiry(): Promise<number> {
    const now = this.now();
    const expiresAt = await this.options.getUnlockedSessionExpiry?.(now);
    return typeof expiresAt === "number" && Number.isFinite(expiresAt)
      ? expiresAt
      : now + UNLOCKED_SESSION_TIMEOUT_MS;
  }

  private async persistUnlockedSession(expiresAt?: number): Promise<void> {
    if (!this.unlockedSigner || !this.unlockedSessionKey) {
      throw new ProviderUnauthorizedError("wallet is locked");
    }
    const resolvedExpiresAt =
      expiresAt ?? (await this.resolveUnlockedSessionExpiry());
    const currentSession = await this.store.loadUnlockedSession();
    const nextExpiresAt =
      currentSession?.publicKey === this.unlockedSigner.address &&
      currentSession.expiresAt > resolvedExpiresAt
        ? currentSession.expiresAt
        : resolvedExpiresAt;
    const session: StoredUnlockedSession = {
      publicKey: this.unlockedSigner.address,
      expiresAt: nextExpiresAt,
      sessionKey: this.unlockedSessionKey
    };
    await this.store.saveUnlockedSession(session);
    this.unlockedSessionExpiresAt = nextExpiresAt;
  }

  private async clearUnlockedSession(): Promise<void> {
    this.unlockedPrivateKey = null;
    this.unlockedSigner = null;
    this.unlockedMnemonic = null;
    this.unlockedSessionKey = null;
    this.unlockedSessionExpiresAt = null;
    await this.store.clearUnlockedSession();
  }

  private async expireUnlockedSession(): Promise<void> {
    await this.clearUnlockedSession();
    const state = await this.loadWalletState();
    if (!state) {
      return;
    }

    await Promise.allSettled(
      state.connectedOrigins.map((origin) =>
        this.emitDisconnectLifecycle(origin)
      )
    );
  }

  private async getUnlockedSigner(): Promise<Ed25519Signer> {
    await this.restoreUnlockedSession();
    if (!this.unlockedPrivateKey) {
      throw new ProviderUnauthorizedError("wallet is locked");
    }
    if (!this.unlockedSigner) {
      this.unlockedSigner = new Ed25519Signer(this.unlockedPrivateKey);
    }
    await this.persistUnlockedSession();
    return this.unlockedSigner;
  }

  private currentClient(state: StoredWalletState): WalletNetworkClient {
    const activePreset = this.activeNetworkPreset(state);
    assertRpcTransportAllowed(state.rpcUrl, activePreset.allowInsecureHttp);
    if (this.options.createClient) {
      return this.options.createClient(state);
    }
    return new XianClient({
      rpcUrl: state.rpcUrl,
      dashboardUrl: state.dashboardUrl
    });
  }

  private requireStoredWallet(
    state: StoredWalletState | null
  ): StoredWalletState {
    if (!state) {
      throw new ProviderUnauthorizedError("wallet is not configured");
    }
    return normalizeStoredWalletNetworks(state);
  }

  private async resolveTokenMetadataForState(
    state: StoredWalletState,
    contract: string
  ): Promise<{
    contract: string;
    name: string | null;
    symbol: string | null;
    logoUrl: string | null;
    logoSvg: string | null;
  }> {
    const normalizedContract = contract.trim();
    const client = this.currentClient(state);
    const metadata = await client.getTokenMetadata(normalizedContract);

    return {
      contract: normalizedContract,
      name: trimNullableString(metadata.name),
      symbol: trimNullableString(metadata.symbol),
      logoUrl: trimNullableString(metadata.logoUrl),
      logoSvg: trimNullableString(metadata.logoSvg)
    };
  }

  private async hydrateWatchedAssetIcons(
    state: StoredWalletState
  ): Promise<StoredWalletState> {
    const assetsMissingIcons = state.watchedAssets.some(
      (asset) => !trimOptionalString(asset.icon)
    );
    if (!assetsMissingIcons) {
      return state;
    }

    let changed = false;
    const watchedAssets = await Promise.all(
      state.watchedAssets.map(async (asset) => {
        if (trimOptionalString(asset.icon)) {
          return asset;
        }
        try {
          const metadata = await this.resolveTokenMetadataForState(
            state,
            asset.contract
          );
          const icon = metadata.logoUrl ?? metadata.logoSvg ?? undefined;
          if (!icon) {
            return asset;
          }
          changed = true;
          return {
            ...asset,
            icon
          };
        } catch {
          return asset;
        }
      })
    );

    if (!changed) {
      return state;
    }

    const nextState = {
      ...state,
      watchedAssets
    };
    await this.store.saveState(nextState);
    return nextState;
  }

  private requireAccounts(state: StoredWalletState): WalletAccount[] {
    if (!state.accounts || state.accounts.length === 0) {
      throw new Error("wallet state has no accounts");
    }
    return state.accounts;
  }

  private async sessionKeyForState(
    state: StoredWalletState,
    password: string
  ): Promise<string> {
    return deriveWalletSessionKey(password, state.walletEncryptionSalt);
  }

  private async decryptPrivateKeyForState(
    state: StoredWalletState,
    password: string
  ): Promise<string> {
    return decryptPrivateKeyWithSessionKey(
      state.encryptedPrivateKey,
      await this.sessionKeyForState(state, password)
    );
  }

  private async decryptMnemonicForState(
    state: StoredWalletState,
    password: string
  ): Promise<string> {
    if (!state.encryptedMnemonic) {
      throw new Error("wallet does not have a recovery phrase");
    }
    return decryptMnemonicWithSessionKey(
      state.encryptedMnemonic,
      await this.sessionKeyForState(state, password)
    );
  }

  private async requireUnlockedSessionKey(): Promise<string> {
    if (!(await this.restoreUnlockedSession()) || !this.unlockedSessionKey) {
      throw new ProviderUnauthorizedError("wallet is locked");
    }
    return this.unlockedSessionKey;
  }

  private storedShieldedWalletSnapshots(
    state: StoredWalletState
  ): StoredShieldedWalletSnapshot[] {
    return [...(state.shieldedWalletSnapshots ?? [])].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
    );
  }

  private shieldedWalletSnapshotSummaries(
    state: StoredWalletState
  ): ShieldedWalletSnapshotSummary[] {
    return this.storedShieldedWalletSnapshots(state).map(
      shieldedWalletSnapshotSummary
    );
  }

  private async exportShieldedWalletSnapshots(
    state: StoredWalletState,
    sessionKey: string
  ): Promise<NonNullable<WalletBackupPayload["shieldedStateSnapshots"]>> {
    const exported: NonNullable<WalletBackupPayload["shieldedStateSnapshots"]> = [];
    for (const record of this.storedShieldedWalletSnapshots(state)) {
      exported.push({
        label: record.label,
        stateSnapshot: await decryptSecretTextWithSessionKey(
          record.encryptedStateSnapshot,
          sessionKey
        ),
      });
    }
    return exported;
  }

  private async importShieldedWalletSnapshots(
    snapshots: WalletBackupPayload["shieldedStateSnapshots"] | undefined,
    sessionKey: string,
    nowIso: string
  ): Promise<StoredShieldedWalletSnapshot[]> {
    const imported: StoredShieldedWalletSnapshot[] = [];
    for (const item of snapshots ?? []) {
      if (
        typeof item !== "object" ||
        item == null ||
        typeof item.label !== "string" ||
        typeof item.stateSnapshot !== "string"
      ) {
        throw new Error(
          "backup shieldedStateSnapshots must contain label and stateSnapshot"
        );
      }
      const parsed = parseShieldedWalletSnapshot(item.stateSnapshot);
      imported.push({
        id: this.createId(),
        label: trimOptionalString(item.label) ?? parsed.assetId,
        assetId: parsed.assetId,
        syncHint: parsed.syncHint,
        encryptedStateSnapshot: await encryptSecretTextWithSessionKey(
          parsed.normalizedSnapshot,
          sessionKey
        ),
        noteCount: parsed.noteCount,
        commitmentCount: parsed.commitmentCount,
        lastScannedIndex: parsed.lastScannedIndex,
        updatedAt: nowIso,
      });
    }
    return imported;
  }

  private activeNetworkPreset(state: StoredWalletState): WalletNetworkPreset {
    const normalized = normalizeStoredWalletNetworks(state);
    return (
      normalized.networkPresets.find(
        (preset) => preset.id === normalized.activeNetworkId
      ) ??
      normalized.networkPresets[0] ??
      createLocalNetworkPreset()
    );
  }

  private async loadWalletState(): Promise<StoredWalletState | null> {
    const state = await this.store.loadState();
    if (!state) {
      return null;
    }

    const normalized = normalizeStoredWalletNetworks(state);
    if (JSON.stringify(normalized) !== JSON.stringify(state)) {
      await this.store.saveState(normalized);
    }

    return normalized;
  }

  private displayChainId(
    preset: WalletNetworkPreset,
    resolvedChainId: string | undefined
  ): string | undefined {
    return resolvedChainId ?? preset.chainId;
  }

  private networkStatus(
    preset: WalletNetworkPreset,
    resolvedChainId: string | undefined
  ): WalletNetworkStatus {
    if (!resolvedChainId) {
      return "unreachable";
    }
    if (preset.chainId && preset.chainId !== resolvedChainId) {
      return "mismatch";
    }
    return "ready";
  }

  private async emitChainChangedForConnectedOrigins(
    state: StoredWalletState,
    previousChainId?: string
  ): Promise<void> {
    if (state.connectedOrigins.length === 0) {
      return;
    }

    const preset = this.activeNetworkPreset(state);
    const nextChainId = this.displayChainId(
      preset,
      await this.safeGetChainId(state)
    );

    if (!nextChainId || nextChainId === previousChainId) {
      return;
    }

    await Promise.all(
      state.connectedOrigins.map((origin) =>
        this.broadcastProviderEvent("chainChanged", [nextChainId], origin)
      )
    );
  }

  private applyActivePreset(
    state: StoredWalletState,
    presetId: string
  ): StoredWalletState {
    const normalized = normalizeStoredWalletNetworks(state);
    const preset = normalized.networkPresets.find((entry) => entry.id === presetId);
    if (!preset) {
      throw new Error("network preset not found");
    }

    return {
      ...normalized,
      activeNetworkId: preset.id,
      rpcUrl: preset.rpcUrl,
      dashboardUrl: preset.dashboardUrl
    };
  }

  private requireConnectedOrigin(state: StoredWalletState, origin: string): void {
    if (!state.connectedOrigins.includes(origin)) {
      throw new ProviderUnauthorizedError("site is not connected to this wallet");
    }
  }

  private async safeGetChainId(
    state: StoredWalletState | null
  ): Promise<string | undefined> {
    if (!state) {
      return undefined;
    }
    try {
      return await this.withTimeout(
        this.currentClient(state).getChainId(),
        SAFE_CHAIN_ID_LOOKUP_TIMEOUT_MS
      );
    } catch {
      return undefined;
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timeoutId = globalThis.setTimeout(() => {
            reject(new Error("operation timed out"));
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timeoutId !== undefined) {
        globalThis.clearTimeout(timeoutId);
      }
    }
  }

  private async buildWalletInfo(
    state: StoredWalletState | null,
    origin: string
  ): Promise<XianWalletInfo> {
    if (!state) {
      return {
        accounts: [],
        connected: false,
        locked: true,
        capabilities: this.providerCapabilities(),
        wallet: this.options.wallet
      };
    }

    const connected = state.connectedOrigins.includes(origin);
    const unlocked = await this.restoreUnlockedSession();
    const preset = this.activeNetworkPreset(state);
    const resolvedChainId = await this.safeGetChainId(state);

    return {
      accounts: connected && unlocked ? [state.publicKey] : [],
      selectedAccount: connected && unlocked ? state.publicKey : undefined,
      chainId: this.displayChainId(preset, resolvedChainId),
      connected,
      locked: !unlocked,
      capabilities: this.providerCapabilities(),
      wallet: this.options.wallet
    };
  }

  private async persistWalletState(
    state: StoredWalletState
  ): Promise<PopupState> {
    await this.store.saveState(normalizeStoredWalletNetworks(state));
    return this.getPopupState();
  }

  private async updateConnectedOrigin(
    origin: string,
    connected: boolean,
    dappMetadata?: WalletConnectedDappMetadata
  ): Promise<StoredWalletState> {
    const state = this.requireStoredWallet(await this.loadWalletState());
    const nextOrigins = new Set(state.connectedOrigins);
    const nextDappMetadata = {
      ...(state.connectedDappMetadata ?? {})
    };

    if (connected) {
      nextOrigins.add(origin);
      const normalizedMetadata = normalizeConnectedDappMetadataEntry(
        dappMetadata,
        { now: this.now() }
      );
      if (normalizedMetadata) {
        nextDappMetadata[origin] = {
          ...(nextDappMetadata[origin] ?? {}),
          ...normalizedMetadata
        };
      }
    } else {
      nextOrigins.delete(origin);
      delete nextDappMetadata[origin];
    }
    const nextState: StoredWalletState = {
      ...state,
      connectedOrigins: [...nextOrigins],
      connectedDappMetadata: nextDappMetadata,
      trustedDappPolicies: connected
        ? state.trustedDappPolicies ?? []
        : (state.trustedDappPolicies ?? []).filter(
            (policy) => policy.origin !== origin
          )
    };
    await this.store.saveState(nextState);
    return nextState;
  }

  private async upsertTrustedDappPolicy(
    policy: XianDappPolicy
  ): Promise<void> {
    const state = this.requireStoredWallet(await this.loadWalletState());
    const currentPolicies = state.trustedDappPolicies ?? [];
    await this.store.saveState({
      ...state,
      trustedDappPolicies: [
        ...currentPolicies.filter(
          (existing) => !xianDappPoliciesHaveSameScope(existing, policy)
        ),
        policy
      ]
    });
  }

  private async touchTrustedDappPolicy(policyId: string): Promise<void> {
    const state = this.requireStoredWallet(await this.loadWalletState());
    const policies = state.trustedDappPolicies ?? [];
    if (!policies.some((policy) => policy.id === policyId)) {
      return;
    }
    await this.store.saveState({
      ...state,
      trustedDappPolicies: policies.map((policy) =>
        policy.id === policyId
          ? {
              ...policy,
              lastUsedAt: this.now(),
              useCount: (policy.useCount ?? 0) + 1
            }
          : policy
      )
    });
  }

  private async maybeExecuteTrustedDappRequest(
    state: StoredWalletState,
    origin: string,
    request: XianProviderRequest,
    account: string,
    chainId: string | undefined
  ): Promise<{ kind: "result"; value: unknown } | null> {
    if (!chainId) {
      return null;
    }

    const match = findMatchingXianDappPolicy(
      state.trustedDappPolicies ?? [],
      {
        origin,
        account,
        chainId,
        now: this.now()
      },
      request
    );

    if (!match.matched || !match.policy) {
      return null;
    }

    const value = await this.executeApprovedRequest(origin, request);
    await this.touchTrustedDappPolicy(match.policy.id);
    return {
      kind: "result",
      value
    };
  }

  private async createTrustedDappPolicyForApproval(
    approval: PersistedApproval,
    argumentScope: XianDappPolicyArgumentScope
  ): Promise<XianDappPolicy | null> {
    const state = this.requireStoredWallet(await this.loadWalletState());
    const activeChainId =
      approval.view.chainId ??
      this.displayChainId(this.activeNetworkPreset(state), await this.safeGetChainId(state));
    if (!activeChainId) {
      return null;
    }
    return createXianDappPolicyForRequest({
      id: this.createId(),
      origin: approval.record.origin,
      account: state.publicKey,
      chainId: activeChainId,
      request: approval.record.request,
      now: this.now(),
      expiresAt: this.now() + TRUSTED_DAPP_POLICY_TTL_MS,
      argumentScope
    });
  }

  private async updateWatchedAssets(
    updater: (assets: StoredWalletState["watchedAssets"]) => StoredWalletState["watchedAssets"]
  ): Promise<void> {
    const state = this.requireStoredWallet(await this.loadWalletState());
    await this.store.saveState({
      ...state,
      watchedAssets: updater(state.watchedAssets)
    });
  }

  private async fetchDetectedAssets(
    state: StoredWalletState | null
  ): Promise<WalletDetectedAsset[]> {
    if (!state) {
      return [];
    }

    const client = this.currentClient(state);
    const trackedContracts = new Set(
      state.watchedAssets.map((asset) => asset.contract)
    );
    const detectedAssets: WalletDetectedAsset[] = [];
    const seenContracts = new Set<string>();
    const pageSize = 200;
    let offset = 0;

    while (true) {
      const page = await client.getTokenBalances(state.publicKey, {
        limit: pageSize,
        offset
      });

      for (const item of page.items) {
        const contract = item.contract.trim();
        if (!contract || seenContracts.has(contract)) {
          continue;
        }
        seenContracts.add(contract);
        detectedAssets.push({
          contract,
          name: trimOptionalIndexedString(item.name),
          symbol: trimOptionalIndexedString(item.symbol),
          icon: trimOptionalIndexedString(item.logoUrl),
          balance: item.balance,
          tracked: trackedContracts.has(contract)
        });
      }

      const fetched = page.items.length;
      if (fetched === 0 || offset + fetched >= page.total) {
        break;
      }
      offset += fetched;
    }

    detectedAssets.sort((left, right) => {
      if (left.tracked !== right.tracked) {
        return left.tracked ? 1 : -1;
      }
      return left.contract.localeCompare(right.contract);
    });
    return detectedAssets;
  }

  private sanitizeNetworkPresetInput(
    input: WalletNetworkPresetInput
  ): WalletNetworkPresetInput {
    const name = input.name.trim();
    const rpcUrl = input.rpcUrl.trim();
    if (!name) {
      throw new TypeError("network preset name is required");
    }
    if (!rpcUrl) {
      throw new TypeError("network preset rpcUrl is required");
    }
    const allowInsecureHttp = input.allowInsecureHttp === true;
    assertRpcTransportAllowed(rpcUrl, allowInsecureHttp);
    return {
      ...input,
      id: trimOptionalString(input.id),
      name,
      chainId: trimOptionalString(input.chainId),
      rpcUrl,
      dashboardUrl: trimOptionalString(input.dashboardUrl),
      allowInsecureHttp,
      makeActive: input.makeActive ?? false
    };
  }

  private upsertNetworkPresetInState(
    state: StoredWalletState,
    input: WalletNetworkPresetInput
  ): StoredWalletState {
    const normalized = normalizeStoredWalletNetworks(state);
    const sanitized = this.sanitizeNetworkPresetInput(input);
    const presetId = sanitized.id ?? this.createId();
    const existingPreset = normalized.networkPresets.find(
      (preset) => preset.id === presetId
    );
    if (existingPreset?.builtin) {
      throw new Error("built-in network presets cannot be edited");
    }

    const nextPreset = normalizePresetInputValue(
      {
        id: presetId,
        name: sanitized.name,
        chainId: sanitized.chainId,
        rpcUrl: sanitized.rpcUrl,
        dashboardUrl: sanitized.dashboardUrl,
        allowInsecureHttp: sanitized.allowInsecureHttp,
        builtin: false
      },
      {
        id: presetId,
        name: sanitized.name,
        rpcUrl: sanitized.rpcUrl,
        dashboardUrl: sanitized.dashboardUrl,
        allowInsecureHttp: sanitized.allowInsecureHttp,
        builtin: false
      }
    );

    const nextPresets = normalized.networkPresets.filter(
      (preset) => preset.id !== presetId
    );
    nextPresets.push(nextPreset);

    const nextActiveNetworkId =
      sanitized.makeActive || normalized.activeNetworkId === presetId
        ? presetId
        : normalized.activeNetworkId;

    return this.applyActivePreset(
      {
        ...normalized,
        networkPresets: nextPresets
      },
      nextActiveNetworkId
    );
  }

  private async broadcastProviderEvent(
    event: string,
    args: unknown[],
    targetOrigin?: string
  ): Promise<void> {
    await this.options.onProviderEvent?.(event, args, targetOrigin);
  }

  private async emitConnectionLifecycle(
    origin: string,
    chainId: string,
    publicKey: string
  ): Promise<void> {
    await this.broadcastProviderEvent("connect", [{ chainId }], origin);
    await this.broadcastProviderEvent("accountsChanged", [[publicKey]], origin);
    await this.broadcastProviderEvent("chainChanged", [chainId], origin);
  }

  private async emitDisconnectLifecycle(origin?: string): Promise<void> {
    await this.broadcastProviderEvent("accountsChanged", [[]], origin);
    await this.broadcastProviderEvent(
      "disconnect",
      [{ code: 4100, message: "wallet disconnected" }],
      origin
    );
  }

  private async notifyUnlockedOrigins(state: StoredWalletState): Promise<void> {
    if (state.connectedOrigins.length === 0) {
      return;
    }

    const chainId =
      this.displayChainId(
        this.activeNetworkPreset(state),
        await this.safeGetChainId(state)
      ) ?? "unknown";

    await Promise.allSettled(
      state.connectedOrigins.map((origin) =>
        this.emitConnectionLifecycle(origin, chainId, state.publicKey)
      )
    );
  }

  private async emitSelectedAccountChangedForConnectedOrigins(
    state: StoredWalletState
  ): Promise<void> {
    if (state.connectedOrigins.length === 0) {
      return;
    }

    if (await this.restoreUnlockedSession()) {
      await Promise.allSettled(
        state.connectedOrigins.map((origin) =>
          this.broadcastProviderEvent(
            "accountsChanged",
            [[state.publicKey]],
            origin
          )
        )
      );
      return;
    }

    await Promise.allSettled(
      state.connectedOrigins.map((origin) =>
        this.emitDisconnectLifecycle(origin)
      )
    );
  }

  private async invalidatePendingRequests(reason: unknown): Promise<void> {
    const requestStates = await this.store.listRequestStates();
    const settledPendingRequestIds = new Set<string>();

    for (const requestState of requestStates) {
      if (requestState.status !== "pending") {
        continue;
      }
      settledPendingRequestIds.add(requestState.requestId);
      await this.rejectRequest(requestState, reason);
    }

    for (const [requestId, waiter] of this.requestWaiters.entries()) {
      if (!settledPendingRequestIds.has(requestId)) {
        waiter.reject(reason);
      }
    }
    this.requestWaiters.clear();

    for (const approval of await this.store.listApprovalStates()) {
      await this.store.deleteApprovalState(approval.id);
    }
  }

  private async prepareTransaction(
    state: StoredWalletState,
    intent: XianTransactionIntent
  ): Promise<XianUnsignedTransaction> {
    const signer = await this.getUnlockedSigner();
    const client = this.currentClient(state);
    const activeChainId = await client.getChainId();

    if (intent.chainId && intent.chainId !== activeChainId) {
      throw new ProviderChainMismatchError(
        "wallet is connected to a different chain"
      );
    }

    return client.buildTx({
      sender: signer.address,
      contract: intent.contract,
      function: intent.function,
      kwargs: intent.kwargs,
      chainId: activeChainId,
      chi: parseIntentNumber(intent.chi, "chi"),
      chiSupplied: parseIntentNumber(intent.chiSupplied, "chiSupplied")
    });
  }

  private async signPreparedTransaction(
    state: StoredWalletState,
    tx: XianUnsignedTransaction
  ): Promise<XianSignedTransaction> {
    const signer = await this.getUnlockedSigner();
    const activeChainId = await this.currentClient(state).getChainId();
    if (tx.payload.sender !== signer.address) {
      throw new ProviderUnauthorizedError(
        "transaction sender does not match the active wallet"
      );
    }
    if (tx.payload.chain_id !== activeChainId) {
      throw new ProviderChainMismatchError(
        "transaction chain does not match the active wallet chain"
      );
    }
    return this.currentClient(state).signTx(tx, signer);
  }

  private async sendPreparedTransaction(
    state: StoredWalletState,
    tx: XianUnsignedTransaction,
    options?: {
      mode?: BroadcastMode;
      waitForTx?: boolean;
      timeoutMs?: number;
      pollIntervalMs?: number;
    }
  ): Promise<TransactionSubmission> {
    const signedTx = await this.signPreparedTransaction(state, tx);
    return this.currentClient(state).broadcastTx(signedTx, options);
  }

  private async executeApprovedRequest(
    origin: string,
    request: XianProviderRequest,
    dappMetadata?: WalletConnectedDappMetadata
  ): Promise<unknown> {
    const state = this.requireStoredWallet(await this.loadWalletState());

    switch (request.method) {
      case "xian_requestAccounts": {
        await this.getUnlockedSigner();
        const chainId = this.displayChainId(
          this.activeNetworkPreset(state),
          await this.safeGetChainId(state)
        );
        const nextState = await this.updateConnectedOrigin(
          origin,
          true,
          dappMetadata
        );
        await this.emitConnectionLifecycle(
          origin,
          chainId ?? "unknown",
          nextState.publicKey
        );
        return [nextState.publicKey];
      }

      case "xian_watchAsset": {
        this.requireConnectedOrigin(state, origin);
        await this.getUnlockedSigner();
        const assetRequest = firstParamObject(
          request.params
        ) as unknown as XianWatchAssetRequest;
        const asset = normalizeTrackedAsset(assetRequest.options);
        await this.updateWatchedAssets((assets) => {
          const next = assets.filter((entry) => entry.contract !== asset.contract);
          next.push(asset);
          return next;
        });
        return true;
      }

      case "xian_signMessage": {
        this.requireConnectedOrigin(state, origin);
        const signer = await this.getUnlockedSigner();
        const { message } = firstParamObject(request.params);
        if (typeof message !== "string") {
          throw new TypeError("xian_signMessage requires a message string");
        }
        if (isUnsafeMessageToSign(message)) {
          throw new Error(
            "refusing to sign a transaction-like payload as a plain message"
          );
        }
        return signer.signMessage(message);
      }

      case "xian_signTransaction": {
        this.requireConnectedOrigin(state, origin);
        await this.getUnlockedSigner();
        const { tx } = firstParamObject(request.params);
        return this.signPreparedTransaction(state, tx as XianUnsignedTransaction);
      }

      case "xian_sendTransaction": {
        this.requireConnectedOrigin(state, origin);
        await this.getUnlockedSigner();
        const { tx, mode, waitForTx, timeoutMs, pollIntervalMs } =
          firstParamObject(request.params);

        return this.sendPreparedTransaction(state, tx as XianUnsignedTransaction, {
          mode: mode as BroadcastMode | undefined,
          waitForTx: waitForTx as boolean | undefined,
          timeoutMs: timeoutMs as number | undefined,
          pollIntervalMs: pollIntervalMs as number | undefined
        });
      }

      case "xian_sendCall": {
        this.requireConnectedOrigin(state, origin);
        await this.getUnlockedSigner();
        const { intent, mode, waitForTx, timeoutMs, pollIntervalMs } =
          firstParamObject(request.params);
        const tx = await this.prepareTransaction(
          state,
          intent as XianTransactionIntent
        );
        return this.sendPreparedTransaction(state, tx, {
          mode: mode as BroadcastMode | undefined,
          waitForTx: waitForTx as boolean | undefined,
          timeoutMs: timeoutMs as number | undefined,
          pollIntervalMs: pollIntervalMs as number | undefined
        });
      }

      default:
        throw new ProviderUnsupportedMethodError(request.method);
    }
  }

  private async fulfillRequest(
    requestState: StoredProviderRequest,
    result: unknown
  ): Promise<ProviderRequestStatusResult> {
    const nextState: StoredProviderRequest = {
      ...requestState,
      updatedAt: this.now(),
      status: "fulfilled",
      result,
      error: undefined
    };
    await this.store.saveRequestState(nextState);
    const waiter = this.requestWaiters.get(requestState.requestId);
    if (waiter) {
      this.requestWaiters.delete(requestState.requestId);
      waiter.resolve(result);
    }
    return {
      status: "fulfilled",
      result
    };
  }

  private async rejectRequest(
    requestState: StoredProviderRequest,
    error: unknown
  ): Promise<ProviderRequestStatusResult> {
    const serialized = this.serializeError(error);
    const nextState: StoredProviderRequest = {
      ...requestState,
      updatedAt: this.now(),
      status: "rejected",
      result: undefined,
      error: serialized
    };
    await this.store.saveRequestState(nextState);
    const waiter = this.requestWaiters.get(requestState.requestId);
    if (waiter) {
      this.requestWaiters.delete(requestState.requestId);
      waiter.reject(hydrateError(serialized));
    }
    return {
      status: "rejected",
      error: serialized
    };
  }

  private async requestWithEstimatedSendCallChi(
    request: XianProviderRequest,
    account: string | undefined
  ): Promise<XianProviderRequest> {
    if (request.method !== "xian_sendCall" || !account) {
      return request;
    }

    const firstParam = firstParamObject(request.params);
    const intent = isRecord(firstParam.intent) ? firstParam.intent : null;
    if (
      !intent ||
      intent.chi != null ||
      intent.chiSupplied != null ||
      typeof intent.contract !== "string" ||
      typeof intent.function !== "string"
    ) {
      return request;
    }

    const kwargs = isRecord(intent.kwargs) ? intent.kwargs : {};
    try {
      const state = this.requireStoredWallet(await this.loadWalletState());
      const estimated = await this.currentClient(state).estimateChi({
        sender: account,
        contract: intent.contract,
        function: intent.function,
        kwargs
      });
      if (!Number.isFinite(estimated.estimated) || estimated.estimated <= 0) {
        return request;
      }

      const nextFirstParam = {
        ...firstParam,
        intent: {
          ...intent,
          kwargs,
          chi: estimated.estimated
        }
      };

      return {
        ...request,
        params: Array.isArray(request.params)
          ? [nextFirstParam, ...request.params.slice(1)]
          : nextFirstParam
      };
    } catch {
      return request;
    }
  }

  private async createApprovalRequest(
    requestState: StoredProviderRequest,
    account: string | undefined,
    chainId: string | undefined
  ): Promise<ProviderRequestStartResult> {
    const request = await this.requestWithEstimatedSendCallChi(
      requestState.request,
      account
    );
    const record: PendingApprovalRecord = {
      id: this.createId(),
      origin: requestState.origin,
      kind: approvalKindFromMethod(requestState.request.method),
      request,
      createdAt: this.now()
    };
    const chiRate =
      record.kind === "signTransaction" ||
      record.kind === "sendTransaction" ||
      record.kind === "sendCall"
        ? await this.getChiRate()
        : null;
    const view = buildApprovalView(record, { account, chainId, chiRate });
    const approval: PersistedApproval = {
      id: record.id,
      requestId: requestState.requestId,
      record,
      view
    };

    await this.store.saveApprovalState(approval);
    await this.store.saveRequestState({
      ...requestState,
      request,
      updatedAt: this.now(),
      status: "pending",
      approvalId: record.id
    });

    try {
      await this.options.onApprovalRequested?.(record.id, view);
      return {
        status: "pending",
        approvalId: record.id
      };
    } catch (error) {
      await this.store.deleteApprovalState(record.id);
      const rejected = await this.rejectRequest(
        {
          ...requestState,
          approvalId: record.id
        },
        error
      );
      if (rejected.status !== "rejected") {
        throw new Error("approval request rejection did not settle correctly");
      }
      return rejected;
    }
  }

  private async executeImmediateRequest(
    state: StoredWalletState | null,
    origin: string,
    request: XianProviderRequest,
    dappMetadata?: WalletConnectedDappMetadata
  ): Promise<{ kind: "result"; value: unknown } | { kind: "approval"; account?: string; chainId?: string }> {
    switch (request.method) {
      case "xian_getWalletInfo":
        return {
          kind: "result",
          value: await this.buildWalletInfo(state, origin)
        };

      case "xian_requestAccounts": {
        const walletState = this.requireStoredWallet(state);
        await this.getUnlockedSigner();
        const approvalChainId = this.displayChainId(
          this.activeNetworkPreset(walletState),
          await this.safeGetChainId(walletState)
        );

        if (walletState.connectedOrigins.includes(origin)) {
          const nextState = await this.updateConnectedOrigin(
            origin,
            true,
            dappMetadata
          );
          return {
            kind: "result",
            value: [nextState.publicKey]
          };
        }

        return {
          kind: "approval",
          account: walletState.publicKey,
          chainId: approvalChainId
        };
      }

      case "xian_disconnect": {
        if (!state) {
          return {
            kind: "result",
            value: null
          };
        }
        await this.updateConnectedOrigin(origin, false);
        await this.emitDisconnectLifecycle(origin);
        return {
          kind: "result",
          value: null
        };
      }

      case "xian_accounts":
        if (!state || !(await this.restoreUnlockedSession()) || !state.connectedOrigins.includes(origin)) {
          return {
            kind: "result",
            value: []
          };
        }
        return {
          kind: "result",
          value: [state.publicKey]
        };

      case "xian_chainId":
        {
          const walletState = this.requireStoredWallet(state);
          return {
            kind: "result",
            value: this.displayChainId(
              this.activeNetworkPreset(walletState),
              await this.safeGetChainId(walletState)
            ) ?? null
          };
        }

      case "xian_switchChain": {
        const walletState = this.requireStoredWallet(state);
        const { chainId } = firstParamObject(request.params);
        if (typeof chainId !== "string" || chainId.length === 0) {
          throw new TypeError("xian_switchChain requires a chainId string");
        }
        const previousChainId = this.displayChainId(
          this.activeNetworkPreset(walletState),
          await this.safeGetChainId(walletState)
        );
        if (previousChainId === chainId) {
          return {
            kind: "result",
            value: null
          };
        }

        const targetPreset = walletState.networkPresets.find(
          (preset) => preset.chainId === chainId
        );
        if (!targetPreset) {
          throw new ProviderChainMismatchError(
            "wallet has no configured network preset for the requested chain"
          );
        }
        const nextState = this.applyActivePreset(walletState, targetPreset.id);
        await this.store.saveState(nextState);
        await this.emitChainChangedForConnectedOrigins(nextState, previousChainId);
        return {
          kind: "result",
          value: null
        };
      }

      case "xian_watchAsset": {
        const walletState = this.requireStoredWallet(state);
        this.requireConnectedOrigin(walletState, origin);
        await this.getUnlockedSigner();
        return {
          kind: "approval",
          account: walletState.publicKey,
          chainId: this.displayChainId(
            this.activeNetworkPreset(walletState),
            await this.safeGetChainId(walletState)
          )
        };
      }

      case "xian_signMessage": {
        const walletState = this.requireStoredWallet(state);
        this.requireConnectedOrigin(walletState, origin);
        await this.getUnlockedSigner();
        return {
          kind: "approval",
          account: walletState.publicKey,
          chainId: this.displayChainId(
            this.activeNetworkPreset(walletState),
            await this.safeGetChainId(walletState)
          )
        };
      }

      case "xian_prepareTransaction": {
        const walletState = this.requireStoredWallet(state);
        this.requireConnectedOrigin(walletState, origin);
        await this.getUnlockedSigner();
        const { intent } = firstParamObject(request.params);
        return {
          kind: "result",
          value: await this.prepareTransaction(
            walletState,
            intent as XianTransactionIntent
          )
        };
      }

      case "xian_signTransaction":
      case "xian_sendTransaction":
      case "xian_sendCall": {
        const walletState = this.requireStoredWallet(state);
        this.requireConnectedOrigin(walletState, origin);
        await this.getUnlockedSigner();
        const activeChainId = this.displayChainId(
          this.activeNetworkPreset(walletState),
          await this.safeGetChainId(walletState)
        );
        const trustedResult = await this.maybeExecuteTrustedDappRequest(
          walletState,
          origin,
          request,
          walletState.publicKey,
          activeChainId
        );
        if (trustedResult) {
          return trustedResult;
        }
        return {
          kind: "approval",
          account: walletState.publicKey,
          chainId: activeChainId
        };
      }

      default:
        throw new ProviderUnsupportedMethodError(request.method);
    }
  }

  private getAccountsList(state: StoredWalletState): Array<{ index: number; publicKey: string; name: string }> {
    return this.requireAccounts(state).map((account) => ({
      index: account.index,
      publicKey: account.publicKey,
      name: account.name
    }));
  }

  async getPopupState(): Promise<PopupState> {
    const loadedState = await this.loadWalletState();
    const state = loadedState
      ? await this.hydrateWatchedAssetIcons(loadedState)
      : null;
    const approvals = await this.store.listApprovalStates();
    const pendingApprovals = approvals
      .map((approval) => approval.view)
      .sort((left, right) => right.createdAt - left.createdAt);
    const activePreset = state ? this.activeNetworkPreset(state) : undefined;
    const resolvedChainId = await this.safeGetChainId(state);
    const unlocked = await this.restoreUnlockedSession();

    const watchedAssets = state?.watchedAssets ?? [];

    return {
      hasWallet: state != null,
      unlocked,
      sessionExpiresAt: unlocked
        ? this.unlockedSessionExpiresAt ?? undefined
        : undefined,
      publicKey: state?.publicKey,
      rpcUrl: state?.rpcUrl ?? DEFAULT_RPC_URL,
      dashboardUrl: state?.dashboardUrl ?? DEFAULT_DASHBOARD_URL,
      chainId: activePreset
        ? this.displayChainId(activePreset, resolvedChainId)
        : undefined,
      resolvedChainId,
      configuredChainId: activePreset?.chainId,
      networkStatus: activePreset
        ? this.networkStatus(activePreset, resolvedChainId)
        : "unreachable",
      activeNetworkId: activePreset?.id,
      activeNetworkName: activePreset?.name,
      networkPresets: state?.networkPresets ?? DEFAULT_NETWORK_PRESETS,
      watchedAssets,
      assetNetworkStates: state?.assetNetworkStates ?? {},
      detectedAssets: [],
      assetBalances: {},
      assetFiatValues: {},
      connectedOrigins: state?.connectedOrigins ?? [],
      trustedDappPolicies: state?.trustedDappPolicies ?? [],
      connectedDappMetadata: state?.connectedDappMetadata ?? {},
      pendingApprovalCount: pendingApprovals.length,
      pendingApprovals,
      hasRecoveryPhrase: Boolean(state?.encryptedMnemonic),
      seedSource: state?.seedSource,
      mnemonicWordCount: state?.mnemonicWordCount,
      accounts: state ? this.getAccountsList(state) : [],
      activeAccountIndex: state?.activeAccountIndex ?? 0,
      shieldedWalletSnapshots: state
        ? this.shieldedWalletSnapshotSummaries(state)
        : [],
      version: this.options.version
    };
  }

  async getAssetBalances(): Promise<Record<string, string | null>> {
    return (await this.getAssetBalanceSnapshot()).balances;
  }

  async getAssetBalanceSnapshot(): Promise<WalletAssetBalanceSnapshot> {
    const state = await this.loadWalletState();
    if (!state) {
      return {
        balances: {},
        assetNetworkStates: {}
      };
    }
    return this.fetchAssetBalanceSnapshot(state, state.watchedAssets);
  }

  async getTokenMetadata(contract: string): Promise<{
    contract: string;
    name: string | null;
    symbol: string | null;
    logoUrl: string | null;
    logoSvg: string | null;
  }> {
    const state = this.requireStoredWallet(await this.loadWalletState());
    return this.resolveTokenMetadataForState(state, contract);
  }

  async getDetectedAssets(): Promise<WalletDetectedAsset[]> {
    const state = await this.loadWalletState();
    if (!state) {
      return [];
    }
    try {
      return await this.fetchDetectedAssets(state);
    } catch {
      return [];
    }
  }

  async trackAsset(
    asset: XianWatchAssetRequest["options"]
  ): Promise<PopupState> {
    const normalized = normalizeTrackedAsset(asset);
    if (!normalized.contract) {
      throw new TypeError("asset contract is required");
    }

    const state = this.requireStoredWallet(await this.loadWalletState());
    let networkState: WalletAssetNetworkState = {
      status: "available",
      lastCheckedAt: new Date().toISOString()
    };

    // Auto-fetch metadata if any display metadata is missing.
    if (!normalized.name || !normalized.symbol || !normalized.icon) {
      try {
        const meta = await this.resolveTokenMetadataForState(
          state,
          normalized.contract
        );
        if (meta.name && !normalized.name) normalized.name = meta.name;
        if (meta.symbol && !normalized.symbol) normalized.symbol = meta.symbol;
        if (meta.logoUrl && !normalized.icon) normalized.icon = meta.logoUrl;
        if (meta.logoSvg && !normalized.icon) normalized.icon = meta.logoSvg;
      } catch (error) {
        networkState = {
          status: isMissingContractResult(error) ? "not_found" : "unknown",
          lastCheckedAt: new Date().toISOString(),
          error: messageFromUnknown(error)
        };
      }
    }

    const watchedAssets = state.watchedAssets.filter(
      (entry) => entry.contract !== normalized.contract
    );
    watchedAssets.push(normalized);
    const updated = updateAssetNetworkStateInWallet(
      {
        ...state,
        watchedAssets
      },
      state.activeNetworkId,
      normalized.contract,
      networkState
    ).state;

    await this.store.saveState(updated);
    return this.getPopupState();
  }

  async updateAssetSettings(
    assets: Array<{ contract: string; hidden?: boolean; order?: number }>
  ): Promise<PopupState> {
    let state = this.requireStoredWallet(await this.loadWalletState());
    for (const update of assets) {
      const asset = state.watchedAssets.find(
        (a) => a.contract === update.contract
      );
      if (asset) {
        if (update.hidden !== undefined) {
          state = updateAssetNetworkStateInWallet(
            state,
            state.activeNetworkId,
            update.contract,
            { hidden: update.hidden }
          ).state;
        }
        if (update.order !== undefined) {
          asset.order = update.order;
        }
      }
    }
    await this.store.saveState(state);
    return this.getPopupState();
  }

  async updateWatchedAssetDecimals(
    contract: string,
    decimals: number
  ): Promise<PopupState> {
    const state = this.requireStoredWallet(await this.loadWalletState());
    const idx = state.watchedAssets.findIndex(
      (asset) => asset.contract === contract
    );
    if (idx === -1) {
      throw new Error(`asset ${contract} is not watched`);
    }
    const existing = state.watchedAssets[idx]!;
    state.watchedAssets[idx] = { ...existing, decimals };
    await this.store.saveState(state);
    return this.getPopupState();
  }

  async estimateTransactionChi(request: {
    contract: string;
    function: string;
    kwargs: Record<string, unknown>;
  }): Promise<{ estimated: number }> {
    const state = this.requireStoredWallet(await this.loadWalletState());
    const client = this.currentClient(state);
    return client.estimateChi({
      sender: state.publicKey,
      contract: request.contract,
      function: request.function,
      kwargs: request.kwargs
    });
  }

  async getChiRate(): Promise<number | null> {
    const state = await this.loadWalletState();
    if (!state) return null;
    try {
      const client = this.currentClient(state);
      if (typeof client.getChiRate !== "function") {
        return null;
      }
      const rate = await client.getChiRate();
      return rate != null ? Number(rate) : null;
    } catch {
      return null;
    }
  }

  async sendDirectTransaction(intent: {
    contract: string;
    function: string;
    kwargs: Record<string, unknown>;
    chi?: number;
  }): Promise<unknown> {
    const state = this.requireStoredWallet(await this.loadWalletState());
    await this.getUnlockedSigner();
    const tx = await this.prepareTransaction(state, {
      contract: intent.contract,
      function: intent.function,
      kwargs: intent.kwargs,
      chi: intent.chi
    });
    return this.sendPreparedTransaction(state, tx, { mode: "commit" });
  }

  async getDexSnapshot(): Promise<WalletDexSnapshot> {
    const state = this.requireStoredWallet(await this.loadWalletState());
    const client = this.currentClient(state);

    if (typeof client.getState !== "function") {
      return {
        available: false,
        contract: DEX_ROUTER_CONTRACT,
        pairsContract: DEX_PAIRS_CONTRACT,
        reason: "Current network client does not support DEX state reads.",
        tradeFeeBps: DEFAULT_DEX_FEE_BPS,
        maxHops: DEX_MAX_HOPS,
        pairs: [],
        tokens: []
      };
    }

    const methods = await this.getContractMethods(DEX_ROUTER_CONTRACT);
    const methodNames = new Set(methods.map((method) => method.name));
    const hasSwapExport = [...DEX_REQUIRED_SWAP_EXPORTS].some((name) =>
      methodNames.has(name)
    );
    if (!hasSwapExport) {
      return {
        available: false,
        contract: DEX_ROUTER_CONTRACT,
        pairsContract: DEX_PAIRS_CONTRACT,
        reason: `${DEX_ROUTER_CONTRACT} is not deployed on this network.`,
        tradeFeeBps: DEFAULT_DEX_FEE_BPS,
        maxHops: DEX_MAX_HOPS,
        pairs: [],
        tokens: []
      };
    }

    const pairs = await this.readDexPairs(client);
    const tokenContracts = new Set<string>();
    for (const asset of state.watchedAssets) {
      tokenContracts.add(asset.contract);
    }
    for (const pair of pairs) {
      tokenContracts.add(pair.token0);
      tokenContracts.add(pair.token1);
    }

    const [tradeFeeBps, tokens] = await Promise.all([
      this.readDexTradeFeeBps(client, state.publicKey),
      Promise.all(
        [...tokenContracts].map((contract) =>
          this.readDexTokenInfo(state, client, contract)
        )
      )
    ]);

    return {
      available: true,
      contract: DEX_ROUTER_CONTRACT,
      pairsContract: DEX_PAIRS_CONTRACT,
      tradeFeeBps,
      maxHops: DEX_MAX_HOPS,
      pairs,
      tokens
    };
  }

  private async readDexPairs(
    client: WalletNetworkClient
  ): Promise<WalletDexPairInfo[]> {
    if (typeof client.getState !== "function") {
      return [];
    }
    const countRaw = await client
      .getState(DEX_PAIRS_CONTRACT, "pairs_num")
      .catch(() => 0);
    const count = Math.max(0, Math.floor(numberFromUnknown(countRaw)));
    if (count <= 0) {
      return [];
    }

    const pairs = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        this.readDexPair(client, index + 1).catch(() => null)
      )
    );
    return pairs.filter((pair): pair is WalletDexPairInfo => pair != null);
  }

  private async readDexPair(
    client: WalletNetworkClient,
    id: number
  ): Promise<WalletDexPairInfo | null> {
    if (typeof client.getState !== "function") {
      return null;
    }
    const key = String(id);
    const [
      token0,
      token1,
      reserve0,
      reserve1,
      totalSupply,
      blockTimestampLast,
      creationTime
    ] = await Promise.all([
      client.getState(DEX_PAIRS_CONTRACT, "pairs", [key, "token0"]),
      client.getState(DEX_PAIRS_CONTRACT, "pairs", [key, "token1"]),
      client.getState(DEX_PAIRS_CONTRACT, "pairs", [key, "reserve0"]),
      client.getState(DEX_PAIRS_CONTRACT, "pairs", [key, "reserve1"]),
      client.getState(DEX_PAIRS_CONTRACT, "pairs", [key, "totalSupply"]),
      client.getState(DEX_PAIRS_CONTRACT, "pairs", [key, "blockTimestampLast"]),
      client.getState(DEX_PAIRS_CONTRACT, "pairs", [key, "creationTime"])
    ]);

    if (typeof token0 !== "string" || typeof token1 !== "string") {
      return null;
    }

    return {
      id,
      token0,
      token1,
      reserve0: numberFromUnknown(reserve0),
      reserve1: numberFromUnknown(reserve1),
      totalSupply: numberFromUnknown(totalSupply),
      blockTimestampLast:
        blockTimestampLast == null ? null : String(blockTimestampLast),
      creationTime: creationTime == null ? null : String(creationTime)
    };
  }

  private async readDexTradeFeeBps(
    client: WalletNetworkClient,
    account: string
  ): Promise<number> {
    if (typeof client.call !== "function") {
      return DEFAULT_DEX_FEE_BPS;
    }
    try {
      const result = await client.call({
        sender: account,
        contract: DEX_ROUTER_CONTRACT,
        function: "getTradeFeeBps",
        kwargs: { account }
      });
      const bps = numberFromUnknown(result, DEFAULT_DEX_FEE_BPS);
      return bps === ZERO_DEX_FEE_BPS ? ZERO_DEX_FEE_BPS : DEFAULT_DEX_FEE_BPS;
    } catch {
      return DEFAULT_DEX_FEE_BPS;
    }
  }

  private async readDexTokenInfo(
    state: StoredWalletState,
    client: WalletNetworkClient,
    contract: string
  ): Promise<WalletDexTokenInfo> {
    const [metadata, precisionRaw, balanceRaw, allowanceRaw, feeOnTransferRaw] =
      await Promise.all([
        this.resolveTokenMetadataForState(state, contract).catch(() => ({
          contract,
          name: null,
          symbol: null,
          logoUrl: null,
          logoSvg: null
        })),
        client.getState
          ? client.getState(contract, "metadata", ["precision"]).catch(() => null)
          : Promise.resolve(null),
        client.getBalance(state.publicKey, { contract }).catch(() => 0),
        client.getState
          ? client
              .getState(contract, "approvals", [
                state.publicKey,
                DEX_ROUTER_CONTRACT
              ])
              .catch(() => 0)
          : Promise.resolve(0),
        client.getState
          ? client
              .getState(DEX_ROUTER_CONTRACT, "fee_on_transfer_tokens", [
                contract
              ])
              .catch(() => false)
          : Promise.resolve(false)
      ]);

    const watched = state.watchedAssets.find(
      (asset) => asset.contract === contract
    );
    const precision = Number.isInteger(numberFromUnknown(precisionRaw, NaN))
      ? numberFromUnknown(precisionRaw)
      : typeof watched?.decimals === "number"
        ? watched.decimals
        : null;

    return {
      contract,
      name: metadata.name,
      symbol: metadata.symbol,
      logoUrl: metadata.logoUrl,
      logoSvg: metadata.logoSvg,
      precision,
      balance: numberFromUnknown(balanceRaw),
      allowance: numberFromUnknown(allowanceRaw),
      feeOnTransfer: feeOnTransferRaw === true
    };
  }

  async getContractMethods(
    contract: string
  ): Promise<{ name: string; arguments: { name: string; type: string }[] }[]> {
    const state = this.requireStoredWallet(await this.loadWalletState());
    const client = this.currentClient(state);
    const methods = await client.getContractMethods(contract);
    let exportedNames: Set<string> | null = null;

    if (client.getContractIr) {
      const contractIr = await client.getContractIr(contract).catch(() => null);
      exportedNames = readExportedFunctionNamesFromIr(contractIr);
    }
    if (!exportedNames && client.getContractSource) {
      const contractSource = await client
        .getContractSource(contract)
        .catch(() => null);
      exportedNames = readExportedFunctionNamesFromSource(contractSource);
    }

    return exportedNames
      ? methods.filter((method) => exportedNames.has(method.name))
      : methods;
  }

  private async fetchAssetBalanceSnapshot(
    state: StoredWalletState | null,
    assets: { contract: string }[]
  ): Promise<WalletAssetBalanceSnapshot> {
    const balances: Record<string, string | null> = {};
    if (!state || assets.length === 0) {
      return {
        balances,
        assetNetworkStates: state?.assetNetworkStates ?? {}
      };
    }

    const client = this.currentClient(state);
    let nextState = state;
    let changed = false;
    const checkedAt = new Date().toISOString();
    const results = await Promise.allSettled(
      assets.map(async (asset) => {
        const raw = await client.getBalance(state.publicKey, {
          contract: asset.contract
        });
        return { contract: asset.contract, raw };
      })
    );
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        const { contract, raw } = result.value;
        if (isMissingContractResult(raw)) {
          balances[contract] = null;
          const updated = updateAssetNetworkStateInWallet(
            nextState,
            state.activeNetworkId,
            contract,
            {
              status: "not_found",
              lastCheckedAt: checkedAt,
              error: messageFromUnknown(raw)
            }
          );
          nextState = updated.state;
          changed = changed || updated.changed;
          continue;
        }

        balances[contract] = raw != null ? String(raw) : null;
        const updated = updateAssetNetworkStateInWallet(
          nextState,
          state.activeNetworkId,
          contract,
          { status: "available", lastCheckedAt: checkedAt }
        );
        nextState = updated.state;
        changed = changed || updated.changed;
      } else {
        const reason = result.reason;
        const contract = assets[index]?.contract;
        if (!contract) {
          continue;
        }
        balances[contract] = null;
        const updated = updateAssetNetworkStateInWallet(
          nextState,
          state.activeNetworkId,
          contract,
          {
            status: isMissingContractResult(reason) ? "not_found" : "unknown",
            lastCheckedAt: checkedAt,
            error: messageFromUnknown(reason)
          }
        );
        nextState = updated.state;
        changed = changed || updated.changed;
      }
    }

    let assetNetworkStates = nextState.assetNetworkStates ?? {};
    if (changed) {
      const latestState = await this.loadWalletState();
      if (latestState?.publicKey === state.publicKey) {
        const networkId = state.activeNetworkId;
        const latestStates = latestState.assetNetworkStates ?? {};
        const latestNetworkState = latestStates[networkId] ?? {};
        const fetchedNetworkState = nextState.assetNetworkStates?.[networkId] ?? {};
        const mergedState: StoredWalletState = {
          ...latestState,
          assetNetworkStates: {
            ...latestStates,
            [networkId]: {
              ...latestNetworkState,
              ...fetchedNetworkState
            }
          }
        };
        await this.store.saveState(mergedState);
        assetNetworkStates = mergedState.assetNetworkStates ?? {};
      }
    }

    return {
      balances,
      assetNetworkStates
    };
  }

  async createOrImportWallet(input: WalletSetupInput): Promise<WalletCreateResult> {
    const secret = await createWalletSecret({
      privateKey: input.privateKey,
      mnemonic: input.mnemonic,
      createWithMnemonic: input.createWithMnemonic
    });
    const signer = new Ed25519Signer(secret.privateKey);
    const { walletEncryptionSalt, sessionKey } = await createWalletSessionKey(
      input.password
    );
    const encryptedPrivateKey = await encryptPrivateKeyWithSessionKey(
      secret.privateKey,
      sessionKey
    );
    const encryptedMnemonic = secret.mnemonic
      ? await encryptMnemonicWithSessionKey(secret.mnemonic, sessionKey)
      : undefined;

    this.unlockedPrivateKey = secret.privateKey;
    this.unlockedSigner = signer;
    this.unlockedMnemonic = secret.mnemonic ?? null;
    this.unlockedSessionKey = sessionKey;
    await this.persistUnlockedSession();

    await this.invalidatePendingRequests(
      new ProviderUnauthorizedError("wallet was replaced")
    );

    const setupRpcUrl = trimOptionalString(input.rpcUrl) ?? DEFAULT_RPC_URL;
    const setupDashboardUrl =
      trimOptionalString(input.dashboardUrl) ?? DEFAULT_DASHBOARD_URL;
    const setupAllowInsecureHttp = input.allowInsecureHttp === true;
    assertRpcTransportAllowed(setupRpcUrl, setupAllowInsecureHttp);
    const localPreset = createLocalNetworkPreset();
    const useLocalPreset =
      setupRpcUrl === localPreset.rpcUrl &&
      (setupDashboardUrl ?? "") === (localPreset.dashboardUrl ?? "");
    const customPresetId = useLocalPreset ? undefined : this.createId();
    const activePreset = useLocalPreset
      ? localPreset
      : normalizePresetInputValue(
          {
            id: customPresetId,
            name: trimOptionalString(input.networkName) ?? "Custom network",
            chainId: trimOptionalString(input.expectedChainId),
            rpcUrl: setupRpcUrl,
            dashboardUrl: setupDashboardUrl,
            allowInsecureHttp: setupAllowInsecureHttp,
            builtin: false
          },
          {
            id: customPresetId ?? "custom-network",
            name: trimOptionalString(input.networkName) ?? "Custom network",
            rpcUrl: setupRpcUrl,
            dashboardUrl: setupDashboardUrl,
            allowInsecureHttp: setupAllowInsecureHttp,
            builtin: false
          }
        );
    const networkPresets = useLocalPreset
      ? [localPreset]
      : [localPreset, activePreset];

    const initialAccount: WalletAccount = {
      index: 0,
      publicKey: signer.address,
      encryptedPrivateKey,
      name: "Account 1"
    };

    const popupState = await this.persistWalletState({
      publicKey: signer.address,
      encryptedPrivateKey,
      encryptedMnemonic,
      walletEncryptionSalt,
      seedSource: secret.seedSource,
      mnemonicWordCount: secret.mnemonicWordCount,
      accounts: [initialAccount],
      activeAccountIndex: 0,
      rpcUrl: activePreset.rpcUrl,
      dashboardUrl: activePreset.dashboardUrl,
      activeNetworkId: activePreset.id,
      networkPresets,
      watchedAssets: [
        {
          contract: "currency",
          name: "Xian",
          symbol: "XIAN"
        }
      ],
      assetNetworkStates: {
        [activePreset.id]: {
          currency: {
            status: "available"
          }
        }
      },
      trustedDappPolicies: [],
      connectedDappMetadata: {},
      connectedOrigins: [],
      createdAt: new Date().toISOString()
    });

    return {
      popupState,
      generatedMnemonic: secret.generatedMnemonic,
      importedSeedSource: secret.seedSource
    };
  }

  async unlockWallet(password: string): Promise<PopupState> {
    const state = this.requireStoredWallet(await this.loadWalletState());
    const sessionKey = await this.sessionKeyForState(state, password);
    const privateKey = await decryptPrivateKeyWithSessionKey(
      state.encryptedPrivateKey,
      sessionKey
    );
    const signer = new Ed25519Signer(privateKey);
    if (signer.address !== state.publicKey) {
      throw new Error("decrypted private key does not match stored wallet");
    }

    this.unlockedPrivateKey = privateKey;
    this.unlockedSigner = signer;
    this.unlockedSessionKey = sessionKey;

    // Decrypt mnemonic into session for account switching
    if (state.encryptedMnemonic) {
      try {
        this.unlockedMnemonic = await decryptMnemonicWithSessionKey(
          state.encryptedMnemonic,
          sessionKey
        );
      } catch {
        this.unlockedMnemonic = null;
      }
    }

    await this.persistUnlockedSession();
    void this.notifyUnlockedOrigins(state);

    return this.getPopupState();
  }

  async revealMnemonic(password: string): Promise<string> {
    const state = this.requireStoredWallet(await this.loadWalletState());
    return this.decryptMnemonicForState(state, password);
  }

  async revealPrivateKey(password: string): Promise<string> {
    const state = this.requireStoredWallet(await this.loadWalletState());
    return this.decryptPrivateKeyForState(state, password);
  }

  async exportWallet(password: string): Promise<WalletBackup> {
    const state = this.requireStoredWallet(await this.loadWalletState());
    const accounts = this.requireAccounts(state);
    await this.restoreUnlockedSession();
    const sessionKey = this.unlockedSessionKey;
    if (!sessionKey) {
      throw new ProviderUnauthorizedError("wallet is locked");
    }

    const backup: WalletBackupPayload = {
      version: 1,
      type: state.seedSource,
      accounts: accounts.map((a) => ({ index: a.index, name: a.name })),
      activeAccountIndex: state.activeAccountIndex ?? accounts[0]?.index ?? 0,
      activeNetworkId: state.activeNetworkId,
      networkPresets: state.networkPresets.filter((p) => !p.builtin),
      watchedAssets: state.watchedAssets,
      assetNetworkStates: state.assetNetworkStates
    };

    if (state.encryptedMnemonic) {
      backup.mnemonic = await decryptMnemonicWithSessionKey(
        state.encryptedMnemonic,
        sessionKey
      );
    } else {
      backup.privateKey = await decryptPrivateKeyWithSessionKey(
        state.encryptedPrivateKey,
        sessionKey
      );
    }

    const shieldedStateSnapshots = await this.exportShieldedWalletSnapshots(
      state,
      sessionKey
    );
    if (shieldedStateSnapshots.length > 0) {
      backup.shieldedStateSnapshots = shieldedStateSnapshots;
    }

    return encryptWalletBackupPayload(backup, password);
  }

  async importWalletBackup(backup: WalletBackup, password: string): Promise<PopupState> {
    const decryptedBackup = await decryptWalletBackup(backup, password);
    // Derive or use the provided private key
    let primaryKey: string;
    let mnemonic: string | undefined;

    if (decryptedBackup.type === "mnemonic" && decryptedBackup.mnemonic) {
      mnemonic = decryptedBackup.mnemonic;
      primaryKey = await derivePrivateKeyFromMnemonic(mnemonic, 0);
    } else if (decryptedBackup.privateKey) {
      primaryKey = decryptedBackup.privateKey;
    } else {
      throw new Error("backup must contain a mnemonic or private key");
    }

    const { walletEncryptionSalt, sessionKey } = await createWalletSessionKey(password);
    const nowIso = new Date().toISOString();
    const encryptedMnemonic = mnemonic
      ? await encryptMnemonicWithSessionKey(mnemonic, sessionKey)
      : undefined;

    // Build accounts list
    const accountEntries = decryptedBackup.accounts;
    if (!accountEntries || accountEntries.length === 0) {
      throw new Error("backup must contain at least one account");
    }
    const accounts: WalletAccount[] = [];
    const privateKeysByIndex = new Map<number, string>();
    for (const entry of accountEntries) {
      const key = mnemonic
        ? await derivePrivateKeyFromMnemonic(mnemonic, entry.index)
        : primaryKey;
      privateKeysByIndex.set(entry.index, key);
      const acctSigner = new Ed25519Signer(key);
      accounts.push({
        index: entry.index,
        publicKey: acctSigner.address,
        encryptedPrivateKey: await encryptPrivateKeyWithSessionKey(key, sessionKey),
        name: entry.name
      });
    }

    const activeAccount =
      accounts.find((account) => account.index === decryptedBackup.activeAccountIndex) ??
      accounts[0];
    if (!activeAccount) {
      throw new Error("backup must contain at least one account");
    }
    const activePrivateKey =
      privateKeysByIndex.get(activeAccount.index) ?? primaryKey;
    const signer = new Ed25519Signer(activePrivateKey);

    this.unlockedPrivateKey = activePrivateKey;
    this.unlockedSigner = signer;
    this.unlockedMnemonic = mnemonic ?? null;
    this.unlockedSessionKey = sessionKey;
    await this.persistUnlockedSession();

    await this.invalidatePendingRequests(
      new ProviderUnauthorizedError("wallet was replaced")
    );

    // Merge network presets
    const presets = [...DEFAULT_NETWORK_PRESETS];
    for (const p of decryptedBackup.networkPresets ?? []) {
      if (!presets.some((existing) => existing.id === p.id)) {
        assertRpcTransportAllowed(p.rpcUrl, p.allowInsecureHttp);
        presets.push(
          normalizePresetInputValue(p, {
            id: p.id,
            name: p.name,
            rpcUrl: p.rpcUrl,
            dashboardUrl: p.dashboardUrl,
            allowInsecureHttp: p.allowInsecureHttp,
            builtin: p.builtin
          })
        );
      }
    }

    const activePreset =
      presets.find((preset) => preset.id === decryptedBackup.activeNetworkId) ??
      presets[0];
    if (!activePreset) {
      throw new Error("backup must contain at least one network preset");
    }
    const watchedAssets = decryptedBackup.watchedAssets?.length
      ? decryptedBackup.watchedAssets
      : [{ contract: "currency", name: "Xian", symbol: "XIAN" }];
    const shieldedWalletSnapshots = await this.importShieldedWalletSnapshots(
      decryptedBackup.shieldedStateSnapshots,
      sessionKey,
      nowIso
    );

    await this.persistWalletState({
      publicKey: activeAccount.publicKey,
      encryptedPrivateKey: activeAccount.encryptedPrivateKey,
      encryptedMnemonic,
      walletEncryptionSalt,
      seedSource: decryptedBackup.type,
      mnemonicWordCount: mnemonic ? mnemonic.split(" ").length : undefined,
      accounts,
      activeAccountIndex: activeAccount.index,
      rpcUrl: activePreset.rpcUrl,
      dashboardUrl: activePreset.dashboardUrl,
      activeNetworkId: activePreset.id,
      networkPresets: presets,
      watchedAssets,
      assetNetworkStates: decryptedBackup.assetNetworkStates,
      shieldedWalletSnapshots,
      trustedDappPolicies: [],
      connectedDappMetadata: {},
      connectedOrigins: [],
      createdAt: nowIso
    });

    return this.getPopupState();
  }

  async saveShieldedWalletSnapshot(
    stateSnapshot: string,
    label?: string
  ): Promise<PopupState> {
    const state = this.requireStoredWallet(await this.loadWalletState());
    const sessionKey = await this.requireUnlockedSessionKey();
    const parsed = parseShieldedWalletSnapshot(stateSnapshot);
    const resolvedLabel = trimOptionalString(label) ?? parsed.assetId;
    const existing = this.storedShieldedWalletSnapshots(state).find(
      (record) =>
        record.assetId === parsed.assetId && record.label === resolvedLabel
    );
    const updatedAt = new Date().toISOString();
    const nextRecord: StoredShieldedWalletSnapshot = {
      id: existing?.id ?? this.createId(),
      label: resolvedLabel,
      assetId: parsed.assetId,
      syncHint: parsed.syncHint,
      encryptedStateSnapshot: await encryptSecretTextWithSessionKey(
        parsed.normalizedSnapshot,
        sessionKey
      ),
      noteCount: parsed.noteCount,
      commitmentCount: parsed.commitmentCount,
      lastScannedIndex: parsed.lastScannedIndex,
      updatedAt,
    };

    state.shieldedWalletSnapshots = [
      nextRecord,
      ...this.storedShieldedWalletSnapshots(state).filter(
        (record) => record.id !== nextRecord.id
      ),
    ];
    await this.persistWalletState(state);
    return this.getPopupState();
  }

  async exportShieldedWalletSnapshot(
    snapshotId: string,
    password: string
  ): Promise<{ label: string; stateSnapshot: string }> {
    void password;
    const state = this.requireStoredWallet(await this.loadWalletState());
    const record = this.storedShieldedWalletSnapshots(state).find(
      (item) => item.id === snapshotId
    );
    if (!record) {
      throw new Error("shielded wallet snapshot not found");
    }
    await this.restoreUnlockedSession();
    const sessionKey = this.unlockedSessionKey;
    if (!sessionKey) {
      throw new ProviderUnauthorizedError("wallet is locked");
    }
    return {
      label: record.label,
      stateSnapshot: await decryptSecretTextWithSessionKey(
        record.encryptedStateSnapshot,
        sessionKey
      ),
    };
  }

  async removeShieldedWalletSnapshot(snapshotId: string): Promise<PopupState> {
    const state = this.requireStoredWallet(await this.loadWalletState());
    const nextSnapshots = this.storedShieldedWalletSnapshots(state).filter(
      (record) => record.id !== snapshotId
    );
    if (nextSnapshots.length === this.storedShieldedWalletSnapshots(state).length) {
      throw new Error("shielded wallet snapshot not found");
    }
    state.shieldedWalletSnapshots = nextSnapshots;
    await this.persistWalletState(state);
    return this.getPopupState();
  }

  async getShieldedWalletSnapshotHistory(
    snapshotId: string,
    limit: number = 5
  ): Promise<ShieldedWalletHistoryStatus> {
    const state = this.requireStoredWallet(await this.loadWalletState());
    const record = this.storedShieldedWalletSnapshots(state).find(
      (item) => item.id === snapshotId
    );
    if (!record) {
      throw new Error("shielded wallet snapshot not found");
    }

    const client = this.currentClient(state);
    if (typeof client.getShieldedWalletHistory !== "function") {
      return {
        snapshotId: record.id,
        label: record.label,
        available: false,
        hasNewerIndexedHistory: false,
        checkedAfterNoteIndex: record.lastScannedIndex,
        newItems: [],
      };
    }

    const history = await client.getShieldedWalletHistory(record.syncHint, {
      kind: "sync_hint",
      limit: Math.max(1, Math.min(Math.trunc(limit), 10)),
      afterNoteIndex: record.lastScannedIndex,
    });

    return {
      snapshotId: record.id,
      label: record.label,
      available: history.available,
      hasNewerIndexedHistory: history.items.length > 0,
      checkedAfterNoteIndex: record.lastScannedIndex,
      newItems: history.items.map((item) => ({
        txHash: item.txHash,
        blockHeight: item.blockHeight,
        function: item.function,
        action: item.action,
        noteIndex: item.noteIndex,
        commitment: item.commitment,
        hasPayload: item.outputPayload != null && item.outputPayload !== "",
        createdAt: item.createdAt,
      })),
    };
  }

  async addAccount(): Promise<PopupState> {
    await this.restoreUnlockedSession();
    if (!this.unlockedMnemonic || !this.unlockedSessionKey) {
      throw new Error("wallet must be unlocked to add an account");
    }
    const state = this.requireStoredWallet(await this.loadWalletState());
    const accounts = this.requireAccounts(state);
    const nextIndex = Math.max(...accounts.map((a) => a.index)) + 1;
    const privateKey = await derivePrivateKeyFromMnemonic(this.unlockedMnemonic, nextIndex);
    const signer = new Ed25519Signer(privateKey);
    const encrypted = await encryptPrivateKeyWithSessionKey(
      privateKey,
      this.unlockedSessionKey
    );

    accounts.push({
      index: nextIndex,
      publicKey: signer.address,
      encryptedPrivateKey: encrypted,
      name: `Account ${accounts.length + 1}`
    });

    state.publicKey = signer.address;
    state.encryptedPrivateKey = encrypted;
    state.activeAccountIndex = nextIndex;
    state.accounts = accounts;
    await this.store.saveState(state);

    this.unlockedPrivateKey = privateKey;
    this.unlockedSigner = signer;
    await this.persistUnlockedSession();
    await this.emitSelectedAccountChangedForConnectedOrigins(state);

    return this.getPopupState();
  }

  async switchAccount(index: number): Promise<PopupState> {
    const wasUnlocked = await this.restoreUnlockedSession();
    const state = this.requireStoredWallet(await this.loadWalletState());
    const accounts = this.requireAccounts(state);
    const target = accounts.find((a) => a.index === index);
    if (!target) {
      throw new Error("account not found");
    }

    // Update active account in state
    state.publicKey = target.publicKey;
    state.encryptedPrivateKey = target.encryptedPrivateKey;
    state.activeAccountIndex = index;
    await this.store.saveState(state);

    // If unlocked, switch the in-memory signer
    if (wasUnlocked && this.unlockedMnemonic) {
      const privateKey = await derivePrivateKeyFromMnemonic(this.unlockedMnemonic, index);
      this.unlockedPrivateKey = privateKey;
      this.unlockedSigner = new Ed25519Signer(privateKey);
      await this.persistUnlockedSession();
    } else if (wasUnlocked && this.unlockedPrivateKey) {
      // No mnemonic in session — clear unlock (requires re-auth)
      await this.clearUnlockedSession();
    }

    await this.emitSelectedAccountChangedForConnectedOrigins(state);

    return this.getPopupState();
  }

  async renameAccount(index: number, name: string): Promise<PopupState> {
    const state = this.requireStoredWallet(await this.loadWalletState());
    const accounts = this.requireAccounts(state);
    const target = accounts.find((a) => a.index === index);
    if (!target) {
      throw new Error("account not found");
    }
    const duplicate = accounts.find((a) => a.index !== index && a.name.toLowerCase() === name.toLowerCase());
    if (duplicate) {
      throw new Error(`An account named "${name}" already exists`);
    }
    target.name = name;
    state.accounts = accounts;
    await this.store.saveState(state);
    return this.getPopupState();
  }

  async removeAccount(index: number): Promise<PopupState> {
    const wasUnlocked = await this.restoreUnlockedSession();
    const state = this.requireStoredWallet(await this.loadWalletState());
    if (index === 0) {
      throw new Error("cannot remove the primary account");
    }
    const accounts = this.requireAccounts(state);
    const nextAccounts = accounts.filter((account) => account.index !== index);
    if (nextAccounts.length === 0) {
      throw new Error("cannot remove the last remaining account");
    }

    const removedActiveAccount = state.activeAccountIndex === index;
    state.accounts = nextAccounts;

    if (removedActiveAccount) {
      const nextActiveAccount = nextAccounts[0]!;
      state.publicKey = nextActiveAccount.publicKey;
      state.encryptedPrivateKey = nextActiveAccount.encryptedPrivateKey;
      state.activeAccountIndex = nextActiveAccount.index;

      if (wasUnlocked && this.unlockedMnemonic) {
        const privateKey = await derivePrivateKeyFromMnemonic(
          this.unlockedMnemonic,
          nextActiveAccount.index
        );
        this.unlockedPrivateKey = privateKey;
        this.unlockedSigner = new Ed25519Signer(privateKey);
        await this.persistUnlockedSession();
      } else if (wasUnlocked && this.unlockedPrivateKey) {
        await this.clearUnlockedSession();
      }
    }

    await this.store.saveState(state);

    if (removedActiveAccount) {
      await this.emitSelectedAccountChangedForConnectedOrigins(state);
    }

    return this.getPopupState();
  }

  async lockWallet(): Promise<PopupState> {
    const state = await this.loadWalletState();
    await this.clearUnlockedSession();

    if (state) {
      await Promise.all(
        state.connectedOrigins.map((origin) => this.emitDisconnectLifecycle(origin))
      );
    }

    return this.getPopupState();
  }

  async removeWallet(): Promise<PopupState> {
    const state = await this.loadWalletState();
    await this.clearUnlockedSession();

    if (state) {
      await Promise.all(
        state.connectedOrigins.map((origin) =>
          this.emitDisconnectLifecycle(origin)
        )
      );
    }

    await this.invalidatePendingRequests(
      new ProviderUnauthorizedError("wallet was removed")
    );

    await this.store.clearState();
    return this.getPopupState();
  }

  async updateSettings(input: WalletSettingsInput): Promise<PopupState> {
    const state = this.requireStoredWallet(await this.loadWalletState());
    const activePreset = this.activeNetworkPreset(state);
    const previousChainId = this.displayChainId(
      activePreset,
      await this.safeGetChainId(state)
    );
    const nextState = this.upsertNetworkPresetInState(state, {
      id: activePreset.builtin ? undefined : activePreset.id,
      name:
        trimOptionalString(input.networkName) ??
        (activePreset.builtin ? "Custom network" : activePreset.name),
      chainId:
        trimOptionalString(input.expectedChainId) ?? activePreset.chainId,
      rpcUrl: input.rpcUrl.trim() || DEFAULT_RPC_URL,
      dashboardUrl: input.dashboardUrl?.trim() || DEFAULT_DASHBOARD_URL,
      allowInsecureHttp: input.allowInsecureHttp === true,
      makeActive: true
    });
    await this.store.saveState(nextState);
    await this.emitChainChangedForConnectedOrigins(nextState, previousChainId);
    return this.getPopupState();
  }

  async disconnectOrigin(origin: string): Promise<PopupState> {
    const state = await this.loadWalletState();
    if (!state || !state.connectedOrigins.includes(origin)) {
      return this.getPopupState();
    }
    await this.updateConnectedOrigin(origin, false);
    await this.emitDisconnectLifecycle(origin);
    return this.getPopupState();
  }

  async disconnectAllOrigins(): Promise<PopupState> {
    const state = await this.loadWalletState();
    if (!state || state.connectedOrigins.length === 0) {
      return this.getPopupState();
    }

    const nextState: StoredWalletState = {
      ...state,
      connectedOrigins: [],
      trustedDappPolicies: [],
      connectedDappMetadata: {}
    };
    await this.store.saveState(nextState);
    await Promise.all(
      state.connectedOrigins.map((origin) => this.emitDisconnectLifecycle(origin))
    );
    return this.getPopupState();
  }

  async removeTrustedDappPolicy(policyId: string): Promise<PopupState> {
    const state = await this.loadWalletState();
    if (!state) {
      return this.getPopupState();
    }
    const nextPolicies = (state.trustedDappPolicies ?? []).filter(
      (policy) => policy.id !== policyId
    );
    if (nextPolicies.length === (state.trustedDappPolicies ?? []).length) {
      return this.getPopupState();
    }
    await this.store.saveState({
      ...state,
      trustedDappPolicies: nextPolicies
    });
    return this.getPopupState();
  }

  async removeWatchedAsset(contract: string): Promise<PopupState> {
    const trimmed = contract.trim();
    if (trimmed.length === 0) {
      throw new TypeError("asset contract is required");
    }

    const state = this.requireStoredWallet(await this.loadWalletState());
    if (!state.watchedAssets.some((asset) => asset.contract === trimmed)) {
      return this.getPopupState();
    }

    if (trimmed === "currency") {
      throw new Error("the native XIAN asset is pinned in the wallet");
    }

    return this.persistWalletState(removeAssetNetworkStateFromWallet({
      ...state,
      watchedAssets: state.watchedAssets.filter(
        (asset) => asset.contract !== trimmed
      )
    }, trimmed));
  }

  async saveNetworkPreset(input: WalletNetworkPresetInput): Promise<PopupState> {
    const state = this.requireStoredWallet(await this.loadWalletState());
    const previousChainId = this.displayChainId(
      this.activeNetworkPreset(state),
      await this.safeGetChainId(state)
    );
    const nextState = this.upsertNetworkPresetInState(state, input);
    await this.store.saveState(nextState);
    await this.emitChainChangedForConnectedOrigins(nextState, previousChainId);
    return this.getPopupState();
  }

  async switchNetwork(presetId: string): Promise<PopupState> {
    const state = this.requireStoredWallet(await this.loadWalletState());
    const normalizedPresetId = presetId.trim();
    if (!normalizedPresetId) {
      throw new TypeError("network preset id is required");
    }

    const previousChainId = this.displayChainId(
      this.activeNetworkPreset(state),
      await this.safeGetChainId(state)
    );
    const nextState = this.applyActivePreset(state, normalizedPresetId);
    await this.store.saveState(nextState);
    await this.emitChainChangedForConnectedOrigins(nextState, previousChainId);
    return this.getPopupState();
  }

  async removeNetworkPreset(presetId: string): Promise<PopupState> {
    const state = this.requireStoredWallet(await this.loadWalletState());
    const normalizedPresetId = presetId.trim();
    if (!normalizedPresetId) {
      throw new TypeError("network preset id is required");
    }

    const preset = state.networkPresets.find((entry) => entry.id === normalizedPresetId);
    if (!preset) {
      return this.getPopupState();
    }
    if (preset.builtin) {
      throw new Error("built-in network presets cannot be deleted");
    }

    const previousChainId = this.displayChainId(
      this.activeNetworkPreset(state),
      await this.safeGetChainId(state)
    );
    const nextPresets = state.networkPresets.filter(
      (entry) => entry.id !== normalizedPresetId
    );
    const nextActiveNetworkId =
      state.activeNetworkId === normalizedPresetId
        ? createLocalNetworkPreset().id
        : state.activeNetworkId;
    const nextState = this.applyActivePreset(
      {
        ...state,
        networkPresets: nextPresets
      },
      nextActiveNetworkId
    );
    await this.store.saveState(nextState);
    await this.emitChainChangedForConnectedOrigins(nextState, previousChainId);
    return this.getPopupState();
  }

  async startProviderRequest(
    requestId: string,
    origin: string,
    request: XianProviderRequest,
    options?: { dappMetadata?: WalletConnectedDappMetadata }
  ): Promise<ProviderRequestStartResult> {
    const existing = await this.store.loadRequestState(requestId);
    if (existing) {
      if (existing.origin !== origin) {
        return {
          status: "rejected",
          error: {
            name: "Error",
            message: "request id is already in use by a different origin"
          }
        };
      }
      if (existing.status === "pending") {
        return {
          status: "pending",
          approvalId: existing.approvalId ?? ""
        };
      }
      if (existing.status === "fulfilled") {
        return {
          status: "fulfilled",
          result: existing.result
        };
      }
      return {
        status: "rejected",
        error: existing.error ?? {
          name: "Error",
          message: "request failed"
        }
      };
    }

    const requestState: StoredProviderRequest = {
      requestId,
      origin,
      request,
      dappMetadata:
        normalizeConnectedDappMetadataEntry(options?.dappMetadata) ?? undefined,
      createdAt: this.now(),
      updatedAt: this.now(),
      status: "pending"
    };
    await this.store.saveRequestState(requestState);

    try {
      const immediate = await this.executeImmediateRequest(
        await this.loadWalletState(),
        origin,
        request,
        requestState.dappMetadata
      );

      if (immediate.kind === "result") {
        const fulfilled = await this.fulfillRequest(requestState, immediate.value);
        if (fulfilled.status !== "fulfilled") {
          throw new Error("immediate request did not settle correctly");
        }
        return fulfilled;
      }

      return this.createApprovalRequest(
        requestState,
        immediate.account,
        immediate.chainId
      );
    } catch (error) {
      const rejected = await this.rejectRequest(requestState, error);
      if (rejected.status !== "rejected") {
        throw new Error("request rejection did not settle correctly");
      }
      return rejected;
    }
  }

  async getProviderRequestStatus(
    requestId: string,
    options?: { consume?: boolean; origin?: string }
  ): Promise<ProviderRequestStatusResult> {
    const state = await this.store.loadRequestState(requestId);
    if (!state) {
      return {
        status: "not_found"
      };
    }
    if (options?.origin && state.origin !== options.origin) {
      return {
        status: "not_found"
      };
    }

    if (state.status === "pending") {
      return {
        status: "pending",
        approvalId: state.approvalId
      };
    }

    if (options?.consume) {
      await this.store.deleteRequestState(requestId);
    }

    if (state.status === "fulfilled") {
      return {
        status: "fulfilled",
        result: state.result
      };
    }

    return {
      status: "rejected",
      error: state.error ?? {
        name: "Error",
        message: "request failed"
      }
    };
  }

  async getApprovalView(approvalId: string): Promise<ApprovalView> {
    const approval = await this.store.loadApprovalState(approvalId);
    if (!approval) {
      throw new Error("approval request not found");
    }
    return approval.view;
  }

  async listApprovalStates(): Promise<PersistedApproval[]> {
    return this.store.listApprovalStates();
  }

  async attachApprovalWindow(
    approvalId: string,
    windowId: number
  ): Promise<void> {
    const approval = await this.store.loadApprovalState(approvalId);
    if (!approval) {
      return;
    }
    await this.store.saveApprovalState({
      ...approval,
      windowId
    });
  }

  async resolveApproval(
    approvalId: string,
    approved: boolean,
    options?: { trust?: boolean | XianDappPolicyArgumentScope }
  ): Promise<null> {
    const approval = await this.store.loadApprovalState(approvalId);
    if (!approval) {
      throw new Error("approval request not found");
    }
    const requestState = await this.store.loadRequestState(approval.requestId);
    if (!requestState) {
      await this.store.deleteApprovalState(approval.id);
      throw new Error("approval request is no longer active");
    }

    await this.store.deleteApprovalState(approvalId);

    if (!approved) {
      await this.rejectRequest(
        requestState,
        new ProviderUnauthorizedError("user rejected the request")
      );
      return null;
    }

    try {
      const result = await this.executeApprovedRequest(
        approval.record.origin,
        approval.record.request,
        requestState.dappMetadata
      );
      await this.fulfillRequest(requestState, result);
      const trustScope = normalizeApprovalTrustScope(options?.trust);
      if (trustScope) {
        const policy = await this.createTrustedDappPolicyForApproval(
          approval,
          trustScope
        );
        if (policy) {
          await this.upsertTrustedDappPolicy(policy);
        }
      }
      return null;
    } catch (error) {
      await this.rejectRequest(requestState, error);
      return null;
    }
  }

  async dismissApproval(
    approvalId: string,
    reason: unknown = new ProviderUnauthorizedError("approval dismissed")
  ): Promise<boolean> {
    const approval = await this.store.loadApprovalState(approvalId);
    if (!approval) {
      return false;
    }
    const requestState = await this.store.loadRequestState(approval.requestId);
    await this.store.deleteApprovalState(approvalId);
    if (requestState) {
      await this.rejectRequest(requestState, reason);
    }
    return true;
  }

  async handleProviderRequest(
    origin: string,
    request: XianProviderRequest
  ): Promise<unknown> {
    const requestId = this.createId();
    const start = await this.startProviderRequest(requestId, origin, request);
    if (start.status === "fulfilled") {
      return start.result;
    }
    if (start.status === "rejected") {
      throw hydrateError(start.error);
    }

    return new Promise<unknown>((resolve, reject) => {
      this.requestWaiters.set(requestId, { resolve, reject });
    });
  }
}

export function errorFromSerializedWalletError(
  error: WalletSerializedError
): Error {
  return hydrateError(error);
}
