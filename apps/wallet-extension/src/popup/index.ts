import { truncateAddress, type ApprovalView, type PopupState } from "@xian/wallet-core";

import {
  popupStateBanner,
  sendRuntimeMessage,
  type WalletCreateRuntimeResult
} from "../shared/messages";

const appRoot = document.querySelector<HTMLElement>("#app");
if (!appRoot) {
  throw new Error("missing popup root");
}

const root = appRoot;

type PopupTab = "overview" | "apps" | "security";
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

let currentState: PopupState | null = null;
let generatedMnemonic: string | null = null;
let revealedMnemonic: string | null = null;
let activeTab: PopupTab = "overview";
let setupMode: SetupMode = "create";
let flash: FlashMessage | null = null;
let networkDraft: NetworkDraft | null = null;

function renderLoading(): void {
  root.innerHTML = `
    <section class="hero-panel stack">
      <p class="eyebrow">Xian Wallet</p>
      <h1>Loading wallet state...</h1>
      <p class="muted">Preparing the extension shell and encrypted local state.</p>
    </section>
  `;
}

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

function bannerHtml(): string {
  if (!flash) {
    return "";
  }
  return `
    <div class="banner banner-${flash.tone}">
      ${escapeHtml(flash.message)}
    </div>
  `;
}

function setFlash(message: string, tone: FlashTone = "info"): void {
  flash = { message, tone };
}

function clearFlash(): void {
  flash = null;
}

function setActiveTab(tab: PopupTab): void {
  activeTab = tab;
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

function defaultNetworkDraft(state: PopupState): NetworkDraft {
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

async function refresh(nextFlash?: FlashMessage | null): Promise<void> {
  if (nextFlash !== undefined) {
    flash = nextFlash;
  }
  currentState = await sendRuntimeMessage<PopupState>({
    type: "wallet_get_popup_state"
  });

  if (!currentState.hasWallet || !currentState.unlocked) {
    revealedMnemonic = null;
    networkDraft = null;
  }
  if (!currentState.unlocked) {
    generatedMnemonic = null;
  }

  render(currentState);
}

function render(state: PopupState | null): void {
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

function renderSetup(state: PopupState | null): void {
  const createSelected = setupMode === "create";
  const mnemonicSelected = setupMode === "importMnemonic";
  const privateKeySelected = setupMode === "importPrivateKey";
  const defaultRpc = state?.rpcUrl ?? "";
  const defaultDashboard = state?.dashboardUrl ?? "";

  root.innerHTML = `
    <div class="app-shell stack">
      <section class="hero-panel stack">
        <p class="eyebrow">Xian Wallet</p>
        <h1>Self-custody for Xian apps</h1>
        <p class="muted">
          Approve connections and signatures in a focused wallet flow. Keys stay
          encrypted in the extension background worker.
        </p>
        ${bannerHtml()}
        <div class="metric-grid">
          <article class="metric-card">
            <span class="metric-label">Provider</span>
            <strong>Injected</strong>
            <span class="metric-caption"><code>window.xian</code> for web apps</span>
          </article>
          <article class="metric-card">
            <span class="metric-label">Custody</span>
            <strong>Local only</strong>
            <span class="metric-caption">Encrypted in browser storage</span>
          </article>
        </div>
      </section>

      <section class="shell-card stack panel-shell">
        <div class="section-head">
          <div>
            <h2>Set up wallet</h2>
            <p class="muted">Choose one clear setup path.</p>
          </div>
        </div>

        <div class="segmented tab-bar" role="tablist" aria-label="Wallet setup mode">
          <button type="button" class="tab-button ${createSelected ? "is-active" : ""}" data-setup-mode="create">
            Create new
          </button>
          <button type="button" class="tab-button ${mnemonicSelected ? "is-active" : ""}" data-setup-mode="importMnemonic">
            Import phrase
          </button>
          <button type="button" class="tab-button ${privateKeySelected ? "is-active" : ""}" data-setup-mode="importPrivateKey">
            Import key
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
                  <strong>Create a new recovery phrase</strong>
                  <p class="muted">
                    The wallet will generate a fresh BIP39 phrase. You will need to
                    write it down before using the wallet.
                  </p>
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
                <div class="banner banner-warning">
                  Never enter a recovery phrase on a website or in chat. Only enter it inside the wallet itself.
                </div>
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
                  <strong>No recovery phrase stored</strong>
                  <p class="muted">
                    Importing a raw private key skips phrase backup and recovery support.
                  </p>
                </div>
              `
              : ""
          }

          <details class="disclosure">
            <summary>Advanced network settings</summary>
            <div class="stack">
              <label>
                Network label
                <input id="setup-network-name" value="Local node" />
              </label>
              <label>
                Expected chain ID
                <input id="setup-expected-chain-id" placeholder="Optional, for example xian-1" />
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

          <button type="submit">
            ${
              createSelected
                ? "Create wallet"
                : mnemonicSelected
                  ? "Import recovery phrase"
                  : "Import private key"
            }
          </button>
        </form>
      </section>
    </div>
  `;

  bindSetupEvents();
}

function renderLocked(state: PopupState): void {
  root.innerHTML = `
    <div class="app-shell stack">
      <section class="hero-panel stack">
        <div class="hero-head">
          <div>
            <p class="eyebrow">Xian Wallet</p>
            <h1>${escapeHtml(truncateAddress(state.publicKey))}</h1>
            <p class="muted">${escapeHtml(popupStateBanner(state))}</p>
          </div>
          <div class="pill">${escapeHtml(state.chainId ?? "Unknown chain")}</div>
        </div>
        ${bannerHtml()}
        <div class="metric-grid">
          <article class="metric-card">
            <span class="metric-label">Address</span>
            <strong>Ready</strong>
            <span class="metric-caption code">${escapeHtml(state.publicKey ?? "unknown")}</span>
          </article>
          <article class="metric-card">
            <span class="metric-label">Approvals</span>
            <strong>${state.pendingApprovalCount}</strong>
            <span class="metric-caption">Pending wallet actions</span>
          </article>
        </div>
      </section>

      <section class="shell-card stack panel-shell">
        <div class="section-head">
          <div>
            <h2>Unlock wallet</h2>
            <p class="muted">Unlock before sites can reconnect or request signatures.</p>
          </div>
        </div>
        <form id="unlock-form" class="stack">
          <label>
            Password
            <input id="unlock-password" type="password" required autocomplete="current-password" />
          </label>
          <button type="submit">Unlock</button>
        </form>
      </section>
    </div>
  `;

  root
    .querySelector<HTMLFormElement>("#unlock-form")
    ?.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await sendRuntimeMessage<PopupState>({
          type: "wallet_unlock",
          password: value("#unlock-password")
        });
        activeTab = "overview";
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

function renderUnlocked(state: PopupState): void {
  const pendingLabel =
    state.pendingApprovalCount === 1 ? "1 request waiting" : `${state.pendingApprovalCount} requests waiting`;
  const networkTone = toneForNetworkStatus(state.networkStatus);
  const activeNetworkLabel = state.activeNetworkName ?? "Network";

  root.innerHTML = `
    <div class="app-shell stack">
      <section class="hero-panel stack">
        <div class="hero-head">
          <div>
            <p class="eyebrow">Xian Wallet</p>
            <h1>${escapeHtml(truncateAddress(state.publicKey))}</h1>
            <p class="muted">${escapeHtml(popupStateBanner(state))}</p>
          </div>
          <div class="stack stack-tight hero-side">
            <div class="pill pill-strong">${escapeHtml(pendingLabel)}</div>
            <div class="pill">${escapeHtml(activeNetworkLabel)}</div>
            <div class="pill pill-${networkTone}">${escapeHtml(networkStatusLabel(state))}</div>
          </div>
        </div>
        ${bannerHtml()}
        <div class="metric-grid">
          <article class="metric-card">
            <span class="metric-label">Connected apps</span>
            <strong>${state.connectedOrigins.length}</strong>
            <span class="metric-caption">Revokable per site</span>
          </article>
          <article class="metric-card">
            <span class="metric-label">Assets</span>
            <strong>${state.watchedAssets.length}</strong>
            <span class="metric-caption">Pinned native XIAN included</span>
          </article>
          <article class="metric-card">
            <span class="metric-label">Backup</span>
            <strong>${escapeHtml(state.hasRecoveryPhrase ? "Available" : "Key only")}</strong>
            <span class="metric-caption">
              ${
                state.seedSource === "mnemonic"
                  ? `${state.mnemonicWordCount ?? 12}-word phrase`
                  : "Imported private key"
              }
            </span>
          </article>
          <article class="metric-card">
            <span class="metric-label">Network</span>
            <strong>${escapeHtml(activeNetworkLabel)}</strong>
            <span class="metric-caption">${escapeHtml(networkStatusDescription(state))}</span>
          </article>
        </div>
        <div class="action-row">
          <button type="button" data-copy-address>Copy address</button>
          <button type="button" data-open-dashboard class="ghost">Open dashboard</button>
          <button type="button" data-lock class="secondary">Lock</button>
        </div>
      </section>

      <nav class="segmented tab-bar" aria-label="Wallet navigation">
        <button type="button" class="tab-button ${activeTab === "overview" ? "is-active" : ""}" data-tab="overview">
          Overview
        </button>
        <button type="button" class="tab-button ${activeTab === "apps" ? "is-active" : ""}" data-tab="apps">
          Apps
        </button>
        <button type="button" class="tab-button ${activeTab === "security" ? "is-active" : ""}" data-tab="security">
          Security
        </button>
      </nav>

      <section class="shell-card stack panel-shell">
        ${renderTabPanel(state)}
      </section>
    </div>
  `;

  bindUnlockedEvents(state);
}

function renderTabPanel(state: PopupState): string {
  switch (activeTab) {
    case "overview":
      return renderOverviewTab(state);
    case "apps":
      return renderAppsTab(state);
    case "security":
      return renderSecurityTab(state);
  }
}

function renderOverviewTab(state: PopupState): string {
  const assetsHtml =
    state.watchedAssets.length === 0
      ? `<div class="empty muted">No assets added yet.</div>`
      : `
          <div class="list">
            ${state.watchedAssets
              .map((asset) => renderAssetCard(asset))
              .join("")}
          </div>
        `;

  const approvalsHtml =
    state.pendingApprovals.length === 0
      ? `
          <div class="empty muted">
            No approvals waiting. Sites will open focused approval windows when they need action.
          </div>
        `
      : `
          <div class="list">
            ${state.pendingApprovals.map((approval) => renderPendingApprovalCard(approval)).join("")}
          </div>
        `;

  return `
    <div class="stack">
      <div class="section-head">
        <div>
          <h2>Overview</h2>
          <p class="muted">Current account, active network, and pending wallet work.</p>
        </div>
      </div>

      <div class="card-grid">
        <article class="detail-card stack">
          <div class="section-head">
            <div>
              <h3>Account</h3>
              <p class="muted">The address dapps can request access to.</p>
            </div>
          </div>
          <div class="code-block">${escapeHtml(state.publicKey ?? "unknown")}</div>
          <div class="detail-grid">
            <div class="detail-row">
              <span>Seed source</span>
              <strong>${escapeHtml(state.seedSource === "mnemonic" ? "Recovery phrase" : "Private key")}</strong>
            </div>
            <div class="detail-row">
              <span>Backup</span>
              <strong>${escapeHtml(state.hasRecoveryPhrase ? "Stored" : "Not stored")}</strong>
            </div>
          </div>
        </article>

        <article class="detail-card stack">
          <div class="section-head">
            <div>
              <h3>Network</h3>
              <p class="muted">Read-only summary. Edit URLs in Security.</p>
            </div>
          </div>
          <div class="detail-grid">
            <div class="detail-row">
              <span>Chain</span>
              <strong>${escapeHtml(state.chainId ?? "Unreachable")}</strong>
            </div>
            <div class="detail-row">
              <span>Configured network</span>
              <strong>${escapeHtml(state.activeNetworkName ?? "Unknown")}</strong>
            </div>
            <div class="detail-row">
              <span>Status</span>
              <strong>${escapeHtml(networkStatusLabel(state))}</strong>
            </div>
            ${
              state.configuredChainId
                ? `
                    <div class="detail-row">
                      <span>Expected chain ID</span>
                      <strong>${escapeHtml(state.configuredChainId)}</strong>
                    </div>
                  `
                : ""
            }
            <div class="detail-row">
              <span>RPC</span>
              <span class="code code-inline">${escapeHtml(state.rpcUrl)}</span>
            </div>
            <div class="detail-row">
              <span>Dashboard</span>
              <span class="code code-inline">${escapeHtml(state.dashboardUrl ?? "Not set")}</span>
            </div>
          </div>
        </article>
      </div>

      <section class="stack">
        <div class="section-head">
          <div>
            <h3>Pending approvals</h3>
            <p class="muted">Requests always need explicit approval.</p>
          </div>
        </div>
        ${approvalsHtml}
      </section>

      <section class="stack">
        <div class="section-head">
          <div>
            <h3>Assets</h3>
            <p class="muted">Native XIAN stays pinned. Added assets can be removed here.</p>
          </div>
        </div>
        ${assetsHtml}
      </section>
    </div>
  `;
}

function renderAppsTab(state: PopupState): string {
  const appsHtml =
    state.connectedOrigins.length === 0
      ? `
          <div class="empty muted">
            No connected sites yet. Wallet connections only expose your active address and still require per-action approvals.
          </div>
        `
      : `
          <div class="list">
            ${state.connectedOrigins
              .map((origin) => renderOriginCard(origin))
              .join("")}
          </div>
        `;

  return `
    <div class="stack">
      <div class="section-head">
        <div>
          <h2>Connected apps</h2>
          <p class="muted">
            Disconnect sites you no longer trust or use. Future actions from disconnected sites will require a new connect approval.
          </p>
        </div>
        ${
          state.connectedOrigins.length > 1
            ? `<button type="button" class="ghost" data-disconnect-all>Disconnect all</button>`
            : ""
        }
      </div>
      ${appsHtml}
    </div>
  `;
}

function renderSecurityTab(state: PopupState): string {
  const networkWarning =
    state.networkStatus === "mismatch"
      ? `
          <div class="banner banner-danger">
            Configured chain and resolved chain do not match. Verify the RPC URL and expected chain ID before approving transactions.
          </div>
        `
      : state.networkStatus === "unreachable"
        ? `
            <div class="banner banner-warning">
              The active RPC is unreachable right now. Signing still uses the configured network preset, but live chain checks are unavailable.
            </div>
          `
        : "";
  const recoverySection = state.hasRecoveryPhrase
    ? `
        <article class="detail-card stack">
          <div class="section-head">
            <div>
              <h3>Recovery phrase</h3>
              <p class="muted">
                This wallet is backed by a ${state.mnemonicWordCount ?? 12}-word phrase.
                Reveal it only on a trusted device and store it offline.
              </p>
            </div>
          </div>
          ${
            generatedMnemonic
              ? renderPhraseCard("Write this down now", generatedMnemonic, "warning")
              : ""
          }
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
        </article>
      `
    : `
        <article class="detail-card stack">
          <div class="section-head">
            <div>
              <h3>Recovery phrase</h3>
              <p class="muted">
                This wallet was imported from a private key. No recovery phrase is stored.
              </p>
            </div>
          </div>
          <div class="empty muted">
            Consider migrating to a phrase-backed wallet before using this for meaningful value.
          </div>
        </article>
      `;

  return `
    <div class="stack">
      <div class="banner banner-warning">
        Never enter your recovery phrase into a website, support chat, or transaction prompt.
      </div>
      ${networkWarning}

      <div class="card-grid">
        <article class="detail-card stack">
          <div class="section-head">
            <div>
              <h2>Security</h2>
              <p class="muted">Backup, recovery, and network safety live here.</p>
            </div>
          </div>
          <div class="detail-grid">
            <div class="detail-row">
              <span>Wallet type</span>
              <strong>${escapeHtml(state.seedSource === "mnemonic" ? "Phrase-backed" : "Private key")}</strong>
            </div>
            <div class="detail-row">
              <span>Backup status</span>
              <strong>${escapeHtml(state.hasRecoveryPhrase ? "Recovery phrase stored" : "No recovery phrase")}</strong>
            </div>
            <div class="detail-row">
              <span>Current chain</span>
              <strong>${escapeHtml(state.chainId ?? "Unreachable")}</strong>
            </div>
            <div class="detail-row">
              <span>Preset</span>
              <strong>${escapeHtml(state.activeNetworkName ?? "Unknown")}</strong>
            </div>
            <div class="detail-row">
              <span>Status</span>
              <strong>${escapeHtml(networkStatusLabel(state))}</strong>
            </div>
          </div>
        </article>

        <article class="detail-card stack">
          <div class="section-head">
            <div>
              <h3>Network presets</h3>
              <p class="muted">Save trusted networks once, switch between them explicitly, and keep expected chain IDs attached to the preset.</p>
            </div>
            <button type="button" class="ghost" data-new-network>New preset</button>
          </div>
          <div class="list">
            ${state.networkPresets
              .map((preset) => renderNetworkPresetCard(state, preset))
              .join("")}
          </div>
          ${renderNetworkEditor(state)}
        </article>
      </div>

      ${recoverySection}
    </div>
  `;
}

function renderPhraseCard(title: string, phrase: string, tone: "warning" | "info"): string {
  return `
    <div class="banner banner-${tone}">
      <strong>${escapeHtml(title)}</strong>
      <div class="recovery-phrase">${escapeHtml(phrase)}</div>
    </div>
  `;
}

function toneForNetworkStatus(
  status: PopupState["networkStatus"]
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

function networkStatusLabel(state: PopupState): string {
  switch (state.networkStatus) {
    case "ready":
      return `Ready on ${state.chainId ?? "current chain"}`;
    case "unreachable":
      return "RPC unreachable";
    case "mismatch":
      return "Chain mismatch";
  }
}

function networkStatusDescription(state: PopupState): string {
  switch (state.networkStatus) {
    case "ready":
      return state.chainId ?? "Connected";
    case "unreachable":
      return "Live chain ID unavailable";
    case "mismatch":
      return state.configuredChainId
        ? `Expected ${state.configuredChainId}, got ${state.resolvedChainId ?? "unknown"}`
        : "Resolved chain differs from preset";
  }
}

function renderNetworkPresetCard(
  state: PopupState,
  preset: PopupState["networkPresets"][number]
): string {
  const isActive = preset.id === state.activeNetworkId;
  const expectedChain = preset.chainId ?? "Inferred from RPC";
  return `
    <article class="list-card stack">
      <div class="row row-top">
        <div>
          <div class="item-title">${escapeHtml(preset.name)}</div>
          <div class="muted">${escapeHtml(expectedChain)}</div>
        </div>
        <div class="inline-actions">
          ${isActive ? `<div class="pill pill-strong">Active</div>` : `<button type="button" class="ghost" data-switch-network="${escapeAttribute(preset.id)}">Use</button>`}
          ${preset.builtin ? "" : `<button type="button" class="ghost" data-edit-network="${escapeAttribute(preset.id)}">Edit</button>`}
          ${preset.builtin ? "" : `<button type="button" class="ghost" data-delete-network="${escapeAttribute(preset.id)}">Delete</button>`}
        </div>
      </div>
      <div class="detail-grid">
        <div class="detail-row">
          <span>RPC</span>
          <span class="code code-inline">${escapeHtml(preset.rpcUrl)}</span>
        </div>
        <div class="detail-row">
          <span>Dashboard</span>
          <span class="code code-inline">${escapeHtml(preset.dashboardUrl ?? "Not set")}</span>
        </div>
      </div>
    </article>
  `;
}

function renderNetworkEditor(state: PopupState): string {
  if (!networkDraft) {
    return `
      <div class="surface surface-quiet">
        <strong>Add a custom network when you need a non-local RPC.</strong>
        <p class="muted">
          Saved presets make popup switching clearer and give injected dapps a configured target for <code>xian_switchChain</code>.
        </p>
      </div>
    `;
  }

  return `
    <form id="network-form" class="stack surface">
      <div class="section-head">
        <div>
          <h3>${escapeHtml(networkDraft.id ? "Edit preset" : "New preset")}</h3>
          <p class="muted">Use explicit labels and expected chain IDs whenever you know them.</p>
        </div>
      </div>
      <label>
        Network label
        <input id="network-name" value="${escapeAttribute(networkDraft.name)}" />
      </label>
      <label>
        Expected chain ID
        <input id="network-chain-id" value="${escapeAttribute(networkDraft.chainId)}" placeholder="Optional, for example xian-1" />
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
        <span>Use this preset immediately after saving</span>
      </label>
      <div class="action-row">
        <button type="submit">${escapeHtml(networkDraft.id ? "Save preset" : "Create preset")}</button>
        <button type="button" class="ghost" data-cancel-network>Cancel</button>
      </div>
      ${
        state.activeNetworkId && networkDraft.id === state.activeNetworkId
          ? `<div class="muted">This edits the currently active preset.</div>`
          : ""
      }
    </form>
  `;
}

function renderPendingApprovalCard(approval: ApprovalView): string {
  const summary = approval.highlights?.[0] ?? approval.description;

  return `
    <article class="list-card stack">
      <div class="row row-top">
        <div>
          <div class="item-title">${escapeHtml(approval.title)}</div>
          <div class="muted">${escapeHtml(safeOriginLabel(approval.origin))}</div>
        </div>
        <div class="pill">${escapeHtml(formatTimestamp(approval.createdAt))}</div>
      </div>
      <p class="muted">${escapeHtml(summary)}</p>
      <div class="inline-actions">
        <button type="button" class="ghost" data-open-approval="${escapeAttribute(approval.id)}">
          Review request
        </button>
      </div>
    </article>
  `;
}

function renderOriginCard(origin: string): string {
  return `
    <article class="list-card stack">
      <div class="row row-top">
        <div>
          <div class="item-title">${escapeHtml(safeOriginLabel(origin))}</div>
          <div class="code">${escapeHtml(origin)}</div>
        </div>
        <button type="button" class="ghost" data-disconnect-origin="${escapeAttribute(origin)}">
          Disconnect
        </button>
      </div>
      <p class="muted">
        This site can view your current address and ask for explicit approvals.
      </p>
    </article>
  `;
}

function renderAssetCard(asset: PopupState["watchedAssets"][number]): string {
  const removeButton =
    asset.contract === "currency"
      ? `<div class="pill">Pinned</div>`
      : `
          <button type="button" class="ghost" data-remove-asset="${escapeAttribute(asset.contract)}">
            Remove
          </button>
        `;

  return `
    <article class="list-card stack">
      <div class="row row-top">
        <div>
          <div class="item-title">${escapeHtml(asset.symbol ?? asset.contract)}</div>
          <div class="muted">${escapeHtml(asset.name ?? "Unnamed asset")}</div>
        </div>
        ${removeButton}
      </div>
      <div class="code">${escapeHtml(asset.contract)}</div>
      ${
        typeof asset.decimals === "number"
          ? `<div class="muted">Decimals: ${asset.decimals}</div>`
          : ""
      }
    </article>
  `;
}

function bindSetupEvents(): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-setup-mode]")) {
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
            setupMode === "importMnemonic" ? value("#setup-mnemonic") || undefined : undefined,
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
        activeTab = generatedMnemonic ? "security" : "overview";
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

function bindUnlockedEvents(state: PopupState): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
    button.addEventListener("click", () => {
      clearFlash();
      setActiveTab(button.dataset.tab as PopupTab);
    });
  }

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-copy-address]")) {
    button.addEventListener("click", async () => {
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
    .querySelector<HTMLButtonElement>("[data-open-dashboard]")
    ?.addEventListener("click", async () => {
      if (!state.dashboardUrl) {
        setFlash("No dashboard URL configured.", "warning");
        render(state);
        return;
      }

      try {
        await chrome.tabs.create({ url: state.dashboardUrl });
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
    });

  root
    .querySelector<HTMLButtonElement>("[data-lock]")
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

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-disconnect-origin]")) {
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

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-remove-asset]")) {
    button.addEventListener("click", async () => {
      const contract = button.dataset.removeAsset ?? "";
      try {
        await sendRuntimeMessage<PopupState>({
          type: "wallet_remove_asset",
          contract
        });
        await refresh({
          tone: "success",
          message: "Asset removed from wallet list."
        });
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
    });
  }

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-open-approval]")) {
    button.addEventListener("click", async () => {
      const approvalId = button.dataset.openApproval;
      if (!approvalId) {
        return;
      }
      try {
        await chrome.windows.create({
          url: chrome.runtime.getURL(`approval.html?approvalId=${approvalId}`),
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

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-switch-network]")) {
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

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-edit-network]")) {
    button.addEventListener("click", () => {
      const presetId = button.dataset.editNetwork;
      const preset = state.networkPresets.find((entry) => entry.id === presetId);
      if (!preset) {
        return;
      }
      clearFlash();
      setNetworkDraft(draftFromPreset(preset));
    });
  }

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-delete-network]")) {
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
        setFlash("Recovery phrase revealed. Store it offline.", "warning");
        render(state);
      } catch (error) {
        setFlash(formatError(error), "danger");
        render(state);
      }
    });
}

function value(selector: string): string {
  const element = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
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

renderLoading();
void refresh(null);
