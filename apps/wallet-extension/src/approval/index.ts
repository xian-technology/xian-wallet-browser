import type { ApprovalView } from "@xian-tech/wallet-core";

import { sendRuntimeMessage } from "../shared/messages";

const appRoot = document.querySelector<HTMLElement>("#app");
if (!appRoot) {
  throw new Error("missing approval root");
}

const root = appRoot;

const approvalIdParam = new URLSearchParams(window.location.search).get("approvalId");
if (!approvalIdParam) {
  throw new Error("missing approval id");
}

const approvalId = approvalIdParam;
let currentView: ApprovalView | null = null;

type ApprovalTrustScope = NonNullable<ApprovalView["trustSuggestion"]>["exactScope"];

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

function renderDetailRow(detail: ApprovalDetailItem): string {
  return `
    <div class="detail-row detail-row-${detail.tone ?? "default"}">
      <span>${escapeHtml(detail.label)}</span>
      <strong class="${detail.monospace ? "code" : ""}">${escapeHtml(detail.value)}</strong>
    </div>
  `;
}

function renderTransactionFeePanel(detail: ApprovalDetailItem): string {
  return `
    <div class="surface transaction-fee-panel">
      <div class="section-head">
        <div>
          <h2>Transaction fee</h2>
        </div>
      </div>
      <div class="detail-grid">
        ${renderDetailRow(detail)}
      </div>
    </div>
  `;
}

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString();
}

function originLabel(origin: string): string {
  try {
    const url = new URL(origin);
    return url.hostname || origin;
  } catch {
    return origin;
  }
}

function toneForApproval(kind: ApprovalView["kind"]): "info" | "warning" | "danger" {
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

function riskLabel(kind: ApprovalView["kind"]): string {
  switch (kind) {
    case "connect":
      return "Connection request";
    case "watchAsset":
      return "Asset suggestion";
    case "signMessage":
      return "Signature required";
    case "sendCall":
      return "Broadcast request";
    case "sendTransaction":
      return "Prepared broadcast";
    case "signTransaction":
      return "Prepared signature";
  }
}

function renderTrustOptions(view: ApprovalView): string {
  if (!view.trustSuggestion) {
    return "";
  }
  return `
    <div class="trust-options">
      <label class="surface trust-option">
        <input id="trust-toggle" type="checkbox" />
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
        <input id="trust-broad-toggle" type="checkbox" />
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

function wireTrustOptions(): void {
  const exact = root.querySelector<HTMLInputElement>("#trust-toggle");
  const broad = root.querySelector<HTMLInputElement>("#trust-broad-toggle");
  exact?.addEventListener("change", () => {
    if (exact.checked && broad) broad.checked = false;
  });
  broad?.addEventListener("change", () => {
    if (broad.checked && exact) exact.checked = false;
  });
}

function selectedTrustScope(): ApprovalTrustScope | undefined {
  const suggestion = currentView?.trustSuggestion;
  if (!suggestion) {
    return undefined;
  }
  if (root.querySelector<HTMLInputElement>("#trust-broad-toggle")?.checked) {
    return suggestion.broadScope;
  }
  if (root.querySelector<HTMLInputElement>("#trust-toggle")?.checked) {
    return suggestion.exactScope;
  }
  return undefined;
}

function showBroadTrustConfirmation(): void {
  const suggestion = currentView?.trustSuggestion;
  if (!suggestion || root.querySelector("[data-broad-trust-confirmation]")) {
    return;
  }
  const dialog = document.createElement("div");
  dialog.dataset.broadTrustConfirmation = "true";
  dialog.innerHTML = `
    <div class="app-dialog-backdrop" role="presentation">
      <div class="app-dialog" role="dialog" aria-modal="true" aria-labelledby="broad-trust-title">
        <div class="app-dialog-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <path d="M12 9v4"/>
            <path d="M12 17h.01"/>
          </svg>
        </div>
        <h3 id="broad-trust-title" class="app-dialog-title">Enable broad auto-approval?</h3>
        <p class="app-dialog-copy">${escapeHtml(suggestion.broadWarning)}</p>
        <div class="app-dialog-value">${escapeHtml(suggestion.broadLabel)}</div>
        <div class="app-dialog-actions">
          <button class="secondary" data-cancel-broad-trust>Cancel</button>
          <button class="danger" data-confirm-broad-trust>Enable broad auto-approval</button>
        </div>
      </div>
    </div>
  `;
  root.appendChild(dialog);
  dialog
    .querySelector<HTMLButtonElement>("[data-cancel-broad-trust]")
    ?.addEventListener("click", () => dialog.remove());
  dialog
    .querySelector<HTMLButtonElement>("[data-confirm-broad-trust]")
    ?.addEventListener("click", async () => {
      dialog.remove();
      await resolveApproval(true, { confirmedBroad: true });
    });
}

async function render(): Promise<void> {
  const view = await sendRuntimeMessage<ApprovalView>({
    type: "approval_get",
    approvalId
  });
  currentView = view;

  const tone = toneForApproval(view.kind);
  const warnings = view.warnings ?? [];
  const highlights = view.highlights ?? [];
  const { summaryDetails, feeDetail } = splitFeeDetail(view.details ?? []);

  root.innerHTML = `
    <div class="app-shell stack">
      <section class="hero-panel stack">
        <div class="hero-head">
          <div>
            <p class="eyebrow">Approval request</p>
            <h1>${escapeHtml(view.title)}</h1>
            <p class="muted">${escapeHtml(view.description)}</p>
          </div>
          <div class="pill pill-${tone}">${escapeHtml(riskLabel(view.kind))}</div>
        </div>
        <div class="metric-grid metric-grid-compact">
          <article class="metric-card">
            <span class="metric-label">Site</span>
            <strong>${escapeHtml(originLabel(view.origin))}</strong>
            <span class="metric-caption code">${escapeHtml(view.origin)}</span>
          </article>
          <article class="metric-card">
            <span class="metric-label">Requested</span>
            <strong>${escapeHtml(formatTimestamp(view.createdAt))}</strong>
            <span class="metric-caption">${escapeHtml(view.chainId ?? "Chain unknown")}</span>
          </article>
        </div>
      </section>

      <section class="shell-card stack panel-shell">
        ${
          warnings.length > 0
            ? `
                <div class="banner banner-${tone}">
                  <strong>Review carefully</strong>
                  <ul class="inline-list">
                    ${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}
                  </ul>
                </div>
              `
            : ""
        }

        ${
          highlights.length > 0
            ? `
                <div class="surface">
                  <div class="section-head">
                    <div>
                      <h2>What stands out</h2>
                    </div>
                  </div>
                  <div class="tag-list">
                    ${highlights.map((item) => `<span class="tag">${escapeHtml(item)}</span>`).join("")}
                  </div>
                </div>
              `
            : ""
        }

        <section class="stack">
          <div class="section-head">
            <div>
              <h2>Summary</h2>
              <p class="muted">Check the important fields first.</p>
            </div>
          </div>
          <div class="detail-grid">
            ${
              summaryDetails.length > 0
                ? summaryDetails.map((detail) => renderDetailRow(detail)).join("")
                : `
                    <div class="empty muted">
                      No structured summary was available for this request. Review the raw payload below.
                    </div>
                  `
            }
          </div>
        </section>

        ${feeDetail ? renderTransactionFeePanel(feeDetail) : ""}

        <details class="disclosure ${view.kind === "signMessage" ? "is-open" : ""}" ${
          view.kind === "signMessage" ? "open" : ""
        }>
          <summary>${escapeHtml(view.payloadLabel ?? "Raw payload")}</summary>
          <pre class="approval-payload">${escapeHtml(view.payload)}</pre>
        </details>

        ${renderTrustOptions(view)}

        <div class="action-row approval-actions">
          <button id="approve-button">${escapeHtml(view.approveLabel ?? "Approve")}</button>
          <button id="reject-button" class="secondary">Reject</button>
        </div>
      </section>
    </div>
  `;

  root
    .querySelector<HTMLButtonElement>("#approve-button")
    ?.addEventListener("click", async () => {
      await resolveApproval(true);
    });

  root
    .querySelector<HTMLButtonElement>("#reject-button")
    ?.addEventListener("click", async () => {
      await resolveApproval(false);
    });
  wireTrustOptions();
}

async function resolveApproval(
  approved: boolean,
  options: { confirmedBroad?: boolean } = {}
): Promise<void> {
  const trust = approved ? selectedTrustScope() : undefined;
  if (trust === "any" && !options.confirmedBroad) {
    showBroadTrustConfirmation();
    return;
  }
  disableButtons();
  try {
    await sendRuntimeMessage<null>({
      type: "approval_resolve",
      approvalId,
      approved,
      trust
    });
  } finally {
    window.close();
  }
}

function disableButtons(): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>("button")) {
    button.disabled = true;
  }
}

void render().catch((error) => {
  root.innerHTML = `
    <section class="shell-card stack">
      <p class="eyebrow">Approval request</p>
      <h1>Approval unavailable</h1>
      <p class="banner banner-danger">${
        error instanceof Error ? escapeHtml(error.message) : escapeHtml(String(error))
      }</p>
    </section>
  `;
});
