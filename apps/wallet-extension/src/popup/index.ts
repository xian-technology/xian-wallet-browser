import { XianClient, type WatchSubscription } from "@xian-tech/client";
import {
  truncateAddress,
  type ApprovalView,
  type PopupState,
  type WalletDetectedAsset
} from "@xian-tech/wallet-core";
import { encode as encodeQr } from "uqr";

import {
  type PopupRuntimeState,
  popupStateBanner,
  sendRuntimeMessage,
  type WalletCreateRuntimeResult
} from "../shared/messages";
import {
  DEFAULT_AUTO_LOCK,
  type WalletShellMode
} from "../shared/preferences";

const appRoot = document.querySelector<HTMLElement>("#app");
if (!appRoot) {
  throw new Error("missing popup root");
}

const root = appRoot;

const toastRoot = document.createElement("div");
toastRoot.id = "toast-root";
document.body.appendChild(toastRoot);

/* ── Types ─────────────────────────────────────────────────── */

type PopupTab = "home" | "send" | "activity" | "apps" | "security";
type SetupMode = "create" | "importMnemonic" | "importPrivateKey";
type FlashTone = "info" | "success" | "danger" | "warning";

interface NetworkDraft {
  id?: string;
  name: string;
  chainId: string;
  rpcUrl: string;
  dashboardUrl: string;
  makeActive: boolean;
}

interface FlashMessage {
  message: string;
  tone: FlashTone;
}

type DisplayedAsset = PopupState["watchedAssets"][number] | WalletDetectedAsset;

/* ── Icons (Feather-style SVGs) ────────────────────────────── */

const ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10A15.3 15.3 0 0 1 12 2z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><circle cx="18" cy="16" r="1"/></svg>',
  chevronLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
  arrowUp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>',
  arrowDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>',
  trendingUp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
  repeat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
  contacts: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  grip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
};

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
let tokenMeta: { name: string | null; symbol: string | null; logoUrl: string | null } | null = null;
let tokenMetaLoading = false;
let tokenMetaGeneration = 0;
let showReceive = false;
let managingAssets = false;
let activeApprovalId: string | null = null;
let showAccountMenu = false;
let renamingAccountIndex: number | null = null;
let confirmDeleteAccountIndex: number | null = null;
let confirmWalletRemoval = false;
let showSaveRecipient = false;
let autoLockEnabled = DEFAULT_AUTO_LOCK;
let balanceWatchClient: XianClient | null = null;
let balanceWatchClientKey: string | null = null;
const balanceSubscriptions = new Map<string, WatchSubscription>();

/* ── Send tab state ────────────────────────────────────────── */

type TxArgType = "str" | "int" | "float" | "bool" | "dict" | "list" | "datetime" | "timedelta" | "Any";
type SendMode = "simple" | "advanced";
type SendStep = "draft" | "review" | "sending" | "result";

interface TxArg {
  id: string;
  name: string;
  value: string;
  type: TxArgType;
  fixed?: boolean;
}

let sendMode: SendMode = "simple";
let sendStep: SendStep = "draft";

// Simple send
let simpleToken = "currency";
let showTokenPicker = false;
let simpleTo = "";
let simpleAmount = "";

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
let sendManualStamps = "";
let sendParsedKwargs: Record<string, unknown> | null = null;
let sendEstimate: { estimated: number; suggested: number } | null = null;
let sendResult: {
  submitted: boolean;
  accepted: boolean | null;
  finalized: boolean;
  txHash?: string;
  message?: unknown;
} | null = null;
let argIdCounter = 0;
let contractMethods: { name: string; arguments: { name: string; type: string }[] }[] = [];
let contractMethodsLoading = false;
let contractMethodsError: string | null = null;
let contractMethodsFor: string | null = null;

function resetSendState(): void {
  sendMode = "simple";
  sendStep = "draft";
  simpleToken = "currency";
  showTokenPicker = false;
  simpleTo = "";
  simpleAmount = "";
  showSaveRecipient = false;
  showContactPicker = false;
  editingContacts = false;
  pendingContact = null;
  sendContract = "";
  sendFunction = "";
  sendArgs = [];
  sendEstimateMode = true;
  sendManualStamps = "";
  sendParsedKwargs = null;
  sendEstimate = null;
  sendResult = null;
  contractMethods = [];
  contractMethodsLoading = false;
  contractMethodsError = null;
  contractMethodsFor = null;
}

function captureSendFormState(): void {
  const c = root.querySelector<HTMLInputElement>("#send-contract");
  const f = root.querySelector<HTMLSelectElement>("#send-function");
  const s = root.querySelector<HTMLInputElement>("#send-stamps");
  if (c) sendContract = c.value.trim();
  if (f) sendFunction = f.value;
  if (s) sendManualStamps = s.value.trim();
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

function parseIntegerInput(value: string): number | bigint | null {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = BigInt(trimmed);
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  const minSafe = BigInt(Number.MIN_SAFE_INTEGER);
  return parsed >= minSafe && parsed <= maxSafe ? Number(parsed) : parsed;
}

function parseRuntimeNumberInput(value: string): number | bigint | null {
  const trimmed = value.trim();
  if (/^-?\d+$/.test(trimmed)) {
    return parseIntegerInput(trimmed);
  }
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseArgValue(val: string, type: TxArgType): unknown {
  switch (type) {
    case "str":
    case "Any":
      return val;
    case "int": {
      return parseIntegerInput(val) ?? val;
    }
    case "float": {
      const n = parseFloat(val);
      return Number.isFinite(n) ? n : val;
    }
    case "bool":
      return val.toLowerCase() === "true" || val === "1";
    case "dict":
    case "list":
      try {
        return JSON.parse(val);
      } catch {
        return val;
      }
    case "datetime": {
      const d = new Date(val);
      if (Number.isNaN(d.getTime())) {
        return val;
      }
      return {
        __time__: [
          d.getFullYear(),
          d.getMonth() + 1,
          d.getDate(),
          d.getHours(),
          d.getMinutes(),
          d.getSeconds()
        ]
      };
    }
    case "timedelta": {
      const secs = parseInt(val, 10);
      if (!Number.isFinite(secs)) {
        return val;
      }
      return { __delta__: [Math.floor(secs / 86400), secs % 86400] };
    }
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

/* ── Utilities ─────────────────────────────────────────────── */

function escapeHtml(value: unknown): string {
  if (value == null) return "";
  const s = typeof value === "string" ? value : String(value);
  return s
    .split("&").join("&amp;")
    .split("<").join("&lt;")
    .split(">").join("&gt;")
    .split('"').join("&quot;")
    .split("'").join("&#39;");
}

function escapeAttribute(value: unknown): string {
  return escapeHtml(value).split("`").join("&#96;");
}

function safeOriginLabel(origin: string): string {
  try {
    const url = new URL(origin);
    return url.hostname || origin;
  } catch {
    return origin;
  }
}

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString();
}

function assetColor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = key.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 45%, 35%)`;
}

function isValidXianAddress(addr: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(addr);
}

function truncateHash(hash: string, headLen = 10, tailLen = 8): string {
  if (hash.length <= headLen + tailLen + 3) {
    return hash;
  }
  return `${hash.slice(0, headLen)}...${hash.slice(-tailLen)}`;
}

function generateQrSvg(text: string): string {
  const { data } = encodeQr(text, { ecc: "M" });
  const count = data.length;
  const margin = 2;
  const total = count + margin * 2;
  let d = "";
  for (let y = 0; y < count; y++) {
    for (let x = 0; x < count; x++) {
      if (data[y]![x]) {
        d += `M${x + margin},${y + margin}h1v1h-1z`;
      }
    }
  }
  return `<svg viewBox="0 0 ${total} ${total}" xmlns="http://www.w3.org/2000/svg"><rect width="${total}" height="${total}" fill="#fff" rx="1"/><path d="${d}" fill="#000"/></svg>`;
}

function isDetectedAsset(asset: DisplayedAsset): asset is WalletDetectedAsset {
  return "tracked" in asset;
}

function visibleDetectedAssets(state: PopupRuntimeState): WalletDetectedAsset[] {
  return state.detectedAssets.filter((asset) => !asset.tracked);
}

function findDisplayedAsset(
  state: PopupRuntimeState,
  contract: string
): DisplayedAsset | null {
  return (
    state.watchedAssets.find((asset) => asset.contract === contract) ??
    state.detectedAssets.find((asset) => asset.contract === contract) ??
    null
  );
}

function selectedAssetIsTracked(state: PopupRuntimeState): boolean {
  if (!selectedAsset) {
    return false;
  }
  return state.watchedAssets.some((asset) => asset.contract === selectedAsset);
}

function assetRawBalance(
  asset: DisplayedAsset,
  state: PopupRuntimeState
): string | null {
  const trackedBalance = state.assetBalances[asset.contract];
  if (trackedBalance != null) {
    return trackedBalance;
  }
  return isDetectedAsset(asset) ? asset.balance : null;
}

function visibleAssetContracts(state: PopupRuntimeState): string[] {
  const contracts = new Set(state.watchedAssets.map((asset) => asset.contract));
  for (const asset of visibleDetectedAssets(state)) {
    contracts.add(asset.contract);
  }
  return [...contracts];
}

function balanceStateKey(contract: string, address: string): string {
  return `${contract}.balances:${address}`;
}

function normalizeLiveBalance(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function ensureBalanceWatchClient(state: PopupRuntimeState): XianClient | null {
  if (!state.dashboardUrl) {
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

function renderToast(): void {
  if (!flash) {
    toastRoot.innerHTML = "";
    return;
  }
  const html = `<div class="flash-toast flash-${flash.tone}">${escapeHtml(flash.message)}</div>`;
  if (toastRoot.innerHTML !== html) {
    toastRoot.innerHTML = html;
  }
}

let flashTimer: ReturnType<typeof setTimeout> | null = null;

function setFlash(message: string, tone: FlashTone = "info"): void {
  flash = { message, tone };
  renderToast();
  if (flashTimer) {
    clearTimeout(flashTimer);
  }
  flashTimer = setTimeout(() => {
    flash = null;
    flashTimer = null;
    renderToast();
  }, 3000);
}

function clearFlash(): void {
  flash = null;
  renderToast();
  if (flashTimer) {
    clearTimeout(flashTimer);
    flashTimer = null;
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
  if (tab === "activity" && currentState?.publicKey) {
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
    makeActive: true
  };
}

function defaultNetworkDraft(state: PopupRuntimeState): NetworkDraft {
  return {
    name: "Custom network",
    chainId: "",
    rpcUrl: state.rpcUrl,
    dashboardUrl: state.dashboardUrl ?? "",
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
  currentState = await sendRuntimeMessage<PopupRuntimeState>({
    type: "wallet_get_popup_state"
  });

  if (currentState.unlocked && !contactsLoaded) {
    contacts = await sendRuntimeMessage<Contact[]>({ type: "contacts_get" });
    contactsLoaded = true;
  }

  if (!currentState.hasWallet || !currentState.unlocked) {
    revealedMnemonic = null;
    networkDraft = null;
  }
  if (!currentState.unlocked) {
    generatedMnemonic = null;
    resetSendState();
  }

  balancesLoading =
    currentState.unlocked &&
    (currentState.watchedAssets.length > 0 ||
      visibleDetectedAssets(currentState).length > 0);
  render(currentState);
  void syncBalanceSubscriptions();
  void refreshDetectedAssets();
  void refreshBalances();
}

async function refreshDetectedAssets(): Promise<void> {
  if (!currentState?.unlocked) {
    if (currentState) {
      currentState.detectedAssets = [];
    }
    await clearBalanceSubscriptions();
    return;
  }

  try {
    const detectedAssets = await sendRuntimeMessage<WalletDetectedAsset[]>({
      type: "wallet_get_detected_assets"
    });
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
  const gen = ++balanceGeneration;
  try {
    const balances = await sendRuntimeMessage<Record<string, string | null>>({
      type: "wallet_get_asset_balances"
    });
    if (gen !== balanceGeneration) {
      return;
    }
    if (currentState) {
      currentState.assetBalances = balances;
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

/* ── Render dispatch ───────────────────────────────────────── */

function render(state: PopupRuntimeState | null): void {
  if (!state || !state.hasWallet) {
    renderSetup(state);
  } else if (!state.unlocked) {
    renderLocked(state);
  } else {
    renderUnlocked(state);
  }
  renderToast();
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

/* ═══════════════════════════════════════════════════════════
   SETUP SCREEN
   ═══════════════════════════════════════════════════════════ */

function renderSetup(state: PopupRuntimeState | null): void {
  const createSelected = setupMode === "create";
  const mnemonicSelected = setupMode === "importMnemonic";
  const privateKeySelected = setupMode === "importPrivateKey";
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
        </div>

        <form id="setup-form" class="stack">
          <label>
            Password
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

          <details class="disclosure">
            <summary>Network settings</summary>
            <div class="stack">
              <label>
                Network label
                <input id="setup-network-name" value="Local node" />
              </label>
              <label>
                Expected chain ID
                <input id="setup-expected-chain-id" placeholder="Optional, e.g. xian-1" />
              </label>
              <label>
                RPC URL
                <input id="setup-rpc-url" value="${escapeAttribute(defaultRpc)}" />
              </label>
              <label>
                Dashboard URL
                <input id="setup-dashboard-url" value="${escapeAttribute(defaultDashboard)}" />
              </label>
            </div>
          </details>

          <button type="submit" class="full-width">
            ${
              createSelected
                ? "Create wallet"
                : mnemonicSelected
                  ? "Import recovery seed"
                  : "Import private key"
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
    ?.addEventListener("click", async () => {
      try {
        confirmWalletRemoval = false;
        await sendRuntimeMessage<PopupState>({ type: "wallet_remove" });
        resetSendState();
        await refresh({ tone: "info", message: "Wallet removed." });
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(currentState);
      }
    });
}

/* ═══════════════════════════════════════════════════════════
   UNLOCKED – WALLET SHELL
   ═══════════════════════════════════════════════════════════ */

function shellModeLabel(mode: WalletShellMode): string {
  return mode === "sidePanel" ? "Chrome side panel" : "Toolbar popup";
}

function renderUnlocked(state: PopupRuntimeState): void {
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
      <div class="receive-address">${escapeHtml(address)}</div>
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
  const visibleAssets = managingAssets
    ? sortedAssets
    : sortedAssets.filter((a) => !a.hidden);

  const trackedAssetsHtml =
    visibleAssets.length === 0 && !managingAssets
      ? `<div class="token-list"><div style="padding: 24px 0; text-align: center" class="muted text-sm">No assets tracked yet.</div></div>`
      : managingAssets
        ? `<div class="token-list" id="manage-asset-list">${sortedAssets.map((a, i) => renderManageAssetRow(a, i)).join("")}</div>`
        : `<div class="token-list">${visibleAssets.map((a) => renderAssetItem(a, state)).join("")}</div>`;

  const detectedAssets = visibleDetectedAssets(state);
  const detectedAssetsHtml =
    detectedAssets.length === 0 || managingAssets
      ? ""
      : `
          <div class="section-hd">
            <span class="section-hd-label">Detected</span>
            <span class="section-hd-badge">${detectedAssets.length}</span>
          </div>
          <div class="token-list">${detectedAssets.map((asset) => renderAssetItem(asset, state)).join("")}</div>
        `;

  const hiddenCount = state.watchedAssets.filter((a) => a.hidden).length;

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
      <button class="quick-action" disabled>
        <div class="quick-action-circle">${ICONS.trendingUp}</div>
        <span>Trade</span>
      </button>
      <button class="quick-action" disabled>
        <div class="quick-action-circle">${ICONS.repeat}</div>
        <span>Swap</span>
      </button>
    </div>

    ${pendingHtml}

    <div class="section-hd">
      <span class="section-hd-label">Assets</span>
      <span class="section-hd-badge">${managingAssets ? state.watchedAssets.length : visibleAssets.length}${hiddenCount > 0 && !managingAssets ? ` · ${hiddenCount} hidden` : ""}</span>
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

function formatBalance(
  raw: string | null | undefined,
  decimals: number | undefined
): string {
  if (raw == null || raw === "") {
    return "—";
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) {
    return raw;
  }
  const dp = decimals ?? 8;
  // Avoid trailing zeros beyond meaningful precision
  const formatted = num.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: dp
  });
  return formatted;
}

function renderAssetItem(asset: DisplayedAsset, state: PopupRuntimeState): string {
  const symbol = asset.symbol ?? asset.contract.slice(0, 6);
  const letter = symbol.charAt(0).toUpperCase();
  const color =
    asset.contract === "currency"
      ? "var(--accent-dim)"
      : assetColor(asset.contract);
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

  return `
    <div class="token-item" data-select-token="${escapeAttribute(asset.contract)}">
      <div class="token-icon" style="background: ${color}">${escapeHtml(letter)}</div>
      <div class="token-body">
        <div class="token-name">${escapeHtml(symbol)}</div>
        <div class="token-sub">${escapeHtml(asset.name ?? asset.contract)}</div>
      </div>
      <div class="token-end">
        <div class="token-balance">${balanceHtml}</div>
        <div class="token-fiat">${
          isDetectedAsset(asset) && !asset.tracked
            ? `<button class="ghost-sm" data-track-asset="${escapeAttribute(asset.contract)}">Track</button>`
            : fiatHtml
        }</div>
      </div>
    </div>
  `;
}

function renderManageAssetRow(asset: { contract: string; name?: string; symbol?: string; hidden?: boolean }, index: number): string {
  const symbol = asset.symbol ?? asset.contract.slice(0, 6);
  const letter = symbol.charAt(0).toUpperCase();
  const color = asset.contract === "currency" ? "var(--accent-dim)" : assetColor(asset.contract);
  const isHidden = asset.hidden === true;

  return `
    <div class="manage-asset-row ${isHidden ? "is-hidden" : ""}" draggable="true" data-drag-contract="${escapeAttribute(asset.contract)}" data-drag-index="${index}">
      <span class="drag-handle">${ICONS.grip}</span>
      <div class="token-icon" style="background: ${color}; width: 28px; height: 28px; font-size: 12px">${escapeHtml(letter)}</div>
      <div class="token-body" style="flex: 1; min-width: 0">
        <div class="token-name">${escapeHtml(symbol)}</div>
        <div class="token-sub">${escapeHtml(asset.name ?? asset.contract)}</div>
      </div>
      <button class="icon-action" data-toggle-hide="${escapeAttribute(asset.contract)}" title="${isHidden ? "Show" : "Hide"}">
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
  const letter = symbol.charAt(0).toUpperCase();
  const color =
    asset.contract === "currency"
      ? "var(--accent-dim)"
      : assetColor(asset.contract);
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
        <div class="s-row"><span class="s-row-key">Logo</span><span class="s-row-val"><span class="skeleton">Loading</span></span></div>
      `
    : tokenMeta
      ? `
          <div class="s-row"><span class="s-row-key">Token name</span><span class="s-row-val">${escapeHtml(tokenMeta.name ?? "—")}</span></div>
          <div class="s-row"><span class="s-row-key">Symbol</span><span class="s-row-val">${escapeHtml(tokenMeta.symbol ?? "—")}</span></div>
          <div class="s-row"><span class="s-row-key">Logo</span><span class="s-row-val mono">${escapeHtml(tokenMeta.logoUrl ?? "—")}</span></div>
        `
      : `
          <div class="s-row"><span class="s-row-key">Token name</span><span class="s-row-val muted">Unavailable</span></div>
          <div class="s-row"><span class="s-row-key">Symbol</span><span class="s-row-val muted">Unavailable</span></div>
          <div class="s-row"><span class="s-row-key">Logo</span><span class="s-row-val muted">Unavailable</span></div>
        `;

  return `
    <div class="token-detail">
      <button class="detail-back" data-back-to-list>
        ${ICONS.chevronLeft} Back
      </button>

      <div class="token-detail-hero">
        <div class="token-icon" style="width: 48px; height: 48px; font-size: 20px; background: ${color}; margin: 0 auto">
          ${escapeHtml(letter)}
        </div>
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
          ? `<button class="secondary full-width" data-remove-selected-asset>Remove from wallet</button>`
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
  if (state.connectedOrigins.length === 0) {
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
      <span class="section-hd-badge">${state.connectedOrigins.length}</span>
    </div>
    ${
      state.connectedOrigins.length > 1
        ? `<div style="padding: 0 16px"><button class="ghost full-width" data-disconnect-all>Disconnect all</button></div>`
        : ""
    }
    <div class="app-list">
      ${state.connectedOrigins.map((o) => renderOriginItem(o)).join("")}
    </div>
  `;
}

function renderOriginItem(origin: string): string {
  const hostname = safeOriginLabel(origin);
  const letter = escapeHtml(hostname.charAt(0).toUpperCase());
  const fallback = `this.replaceWith(Object.assign(document.createElement('div'),{className:'token-icon',style:'background:${assetColor(origin)}',textContent:'${letter}'}))`;
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=32`;

  return `
    <div class="app-item">
      <img class="app-favicon" src="${escapeAttribute(faviconUrl)}" alt="" width="32" height="32" onerror="${escapeAttribute(fallback)}" />
      <div class="app-item-info">
        <div class="app-item-host">${escapeHtml(hostname)}</div>
        <div class="app-item-url">${escapeHtml(origin)}</div>
      </div>
      <button class="ghost-sm" data-disconnect-origin="${escapeAttribute(origin)}">Disconnect</button>
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════
   ACTIVITY TAB
   ═══════════════════════════════════════════════════════════ */

let activityTxs: Array<{
  hash: string;
  contract: string;
  function: string;
  sender: string;
  success: boolean;
  stamps_used: number;
  created_at: string;
  block_height: number;
}> = [];
let activityLoading = false;

async function fetchActivityTxs(address: string): Promise<void> {
  activityLoading = true;
  if (currentState) render(currentState);
  try {
    const rpcUrl = currentState?.rpcUrl ?? "http://127.0.0.1:26657";
    const resp = await fetch(
      `${rpcUrl}/abci_query?path=%22/txs_by_sender/${address}/limit=50/offset=0%22`
    );
    if (resp.ok) {
      const data = await resp.json();
      const val = data?.result?.response?.value;
      if (val) {
        const decoded = JSON.parse(atob(val));
        activityTxs = Array.isArray(decoded) ? decoded : decoded?.items ?? [];
      } else {
        activityTxs = [];
      }
    }
  } catch {
    activityTxs = [];
  }
  activityLoading = false;
  if (currentState) render(currentState);
}
let selectedTxHash: string | null = null;

function renderActivityTab(state: PopupRuntimeState): string {
  if (selectedTxHash) {
    const tx = activityTxs.find((t) => t.hash === selectedTxHash);
    if (tx) {
      const isOut = tx.sender === state.publicKey;
      const explorerBase = state.dashboardUrl ? state.dashboardUrl.replace(/\/+$/, "") + "/explorer/tx/" : null;
      return `
        <div class="settings-wrap">
          <button class="detail-back" data-close-tx-detail>${ICONS.chevronLeft} Back</button>
          <div class="s-card">
            <div class="s-card-head">
              <div>
                <h3 class="s-card-title">${escapeHtml(tx.contract)}.${escapeHtml(tx.function)}</h3>
                <p class="s-card-desc">${isOut ? "Sent" : "Received"} · ${tx.success ? "Success" : "Failed"}</p>
              </div>
              <span class="pill ${tx.success ? "pill-info" : "pill-warning"}">${tx.success ? "✓" : "✗"}</span>
            </div>
            <div class="s-card-body">
              <div class="s-row"><span class="s-row-key">Hash</span><span class="s-row-val mono" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeAttribute(tx.hash)}">${explorerBase ? `<a href="${escapeAttribute(explorerBase + tx.hash)}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">${escapeHtml(truncateHash(tx.hash))}</a>` : escapeHtml(truncateHash(tx.hash))}</span></div>
              <div class="s-row"><span class="s-row-key">Block</span><span class="s-row-val">${tx.block_height}</span></div>
              <div class="s-row"><span class="s-row-key">Stamps</span><span class="s-row-val">${tx.stamps_used.toLocaleString()}</span></div>
              <div class="s-row"><span class="s-row-key">Time</span><span class="s-row-val">${escapeHtml(tx.created_at)}</span></div>
            </div>
          </div>
        </div>
      `;
    }
    selectedTxHash = null;
  }

  if (activityLoading) {
    return `<div class="send-centered"><div class="spinner"></div><p class="muted text-sm">Loading transactions...</p></div>`;
  }

  if (activityTxs.length === 0) {
    return `
      <div class="send-centered" style="padding: 48px 0">
        <p class="muted text-sm">No transactions yet.</p>
        <p class="muted text-sm" style="opacity: 0.6">Send or receive tokens to see activity here.</p>
      </div>
    `;
  }

  return `
    <div class="token-list">
      ${activityTxs.map((tx) => {
        const isOut = tx.sender === state.publicKey;
        return `
          <div class="token-item" data-select-tx="${escapeAttribute(tx.hash)}" style="cursor:pointer">
            <div class="token-icon" style="background: ${isOut ? "var(--danger-soft, rgba(255,77,79,0.12))" : "var(--success-soft, rgba(34,197,94,0.12))"}">
              ${isOut ? ICONS.arrowUp : ICONS.arrowDown}
            </div>
            <div class="token-body">
              <div class="token-name">${escapeHtml(tx.contract)}.${escapeHtml(tx.function)}</div>
              <div class="token-sub">${escapeHtml(tx.created_at)}</div>
            </div>
            <div class="token-end">
              <span class="pill ${tx.success ? "pill-info" : "pill-warning"}" style="font-size:11px">${tx.success ? "✓" : "✗"}</span>
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

function renderApprovalInline(view: ApprovalView): string {
  const tone = approvalTone(view.kind);
  const warnings = view.warnings ?? [];
  const highlights = view.highlights ?? [];
  const details = view.details ?? [];

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
            details.length > 0
              ? details
                  .map(
                    (d) => `
                      <div class="s-row">
                        <span class="s-row-key">${escapeHtml(d.label)}</span>
                        <span class="s-row-val ${d.monospace ? "mono" : ""}">${escapeHtml(d.value)}</span>
                      </div>
                    `
                  )
                  .join("")
              : ""
          }
        </div>
      </div>

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

      <div class="action-row" style="gap: 10px">
        <button class="full-width" data-approve-inline="${escapeAttribute(view.id)}">${escapeHtml(view.approveLabel ?? "Approve")}</button>
        <button class="secondary full-width" data-reject-inline="${escapeAttribute(view.id)}">Reject</button>
      </div>
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
    case "result":
      return renderSendResult(state);
  }
}

function renderSimpleSend(state: PopupRuntimeState): string {
  if (editingContacts) {
    return renderContactsEditor();
  }

  const selectedAssetObj = state.watchedAssets.find((a) => a.contract === simpleToken);
  const tokenSymbol = selectedAssetObj?.symbol ?? simpleToken.slice(0, 6).toUpperCase();
  const tokenLetter = tokenSymbol.charAt(0).toUpperCase();
  const tokenBalance = state.assetBalances[simpleToken] ?? "0";
  const displayBalance = formatSimpleBalance(tokenBalance);
  const tokenColor = simpleToken === "currency" ? "var(--accent-dim)" : assetColor(simpleToken);
  const visibleTokens = state.watchedAssets.filter((a) => !a.hidden).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

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
              <span class="token-chooser-icon" style="background: ${tokenColor}">${escapeHtml(tokenLetter)}</span>
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
                const l = s.charAt(0).toUpperCase();
                const c = a.contract === "currency" ? "var(--accent-dim)" : assetColor(a.contract);
                const active = a.contract === simpleToken;
                return `
                  <button type="button" class="token-picker-item ${active ? "is-active" : ""}" data-pick-token="${escapeAttribute(a.contract)}">
                    <span class="token-chooser-icon" style="background: ${c}">${escapeHtml(l)}</span>
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

      <button class="full-width" data-review-simple>Review</button>
      <div class="send-footer-links">
        <button class="send-footer-link" data-switch-advanced>Advanced transaction</button>
        <button class="send-footer-link" data-edit-contacts>${contacts.length > 0 ? "Manage contacts" : "Add contacts"}</button>
      </div>
    </div>
  `;
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
                        <button class="ghost-sm" data-delete-contact="${escapeAttribute(c.id)}">×</button>
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
  const typeAttrs = arg.fixed ? "disabled" : "";
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
        <option value="">${contractMethodsLoading ? "Loading..." : hasContract ? "No functions loaded" : "Enter contract first"}</option>
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
            <h3 class="s-card-title">Stamps</h3>
            <p class="s-card-desc">Transaction cost budget.</p>
          </div>
        </div>
        <div class="s-card-body stack">
          <label class="inline-check">
            <input type="radio" name="stamp-mode" value="estimate" ${sendEstimateMode ? "checked" : ""} data-stamp-mode="estimate" />
            <span>Estimate automatically</span>
          </label>
          <label class="inline-check">
            <input type="radio" name="stamp-mode" value="manual" ${!sendEstimateMode ? "checked" : ""} data-stamp-mode="manual" />
            <span>Set manually</span>
          </label>
          ${
            !sendEstimateMode
              ? `<label>Stamp limit<input id="send-stamps" type="number" min="1" value="${escapeAttribute(sendManualStamps)}" placeholder="e.g. 50000" /></label>`
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
  const stampsLabel = sendEstimate
    ? sendEstimate.estimated.toLocaleString()
    : Number(sendManualStamps).toLocaleString();

  return `
    <div class="settings-wrap">
      <button class="detail-back" data-edit-tx>${ICONS.chevronLeft} Edit</button>

      <div class="s-card">
        <div class="s-card-head">
          <div><h3 class="s-card-title">Transaction summary</h3></div>
        </div>
        <div class="s-card-body">
          <div class="s-row">
            <span class="s-row-key">Contract</span>
            <span class="s-row-val mono">${escapeHtml(sendContract)}</span>
          </div>
          <div class="s-row">
            <span class="s-row-key">Function</span>
            <span class="s-row-val">${escapeHtml(sendFunction)}</span>
          </div>
          <div class="s-row">
            <span class="s-row-key">Stamps</span>
            <span class="s-row-val">${escapeHtml(stampsLabel)}</span>
          </div>
          ${entries
            .map(
              ([k, v]) => `
                <div class="s-row">
                  <span class="s-row-key">${escapeHtml(k)}</span>
                  <span class="s-row-val mono">${escapeHtml(String(v))}</span>
                </div>
              `
            )
            .join("")}
        </div>
      </div>

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

function renderSendResult(state: PopupRuntimeState): string {
  if (!sendResult) {
    return renderSendDraft();
  }
  const ok = sendResult.finalized || sendResult.accepted === true;
  const explorerBase = state.dashboardUrl
    ? state.dashboardUrl.replace(/\/+$/, "") + "/explorer/tx/"
    : null;
  const hashLink =
    sendResult.txHash && explorerBase
      ? `<a href="${escapeAttribute(explorerBase + sendResult.txHash)}" target="_blank" rel="noopener" style="color: var(--accent); text-decoration: none" title="${escapeAttribute(sendResult.txHash)}">${escapeHtml(truncateHash(sendResult.txHash))}</a>`
      : sendResult.txHash
        ? `<span title="${escapeAttribute(sendResult.txHash)}">${escapeHtml(truncateHash(sendResult.txHash))}</span>`
        : null;

  return `
    <div class="settings-wrap">
      ${
        !ok && sendResult.message
          ? `<div class="banner banner-danger"><strong>Transaction failed</strong><p class="text-sm" style="margin-top: 4px">${escapeHtml(String(sendResult.message))}</p></div>`
          : ""
      }

      ${
        hashLink
          ? `
              <div class="s-card">
                <div class="s-card-body">
                  <div class="s-row">
                    <span class="s-row-key">TX Hash</span>
                    <span class="s-row-val mono" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px">${hashLink}</span>
                  </div>
                </div>
              </div>
            `
          : ""
      }

      ${
        sendMode === "simple" &&
        ok &&
        simpleTo &&
        !contacts.some((c) => c.address === simpleTo)
          ? showSaveRecipient
            ? `<div style="display: flex; gap: 6px; align-items: center">
                 <input id="save-contact-name" class="ide-input" style="flex: 1; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg-0); color: var(--fg); font-size: 13px" placeholder="Contact name" autofocus />
                 <button class="ghost-sm" data-confirm-save-recipient>Save</button>
                 <button class="ghost-sm" data-cancel-save-recipient>Cancel</button>
               </div>`
            : `<button class="secondary full-width" data-save-recipient>Save recipient as contact</button>`
          : ""
      }

      <button class="full-width" data-new-tx>New Transaction</button>
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════
   SECURITY TAB
   ═══════════════════════════════════════════════════════════ */

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
              Password
              <input id="backup-password" type="password" required autocomplete="current-password" />
            </label>
            <div style="display: flex; gap: 8px">
              <button type="submit" class="secondary full-width">Export</button>
              <button type="button" class="secondary full-width" data-import-trigger>Import</button>
              <input type="file" accept=".json" id="import-wallet-file" style="display: none" />
            </div>
          </form>
          <p class="muted text-sm">Export saves your ${escapeHtml(state.seedSource === "mnemonic" ? "seed and all accounts" : "private key")} to an encrypted file. Import restores from a previously exported file.</p>
        </div>
      </div>

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
      <div class="preset-detail">${escapeHtml(preset.rpcUrl)}</div>
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
        <input id="network-chain-id" value="${escapeAttribute(networkDraft.chainId)}" placeholder="Optional, e.g. xian-1" />
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
    ?.addEventListener("submit", async (event) => {
      event.preventDefault();

      try {
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
          dashboardUrl: value("#setup-dashboard-url") || undefined
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
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(currentState);
      }
    });
}

function bindUnlockedEvents(state: PopupRuntimeState): void {
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
    el.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(state.publicKey ?? "");
        setFlash("Address copied.", "success");
        render(state);
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
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

  /* ── Manage assets ────────────────────────────────────────── */

  root
    .querySelector<HTMLElement>("[data-toggle-manage-assets]")
    ?.addEventListener("click", () => {
      managingAssets = !managingAssets;
      render(state);
    });

  root
    .querySelector<HTMLElement>("[data-add-token]")
    ?.addEventListener("click", async () => {
      const input = root.querySelector<HTMLInputElement>("#add-token-input");
      const contract = input?.value.trim();
      if (!contract) return;
      try {
        await sendRuntimeMessage<PopupState>({
          type: "wallet_track_asset",
          asset: { contract }
        });
        setFlash(`Added ${contract}.`, "success");
        await refresh(null);
        managingAssets = true;
        render(currentState);
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
    });

  for (const btn of root.querySelectorAll<HTMLElement>("[data-toggle-hide]")) {
    btn.addEventListener("click", async () => {
      const contract = btn.dataset.toggleHide!;
      const asset = state.watchedAssets.find((a) => a.contract === contract);
      if (!asset) return;
      try {
        await sendRuntimeMessage<PopupState>({
          type: "wallet_update_assets",
          assets: [{ contract, hidden: !asset.hidden }]
        });
        await refresh(null);
        managingAssets = true;
        render(currentState);
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
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
        row.addEventListener("drop", async (e) => {
          e.preventDefault();
          // Read new order from DOM
          const rows = list.querySelectorAll<HTMLElement>("[data-drag-contract]");
          const updates: Array<{ contract: string; order: number }> = [];
          rows.forEach((r, i) => {
            updates.push({ contract: r.dataset.dragContract!, order: i });
          });
          try {
            await sendRuntimeMessage<PopupState>({
              type: "wallet_update_assets",
              assets: updates
            });
            await refresh(null);
            managingAssets = true;
            render(currentState);
          } catch (error) {
            setFlash(formatError(error), "danger");
            render(state);
          }
        });
      }
    }
  }

  root
    .querySelector<HTMLElement>("[data-open-dashboard]")
    ?.addEventListener("click", async () => {
      if (!state.dashboardUrl) {
        setFlash("No dashboard URL configured.", "warning");
        render(state);
        return;
      }

      try {
        const explorerUrl = state.dashboardUrl.replace(/\/+$/, "") + "/explorer";
        await chrome.tabs.create({ url: explorerUrl });
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
    });

  root
    .querySelector<HTMLElement>("[data-lock]")
    ?.addEventListener("click", async () => {
      try {
        generatedMnemonic = null;
        revealedMnemonic = null;
        await sendRuntimeMessage<PopupState>({
          type: "wallet_lock"
        });
        await refresh({
          tone: "info",
          message: "Wallet locked."
        });
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
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
    btn.addEventListener("click", async () => {
      const index = Number(btn.dataset.switchAccount);
      showAccountMenu = false;
      renamingAccountIndex = null;
      try {
        await sendRuntimeMessage<PopupState>({
          type: "wallet_switch_account",
          index
        });
        resetSendState();
        await refresh(null);
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
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
    try {
      await sendRuntimeMessage<PopupState>({
        type: "wallet_rename_account",
        index,
        name
      });
      renamingAccountIndex = null;
      showAccountMenu = false;
      await refresh(null);
    } catch (error) {
      setFlash(formatError(error), "danger");
      render(state);
    }
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
    ?.addEventListener("click", async () => {
      showAccountMenu = false;
      renamingAccountIndex = null;
      try {
        await sendRuntimeMessage<PopupState>({
          type: "wallet_add_account"
        });
        setFlash("Account added.", "success");
        await refresh(null);
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
    });

  root
    .querySelector<HTMLButtonElement>("[data-disconnect-all]")
    ?.addEventListener("click", async () => {
      try {
        await sendRuntimeMessage<PopupState>({
          type: "wallet_disconnect_all_origins"
        });
        await refresh({
          tone: "success",
          message: "Disconnected all sites."
        });
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
    });

  for (const button of root.querySelectorAll<HTMLButtonElement>(
    "[data-disconnect-origin]"
  )) {
    button.addEventListener("click", async () => {
      const origin = button.dataset.disconnectOrigin ?? "";
      try {
        await sendRuntimeMessage<PopupState>({
          type: "wallet_disconnect_origin",
          origin
        });
        await refresh({
          tone: "success",
          message: `Disconnected ${safeOriginLabel(origin)}.`
        });
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
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
      clearFlash();
      render(state);
    });

  root
    .querySelector<HTMLFormElement>("#decimals-form")
    ?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const decimals = parseInt(value("#decimals-input"), 10);
      if (!Number.isFinite(decimals) || decimals < 0 || decimals > 18) {
        setFlash("Decimals must be between 0 and 18.", "warning");
        render(state);
        return;
      }
      try {
        await sendRuntimeMessage<PopupState>({
          type: "wallet_update_asset_decimals",
          contract: selectedAsset!,
          decimals
        });
        await refresh({
          tone: "success",
          message: "Decimal places updated."
        });
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
    });

  root
    .querySelector<HTMLElement>("[data-remove-selected-asset]")
    ?.addEventListener("click", async () => {
      const contract = selectedAsset;
      if (!contract) {
        return;
      }
      try {
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
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
    });

  for (const button of root.querySelectorAll<HTMLElement>("[data-track-asset]")) {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const contract = button.dataset.trackAsset ?? "";
      const asset =
        currentState && contract ? findDisplayedAsset(currentState, contract) : null;
      if (!asset) {
        return;
      }
      try {
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
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
    });
  }

  root
    .querySelector<HTMLElement>("[data-track-selected-asset]")
    ?.addEventListener("click", async () => {
      if (!currentState || !selectedAsset) {
        return;
      }
      const asset = findDisplayedAsset(currentState, selectedAsset);
      if (!asset) {
        return;
      }
      try {
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
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
    });

  /* ── Send tab handlers ──────────────────────────────────── */

  root
    .querySelector<HTMLInputElement>("#send-contract")
    ?.addEventListener("blur", async () => {
      const contractInput = root.querySelector<HTMLInputElement>(
        "#send-contract"
      );
      const contractName = contractInput?.value.trim() ?? "";
      if (!contractName || contractName === contractMethodsFor) {
        return;
      }

      captureSendFormState();
      contractMethodsFor = contractName;
      contractMethods = [];
      contractMethodsLoading = true;
      contractMethodsError = null;
      sendFunction = "";
      render(state);

      try {
        contractMethods = await sendRuntimeMessage<
          typeof contractMethods
        >({
          type: "wallet_get_contract_methods",
          contract: contractName
        });
        contractMethodsLoading = false;
        if (contractMethods.length === 0) {
          contractMethodsError = "No functions found for this contract.";
        }
      } catch (error) {
        contractMethodsLoading = false;
        contractMethodsError = formatError(error);
        contractMethods = [];
      }
      if (contractMethodsFor === contractName) {
        render(state);
      }
    });

  root
    .querySelector<HTMLSelectElement>("#send-function")
    ?.addEventListener("change", () => {
      captureSendFormState();
      const method = contractMethods.find(
        (m) => m.name === sendFunction
      );
      if (method) {
        sendArgs = method.arguments.map((a) => ({
          id: String(++argIdCounter),
          name: a.name,
          value: "",
          type: mapContractType(a.type),
          fixed: true
        }));
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
    "[data-stamp-mode]"
  )) {
    radio.addEventListener("change", () => {
      captureSendFormState();
      sendEstimateMode = radio.dataset.stampMode === "estimate";
      render(state);
    });
  }

  root
    .querySelector<HTMLElement>("[data-review-tx]")
    ?.addEventListener("click", async () => {
      captureSendFormState();

      if (!sendContract || !sendFunction) {
        setFlash("Contract and function are required.", "warning");
        render(state);
        return;
      }

      sendParsedKwargs = buildSendKwargs();

      if (sendEstimateMode) {
        try {
          sendEstimate = await sendRuntimeMessage<{
            estimated: number;
            suggested: number;
          }>({
            type: "wallet_estimate_transaction",
            contract: sendContract,
            function: sendFunction,
            kwargs: sendParsedKwargs
          });
          sendStep = "review";
          clearFlash();
          render(state);
        } catch (error) {
          setFlash(formatError(error), "danger");
          render(state);
        }
      } else {
        if (
          !sendManualStamps ||
          parseInt(sendManualStamps, 10) <= 0
        ) {
          setFlash("Enter a valid stamp limit.", "warning");
          render(state);
          return;
        }
        sendEstimate = null;
        sendStep = "review";
        clearFlash();
        render(state);
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

      sendStep = "sending";
      render(state);

      const stamps =
        sendEstimateMode && sendEstimate
          ? sendEstimate.estimated
          : parseInt(sendManualStamps, 10) || undefined;

      try {
        sendResult = await sendRuntimeMessage<
          typeof sendResult & Record<string, unknown>
        >({
          type: "wallet_send_direct_transaction",
          contract: sendContract,
          function: sendFunction,
          kwargs: sendParsedKwargs,
          stamps
        });
        sendStep = "result";
        const ok =
          sendResult?.finalized || sendResult?.accepted === true;
        setFlash(
          ok
            ? sendResult?.finalized
              ? "Transaction finalized."
              : "Transaction accepted."
            : sendResult?.submitted
              ? "Transaction submitted but not accepted."
              : "Transaction failed.",
          ok ? "success" : "danger"
        );
        const receipt =
          sendResult && typeof sendResult === "object"
            ? (sendResult as Record<string, unknown>).receipt
            : null;
        const execution =
          receipt && typeof receipt === "object"
            ? (receipt as Record<string, unknown>).execution
            : null;
        applyReceiptStateWrites(execution);
        void refresh(ok ? null : undefined);
        // Refresh activity cache so the new tx shows up
        if (ok && currentState?.publicKey) {
          void fetchActivityTxs(currentState.publicKey);
        }
        render(state);
      } catch (error) {
        sendStep = "review";
        setFlash(formatError(error), "danger");
        render(state);
      }
    });

  root
    .querySelector<HTMLElement>("[data-new-tx]")
    ?.addEventListener("click", () => {
      resetSendState();
      clearFlash();
      render(state);
    });

  root
    .querySelector<HTMLElement>("[data-save-recipient]")
    ?.addEventListener("click", () => {
      showSaveRecipient = true;
      render(state);
    });

  root
    .querySelector<HTMLElement>("[data-cancel-save-recipient]")
    ?.addEventListener("click", () => {
      showSaveRecipient = false;
      render(state);
    });

  root
    .querySelector<HTMLElement>("[data-confirm-save-recipient]")
    ?.addEventListener("click", async () => {
      const input = root.querySelector<HTMLInputElement>("#save-contact-name");
      const name = input?.value.trim();
      if (!name || !simpleTo) return;
      contacts.push({ id: crypto.randomUUID(), name, address: simpleTo });
      await sendRuntimeMessage<null>({ type: "contacts_save", contacts });
      showSaveRecipient = false;
      setFlash("Contact saved.", "success");
      render(state);
    });

  // Also support Enter key in the contact name input
  root
    .querySelector<HTMLInputElement>("#save-contact-name")
    ?.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter") return;
      const name = (e.target as HTMLInputElement).value.trim();
      if (!name || !simpleTo) return;
      contacts.push({ id: crypto.randomUUID(), name, address: simpleTo });
      await sendRuntimeMessage<null>({ type: "contacts_save", contacts });
      showSaveRecipient = false;
      setFlash("Contact saved.", "success");
      render(state);
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
      const tokenSelect = root.querySelector<HTMLSelectElement>("#simple-token");
      if (tokenSelect) simpleToken = tokenSelect.value;
      const raw = state.assetBalances[simpleToken] ?? "0";
      simpleAmount = raw;
      render(state);
    });

  {
    const reviewBtn = root.querySelector<HTMLButtonElement>("[data-review-simple]");
    reviewBtn?.addEventListener("click", async () => {
      const tokenSelect = root.querySelector<HTMLSelectElement>("#simple-token");
      if (tokenSelect) simpleToken = tokenSelect.value;
      const toInput = root.querySelector<HTMLInputElement>("#simple-to");
      const amtInput = root.querySelector<HTMLInputElement>("#simple-amount");
      if (toInput) simpleTo = toInput.value.trim();
      if (amtInput) simpleAmount = amtInput.value.trim();

      if (!simpleTo) {
        setFlash("Recipient address is required.", "warning");
        render(state);
        return;
      }
      const amount = parseRuntimeNumberInput(simpleAmount);
      if (
        amount == null ||
        (typeof amount === "bigint" ? amount <= 0n : amount <= 0)
      ) {
        setFlash("Enter a valid amount.", "warning");
        render(state);
        return;
      }

      // Set up as a token.transfer call
      sendContract = simpleToken;
      sendFunction = "transfer";
      sendParsedKwargs = { to: simpleTo, amount };
      sendEstimateMode = true;

      // Show loading state on button
      const originalText = reviewBtn.textContent ?? "Review";
      reviewBtn.disabled = true;
      reviewBtn.innerHTML = `<span class="btn-spinner"></span> Estimating...`;

      // Timeout: restore button after 15s
      const timeout = setTimeout(() => {
        reviewBtn.disabled = false;
        reviewBtn.textContent = originalText;
        setFlash("Estimation timed out. Try again.", "warning");
        renderToast();
      }, 15000);

      try {
        sendEstimate = await sendRuntimeMessage<{ estimated: number; suggested: number }>({
          type: "wallet_estimate_transaction",
          contract: sendContract,
          function: sendFunction,
          kwargs: sendParsedKwargs
        });
        clearTimeout(timeout);
        sendStep = "review";
        render(state);
      } catch (error) {
        clearTimeout(timeout);
        reviewBtn.disabled = false;
        reviewBtn.textContent = originalText;
        setFlash(formatError(error), "danger");
        renderToast();
      }
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
    btn.addEventListener("click", async () => {
      const id = btn.dataset.deleteContact;
      contacts = contacts.filter((c) => c.id !== id);
      await sendRuntimeMessage<null>({ type: "contacts_save", contacts });
      setFlash("Contact removed.", "info");
      render(state);
    });
  }

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
      render(state);
    });

  root
    .querySelector<HTMLElement>("[data-approve-inline]")
    ?.addEventListener("click", async () => {
      const id =
        root.querySelector<HTMLElement>("[data-approve-inline]")?.dataset
          .approveInline;
      if (!id) {
        return;
      }
      try {
        await sendRuntimeMessage<null>({
          type: "approval_resolve",
          approvalId: id,
          approved: true
        });
        activeApprovalId = null;
        await refresh({ tone: "success", message: "Approved." });
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
    });

  root
    .querySelector<HTMLElement>("[data-reject-inline]")
    ?.addEventListener("click", async () => {
      const id =
        root.querySelector<HTMLElement>("[data-reject-inline]")?.dataset
          .rejectInline;
      if (!id) {
        return;
      }
      try {
        await sendRuntimeMessage<null>({
          type: "approval_resolve",
          approvalId: id,
          approved: false
        });
        activeApprovalId = null;
        await refresh({ tone: "info", message: "Rejected." });
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
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

      try {
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
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
    });
  }

  root
    .querySelector<HTMLElement>("[data-toggle-auto-lock]")
    ?.addEventListener("click", async () => {
      autoLockEnabled = !autoLockEnabled;
      await sendRuntimeMessage<null>({
        type: "wallet_set_auto_lock",
        enabled: autoLockEnabled
      });
      setFlash(autoLockEnabled ? "Auto-lock enabled." : "Auto-lock disabled.", "success");
      render(state);
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
    ?.addEventListener("click", async () => {
      try {
        await sendRuntimeMessage<PopupState>({
          type: "wallet_remove"
        });
        confirmWalletRemoval = false;
        resetSendState();
        await refresh({
          tone: "info",
          message: "Wallet removed."
        });
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
    });

  for (const button of root.querySelectorAll<HTMLButtonElement>(
    "[data-switch-network]"
  )) {
    button.addEventListener("click", async () => {
      const presetId = button.dataset.switchNetwork ?? "";
      try {
        resetNetworkDraft();
        await sendRuntimeMessage<PopupState>({
          type: "wallet_switch_network",
          presetId
        });
        await refresh({
          tone: "success",
          message: "Switched active network preset."
        });
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
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
      try {
        resetNetworkDraft();
        await sendRuntimeMessage<PopupState>({
          type: "wallet_remove_network_preset",
          presetId
        });
        await refresh({
          tone: "success",
          message: "Network preset deleted."
        });
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
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
    ?.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const editingExistingPreset = Boolean(networkDraft?.id);
        await sendRuntimeMessage<PopupState>({
          type: "wallet_save_network_preset",
          id: networkDraft?.id,
          name: value("#network-name"),
          chainId: value("#network-chain-id") || undefined,
          rpcUrl: value("#network-rpc-url"),
          dashboardUrl: value("#network-dashboard-url") || undefined,
          makeActive: checked("#network-make-active")
        });
        resetNetworkDraft();
        await refresh({
          tone: "success",
          message: editingExistingPreset
            ? "Network preset updated."
            : "Network preset created."
        });
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
    });

  root
    .querySelector<HTMLElement>("[data-export-mnemonic]")
    ?.addEventListener("click", async (event) => {
      event.preventDefault();
      try {
        revealedMnemonic = await sendRuntimeMessage<string>({
          type: "wallet_reveal_mnemonic",
          password: value("#export-password")
        });
        setFlash("Recovery seed revealed. Store it offline.", "warning");
        render(state);
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
    });

  root
    .querySelector<HTMLElement>("[data-export-private-key]")
    ?.addEventListener("click", async (event) => {
      event.preventDefault();
      try {
        revealedPrivateKey = await sendRuntimeMessage<string>({
          type: "wallet_reveal_private_key",
          password: value("#export-password")
        });
        setFlash("Private key revealed. Store it offline.", "warning");
        render(state);
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
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
    ?.addEventListener("click", async () => {
      const index = Number(
        root.querySelector<HTMLElement>("[data-confirm-delete-account]")?.dataset.confirmDeleteAccount
      );
      confirmDeleteAccountIndex = null;
      try {
        await sendRuntimeMessage<PopupState>({
          type: "wallet_remove_account",
          index
        });
        setFlash("Account removed.", "info");
        await refresh(null);
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
    });

  /* ── Export / Import ──────────────────────────────────────── */

  root
    .querySelector<HTMLFormElement>("#export-wallet-form")
    ?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const password = value("#backup-password");
      if (!password) return;
      try {
        const backup = await sendRuntimeMessage<Record<string, unknown>>({
          type: "wallet_export",
          password
        });
        const blob = new Blob([JSON.stringify(backup, null, 2)], {
          type: "application/json"
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `xian-wallet-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        setFlash("Wallet exported.", "success");
        render(state);
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
    });

  root
    .querySelector<HTMLElement>("[data-import-trigger]")
    ?.addEventListener("click", () => {
      root.querySelector<HTMLInputElement>("#import-wallet-file")?.click();
    });

  root
    .querySelector<HTMLInputElement>("#import-wallet-file")
    ?.addEventListener("change", async (event) => {
      const input = event.target as HTMLInputElement;
      const file = input.files?.[0];
      if (!file) return;

      const password = value("#backup-password");
      if (!password) {
        setFlash("Enter a password first. It will encrypt the imported wallet.", "warning");
        render(state);
        return;
      }

      try {
        const text = await file.text();
        const backup = JSON.parse(text);
        if (!backup || backup.version !== 1 || !backup.type) {
          setFlash("Invalid backup file.", "danger");
          render(state);
          return;
        }
        await sendRuntimeMessage<PopupState>({
          type: "wallet_import_backup",
          backup,
          password
        });
        resetSendState();
        await refresh({
          tone: "success",
          message: "Wallet imported."
        });
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
    });
}

/* ── DOM helpers ───────────────────────────────────────────── */

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

/* ── Init ──────────────────────────────────────────────────── */

chrome.runtime.onMessage.addListener(
  (message: { type?: string; approvalId?: string }) => {
    if (message.type === "approval_notify" && message.approvalId) {
      activeApprovalId = message.approvalId;
      void refresh(null);
    }
  }
);

window.addEventListener("beforeunload", () => {
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
