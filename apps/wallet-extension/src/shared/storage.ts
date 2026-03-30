import {
  DEFAULT_NETWORK_PRESETS,
  DEFAULT_DASHBOARD_URL,
  DEFAULT_RPC_URL,
  LOCAL_NETWORK_PRESET_ID,
  LOCAL_NETWORK_PRESET_NAME,
  type PersistedApproval,
  type StoredProviderRequest,
  type StoredWalletState,
  type WalletNetworkPreset
} from "@xian-tech/wallet-core";

export const STORAGE_KEY = "xianWalletShellState";
export const STORAGE_SCHEMA_VERSION = 3;

interface WalletStorageEnvelope {
  version: typeof STORAGE_SCHEMA_VERSION;
  wallet: StoredWalletState | null;
  providerRequests: Record<string, StoredProviderRequest>;
  approvals: Record<string, PersistedApproval>;
}

function emptyEnvelope(): WalletStorageEnvelope {
  return {
    version: STORAGE_SCHEMA_VERSION,
    wallet: null,
    providerRequests: {},
    approvals: {}
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null;
}

function encodeStorageValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    return {
      __xianType: "bigint",
      value: value.toString()
    };
  }
  if (Array.isArray(value)) {
    return value.map(encodeStorageValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, encodeStorageValue(entry)])
    );
  }
  return value;
}

function decodeStorageValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(decodeStorageValue);
  }
  if (isRecord(value)) {
    if (value.__xianType === "bigint" && typeof value.value === "string") {
      return BigInt(value.value);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, decodeStorageValue(entry)])
    );
  }
  return value;
}

async function storageGet<T>(key: string): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    chrome.storage.local.get([key], (result: Record<string, unknown>) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result[key] as T | undefined);
    });
  });
}

async function storageSet(value: Record<string, unknown>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function normalizeWalletState(value: unknown): StoredWalletState | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.publicKey !== "string" ||
    typeof value.encryptedPrivateKey !== "string"
  ) {
    return null;
  }

  const legacyRpcUrl =
    typeof value.rpcUrl === "string" && value.rpcUrl.length > 0
      ? value.rpcUrl
      : DEFAULT_RPC_URL;
  const legacyDashboardUrl =
    typeof value.dashboardUrl === "string" && value.dashboardUrl.length > 0
      ? value.dashboardUrl
      : DEFAULT_DASHBOARD_URL;
  const localPreset: WalletNetworkPreset = DEFAULT_NETWORK_PRESETS[0]
    ? {
        ...DEFAULT_NETWORK_PRESETS[0]
      }
    : {
        id: LOCAL_NETWORK_PRESET_ID,
        name: LOCAL_NETWORK_PRESET_NAME,
        rpcUrl: DEFAULT_RPC_URL,
        dashboardUrl: DEFAULT_DASHBOARD_URL,
        builtin: true
      };
  const rawPresets = Array.isArray(value.networkPresets)
    ? value.networkPresets.flatMap((entry): WalletNetworkPreset[] => {
        if (
          !isRecord(entry) ||
          typeof entry.id !== "string" ||
          typeof entry.name !== "string" ||
          typeof entry.rpcUrl !== "string"
        ) {
          return [];
        }

        return [
          {
            id: entry.id,
            name: entry.name,
            chainId: typeof entry.chainId === "string" ? entry.chainId : undefined,
            rpcUrl: entry.rpcUrl,
            dashboardUrl:
              typeof entry.dashboardUrl === "string" ? entry.dashboardUrl : undefined,
            builtin: entry.builtin === true
          }
        ];
      })
    : [];
  const usingLegacyCustomPreset =
    rawPresets.length === 0 &&
    !(
      legacyRpcUrl === localPreset.rpcUrl &&
      legacyDashboardUrl === (localPreset.dashboardUrl ?? DEFAULT_DASHBOARD_URL)
    );
  const networkPresets: WalletNetworkPreset[] =
    rawPresets.length > 0
      ? rawPresets
      : !usingLegacyCustomPreset
        ? [localPreset]
        : [
            localPreset,
            {
              id: "custom-network",
              name: "Custom network",
              rpcUrl: legacyRpcUrl,
              dashboardUrl: legacyDashboardUrl
            }
          ];
  const activeNetworkId =
    typeof value.activeNetworkId === "string" &&
    networkPresets.some((preset) => preset.id === value.activeNetworkId)
      ? value.activeNetworkId
      : usingLegacyCustomPreset
        ? "custom-network"
      : networkPresets[0]?.id ?? LOCAL_NETWORK_PRESET_ID;
  const activePreset =
    networkPresets.find((preset) => preset.id === activeNetworkId) ?? localPreset;

  return {
    publicKey: value.publicKey,
    encryptedPrivateKey: value.encryptedPrivateKey,
    encryptedMnemonic:
      typeof value.encryptedMnemonic === "string"
        ? value.encryptedMnemonic
        : undefined,
    seedSource: value.seedSource === "mnemonic" ? "mnemonic" : "privateKey",
    mnemonicWordCount:
      typeof value.mnemonicWordCount === "number" ? value.mnemonicWordCount : undefined,
    rpcUrl: activePreset.rpcUrl,
    dashboardUrl: activePreset.dashboardUrl,
    activeNetworkId,
    networkPresets,
    watchedAssets: Array.isArray(value.watchedAssets) ? value.watchedAssets : [],
    connectedOrigins: Array.isArray(value.connectedOrigins)
      ? value.connectedOrigins.filter((entry): entry is string => typeof entry === "string")
      : [],
    createdAt:
      typeof value.createdAt === "string" && value.createdAt.length > 0
        ? value.createdAt
        : new Date(0).toISOString()
  };
}

function normalizeRequestStates(value: unknown): Record<string, StoredProviderRequest> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      return (
        isRecord(entry) &&
        typeof entry.requestId === "string" &&
        typeof entry.origin === "string" &&
        isRecord(entry.request) &&
        typeof entry.status === "string"
      );
    }) as Array<[string, StoredProviderRequest]>
  );
}

function normalizeApprovals(value: unknown): Record<string, PersistedApproval> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      return (
        isRecord(entry) &&
        typeof entry.id === "string" &&
        typeof entry.requestId === "string" &&
        isRecord(entry.record) &&
        isRecord(entry.view)
      );
    }) as Array<[string, PersistedApproval]>
  );
}

async function saveEnvelope(envelope: WalletStorageEnvelope): Promise<void> {
  await storageSet({
    [STORAGE_KEY]: encodeStorageValue(envelope)
  });
}

async function loadEnvelope(): Promise<WalletStorageEnvelope> {
  const raw = await storageGet<unknown>(STORAGE_KEY);
  const decoded = decodeStorageValue(raw);

  if (!decoded) {
    return emptyEnvelope();
  }

  if (
    isRecord(decoded) &&
    decoded.version === STORAGE_SCHEMA_VERSION
  ) {
    return {
      version: STORAGE_SCHEMA_VERSION,
      wallet: normalizeWalletState(decoded.wallet),
      providerRequests: normalizeRequestStates(decoded.providerRequests),
      approvals: normalizeApprovals(decoded.approvals)
    };
  }

  const migratedWallet = normalizeWalletState(decoded);
  if (migratedWallet) {
    const migratedEnvelope: WalletStorageEnvelope = {
      version: STORAGE_SCHEMA_VERSION,
      wallet: migratedWallet,
      providerRequests: {},
      approvals: {}
    };
    await saveEnvelope(migratedEnvelope);
    return migratedEnvelope;
  }

  return emptyEnvelope();
}

async function updateEnvelope(
  updater: (envelope: WalletStorageEnvelope) => WalletStorageEnvelope
): Promise<void> {
  const current = await loadEnvelope();
  await saveEnvelope(updater(current));
}

export async function loadWalletState(): Promise<StoredWalletState | null> {
  return (await loadEnvelope()).wallet;
}

export async function saveWalletState(state: StoredWalletState): Promise<void> {
  await updateEnvelope((envelope) => ({
    ...envelope,
    wallet: state
  }));
}

export async function loadRequestState(
  requestId: string
): Promise<StoredProviderRequest | null> {
  return (await loadEnvelope()).providerRequests[requestId] ?? null;
}

export async function saveRequestState(state: StoredProviderRequest): Promise<void> {
  await updateEnvelope((envelope) => ({
    ...envelope,
    providerRequests: {
      ...envelope.providerRequests,
      [state.requestId]: state
    }
  }));
}

export async function deleteRequestState(requestId: string): Promise<void> {
  await updateEnvelope((envelope) => {
    const nextRequests = { ...envelope.providerRequests };
    delete nextRequests[requestId];
    return {
      ...envelope,
      providerRequests: nextRequests
    };
  });
}

export async function listRequestStates(): Promise<StoredProviderRequest[]> {
  return Object.values((await loadEnvelope()).providerRequests);
}

export async function loadApprovalState(
  approvalId: string
): Promise<PersistedApproval | null> {
  return (await loadEnvelope()).approvals[approvalId] ?? null;
}

export async function saveApprovalState(state: PersistedApproval): Promise<void> {
  await updateEnvelope((envelope) => ({
    ...envelope,
    approvals: {
      ...envelope.approvals,
      [state.id]: state
    }
  }));
}

export async function deleteApprovalState(approvalId: string): Promise<void> {
  await updateEnvelope((envelope) => {
    const nextApprovals = { ...envelope.approvals };
    delete nextApprovals[approvalId];
    return {
      ...envelope,
      approvals: nextApprovals
    };
  });
}

export async function listApprovalStates(): Promise<PersistedApproval[]> {
  return Object.values((await loadEnvelope()).approvals);
}
