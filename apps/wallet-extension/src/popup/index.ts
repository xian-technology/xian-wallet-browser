import { XianClient, type WatchSubscription } from "@xian-tech/client";
import {
  assertRpcTransportAllowed,
  formatChiWithXianCost,
  truncateAddress,
  type ApprovalView,
  type WalletBackup,
  type WalletDexTokenInfo,
  type PopupState,
  type WalletDetectedAsset
} from "@xian-tech/wallet-core";

import {
  type PopupRuntimeState,
  popupStateBanner,
  sendRuntimeMessage,
  type WalletAssetBalanceRuntimeResult,
  type ShieldedSnapshotHistoryRuntimeResult,
  type WalletCreateRuntimeResult,
  type WalletDexSnapshotRuntimeResult,
  type WalletTransactionSubmittedRuntimeMessage
} from "../shared/messages";
import {
  DEFAULT_AUTO_LOCK,
  type WalletShellMode
} from "../shared/preferences";
import {
  isPositiveRuntimeAmount,
  isRecognizedXianRecipient,
  parseArgValue,
  parseRuntimeNumberInput
} from "../runtime-input";
import {
  loadLocalActivityTxs,
  loadDexAvailability,
  saveLocalActivityTx,
  saveDexAvailability,
  STORAGE_KEY,
  SESSION_STORAGE_KEY
} from "../shared/storage";

const appRoot = document.querySelector<HTMLElement>("#app");
if (!appRoot) {
  throw new Error("missing popup root");
}

const root = appRoot;

const toastRoot = document.createElement("div");
toastRoot.id = "toast-root";
document.body.appendChild(toastRoot);

/* ── Types ─────────────────────────────────────────────────── */

type PopupTab = "home" | "send" | "trade" | "activity" | "apps" | "security";
type SetupMode = "create" | "importMnemonic" | "importPrivateKey" | "importBackup";
type FlashTone = "info" | "success" | "danger" | "warning";
type FlashIcon = "info" | "success" | "danger" | "warning" | "none";

interface NetworkDraft {
  id?: string;
  name: string;
  chainId: string;
  rpcUrl: string;
  dashboardUrl: string;
  allowInsecureHttp: boolean;
  makeActive: boolean;
}

interface FlashMessage {
  message: string;
  tone: FlashTone;
  detail?: string;
  icon?: FlashIcon;
  action?: {
    label: string;
    href: string;
    title?: string;
  };
  durationMs?: number;
}

/* ── Icons (Feather-style SVGs) ────────────────────────────── */

import { ICONS } from "./icons";
import {
  assetGradient,
  assetRawBalance,
  balanceStateKey,
  findDisplayedAsset,
  hiddenAssetCount,
  isDetectedAsset,
  isAssetHiddenOnActiveNetwork,
  isAssetUnavailableOnActiveNetwork,
  normalizeLiveBalance,
  renderTokenIcon,
  unavailableAssetCount,
  unavailableAssetLabel,
  visibleAssetContracts,
  visibleDetectedAssets,
  visibleWatchedAssets,
  type DisplayedAsset
} from "./assets";
import {
  escapeAttribute,
  escapeHtml,
  formatBalance,
  formatTimestamp,
  generateQrSvg,
  isValidXianAddress,
  safeOriginLabel,
  truncateHash
} from "./format";
import {
  type ActivityTx,
  type TxCategory,
  type TxClassification,
  TX_ACCENT_BG,
  TX_ACCENT_FG,
  classifyTx,
  formatTxAmount,
  formatTxArgValue,
  formatTxTimestamp,
} from "./tx-classify";
import {
  DEFAULT_DEADLINE_MINUTES,
  DEFAULT_SLIPPAGE_BPS,
  DEX_ROUTER,
  blockedIntermediateToken,
  buildDexQuote,
  deadlineFromNow,
  minReceived,
  runtimeFixedFromNumber,
  runtimeFixedFromString,
  sortedDexTokens,
  tokenByContract,
  tokenSymbol,
  useSupportingFeeRoute,
  type DexQuote
} from "./dex";

/* ── State ─────────────────────────────────────────────────── */

let currentState: PopupRuntimeState | null = null;
let generatedMnemonic: string | null = null;
let revealedMnemonic: string | null = null;
let revealedPrivateKey: string | null = null;
let activeTab: PopupTab = "home";
let setupMode: SetupMode = "create";
let flash: FlashMessage | null = null;
let networkDraft: NetworkDraft | null = null;
let balancesLoading = false;
let balanceGeneration = 0;
let selectedAsset: string | null = null;
let tokenMeta: {
  name: string | null;
  symbol: string | null;
  logoUrl: string | null;
  logoSvg: string | null;
} | null = null;
let tokenMetaLoading = false;
let tokenMetaGeneration = 0;
let showReceive = false;
let managingAssets = false;
let activeApprovalId: string | null = null;
let pendingBroadTrustApprovalId: string | null = null;
let showAccountMenu = false;
let renamingAccountIndex: number | null = null;
let confirmDeleteAccountIndex: number | null = null;
let confirmDeleteContactId: string | null = null;
let confirmRemoveSelectedAsset = false;
let confirmWalletRemoval = false;
let showImportBackupDialog = false;
let autoLockEnabled = DEFAULT_AUTO_LOCK;
let autoLockRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let lockStateCheck: Promise<boolean> | null = null;
let balanceWatchClient: XianClient | null = null;
let balanceWatchClientKey: string | null = null;
const balanceSubscriptions = new Map<string, WatchSubscription>();
const shieldedHistoryStatus = new Map<
  string,
  | { loading: true }
  | { loading: false; status: ShieldedSnapshotHistoryRuntimeResult }
  | { loading: false; error: string }
>();
/* ── Send tab state ────────────────────────────────────────── */

type TxArgType = "str" | "int" | "float" | "bool" | "dict" | "list" | "datetime" | "timedelta" | "Any";
type SendMode = "simple" | "advanced";
type SendStep = "draft" | "review" | "sending";

interface TxArg {
  id: string;
  name: string;
  value: string;
  type: TxArgType;
  fixed?: boolean;
  typeFixed?: boolean;
}

type ContractMethod = {
  name: string;
  arguments: { name: string; type: string }[];
};

interface SendTransactionResult {
  submitted: boolean;
  accepted: boolean | null;
  finalized: boolean;
  txHash?: string;
  message?: unknown;
  receipt?: unknown;
}

interface TransactionFlashLabels {
  sent?: string;
  finalized?: string;
  accepted?: string;
  failed?: string;
}

let sendMode: SendMode = "simple";
let sendStep: SendStep = "draft";

// Simple send
let simpleToken = "currency";
let showTokenPicker = false;
let simpleTo = "";
let simpleAmount = "";
let pendingUnrecognizedRecipient: string | null = null;
let pendingUnavailableTokenContract: string | null = null;
let simpleReviewLoading = false;
let simpleReviewRequestId = 0;

// Contacts
interface Contact {
  id: string;
  name: string;
  address: string;
}
let contacts: Contact[] = [];
let contactsLoaded = false;
let showContactPicker = false;
let editingContacts = false;
let pendingContact: { name: string; address: string } | null = null;
let sendContract = "";
let sendFunction = "";
let sendArgs: TxArg[] = [];
let sendEstimateMode = true;
let sendManualChi = "";
let sendParsedKwargs: Record<string, unknown> | null = null;
let sendEstimate: { estimated: number } | null = null;
let sendChiRate: number | null = null;
let sendResult: SendTransactionResult | null = null;
let argIdCounter = 0;
let contractMethods: ContractMethod[] = [];
let contractMethodsLoading = false;
let contractMethodsError: string | null = null;
let contractMethodsFor: string | null = null;
let transactionFlashGeneration = 0;

/* ── Trade state ───────────────────────────────────────────── */

type DexAvailabilityStatus = "unknown" | "checking" | "available" | "unavailable";
type TradeStep = "form" | "review" | "approving" | "swapping";
type TradeTokenSide = "from" | "to";

let dexAvailabilityStatus: DexAvailabilityStatus = "unknown";
let dexAvailabilityNetworkKey: string | null = null;
let dexAvailabilityError: string | null = null;
let dexAvailabilityProbe: Promise<void> | null = null;

let tradeStep: TradeStep = "form";
let tradeSnapshot: WalletDexSnapshotRuntimeResult | null = null;
let tradeSnapshotLoading = false;
let tradeSnapshotError: string | null = null;
let tradeSnapshotNetworkKey: string | null = null;
let tradeFromToken = "currency";
let tradeToToken = "";
let tradeAmount = "";
let tradeSlippageBps = DEFAULT_SLIPPAGE_BPS;
let tradeDeadlineMinutes = DEFAULT_DEADLINE_MINUTES;
let tradeEstimate: { estimated: number } | null = null;
let tradeChiRate: number | null = null;
let tradeQuoteForReview: DexQuote | null = null;
let tradeKwargsForReview: Record<string, unknown> | null = null;
let tradeApprovalNotice: string | null = null;
let tradeTokenPicker: TradeTokenSide | null = null;

function resetSendState(): void {
  sendMode = "simple";
  sendStep = "draft";
  simpleToken = "currency";
  showTokenPicker = false;
  simpleTo = "";
  simpleAmount = "";
  pendingUnrecognizedRecipient = null;
  simpleReviewLoading = false;
  simpleReviewRequestId++;
  showContactPicker = false;
  editingContacts = false;
  pendingContact = null;
  sendContract = "";
  sendFunction = "";
  sendArgs = [];
  sendEstimateMode = true;
  sendManualChi = "";
  sendParsedKwargs = null;
  sendEstimate = null;
  sendChiRate = null;
  sendResult = null;
  contractMethods = [];
  contractMethodsLoading = false;
  contractMethodsError = null;
  contractMethodsFor = null;
}

function resetTradeForm(): void {
  tradeStep = "form";
  tradeFromToken = "currency";
  tradeToToken = "";
  tradeAmount = "";
  tradeEstimate = null;
  tradeChiRate = null;
  tradeQuoteForReview = null;
  tradeKwargsForReview = null;
  tradeApprovalNotice = null;
  tradeTokenPicker = null;
}

function resetNoWalletUiState(): void {
  activeTab = "home";
  setupMode = "create";
  generatedMnemonic = null;
  revealedMnemonic = null;
  revealedPrivateKey = null;
  networkDraft = null;
  balancesLoading = false;
  balanceGeneration++;
  selectedAsset = null;
  tokenMeta = null;
  tokenMetaLoading = false;
  tokenMetaGeneration++;
  showReceive = false;
  managingAssets = false;
  activeApprovalId = null;
  showAccountMenu = false;
  renamingAccountIndex = null;
  confirmDeleteAccountIndex = null;
  confirmDeleteContactId = null;
  confirmRemoveSelectedAsset = false;
  confirmWalletRemoval = false;
  showImportBackupDialog = false;
  contacts = [];
  contactsLoaded = false;
  pendingUnavailableTokenContract = null;
  transactionFlashGeneration++;
  dexAvailabilityStatus = "unknown";
  dexAvailabilityNetworkKey = null;
  dexAvailabilityError = null;
  dexAvailabilityProbe = null;
  tradeSnapshot = null;
  tradeSnapshotLoading = false;
  tradeSnapshotError = null;
  tradeSnapshotNetworkKey = null;
  resetSendState();
  resetTradeForm();
  resetActivityState();
  activityStateKey = null;
  activityRequestId++;
  activityPollGeneration++;
}

function dexNetworkKey(state: PopupRuntimeState): string {
  return [
    state.activeNetworkId ?? "network",
    state.resolvedChainId ?? state.chainId ?? state.configuredChainId ?? "",
    state.rpcUrl
  ].join("|");
}

function resetDexAvailabilityForNetwork(state: PopupRuntimeState): void {
  const networkKey = dexNetworkKey(state);
  if (dexAvailabilityNetworkKey !== networkKey) {
    dexAvailabilityNetworkKey = networkKey;
    dexAvailabilityStatus = "unknown";
    dexAvailabilityError = null;
    dexAvailabilityProbe = null;
    tradeSnapshot = null;
    tradeSnapshotNetworkKey = null;
    tradeSnapshotError = null;
    tradeSnapshotLoading = false;
    resetTradeForm();
  }
}

async function ensureDexAvailability(state: PopupRuntimeState): Promise<void> {
  const networkKey = dexNetworkKey(state);
  resetDexAvailabilityForNetwork(state);
  if (
    dexAvailabilityStatus === "available" ||
    dexAvailabilityStatus === "checking"
  ) {
    return dexAvailabilityProbe ?? undefined;
  }

  const cached = await loadDexAvailability(networkKey).catch(() => null);
  if (cached?.contract === DEX_ROUTER) {
    dexAvailabilityStatus = "available";
    dexAvailabilityError = null;
    render(currentState?.unlocked ? currentState : state);
    return;
  }

  dexAvailabilityStatus = "checking";
  dexAvailabilityError = null;
  dexAvailabilityProbe = (async () => {
    try {
      const snapshot = await sendRuntimeMessage<WalletDexSnapshotRuntimeResult>({
        type: "wallet_get_dex_snapshot"
      });
      if (dexAvailabilityNetworkKey !== networkKey) {
        return;
      }
      if (snapshot.available) {
        dexAvailabilityStatus = "available";
        dexAvailabilityError = null;
        tradeSnapshot = snapshot;
        tradeSnapshotNetworkKey = networkKey;
        await saveDexAvailability({
          networkKey,
          contract: DEX_ROUTER,
          checkedAt: new Date().toISOString()
        });
      } else {
        dexAvailabilityStatus = "unavailable";
        dexAvailabilityError = snapshot.reason ?? "DEX is not deployed on this network.";
      }
    } catch (error) {
      if (dexAvailabilityNetworkKey !== networkKey) {
        return;
      }
      dexAvailabilityStatus = "unavailable";
      dexAvailabilityError = formatError(error);
    } finally {
      if (dexAvailabilityNetworkKey === networkKey) {
        dexAvailabilityProbe = null;
        render(currentState?.unlocked ? currentState : state);
      }
    }
  })();
  render(state);
  return dexAvailabilityProbe;
}

async function loadTradeSnapshot(
  state: PopupRuntimeState,
  options: { force?: boolean } = {}
): Promise<void> {
  const networkKey = dexNetworkKey(state);
  resetDexAvailabilityForNetwork(state);
  if (tradeSnapshotLoading && !options.force) {
    return;
  }
  if (
    !options.force &&
    tradeSnapshot &&
    tradeSnapshotNetworkKey === networkKey
  ) {
    return;
  }

  tradeSnapshotLoading = true;
  tradeSnapshotError = null;
  render(state);
  try {
    const snapshot = await sendRuntimeMessage<WalletDexSnapshotRuntimeResult>({
      type: "wallet_get_dex_snapshot"
    });
    if (dexAvailabilityNetworkKey !== networkKey) {
      return;
    }
    tradeSnapshot = snapshot;
    tradeSnapshotNetworkKey = networkKey;
    tradeSnapshotError = snapshot.available
      ? null
      : snapshot.reason ?? "DEX is not deployed on this network.";
    dexAvailabilityStatus = snapshot.available ? "available" : "unavailable";
    dexAvailabilityError = tradeSnapshotError;
    if (snapshot.available) {
      await saveDexAvailability({
        networkKey,
        contract: DEX_ROUTER,
        checkedAt: new Date().toISOString()
      });
    }
  } catch (error) {
    tradeSnapshotError = formatError(error);
  } finally {
    if (dexAvailabilityNetworkKey === networkKey) {
      tradeSnapshotLoading = false;
      render(currentState?.unlocked ? currentState : state);
    }
  }
}

function captureSendFormState(): void {
  const c = root.querySelector<HTMLInputElement>("#send-contract");
  const f = root.querySelector<HTMLSelectElement>("#send-function");
  const s = root.querySelector<HTMLInputElement>("#send-chi");
  if (c) sendContract = c.value.trim();
  if (f) sendFunction = f.value;
  if (s) sendManualChi = s.value.trim();
  for (const arg of sendArgs) {
    const row = root.querySelector<HTMLElement>(
      `[data-arg-id="${arg.id}"]`
    );
    if (!row) continue;
    const n = row.querySelector<HTMLInputElement>(".arg-name");
    const v = row.querySelector<HTMLInputElement>(".arg-value");
    const t = row.querySelector<HTMLSelectElement>(".arg-type");
    if (n) arg.name = n.value.trim();
    if (v) arg.value = v.value;
    if (t) arg.type = t.value as TxArgType;
  }
}

function captureSimpleSendFormState(): void {
  const tokenSelect = root.querySelector<HTMLSelectElement>("#simple-token");
  const toInput = root.querySelector<HTMLInputElement>("#simple-to");
  const amtInput = root.querySelector<HTMLInputElement>("#simple-amount");
  if (tokenSelect) simpleToken = tokenSelect.value;
  if (toInput) simpleTo = toInput.value.trim();
  if (amtInput) simpleAmount = amtInput.value.trim();
}

function mapContractType(annotation: string): TxArgType {
  switch (annotation) {
    case "str":
      return "str";
    case "int":
      return "int";
    case "float":
      return "float";
    case "bool":
      return "bool";
    case "dict":
      return "dict";
    case "list":
      return "list";
    case "datetime.datetime":
      return "datetime";
    case "datetime.timedelta":
      return "timedelta";
    case "Any":
      return "Any";
    default:
      return "str";
  }
}

function sendArgsFromMethod(method: ContractMethod): TxArg[] {
  return method.arguments.map((a) => {
    const t = mapContractType(a.type);
    return {
      id: String(++argIdCounter),
      name: a.name,
      value: "",
      type: t,
      fixed: true,
      typeFixed: t !== "Any"
    };
  });
}

function syncSendArgsForSelectedFunction(): void {
  const method = contractMethods.find((m) => m.name === sendFunction);
  if (!method) {
    sendArgs = [];
    return;
  }
  if (sendArgs.length === 0) {
    sendArgs = sendArgsFromMethod(method);
  }
}

function buildSendKwargs(): Record<string, unknown> {
  const kwargs: Record<string, unknown> = {};
  for (const arg of sendArgs) {
    if (!arg.name) continue;
    kwargs[arg.name] = parseArgValue(arg.value, arg.type);
  }
  return kwargs;
}

async function loadContractMethodsForSend(
  contractName: string,
  state: PopupRuntimeState
): Promise<void> {
  const nextContract = contractName.trim();
  if (
    !nextContract ||
    (nextContract === contractMethodsFor &&
      (contractMethodsLoading || contractMethods.length > 0 || contractMethodsError))
  ) {
    return;
  }

  sendContract = nextContract;
  contractMethodsFor = nextContract;
  contractMethods = [];
  contractMethodsLoading = true;
  contractMethodsError = null;
  if (!sendFunction) {
    sendArgs = [];
  }
  render(state);

  try {
    const methods = await sendRuntimeMessage<ContractMethod[]>({
      type: "wallet_get_contract_methods",
      contract: nextContract
    });
    if (contractMethodsFor !== nextContract || sendContract !== nextContract) {
      return;
    }
    contractMethods = methods;
    if (!contractMethods.some((method) => method.name === sendFunction)) {
      sendFunction = "";
      sendArgs = [];
    } else {
      syncSendArgsForSelectedFunction();
    }
    contractMethodsLoading = false;
    if (contractMethods.length === 0) {
      contractMethodsError = "No transaction functions found for this contract.";
    }
  } catch (error) {
    if (contractMethodsFor !== nextContract || sendContract !== nextContract) {
      return;
    }
    contractMethodsLoading = false;
    contractMethodsError = formatError(error);
    contractMethods = [];
  }
  if (contractMethodsFor === nextContract) {
    render(state);
  }
}

/* ── Utilities ─────────────────────────────────────────────── */

function selectedAssetIsTracked(state: PopupRuntimeState): boolean {
  if (!selectedAsset) {
    return false;
  }
  return state.watchedAssets.some((asset) => asset.contract === selectedAsset);
}

function activePresetAllowsInsecureHttp(state: PopupRuntimeState): boolean {
  return (
    state.networkPresets.find((preset) => preset.id === state.activeNetworkId)
      ?.allowInsecureHttp === true
  );
}

function ensureBalanceWatchClient(state: PopupRuntimeState): XianClient | null {
  if (!state.dashboardUrl) {
    balanceWatchClient = null;
    balanceWatchClientKey = null;
    return null;
  }
  try {
    assertRpcTransportAllowed(state.rpcUrl, activePresetAllowsInsecureHttp(state));
  } catch {
    balanceWatchClient = null;
    balanceWatchClientKey = null;
    return null;
  }
  const nextKey = `${state.rpcUrl}|${state.dashboardUrl}`;
  if (!balanceWatchClient || balanceWatchClientKey !== nextKey) {
    balanceWatchClient = new XianClient({
      rpcUrl: state.rpcUrl,
      dashboardUrl: state.dashboardUrl
    });
    balanceWatchClientKey = nextKey;
  }
  return balanceWatchClient;
}

async function clearBalanceSubscriptions(): Promise<void> {
  const subscriptions = [...balanceSubscriptions.values()];
  balanceSubscriptions.clear();
  await Promise.all(
    subscriptions.map((subscription) =>
      subscription.unsubscribe().catch(() => undefined)
    )
  );
}

function applyVisibleBalanceUpdate(contract: string, value: unknown): void {
  if (!currentState) {
    return;
  }
  const normalized = normalizeLiveBalance(value);
  currentState.assetBalances[contract] = normalized;
  currentState.detectedAssets = currentState.detectedAssets.map((asset) =>
    asset.contract === contract ? { ...asset, balance: normalized } : asset
  );
  render(currentState);
}

async function syncBalanceSubscriptions(): Promise<void> {
  const state = currentState;
  if (!state?.unlocked || !state.publicKey || !state.dashboardUrl) {
    await clearBalanceSubscriptions();
    return;
  }

  const client = ensureBalanceWatchClient(state);
  if (!client) {
    await clearBalanceSubscriptions();
    return;
  }

  const desired = new Map<string, string>();
  for (const contract of visibleAssetContracts(state)) {
    desired.set(balanceStateKey(contract, state.publicKey), contract);
  }

  for (const [key, subscription] of [...balanceSubscriptions.entries()]) {
    if (desired.has(key)) {
      continue;
    }
    balanceSubscriptions.delete(key);
    void subscription.unsubscribe();
  }

  for (const [key, contract] of desired.entries()) {
    if (balanceSubscriptions.has(key)) {
      continue;
    }
    try {
      const subscription = client.watch.state(key, (message) => {
        if (message.key === key) {
          applyVisibleBalanceUpdate(contract, message.value);
        }
      });
      balanceSubscriptions.set(key, subscription);
    } catch {
      return;
    }
  }
}

function popupSessionExpired(state: PopupRuntimeState): boolean {
  if (!state.unlocked) {
    return false;
  }
  const expiresAt = state.sessionExpiresAt;
  return (
    typeof expiresAt === "number" &&
    Number.isFinite(expiresAt) &&
    expiresAt < Number.MAX_SAFE_INTEGER &&
    expiresAt <= Date.now()
  );
}

async function reconcileLockedState(): Promise<boolean> {
  if (currentState?.hasWallet && !currentState.unlocked) {
    return true;
  }
  if (lockStateCheck) {
    return lockStateCheck;
  }

  const check = (async () => {
    try {
      const state = await sendRuntimeMessage<PopupRuntimeState>({
        type: "wallet_get_popup_state"
      });
      if (currentState && !currentState.hasWallet && state.hasWallet) {
        return false;
      }
      if (!state.unlocked) {
        await applyPopupState(state);
        return true;
      }
      if (
        currentState?.publicKey &&
        currentState.publicKey === state.publicKey
      ) {
        currentState.sessionExpiresAt = state.sessionExpiresAt;
      }
    } catch {
      // A failed lock-state probe should not be treated as a locked wallet.
    }
    return false;
  })();

  lockStateCheck = check;
  try {
    return await check;
  } finally {
    if (lockStateCheck === check) {
      lockStateCheck = null;
    }
  }
}

function applyReceiptStateWrites(execution: unknown): void {
  if (
    !currentState ||
    execution == null ||
    typeof execution !== "object" ||
    !Array.isArray((execution as { state?: unknown[] }).state)
  ) {
    return;
  }

  const writes = (execution as { state: Array<{ key?: unknown; value?: unknown }> }).state;
  const address = currentState.publicKey;
  if (!address) {
    return;
  }

  for (const write of writes) {
    if (typeof write?.key !== "string") {
      continue;
    }
    const suffix = `.balances:${address}`;
    if (!write.key.endsWith(suffix)) {
      continue;
    }
    const contract = write.key.slice(0, write.key.length - suffix.length);
    if (contract) {
      applyVisibleBalanceUpdate(contract, write.value);
    }
  }
}

/* ── Flash ─────────────────────────────────────────────────── */

function flashIconSvg(icon: FlashIcon | undefined, tone: FlashTone): string {
  const resolved = icon ?? tone;
  switch (resolved) {
    case "success":
      return ICONS.checkCircle;
    case "danger":
      return ICONS.xCircle;
    case "warning":
      return ICONS.alertTriangle;
    case "info":
      return ICONS.zap;
    case "none":
      return "";
  }
}

function renderToast(): void {
  if (!flash) {
    toastRoot.innerHTML = "";
    return;
  }
  const icon = flashIconSvg(flash.icon, flash.tone);
  const action = flash.action
    ? `<a class="flash-action" href="${escapeAttribute(flash.action.href)}" target="_blank" rel="noopener" title="${escapeAttribute(flash.action.title ?? flash.action.href)}">${escapeHtml(flash.action.label)}${ICONS.externalLink}</a>`
    : "";
  const html = `
    <div class="flash-toast flash-${flash.tone}" role="status">
      ${icon ? `<span class="flash-icon" aria-hidden="true">${icon}</span>` : ""}
      <span class="flash-content">
        <span class="flash-message">${escapeHtml(flash.message)}</span>
        ${flash.detail ? `<span class="flash-detail">${escapeHtml(flash.detail)}</span>` : ""}
        ${action}
      </span>
    </div>
  `;
  if (toastRoot.innerHTML !== html) {
    toastRoot.innerHTML = html;
  }
}

let flashTimer: ReturnType<typeof setTimeout> | null = null;

function setFlash(
  message: string,
  tone: FlashTone = "info",
  options: Omit<FlashMessage, "message" | "tone"> = {}
): void {
  flash = { message, tone, ...options };
  renderToast();
  if (flashTimer) {
    clearTimeout(flashTimer);
  }
  const durationMs = options.durationMs ?? (options.action ? 6000 : 3000);
  if (durationMs <= 0) {
    flashTimer = null;
    return;
  }
  flashTimer = setTimeout(() => {
    flash = null;
    flashTimer = null;
    renderToast();
  }, durationMs);
}

function clearFlash(): void {
  flash = null;
  renderToast();
  if (flashTimer) {
    clearTimeout(flashTimer);
    flashTimer = null;
  }
}

function transactionExplorerUrl(
  state: PopupRuntimeState,
  txHash: string | null | undefined
): string | null {
  const trimmedHash = txHash?.trim();
  const dashboardUrl = state.dashboardUrl?.trim();
  if (!trimmedHash || !dashboardUrl) {
    return null;
  }

  try {
    const parsed = new URL(dashboardUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
  } catch {
    return null;
  }

  return `${dashboardUrl.replace(/\/+$/, "")}/explorer/tx/${encodeURIComponent(trimmedHash)}`;
}

function transactionFlashAction(
  state: PopupRuntimeState,
  txHash: string | null | undefined
): FlashMessage["action"] | undefined {
  const href = transactionExplorerUrl(state, txHash);
  if (!href || !txHash) {
    return undefined;
  }
  return {
    label: "View transaction",
    href,
    title: txHash
  };
}

function setTransactionFlash(
  state: PopupRuntimeState,
  message: string,
  tone: FlashTone,
  txHash: string | null | undefined,
  options: {
    detail?: string;
    icon?: FlashIcon;
    durationMs?: number;
  } = {}
): void {
  setFlash(message, tone, {
    ...options,
    action: transactionFlashAction(state, txHash),
    detail: options.detail ?? (txHash ? truncateHash(txHash) : undefined),
    durationMs: options.durationMs ?? 6000
  });
}

function transactionAccepted(result: SendTransactionResult): boolean {
  return result.finalized === true || result.accepted === true;
}

function transactionFinalStatus(
  result: SendTransactionResult,
  labels: TransactionFlashLabels = {}
): {
  message: string;
  tone: FlashTone;
  icon: FlashIcon;
  detail?: string;
} | null {
  if (result.finalized === true) {
    return {
      message: labels.finalized ?? "Transaction finalized.",
      tone: "success",
      icon: "success"
    };
  }
  if (result.accepted === true) {
    return {
      message: labels.accepted ?? "Transaction accepted.",
      tone: "success",
      icon: "success"
    };
  }
  if (result.accepted === false || result.submitted === false) {
    return {
      message: labels.failed ?? "Transaction failed.",
      tone: "danger",
      icon: "danger",
      detail:
        typeof result.message === "string" && result.message.trim()
          ? result.message.trim()
          : undefined
    };
  }
  return null;
}

function scheduleTransactionStatusFlash(
  state: PopupRuntimeState,
  result: SendTransactionResult,
  generation: number,
  delayMs: number,
  labels: TransactionFlashLabels = {}
): void {
  const status = transactionFinalStatus(result, labels);
  if (!status) {
    return;
  }
  window.setTimeout(() => {
    if (generation !== transactionFlashGeneration) {
      return;
    }
    setTransactionFlash(state, status.message, status.tone, result.txHash, {
      icon: status.icon,
      detail: status.detail
    });
  }, delayMs);
}

function showSubmittedTransactionFlash(
  state: PopupRuntimeState,
  result: SendTransactionResult,
  labels: TransactionFlashLabels = {}
): {
  txHash: string | null;
  generation: number;
  sentFlashShown: boolean;
} {
  const txHash =
    typeof result.txHash === "string" && result.txHash.trim()
      ? result.txHash
      : null;
  const generation = ++transactionFlashGeneration;
  const sentFlashShown = result.submitted === true || Boolean(txHash);
  if (sentFlashShown) {
    setTransactionFlash(state, labels.sent ?? "Transaction sent.", "info", txHash, {
      icon: "info"
    });
  }
  return { txHash, generation, sentFlashShown };
}

/**
 * Run an async action and surface any failure as a danger flash toast,
 * then re-render. Collapses the repeated try/catch pattern at call sites.
 */
async function withErrorFlash<T>(action: () => Promise<T>): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    setFlash(formatError(error), "danger");
    render(currentState);
    return undefined;
  }
}

/* ── State setters ─────────────────────────────────────────── */

function setActiveTab(tab: PopupTab): void {
  activeTab = tab;
  selectedAsset = null;
  tokenMeta = null;
  tokenMetaLoading = false;
  showReceive = false;
  activeApprovalId = null;
  revealedPrivateKey = null;
  selectedTxHash = null;
  pendingUnrecognizedRecipient = null;
  pendingUnavailableTokenContract = null;
  confirmDeleteContactId = null;
  confirmRemoveSelectedAsset = false;
  if (tab === "activity" && currentState?.publicKey) {
    if (activityStateKey !== activityKey(currentState, currentState.publicKey)) {
      resetActivityState();
    }
    void fetchActivityTxs(currentState.publicKey);
  }
  if (currentState) {
    render(currentState);
  }
}

function setSetupMode(mode: SetupMode): void {
  setupMode = mode;
  render(currentState);
}

function draftFromPreset(
  preset: PopupState["networkPresets"][number]
): NetworkDraft {
  return {
    id: preset.builtin ? undefined : preset.id,
    name: preset.name,
    chainId: preset.chainId ?? "",
    rpcUrl: preset.rpcUrl,
    dashboardUrl: preset.dashboardUrl ?? "",
    allowInsecureHttp: preset.allowInsecureHttp === true,
    makeActive: true
  };
}

function defaultNetworkDraft(state: PopupRuntimeState): NetworkDraft {
  return {
    name: "Custom network",
    chainId: "",
    rpcUrl: state.rpcUrl,
    dashboardUrl: state.dashboardUrl ?? "",
    allowInsecureHttp: false,
    makeActive: true
  };
}

function resetNetworkDraft(): void {
  networkDraft = null;
}

function setNetworkDraft(nextDraft: NetworkDraft): void {
  networkDraft = nextDraft;
  if (currentState) {
    activeTab = "security";
    render(currentState);
  }
}

/* ── Refresh ───────────────────────────────────────────────── */

async function refresh(nextFlash?: FlashMessage | null): Promise<void> {
  if (nextFlash !== undefined) {
    flash = nextFlash;
  }
  const state = await sendRuntimeMessage<PopupRuntimeState>({
    type: "wallet_get_popup_state"
  });
  await applyPopupState(state);
}

async function removeWalletAndApplyState(shellMode: WalletShellMode): Promise<void> {
  const removedState = await sendRuntimeMessage<PopupState>({
    type: "wallet_remove"
  });
  confirmWalletRemoval = false;
  flash = {
    tone: "info",
    message: "Wallet removed."
  };
  await applyPopupState({
    ...removedState,
    shellMode
  });
}

async function applyPopupState(state: PopupRuntimeState): Promise<void> {
  const nextActivityKey =
    state.unlocked && state.publicKey ? activityKey(state, state.publicKey) : null;
  const activityContextChanged =
    activeTab === "activity" &&
    nextActivityKey != null &&
    activityStateKey !== nextActivityKey;
  if (activityContextChanged) {
    resetActivityState();
  }
  currentState = state;
  const activeSnapshotIds = new Set(
    state.shieldedWalletSnapshots.map((snapshot) => snapshot.id)
  );
  for (const snapshotId of shieldedHistoryStatus.keys()) {
    if (!activeSnapshotIds.has(snapshotId)) {
      shieldedHistoryStatus.delete(snapshotId);
    }
  }

  if (state.unlocked && !contactsLoaded) {
    contacts = await sendRuntimeMessage<Contact[]>({ type: "contacts_get" });
    contactsLoaded = true;
  }

  if (!state.hasWallet || !state.unlocked) {
    revealedMnemonic = null;
    networkDraft = null;
  }
  if (!state.hasWallet) {
    resetNoWalletUiState();
  }
  if (!state.unlocked) {
    balanceGeneration++;
    generatedMnemonic = null;
    resetSendState();
    resetActivityState();
    contactsLoaded = false;
    contacts = [];
    confirmDeleteContactId = null;
  }

  balancesLoading =
    state.unlocked &&
    (state.watchedAssets.length > 0 ||
      visibleDetectedAssets(state).length > 0);
  render(state);
  if (activityContextChanged && state.publicKey) {
    void fetchActivityTxs(state.publicKey);
  }
  void syncBalanceSubscriptions();
  void refreshDetectedAssets();
  void refreshBalances();
}

const MAX_AUTO_LOCK_REFRESH_DELAY_MS = 2_147_483_647;

function scheduleAutoLockRefresh(state: PopupRuntimeState | null): void {
  if (autoLockRefreshTimer) {
    clearTimeout(autoLockRefreshTimer);
    autoLockRefreshTimer = null;
  }

  const expiresAt = state?.unlocked ? state.sessionExpiresAt : undefined;
  if (
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt) ||
    expiresAt >= Number.MAX_SAFE_INTEGER
  ) {
    return;
  }

  const delay = expiresAt - Date.now();
  if (delay > MAX_AUTO_LOCK_REFRESH_DELAY_MS) {
    return;
  }

  autoLockRefreshTimer = setTimeout(() => {
    autoLockRefreshTimer = null;
    void refresh(null);
  }, Math.max(0, delay + 50));
}

async function refreshDetectedAssets(): Promise<void> {
  if (!currentState?.unlocked) {
    if (currentState) {
      currentState.detectedAssets = [];
    }
    await clearBalanceSubscriptions();
    return;
  }
  if (await reconcileLockedState()) {
    return;
  }

  try {
    const detectedAssets = await sendRuntimeMessage<WalletDetectedAsset[]>({
      type: "wallet_get_detected_assets"
    });
    if (await reconcileLockedState()) {
      return;
    }
    if (!currentState) {
      return;
    }
    currentState.detectedAssets = detectedAssets;
    for (const asset of detectedAssets) {
      if (
        asset.balance != null &&
        currentState.assetBalances[asset.contract] == null
      ) {
        currentState.assetBalances[asset.contract] = asset.balance;
      }
    }
    render(currentState);
    void syncBalanceSubscriptions();
  } catch {
    if (currentState) {
      currentState.detectedAssets = [];
      render(currentState);
    }
  }
}

async function refreshBalances(): Promise<void> {
  if (
    !currentState?.unlocked ||
    (currentState.watchedAssets.length === 0 &&
      visibleDetectedAssets(currentState).length === 0)
  ) {
    balancesLoading = false;
    return;
  }
  if (await reconcileLockedState()) {
    balancesLoading = false;
    return;
  }
  const gen = ++balanceGeneration;
  try {
    const snapshot = await sendRuntimeMessage<WalletAssetBalanceRuntimeResult>({
      type: "wallet_get_asset_balances"
    });
    if (gen !== balanceGeneration) {
      return;
    }
    if (await reconcileLockedState()) {
      balancesLoading = false;
      return;
    }
    if (currentState) {
      currentState.assetBalances = snapshot.balances;
      currentState.assetNetworkStates = snapshot.assetNetworkStates;
    }
  } catch {
    if (gen !== balanceGeneration) {
      return;
    }
  }
  balancesLoading = false;
  if (currentState) {
    render(currentState);
  }
}

async function fetchTokenMeta(contract: string): Promise<void> {
  const gen = ++tokenMetaGeneration;
  try {
    const meta = await sendRuntimeMessage<{
      contract: string;
      name: string | null;
      symbol: string | null;
      logoUrl: string | null;
      logoSvg: string | null;
    }>({
      type: "wallet_get_token_metadata",
      contract
    });
    if (gen !== tokenMetaGeneration) {
      return;
    }
    tokenMeta = meta;
  } catch {
    if (gen !== tokenMetaGeneration) {
      return;
    }
    tokenMeta = null;
  }
  tokenMetaLoading = false;
  if (currentState) {
    render(currentState);
  }
}

async function addTokenToWallet(
  contract: string,
  options: { confirmedInactive?: boolean } = {}
): Promise<void> {
  let metadata:
    | {
        contract: string;
        name: string | null;
        symbol: string | null;
        logoUrl: string | null;
        logoSvg: string | null;
      }
    | null = null;

  try {
    metadata = await sendRuntimeMessage<{
      contract: string;
      name: string | null;
      symbol: string | null;
      logoUrl: string | null;
      logoSvg: string | null;
    }>({
      type: "wallet_get_token_metadata",
      contract
    });
  } catch (error) {
    if (isMissingContractError(error) && !options.confirmedInactive) {
      pendingUnavailableTokenContract = contract;
      if (currentState) render(currentState);
      return;
    }

    if (!isMissingContractError(error)) {
      setFlash(formatError(error), "danger");
      if (currentState) render(currentState);
      return;
    }
  }

  await sendRuntimeMessage<PopupState>({
    type: "wallet_track_asset",
    asset: {
      contract,
      name: metadata?.name ?? undefined,
      symbol: metadata?.symbol ?? undefined,
      icon: metadata?.logoUrl ?? metadata?.logoSvg ?? undefined
    }
  });
  setFlash(
    metadata?.symbol
      ? `Added ${metadata.symbol}.`
      : options.confirmedInactive
        ? `Added ${contract} as inactive.`
        : `Added ${contract}.`,
    "success"
  );
  pendingUnavailableTokenContract = null;
  await refresh(null);
  managingAssets = true;
  render(currentState);
}

/* ── Render dispatch ───────────────────────────────────────── */

function render(state: PopupRuntimeState | null): void {
  const securityScrollTop =
    activeTab === "security"
      ? root.querySelector<HTMLElement>(".wallet-content")?.scrollTop
      : undefined;

  if (state?.hasWallet && popupSessionExpired(state)) {
    void reconcileLockedState();
  }

  if (!state || !state.hasWallet) {
    renderSetup(state);
  } else if (!state.unlocked) {
    renderLocked(state);
  } else {
    renderUnlocked(state);
    if (typeof securityScrollTop === "number" && activeTab === "security") {
      const walletContent =
        root.querySelector<HTMLElement>(".wallet-content");
      if (walletContent) {
        walletContent.scrollTop = securityScrollTop;
        requestAnimationFrame(() => {
          walletContent.scrollTop = securityScrollTop;
        });
      }
    }
  }
  renderToast();
  scheduleAutoLockRefresh(state);
}

function renderLoading(): void {
  root.innerHTML = `
    <div class="lock-screen">
      <div class="lock-avatar"><img src="icon.png" alt="" style="width: 32px; height: 32px; object-fit: contain" /></div>
      <h1>Xian Wallet</h1>
      <div class="spinner" style="margin-top: 16px"></div>
    </div>
  `;
}

function renderAccountMenu(state: PopupRuntimeState): string {
  return `
    <div class="account-menu">
      ${state.accounts
        .map((a) => {
          if (renamingAccountIndex === a.index) {
            return `
              <div class="account-menu-rename">
                <input class="account-rename-input" data-rename-input="${a.index}" value="${escapeAttribute(a.name)}" />
                <button class="ghost-sm" data-save-rename="${a.index}">Save</button>
                <button class="ghost-sm" data-cancel-rename>Cancel</button>
              </div>
            `;
          }
          return `
            <div class="account-menu-item ${a.index === state.activeAccountIndex ? "is-active" : ""}">
              <button class="account-menu-main" data-switch-account="${a.index}">
                <span class="account-menu-name">${escapeHtml(a.name)}</span>
                <span class="account-menu-addr mono">${escapeHtml(truncateHash(a.publicKey, 6, 4))}</span>
              </button>
              <button class="account-menu-action" data-start-rename="${a.index}" title="Rename">Rename</button>
            </div>
          `;
        })
        .join("")}
      <button class="account-menu-item account-menu-add" data-add-account-prompt>
        <span class="account-menu-name">${ICONS.plus} Add account</span>
      </button>
    </div>
  `;
}

function renderUnrecognizedRecipientDialog(recipient: string): string {
  return `
    <div class="app-dialog-backdrop" role="presentation">
      <div class="app-dialog" role="dialog" aria-modal="true" aria-labelledby="recipient-confirm-title">
        <div class="app-dialog-icon">${ICONS.alertTriangle}</div>
        <h3 id="recipient-confirm-title" class="app-dialog-title">Confirm recipient</h3>
        <p class="app-dialog-copy">This recipient is not a standard Xian address or contract name. Send funds to it anyway?</p>
        <div class="app-dialog-value mono">${escapeHtml(recipient)}</div>
        <div class="app-dialog-actions">
          <button class="secondary full-width" data-cancel-unrecognized-recipient>Cancel</button>
          <button class="danger full-width" data-confirm-unrecognized-recipient>Send Anyway</button>
        </div>
      </div>
    </div>
  `;
}

function renderUnavailableTokenDialog(contract: string, state: PopupRuntimeState): string {
  return `
    <div class="app-dialog-backdrop" role="presentation">
      <div class="app-dialog" role="dialog" aria-modal="true" aria-labelledby="token-unavailable-title">
        <div class="app-dialog-icon">${ICONS.alertTriangle}</div>
        <h3 id="token-unavailable-title" class="app-dialog-title">Token unavailable</h3>
        <p class="app-dialog-copy">This token contract was not found on ${escapeHtml(state.activeNetworkName ?? "the current network")}. Add it as an inactive token anyway?</p>
        <div class="app-dialog-value mono">${escapeHtml(contract)}</div>
        <div class="app-dialog-actions">
          <button class="secondary full-width" data-cancel-unavailable-token>Cancel</button>
          <button class="full-width" data-confirm-unavailable-token>Add Inactive</button>
        </div>
      </div>
    </div>
  `;
}

function renderImportBackupDialog(): string {
  return `
    <div class="app-dialog-backdrop" role="presentation">
      <div class="app-dialog app-dialog-wide" role="dialog" aria-modal="true" aria-labelledby="import-backup-title">
        <div class="app-dialog-icon">${ICONS.arrowDown}</div>
        <h3 id="import-backup-title" class="app-dialog-title">Import Backup</h3>
        <p class="app-dialog-copy">Choose an encrypted wallet backup file or paste the backup JSON.</p>
        <label class="backup-file-picker">
          Backup file
          <input id="import-backup-file" type="file" accept=".json,application/json" />
        </label>
        <textarea
          id="import-backup-json"
          class="app-dialog-textarea mono"
          rows="8"
          placeholder="Paste backup JSON"
          spellcheck="false"
        ></textarea>
        <div class="app-dialog-actions">
          <button class="secondary full-width" data-cancel-import-backup>Cancel</button>
          <button class="full-width" data-confirm-import-backup>Import</button>
        </div>
      </div>
    </div>
  `;
}

function parseWalletBackupJson(text: string): WalletBackup {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Paste backup JSON first.");
  }

  let backup: unknown;
  try {
    backup = JSON.parse(trimmed);
  } catch {
    throw new Error("Invalid backup JSON.");
  }

  if (!backup || typeof backup !== "object") {
    throw new Error("Invalid backup JSON.");
  }

  const candidate = backup as {
    version?: unknown;
    kind?: unknown;
  };
  if (candidate.version !== 2 || candidate.kind !== "xian-wallet-backup") {
    throw new Error("Invalid backup JSON.");
  }

  return backup as WalletBackup;
}

async function loadBackupFileIntoTextarea(
  fileInput: HTMLInputElement,
  textareaSelector: string
): Promise<void> {
  const file = fileInput.files?.[0];
  if (!file) {
    return;
  }

  const text = await file.text();
  parseWalletBackupJson(text);
  const textarea = root.querySelector<HTMLTextAreaElement>(textareaSelector);
  if (!textarea) {
    throw new Error("Backup import field is not available.");
  }
  textarea.value = text.trim();
  setFlash(`Loaded ${file.name}.`, "success");
}

function bindBackupFileChooser(inputSelector: string, textareaSelector: string): void {
  root
    .querySelector<HTMLInputElement>(inputSelector)
    ?.addEventListener("change", (event) => {
      const input = event.currentTarget;
      if (!(input instanceof HTMLInputElement)) {
        return;
      }
      void withErrorFlash(async () => {
        try {
          await loadBackupFileIntoTextarea(input, textareaSelector);
        } catch (error) {
          input.value = "";
          throw error;
        }
      });
    });
}

/* ═══════════════════════════════════════════════════════════
   SETUP SCREEN
   ═══════════════════════════════════════════════════════════ */

function renderSetup(state: PopupRuntimeState | null): void {
  const createSelected = setupMode === "create";
  const mnemonicSelected = setupMode === "importMnemonic";
  const privateKeySelected = setupMode === "importPrivateKey";
  const backupSelected = setupMode === "importBackup";
  const defaultRpc = state?.rpcUrl ?? "";
  const defaultDashboard = state?.dashboardUrl ?? "";

  root.innerHTML = `
    <div class="setup-screen">
      <div class="setup-top">
        <div class="setup-logo"><img src="icon.png" alt="" style="width: 32px; height: 32px; object-fit: contain" /></div>
        <h1>Xian Wallet</h1>
        <p class="muted text-sm">Self-custody for Xian. Keys encrypted locally.</p>
      </div>

      <div class="setup-form">
        <div class="segmented tab-bar" role="tablist" aria-label="Wallet setup mode">
          <button type="button" class="tab-button ${createSelected ? "is-active" : ""}" data-setup-mode="create">
            Create
          </button>
          <button type="button" class="tab-button ${mnemonicSelected ? "is-active" : ""}" data-setup-mode="importMnemonic">
            Seed
          </button>
          <button type="button" class="tab-button ${privateKeySelected ? "is-active" : ""}" data-setup-mode="importPrivateKey">
            Key
          </button>
          <button type="button" class="tab-button ${backupSelected ? "is-active" : ""}" data-setup-mode="importBackup">
            Backup
          </button>
        </div>

        <form id="setup-form" class="stack">
          <label>
            ${backupSelected ? "Backup password" : "Password"}
            <input id="setup-password" type="password" required autocomplete="new-password" />
          </label>

          ${
            createSelected
              ? `
                  <div class="surface surface-quiet">
                    <strong>New recovery seed</strong>
                    <p class="muted text-sm">A BIP39 seed phrase will be generated. Back it up before closing.</p>
                  </div>
                `
              : ""
          }

          ${
            mnemonicSelected
              ? `
                  <label>
                    Recovery seed
                    <textarea id="setup-mnemonic" placeholder="Enter your 12 or 24 word BIP39 seed phrase" required></textarea>
                  </label>
                `
              : ""
          }

          ${
            privateKeySelected
              ? `
                  <label>
                    Private key
                    <input id="setup-private-key" placeholder="32-byte hex seed" required autocomplete="off" />
                  </label>
                `
              : ""
          }

          ${
            backupSelected
              ? `
                  <label>
                    Backup JSON
                    <span class="backup-file-picker">
                      <span>Backup file</span>
                      <input id="setup-backup-file" type="file" accept=".json,application/json" />
                    </span>
                    <textarea id="setup-backup-json" class="mono" placeholder="Paste encrypted backup JSON" rows="8" spellcheck="false" required></textarea>
                  </label>
                `
              : `
                  <details class="disclosure">
                    <summary>Network settings</summary>
                    <div class="stack">
                      <label>
                        Network label
                        <input id="setup-network-name" value="Local node" />
                      </label>
                      <label>
                        Expected chain ID
                        <input id="setup-expected-chain-id" placeholder="Optional, e.g. xian-local-1" />
                      </label>
                      <label>
                        RPC URL
                        <input id="setup-rpc-url" value="${escapeAttribute(defaultRpc)}" />
                      </label>
                      <label>
                        Dashboard URL
                        <input id="setup-dashboard-url" value="${escapeAttribute(defaultDashboard)}" />
                      </label>
                      <label class="inline-check">
                        <input id="setup-allow-insecure-http" type="checkbox" />
                        <span>Allow HTTP data transfers</span>
                      </label>
                    </div>
                  </details>
                `
          }

          <button type="submit" class="full-width">
            ${
              createSelected
                ? "Create wallet"
                : mnemonicSelected
                  ? "Import recovery seed"
                  : privateKeySelected
                    ? "Import private key"
                    : "Import backup"
            }
          </button>
        </form>
      </div>
    </div>
  `;

  bindSetupEvents();
}

/* ═══════════════════════════════════════════════════════════
   LOCK SCREEN
   ═══════════════════════════════════════════════════════════ */

function renderLocked(state: PopupRuntimeState): void {
  root.innerHTML = `
    <div class="lock-screen">
      <div class="lock-avatar"><img src="icon.png" alt="" style="width: 32px; height: 32px; object-fit: contain" /></div>
      <h1>Xian Wallet</h1>
      <div class="balance-address-pill" data-copy-address style="margin-top: 8px">
        ${escapeHtml(truncateAddress(state.publicKey ?? ""))}
        ${ICONS.copy}
      </div>
      <p class="muted text-sm" style="margin-top: 8px">${escapeHtml(popupStateBanner(state))}</p>
      <form id="unlock-form" class="lock-body">
        <label>
          Password
          <input id="unlock-password" type="password" required autocomplete="current-password" />
        </label>
        <button type="submit" class="full-width">Unlock</button>
      </form>
      ${
        confirmWalletRemoval
          ? `
            <div class="banner banner-danger" style="margin-top: 12px; text-align: left">
              Permanently remove the wallet and all data?
              <div style="display: flex; gap: 8px; margin-top: 8px">
                <button class="ghost-sm full-width" data-lock-confirm-remove style="color: var(--danger); border-color: rgba(255,77,79,0.2)">Yes, remove</button>
                <button class="ghost-sm full-width" data-lock-cancel-remove>Cancel</button>
              </div>
            </div>
          `
          : `<button class="send-footer-link" data-lock-remove-wallet style="margin-top: 12px">Forgot password? Remove wallet</button>`
      }
    </div>
  `;

  root
    .querySelector<HTMLElement>("[data-copy-address]")
    ?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(state.publicKey ?? "");
        setFlash("Address copied.", "success");
        renderLocked(state);
      } catch {
        /* clipboard unavailable on lock screen is ok */
      }
    });

  root
    .querySelector<HTMLFormElement>("#unlock-form")
    ?.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await sendRuntimeMessage<PopupState>({
          type: "wallet_unlock",
          password: value("#unlock-password")
        });
        activeTab = "home";
        await refresh({
          tone: "success",
          message: "Wallet unlocked."
        });
      } catch {
        setFlash("Invalid password.", "danger");
        render(currentState);
      }
    });

  root
    .querySelector<HTMLElement>("[data-lock-remove-wallet]")
    ?.addEventListener("click", () => {
      confirmWalletRemoval = true;
      render(currentState);
    });

  root
    .querySelector<HTMLElement>("[data-lock-cancel-remove]")
    ?.addEventListener("click", () => {
      confirmWalletRemoval = false;
      render(currentState);
    });

  root
    .querySelector<HTMLElement>("[data-lock-confirm-remove]")
    ?.addEventListener("click", () => {
      void withErrorFlash(async () => {
        await removeWalletAndApplyState(state.shellMode);
      });
    });
}

/* ═══════════════════════════════════════════════════════════
   UNLOCKED – WALLET SHELL
   ═══════════════════════════════════════════════════════════ */

function shellModeLabel(mode: WalletShellMode): string {
  return mode === "sidePanel" ? "Chrome side panel" : "Toolbar popup";
}

function renderUnlocked(state: PopupRuntimeState): void {
  resetDexAvailabilityForNetwork(state);
  if (activeTab === "home" && dexAvailabilityStatus === "unknown") {
    void ensureDexAvailability(state);
  }

  const networkTone = toneForNetworkStatus(state.networkStatus);
  const dotClass =
    networkTone === "info"
      ? ""
      : networkTone === "warning"
        ? " header-dot-warning"
        : " header-dot-danger";
  const activeNetworkLabel = state.activeNetworkName ?? "Network";

  const activeAccount = state.accounts.find((a) => a.index === state.activeAccountIndex) ?? state.accounts[0];
  const accountLabel = activeAccount?.name ?? "Account";
  const hasMultipleAccounts = state.accounts.length > 1;
  const isMnemonic = state.seedSource === "mnemonic";

  root.innerHTML = `
    <div class="wallet-app">
      <header class="wallet-header">
        <div class="header-left">
          <img src="icon.png" alt="Xian" class="header-logo" />
          ${
            isMnemonic
              ? `<button class="header-account" data-toggle-account-menu title="Switch account">${escapeHtml(accountLabel)} ${ICONS.chevronDown}</button>`
              : `<span class="header-account-label">${escapeHtml(accountLabel)}</span>`
          }
        </div>
        <div class="header-right">
          <button class="header-network" data-refresh title="Refresh wallet data">
            <span class="header-dot${dotClass}"></span>
            ${escapeHtml(activeNetworkLabel)}
          </button>
          <button class="header-icon-btn" data-open-dashboard title="Open explorer">${ICONS.globe}</button>
          <button class="header-icon-btn" data-lock title="Lock wallet">${ICONS.lock}</button>
        </div>
      </header>
      ${showAccountMenu ? renderAccountMenu(state) : ""}

      <div class="wallet-content">
        ${renderTabPanel(state)}
      </div>
      <nav class="wallet-nav">
        <button class="nav-item ${activeTab === "home" ? "is-active" : ""}" data-tab="home">
          ${ICONS.home}
          Home
        </button>
        <button class="nav-item ${activeTab === "activity" ? "is-active" : ""}" data-tab="activity">
          ${ICONS.clock}
          Activity
        </button>
        <button class="nav-item ${activeTab === "apps" ? "is-active" : ""}" data-tab="apps">
          ${ICONS.grid}
          Apps
        </button>
        <button class="nav-item ${activeTab === "security" ? "is-active" : ""}" data-tab="security">
          ${ICONS.settings}
          Settings
        </button>
      </nav>
      ${pendingUnrecognizedRecipient ? renderUnrecognizedRecipientDialog(pendingUnrecognizedRecipient) : ""}
      ${pendingUnavailableTokenContract ? renderUnavailableTokenDialog(pendingUnavailableTokenContract, state) : ""}
      ${showImportBackupDialog ? renderImportBackupDialog() : ""}
    </div>
  `;

  bindUnlockedEvents(state);
}

function renderTabPanel(state: PopupRuntimeState): string {
  if (activeApprovalId) {
    const approval = state.pendingApprovals.find(
      (a) => a.id === activeApprovalId
    );
    if (approval) {
      return renderApprovalInline(approval);
    }
    activeApprovalId = null;
  }
  switch (activeTab) {
    case "home":
      return renderHomeTab(state);
    case "send":
      return renderSendTab(state);
    case "trade":
      return renderTradeTab(state);
    case "activity":
      return renderActivityTab(state);
    case "apps":
      return renderAppsTab(state);
    case "security":
      return renderSecurityTab(state);
  }
}

/* ═══════════════════════════════════════════════════════════
   HOME TAB
   ═══════════════════════════════════════════════════════════ */

function renderReceiveView(state: PopupRuntimeState): string {
  const address = state.publicKey ?? "";
  return `
    <div class="receive-view">
      <button class="detail-back" data-close-receive style="align-self: flex-start">
        ${ICONS.chevronLeft} Back
      </button>
      <div class="qr-frame">${generateQrSvg(address)}</div>
      <p class="muted text-sm" style="margin: 0">Your Xian address</p>
      <div class="receive-address">${
        [0, 1, 2, 3]
          .map(
            (row) =>
              `<div class="addr-row">${[0, 1, 2, 3]
                .map((col) => {
                  const i = row * 4 + col;
                  const chunk = address.slice(i * 4, i * 4 + 4);
                  return `<span class="${i % 2 === 0 ? "addr-bright" : "addr-dim"}">${escapeHtml(chunk)}</span>`;
                })
                .join("")}</div>`
          )
          .join("")
      }</div>
      <button class="secondary full-width" data-copy-address>Copy Address</button>
    </div>
  `;
}

function renderHomeTab(state: PopupRuntimeState): string {
  if (selectedAsset) {
    return renderTokenDetail(state);
  }
  if (showReceive) {
    return renderReceiveView(state);
  }

  const hasPending = state.pendingApprovals.length > 0;

  const pendingHtml = hasPending
    ? `
        <div class="section-hd">
          <span class="section-hd-label">Pending</span>
          <span class="section-hd-badge">${state.pendingApprovals.length}</span>
        </div>
        <div class="token-list">
          ${state.pendingApprovals.map((a) => renderApprovalItem(a)).join("")}
        </div>
      `
    : "";

  const sortedAssets = [...state.watchedAssets].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0)
  );
  const visibleAssets = visibleWatchedAssets(state);

  const trackedAssetsHtml =
    visibleAssets.length === 0 && !managingAssets
      ? `<div class="token-list"><div style="padding: 24px 0; text-align: center" class="muted text-sm">${state.watchedAssets.length > 0 ? "No assets available on this network." : "No assets tracked yet."}</div></div>`
      : managingAssets
        ? `<div class="token-list" id="manage-asset-list">${sortedAssets.map((a, i) => renderManageAssetRow(a, state, i)).join("")}</div>`
        : `<div class="token-list">${visibleAssets.map((a) => renderAssetItem(a, state)).join("")}</div>`;

  const detectedAssets = visibleDetectedAssets(state);
  const detectedAssetsHtml =
    detectedAssets.length === 0 || !managingAssets
      ? ""
      : `
          <div class="section-hd">
            <span class="section-hd-label">Detected</span>
            <span class="section-hd-badge">${detectedAssets.length}</span>
          </div>
          <div class="token-list">${detectedAssets.map((asset) => renderAssetItem(asset, state)).join("")}</div>
        `;

  const hiddenCount = hiddenAssetCount(state);
  const unavailableCount = unavailableAssetCount(state);
  const secondaryAssetCount =
    hiddenCount > 0 || unavailableCount > 0
      ? ` · ${[
          hiddenCount > 0 ? `${hiddenCount} hidden` : "",
          unavailableCount > 0 ? `${unavailableCount} unavailable` : ""
        ].filter(Boolean).join(" · ")}`
      : "";
  const tradeEnabled = dexAvailabilityStatus === "available";
  const tradeChecking = dexAvailabilityStatus === "checking";
  const tradeTitle = tradeEnabled
    ? "Swap tokens"
    : tradeChecking
      ? "Checking DEX availability"
      : dexAvailabilityError ?? "DEX is not deployed on this network yet";

  return `
    <div class="balance-hero">
      <div class="balance-address-pill" data-copy-address>
        ${escapeHtml(truncateAddress(state.publicKey ?? ""))}
        ${ICONS.copy}
      </div>
    </div>

    <div class="quick-actions">
      <button class="quick-action" data-go-send>
        <div class="quick-action-circle">${ICONS.arrowUp}</div>
        <span>Send</span>
      </button>
      <button class="quick-action" data-show-receive>
        <div class="quick-action-circle">${ICONS.arrowDown}</div>
        <span>Receive</span>
      </button>
      <button class="quick-action ${tradeEnabled ? "" : "quick-action-disabled"}" ${tradeEnabled ? "data-go-trade" : "disabled"} title="${escapeAttribute(tradeTitle)}">
        <div class="quick-action-circle">${ICONS.repeat}</div>
        <span>${tradeChecking ? "Checking" : "Swap"}</span>
      </button>
    </div>

    ${pendingHtml}

    <div class="section-hd">
      <span class="section-hd-label">Assets</span>
      <span class="section-hd-badge">${managingAssets ? state.watchedAssets.length : visibleAssets.length}${!managingAssets ? secondaryAssetCount : ""}</span>
    </div>
    ${trackedAssetsHtml}
    ${detectedAssetsHtml}
    ${managingAssets ? `
      <div style="padding: 8px 16px">
        <div style="display: flex; gap: 6px">
          <input id="add-token-input" class="ide-input" style="flex: 1; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg-0); color: var(--fg); font-size: 12px; font-family: var(--font-mono)" placeholder="Contract name" />
          <button class="ghost-sm" data-add-token>Add</button>
        </div>
      </div>
    ` : ""}
    <div class="manage-assets-footer">
      <button class="send-footer-link" data-toggle-manage-assets>${managingAssets ? "Done" : "Manage assets"}</button>
    </div>
  `;
}

function renderAssetItem(asset: DisplayedAsset, state: PopupRuntimeState): string {
  const symbol = asset.symbol ?? asset.contract.slice(0, 6);
  const color =
    asset.contract === "currency"
      ? "var(--accent-dim)"
      : assetGradient(asset.contract);
  const rawBalance = assetRawBalance(asset, state);
  const fiat = state.assetFiatValues[asset.contract];
  const balanceHtml = balancesLoading
    ? `<span class="skeleton">0,000.00</span>`
    : escapeHtml(formatBalance(rawBalance, asset.decimals));
  const fiatHtml = balancesLoading
    ? `<span class="skeleton">$0.00</span>`
    : fiat
      ? escapeHtml(fiat)
      : "";
  const isDetectedUntracked = isDetectedAsset(asset) && !asset.tracked;

  return `
    <div class="token-item${isDetectedUntracked ? " is-detected" : ""}" data-select-token="${escapeAttribute(asset.contract)}">
      ${renderTokenIcon({
        contract: asset.contract,
        symbol,
        icon: asset.icon ?? null,
        background: color
      })}
      <div class="token-body">
        <div class="token-name">${escapeHtml(symbol)}</div>
        <div class="token-sub">${escapeHtml(asset.name ?? asset.contract)}</div>
      </div>
      <div class="token-end">
        <div class="token-balance">${balanceHtml}</div>
        <div class="token-fiat">${
          isDetectedUntracked
            ? `<button class="track-pill" data-track-asset="${escapeAttribute(asset.contract)}">Track</button>`
            : fiatHtml
        }</div>
      </div>
    </div>
  `;
}

function renderManageAssetRow(
  asset: {
    contract: string;
    name?: string;
    symbol?: string;
    icon?: string;
    hidden?: boolean;
  },
  state: PopupRuntimeState,
  index: number
): string {
  const symbol = asset.symbol ?? asset.contract.slice(0, 6);
  const color = asset.contract === "currency" ? "var(--accent-dim)" : assetGradient(asset.contract);
  const isHidden = isAssetHiddenOnActiveNetwork(state, asset);
  const isUnavailable = isAssetUnavailableOnActiveNetwork(state, asset);
  const statusText = isUnavailable
    ? `<div class="token-status">${escapeHtml(unavailableAssetLabel(state))}</div>`
    : "";
  const toggleTitle = isUnavailable
    ? "Unavailable on this network"
    : isHidden ? "Show" : "Hide";

  return `
    <div class="manage-asset-row ${isHidden ? "is-hidden" : ""} ${isUnavailable ? "is-unavailable" : ""}" draggable="true" data-drag-contract="${escapeAttribute(asset.contract)}" data-drag-index="${index}">
      <span class="drag-handle">${ICONS.grip}</span>
      ${renderTokenIcon({
        contract: asset.contract,
        symbol,
        icon: asset.icon ?? null,
        background: color,
        size: 28,
        fontSize: 12
      })}
      <div class="token-body" style="flex: 1; min-width: 0">
        <div class="token-name">${escapeHtml(symbol)}</div>
        <div class="token-sub">${escapeHtml(asset.name ?? asset.contract)}</div>
        ${statusText}
      </div>
      <button class="icon-action" data-toggle-hide="${escapeAttribute(asset.contract)}" title="${escapeAttribute(toggleTitle)}" ${isUnavailable ? "disabled" : ""}>
        ${isHidden ? ICONS.eyeOff : ICONS.eye}
      </button>
    </div>
  `;
}

function renderTokenDetail(state: PopupRuntimeState): string {
  const asset = selectedAsset ? findDisplayedAsset(state, selectedAsset) : null;
  if (!asset) {
    selectedAsset = null;
    return renderHomeTab(state);
  }

  const symbol = asset.symbol ?? asset.contract.slice(0, 6);
  const color =
    asset.contract === "currency"
      ? "var(--accent-dim)"
      : assetGradient(asset.contract);
  const detailIcon =
    asset.icon ??
    tokenMeta?.logoUrl ??
    tokenMeta?.logoSvg ??
    null;
  const isPinned = asset.contract === "currency";
  const tracked = selectedAssetIsTracked(state);
  const rawBalance = assetRawBalance(asset, state);
  const fiat = state.assetFiatValues[asset.contract];
  const balanceHtml = balancesLoading
    ? `<span class="skeleton">0,000.00</span>`
    : escapeHtml(formatBalance(rawBalance, asset.decimals));
  const fiatHtml = balancesLoading
    ? `<span class="skeleton">$0.00</span>`
    : fiat
      ? escapeHtml(fiat)
      : "";

  const metaRows = tokenMetaLoading
    ? `
        <div class="s-row"><span class="s-row-key">Token name</span><span class="s-row-val"><span class="skeleton">Loading</span></span></div>
        <div class="s-row"><span class="s-row-key">Symbol</span><span class="s-row-val"><span class="skeleton">Loading</span></span></div>
        <div class="s-row"><span class="s-row-key">Logo URL</span><span class="s-row-val"><span class="skeleton">Loading</span></span></div>
        <div class="s-row"><span class="s-row-key">On-chain SVG</span><span class="s-row-val"><span class="skeleton">Loading</span></span></div>
      `
    : tokenMeta
      ? `
          <div class="s-row"><span class="s-row-key">Token name</span><span class="s-row-val">${escapeHtml(tokenMeta.name ?? "—")}</span></div>
          <div class="s-row"><span class="s-row-key">Symbol</span><span class="s-row-val">${escapeHtml(tokenMeta.symbol ?? "—")}</span></div>
          <div class="s-row"><span class="s-row-key">Logo URL</span><span class="s-row-val mono">${escapeHtml(tokenMeta.logoUrl ?? "—")}</span></div>
          <div class="s-row"><span class="s-row-key">On-chain SVG</span><span class="s-row-val">${tokenMeta.logoSvg ? "Available" : "—"}</span></div>
        `
      : `
          <div class="s-row"><span class="s-row-key">Token name</span><span class="s-row-val muted">Unavailable</span></div>
          <div class="s-row"><span class="s-row-key">Symbol</span><span class="s-row-val muted">Unavailable</span></div>
          <div class="s-row"><span class="s-row-key">Logo URL</span><span class="s-row-val muted">Unavailable</span></div>
          <div class="s-row"><span class="s-row-key">On-chain SVG</span><span class="s-row-val muted">Unavailable</span></div>
        `;

  return `
    <div class="token-detail">
      <button class="detail-back" data-back-to-list>
        ${ICONS.chevronLeft} Back
      </button>

      <div class="token-detail-hero">
        ${renderTokenIcon({
          contract: asset.contract,
          symbol,
          icon: detailIcon,
          background: color,
          size: 48,
          fontSize: 20,
          style: "margin: 0 auto"
        })}
        <div class="token-detail-symbol">${escapeHtml(symbol)}</div>
        <div class="token-detail-name">${escapeHtml(asset.name ?? asset.contract)}</div>
        <div class="token-detail-balance">${balanceHtml}</div>
        <div class="token-detail-fiat">${fiatHtml}</div>
      </div>

      <div class="s-card">
        <div class="s-card-head">
          <div><h3 class="s-card-title">Details</h3></div>
        </div>
        <div class="s-card-body">
          <div class="s-row">
            <span class="s-row-key">Contract</span>
            <span class="s-row-val mono">${escapeHtml(asset.contract)}</span>
          </div>
          ${metaRows}
        </div>
      </div>

      ${
        tracked
          ? `
              <div class="s-card">
                <div class="s-card-head">
                  <div><h3 class="s-card-title">Display</h3></div>
                </div>
                <div class="s-card-body">
                  <form id="decimals-form" class="stack">
                    <label>
                      Decimal places shown in token list
                      <input id="decimals-input" type="number" min="0" max="18" value="${asset.decimals ?? 8}" />
                    </label>
                    <button type="submit" class="secondary">Save</button>
                  </form>
                </div>
              </div>
            `
          : `
              <button class="secondary full-width" data-track-selected-asset>Add To Wallet</button>
            `
      }

      ${
        tracked && !isPinned
          ? confirmRemoveSelectedAsset
            ? `<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">
                 <button class="secondary" data-cancel-remove-selected-asset>Cancel</button>
                 <button class="danger" data-confirm-remove-selected-asset>Remove</button>
               </div>`
            : `<button class="secondary full-width" data-remove-selected-asset>Remove from wallet</button>`
          : ""
      }
    </div>
  `;
}

function renderApprovalItem(approval: ApprovalView): string {
  return `
    <div class="token-item">
      <div class="token-icon" style="background: var(--accent-soft); color: var(--accent)">!</div>
      <div class="token-body">
        <div class="token-name">${escapeHtml(approval.title)}</div>
        <div class="token-sub">${escapeHtml(safeOriginLabel(approval.origin))}</div>
      </div>
      <button class="ghost-sm" data-open-approval="${escapeAttribute(approval.id)}">Review</button>
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════
   APPS TAB
   ═══════════════════════════════════════════════════════════ */

function renderAppsTab(state: PopupRuntimeState): string {
  const connectedOrigins = Array.isArray(state.connectedOrigins)
    ? state.connectedOrigins
    : [];
  const trustedDappPolicies = Array.isArray(state.trustedDappPolicies)
    ? state.trustedDappPolicies
    : [];
  const rawConnectedDappMetadata = (state as {
    connectedDappMetadata?: unknown;
  }).connectedDappMetadata;
  const connectedDappMetadata =
    rawConnectedDappMetadata &&
    typeof rawConnectedDappMetadata === "object"
      ? rawConnectedDappMetadata as PopupRuntimeState["connectedDappMetadata"]
      : {};

  if (connectedOrigins.length === 0) {
    return `
      <div class="section-hd">
        <span class="section-hd-label">Connected apps</span>
      </div>
      <div class="app-list">
        <div style="padding: 32px 0; text-align: center" class="muted text-sm">No connected sites.</div>
      </div>
    `;
  }

  return `
    <div class="section-hd">
      <span class="section-hd-label">Connected apps</span>
      <span class="section-hd-badge">${connectedOrigins.length}</span>
    </div>
    ${
      connectedOrigins.length > 1
        ? `<div style="padding: 0 16px"><button class="ghost full-width" data-disconnect-all>Disconnect all</button></div>`
        : ""
    }
    <div class="app-list">
      ${connectedOrigins.map((o) =>
        renderOriginItem(
          o,
          trustedDappPolicies,
          connectedDappMetadata[o]
        )
      ).join("")}
    </div>
  `;
}

function renderOriginItem(
  origin: string,
  trustedDappPolicies: PopupRuntimeState["trustedDappPolicies"],
  metadata?: PopupRuntimeState["connectedDappMetadata"][string]
): string {
  const hostname = safeOriginLabel(origin);
  const displayName = metadata?.name?.trim() || hostname;
  const displaySubtitle =
    displayName === hostname ? origin : `${hostname} · ${origin}`;
  const letter = escapeHtml((displayName.charAt(0) || "?").toUpperCase());
  const fallbackBackground = assetGradient(origin);
  const faviconUrl =
    metadata?.iconUrl ??
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=64`;
  const policies = trustedDappPolicies.filter(
    (policy) => policy.origin === origin
  );

  return `
    <div class="app-group">
      <div class="app-item">
        <div class="app-favicon-frame" style="--app-favicon-bg: ${escapeAttribute(fallbackBackground)}">
          <span class="app-favicon-placeholder" aria-hidden="true">${letter}</span>
          <img class="app-favicon" data-app-favicon src="${escapeAttribute(faviconUrl)}" alt="" width="32" height="32" />
        </div>
        <div class="app-item-info">
          <div class="app-item-host">${escapeHtml(displayName)}</div>
          <div class="app-item-url">${escapeHtml(displaySubtitle)}</div>
          ${
            policies.length > 0
              ? `<div class="app-item-url">${policies.length} auto-approval rule${policies.length === 1 ? "" : "s"}</div>`
              : ""
          }
        </div>
        <button class="ghost-sm" data-disconnect-origin="${escapeAttribute(origin)}">Disconnect</button>
      </div>
      ${
        policies.length > 0
          ? `
              <div class="app-policy-list">
                ${policies.map(renderTrustedDappPolicy).join("")}
              </div>
            `
          : ""
      }
    </div>
  `;
}

function bindAppFaviconFallbacks(): void {
  for (const image of root.querySelectorAll<HTMLImageElement>("[data-app-favicon]")) {
    const frame = image.closest<HTMLElement>(".app-favicon-frame");
    if (!frame) {
      continue;
    }

    const showImage = () => {
      frame.classList.add("is-loaded");
    };
    const showPlaceholder = () => {
      frame.classList.remove("is-loaded");
    };

    image.addEventListener("load", () => {
      if (image.naturalWidth > 0) {
        showImage();
      } else {
        showPlaceholder();
      }
    });
    image.addEventListener("error", showPlaceholder);

    if (image.complete) {
      if (image.naturalWidth > 0) {
        showImage();
      } else {
        showPlaceholder();
      }
    }
  }
}

function bindTokenIconFallbacks(): void {
  for (const image of root.querySelectorAll<HTMLImageElement>(
    "[data-token-icon-image]"
  )) {
    const frame = image.closest<HTMLElement>("[data-token-icon-frame]");
    const placeholder = image.nextElementSibling as HTMLElement | null;
    if (!frame || !placeholder) {
      continue;
    }

    const showImage = () => {
      image.hidden = false;
      placeholder.hidden = true;
    };
    const showPlaceholder = () => {
      image.hidden = true;
      frame.style.background = frame.dataset.fallbackBg ?? "";
      placeholder.hidden = false;
    };

    image.addEventListener("load", () => {
      if (image.naturalWidth > 0) {
        showImage();
      } else {
        showPlaceholder();
      }
    });
    image.addEventListener("error", showPlaceholder);

    if (image.complete) {
      if (image.naturalWidth > 0) {
        showImage();
      } else {
        showPlaceholder();
      }
    }
  }
}

function renderTrustedDappPolicy(policy: PopupRuntimeState["trustedDappPolicies"][number]): string {
  const methodLabel = policy.methods
    .map((method) => method.replace("xian_", ""))
    .join(", ");
  const scope = [
    policy.contract && policy.function
      ? `${policy.contract}.${policy.function}`
      : policy.label,
    methodLabel,
    policy.chainId
  ].filter(Boolean).join(" · ");
  const expires =
    policy.expiresAt != null
      ? `Expires ${formatTimestamp(policy.expiresAt)}`
      : "No expiry";
  const lastUsed =
    policy.lastUsedAt != null
      ? ` · Used ${formatTimestamp(policy.lastUsedAt)}`
      : "";
  const argumentScope =
    policy.argumentScope === "any"
      ? "Any arguments"
      : `Exact arguments${policy.kwargs ? ` (${Object.keys(policy.kwargs).length})` : ""}`;

  return `
    <div class="app-policy-row">
      <div>
        <div class="app-policy-title">${escapeHtml(scope)}</div>
        <div class="app-policy-meta">${escapeHtml(argumentScope)} · ${escapeHtml(expires)}${escapeHtml(lastUsed)}</div>
      </div>
      <button class="ghost-sm" data-remove-trusted-policy="${escapeAttribute(policy.id)}">Revoke</button>
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════
   ACTIVITY TAB
   ═══════════════════════════════════════════════════════════ */

let activityTxs: ActivityTx[] = [];
let activityLoading = false;
let activityError: string | null = null;
let activityNotice: string | null = null;
let activityStateKey: string | null = null;
let activityRequestId = 0;
let activityPollGeneration = 0;
const ACTIVITY_TX_POLL_DELAYS_MS = [0, 750, 2_000, 5_000, 10_000];

function activityKey(state: PopupRuntimeState, address: string): string {
  return `${state.activeNetworkId ?? state.rpcUrl}|${state.rpcUrl}|${address}`;
}

function txTimestampMillis(tx: ActivityTx): number {
  const raw = tx.created_at ?? tx.block_time;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 1e12 ? raw : raw * 1000;
  }
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function mergeActivityTxs(
  indexedTxs: ActivityTx[],
  localTxs: ActivityTx[]
): ActivityTx[] {
  const indexedHashes = new Set(indexedTxs.map((tx) => tx.hash));
  const seenLocalHashes = new Set<string>();
  const dedupedLocalTxs = localTxs.filter((tx) => {
    if (indexedHashes.has(tx.hash) || seenLocalHashes.has(tx.hash)) {
      return false;
    }
    seenLocalHashes.add(tx.hash);
    return true;
  });
  return [...dedupedLocalTxs, ...indexedTxs].sort(
    (left, right) => txTimestampMillis(right) - txTimestampMillis(left)
  );
}

async function loadLocalActivityForKey(networkKey: string): Promise<ActivityTx[]> {
  try {
    return (await loadLocalActivityTxs(networkKey)) as ActivityTx[];
  } catch {
    return [];
  }
}

function localActivityStatusLabel(tx: ActivityTx): string {
  if (!tx.success) return "Failed";
  if (tx.local === true && tx.block_height == null) {
    return tx.local_status === "finalized" ? "Finalized" : "Accepted";
  }
  return "Success";
}

function isLocalUnindexedTx(tx: ActivityTx): boolean {
  return tx.local === true && tx.block_height == null;
}

function formatActivityListTime(tx: ActivityTx): string {
  const raw = tx.created_at ?? tx.block_time;
  const timestamp = txTimestampMillis(tx);
  if (timestamp <= 0) {
    return formatTxTimestamp(raw) ?? "";
  }
  const diff = Date.now() - timestamp;
  if (diff < 0) {
    return formatTxTimestamp(raw) ?? "";
  }
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function activitySubtitle(tx: ActivityTx, cls: TxClassification): string {
  const kwargs = (tx.payload?.kwargs ?? {}) as Record<string, unknown>;
  const to = typeof kwargs.to === "string" ? kwargs.to : "";
  if (cls.category === "send" || cls.category === "receive") {
    const amount = formatTxAmount(kwargs.amount);
    if (amount && to) {
      return `${amount} ${tx.contract} to ${truncateHash(to, 6, 4)}`;
    }
    if (amount) {
      return `${amount} ${tx.contract}`;
    }
  } else if (cls.category === "approve") {
    const amount = formatTxAmount(kwargs.amount);
    if (amount && to) {
      return `${amount} ${tx.contract} for ${truncateHash(to, 6, 4)}`;
    }
    if (amount) {
      return `${amount} ${tx.contract}`;
    }
  } else if (cls.category === "buy" || cls.category === "sell" || cls.category === "swap") {
    const amountIn = formatTxAmount(kwargs.amountIn);
    const src = typeof kwargs.src === "string" ? (kwargs.src as string) : "";
    if (amountIn) return `${amountIn}${src ? ` ${src}` : ""}`;
  } else if (cls.category === "add_liquidity" || cls.category === "remove_liquidity") {
    const a = typeof kwargs.tokenA === "string" ? (kwargs.tokenA as string) : "";
    const b = typeof kwargs.tokenB === "string" ? (kwargs.tokenB as string) : "";
    if (a && b) return `${a} / ${b}`;
  } else if (cls.category === "create_token") {
    const sym = typeof kwargs.token_symbol === "string" ? (kwargs.token_symbol as string) : "";
    const name = typeof kwargs.token_name === "string" ? (kwargs.token_name as string) : "";
    return sym || name || "";
  }
  return `${tx.contract}.${tx.function}`;
}

function normalizeActivityPayload(value: unknown): ActivityTx[] {
  if (Array.isArray(value)) {
    return value as ActivityTx[];
  }
  if (value && typeof value === "object") {
    const items = (value as { items?: unknown }).items;
    return Array.isArray(items) ? (items as ActivityTx[]) : [];
  }
  return [];
}

async function readJsonBodyOrNull(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function decodeActivityValue(value: unknown): ActivityTx[] {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  let decoded = "";
  try {
    decoded = atob(value);
  } catch {
    return [];
  }
  if (!decoded.trim()) {
    return [];
  }
  try {
    return normalizeActivityPayload(JSON.parse(decoded));
  } catch {
    return [];
  }
}

async function loadActivityTxsFromRpc(
  rpcUrl: string,
  address: string,
  allowInsecureHttp: boolean
): Promise<ActivityTx[]> {
  assertRpcTransportAllowed(rpcUrl, allowInsecureHttp);
  const resp = await fetch(
    `${rpcUrl}/abci_query?path=%22/txs_by_sender/${address}/limit=50/offset=0%22`
  );
  if (!resp.ok) {
    throw new Error("Activity is unavailable on this network.");
  }
  const data = await readJsonBodyOrNull(resp);
  return decodeActivityValue(
    (data as { result?: { response?: { value?: unknown } } } | null)
      ?.result?.response?.value
  );
}

function resetActivityState(): void {
  activityTxs = [];
  activityError = null;
  activityNotice = null;
  activityLoading = false;
  selectedTxHash = null;
}

async function fetchActivityTxs(
  address: string,
  options: { showLoading?: boolean } = {}
): Promise<void> {
  const state = currentState;
  if (!state) {
    return;
  }
  const requestKey = activityKey(state, address);
  const requestId = ++activityRequestId;
  activityStateKey = requestKey;
  const showLoading = options.showLoading ?? true;
  if (showLoading) {
    activityLoading = true;
  }
  activityError = null;
  if (showLoading) {
    render(state);
  }
  const localTxs = await loadLocalActivityForKey(requestKey);
  try {
    const txs = await loadActivityTxsFromRpc(
      state.rpcUrl,
      address,
      activePresetAllowsInsecureHttp(state)
    );
    if (
      requestId !== activityRequestId ||
      !currentState ||
      activityKey(currentState, address) !== requestKey
    ) {
      return;
    }
    activityTxs = mergeActivityTxs(txs, localTxs);
    activityNotice = activityTxs.some(isLocalUnindexedTx)
      ? "Recent submissions are shown from this device until indexed history catches up."
      : null;
  } catch {
    if (
      requestId !== activityRequestId ||
      !currentState ||
      activityKey(currentState, address) !== requestKey
    ) {
      return;
    }
    activityTxs = localTxs;
    if (localTxs.length > 0) {
      activityError = null;
      activityNotice = "Showing saved submissions only. Indexed history is unavailable on this network.";
    } else {
      activityError = "Activity is unavailable on this network.";
      activityNotice = null;
    }
  }
  activityLoading = false;
  if (currentState) render(currentState);
}

function makeLocalActivityTx(
  state: PopupRuntimeState,
  txHash: string,
  result: NonNullable<typeof sendResult>,
  context: {
    contract: string;
    function: string;
    kwargs: Record<string, unknown>;
  } = {
    contract: sendContract,
    function: sendFunction,
    kwargs: sendParsedKwargs ?? {}
  }
): ActivityTx | null {
  if (!state.publicKey || !txHash.trim()) {
    return null;
  }
  return {
    hash: txHash.trim(),
    sender: state.publicKey,
    contract: context.contract,
    function: context.function,
    success: result.finalized || result.accepted === true,
    created_at: new Date().toISOString(),
    payload: {
      sender: state.publicKey,
      contract: context.contract,
      function: context.function,
      kwargs: context.kwargs
    },
    result: result.message ? { message: result.message } : undefined,
    local: true,
    local_status: result.finalized ? "finalized" : "accepted"
  };
}

function upsertActivityTx(tx: ActivityTx): void {
  activityTxs = mergeActivityTxs(
    activityTxs.filter((item) => item.hash !== tx.hash),
    [tx]
  );
}

async function recordLocalActivityTx(
  state: PopupRuntimeState,
  txHash: string,
  result: NonNullable<typeof sendResult>,
  context?: {
    contract: string;
    function: string;
    kwargs: Record<string, unknown>;
  }
): Promise<void> {
  const tx = makeLocalActivityTx(state, txHash, result, context);
  if (!tx || !state.publicKey) {
    return;
  }
  const networkKey = activityKey(state, state.publicKey);
  if (
    currentState?.publicKey &&
    activityKey(currentState, currentState.publicKey) === networkKey
  ) {
    upsertActivityTx(tx);
    if (activeTab === "activity") {
      render(currentState);
    }
  }
  await saveLocalActivityTx(networkKey, tx);
}

function activityHasTx(hash: string): boolean {
  return activityTxs.some((tx) => tx.hash === hash);
}

function refreshActivityAfterTransaction(
  sourceState: PopupRuntimeState,
  txHash?: string | null
): void {
  if (!sourceState.publicKey) {
    return;
  }
  const expectedHash = txHash?.trim();
  const expectedKey = activityKey(sourceState, sourceState.publicKey);
  const generation = ++activityPollGeneration;
  const delays = expectedHash ? ACTIVITY_TX_POLL_DELAYS_MS : [0];

  const poll = (attempt: number) => {
    const delay = delays[attempt];
    if (delay == null) {
      return;
    }
    window.setTimeout(() => {
      void (async () => {
        const state = currentState;
        if (
          generation !== activityPollGeneration ||
          !state?.publicKey ||
          activityKey(state, state.publicKey) !== expectedKey
        ) {
          return;
        }

        await fetchActivityTxs(state.publicKey, {
          showLoading: activeTab === "activity" && attempt === 0
        });

        if (expectedHash && activityHasTx(expectedHash)) {
          return;
        }
        poll(attempt + 1);
      })();
    }, delay);
  };

  poll(0);
}

function isWalletTransactionSubmittedMessage(
  message: unknown
): message is WalletTransactionSubmittedRuntimeMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "wallet_transaction_submitted"
  );
}

function walletStorageWasRemoved(change: unknown): boolean {
  if (typeof change !== "object" || change === null) {
    return false;
  }
  const storageChange = change as {
    oldValue?: { wallet?: unknown } | null;
    newValue?: { wallet?: unknown } | null;
  };
  return Boolean(storageChange.oldValue?.wallet) && !storageChange.newValue?.wallet;
}

async function handleWalletTransactionSubmitted(
  message: WalletTransactionSubmittedRuntimeMessage
): Promise<void> {
  const state = currentState;
  if (!state?.publicKey) {
    return;
  }
  if (message.sender && message.sender !== state.publicKey) {
    return;
  }

  applyReceiptStateWrites(message.execution);
  void refresh(null);

  if (message.txHash) {
    refreshActivityAfterTransaction(state, message.txHash);
  } else {
    await fetchActivityTxs(state.publicKey, {
      showLoading: activeTab === "activity"
    });
  }
}

let selectedTxHash: string | null = null;

function renderTxDetail(tx: ActivityTx, state: PopupRuntimeState): string {
  const cls = classifyTx(tx);
  const kwargs = (tx.payload?.kwargs ?? {}) as Record<string, unknown>;
  const explorerBase = state.dashboardUrl
    ? state.dashboardUrl.replace(/\/+$/, "") + "/explorer/tx/"
    : null;

  const rows: string[] = [];
  const addRow = (key: string, val: string, mono = false) => {
    rows.push(
      `<div class="s-row"><span class="s-row-key">${escapeHtml(key)}</span><span class="s-row-val${mono ? " mono" : ""}" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeAttribute(val.replace(/<[^>]+>/g, ""))}">${val}</span></div>`
    );
  };

  const addressLink = (addr: string): string => {
    const short = truncateHash(addr, 8, 6);
    if (state.dashboardUrl) {
      const base = state.dashboardUrl.replace(/\/+$/, "") + "/explorer/address/";
      return `<a href="${escapeAttribute(base + addr)}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">${escapeHtml(short)}</a>`;
    }
    return escapeHtml(short);
  };

  const tokenLabel = (contractName: string | null | undefined): string => {
    if (!contractName) return "—";
    return escapeHtml(contractName);
  };

  switch (cls.category) {
    case "send":
    case "receive": {
      const amount = formatTxAmount(kwargs.amount);
      const to = typeof kwargs.to === "string" ? (kwargs.to as string) : null;
      const mainAccount =
        typeof kwargs.main_account === "string"
          ? (kwargs.main_account as string)
          : null;
      if (amount) {
        addRow("Amount", `${escapeHtml(amount)} ${tokenLabel(tx.contract)}`);
      }
      addRow("From", addressLink(tx.sender));
      if (to) addRow("To", addressLink(to));
      if (mainAccount) addRow("On behalf of", addressLink(mainAccount));
      break;
    }
    case "approve": {
      const amount = formatTxAmount(kwargs.amount);
      const to = typeof kwargs.to === "string" ? (kwargs.to as string) : null;
      if (amount) {
        addRow("Amount", `${escapeHtml(amount)} ${tokenLabel(tx.contract)}`);
      }
      if (to) addRow("Spender", addressLink(to));
      addRow("Owner", addressLink(tx.sender));
      break;
    }
    case "buy":
    case "sell":
    case "swap": {
      const amountIn = formatTxAmount(kwargs.amountIn);
      const amountOutMin = formatTxAmount(kwargs.amountOutMin);
      const src = typeof kwargs.src === "string" ? (kwargs.src as string) : null;
      const path = Array.isArray(kwargs.path)
        ? (kwargs.path as unknown[])
            .filter((p): p is string => typeof p === "string")
        : null;
      const to = typeof kwargs.to === "string" ? (kwargs.to as string) : null;
      if (amountIn) addRow("Amount in", `${escapeHtml(amountIn)}${src ? ` ${escapeHtml(src)}` : ""}`);
      if (amountOutMin) addRow("Min out", escapeHtml(amountOutMin));
      if (path && path.length > 0) {
        const full = src ? [src, ...path] : path;
        addRow("Route", escapeHtml(full.join(" → ")));
      }
      if (to) addRow("Recipient", addressLink(to));
      break;
    }
    case "add_liquidity":
    case "remove_liquidity": {
      const tokenA = typeof kwargs.tokenA === "string" ? (kwargs.tokenA as string) : null;
      const tokenB = typeof kwargs.tokenB === "string" ? (kwargs.tokenB as string) : null;
      if (tokenA && tokenB) {
        addRow("Pair", `${escapeHtml(tokenA)} / ${escapeHtml(tokenB)}`);
      }
      const amountA = formatTxAmount(kwargs.amountADesired ?? kwargs.amountA);
      const amountB = formatTxAmount(kwargs.amountBDesired ?? kwargs.amountB);
      const liquidity = formatTxAmount(kwargs.liquidity);
      if (amountA) addRow("Amount A", escapeHtml(amountA));
      if (amountB) addRow("Amount B", escapeHtml(amountB));
      if (liquidity) addRow("Liquidity", escapeHtml(liquidity));
      break;
    }
    case "create_token": {
      const tokenContract =
        typeof kwargs.token_contract === "string"
          ? (kwargs.token_contract as string)
          : null;
      const tokenName =
        typeof kwargs.token_name === "string" ? (kwargs.token_name as string) : null;
      const tokenSymbol =
        typeof kwargs.token_symbol === "string"
          ? (kwargs.token_symbol as string)
          : null;
      const supply = formatTxAmount(kwargs.initial_supply);
      if (tokenName) addRow("Name", escapeHtml(tokenName));
      if (tokenSymbol) addRow("Symbol", escapeHtml(tokenSymbol));
      if (tokenContract) addRow("Contract", escapeHtml(tokenContract));
      if (supply) addRow("Initial supply", escapeHtml(supply));
      break;
    }
    case "contract":
    default:
      break;
  }

  // Generic footer rows
  const hashDisplay = explorerBase
    ? `<a href="${escapeAttribute(explorerBase + tx.hash)}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">${escapeHtml(truncateHash(tx.hash))}</a>`
    : escapeHtml(truncateHash(tx.hash));
  addRow("Hash", hashDisplay, true);
  addRow("Contract", `${escapeHtml(tx.contract)}.${escapeHtml(tx.function)}`);
  if (tx.block_height !== null && tx.block_height !== undefined) {
    addRow("Block", String(tx.block_height));
  }
  if (tx.chi_used !== null && tx.chi_used !== undefined) {
    const chi = Number(tx.chi_used);
    addRow("Chi used", Number.isFinite(chi) ? chi.toLocaleString() : String(tx.chi_used));
  }
  const when = formatTxTimestamp(tx.created_at ?? tx.block_time);
  if (when) addRow("Time", escapeHtml(when));

  // Extra kwargs not covered above (best-effort dump for transparency)
  const knownKeys: Record<TxCategory, string[]> = {
    send: ["amount", "to", "main_account"],
    receive: ["amount", "to", "main_account"],
    approve: ["amount", "to"],
    buy: ["amountIn", "amountOutMin", "src", "path", "to"],
    sell: ["amountIn", "amountOutMin", "src", "path", "to"],
    swap: ["amountIn", "amountOutMin", "src", "path", "to"],
    add_liquidity: ["tokenA", "tokenB", "amountADesired", "amountBDesired", "amountA", "amountB", "amountAMin", "amountBMin", "to", "deadline", "feeBps"],
    remove_liquidity: ["tokenA", "tokenB", "liquidity", "amountAMin", "amountBMin", "to", "deadline"],
    create_token: ["token_contract", "token_name", "token_symbol", "initial_supply", "token_logo_url", "token_logo_svg", "token_website", "initial_holder", "operator_address"],
    contract: []
  };
  const extraKwargRows: string[] = [];
  const known = new Set(knownKeys[cls.category]);
  for (const [k, v] of Object.entries(kwargs)) {
    if (known.has(k)) continue;
    const label = k;
    const formatted = formatTxArgValue(v);
    if (formatted.length > 60) {
      extraKwargRows.push(
        `<div class="s-row" style="align-items:flex-start"><span class="s-row-key">${escapeHtml(label)}</span><span class="s-row-val mono" style="text-align:right;word-break:break-all;white-space:normal;max-width:180px">${escapeHtml(formatted)}</span></div>`
      );
    } else {
      extraKwargRows.push(
        `<div class="s-row"><span class="s-row-key">${escapeHtml(label)}</span><span class="s-row-val mono" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeAttribute(formatted)}">${escapeHtml(formatted)}</span></div>`
      );
    }
  }

  const resultMessage = (() => {
    if (tx.success) return null;
    const res = tx.result as unknown;
    if (!res) return null;
    if (typeof res === "string") return res;
    if (typeof res === "object") {
      const obj = res as Record<string, unknown>;
      const msg = obj.error ?? obj.message ?? obj.result ?? null;
      if (typeof msg === "string") return msg;
      try {
        return JSON.stringify(res);
      } catch {
        return null;
      }
    }
    return null;
  })();

  return `
    <div class="settings-wrap">
      <button class="detail-back" data-close-tx-detail>${ICONS.chevronLeft} Back</button>
      <div class="s-card">
        <div class="s-card-head">
          <div style="display:flex;align-items:center;gap:12px;min-width:0">
            <div class="token-icon" style="background:${TX_ACCENT_BG[cls.accent]};color:${TX_ACCENT_FG[cls.accent]};width:40px;height:40px">${cls.icon}</div>
            <div style="min-width:0">
              <h3 class="s-card-title">${escapeHtml(cls.label)}</h3>
              <p class="s-card-desc">${escapeHtml(tx.contract)}.${escapeHtml(tx.function)}</p>
            </div>
          </div>
          <span class="pill ${tx.success ? "pill-info" : "pill-danger"}">${escapeHtml(localActivityStatusLabel(tx))}</span>
        </div>
        <div class="s-card-body">
          ${rows.join("")}
        </div>
      </div>
      ${
        resultMessage
          ? `<div class="s-card"><div class="s-card-head"><div><h3 class="s-card-title">Error</h3></div></div><div class="s-card-body"><div class="s-row" style="align-items:flex-start"><span class="s-row-val mono" style="text-align:left;word-break:break-all;white-space:normal">${escapeHtml(resultMessage)}</span></div></div></div>`
          : ""
      }
      ${
        extraKwargRows.length > 0
          ? `<div class="s-card"><div class="s-card-head"><div><h3 class="s-card-title">Arguments</h3></div></div><div class="s-card-body">${extraKwargRows.join("")}</div></div>`
          : ""
      }
    </div>
  `;
}

function renderActivityTab(state: PopupRuntimeState): string {
  if (selectedTxHash) {
    const tx = activityTxs.find((t) => t.hash === selectedTxHash);
    if (tx) {
      return renderTxDetail(tx, state);
    }
    selectedTxHash = null;
  }

  if (activityLoading) {
    return `<div class="send-centered"><div class="spinner"></div><p class="muted text-sm">Loading transactions...</p></div>`;
  }

  if (activityTxs.length === 0) {
    if (activityError) {
      return `
        <div class="send-centered" style="padding: 48px 0; gap: 12px">
          <p class="muted text-sm" style="color: var(--danger)">${escapeHtml(activityError)}</p>
          <p class="muted text-sm" style="opacity: 0.6">Check the RPC endpoint and try again.</p>
          <button class="secondary activity-retry-btn" data-retry-activity>${ICONS.repeat} Retry</button>
        </div>
      `;
    }
    return `
      <div class="send-centered" style="padding: 48px 0">
        <p class="muted text-sm">No transactions on this network yet.</p>
        <p class="muted text-sm" style="opacity: 0.6">Send or receive tokens to see activity here.</p>
      </div>
    `;
  }

  const noticeHtml = activityNotice
    ? `<div class="activity-notice">${ICONS.alertTriangle}<span>${escapeHtml(activityNotice)}</span><button class="ghost-sm" data-retry-activity>Retry</button></div>`
    : "";

  return `
    ${noticeHtml}
    <div class="token-list">
      ${activityTxs.map((tx) => {
        const cls = classifyTx(tx);
        const subtitle = activitySubtitle(tx, cls);
        const when = formatActivityListTime(tx);
        return `
          <div class="token-item" data-select-tx="${escapeAttribute(tx.hash)}" style="cursor:pointer">
            <div class="token-icon" style="background:${TX_ACCENT_BG[cls.accent]};color:${TX_ACCENT_FG[cls.accent]}">
              ${cls.icon}
            </div>
            <div class="token-body">
              <div class="token-name">${escapeHtml(cls.label)}${tx.success ? "" : ` <span style="color:var(--danger);font-weight:500;font-size:11px">· Failed</span>`}${tx.success && isLocalUnindexedTx(tx) ? ` <span style="color:var(--warning);font-weight:500;font-size:11px">· ${escapeHtml(localActivityStatusLabel(tx))}</span>` : ""}</div>
              <div class="token-sub">${escapeHtml(subtitle)}</div>
            </div>
            <div class="token-end">
              <div class="token-fiat" style="font-size:10px">${escapeHtml(when)}</div>
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════
   INLINE APPROVAL
   ═══════════════════════════════════════════════════════════ */

function approvalTone(
  kind: ApprovalView["kind"]
): "info" | "warning" | "danger" {
  switch (kind) {
    case "connect":
      return "info";
    case "watchAsset":
    case "signMessage":
      return "warning";
    case "sendCall":
    case "sendTransaction":
    case "signTransaction":
      return "danger";
  }
}

function approvalRiskLabel(kind: ApprovalView["kind"]): string {
  switch (kind) {
    case "connect":
      return "Connection";
    case "watchAsset":
      return "Asset";
    case "signMessage":
      return "Signature";
    case "signTransaction":
      return "Prepared signature";
    case "sendTransaction":
      return "Broadcast";
    case "sendCall":
      return "Contract call";
  }
}

type ApprovalDetailItem = NonNullable<ApprovalView["details"]>[number];

function splitFeeDetail(details: ApprovalDetailItem[]): {
  summaryDetails: ApprovalDetailItem[];
  feeDetail: ApprovalDetailItem | null;
} {
  const feeIndex = details.findIndex(
    (detail) => detail.label.toLowerCase() === "chi"
  );
  if (feeIndex < 0) {
    return { summaryDetails: details, feeDetail: null };
  }
  return {
    summaryDetails: [
      ...details.slice(0, feeIndex),
      ...details.slice(feeIndex + 1)
    ],
    feeDetail: details[feeIndex] ?? null
  };
}

function renderSummaryRow(
  label: string,
  value: string,
  options: { monospace?: boolean; title?: string } = {}
): string {
  const title = options.title ?? value;
  return `
    <div class="s-row">
      <span class="s-row-key">${escapeHtml(label)}</span>
      <span class="s-row-val ${options.monospace ? "mono" : ""}" title="${escapeAttribute(title)}">${escapeHtml(value)}</span>
    </div>
  `;
}

function renderTransactionFeeCard(value: string): string {
  return `
    <div class="s-card transaction-fee-card">
      <div class="s-card-head">
        <div><h3 class="s-card-title">Transaction fee</h3></div>
      </div>
      <div class="s-card-body">
        ${renderSummaryRow("Chi", value)}
      </div>
    </div>
  `;
}

function renderApprovalTrustOptions(view: ApprovalView): string {
  if (!view.trustSuggestion) {
    return "";
  }
  return `
    <div class="trust-options">
      <label class="surface trust-option">
        <input data-trust-inline="${escapeAttribute(view.id)}" type="checkbox" />
        <span class="trust-icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            <path d="m9 12 2 2 4-4"/>
          </svg>
        </span>
        <span class="trust-text">
          <strong>${escapeHtml(view.trustSuggestion.label)}</strong>
          <span class="muted">${escapeHtml(view.trustSuggestion.description)}</span>
        </span>
        <span class="trust-switch" aria-hidden="true"></span>
      </label>
      <label class="surface trust-option trust-option-danger">
        <input data-trust-broad-inline="${escapeAttribute(view.id)}" type="checkbox" />
        <span class="trust-icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <path d="M12 9v4"/>
            <path d="M12 17h.01"/>
          </svg>
        </span>
        <span class="trust-text">
          <strong>${escapeHtml(view.trustSuggestion.broadLabel)}</strong>
          <span class="muted">${escapeHtml(view.trustSuggestion.broadDescription)}</span>
        </span>
        <span class="trust-switch" aria-hidden="true"></span>
      </label>
    </div>
  `;
}

function renderBroadTrustConfirmationDialog(view: ApprovalView): string {
  if (!view.trustSuggestion) {
    return "";
  }
  return `
    <div class="app-dialog-backdrop" role="presentation">
      <div class="app-dialog" role="dialog" aria-modal="true" aria-labelledby="broad-trust-title">
        <div class="app-dialog-icon">${ICONS.alertTriangle}</div>
        <h3 id="broad-trust-title" class="app-dialog-title">Enable broad auto-approval?</h3>
        <p class="app-dialog-copy">${escapeHtml(view.trustSuggestion.broadWarning)}</p>
        <div class="app-dialog-value">${escapeHtml(view.trustSuggestion.broadLabel)}</div>
        <div class="app-dialog-actions">
          <button class="secondary" data-cancel-broad-trust>Cancel</button>
          <button class="danger" data-confirm-broad-trust="${escapeAttribute(view.id)}">Enable broad auto-approval</button>
        </div>
      </div>
    </div>
  `;
}

function renderApprovalInline(view: ApprovalView): string {
  const tone = approvalTone(view.kind);
  const warnings = view.warnings ?? [];
  const highlights = view.highlights ?? [];
  const { summaryDetails, feeDetail } = splitFeeDetail(view.details ?? []);

  return `
    <div class="settings-wrap">
      <button class="detail-back" data-close-approval>
        ${ICONS.chevronLeft} Back
      </button>

      <div class="s-card">
        <div class="s-card-head">
          <div>
            <h3 class="s-card-title">${escapeHtml(view.title)}</h3>
            <p class="s-card-desc">${escapeHtml(view.description)}</p>
          </div>
          <span class="pill pill-${tone}">${escapeHtml(approvalRiskLabel(view.kind))}</span>
        </div>
        <div class="s-card-body stack">
          ${
            warnings.length > 0
              ? `<div class="banner banner-${tone}">${warnings.map((w) => `<div>${escapeHtml(w)}</div>`).join("")}</div>`
              : ""
          }
          ${
            highlights.length > 0
              ? `<div style="display: flex; gap: 6px; flex-wrap: wrap">${highlights.map((h) => `<span class="pill">${escapeHtml(h)}</span>`).join("")}</div>`
              : ""
          }
          ${
            summaryDetails.length > 0
              ? summaryDetails
                  .map(
                    (d) => renderSummaryRow(d.label, d.value, { monospace: d.monospace })
                  )
                  .join("")
              : ""
          }
        </div>
      </div>

      ${feeDetail ? renderTransactionFeeCard(feeDetail.value) : ""}

      ${
        view.payload
          ? `
              <details class="disclosure">
                <summary>${escapeHtml(view.payloadLabel ?? "Raw payload")}</summary>
                <pre class="approval-payload">${escapeHtml(view.payload)}</pre>
              </details>
            `
          : ""
      }

      ${renderApprovalTrustOptions(view)}

      <div class="action-row" style="gap: 10px">
        <button class="full-width" data-approve-inline="${escapeAttribute(view.id)}">${escapeHtml(view.approveLabel ?? "Approve")}</button>
        <button class="secondary full-width" data-reject-inline="${escapeAttribute(view.id)}">Reject</button>
      </div>
      ${pendingBroadTrustApprovalId === view.id ? renderBroadTrustConfirmationDialog(view) : ""}
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════
   SEND TAB
   ═══════════════════════════════════════════════════════════ */

function renderSendTab(state: PopupRuntimeState): string {
  switch (sendStep) {
    case "draft":
      return sendMode === "simple"
        ? renderSimpleSend(state)
        : renderSendDraft();
    case "review":
      return renderSendReview();
    case "sending":
      return renderSendSending();
  }
}

function renderSimpleSend(state: PopupRuntimeState): string {
  if (editingContacts) {
    return renderContactsEditor();
  }

  const visibleTokens = visibleWatchedAssets(state);
  if (!visibleTokens.some((asset) => asset.contract === simpleToken)) {
    simpleToken =
      visibleTokens.find((asset) => asset.contract === "currency")?.contract ??
      visibleTokens[0]?.contract ??
      "currency";
  }
  const selectedAssetObj = state.watchedAssets.find((a) => a.contract === simpleToken);
  const tokenSymbol = selectedAssetObj?.symbol ?? simpleToken.slice(0, 6).toUpperCase();
  const tokenBalance = state.assetBalances[simpleToken] ?? "0";
  const displayBalance = formatSimpleBalance(tokenBalance);
  const tokenColor = simpleToken === "currency" ? "var(--accent-dim)" : assetGradient(simpleToken);

  return `
    <div class="settings-wrap">
      <div class="s-card">
        <div class="s-card-head">
          <div>
            <h3 class="s-card-title">Send</h3>
            <p class="s-card-desc">Transfer tokens to another address.</p>
          </div>
        </div>
        <div class="s-card-body stack">
          <label>
            Token
            <button type="button" class="token-chooser" data-toggle-token-picker>
              ${renderTokenIcon({
                contract: simpleToken,
                symbol: tokenSymbol,
                icon: selectedAssetObj?.icon ?? null,
                className: "token-chooser-icon",
                background: tokenColor,
                size: 28,
                fontSize: 13
              })}
              <span class="token-chooser-info">
                <span class="token-chooser-sym">${escapeHtml(tokenSymbol)}</span>
                <span class="token-chooser-name">${escapeHtml(selectedAssetObj?.name ?? simpleToken)}</span>
              </span>
              ${ICONS.chevronDown}
            </button>
            <input type="hidden" id="simple-token" value="${escapeAttribute(simpleToken)}" />
          </label>
          ${showTokenPicker ? `
            <div class="token-picker-list">
              ${visibleTokens.map((a) => {
                const s = a.symbol ?? a.contract.slice(0, 6);
                const c = a.contract === "currency" ? "var(--accent-dim)" : assetGradient(a.contract);
                const active = a.contract === simpleToken;
                return `
                  <button type="button" class="token-picker-item ${active ? "is-active" : ""}" data-pick-token="${escapeAttribute(a.contract)}">
                    ${renderTokenIcon({
                      contract: a.contract,
                      symbol: s,
                      icon: a.icon ?? null,
                      className: "token-chooser-icon",
                      background: c,
                      size: 28,
                      fontSize: 13
                    })}
                    <span class="token-chooser-info">
                      <span class="token-chooser-sym">${escapeHtml(s)}</span>
                      <span class="token-chooser-name">${escapeHtml(a.name ?? a.contract)}</span>
                    </span>
                  </button>
                `;
              }).join("")}
            </div>
          ` : ""}
          <label>
            Recipient
            <div class="input-with-icon">
              <input id="simple-to" value="${escapeAttribute(simpleTo)}" placeholder="Wallet address" />
              ${contacts.length > 0 ? `<button type="button" class="input-icon-btn" data-toggle-contacts title="Contacts">${ICONS.contacts}</button>` : ""}
            </div>
          </label>
          ${showContactPicker ? renderContactList() : ""}
          <label>
            Amount
            <div class="input-with-icon">
              <input id="simple-amount" type="number" min="0" step="any" value="${escapeAttribute(simpleAmount)}" placeholder="0.00" />
              <button type="button" class="input-icon-btn max-badge" data-max-amount title="Use max balance">MAX</button>
            </div>
            <span class="muted text-sm">Available: ${escapeHtml(displayBalance)} ${escapeHtml(tokenSymbol)}</span>
          </label>
        </div>
      </div>

      <button class="full-width" data-review-simple ${simpleReviewLoading ? "disabled" : ""}>
        ${simpleReviewLoading ? `<span class="btn-spinner"></span> Estimating...` : "Review"}
      </button>
      <div class="send-footer-links">
        <button class="send-footer-link" data-switch-advanced>Advanced transaction</button>
        <button class="send-footer-link" data-edit-contacts>${contacts.length > 0 ? "Manage contacts" : "Add contacts"}</button>
      </div>
    </div>
  `;
}

async function reviewSimpleSend(
  state: PopupRuntimeState,
  options: { confirmedUnrecognized?: boolean } = {}
): Promise<void> {
  if (simpleReviewLoading) {
    return;
  }
  if (await reconcileLockedState()) {
    return;
  }
  const activeState = currentState?.unlocked ? currentState : state;
  if (!simpleTo) {
    setFlash("Recipient address is required.", "warning");
    render(activeState);
    return;
  }
  if (simpleTo === activeState.publicKey) {
    setFlash("You can't send tokens to your own address.", "warning");
    render(activeState);
    return;
  }
  if (
    !options.confirmedUnrecognized &&
    !isRecognizedXianRecipient(simpleTo)
  ) {
    pendingUnrecognizedRecipient = simpleTo;
    render(activeState);
    return;
  }

  const amount = parseRuntimeNumberInput(simpleAmount);
  if (amount == null || !isPositiveRuntimeAmount(amount)) {
    setFlash("Enter a valid amount.", "warning");
    render(activeState);
    return;
  }

  pendingUnrecognizedRecipient = null;
  sendContract = simpleToken;
  sendFunction = "transfer";
  sendParsedKwargs = { to: simpleTo, amount };
  sendEstimateMode = true;
  simpleReviewLoading = true;
  const requestId = ++simpleReviewRequestId;
  clearFlash();
  render(activeState);

  const timeout = setTimeout(() => {
    if (requestId !== simpleReviewRequestId) {
      return;
    }
    simpleReviewRequestId++;
    simpleReviewLoading = false;
    setFlash("Estimation timed out. Try again.", "warning");
    render(activeState);
  }, 15000);

  try {
    [sendEstimate, sendChiRate] = await Promise.all([
      sendRuntimeMessage<{ estimated: number }>({
        type: "wallet_estimate_transaction",
        contract: sendContract,
        function: sendFunction,
        kwargs: sendParsedKwargs
      }),
      sendRuntimeMessage<number | null>({ type: "wallet_get_chi_rate" }),
    ]);
    if (requestId !== simpleReviewRequestId) {
      return;
    }
    if (await reconcileLockedState()) {
      clearTimeout(timeout);
      simpleReviewLoading = false;
      return;
    }
    clearTimeout(timeout);
    simpleReviewLoading = false;
    sendStep = "review";
    render(currentState?.unlocked ? currentState : activeState);
  } catch (error) {
    if (requestId !== simpleReviewRequestId) {
      return;
    }
    clearTimeout(timeout);
    simpleReviewLoading = false;
    if (await reconcileLockedState()) {
      return;
    }
    setFlash(formatError(error), "danger");
    render(currentState?.unlocked ? currentState : activeState);
  }
}

function formatSimpleBalance(raw: string): string {
  const n = Number(raw);
  if (Number.isNaN(n)) return "0";
  if (n === Math.floor(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 });
}

function renderContactList(): string {
  if (contacts.length === 0) {
    return `<p class="muted text-sm">No contacts saved yet.</p>`;
  }
  return `
    <div class="contact-list" style="max-height: ${Math.min(contacts.length, 5) * 40}px; overflow-y: auto">
      ${contacts
        .map(
          (c) => `
            <button type="button" class="contact-item" data-pick-contact="${escapeAttribute(c.address)}">
              <span class="contact-name">${escapeHtml(c.name)}</span>
              <span class="contact-addr mono">${escapeHtml(truncateHash(c.address, 8, 6))}</span>
            </button>
          `
        )
        .join("")}
    </div>
  `;
}

function renderContactsEditor(): string {
  return `
    <div class="settings-wrap">
      <button class="detail-back" data-close-contacts-editor>${ICONS.chevronLeft} Back</button>

      <div class="s-card">
        <div class="s-card-head">
          <div>
            <h3 class="s-card-title">Contacts</h3>
            <p class="s-card-desc">Saved recipient addresses.</p>
          </div>
        </div>
        <div class="s-card-body stack">
          ${
            contacts.length === 0
              ? `<p class="muted text-sm">No contacts yet.</p>`
              : contacts
                  .map(
                    (c) => `
                      <div class="contact-edit-row">
                        <div style="flex: 1; min-width: 0">
                          <div class="text-sm">${escapeHtml(c.name)}</div>
                          <div class="muted text-sm mono" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">${escapeHtml(c.address)}</div>
                        </div>
                        ${
                          confirmDeleteContactId === c.id
                            ? `<button class="ghost-sm" data-confirm-delete-contact="${escapeAttribute(c.id)}" style="color: var(--danger); font-weight: 600">Remove?</button>
                               <button class="ghost-sm" data-cancel-delete-contact>Cancel</button>`
                            : `<button class="ghost-sm" data-delete-contact="${escapeAttribute(c.id)}" title="Remove contact">×</button>`
                        }
                      </div>
                    `
                  )
                  .join("")
          }
        </div>
      </div>

      ${
        pendingContact
          ? `
            <div class="s-card">
              <div class="s-card-body stack">
                <div class="banner banner-warning">This doesn't look like a valid Xian address (expected 64-character hex). Save anyway?</div>
                <div style="display: flex; gap: 8px">
                  <button class="secondary full-width" data-confirm-contact>Save anyway</button>
                  <button class="ghost full-width" data-cancel-contact>Cancel</button>
                </div>
              </div>
            </div>
          `
          : `
            <form id="add-contact-form" class="s-card">
              <div class="s-card-head">
                <div>
                  <h3 class="s-card-title">New contact</h3>
                </div>
              </div>
              <div class="s-card-body stack">
                <label>Name <input id="contact-name" required placeholder="e.g. Alice" /></label>
                <label>Address <input id="contact-address" required placeholder="Wallet address" /></label>
                <button type="submit" class="secondary full-width">Save contact</button>
              </div>
            </form>
          `
      }
    </div>
  `;
}

function renderArgValueInput(arg: TxArg): string {
  switch (arg.type) {
    case "bool":
      return `<select class="arg-value"><option value="true" ${arg.value === "true" ? "selected" : ""}>true</option><option value="false" ${arg.value !== "true" ? "selected" : ""}>false</option></select>`;
    case "datetime":
      return `<input type="datetime-local" class="arg-value" value="${escapeAttribute(arg.value)}" />`;
    case "timedelta":
      return `<input type="number" class="arg-value" value="${escapeAttribute(arg.value)}" placeholder="seconds" />`;
    case "dict":
      return `<input class="arg-value" value="${escapeAttribute(arg.value)}" placeholder='{"key": "value"}' />`;
    case "list":
      return `<input class="arg-value" value="${escapeAttribute(arg.value)}" placeholder='[1, 2, 3]' />`;
    default:
      return `<input class="arg-value" value="${escapeAttribute(arg.value)}" placeholder="value" />`;
  }
}

const ARG_TYPE_OPTIONS: TxArgType[] = [
  "str",
  "int",
  "float",
  "bool",
  "dict",
  "list",
  "datetime",
  "timedelta",
  "Any"
];

function renderArgRow(arg: TxArg): string {
  const nameAttrs = arg.fixed ? "readonly" : "";
  const typeAttrs = arg.typeFixed ? "disabled" : "";
  const typeOptions = ARG_TYPE_OPTIONS.map(
    (t) =>
      `<option value="${t}" ${arg.type === t ? "selected" : ""}>${t}</option>`
  ).join("");

  return `
    <div class="arg-row" data-arg-id="${escapeAttribute(arg.id)}">
      <input class="arg-name" value="${escapeAttribute(arg.name)}" placeholder="name" ${nameAttrs} />
      ${renderArgValueInput(arg)}
      <select class="arg-type" ${typeAttrs}>${typeOptions}</select>
      ${arg.fixed ? "" : `<button class="ghost-sm" data-remove-arg="${escapeAttribute(arg.id)}">×</button>`}
    </div>
  `;
}

function renderFunctionSelect(): string {
  const hasContract = sendContract.length > 0;
  const disabled =
    !hasContract || contractMethodsLoading ? "disabled" : "";
  const loadingHint = contractMethodsLoading
    ? `<p class="muted text-sm">Loading functions...</p>`
    : contractMethodsError
      ? `<p class="muted text-sm" style="color: var(--danger)">${escapeHtml(contractMethodsError)}</p>`
      : !hasContract
        ? `<p class="muted text-sm">Enter a contract name first.</p>`
        : "";

  if (contractMethods.length > 0) {
    const options = contractMethods
      .map(
        (m) =>
          `<option value="${escapeAttribute(m.name)}" ${m.name === sendFunction ? "selected" : ""}>${escapeHtml(m.name)}</option>`
      )
      .join("");
    return `
      <label>
        Function
        <select id="send-function" ${disabled}>
          <option value="">Select a function</option>
          ${options}
        </select>
      </label>
      ${loadingHint}
    `;
  }

  return `
    <label>
      Function
      <select id="send-function" ${disabled}>
        <option value="">${contractMethodsLoading ? "Loading..." : hasContract ? "No transaction functions loaded" : "Enter contract first"}</option>
        ${sendFunction ? `<option value="${escapeAttribute(sendFunction)}" selected>${escapeHtml(sendFunction)}</option>` : ""}
      </select>
    </label>
    ${loadingHint}
  `;
}

function renderSendDraft(): string {
  return `
    <div class="settings-wrap">
      <button class="detail-back" data-switch-simple>${ICONS.chevronLeft} Simple send</button>
      <div class="s-card">
        <div class="s-card-head">
          <div>
            <h3 class="s-card-title">Contract call</h3>
            <p class="s-card-desc">Specify the contract and function to invoke.</p>
          </div>
        </div>
        <div class="s-card-body stack">
          <label>
            Contract
            <input id="send-contract" value="${escapeAttribute(sendContract)}" placeholder="e.g. currency" />
          </label>
          ${renderFunctionSelect()}
        </div>
      </div>

      <div class="s-card">
        <div class="s-card-head">
          <div>
            <h3 class="s-card-title">Arguments</h3>
            <p class="s-card-desc">Key-value pairs passed as kwargs.</p>
          </div>
        </div>
        <div class="s-card-body">
          ${
            sendArgs.length === 0
              ? `<p class="muted text-sm">No arguments added yet.</p>`
              : sendArgs.map((a) => renderArgRow(a)).join("")
          }
        </div>
      </div>

      <div class="s-card">
        <div class="s-card-head">
          <div>
            <h3 class="s-card-title">Chi</h3>
            <p class="s-card-desc">Transaction cost budget.</p>
          </div>
        </div>
        <div class="s-card-body stack">
          <label class="inline-check">
            <input type="radio" name="chi-mode" value="estimate" ${sendEstimateMode ? "checked" : ""} data-chi-mode="estimate" />
            <span>Estimate automatically</span>
          </label>
          <label class="inline-check">
            <input type="radio" name="chi-mode" value="manual" ${!sendEstimateMode ? "checked" : ""} data-chi-mode="manual" />
            <span>Set manually</span>
          </label>
          ${
            !sendEstimateMode
              ? `<label>Chi limit<input id="send-chi" type="number" min="1" value="${escapeAttribute(sendManualChi)}" placeholder="e.g. 50000" /></label>`
              : ""
          }
        </div>
      </div>

      <button class="full-width" data-review-tx>Review Transaction</button>
    </div>
  `;
}

function renderSendReview(): string {
  const entries = sendParsedKwargs ? Object.entries(sendParsedKwargs) : [];
  const chiNum = sendEstimate
    ? sendEstimate.estimated
    : Number(sendManualChi);
  const chiLabel = formatChiWithXianCost(chiNum, sendChiRate) ?? "Not provided";
  const argumentRows = entries
    .map(([k, v]) => {
      const formatted = formatTxArgValue(v);
      return renderSummaryRow(k, formatted);
    })
    .join("");
  const argumentsHtml = entries.length > 0
    ? `
        <div class="s-section-label">Arguments</div>
        ${argumentRows}
      `
    : `
        <div class="s-section-label">Arguments</div>
        <div class="s-empty-row">No arguments</div>
      `;

  return `
    <div class="settings-wrap">
      <button class="detail-back" data-edit-tx>${ICONS.chevronLeft} Edit</button>

      <div class="s-card">
        <div class="s-card-head">
          <div><h3 class="s-card-title">Transaction summary</h3></div>
        </div>
        <div class="s-card-body">
          ${renderSummaryRow("Contract", sendContract)}
          ${renderSummaryRow("Function", sendFunction)}
          ${argumentsHtml}
        </div>
      </div>

      ${renderTransactionFeeCard(chiLabel)}

      <button class="full-width" data-send-tx>Send Transaction</button>
    </div>
  `;
}

function renderSendSending(): string {
  return `
    <div class="send-centered">
      <div class="spinner"></div>
      <p class="muted text-sm">Sending transaction...</p>
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════
   TRADE TAB
   ═══════════════════════════════════════════════════════════ */

function formatTradeNumber(value: number, maxDecimals = 6): string {
  if (!Number.isFinite(value)) return "0";
  if (value === 0) return "0";
  const abs = Math.abs(value);
  const decimals =
    abs >= 1000
      ? Math.min(2, maxDecimals)
      : abs >= 1
        ? Math.min(4, maxDecimals)
        : abs >= 0.0001
          ? Math.min(6, maxDecimals)
          : Math.min(8, maxDecimals);
  return value.toLocaleString(undefined, {
    maximumFractionDigits: decimals,
    minimumFractionDigits: 0
  });
}

function formatTradePercent(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(decimals)}%`;
}

function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
}

function normalizeTradeSelection(): void {
  const tokens = sortedDexTokens(tradeSnapshot);
  if (tokens.length === 0) {
    return;
  }
  if (!tokens.some((token) => token.contract === tradeFromToken)) {
    tradeFromToken =
      tokens.find((token) => token.contract === "currency")?.contract ??
      tokens[0]!.contract;
  }
  if (
    !tradeToToken ||
    tradeToToken === tradeFromToken ||
    !tokens.some((token) => token.contract === tradeToToken)
  ) {
    tradeToToken =
      tokens.find((token) => token.contract !== tradeFromToken)?.contract ?? "";
  }
}

function currentTradeQuote(): {
  quote: DexQuote | null;
  error: string | null;
} {
  if (!tradeSnapshot?.available) {
    return { quote: null, error: null };
  }
  const amount = Number(tradeAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { quote: null, error: null };
  }
  if (!tradeFromToken || !tradeToToken) {
    return { quote: null, error: "Select both tokens." };
  }
  if (tradeFromToken === tradeToToken) {
    return { quote: null, error: "Tokens must differ." };
  }
  const quote = buildDexQuote(
    tradeSnapshot,
    tradeFromToken,
    tradeToToken,
    amount
  );
  return quote
    ? { quote, error: null }
    : { quote: null, error: "No route exists between these tokens." };
}

function renderTradeTokenButton(
  side: TradeTokenSide,
  token: WalletDexTokenInfo | null,
  selectedContract: string
): string {
  const symbol = tokenSymbol(token);
  const label = token
    ? symbol
    : "Select token";
  return `
    <button
      type="button"
      class="trade-token-button"
      data-toggle-trade-token-picker="${side}"
      aria-expanded="${tradeTokenPicker === side ? "true" : "false"}"
    >
      <span class="trade-token-button-label">${escapeHtml(label)}</span>
      ${ICONS.chevronDown}
    </button>
    <input type="hidden" id="trade-${side}" value="${escapeAttribute(selectedContract)}" />
  `;
}

function renderTradeTokenPicker(
  side: TradeTokenSide,
  selectedContract: string,
  exclude?: string
): string {
  if (tradeTokenPicker !== side) {
    return "";
  }
  const tokens = sortedDexTokens(tradeSnapshot).filter(
    (token) => token.contract !== exclude
  );
  if (tokens.length === 0) {
    return `
      <div class="token-picker-list trade-token-picker-list">
        <div class="trade-token-picker-empty text-sm">No tokens available.</div>
      </div>
    `;
  }
  return `
    <div class="token-picker-list trade-token-picker-list">
      ${tokens.map((token) => {
      const symbol = tokenSymbol(token);
      const active = token.contract === selectedContract;
      return `
        <button
          type="button"
          class="token-picker-item ${active ? "is-active" : ""}"
          data-pick-trade-token="${side}"
          data-contract="${escapeAttribute(token.contract)}"
        >
          ${renderTokenIcon({
            contract: token.contract,
            symbol,
            icon: token.logoSvg ?? token.logoUrl,
            className: "token-chooser-icon",
            background: token.contract === "currency" ? "var(--accent-dim)" : assetGradient(token.contract),
            size: 28,
            fontSize: 13
          })}
          <span class="token-chooser-info">
            <span class="token-chooser-sym">${escapeHtml(symbol)}</span>
            <span class="token-chooser-name">${escapeHtml(token.name ?? token.contract)}</span>
          </span>
        </button>
      `;
      }).join("")}
    </div>
  `;
}

function renderTradeRoute(quote: DexQuote): string {
  const contracts = [
    quote.hops[0]?.fromToken,
    ...quote.hops.map((hop) => hop.toToken)
  ].filter((contract): contract is string => Boolean(contract));
  return contracts
    .map((contract, index) => {
      const token = tokenByContract(tradeSnapshot, contract);
      return `
        <span class="trade-route-step">
          <span>${escapeHtml(tokenSymbol(token) || contract.slice(0, 6))}</span>
          ${index < contracts.length - 1 ? `<span class="trade-route-arrow">›</span>` : ""}
        </span>
      `;
    })
    .join("");
}

function renderTradeQuoteSummary(quote: DexQuote): string {
  if (!tradeSnapshot) {
    return "";
  }
  const fromToken = tokenByContract(tradeSnapshot, tradeFromToken);
  const toToken = tokenByContract(tradeSnapshot, tradeToToken);
  const minOut = minReceived(quote, tradeSlippageBps);
  const priceImpactPct = quote.priceImpact * 100;
  const priceImpactClass =
    priceImpactPct >= 5 ? "danger" : priceImpactPct >= 1.5 ? "warning" : "muted";
  const blocked = blockedIntermediateToken(tradeSnapshot, quote);
  const useSupporting = useSupportingFeeRoute(tradeSnapshot, quote);

  return `
    <div class="trade-summary">
      ${renderSummaryRow("Rate", `1 ${tokenSymbol(fromToken)} ≈ ${formatTradeNumber(quote.amountOut / Math.max(quote.amountIn, 1e-12))} ${tokenSymbol(toToken)}`)}
      ${renderSummaryRow(`Min received (${formatBps(tradeSlippageBps)} slippage)`, `${formatTradeNumber(minOut)} ${tokenSymbol(toToken)}`)}
      ${renderSummaryRow("Price impact", formatTradePercent(-priceImpactPct, 2), { title: `${priceImpactPct.toFixed(4)}%` }).replace("s-row-val", `s-row-val ${priceImpactClass}`)}
      ${renderSummaryRow("DEX fee", formatBps(quote.feeBps))}
      <div class="s-row">
        <span class="s-row-key">Route</span>
        <span class="s-row-val trade-route">${renderTradeRoute(quote)}</span>
      </div>
      ${quote.hops.length > 1 ? `<div class="banner banner-info text-sm">${quote.hops.length} hops · best route auto-selected.</div>` : ""}
      ${useSupporting ? `<div class="banner banner-warning text-sm">Using fee-on-transfer compatible route.</div>` : ""}
      ${blocked ? `<div class="banner banner-danger text-sm">Route unavailable: intermediate token ${escapeHtml(blocked)} is fee-on-transfer.</div>` : ""}
      ${priceImpactPct >= 5 ? `<div class="banner banner-danger text-sm">Price impact is high. Consider a smaller trade.</div>` : ""}
    </div>
  `;
}

function renderTradeTab(state: PopupRuntimeState): string {
  if (tradeStep === "approving") {
    return renderTradeBusy("Approving token...");
  }
  if (tradeStep === "swapping") {
    return renderTradeBusy("Sending swap...");
  }
  if (tradeStep === "review") {
    return renderTradeReview(state);
  }
  return renderTradeForm(state);
}

function renderTradeForm(state: PopupRuntimeState): string {
  if (dexAvailabilityStatus !== "available") {
    void ensureDexAvailability(state);
    return `
      <div class="settings-wrap">
        <button class="detail-back" data-back-home>${ICONS.chevronLeft} Home</button>
        <div class="s-card">
          <div class="s-card-head">
            <div>
              <h3 class="s-card-title">Swap</h3>
              <p class="s-card-desc">Swap tokens when the DEX is deployed on this network.</p>
            </div>
          </div>
          <div class="s-card-body stack">
            ${
              dexAvailabilityStatus === "checking"
                ? `<div class="send-centered"><div class="spinner"></div><p class="muted text-sm">Checking DEX availability...</p></div>`
                : `<div class="banner banner-warning">${escapeHtml(dexAvailabilityError ?? "DEX is not deployed on this network yet.")}</div>`
            }
          </div>
        </div>
      </div>
    `;
  }

  if (
    !tradeSnapshotLoading &&
    (!tradeSnapshot || tradeSnapshotNetworkKey !== dexNetworkKey(state))
  ) {
    void loadTradeSnapshot(state);
  }
  normalizeTradeSelection();

  const tokens = sortedDexTokens(tradeSnapshot);
  const fromToken = tokenByContract(tradeSnapshot, tradeFromToken);
  const toToken = tokenByContract(tradeSnapshot, tradeToToken);
  const { quote, error: quoteError } = currentTradeQuote();
  const blocked = tradeSnapshot && quote ? blockedIntermediateToken(tradeSnapshot, quote) : null;
  const needsApproval =
    Boolean(fromToken && quote && fromToken.allowance < quote.amountIn);
  const insufficient =
    Boolean(fromToken && quote && fromToken.balance < quote.amountIn);
  const canReview =
    Boolean(quote && !blocked && !needsApproval && !insufficient);
  const approvalNotice =
    tradeApprovalNotice && canReview
      ? `<div class="banner banner-success text-sm">${escapeHtml(tradeApprovalNotice)}</div>`
      : "";
  const primaryLabel = tradeSnapshotLoading
    ? "Loading markets..."
    : tokens.length < 2
      ? "No trade tokens"
      : !quote
        ? "Enter amount"
        : insufficient
          ? `Insufficient ${tokenSymbol(fromToken)}`
          : blocked
            ? "Route unavailable"
            : needsApproval
              ? `Approve ${tokenSymbol(fromToken)}`
              : "Review Swap";

  return `
    <div class="settings-wrap trade-wrap">
      <button class="detail-back" data-back-home>${ICONS.chevronLeft} Home</button>

      <div class="s-card trade-card">
        <div class="s-card-head">
          <div>
            <h3 class="s-card-title">Swap</h3>
            <p class="s-card-desc">Swap through ${escapeHtml(DEX_ROUTER)} on ${escapeHtml(state.activeNetworkName ?? "this network")}.</p>
          </div>
          <button class="icon-action" data-refresh-trade title="Refresh markets">${ICONS.repeat}</button>
        </div>
        <div class="s-card-body stack">
          ${tradeSnapshotError ? `<div class="banner banner-warning">${escapeHtml(tradeSnapshotError)}</div>` : ""}
          ${approvalNotice}
          <div class="trade-panel">
            <div class="trade-panel-top">
              <span class="muted text-sm">From</span>
              ${fromToken ? `<span class="muted text-sm">Balance: <strong>${escapeHtml(formatTradeNumber(fromToken.balance))}</strong> <button class="send-footer-link trade-max" data-trade-max>MAX</button></span>` : ""}
            </div>
            <div class="trade-panel-body">
              <input id="trade-amount" class="trade-amount-input" type="text" inputmode="decimal" autocomplete="off" value="${escapeAttribute(tradeAmount)}" placeholder="0.00" />
              ${renderTradeTokenButton("from", fromToken, tradeFromToken)}
            </div>
            ${renderTradeTokenPicker("from", tradeFromToken, tradeToToken)}
          </div>

          <button class="trade-flip" data-trade-flip title="Flip tokens">${ICONS.repeat}</button>

          <div class="trade-panel">
            <div class="trade-panel-top">
              <span class="muted text-sm">To</span>
              ${toToken ? `<span class="muted text-sm">Balance: <strong>${escapeHtml(formatTradeNumber(toToken.balance))}</strong></span>` : ""}
            </div>
            <div class="trade-panel-body">
              <input class="trade-amount-input" value="${quote ? escapeAttribute(formatTradeNumber(quote.amountOut)) : ""}" placeholder="0.00" readonly />
              ${renderTradeTokenButton("to", toToken, tradeToToken)}
            </div>
            ${renderTradeTokenPicker("to", tradeToToken, tradeFromToken)}
          </div>

          <div class="trade-settings">
            <label>
              Slippage
              <select id="trade-slippage">
                ${[50, 100, 300, 500].map((bps) => `<option value="${bps}" ${bps === tradeSlippageBps ? "selected" : ""}>${formatBps(bps)}</option>`).join("")}
              </select>
            </label>
            <label>
              Deadline
              <select id="trade-deadline">
                ${[10, 20, 30, 60].map((minutes) => `<option value="${minutes}" ${minutes === tradeDeadlineMinutes ? "selected" : ""}>${minutes} min</option>`).join("")}
              </select>
            </label>
          </div>

          ${tradeSnapshotLoading ? `<div class="send-centered"><div class="spinner"></div><p class="muted text-sm">Loading markets...</p></div>` : ""}
          ${quoteError ? `<div class="banner banner-warning text-sm">${escapeHtml(quoteError)}</div>` : ""}
          ${quote ? renderTradeQuoteSummary(quote) : ""}
        </div>
      </div>

      <button class="full-width" ${canReview || needsApproval ? (tradeSnapshotLoading ? "disabled" : "") : "disabled"} ${needsApproval ? "data-approve-trade" : "data-review-trade"}>
        ${primaryLabel}
      </button>
    </div>
  `;
}

function renderTradeReview(state: PopupRuntimeState): string {
  if (!tradeSnapshot || !tradeQuoteForReview || !tradeKwargsForReview) {
    tradeStep = "form";
    return renderTradeForm(state);
  }
  const fromToken = tokenByContract(tradeSnapshot, tradeFromToken);
  const toToken = tokenByContract(tradeSnapshot, tradeToToken);
  const quote = tradeQuoteForReview;
  const minOut = Number(tradeKwargsForReview.amountOutMin);
  const chiLabel = tradeEstimate
    ? formatChiWithXianCost(tradeEstimate.estimated, tradeChiRate) ?? "Not available"
    : "Not available";
  const fn =
    tradeKwargsForReview.path instanceof Array && tradeKwargsForReview.path.length > 0
      ? tradeSnapshot && useSupportingFeeRoute(tradeSnapshot, quote)
        ? "swapExactTokensForTokensSupportingFeeOnTransferTokens"
        : "swapExactTokensForTokens"
      : "swapExactTokensForTokens";

  return `
    <div class="settings-wrap">
      <button class="detail-back" data-edit-trade>${ICONS.chevronLeft} Edit</button>

      <div class="s-card">
        <div class="s-card-head">
          <div><h3 class="s-card-title">Swap summary</h3></div>
        </div>
        <div class="s-card-body">
          ${renderSummaryRow("From", `${formatTradeNumber(quote.amountIn)} ${tokenSymbol(fromToken)}`)}
          ${renderSummaryRow("To", `~${formatTradeNumber(quote.amountOut)} ${tokenSymbol(toToken)}`)}
          ${renderSummaryRow("Minimum received", `${formatTradeNumber(minOut)} ${tokenSymbol(toToken)}`)}
          ${renderSummaryRow("Price impact", formatTradePercent(-(quote.priceImpact * 100), 2))}
          <div class="s-section-label">Route</div>
          <div class="s-row">
            <span class="s-row-key">Path</span>
            <span class="s-row-val trade-route">${renderTradeRoute(quote)}</span>
          </div>
          <div class="s-section-label">Transaction</div>
          ${renderSummaryRow("Contract", DEX_ROUTER)}
          ${renderSummaryRow("Function", fn)}
        </div>
      </div>

      ${renderTransactionFeeCard(chiLabel)}

      <button class="full-width" data-send-trade>Send Swap</button>
    </div>
  `;
}

function renderTradeBusy(label: string): string {
  return `
    <div class="send-centered">
      <div class="spinner"></div>
      <p class="muted text-sm">${escapeHtml(label)}</p>
    </div>
  `;
}

function captureTradeFormState(): void {
  const amount = root.querySelector<HTMLInputElement>("#trade-amount");
  const from = root.querySelector<HTMLInputElement | HTMLSelectElement>("#trade-from");
  const to = root.querySelector<HTMLInputElement | HTMLSelectElement>("#trade-to");
  const slippage = root.querySelector<HTMLSelectElement>("#trade-slippage");
  const deadline = root.querySelector<HTMLSelectElement>("#trade-deadline");
  if (amount) tradeAmount = amount.value.trim();
  if (from) tradeFromToken = from.value;
  if (to) tradeToToken = to.value;
  if (slippage) {
    const parsed = Number(slippage.value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      tradeSlippageBps = parsed;
    }
  }
  if (deadline) {
    const parsed = Number(deadline.value);
    if (Number.isFinite(parsed) && parsed > 0) {
      tradeDeadlineMinutes = parsed;
    }
  }
}

function renderPreservingTradeAmountFocus(state: PopupRuntimeState): void {
  const input = root.querySelector<HTMLInputElement>("#trade-amount");
  const shouldRestore = document.activeElement === input;
  const start = shouldRestore ? input?.selectionStart ?? input?.value.length ?? null : null;
  const end = shouldRestore ? input?.selectionEnd ?? input?.value.length ?? null : null;

  render(state);

  if (!shouldRestore) {
    return;
  }
  const nextInput = root.querySelector<HTMLInputElement>("#trade-amount");
  if (!nextInput) {
    return;
  }
  nextInput.focus({ preventScroll: true });
  if (start == null || end == null) {
    return;
  }
  const nextLength = nextInput.value.length;
  try {
    nextInput.setSelectionRange(
      Math.min(start, nextLength),
      Math.min(end, nextLength)
    );
  } catch {
    // Some embedded browser inputs do not support selection restoration.
  }
}

function tradeSwapFunction(snapshot: WalletDexSnapshotRuntimeResult, quote: DexQuote): string {
  return useSupportingFeeRoute(snapshot, quote)
    ? "swapExactTokensForTokensSupportingFeeOnTransferTokens"
    : "swapExactTokensForTokens";
}

function buildTradeSwapKwargs(
  state: PopupRuntimeState,
  quote: DexQuote
): Record<string, unknown> {
  return {
    amountIn:
      runtimeFixedFromString(tradeAmount) ??
      runtimeFixedFromNumber(quote.amountIn),
    amountOutMin: runtimeFixedFromNumber(
      minReceived(quote, tradeSlippageBps),
      { floor: true }
    ),
    path: quote.path,
    src: tradeFromToken,
    to: state.publicKey,
    deadline: deadlineFromNow(tradeDeadlineMinutes)
  };
}

async function handleTradeApproval(state: PopupRuntimeState): Promise<void> {
  captureTradeFormState();
  if (await reconcileLockedState()) {
    return;
  }
  if (!tradeSnapshot?.available) {
    setFlash("DEX market data is not loaded.", "warning");
    render(state);
    return;
  }
  const { quote } = currentTradeQuote();
  if (!quote) {
    setFlash("Enter a valid trade amount.", "warning");
    render(state);
    return;
  }

  const kwargs = {
    amount:
      runtimeFixedFromString(tradeAmount) ??
      runtimeFixedFromNumber(quote.amountIn),
    to: DEX_ROUTER
  };
  const notificationState = currentState?.unlocked ? currentState : state;
  tradeStep = "approving";
  clearFlash();
  render(notificationState);
  try {
    const result = await sendRuntimeMessage<
      SendTransactionResult & Record<string, unknown>
    >({
      type: "wallet_send_direct_transaction",
      contract: tradeFromToken,
      function: "approve",
      kwargs
    });
    const { txHash, generation, sentFlashShown } =
      showSubmittedTransactionFlash(notificationState, result, {
        sent: "Approval transaction sent."
      });
    const receipt = result.receipt ?? null;
    const execution =
      receipt && typeof receipt === "object"
        ? (receipt as Record<string, unknown>).execution
        : null;
    applyReceiptStateWrites(execution);

    if (transactionAccepted(result)) {
      if (txHash) {
        void recordLocalActivityTx(notificationState, txHash, result, {
          contract: tradeFromToken,
          function: "approve",
          kwargs
        });
      }
      refreshActivityAfterTransaction(notificationState, txHash);
      tradeStep = "form";
      tradeApprovalNotice =
        "Approval complete. Review and send the swap to complete the trade.";
      await loadTradeSnapshot(notificationState, { force: true });
    } else {
      tradeStep = "form";
      tradeApprovalNotice = null;
      render(currentState?.unlocked ? currentState : notificationState);
    }
    scheduleTransactionStatusFlash(
      notificationState,
      result,
      generation,
      sentFlashShown ? 1600 : 0,
      {
        finalized: "Approval finalized. Review and send the swap.",
        accepted: "Approval accepted. Review and send the swap.",
        failed: "Approval failed."
      }
    );
  } catch (error) {
    tradeStep = "form";
    tradeApprovalNotice = null;
    if (await reconcileLockedState()) {
      return;
    }
    setFlash(formatError(error), "danger");
    render(currentState?.unlocked ? currentState : notificationState);
  }
}

async function handleTradeReview(state: PopupRuntimeState): Promise<void> {
  captureTradeFormState();
  if (await reconcileLockedState()) {
    return;
  }
  if (!tradeSnapshot?.available) {
    await loadTradeSnapshot(state, { force: true });
  }
  if (!tradeSnapshot?.available) {
    setFlash(tradeSnapshotError ?? "DEX market data is not loaded.", "warning");
    render(currentState?.unlocked ? currentState : state);
    return;
  }

  const { quote, error } = currentTradeQuote();
  if (!quote) {
    setFlash(error ?? "Enter a valid trade amount.", "warning");
    render(currentState?.unlocked ? currentState : state);
    return;
  }
  const fromToken = tokenByContract(tradeSnapshot, tradeFromToken);
  if (fromToken && fromToken.balance < quote.amountIn) {
    setFlash(`Insufficient ${tokenSymbol(fromToken)} balance.`, "warning");
    render(currentState?.unlocked ? currentState : state);
    return;
  }
  if (fromToken && fromToken.allowance < quote.amountIn) {
    setFlash(`Approve ${tokenSymbol(fromToken)} first.`, "warning");
    render(currentState?.unlocked ? currentState : state);
    return;
  }
  const blocked = blockedIntermediateToken(tradeSnapshot, quote);
  if (blocked) {
    setFlash(`Route unavailable: ${blocked} is fee-on-transfer.`, "warning");
    render(currentState?.unlocked ? currentState : state);
    return;
  }

  const fn = tradeSwapFunction(tradeSnapshot, quote);
  const kwargs = buildTradeSwapKwargs(state, quote);
  tradeQuoteForReview = quote;
  tradeKwargsForReview = kwargs;
  tradeEstimate = null;
  tradeChiRate = null;
  clearFlash();
  try {
    [tradeEstimate, tradeChiRate] = await Promise.all([
      sendRuntimeMessage<{ estimated: number }>({
        type: "wallet_estimate_transaction",
        contract: DEX_ROUTER,
        function: fn,
        kwargs
      }),
      sendRuntimeMessage<number | null>({ type: "wallet_get_chi_rate" }),
    ]);
    if (await reconcileLockedState()) {
      return;
    }
    tradeStep = "review";
    render(currentState?.unlocked ? currentState : state);
  } catch (error) {
    if (await reconcileLockedState()) {
      return;
    }
    setFlash(formatError(error), "danger");
    render(currentState?.unlocked ? currentState : state);
  }
}

async function handleTradeSend(state: PopupRuntimeState): Promise<void> {
  if (!tradeSnapshot || !tradeQuoteForReview || !tradeKwargsForReview) {
    tradeStep = "form";
    render(state);
    return;
  }
  if (await reconcileLockedState()) {
    return;
  }

  const quote = tradeQuoteForReview;
  const kwargs = tradeKwargsForReview;
  const fn = tradeSwapFunction(tradeSnapshot, quote);
  const chi = tradeEstimate?.estimated;
  const notificationState = currentState?.unlocked ? currentState : state;
  tradeStep = "swapping";
  render(notificationState);

  try {
    const result = await sendRuntimeMessage<
      SendTransactionResult & Record<string, unknown>
    >({
      type: "wallet_send_direct_transaction",
      contract: DEX_ROUTER,
      function: fn,
      kwargs,
      chi
    });
    const { txHash, generation, sentFlashShown } =
      showSubmittedTransactionFlash(notificationState, result, {
        sent: "Swap transaction sent."
      });
    const receipt = result.receipt ?? null;
    const execution =
      receipt && typeof receipt === "object"
        ? (receipt as Record<string, unknown>).execution
        : null;
    applyReceiptStateWrites(execution);

    if (transactionAccepted(result)) {
      if (txHash) {
        void recordLocalActivityTx(notificationState, txHash, result, {
          contract: DEX_ROUTER,
          function: fn,
          kwargs
        });
      }
      refreshActivityAfterTransaction(notificationState, txHash);
      resetTradeForm();
      activeTab = "home";
    } else {
      tradeStep = "review";
    }
    void refresh();
    render(currentState?.unlocked ? currentState : notificationState);
    scheduleTransactionStatusFlash(
      notificationState,
      result,
      generation,
      sentFlashShown ? 1600 : 0,
      {
        finalized: "Swap finalized.",
        accepted: "Swap accepted.",
        failed: "Swap failed."
      }
    );
  } catch (error) {
    tradeStep = "review";
    if (await reconcileLockedState()) {
      return;
    }
    setFlash(formatError(error), "danger");
    render(currentState?.unlocked ? currentState : notificationState);
  }
}

/* ═══════════════════════════════════════════════════════════
   SECURITY TAB
   ═══════════════════════════════════════════════════════════ */

function renderShieldedSnapshotItem(
  snapshot: PopupRuntimeState["shieldedWalletSnapshots"][number]
): string {
  const historyState = shieldedHistoryStatus.get(snapshot.id);
  let historyHtml = `
    <div class="muted text-sm" style="margin-top: 8px">
      Seed-only recovery still depends on indexed shielded history being available somewhere.
    </div>
  `;
  if (historyState?.loading) {
    historyHtml = `
      <div class="muted text-sm" style="margin-top: 8px">
        Checking indexed history after note ${snapshot.lastScannedIndex}...
      </div>
    `;
  } else if (historyState && "error" in historyState) {
    historyHtml = `
      <div class="banner banner-warning" style="margin-top: 8px">
        ${escapeHtml(historyState.error)}
      </div>
    `;
  } else if (historyState && "status" in historyState) {
    if (!historyState.status.available) {
      historyHtml = `
        <div class="banner banner-warning" style="margin-top: 8px">
          Indexed shielded history is not available from the current RPC/BDS path right now.
        </div>
      `;
    } else if (!historyState.status.hasNewerIndexedHistory) {
      historyHtml = `
        <div class="banner banner-info" style="margin-top: 8px">
          Indexed history is available and no newer notes were found after this snapshot.
        </div>
      `;
    } else {
      historyHtml = `
        <div class="banner banner-warning" style="margin-top: 8px">
          Indexed history shows newer notes after this snapshot. Refresh your shielded wallet state before spending.
        </div>
        <div class="stack" style="margin-top: 8px">
          ${historyState.status.newItems
            .map(
              (item) => `
                <div class="s-row" style="align-items: flex-start">
                  <div style="flex: 1; min-width: 0">
                    <div class="text-sm" style="font-weight: 600">
                      ${escapeHtml(item.action ?? item.function ?? "shielded output")} · note ${escapeHtml(String(item.noteIndex ?? "?"))}
                    </div>
                    <div class="muted text-sm mono" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
                      ${escapeHtml(item.commitment ?? item.txHash ?? "")}
                    </div>
                    <div class="muted text-sm">
                      ${escapeHtml(item.createdAt ?? "timestamp unavailable")} · payload ${item.hasPayload ? "present" : "missing"}
                    </div>
                  </div>
                </div>
              `
            )
            .join("")}
        </div>
      `;
    }
  }

  return `
    <div class="s-row" style="align-items: flex-start; gap: 12px">
      <div style="flex: 1; min-width: 0">
        <div class="text-sm" style="font-weight: 600">${escapeHtml(snapshot.label)}</div>
        <div class="muted text-sm mono" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">${escapeHtml(snapshot.assetId)}</div>
        <div class="muted text-sm">
          ${snapshot.noteCount} notes · ${snapshot.commitmentCount} commitments · scanned ${snapshot.lastScannedIndex}
        </div>
        ${historyHtml}
      </div>
      <div style="display: flex; gap: 8px; flex-shrink: 0">
        <button class="ghost-sm" data-check-shielded-history="${escapeAttribute(snapshot.id)}">Check history</button>
        <button class="ghost-sm" data-export-shielded-snapshot="${escapeAttribute(snapshot.id)}">Export</button>
        <button class="ghost-sm" data-remove-shielded-snapshot="${escapeAttribute(snapshot.id)}">Remove</button>
      </div>
    </div>
  `;
}

function renderShieldedSnapshotsCard(state: PopupRuntimeState): string {
  const snapshotRows =
    state.shieldedWalletSnapshots.length === 0
      ? `<p class="muted text-sm" style="margin: 0">No shielded wallet state snapshots stored yet.</p>`
      : state.shieldedWalletSnapshots
          .map((snapshot) => renderShieldedSnapshotItem(snapshot))
          .join("");

  return `
    <div class="s-card">
      <div class="s-card-head">
        <div>
          <h3 class="s-card-title">Shielded snapshots</h3>
          <p class="s-card-desc">Store validated xian-zk \`state_snapshot\` payloads with the wallet.</p>
        </div>
      </div>
      <div class="s-card-body stack">
        <div class="banner banner-info">
          Stored snapshots are encrypted at rest and included automatically in full wallet backups.
        </div>
        ${snapshotRows}
        <form id="shielded-snapshot-form" class="stack">
          <label>
            Label
            <input id="shielded-snapshot-label" placeholder="Defaults to asset_id" />
          </label>
          <label>
            state_snapshot
            <textarea
              id="shielded-snapshot-json"
              rows="6"
              placeholder='Paste ShieldedWallet.to_json() output here'
              style="resize: vertical"
            ></textarea>
          </label>
          <button type="submit" class="secondary full-width">Store shielded snapshot</button>
        </form>
      </div>
    </div>
  `;
}

function renderSecurityTab(state: PopupRuntimeState): string {
  const networkWarnings: string[] = [];
  if (state.networkStatus === "mismatch") {
    networkWarnings.push(
      `<div class="banner banner-danger">Chain mismatch detected. Verify RPC URL and chain ID before approving transactions.</div>`
    );
  } else if (state.networkStatus === "unreachable") {
    networkWarnings.push(
      `<div class="banner banner-warning">RPC unreachable. Signing uses the configured preset, but live chain checks are unavailable.</div>`
    );
  }

  return `
    <div class="settings-wrap">
      ${networkWarnings.join("")}

      <!-- Status -->
      <div class="s-card">
        <div class="s-card-head">
          <div>
            <h3 class="s-card-title">Status</h3>
            <p class="s-card-desc">Wallet and network overview.</p>
          </div>
        </div>
        <div class="s-card-body">
          <div class="s-row">
            <span class="s-row-key">Preset</span>
            <span class="s-row-val">${escapeHtml(state.activeNetworkName ?? "Unknown")}</span>
          </div>
          <div class="s-row">
            <span class="s-row-key">Chain</span>
            <span class="s-row-val">${escapeHtml(state.chainId ?? "Unreachable")}</span>
          </div>
          <div class="s-row">
            <span class="s-row-key">Network</span>
            <span class="s-row-val">${escapeHtml(networkStatusLabel(state))}</span>
          </div>
        </div>
      </div>

      ${state.seedSource === "mnemonic" ? renderAccountsCard(state) : ""}

      <!-- Networks -->
      <div class="s-card">
        <div class="s-card-head">
          <div>
            <h3 class="s-card-title">Networks</h3>
            <p class="s-card-desc">Saved RPC configurations.</p>
          </div>
          <button class="ghost-sm" data-new-network>Add</button>
        </div>
        <div class="s-card-body">
          ${state.networkPresets.map((p) => renderPresetItem(state, p)).join("")}
          ${renderNetworkEditor(state)}
        </div>
      </div>

      <!-- Security -->
      <div class="s-card">
        <div class="s-card-head">
          <div>
            <h3 class="s-card-title">Security</h3>
            <p class="s-card-desc">${escapeHtml(state.seedSource === "mnemonic" ? "Seed-backed wallet" : "Private key wallet")}.</p>
          </div>
        </div>
        <div class="s-card-body stack">
          ${renderExportSection(state)}
        </div>
      </div>

      <!-- Open behavior -->
      <div class="s-card">
        <div class="s-card-head">
          <div>
            <h3 class="s-card-title">Open behavior</h3>
            <p class="s-card-desc">${escapeHtml(shellModeLabel(state.shellMode))}</p>
          </div>
        </div>
        <div class="s-card-body">
          <div class="segmented tab-bar" role="tablist" aria-label="Wallet open behavior">
            <button type="button" class="tab-button ${state.shellMode === "popup" ? "is-active" : ""}" data-shell-mode="popup">
              Popup
            </button>
            <button type="button" class="tab-button ${state.shellMode === "sidePanel" ? "is-active" : ""}" data-shell-mode="sidePanel">
              Side panel
            </button>
          </div>
          <p class="muted text-sm" style="margin-top: 8px">Approval requests always open in a dedicated window.</p>
        </div>
      </div>

      <!-- Backup -->
      <div class="s-card">
        <div class="s-card-head">
          <div>
            <h3 class="s-card-title">Backup</h3>
            <p class="s-card-desc">Export or import wallet data.</p>
          </div>
        </div>
        <div class="s-card-body stack">
          <form id="export-wallet-form" class="stack">
            <label>
              Backup password
              <input id="backup-password" type="password" required autocomplete="new-password" />
            </label>
            <div style="display: flex; gap: 8px">
              <button type="submit" class="secondary full-width">Export</button>
              <button type="button" class="secondary full-width" data-import-trigger>Import</button>
            </div>
          </form>
          <p class="muted text-sm">Export creates encrypted backup JSON for your ${escapeHtml(state.seedSource === "mnemonic" ? "seed and all accounts" : "private key")}. Stored shielded snapshots are included automatically. Import decrypts the backup in the wallet UI.</p>
        </div>
      </div>

      ${renderShieldedSnapshotsCard(state)}

      <!-- Auto-lock -->
      <div class="s-card">
        <div class="s-card-head">
          <div>
            <h3 class="s-card-title">Auto-lock</h3>
            <p class="s-card-desc">Lock the wallet after 5 minutes of inactivity.</p>
          </div>
        </div>
        <div class="s-card-body">
          <div class="s-row" style="cursor: pointer" data-toggle-auto-lock>
            <span class="s-row-key">Auto-lock</span>
            <span class="s-row-val">${autoLockEnabled ? "Enabled" : "Disabled"}</span>
          </div>
        </div>
      </div>

      <!-- Danger zone -->
      <div class="s-card">
        <div class="s-card-head">
          <div>
            <h3 class="s-card-title">Danger zone</h3>
            <p class="s-card-desc">Destructive actions that cannot be undone.</p>
          </div>
        </div>
        <div class="s-card-body stack">
          ${
            confirmWalletRemoval
              ? `
                <div class="banner banner-danger">Are you sure? This permanently removes the wallet and all accounts. Make sure you have your recovery seed backed up.</div>
                <div style="display: flex; gap: 8px">
                  <button class="ghost full-width" data-confirm-remove style="color: var(--danger); border-color: rgba(255,77,79,0.2)">Yes, remove wallet</button>
                  <button class="ghost full-width" data-cancel-remove>Cancel</button>
                </div>
              `
              : `
                <p class="muted text-sm">This permanently removes the wallet from the extension. Make sure you have backed up your recovery seed before proceeding.</p>
                <button class="ghost full-width" data-remove-wallet style="margin-top: 8px; color: var(--danger); border-color: rgba(255,77,79,0.2)">Remove wallet</button>
              `
          }
        </div>
      </div>

      <p class="muted text-sm" style="text-align: center; opacity: 0.5; margin-top: 4px">v${escapeHtml(chrome.runtime.getManifest().version)}</p>
    </div>
  `;
}

function renderAccountsCard(state: PopupRuntimeState): string {
  return `
    <!-- Accounts -->
    <div class="s-card">
      <div class="s-card-head">
        <div>
          <h3 class="s-card-title">Accounts</h3>
          <p class="s-card-desc">${state.accounts.length} derived from recovery seed.</p>
        </div>
      </div>
      <div class="s-card-body stack">
        ${state.accounts
          .map((a) => {
            if (renamingAccountIndex === a.index) {
              return `
                <div class="account-menu-rename">
                  <input class="account-rename-input" data-rename-input="${a.index}" value="${escapeAttribute(a.name)}" />
                  <button class="ghost-sm" data-save-rename="${a.index}">Save</button>
                  <button class="ghost-sm" data-cancel-rename>Cancel</button>
                </div>
              `;
            }
            if (confirmDeleteAccountIndex === a.index) {
              return `
                <div class="contact-edit-row" style="flex-direction: column; align-items: stretch; gap: 8px">
                  <div class="banner banner-warning">Remove <strong>${escapeHtml(a.name)}</strong>? You can re-derive it later from the recovery seed.</div>
                  <div style="display: flex; gap: 8px">
                    <button class="ghost-sm full-width" data-confirm-delete-account="${a.index}" style="color: var(--danger)">Remove</button>
                    <button class="ghost-sm full-width" data-cancel-delete-account>Cancel</button>
                  </div>
                </div>
              `;
            }
            return `
              <div class="contact-edit-row">
                <div style="flex: 1; min-width: 0">
                  <div class="text-sm">${escapeHtml(a.name)} ${a.index === state.activeAccountIndex ? `<span class="pill pill-strong">Active</span>` : ""}</div>
                  <div class="muted text-sm mono" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">${escapeHtml(a.publicKey)}</div>
                </div>
                <div class="inline-actions">
                  <button class="icon-action" data-rename-account="${a.index}" title="Rename">${ICONS.pencil}</button>
                  ${a.index !== 0 ? `<button class="icon-action" data-delete-account="${a.index}" title="Remove">${ICONS.trash}</button>` : ""}
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
}

function renderExportSection(state: PopupRuntimeState): string {
  const hasMnemonic = state.hasRecoveryPhrase;
  const anyRevealed = !!generatedMnemonic || !!revealedMnemonic || !!revealedPrivateKey;

  // Revealed secrets
  const secrets: string[] = [];
  if (generatedMnemonic) {
    secrets.push(renderPhraseCard("Write this down now", generatedMnemonic, "warning"));
  }
  if (revealedMnemonic && revealedMnemonic !== generatedMnemonic) {
    secrets.push(renderPhraseCard("Recovery seed", revealedMnemonic, "info"));
  }
  if (revealedPrivateKey) {
    secrets.push(renderSecretCard("Private key", revealedPrivateKey));
  }

  if (anyRevealed) {
    return `
      ${secrets.join("")}
      <button class="secondary full-width" data-hide-secrets>Hide</button>
    `;
  }

  return `
    <form id="export-form" class="stack">
      <label>
        Password
        <input id="export-password" type="password" required autocomplete="current-password" />
      </label>
      <div style="display: flex; gap: 8px">
        ${hasMnemonic ? `<button type="submit" class="secondary full-width" data-export-mnemonic>Show seed</button>` : ""}
        <button type="submit" class="secondary full-width" data-export-private-key>Show private key</button>
      </div>
    </form>
  `;
}

function renderPresetItem(
  state: PopupRuntimeState,
  preset: PopupState["networkPresets"][number]
): string {
  const isActive = preset.id === state.activeNetworkId;

  return `
    <div class="preset-item">
      <div class="preset-head">
        <div class="preset-name">
          ${escapeHtml(preset.name)}
          ${isActive ? `<span class="pill pill-strong">Active</span>` : ""}
        </div>
        <div class="inline-actions">
          ${!isActive ? `<button class="ghost-sm" data-switch-network="${escapeAttribute(preset.id)}">Use</button>` : ""}
          ${!preset.builtin ? `<button class="ghost-sm" data-edit-network="${escapeAttribute(preset.id)}">Edit</button>` : ""}
          ${!preset.builtin ? `<button class="ghost-sm" data-delete-network="${escapeAttribute(preset.id)}">Delete</button>` : ""}
        </div>
      </div>
      <div class="preset-detail">
        ${escapeHtml(preset.rpcUrl)}
        ${preset.allowInsecureHttp ? `<span class="pill pill-warning">HTTP allowed</span>` : ""}
      </div>
    </div>
  `;
}

function renderNetworkEditor(state: PopupRuntimeState): string {
  if (!networkDraft) {
    return "";
  }

  return `
    <form id="network-form" class="surface stack" style="margin-top: 12px">
      <h3>${escapeHtml(networkDraft.id ? "Edit preset" : "New preset")}</h3>
      <label>
        Name
        <input id="network-name" value="${escapeAttribute(networkDraft.name)}" />
      </label>
      <label>
        Expected chain ID
        <input id="network-chain-id" value="${escapeAttribute(networkDraft.chainId)}" placeholder="Optional, e.g. xian-local-1" />
      </label>
      <label>
        RPC URL
        <input id="network-rpc-url" value="${escapeAttribute(networkDraft.rpcUrl)}" />
      </label>
      <label>
        Dashboard URL
        <input id="network-dashboard-url" value="${escapeAttribute(networkDraft.dashboardUrl)}" />
      </label>
      <label class="inline-check">
        <input id="network-allow-insecure-http" type="checkbox" ${networkDraft.allowInsecureHttp ? "checked" : ""} />
        <span>Allow HTTP data transfers</span>
      </label>
      <label class="inline-check">
        <input id="network-make-active" type="checkbox" ${networkDraft.makeActive ? "checked" : ""} />
        <span>Use this preset immediately</span>
      </label>
      <div class="action-row">
        <button type="submit">${escapeHtml(networkDraft.id ? "Save" : "Create")}</button>
        <button type="button" class="ghost" data-cancel-network>Cancel</button>
      </div>
      ${
        state.activeNetworkId && networkDraft.id === state.activeNetworkId
          ? `<p class="muted text-sm">This edits the currently active preset.</p>`
          : ""
      }
    </form>
  `;
}

function renderSecretCard(title: string, secret: string): string {
  return `
    <div class="banner banner-info copyable-secret" data-copy-secret="${escapeAttribute(secret)}" title="Click to copy">
      <strong>${escapeHtml(title)}</strong>
      <div class="recovery-phrase">${escapeHtml(secret)}</div>
    </div>
  `;
}

function renderPhraseCard(
  title: string,
  phrase: string,
  tone: "warning" | "info"
): string {
  return `
    <div class="banner banner-${tone} copyable-secret" data-copy-secret="${escapeAttribute(phrase)}" title="Click to copy">
      <strong>${escapeHtml(title)}</strong>
      <div class="recovery-phrase">${escapeHtml(phrase)}</div>
    </div>
  `;
}

/* ── Network helpers ───────────────────────────────────────── */

function toneForNetworkStatus(
  status: PopupRuntimeState["networkStatus"]
): "info" | "warning" | "danger" {
  switch (status) {
    case "ready":
      return "info";
    case "unreachable":
      return "warning";
    case "mismatch":
      return "danger";
  }
}

function networkStatusLabel(state: PopupRuntimeState): string {
  switch (state.networkStatus) {
    case "ready":
      return "Ready";
    case "unreachable":
      return "RPC unreachable";
    case "mismatch":
      return "Chain mismatch";
  }
}

/* ═══════════════════════════════════════════════════════════
   EVENT BINDING
   ═══════════════════════════════════════════════════════════ */

function bindSetupEvents(): void {
  bindBackupFileChooser("#setup-backup-file", "#setup-backup-json");

  for (const button of root.querySelectorAll<HTMLButtonElement>(
    "[data-setup-mode]"
  )) {
    button.addEventListener("click", () => {
      clearFlash();
      setSetupMode(button.dataset.setupMode as SetupMode);
    });
  }

  root
    .querySelector<HTMLFormElement>("#setup-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      void withErrorFlash(async () => {
        if (setupMode === "importBackup") {
          const backup = parseWalletBackupJson(value("#setup-backup-json"));
          await sendRuntimeMessage<PopupState>({
            type: "wallet_import_backup",
            backup,
            password: value("#setup-password")
          });
          generatedMnemonic = null;
          revealedMnemonic = null;
          activeTab = "home";
          resetSendState();
          await refresh({
            tone: "success",
            message: "Wallet imported."
          });
          return;
        }

        const result = await sendRuntimeMessage<WalletCreateRuntimeResult>({
          type: "wallet_create",
          password: value("#setup-password"),
          createWithMnemonic: setupMode !== "importPrivateKey",
          mnemonic:
            setupMode === "importMnemonic"
              ? value("#setup-mnemonic") || undefined
              : undefined,
          privateKey:
            setupMode === "importPrivateKey"
              ? value("#setup-private-key") || undefined
              : undefined,
          networkName: value("#setup-network-name") || undefined,
          expectedChainId: value("#setup-expected-chain-id") || undefined,
          rpcUrl: value("#setup-rpc-url") || undefined,
          dashboardUrl: value("#setup-dashboard-url") || undefined,
          allowInsecureHttp: checked("#setup-allow-insecure-http")
        });

        currentState = result.popupState;
        generatedMnemonic = result.generatedMnemonic ?? null;
        revealedMnemonic = result.generatedMnemonic ?? null;
        activeTab = generatedMnemonic ? "security" : "home";
        setFlash(
          generatedMnemonic
            ? "Wallet created. Write down the recovery seed before closing this popup."
            : `Wallet imported from ${result.importedSeedSource === "mnemonic" ? "recovery seed" : "private key"}.`,
          "success"
        );
        balancesLoading =
          currentState.unlocked &&
          (currentState.watchedAssets.length > 0 ||
            visibleDetectedAssets(currentState).length > 0);
        render(currentState);
        void syncBalanceSubscriptions();
        void refreshDetectedAssets();
        void refreshBalances();
      });
    });
}

function bindUnlockedEvents(state: PopupRuntimeState): void {
  bindTokenIconFallbacks();
  bindAppFaviconFallbacks();

  for (const button of root.querySelectorAll<HTMLButtonElement>(
    "[data-tab]"
  )) {
    button.addEventListener("click", () => {
      clearFlash();
      setActiveTab(button.dataset.tab as PopupTab);
    });
  }

  for (const el of root.querySelectorAll<HTMLElement>(
    "[data-copy-address]"
  )) {
    el.addEventListener("click", () => {
      void withErrorFlash(async () => {
        await navigator.clipboard.writeText(state.publicKey ?? "");
        setFlash("Address copied.", "success");
        render(state);
      });
    });
  }

  root
    .querySelector<HTMLElement>("[data-refresh]")
    ?.addEventListener("click", async () => {
      await refresh({ tone: "success", message: "Data refreshed." });
    });

  root
    .querySelector<HTMLElement>("[data-go-send]")
    ?.addEventListener("click", () => {
      clearFlash();
      setActiveTab("send");
    });

  root
    .querySelector<HTMLElement>("[data-go-trade]")
    ?.addEventListener("click", () => {
      clearFlash();
      activeTab = "trade";
      tradeStep = "form";
      render(state);
      void loadTradeSnapshot(state);
    });

  root
    .querySelector<HTMLElement>("[data-back-home]")
    ?.addEventListener("click", () => {
      activeTab = "home";
      clearFlash();
      render(state);
    });

  root
    .querySelector<HTMLElement>("[data-show-receive]")
    ?.addEventListener("click", () => {
      clearFlash();
      showReceive = true;
      render(state);
    });

  root
    .querySelector<HTMLElement>("[data-close-receive]")
    ?.addEventListener("click", () => {
      showReceive = false;
      clearFlash();
      render(state);
    });

  /* ── Trade handlers ─────────────────────────────────────── */

  root
    .querySelector<HTMLElement>("[data-refresh-trade]")
    ?.addEventListener("click", () => {
      void loadTradeSnapshot(state, { force: true });
    });

  root
    .querySelector<HTMLInputElement>("#trade-amount")
    ?.addEventListener("input", () => {
      captureTradeFormState();
      tradeEstimate = null;
      tradeQuoteForReview = null;
      tradeKwargsForReview = null;
      tradeApprovalNotice = null;
      renderPreservingTradeAmountFocus(state);
    });

  for (const button of root.querySelectorAll<HTMLElement>(
    "[data-toggle-trade-token-picker]"
  )) {
    button.addEventListener("click", () => {
      captureTradeFormState();
      const side = button.dataset.toggleTradeTokenPicker as TradeTokenSide | undefined;
      tradeTokenPicker = tradeTokenPicker === side ? null : side ?? null;
      render(state);
    });
  }

  for (const button of root.querySelectorAll<HTMLElement>(
    "[data-pick-trade-token]"
  )) {
    button.addEventListener("click", () => {
      captureTradeFormState();
      const side = button.dataset.pickTradeToken as TradeTokenSide | undefined;
      const contract = button.dataset.contract;
      if (!side || !contract) {
        return;
      }
      if (side === "from") {
        tradeFromToken = contract;
      } else {
        tradeToToken = contract;
      }
      tradeTokenPicker = null;
      tradeEstimate = null;
      tradeQuoteForReview = null;
      tradeKwargsForReview = null;
      tradeApprovalNotice = null;
      render(state);
    });
  }

  root
    .querySelector<HTMLSelectElement>("#trade-slippage")
    ?.addEventListener("change", () => {
      captureTradeFormState();
      tradeEstimate = null;
      tradeQuoteForReview = null;
      tradeKwargsForReview = null;
      render(state);
    });

  root
    .querySelector<HTMLSelectElement>("#trade-deadline")
    ?.addEventListener("change", () => {
      captureTradeFormState();
      tradeEstimate = null;
      tradeQuoteForReview = null;
      tradeKwargsForReview = null;
      render(state);
    });

  root
    .querySelector<HTMLElement>("[data-trade-max]")
    ?.addEventListener("click", () => {
      const fromToken = tokenByContract(tradeSnapshot, tradeFromToken);
      if (!fromToken) {
        return;
      }
      tradeAmount = String(fromToken.balance);
      tradeEstimate = null;
      tradeQuoteForReview = null;
      tradeKwargsForReview = null;
      tradeApprovalNotice = null;
      tradeTokenPicker = null;
      render(state);
    });

  root
    .querySelector<HTMLElement>("[data-trade-flip]")
    ?.addEventListener("click", () => {
      const nextFrom = tradeToToken;
      tradeToToken = tradeFromToken;
      tradeFromToken = nextFrom;
      tradeAmount = "";
      tradeEstimate = null;
      tradeQuoteForReview = null;
      tradeKwargsForReview = null;
      tradeApprovalNotice = null;
      tradeTokenPicker = null;
      render(state);
    });

  root
    .querySelector<HTMLElement>("[data-approve-trade]")
    ?.addEventListener("click", () => {
      void handleTradeApproval(state);
    });

  root
    .querySelector<HTMLElement>("[data-review-trade]")
    ?.addEventListener("click", () => {
      void handleTradeReview(state);
    });

  root
    .querySelector<HTMLElement>("[data-edit-trade]")
    ?.addEventListener("click", () => {
      tradeStep = "form";
      clearFlash();
      render(state);
    });

  root
    .querySelector<HTMLElement>("[data-send-trade]")
    ?.addEventListener("click", () => {
      void handleTradeSend(state);
    });

  /* ── Manage assets ────────────────────────────────────────── */

  root
    .querySelector<HTMLElement>("[data-toggle-manage-assets]")
    ?.addEventListener("click", () => {
      managingAssets = !managingAssets;
      render(state);
    });

  root
    .querySelector<HTMLElement>("[data-add-token]")
    ?.addEventListener("click", () => {
      const input = root.querySelector<HTMLInputElement>("#add-token-input");
      const contract = input?.value.trim();
      if (!contract) return;
      void withErrorFlash(async () => {
        await addTokenToWallet(contract);
      });
    });

  for (const btn of root.querySelectorAll<HTMLElement>("[data-toggle-hide]")) {
    btn.addEventListener("click", () => {
      const contract = btn.dataset.toggleHide!;
      const asset = state.watchedAssets.find((a) => a.contract === contract);
      if (!asset) return;
      if (isAssetUnavailableOnActiveNetwork(state, asset)) return;
      void withErrorFlash(async () => {
        await sendRuntimeMessage<PopupState>({
          type: "wallet_update_assets",
          assets: [{ contract, hidden: !isAssetHiddenOnActiveNetwork(state, asset) }]
        });
        await refresh(null);
        managingAssets = true;
        render(currentState);
      });
    });
  }

  // Drag-and-drop reordering
  {
    const list = root.querySelector<HTMLElement>("#manage-asset-list");
    if (list) {
      let draggedContract: string | null = null;

      for (const row of list.querySelectorAll<HTMLElement>("[data-drag-contract]")) {
        row.addEventListener("dragstart", (e) => {
          draggedContract = row.dataset.dragContract!;
          row.classList.add("dragging");
          e.dataTransfer?.setData("text/plain", draggedContract);
        });
        row.addEventListener("dragend", () => {
          draggedContract = null;
          row.classList.remove("dragging");
        });
        row.addEventListener("dragover", (e) => {
          e.preventDefault();
          if (!draggedContract || draggedContract === row.dataset.dragContract) return;
          const rect = row.getBoundingClientRect();
          const mid = rect.top + rect.height / 2;
          if (e.clientY < mid) {
            list.insertBefore(
              list.querySelector(`[data-drag-contract="${draggedContract}"]`)!,
              row
            );
          } else {
            list.insertBefore(
              list.querySelector(`[data-drag-contract="${draggedContract}"]`)!,
              row.nextSibling
            );
          }
        });
        row.addEventListener("drop", (e) => {
          e.preventDefault();
          // Read new order from DOM
          const rows = list.querySelectorAll<HTMLElement>("[data-drag-contract]");
          const updates: Array<{ contract: string; order: number }> = [];
          rows.forEach((r, i) => {
            updates.push({ contract: r.dataset.dragContract!, order: i });
          });
          void withErrorFlash(async () => {
            await sendRuntimeMessage<PopupState>({
              type: "wallet_update_assets",
              assets: updates
            });
            await refresh(null);
            managingAssets = true;
            render(currentState);
          });
        });
      }
    }
  }

  root
    .querySelector<HTMLElement>("[data-open-dashboard]")
    ?.addEventListener("click", () => {
      if (!state.dashboardUrl) {
        setFlash("No dashboard URL configured.", "warning");
        render(state);
        return;
      }
      void withErrorFlash(async () => {
        const explorerUrl = state.dashboardUrl!.replace(/\/+$/, "") + "/explorer";
        await chrome.tabs.create({ url: explorerUrl });
      });
    });

  root
    .querySelector<HTMLElement>("[data-lock]")
    ?.addEventListener("click", () => {
      void withErrorFlash(async () => {
        generatedMnemonic = null;
        revealedMnemonic = null;
        const lockedState = await sendRuntimeMessage<PopupState>({
          type: "wallet_lock"
        });
        flash = {
          tone: "info",
          message: "Wallet locked."
        };
        await applyPopupState({
          ...lockedState,
          shellMode: state.shellMode
        });
      });
    });

  /* ── Account switching ──────────────────────────────────── */

  root
    .querySelector<HTMLElement>("[data-toggle-account-menu]")
    ?.addEventListener("click", () => {
      showAccountMenu = !showAccountMenu;
      renamingAccountIndex = null;
      render(state);
    });

  for (const btn of root.querySelectorAll<HTMLElement>("[data-switch-account]")) {
    btn.addEventListener("click", () => {
      const index = Number(btn.dataset.switchAccount);
      showAccountMenu = false;
      renamingAccountIndex = null;
      void withErrorFlash(async () => {
        await sendRuntimeMessage<PopupState>({
          type: "wallet_switch_account",
          index
        });
        resetSendState();
        await refresh(null);
      });
    });
  }

  for (const btn of root.querySelectorAll<HTMLElement>("[data-start-rename]")) {
    btn.addEventListener("click", () => {
      renamingAccountIndex = Number(btn.dataset.startRename);
      render(state);
      const input = root.querySelector<HTMLInputElement>(`[data-rename-input="${renamingAccountIndex}"]`);
      if (input) {
        input.focus();
        input.select();
      }
    });
  }

  root
    .querySelector<HTMLElement>("[data-cancel-rename]")
    ?.addEventListener("click", () => {
      renamingAccountIndex = null;
      render(state);
    });

  async function saveRename(index: number): Promise<void> {
    const input = root.querySelector<HTMLInputElement>(`[data-rename-input="${index}"]`);
    const name = input?.value.trim();
    if (!name) return;
    await withErrorFlash(async () => {
      await sendRuntimeMessage<PopupState>({
        type: "wallet_rename_account",
        index,
        name
      });
      renamingAccountIndex = null;
      showAccountMenu = false;
      await refresh(null);
    });
  }

  for (const btn of root.querySelectorAll<HTMLElement>("[data-save-rename]")) {
    btn.addEventListener("click", () => {
      void saveRename(Number(btn.dataset.saveRename));
    });
  }

  for (const input of root.querySelectorAll<HTMLInputElement>("[data-rename-input]")) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void saveRename(Number(input.dataset.renameInput));
      }
    });
  }

  root
    .querySelector<HTMLElement>("[data-add-account-prompt]")
    ?.addEventListener("click", () => {
      showAccountMenu = false;
      renamingAccountIndex = null;
      void withErrorFlash(async () => {
        await sendRuntimeMessage<PopupState>({
          type: "wallet_add_account"
        });
        setFlash("Account added.", "success");
        await refresh(null);
      });
    });

  root
    .querySelector<HTMLButtonElement>("[data-disconnect-all]")
    ?.addEventListener("click", () => {
      void withErrorFlash(async () => {
        await sendRuntimeMessage<PopupState>({
          type: "wallet_disconnect_all_origins"
        });
        await refresh({
          tone: "success",
          message: "Disconnected all sites."
        });
      });
    });

  for (const button of root.querySelectorAll<HTMLButtonElement>(
    "[data-disconnect-origin]"
  )) {
    button.addEventListener("click", () => {
      const origin = button.dataset.disconnectOrigin ?? "";
      void withErrorFlash(async () => {
        await sendRuntimeMessage<PopupState>({
          type: "wallet_disconnect_origin",
          origin
        });
        await refresh({
          tone: "success",
          message: `Disconnected ${safeOriginLabel(origin)}.`
        });
      });
    });
  }

  for (const button of root.querySelectorAll<HTMLButtonElement>(
    "[data-remove-trusted-policy]"
  )) {
    button.addEventListener("click", () => {
      const policyId = button.dataset.removeTrustedPolicy ?? "";
      void withErrorFlash(async () => {
        await sendRuntimeMessage<PopupState>({
          type: "wallet_remove_trusted_dapp_policy",
          policyId
        });
        await refresh({
          tone: "success",
          message: "Auto-approval rule revoked."
        });
      });
    });
  }

  for (const el of root.querySelectorAll<HTMLElement>(
    "[data-select-token]"
  )) {
    el.addEventListener("click", () => {
      const contract = el.dataset.selectToken;
      if (!contract) {
        return;
      }
      selectedAsset = contract;
      tokenMeta = null;
      tokenMetaLoading = true;
      clearFlash();
      render(state);
      void fetchTokenMeta(contract);
    });
  }

  root
    .querySelector<HTMLElement>("[data-back-to-list]")
    ?.addEventListener("click", () => {
      selectedAsset = null;
      tokenMeta = null;
      tokenMetaLoading = false;
      confirmRemoveSelectedAsset = false;
      clearFlash();
      render(state);
    });

  root
    .querySelector<HTMLFormElement>("#decimals-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      const decimals = parseInt(value("#decimals-input"), 10);
      if (!Number.isFinite(decimals) || decimals < 0 || decimals > 18) {
        setFlash("Decimals must be between 0 and 18.", "warning");
        render(state);
        return;
      }
      void withErrorFlash(async () => {
        await sendRuntimeMessage<PopupState>({
          type: "wallet_update_asset_decimals",
          contract: selectedAsset!,
          decimals
        });
        await refresh({
          tone: "success",
          message: "Decimal places updated."
        });
      });
    });

  root
    .querySelector<HTMLElement>("[data-remove-selected-asset]")
    ?.addEventListener("click", () => {
      confirmRemoveSelectedAsset = true;
      render(state);
    });
  root
    .querySelector<HTMLElement>("[data-cancel-remove-selected-asset]")
    ?.addEventListener("click", () => {
      confirmRemoveSelectedAsset = false;
      render(state);
    });
  root
    .querySelector<HTMLElement>("[data-confirm-remove-selected-asset]")
    ?.addEventListener("click", () => {
      const contract = selectedAsset;
      confirmRemoveSelectedAsset = false;
      if (!contract) {
        return;
      }
      void withErrorFlash(async () => {
        selectedAsset = null;
        tokenMeta = null;
        await sendRuntimeMessage<PopupState>({
          type: "wallet_remove_asset",
          contract
        });
        await refresh({
          tone: "success",
          message: "Asset removed."
        });
      });
    });

  for (const button of root.querySelectorAll<HTMLElement>("[data-track-asset]")) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const contract = button.dataset.trackAsset ?? "";
      const asset =
        currentState && contract ? findDisplayedAsset(currentState, contract) : null;
      if (!asset) {
        return;
      }
      void withErrorFlash(async () => {
        await sendRuntimeMessage<PopupState>({
          type: "wallet_track_asset",
          asset: {
            contract: asset.contract,
            name: asset.name ?? undefined,
            symbol: asset.symbol ?? undefined,
            icon: asset.icon ?? undefined,
            decimals: asset.decimals
          }
        });
        await refresh({
          tone: "success",
          message: `${asset.symbol ?? asset.contract} added to wallet.`
        });
      });
    });
  }

  root
    .querySelector<HTMLElement>("[data-track-selected-asset]")
    ?.addEventListener("click", () => {
      if (!currentState || !selectedAsset) return;
      const asset = findDisplayedAsset(currentState, selectedAsset);
      if (!asset) return;
      void withErrorFlash(async () => {
        await sendRuntimeMessage<PopupState>({
          type: "wallet_track_asset",
          asset: {
            contract: asset.contract,
            name: asset.name ?? undefined,
            symbol: asset.symbol ?? undefined,
            icon: asset.icon ?? undefined,
            decimals: asset.decimals
          }
        });
        await refresh({
          tone: "success",
          message: `${asset.symbol ?? asset.contract} added to wallet.`
        });
      });
  });

  /* ── Send tab handlers ──────────────────────────────────── */

  if (
    activeTab === "send" &&
    sendMode === "advanced" &&
    sendStep === "draft" &&
    sendContract.trim()
  ) {
    void Promise.resolve().then(() =>
      loadContractMethodsForSend(sendContract, state)
    );
  }

  root
    .querySelector<HTMLElement>("[data-cancel-unrecognized-recipient]")
    ?.addEventListener("click", () => {
      pendingUnrecognizedRecipient = null;
      render(state);
    });

  root
    .querySelector<HTMLElement>("[data-confirm-unrecognized-recipient]")
    ?.addEventListener("click", () => {
      if (!pendingUnrecognizedRecipient) {
        return;
      }
      simpleTo = pendingUnrecognizedRecipient;
      pendingUnrecognizedRecipient = null;
      void reviewSimpleSend(state, { confirmedUnrecognized: true });
    });

  root
    .querySelector<HTMLElement>("[data-cancel-unavailable-token]")
    ?.addEventListener("click", () => {
      pendingUnavailableTokenContract = null;
      render(state);
    });

  root
    .querySelector<HTMLElement>("[data-confirm-unavailable-token]")
    ?.addEventListener("click", () => {
      const contract = pendingUnavailableTokenContract;
      if (!contract) {
        return;
      }
      void withErrorFlash(async () => {
        await addTokenToWallet(contract, { confirmedInactive: true });
      });
    });

  root
    .querySelector<HTMLInputElement>("#send-contract")
    ?.addEventListener("blur", async () => {
      const contractInput = root.querySelector<HTMLInputElement>(
        "#send-contract"
      );
      const contractName = contractInput?.value.trim() ?? "";
      captureSendFormState();
      await loadContractMethodsForSend(contractName, state);
    });

  root
    .querySelector<HTMLSelectElement>("#send-function")
    ?.addEventListener("change", () => {
      captureSendFormState();
      const method = contractMethods.find(
        (m) => m.name === sendFunction
      );
      if (method) {
        sendArgs = sendArgsFromMethod(method);
      } else {
        sendArgs = [];
      }
      render(state);
    });

  root
    .querySelector<HTMLElement>("[data-add-arg]")
    ?.addEventListener("click", () => {
      captureSendFormState();
      sendArgs.push({
        id: String(++argIdCounter),
        name: "",
        value: "",
        type: "str"
      });
      render(state);
    });

  for (const sel of root.querySelectorAll<HTMLSelectElement>(".arg-type")) {
    sel.addEventListener("change", () => {
      captureSendFormState();
      render(state);
    });
  }

  for (const btn of root.querySelectorAll<HTMLButtonElement>(
    "[data-remove-arg]"
  )) {
    btn.addEventListener("click", () => {
      captureSendFormState();
      const id = btn.dataset.removeArg;
      sendArgs = sendArgs.filter((a) => a.id !== id);
      render(state);
    });
  }

  for (const radio of root.querySelectorAll<HTMLInputElement>(
    "[data-chi-mode]"
  )) {
    radio.addEventListener("change", () => {
      captureSendFormState();
      sendEstimateMode = radio.dataset.chiMode === "estimate";
      render(state);
    });
  }

  root
    .querySelector<HTMLElement>("[data-review-tx]")
    ?.addEventListener("click", async () => {
      captureSendFormState();
      if (await reconcileLockedState()) {
        return;
      }

      if (!sendContract || !sendFunction) {
        setFlash("Contract and function are required.", "warning");
        render(state);
        return;
      }

      sendParsedKwargs = buildSendKwargs();

      if (sendEstimateMode) {
        try {
          [sendEstimate, sendChiRate] = await Promise.all([
            sendRuntimeMessage<{ estimated: number }>({
              type: "wallet_estimate_transaction",
              contract: sendContract,
              function: sendFunction,
              kwargs: sendParsedKwargs
            }),
            sendRuntimeMessage<number | null>({ type: "wallet_get_chi_rate" }),
          ]);
          if (await reconcileLockedState()) {
            return;
          }
          sendStep = "review";
          clearFlash();
          render(currentState?.unlocked ? currentState : state);
        } catch (error) {
          if (await reconcileLockedState()) {
            return;
          }
          setFlash(formatError(error), "danger");
          render(currentState?.unlocked ? currentState : state);
        }
      } else {
        if (
          !sendManualChi ||
          parseInt(sendManualChi, 10) <= 0
        ) {
          setFlash("Enter a valid chi limit.", "warning");
          render(state);
          return;
        }
        sendEstimate = null;
        sendStep = "review";
        clearFlash();
        render(currentState?.unlocked ? currentState : state);
      }
    });

  root
    .querySelector<HTMLElement>("[data-edit-tx]")
    ?.addEventListener("click", () => {
      sendStep = "draft";
      clearFlash();
      render(state);
    });

  root
    .querySelector<HTMLElement>("[data-send-tx]")
    ?.addEventListener("click", async () => {
      if (!sendParsedKwargs) {
        return;
      }
      if (await reconcileLockedState()) {
        return;
      }

      sendStep = "sending";
      render(state);

      const chi =
        sendEstimateMode && sendEstimate
          ? sendEstimate.estimated
          : parseInt(sendManualChi, 10) || undefined;

      try {
        sendResult = await sendRuntimeMessage<
          SendTransactionResult & Record<string, unknown>
        >({
          type: "wallet_send_direct_transaction",
          contract: sendContract,
          function: sendFunction,
          kwargs: sendParsedKwargs,
          chi
        });
        const result = sendResult;
        const notificationState = currentState?.unlocked ? currentState : state;
        const { txHash, generation, sentFlashShown } =
          showSubmittedTransactionFlash(notificationState, result);

        const ok = transactionAccepted(result);
        const receipt = result.receipt ?? null;
        const execution =
          receipt && typeof receipt === "object"
            ? (receipt as Record<string, unknown>).execution
            : null;
        applyReceiptStateWrites(execution);

        if (ok) {
          if (txHash) {
            void recordLocalActivityTx(state, txHash, result);
          }
          refreshActivityAfterTransaction(state, txHash);
          resetSendState();
          activeTab = "home";
        } else {
          sendStep = "review";
        }
        void refresh();
        render(currentState?.unlocked ? currentState : state);
        scheduleTransactionStatusFlash(
          notificationState,
          result,
          generation,
          sentFlashShown ? 1600 : 0
        );
      } catch (error) {
        sendStep = "review";
        if (await reconcileLockedState()) {
          return;
        }
        setFlash(formatError(error), "danger");
        render(currentState?.unlocked ? currentState : state);
      }
    });

  /* ── Simple send handlers ─────────────────────────────────── */

  root
    .querySelector<HTMLElement>("[data-switch-advanced]")
    ?.addEventListener("click", () => {
      sendMode = "advanced";
      render(state);
    });

  root
    .querySelector<HTMLElement>("[data-switch-simple]")
    ?.addEventListener("click", () => {
      sendMode = "simple";
      render(state);
    });

  root
    .querySelector<HTMLElement>("[data-toggle-token-picker]")
    ?.addEventListener("click", () => {
      showTokenPicker = !showTokenPicker;
      render(state);
    });

  for (const btn of root.querySelectorAll<HTMLElement>("[data-pick-token]")) {
    btn.addEventListener("click", () => {
      simpleToken = btn.dataset.pickToken ?? "currency";
      showTokenPicker = false;
      render(state);
    });
  }

  root
    .querySelector<HTMLElement>("[data-toggle-contacts]")
    ?.addEventListener("click", () => {
      const toInput = root.querySelector<HTMLInputElement>("#simple-to");
      if (toInput) simpleTo = toInput.value.trim();
      const amtInput = root.querySelector<HTMLInputElement>("#simple-amount");
      if (amtInput) simpleAmount = amtInput.value.trim();
      showContactPicker = !showContactPicker;
      render(state);
    });

  for (const btn of root.querySelectorAll<HTMLElement>("[data-pick-contact]")) {
    btn.addEventListener("click", () => {
      simpleTo = btn.dataset.pickContact ?? "";
      showContactPicker = false;
      render(state);
    });
  }

  root
    .querySelector<HTMLElement>("[data-max-amount]")
    ?.addEventListener("click", () => {
      void (async () => {
        if (await reconcileLockedState()) {
          return;
        }
        const activeState = currentState?.unlocked ? currentState : state;
        const tokenSelect = root.querySelector<HTMLSelectElement>("#simple-token");
        if (tokenSelect) simpleToken = tokenSelect.value;
        const raw = activeState.assetBalances[simpleToken] ?? "0";
        simpleAmount = raw;
        render(activeState);
      })();
    });

  {
    const reviewBtn = root.querySelector<HTMLButtonElement>("[data-review-simple]");
    reviewBtn?.addEventListener("click", async () => {
      captureSimpleSendFormState();
      await reviewSimpleSend(state);
    });
  }

  root
    .querySelector<HTMLElement>("[data-edit-contacts]")
    ?.addEventListener("click", () => {
      const toInput = root.querySelector<HTMLInputElement>("#simple-to");
      const amtInput = root.querySelector<HTMLInputElement>("#simple-amount");
      if (toInput) simpleTo = toInput.value.trim();
      if (amtInput) simpleAmount = amtInput.value.trim();
      editingContacts = true;
      render(state);
    });

  root
    .querySelector<HTMLElement>("[data-close-contacts-editor]")
    ?.addEventListener("click", () => {
      editingContacts = false;
      render(state);
    });

  root
    .querySelector<HTMLFormElement>("#add-contact-form")
    ?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = value("#contact-name");
      const address = value("#contact-address");
      if (!name || !address) {
        setFlash("Name and address are required.", "warning");
        render(state);
        return;
      }
      if (!isValidXianAddress(address)) {
        pendingContact = { name, address };
        render(state);
        return;
      }
      contacts.push({ id: crypto.randomUUID(), name, address });
      await sendRuntimeMessage<null>({ type: "contacts_save", contacts });
      setFlash("Contact saved.", "success");
      render(state);
    });

  root
    .querySelector<HTMLElement>("[data-confirm-contact]")
    ?.addEventListener("click", async () => {
      if (!pendingContact) return;
      contacts.push({ id: crypto.randomUUID(), ...pendingContact });
      pendingContact = null;
      await sendRuntimeMessage<null>({ type: "contacts_save", contacts });
      setFlash("Contact saved.", "success");
      render(state);
    });

  root
    .querySelector<HTMLElement>("[data-cancel-contact]")
    ?.addEventListener("click", () => {
      pendingContact = null;
      render(state);
    });

  for (const btn of root.querySelectorAll<HTMLElement>("[data-delete-contact]")) {
    btn.addEventListener("click", () => {
      confirmDeleteContactId = btn.dataset.deleteContact ?? null;
      render(state);
    });
  }
  for (const btn of root.querySelectorAll<HTMLElement>("[data-confirm-delete-contact]")) {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.confirmDeleteContact;
      confirmDeleteContactId = null;
      contacts = contacts.filter((c) => c.id !== id);
      await sendRuntimeMessage<null>({ type: "contacts_save", contacts });
      setFlash("Contact removed.", "info");
      render(state);
    });
  }
  root
    .querySelector<HTMLElement>("[data-cancel-delete-contact]")
    ?.addEventListener("click", () => {
      confirmDeleteContactId = null;
      render(state);
    });

  /* ── Activity tab ──────────────────────────────────────────── */
  for (const el of root.querySelectorAll<HTMLElement>("[data-select-tx]")) {
    el.addEventListener("click", () => {
      selectedTxHash = el.dataset.selectTx ?? null;
      render(state);
    });
  }
  root
    .querySelector<HTMLElement>("[data-close-tx-detail]")
    ?.addEventListener("click", () => {
      selectedTxHash = null;
      render(state);
    });
  root
    .querySelector<HTMLElement>("[data-retry-activity]")
    ?.addEventListener("click", () => {
      if (state.publicKey) {
        void fetchActivityTxs(state.publicKey);
      }
    });

  for (const button of root.querySelectorAll<HTMLButtonElement>(
    "[data-open-approval]"
  )) {
    button.addEventListener("click", () => {
      const approvalId = button.dataset.openApproval;
      if (!approvalId) {
        return;
      }
      activeApprovalId = approvalId;
      clearFlash();
      render(state);
    });
  }

  root
    .querySelector<HTMLElement>("[data-close-approval]")
    ?.addEventListener("click", () => {
      activeApprovalId = null;
      pendingBroadTrustApprovalId = null;
      render(state);
    });

  for (const input of root.querySelectorAll<HTMLInputElement>("[data-trust-inline]")) {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      const id = input.dataset.trustInline;
      if (!id) return;
      const broad = root.querySelector<HTMLInputElement>(
        `[data-trust-broad-inline="${CSS.escape(id)}"]`
      );
      if (broad) broad.checked = false;
    });
  }

  for (const input of root.querySelectorAll<HTMLInputElement>("[data-trust-broad-inline]")) {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      const id = input.dataset.trustBroadInline;
      if (!id) return;
      const exact = root.querySelector<HTMLInputElement>(
        `[data-trust-inline="${CSS.escape(id)}"]`
      );
      if (exact) exact.checked = false;
    });
  }

  root
    .querySelector<HTMLElement>("[data-cancel-broad-trust]")
    ?.addEventListener("click", () => {
      pendingBroadTrustApprovalId = null;
      render(state);
    });

  root
    .querySelector<HTMLElement>("[data-confirm-broad-trust]")
    ?.addEventListener("click", () => {
      const id =
        root.querySelector<HTMLElement>("[data-confirm-broad-trust]")?.dataset
          .confirmBroadTrust;
      if (!id) return;
      pendingBroadTrustApprovalId = null;
      void withErrorFlash(async () => {
        await sendRuntimeMessage<null>({
          type: "approval_resolve",
          approvalId: id,
          approved: true,
          trust: "any"
        });
        activeApprovalId = null;
        await refresh({ tone: "success", message: "Approved." });
      });
    });

  root
    .querySelector<HTMLElement>("[data-approve-inline]")
    ?.addEventListener("click", () => {
      const id =
        root.querySelector<HTMLElement>("[data-approve-inline]")?.dataset
          .approveInline;
      if (!id) return;
      const trust = root.querySelector<HTMLInputElement>(
        `[data-trust-broad-inline="${CSS.escape(id)}"]`
      )?.checked
        ? "any"
        : root.querySelector<HTMLInputElement>(
              `[data-trust-inline="${CSS.escape(id)}"]`
            )?.checked
          ? "exact"
          : undefined;
      if (trust === "any") {
        pendingBroadTrustApprovalId = id;
        render(state);
        return;
      }
      void withErrorFlash(async () => {
        await sendRuntimeMessage<null>({
          type: "approval_resolve",
          approvalId: id,
          approved: true,
          trust
        });
        activeApprovalId = null;
        await refresh({ tone: "success", message: "Approved." });
      });
    });

  root
    .querySelector<HTMLElement>("[data-reject-inline]")
    ?.addEventListener("click", () => {
      const id =
        root.querySelector<HTMLElement>("[data-reject-inline]")?.dataset
          .rejectInline;
      if (!id) return;
      pendingBroadTrustApprovalId = null;
      void withErrorFlash(async () => {
        await sendRuntimeMessage<null>({
          type: "approval_resolve",
          approvalId: id,
          approved: false
        });
        activeApprovalId = null;
        await refresh({ tone: "info", message: "Rejected." });
      });
    });

  root
    .querySelector<HTMLButtonElement>("[data-new-network]")
    ?.addEventListener("click", () => {
      clearFlash();
      setNetworkDraft(defaultNetworkDraft(state));
    });

  for (const button of root.querySelectorAll<HTMLButtonElement>(
    "[data-shell-mode]"
  )) {
    button.addEventListener("click", async () => {
      const shellMode = button.dataset.shellMode as
        | WalletShellMode
        | undefined;
      if (!shellMode || shellMode === state.shellMode) {
        return;
      }

      button.disabled = true;

      void withErrorFlash(async () => {
        currentState = await sendRuntimeMessage<PopupRuntimeState>({
          type: "wallet_set_shell_mode",
          shellMode
        });

        if (
          shellMode === "sidePanel" &&
          chrome.sidePanel?.open
        ) {
          const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true
          });
          if (tab?.windowId) {
            await chrome.sidePanel.open({
              windowId: tab.windowId
            });
            window.close();
            return;
          }
        }

        setFlash(
          shellMode === "sidePanel"
            ? "Toolbar clicks will open the Chrome side panel."
            : "Toolbar clicks will open the wallet popup.",
          "success"
        );
        render(currentState);
      });
    });
  }

  root
    .querySelector<HTMLElement>("[data-toggle-auto-lock]")
    ?.addEventListener("click", async () => {
      autoLockEnabled = !autoLockEnabled;
      currentState = await sendRuntimeMessage<PopupRuntimeState>({
        type: "wallet_set_auto_lock",
        enabled: autoLockEnabled
      });
      setFlash(autoLockEnabled ? "Auto-lock enabled." : "Auto-lock disabled.", "success");
      render(currentState);
    });

  root
    .querySelector<HTMLElement>("[data-remove-wallet]")
    ?.addEventListener("click", () => {
      confirmWalletRemoval = true;
      render(state);
    });

  root
    .querySelector<HTMLElement>("[data-cancel-remove]")
    ?.addEventListener("click", () => {
      confirmWalletRemoval = false;
      render(state);
    });

  root
    .querySelector<HTMLElement>("[data-confirm-remove]")
    ?.addEventListener("click", () => {
      void withErrorFlash(async () => {
        await removeWalletAndApplyState(state.shellMode);
      });
    });

  for (const button of root.querySelectorAll<HTMLButtonElement>(
    "[data-switch-network]"
  )) {
    button.addEventListener("click", () => {
      const presetId = button.dataset.switchNetwork ?? "";
      void withErrorFlash(async () => {
        resetNetworkDraft();
        await sendRuntimeMessage<PopupState>({
          type: "wallet_switch_network",
          presetId
        });
        await refresh({
          tone: "success",
          message: "Switched active network preset."
        });
      });
    });
  }

  for (const button of root.querySelectorAll<HTMLButtonElement>(
    "[data-edit-network]"
  )) {
    button.addEventListener("click", () => {
      const presetId = button.dataset.editNetwork;
      const preset = state.networkPresets.find(
        (entry) => entry.id === presetId
      );
      if (!preset) {
        return;
      }
      clearFlash();
      setNetworkDraft(draftFromPreset(preset));
    });
  }

  for (const button of root.querySelectorAll<HTMLButtonElement>(
    "[data-delete-network]"
  )) {
    button.addEventListener("click", async () => {
      const presetId = button.dataset.deleteNetwork ?? "";
      void withErrorFlash(async () => {
        resetNetworkDraft();
        await sendRuntimeMessage<PopupState>({
          type: "wallet_remove_network_preset",
          presetId
        });
        await refresh({
          tone: "success",
          message: "Network preset deleted."
        });
      });
    });
  }

  root
    .querySelector<HTMLButtonElement>("[data-cancel-network]")
    ?.addEventListener("click", () => {
      resetNetworkDraft();
      render(state);
    });

  root
    .querySelector<HTMLFormElement>("#network-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      void withErrorFlash(async () => {
        const editingExistingPreset = Boolean(networkDraft?.id);
        await sendRuntimeMessage<PopupState>({
          type: "wallet_save_network_preset",
          id: networkDraft?.id,
          name: value("#network-name"),
          chainId: value("#network-chain-id") || undefined,
          rpcUrl: value("#network-rpc-url"),
          dashboardUrl: value("#network-dashboard-url") || undefined,
          allowInsecureHttp: checked("#network-allow-insecure-http"),
          makeActive: checked("#network-make-active")
        });
        resetNetworkDraft();
        await refresh({
          tone: "success",
          message: editingExistingPreset
            ? "Network preset updated."
            : "Network preset created."
        });
      });
    });

  root
    .querySelector<HTMLElement>("[data-export-mnemonic]")
    ?.addEventListener("click", (event) => {
      event.preventDefault();
      void withErrorFlash(async () => {
        revealedMnemonic = await sendRuntimeMessage<string>({
          type: "wallet_reveal_mnemonic",
          password: value("#export-password")
        });
        setFlash("Recovery seed revealed. Store it offline.", "warning");
        render(state);
      });
    });

  root
    .querySelector<HTMLElement>("[data-export-private-key]")
    ?.addEventListener("click", (event) => {
      event.preventDefault();
      void withErrorFlash(async () => {
        revealedPrivateKey = await sendRuntimeMessage<string>({
          type: "wallet_reveal_private_key",
          password: value("#export-password")
        });
        setFlash("Private key revealed. Store it offline.", "warning");
        render(state);
      });
    });

  for (const el of root.querySelectorAll<HTMLElement>("[data-copy-secret]")) {
    el.addEventListener("click", async () => {
      const secret = el.dataset.copySecret;
      if (!secret) return;
      try {
        await navigator.clipboard.writeText(secret);
        setFlash("Copied to clipboard.", "success");
        renderToast();
      } catch {
        setFlash("Failed to copy.", "danger");
        renderToast();
      }
    });
  }

  root
    .querySelector<HTMLElement>("[data-hide-secrets]")
    ?.addEventListener("click", () => {
      revealedMnemonic = null;
      revealedPrivateKey = null;
      generatedMnemonic = null;
      render(state);
    });

  for (const btn of root.querySelectorAll<HTMLElement>("[data-rename-account]")) {
    btn.addEventListener("click", () => {
      renamingAccountIndex = Number(btn.dataset.renameAccount);
      render(state);
      const input = root.querySelector<HTMLInputElement>(`[data-rename-input="${renamingAccountIndex}"]`);
      if (input) {
        input.focus();
        input.select();
      }
    });
  }


  for (const btn of root.querySelectorAll<HTMLElement>("[data-delete-account]")) {
    btn.addEventListener("click", () => {
      confirmDeleteAccountIndex = Number(btn.dataset.deleteAccount);
      render(state);
    });
  }

  root
    .querySelector<HTMLElement>("[data-cancel-delete-account]")
    ?.addEventListener("click", () => {
      confirmDeleteAccountIndex = null;
      render(state);
    });

  root
    .querySelector<HTMLElement>("[data-confirm-delete-account]")
    ?.addEventListener("click", () => {
      const index = Number(
        root.querySelector<HTMLElement>("[data-confirm-delete-account]")?.dataset.confirmDeleteAccount
      );
      confirmDeleteAccountIndex = null;
      void withErrorFlash(async () => {
        await sendRuntimeMessage<PopupState>({
          type: "wallet_remove_account",
          index
        });
        setFlash("Account removed.", "info");
        await refresh(null);
      });
    });

  /* ── Export / Import ──────────────────────────────────────── */

  root
    .querySelector<HTMLFormElement>("#export-wallet-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      const password = value("#backup-password");
      if (!password) return;
      void withErrorFlash(async () => {
        const backup = await sendRuntimeMessage<Record<string, unknown>>({
          type: "wallet_export",
          password
        });
        downloadJsonText(
          JSON.stringify(backup, null, 2),
          `xian-wallet-backup-${new Date().toISOString().slice(0, 10)}.json`
        );
        setFlash("Wallet exported.", "success");
        render(state);
      });
    });

  root
    .querySelector<HTMLElement>("[data-import-trigger]")
    ?.addEventListener("click", () => {
      const password = value("#backup-password");
      if (!password) {
        setFlash("Enter the backup password first.", "warning");
        render(state);
        return;
      }
      showImportBackupDialog = true;
      render(state);
    });

  root
    .querySelector<HTMLElement>("[data-cancel-import-backup]")
    ?.addEventListener("click", () => {
      showImportBackupDialog = false;
      render(state);
    });

  bindBackupFileChooser("#import-backup-file", "#import-backup-json");

  root
    .querySelector<HTMLElement>("[data-confirm-import-backup]")
    ?.addEventListener("click", () => {
      const password = value("#backup-password");
      if (!password) {
        setFlash("Enter the backup password first.", "warning");
        showImportBackupDialog = false;
        render(state);
        return;
      }

      void withErrorFlash(async () => {
        const backup = parseWalletBackupJson(value("#import-backup-json"));
        await sendRuntimeMessage<PopupState>({
          type: "wallet_import_backup",
          backup,
          password
        });
        showImportBackupDialog = false;
        resetSendState();
        await refresh({
          tone: "success",
          message: "Wallet imported."
        });
      });
    });

  root
    .querySelector<HTMLFormElement>("#shielded-snapshot-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      const stateSnapshot = value("#shielded-snapshot-json");
      if (!stateSnapshot) {
        setFlash("Paste a shielded state_snapshot first.", "warning");
        render(state);
        return;
      }
      void withErrorFlash(async () => {
        await sendRuntimeMessage<PopupState>({
          type: "wallet_save_shielded_snapshot",
          stateSnapshot,
          label: value("#shielded-snapshot-label") || undefined,
        });
        await refresh({
          tone: "success",
          message: "Shielded snapshot stored.",
        });
      });
    });

  for (const button of root.querySelectorAll<HTMLElement>("[data-export-shielded-snapshot]")) {
    button.addEventListener("click", () => {
      const snapshotId = button.dataset.exportShieldedSnapshot;
      const password = value("#backup-password");
      if (!snapshotId) return;
      if (!password) {
        setFlash("Enter your backup password first to export a shielded snapshot.", "warning");
        render(state);
        return;
      }
      void withErrorFlash(async () => {
        const payload = await sendRuntimeMessage<{ label: string; stateSnapshot: string }>({
          type: "wallet_export_shielded_snapshot",
          snapshotId,
          password,
        });
        const prettySnapshot = formatJsonText(payload.stateSnapshot);
        downloadJsonText(
          prettySnapshot,
          `xian-shielded-state-${sanitizeFilename(payload.label)}-${new Date().toISOString().slice(0, 10)}.json`
        );
        setFlash("Shielded snapshot exported.", "success");
        render(state);
      });
    });
  }

  for (const button of root.querySelectorAll<HTMLElement>("[data-check-shielded-history]")) {
    button.addEventListener("click", async () => {
      const snapshotId = button.dataset.checkShieldedHistory;
      if (!snapshotId) {
        return;
      }
      shieldedHistoryStatus.set(snapshotId, { loading: true });
      render(state);
      try {
        const status =
          await sendRuntimeMessage<ShieldedSnapshotHistoryRuntimeResult>({
            type: "wallet_get_shielded_snapshot_history",
            snapshotId,
            limit: 5,
          });
        shieldedHistoryStatus.set(snapshotId, {
          loading: false,
          status,
        });
      } catch (error) {
        shieldedHistoryStatus.set(snapshotId, {
          loading: false,
          error: formatError(error),
        });
      }
      render(state);
    });
  }

  for (const button of root.querySelectorAll<HTMLElement>("[data-remove-shielded-snapshot]")) {
    button.addEventListener("click", () => {
      const snapshotId = button.dataset.removeShieldedSnapshot;
      if (!snapshotId) return;
      void withErrorFlash(async () => {
        shieldedHistoryStatus.delete(snapshotId);
        await sendRuntimeMessage<PopupState>({
          type: "wallet_remove_shielded_snapshot",
          snapshotId,
        });
        await refresh({
          tone: "info",
          message: "Shielded snapshot removed.",
        });
      });
    });
  }
}

/* ── DOM helpers ───────────────────────────────────────────── */

function formatJsonText(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function downloadJsonText(text: string, filename: string): void {
  const blob = new Blob([text], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function sanitizeFilename(value: string): string {
  const sanitized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return sanitized.length > 0 ? sanitized : "snapshot";
}

function value(selector: string): string {
  const element =
    root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!element) {
    return "";
  }
  return element.value.trim();
}

function checked(selector: string): boolean {
  const element = root.querySelector<HTMLInputElement>(selector);
  return Boolean(element?.checked);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    const msg = error.message;
    const data = (error as Error & { data?: unknown }).data;
    if (data && typeof data === "object") {
      const obj = data as Record<string, unknown>;
      const dataStr =
        "error" in obj && typeof obj.error === "string"
          ? obj.error
          : JSON.stringify(data);
      return msg ? `${msg}: ${dataStr}` : dataStr;
    }
    return msg || "Unknown error";
  }
  return String(error) || "Unknown error";
}

function isMissingContractError(error: unknown): boolean {
  const message = formatError(error);
  return /ImportError\(['"]Module\s+[^'"]+\s+not found['"]\)/i.test(message) ||
    /Module\s+\S+\s+not found/i.test(message);
}

/* ── Init ──────────────────────────────────────────────────── */

chrome.runtime.onMessage.addListener(
  (message: unknown) => {
    const runtimeMessage =
      typeof message === "object" && message !== null
        ? (message as { type?: unknown; approvalId?: unknown })
        : null;
    if (
      runtimeMessage?.type === "approval_notify" &&
      typeof runtimeMessage.approvalId === "string"
    ) {
      activeApprovalId = runtimeMessage.approvalId;
      void refresh(null);
      return;
    }
    if (isWalletTransactionSubmittedMessage(message)) {
      void handleWalletTransactionSubmitted(message);
    }
  }
);

chrome.storage.onChanged.addListener(
  (changes: Record<string, unknown>, areaName: string) => {
    if (
      areaName === "local" &&
      STORAGE_KEY in changes &&
      walletStorageWasRemoved(changes[STORAGE_KEY])
    ) {
      void refresh(null);
      return;
    }
    if (areaName === "session" && SESSION_STORAGE_KEY in changes) {
      void reconcileLockedState();
    }
  }
);

window.addEventListener("beforeunload", () => {
  if (autoLockRefreshTimer) {
    clearTimeout(autoLockRefreshTimer);
    autoLockRefreshTimer = null;
  }
  void clearBalanceSubscriptions();
});

renderLoading();

async function initializePopup(): Promise<void> {
  try {
    autoLockEnabled = await sendRuntimeMessage<boolean>({
      type: "wallet_get_auto_lock"
    });
  } catch {
    autoLockEnabled = DEFAULT_AUTO_LOCK;
  }
  await refresh(null);
}

void initializePopup();
