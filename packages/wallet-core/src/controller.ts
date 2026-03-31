import { Ed25519Signer, XianClient } from "@xian-tech/client";
import {
  ProviderChainMismatchError,
  ProviderUnauthorizedError,
  ProviderUnsupportedMethodError,
  type BroadcastMode,
  type TransactionSubmission,
  type XianProviderRequest,
  type XianSignedTransaction,
  type XianTransactionIntent,
  type XianUnsignedTransaction,
  type XianWalletCapabilities,
  type XianWalletDescriptor,
  type XianWalletInfo,
  type XianWatchAssetRequest
} from "@xian-tech/provider";

import { approvalKindFromMethod, buildApprovalView } from "./approvals";
import {
  DEFAULT_NETWORK_PRESETS,
  DEFAULT_DASHBOARD_URL,
  DEFAULT_RPC_URL,
  LOCAL_NETWORK_PRESET_NAME,
  DEFAULT_WALLET_CAPABILITIES,
  LOCAL_NETWORK_PRESET_ID,
  UNLOCKED_SESSION_TIMEOUT_MS
} from "./constants";
import {
  createWalletSecret,
  decryptMnemonic,
  decryptPrivateKey,
  encryptMnemonic,
  encryptPrivateKey,
  isUnsafeMessageToSign
} from "./crypto";
import type {
  ApprovalView,
  PendingApprovalRecord,
  PersistedApproval,
  PopupState,
  ProviderRequestStartResult,
  ProviderRequestStatusResult,
  StoredProviderRequest,
  StoredUnlockedSession,
  StoredWalletState,
  WalletControllerStore,
  WalletCreateResult,
  WalletNetworkPreset,
  WalletNetworkPresetInput,
  WalletNetworkStatus,
  WalletSerializedError,
  WalletSettingsInput,
  WalletSetupInput,
  WalletStateStore
} from "./types";

interface RequestWaiter {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

export interface WalletNetworkClient {
  getChainId(): Promise<string>;
  getBalance(address: string, options?: { contract?: string }): Promise<unknown>;
  buildTx(intent: {
    sender: string;
    contract: string;
    function: string;
    kwargs: Record<string, unknown>;
    chainId?: string;
    stamps?: number | bigint;
    stampsSupplied?: number | bigint;
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
    builtin?: boolean;
  }
): WalletNetworkPreset {
  return {
    id: trimOptionalString(preset.id) ?? fallback.id,
    name: trimOptionalString(preset.name) ?? fallback.name,
    chainId: trimOptionalString(preset.chainId),
    rpcUrl: trimOptionalString(preset.rpcUrl) ?? fallback.rpcUrl,
    dashboardUrl:
      trimOptionalString(preset.dashboardUrl) ??
      trimOptionalString(fallback.dashboardUrl),
    builtin: preset.builtin ?? fallback.builtin
  };
}

function normalizeStoredWalletNetworks(state: StoredWalletState): StoredWalletState {
  const localPreset = createLocalNetworkPreset();
  const rawPresets = Array.isArray(state.networkPresets) ? state.networkPresets : [];

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
        networkPresets: [localPreset]
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
      networkPresets: [localPreset, customPreset]
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
    networkPresets: [...presets.values()]
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
    if (this.unlockedPrivateKey) {
      return true;
    }

    const session = await this.store.loadUnlockedSession();
    if (!session) {
      return false;
    }

    if (session.expiresAt <= this.now()) {
      await this.store.clearUnlockedSession();
      return false;
    }

    this.unlockedPrivateKey = session.privateKey;
    this.unlockedSigner = new Ed25519Signer(session.privateKey);
    return true;
  }

  private async persistUnlockedSession(
    privateKey: string,
    expiresAt = this.now() + UNLOCKED_SESSION_TIMEOUT_MS
  ): Promise<void> {
    const session: StoredUnlockedSession = {
      privateKey,
      expiresAt
    };
    await this.store.saveUnlockedSession(session);
  }

  private async clearUnlockedSession(): Promise<void> {
    this.unlockedPrivateKey = null;
    this.unlockedSigner = null;
    await this.store.clearUnlockedSession();
  }

  private async getUnlockedSigner(): Promise<Ed25519Signer> {
    await this.restoreUnlockedSession();
    if (!this.unlockedPrivateKey) {
      throw new ProviderUnauthorizedError("wallet is locked");
    }
    if (!this.unlockedSigner) {
      this.unlockedSigner = new Ed25519Signer(this.unlockedPrivateKey);
    }
    await this.persistUnlockedSession(this.unlockedPrivateKey);
    return this.unlockedSigner;
  }

  private currentClient(state: StoredWalletState): WalletNetworkClient {
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
      return await this.currentClient(state).getChainId();
    } catch {
      return undefined;
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
    connected: boolean
  ): Promise<StoredWalletState> {
    const state = this.requireStoredWallet(await this.loadWalletState());
    const nextOrigins = new Set(state.connectedOrigins);
    if (connected) {
      nextOrigins.add(origin);
    } else {
      nextOrigins.delete(origin);
    }
    const nextState: StoredWalletState = {
      ...state,
      connectedOrigins: [...nextOrigins]
    };
    await this.store.saveState(nextState);
    return nextState;
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
    return {
      ...input,
      id: trimOptionalString(input.id),
      name,
      chainId: trimOptionalString(input.chainId),
      rpcUrl,
      dashboardUrl: trimOptionalString(input.dashboardUrl),
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
        builtin: false
      },
      {
        id: presetId,
        name: sanitized.name,
        rpcUrl: sanitized.rpcUrl,
        dashboardUrl: sanitized.dashboardUrl,
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
      stamps: parseIntentNumber(intent.stamps, "stamps"),
      stampsSupplied: parseIntentNumber(intent.stampsSupplied, "stampsSupplied")
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
    request: XianProviderRequest
  ): Promise<unknown> {
    const state = this.requireStoredWallet(await this.loadWalletState());

    switch (request.method) {
      case "xian_requestAccounts": {
        await this.getUnlockedSigner();
        const chainId = this.displayChainId(
          this.activeNetworkPreset(state),
          await this.safeGetChainId(state)
        );
        const nextState = await this.updateConnectedOrigin(origin, true);
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
        const asset = assetRequest.options;
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

  private async createApprovalRequest(
    requestState: StoredProviderRequest,
    account: string | undefined,
    chainId: string | undefined
  ): Promise<ProviderRequestStartResult> {
    const record: PendingApprovalRecord = {
      id: this.createId(),
      origin: requestState.origin,
      kind: approvalKindFromMethod(requestState.request.method),
      request: requestState.request,
      createdAt: this.now()
    };
    const view = buildApprovalView(record, { account, chainId });
    const approval: PersistedApproval = {
      id: record.id,
      requestId: requestState.requestId,
      record,
      view
    };

    await this.store.saveApprovalState(approval);
    await this.store.saveRequestState({
      ...requestState,
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
    request: XianProviderRequest
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
          return {
            kind: "result",
            value: [walletState.publicKey]
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
        return {
          kind: "approval",
          account: walletState.publicKey,
          chainId: this.displayChainId(
            this.activeNetworkPreset(walletState),
            await this.safeGetChainId(walletState)
          )
        };
      }

      default:
        throw new ProviderUnsupportedMethodError(request.method);
    }
  }

  async getPopupState(): Promise<PopupState> {
    const state = await this.loadWalletState();
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
      assetBalances: {},
      assetFiatValues: {},
      connectedOrigins: state?.connectedOrigins ?? [],
      pendingApprovalCount: pendingApprovals.length,
      pendingApprovals,
      hasRecoveryPhrase: Boolean(state?.encryptedMnemonic),
      seedSource: state?.seedSource,
      mnemonicWordCount: state?.mnemonicWordCount,
      version: this.options.version
    };
  }

  async getAssetBalances(): Promise<Record<string, string | null>> {
    const state = await this.loadWalletState();
    if (!state) {
      return {};
    }
    return this.fetchAssetBalances(state, state.watchedAssets);
  }

  private async fetchAssetBalances(
    state: StoredWalletState | null,
    assets: { contract: string }[]
  ): Promise<Record<string, string | null>> {
    const balances: Record<string, string | null> = {};
    if (!state || assets.length === 0) {
      return balances;
    }
    const client = this.currentClient(state);
    const results = await Promise.allSettled(
      assets.map(async (asset) => {
        const raw = await client.getBalance(state.publicKey, {
          contract: asset.contract
        });
        return { contract: asset.contract, raw };
      })
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        const { contract, raw } = result.value;
        balances[contract] =
          raw != null ? String(raw) : null;
      } else {
        // If a single balance fetch fails, mark it null rather than
        // failing the entire popup state.
      }
    }
    return balances;
  }

  async createOrImportWallet(input: WalletSetupInput): Promise<WalletCreateResult> {
    const secret = await createWalletSecret({
      privateKey: input.privateKey,
      mnemonic: input.mnemonic,
      createWithMnemonic: input.createWithMnemonic
    });
    const signer = new Ed25519Signer(secret.privateKey);
    const encryptedPrivateKey = await encryptPrivateKey(secret.privateKey, input.password);
    const encryptedMnemonic = secret.mnemonic
      ? await encryptMnemonic(secret.mnemonic, input.password)
      : undefined;

    this.unlockedPrivateKey = secret.privateKey;
    this.unlockedSigner = signer;
    await this.persistUnlockedSession(secret.privateKey);

    const waiters = [...this.requestWaiters.values()];
    this.requestWaiters.clear();
    for (const waiter of waiters) {
      waiter.reject(new ProviderUnauthorizedError("wallet was replaced"));
    }
    for (const requestState of await this.store.listRequestStates()) {
      await this.store.deleteRequestState(requestState.requestId);
    }
    for (const approval of await this.store.listApprovalStates()) {
      await this.store.deleteApprovalState(approval.id);
    }

    const setupRpcUrl = trimOptionalString(input.rpcUrl) ?? DEFAULT_RPC_URL;
    const setupDashboardUrl =
      trimOptionalString(input.dashboardUrl) ?? DEFAULT_DASHBOARD_URL;
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
            builtin: false
          },
          {
            id: customPresetId ?? "custom-network",
            name: trimOptionalString(input.networkName) ?? "Custom network",
            rpcUrl: setupRpcUrl,
            dashboardUrl: setupDashboardUrl,
            builtin: false
          }
        );
    const networkPresets = useLocalPreset
      ? [localPreset]
      : [localPreset, activePreset];

    const popupState = await this.persistWalletState({
      publicKey: signer.address,
      encryptedPrivateKey,
      encryptedMnemonic,
      seedSource: secret.seedSource,
      mnemonicWordCount: secret.mnemonicWordCount,
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
    const privateKey = await decryptPrivateKey(state.encryptedPrivateKey, password);
    const signer = new Ed25519Signer(privateKey);
    if (signer.address !== state.publicKey) {
      throw new Error("decrypted private key does not match stored wallet");
    }

    this.unlockedPrivateKey = privateKey;
    this.unlockedSigner = signer;
    await this.persistUnlockedSession(privateKey);

    const chainId = this.displayChainId(
      this.activeNetworkPreset(state),
      await this.safeGetChainId(state)
    );
    await Promise.all(
      state.connectedOrigins.map((origin) =>
        this.emitConnectionLifecycle(origin, chainId ?? "unknown", state.publicKey)
      )
    );

    return this.getPopupState();
  }

  async revealMnemonic(password: string): Promise<string> {
    const state = this.requireStoredWallet(await this.loadWalletState());
    if (!state.encryptedMnemonic) {
      throw new Error("wallet does not have a recovery phrase");
    }
    return decryptMnemonic(state.encryptedMnemonic, password);
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
      connectedOrigins: []
    };
    await this.store.saveState(nextState);
    await Promise.all(
      state.connectedOrigins.map((origin) => this.emitDisconnectLifecycle(origin))
    );
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

    return this.persistWalletState({
      ...state,
      watchedAssets: state.watchedAssets.filter(
        (asset) => asset.contract !== trimmed
      )
    });
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
    request: XianProviderRequest
  ): Promise<ProviderRequestStartResult> {
    const existing = await this.store.loadRequestState(requestId);
    if (existing) {
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
      createdAt: this.now(),
      updatedAt: this.now(),
      status: "pending"
    };
    await this.store.saveRequestState(requestState);

    try {
      const immediate = await this.executeImmediateRequest(
        await this.loadWalletState(),
        origin,
        request
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
    options?: { consume?: boolean }
  ): Promise<ProviderRequestStatusResult> {
    const state = await this.store.loadRequestState(requestId);
    if (!state) {
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

  async resolveApproval(approvalId: string, approved: boolean): Promise<null> {
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
        approval.record.request
      );
      await this.fulfillRequest(requestState, result);
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
