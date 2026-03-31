import { truncateAddress, type ApprovalView, type PopupState } from "@xian-tech/wallet-core";
import { encode as encodeQr } from "uqr";

import {
  type PopupRuntimeState,
  popupStateBanner,
  sendRuntimeMessage,
  type WalletCreateRuntimeResult
} from "../shared/messages";
import type { WalletShellMode } from "../shared/preferences";

const appRoot = document.querySelector<HTMLElement>("#app");
if (!appRoot) {
  throw new Error("missing popup root");
}

const root = appRoot;

/* ── Types ─────────────────────────────────────────────────── */

type PopupTab = "home" | "send" | "apps" | "security";
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
  repeat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>'
};

/* ── State ─────────────────────────────────────────────────── */

let currentState: PopupRuntimeState | null = null;
let generatedMnemonic: string | null = null;
let revealedMnemonic: string | null = null;
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

/* ── Send tab state ────────────────────────────────────────── */

type TxArgType = "str" | "int" | "float" | "bool" | "dict" | "list" | "datetime" | "timedelta" | "Any";
type SendStep = "draft" | "review" | "sending" | "result";

interface TxArg {
  id: string;
  name: string;
  value: string;
  type: TxArgType;
  fixed?: boolean;
}

let sendStep: SendStep = "draft";
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
  sendStep = "draft";
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

function parseArgValue(val: string, type: TxArgType): unknown {
  switch (type) {
    case "str":
    case "Any":
      return val;
    case "int": {
      const n = parseInt(val, 10);
      return Number.isFinite(n) ? n : val;
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll("`", "&#96;");
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

/* ── Flash ─────────────────────────────────────────────────── */

function flashHtml(): string {
  if (!flash) {
    return "";
  }
  return `<div class="flash-toast flash-${flash.tone}">${escapeHtml(flash.message)}</div>`;
}

function setFlash(message: string, tone: FlashTone = "info"): void {
  flash = { message, tone };
}

function clearFlash(): void {
  flash = null;
}

/* ── State setters ─────────────────────────────────────────── */

function setActiveTab(tab: PopupTab): void {
  activeTab = tab;
  selectedAsset = null;
  tokenMeta = null;
  tokenMetaLoading = false;
  showReceive = false;
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

  if (!currentState.hasWallet || !currentState.unlocked) {
    revealedMnemonic = null;
    networkDraft = null;
  }
  if (!currentState.unlocked) {
    generatedMnemonic = null;
    resetSendState();
  }

  balancesLoading =
    currentState.unlocked && currentState.watchedAssets.length > 0;
  render(currentState);
  void refreshBalances();
}

async function refreshBalances(): Promise<void> {
  if (!currentState?.unlocked || !currentState.watchedAssets.length) {
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
    return;
  }

  if (!state.unlocked) {
    renderLocked(state);
    return;
  }

  renderUnlocked(state);
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

      ${flashHtml()}

      <div class="setup-form">
        <div class="segmented tab-bar" role="tablist" aria-label="Wallet setup mode">
          <button type="button" class="tab-button ${createSelected ? "is-active" : ""}" data-setup-mode="create">
            Create
          </button>
          <button type="button" class="tab-button ${mnemonicSelected ? "is-active" : ""}" data-setup-mode="importMnemonic">
            Phrase
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
                    <strong>New recovery phrase</strong>
                    <p class="muted text-sm">A BIP39 phrase will be generated. Back it up before closing.</p>
                  </div>
                `
              : ""
          }

          ${
            mnemonicSelected
              ? `
                  <label>
                    Recovery phrase
                    <textarea id="setup-mnemonic" placeholder="Enter your 12 or 24 word BIP39 phrase" required></textarea>
                  </label>
                  <div class="banner banner-warning">Only enter your phrase inside this wallet. Never on a website or in chat.</div>
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
                  <div class="surface surface-quiet">
                    <strong>No recovery phrase</strong>
                    <p class="muted text-sm">Raw key import. No phrase backup or recovery.</p>
                  </div>
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
                  ? "Import recovery phrase"
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
      ${flash ? `<div class="flash-toast flash-${flash.tone}" style="margin-top: 12px; width: 100%; max-width: 300px">${escapeHtml(flash.message)}</div>` : ""}
      <form id="unlock-form" class="lock-body">
        <label>
          Password
          <input id="unlock-password" type="password" required autocomplete="current-password" />
        </label>
        <button type="submit" class="full-width">Unlock</button>
      </form>
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
      } catch (error) {
        setFlash(formatError(error), "danger");
        renderLocked(state);
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

  root.innerHTML = `
    <div class="wallet-app">
      <header class="wallet-header">
        <div class="header-left">
          <img src="icon.png" alt="Xian" class="header-logo" />
        </div>
        <div class="header-right">
          <span class="header-network">
            <span class="header-dot${dotClass}"></span>
            ${escapeHtml(activeNetworkLabel)}
          </span>
          <button class="header-icon-btn" data-open-dashboard title="Open explorer">${ICONS.globe}</button>
          <button class="header-icon-btn" data-lock title="Lock wallet">${ICONS.lock}</button>
        </div>
      </header>

      <div class="wallet-content">
        ${flashHtml()}
        ${renderTabPanel(state)}
      </div>

      <nav class="wallet-nav">
        <button class="nav-item ${activeTab === "home" ? "is-active" : ""}" data-tab="home">
          ${ICONS.home}
          Home
        </button>
        <button class="nav-item ${activeTab === "send" ? "is-active" : ""}" data-tab="send">
          ${ICONS.send}
          Send
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
  switch (activeTab) {
    case "home":
      return renderHomeTab(state);
    case "send":
      return renderSendTab(state);
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

  const assetsHtml =
    state.watchedAssets.length === 0
      ? `<div class="token-list"><div style="padding: 24px 0; text-align: center" class="muted text-sm">No assets tracked yet.</div></div>`
      : `<div class="token-list">${state.watchedAssets.map((a) => renderAssetItem(a, state)).join("")}</div>`;

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
      <span class="section-hd-badge">${state.watchedAssets.length}</span>
    </div>
    ${assetsHtml}
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

function renderAssetItem(
  asset: PopupState["watchedAssets"][number],
  state: PopupRuntimeState
): string {
  const symbol = asset.symbol ?? asset.contract.slice(0, 6);
  const letter = symbol.charAt(0).toUpperCase();
  const color =
    asset.contract === "currency"
      ? "var(--accent-dim)"
      : assetColor(asset.contract);
  const isPinned = asset.contract === "currency";
  const rawBalance = state.assetBalances[asset.contract];
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
        <div class="token-fiat">${fiatHtml}</div>
      </div>
    </div>
  `;
}

function renderTokenDetail(state: PopupRuntimeState): string {
  const asset = state.watchedAssets.find(
    (a) => a.contract === selectedAsset
  );
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
  const rawBalance = state.assetBalances[asset.contract];
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

      ${
        !isPinned
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
  const letter = hostname.charAt(0).toUpperCase();

  return `
    <div class="app-item">
      <div class="token-icon" style="background: ${assetColor(origin)}">${escapeHtml(letter)}</div>
      <div class="app-item-info">
        <div class="app-item-host">${escapeHtml(hostname)}</div>
        <div class="app-item-url">${escapeHtml(origin)}</div>
      </div>
      <button class="ghost-sm" data-disconnect-origin="${escapeAttribute(origin)}">Disconnect</button>
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════
   SEND TAB
   ═══════════════════════════════════════════════════════════ */

function renderSendTab(_state: PopupRuntimeState): string {
  switch (sendStep) {
    case "draft":
      return renderSendDraft();
    case "review":
      return renderSendReview();
    case "sending":
      return renderSendSending();
    case "result":
      return renderSendResult();
  }
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
          <button class="ghost-sm" data-add-arg>Add</button>
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
    ? `${sendEstimate.suggested.toLocaleString()} (estimated ${sendEstimate.estimated.toLocaleString()} + margin)`
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

function renderSendResult(): string {
  if (!sendResult) {
    return renderSendDraft();
  }
  const ok = sendResult.finalized || sendResult.accepted === true;
  const tone = sendResult.finalized
    ? "success"
    : sendResult.accepted
      ? "info"
      : "danger";
  const label = sendResult.finalized
    ? "Transaction finalized"
    : sendResult.accepted
      ? "Transaction accepted"
      : sendResult.submitted
        ? "Transaction submitted but not accepted"
        : "Transaction failed";

  return `
    <div class="settings-wrap">
      <div class="banner banner-${tone}">
        <strong>${escapeHtml(label)}</strong>
        ${
          sendResult.message && !ok
            ? `<p class="text-sm" style="margin-top: 4px">${escapeHtml(String(sendResult.message))}</p>`
            : ""
        }
      </div>

      ${
        sendResult.txHash
          ? `
              <div class="s-card">
                <div class="s-card-body">
                  <div class="s-row">
                    <span class="s-row-key">TX Hash</span>
                    <span class="s-row-val mono">${escapeHtml(sendResult.txHash)}</span>
                  </div>
                </div>
              </div>
            `
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

      <div class="s-card">
        <div class="s-card-head">
          <div>
            <h3 class="s-card-title">Security</h3>
            <p class="s-card-desc">Wallet and network status.</p>
          </div>
        </div>
        <div class="s-card-body">
          <div class="s-row">
            <span class="s-row-key">Type</span>
            <span class="s-row-val">${escapeHtml(state.seedSource === "mnemonic" ? "Phrase-backed" : "Private key")}</span>
          </div>
          <div class="s-row">
            <span class="s-row-key">Backup</span>
            <span class="s-row-val">${escapeHtml(state.hasRecoveryPhrase ? "Phrase stored" : "No phrase")}</span>
          </div>
          <div class="s-row">
            <span class="s-row-key">Chain</span>
            <span class="s-row-val">${escapeHtml(state.chainId ?? "Unreachable")}</span>
          </div>
          <div class="s-row">
            <span class="s-row-key">Preset</span>
            <span class="s-row-val">${escapeHtml(state.activeNetworkName ?? "Unknown")}</span>
          </div>
          <div class="s-row">
            <span class="s-row-key">Status</span>
            <span class="s-row-val">${escapeHtml(networkStatusLabel(state))}</span>
          </div>
        </div>
      </div>

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

      ${renderRecoveryCard(state)}

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
    </div>
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

function renderRecoveryCard(state: PopupRuntimeState): string {
  if (!state.hasRecoveryPhrase) {
    return `
      <div class="s-card">
        <div class="s-card-head">
          <div>
            <h3 class="s-card-title">Recovery phrase</h3>
            <p class="s-card-desc">Imported from private key. No phrase stored.</p>
          </div>
        </div>
        <div class="s-card-body">
          <p class="muted text-sm">Consider migrating to a phrase-backed wallet for better recovery options.</p>
        </div>
      </div>
    `;
  }

  return `
    <div class="s-card">
      <div class="s-card-head">
        <div>
          <h3 class="s-card-title">Recovery phrase</h3>
          <p class="s-card-desc">${state.mnemonicWordCount ?? 12}-word phrase. Reveal on a trusted device only.</p>
        </div>
      </div>
      <div class="s-card-body stack">
        ${generatedMnemonic ? renderPhraseCard("Write this down now", generatedMnemonic, "warning") : ""}
        ${
          revealedMnemonic && revealedMnemonic !== generatedMnemonic
            ? renderPhraseCard("Recovered phrase", revealedMnemonic, "info")
            : ""
        }
        <form id="recovery-form" class="stack">
          <label>
            Password
            <input id="recovery-password" type="password" required autocomplete="current-password" />
          </label>
          <button type="submit" class="secondary">Reveal recovery phrase</button>
        </form>
      </div>
    </div>
  `;
}

function renderPhraseCard(
  title: string,
  phrase: string,
  tone: "warning" | "info"
): string {
  return `
    <div class="banner banner-${tone}">
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
      return `Ready on ${state.chainId ?? "current chain"}`;
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
            ? "Wallet created. Write down the recovery phrase before closing this popup."
            : `Wallet imported from ${result.importedSeedSource === "mnemonic" ? "recovery phrase" : "private key"}.`,
          "success"
        );
        render(currentState);
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
          ? sendEstimate.suggested
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

  for (const button of root.querySelectorAll<HTMLButtonElement>(
    "[data-open-approval]"
  )) {
    button.addEventListener("click", async () => {
      const approvalId = button.dataset.openApproval;
      if (!approvalId) {
        return;
      }
      try {
        await chrome.windows.create({
          url: chrome.runtime.getURL(
            `approval.html?approvalId=${approvalId}`
          ),
          type: "popup",
          width: 420,
          height: 700
        });
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
    });
  }

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
    .querySelector<HTMLFormElement>("#recovery-form")
    ?.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        revealedMnemonic = await sendRuntimeMessage<string>({
          type: "wallet_reveal_mnemonic",
          password: value("#recovery-password")
        });
        setFlash(
          "Recovery phrase revealed. Store it offline.",
          "warning"
        );
        render(state);
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
    return error.message;
  }
  return String(error);
}

/* ── Init ──────────────────────────────────────────────────── */

renderLoading();
void refresh(null);
