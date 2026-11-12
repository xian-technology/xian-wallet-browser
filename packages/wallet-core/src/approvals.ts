import { encodeRuntime } from "@xian-tech/client";
import type { XianProviderRequest } from "@xian-tech/provider";

import type {
  ApprovalDetail,
  ApprovalKind,
  ApprovalTrustSuggestion,
  ApprovalView,
  PendingApprovalRecord
} from "./types.js";
import {
  HIDDEN_CHARACTERS_WARNING,
  revealHiddenCharacters
} from "./text-safety.js";

function prettyJson(value: unknown): string {
  return JSON.stringify(JSON.parse(encodeRuntime(value)), null, 2);
}

function payloadForRequest(request: XianProviderRequest): unknown {
  if (Array.isArray(request.params)) {
    return request.params[0] ?? null;
  }
  return request.params ?? null;
}

function stringifyValue(value: unknown): string {
  if (value == null) {
    return "Not provided";
  }
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return prettyJson(value);
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function exactIntegerValue(value: unknown): bigint | null {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  return null;
}

function formatNumericValue(value: number): string {
  return value.toLocaleString(undefined, {
    maximumFractionDigits: 8
  });
}

function formatChiAmount(value: unknown, chi: number | null): string {
  const exactChi = exactIntegerValue(value);
  if (exactChi != null) {
    return exactChi.toLocaleString();
  }
  return chi == null ? stringifyValue(value) : formatNumericValue(chi);
}

export function formatChiWithXianCost(
  value: unknown,
  chiRate: number | null | undefined
): string | null {
  if (
    value == null ||
    value === "" ||
    (typeof value === "number" && Number.isNaN(value))
  ) {
    return null;
  }

  const chi = numericValue(value);
  const formattedChi = formatChiAmount(value, chi);
  const cost = xianCost(chi, chiRate);
  return cost == null ? formattedChi : `${formattedChi} (~${formatNumericValue(cost)} XIAN)`;
}

/** The XIAN that `chi` costs at `chiRate` chi per XIAN, or null when it has no finite value. */
function xianCost(chi: number | null, chiRate: number | null | undefined): number | null {
  if (chi == null || typeof chiRate !== "number" || !Number.isFinite(chiRate) || chiRate <= 0) {
    return null;
  }
  const cost = chi / chiRate;
  return Number.isFinite(cost) ? cost : null;
}

function compactDetail(
  label: string,
  value: unknown,
  options?: {
    monospace?: boolean;
    tone?: ApprovalDetail["tone"];
  }
): ApprovalDetail | null {
  if (
    value == null ||
    value === "" ||
    (typeof value === "number" && Number.isNaN(value))
  ) {
    return null;
  }

  return {
    label,
    value: stringifyValue(value),
    monospace: options?.monospace,
    tone: options?.tone
  };
}

function siteDetail(approval: PendingApprovalRecord): ApprovalDetail | null {
  return compactDetail("Site", approval.origin, { monospace: true });
}

function compactDetails(
  details: Array<ApprovalDetail | null>
): ApprovalDetail[] {
  return details.filter((detail): detail is ApprovalDetail => detail != null);
}

function trustedDappSuggestion(
  contract: string,
  fn: string,
  requestLabel: string
): ApprovalTrustSuggestion {
  const target = `${contract}.${fn}`;
  return {
    label: `Auto-approve this exact ${target}`,
    description:
      `For the next 30 days, this site can repeat matching ${requestLabel} with the same arguments on this account and network.`,
    broadLabel: `Auto-approve any ${target}`,
    broadDescription:
      `For the next 30 days, this site can send matching ${requestLabel} even if recipients, amounts, routes, or other arguments change.`,
    broadWarning:
      "Broad auto-approval can move funds or execute contract logic without another prompt. Use it only for dapps you fully trust.",
    exactScope: "exact",
    broadScope: "any"
  };
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload != null
    ? (payload as Record<string, unknown>)
    : {};
}

function nestedOrSelf(
  root: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const nested = root[key];
  return typeof nested === "object" && nested != null
    ? (nested as Record<string, unknown>)
    : root;
}

/** `payload[key]` when it is an object, else the payload itself (flat request shapes). */
function requestPart(payload: unknown, key: "tx" | "intent" | "options"): Record<string, unknown> {
  return nestedOrSelf(payloadRecord(payload), key);
}

function messagePreview(message: string): string {
  if (message.length <= 160) {
    return message;
  }
  return `${message.slice(0, 157)}...`;
}

export function approvalKindFromMethod(method: string): ApprovalKind {
  switch (method) {
    case "xian_requestAccounts":
      return "connect";
    case "xian_switchChain":
      return "switchChain";
    case "xian_signMessage":
      return "signMessage";
    case "xian_signTransaction":
      return "signTransaction";
    case "xian_sendTransaction":
      return "sendTransaction";
    case "xian_sendCall":
      return "sendCall";
    case "xian_watchAsset":
      return "watchAsset";
    default:
      throw new Error(`unsupported approval method: ${method}`);
  }
}

export interface ApprovalViewOptions {
  account?: string;
  chainId?: string;
  targetChainId?: string;
  chiRate?: number | null;
}

type ApprovalViewBody = Omit<
  ApprovalView,
  "id" | "origin" | "kind" | "account" | "chainId" | "createdAt"
>;

type ApprovalViewBuilder = (
  approval: PendingApprovalRecord,
  payload: unknown,
  options: ApprovalViewOptions | undefined
) => ApprovalViewBody;

function connectView(
  approval: PendingApprovalRecord,
  _payload: unknown,
  options: ApprovalViewOptions | undefined
): ApprovalViewBody {
  return {
    title: "Connect wallet",
    description:
      "Allow this site to view your active address and request wallet actions.",
    approveLabel: "Connect",
    details: compactDetails([
      siteDetail(approval),
      compactDetail("Account", options?.account, { monospace: true }),
      compactDetail("Network", options?.chainId),
      compactDetail("Access", "View your address and request approvals")
    ]),
    highlights: [
      "Connection does not send a transaction or move funds.",
      "Future signing and transaction requests will still need explicit approval."
    ],
    warnings: [
      "Only connect sites you trust. You can revoke site access from the wallet at any time."
    ],
    payload: prettyJson({
      origin: approval.origin,
      account: options?.account ?? null,
      chainId: options?.chainId ?? null
    }),
    payloadLabel: "Connection request"
  };
}

function requestedChainId(
  payload: unknown,
  options: ApprovalViewOptions | undefined
): string | undefined {
  const chainId = payloadRecord(payload).chainId;
  return options?.targetChainId ?? (typeof chainId === "string" ? chainId : undefined);
}

function switchChainView(
  approval: PendingApprovalRecord,
  payload: unknown,
  options: ApprovalViewOptions | undefined
): ApprovalViewBody {
  const targetChainId = requestedChainId(payload, options);
  return {
    title: "Switch network",
    description:
      "Allow this site to change the wallet network used by every connected site.",
    approveLabel: "Switch network",
    details: compactDetails([
      siteDetail(approval),
      compactDetail("Account", options?.account, { monospace: true }),
      compactDetail("Current network", options?.chainId),
      compactDetail("Requested network", targetChainId)
    ]),
    highlights: [
      `Switch from ${stringifyValue(options?.chainId)} to ${stringifyValue(
        targetChainId
      )}`
    ],
    warnings: [
      "Switching changes the signing and transaction context for all connected sites."
    ],
    payload: prettyJson({
      origin: approval.origin,
      account: options?.account ?? null,
      fromChainId: options?.chainId ?? null,
      toChainId: targetChainId ?? null
    }),
    payloadLabel: "Network switch request"
  };
}

function signMessageView(
  approval: PendingApprovalRecord,
  payload: unknown,
  options: ApprovalViewOptions | undefined
): ApprovalViewBody {
  const message =
    typeof payload === "object" && payload != null
      ? String((payload as { message?: unknown }).message ?? "")
      : String(payload ?? "");
  return {
    title: "Sign message",
    description:
      "Review the exact message carefully. Message signing should never be used as a substitute for transaction approval.",
    approveLabel: "Sign message",
    details: compactDetails([
      siteDetail(approval),
      compactDetail("Account", options?.account, { monospace: true }),
      compactDetail("Network", options?.chainId),
      compactDetail("Length", `${message.length} characters`),
      compactDetail("Preview", messagePreview(message))
    ]),
    highlights: message.length > 0 ? [messagePreview(message)] : [],
    warnings: [
      "Do not sign messages you do not understand.",
      "Never sign a message that looks like a transaction payload or seed phrase request."
    ],
    payload: message,
    payloadLabel: "Full message"
  };
}

function exactMarkerText(value: Record<string, unknown>): string | null {
  const keys = Object.keys(value);
  if (keys.length !== 1) {
    return null;
  }
  const marker = value.__fixed__ ?? value.__big_int__;
  return typeof marker === "string" ? marker : null;
}

function argumentText(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const marker = exactMarkerText(value as Record<string, unknown>);
    if (marker != null) {
      return marker;
    }
  }
  return stringifyValue(value);
}

function argumentDetails(kwargs: unknown): ApprovalDetail[] {
  if (typeof kwargs !== "object" || kwargs == null || Array.isArray(kwargs)) {
    return [];
  }
  return Object.entries(kwargs).map(([name, value]) => ({
    label: `Argument: ${name}`,
    value: argumentText(value),
    monospace: true
  }));
}

function preparedTransactionDetails(
  approval: PendingApprovalRecord,
  txPayload: Record<string, unknown>,
  options: ApprovalViewOptions | undefined,
  chiTone: ApprovalDetail["tone"]
): ApprovalDetail[] {
  return compactDetails([
    siteDetail(approval),
    compactDetail("Sender", txPayload.sender, { monospace: true }),
    compactDetail("Contract", txPayload.contract, { monospace: true }),
    compactDetail("Function", txPayload.function),
    compactDetail("Network", txPayload.chain_id ?? options?.chainId),
    compactDetail("Nonce", txPayload.nonce),
    compactDetail(
      "Chi",
      formatChiWithXianCost(txPayload.chi_supplied, options?.chiRate),
      { tone: chiTone }
    ),
    ...argumentDetails(txPayload.kwargs)
  ]);
}

function targetTrustSuggestion(
  target: Record<string, unknown>,
  requestLabel: string
): ApprovalTrustSuggestion | undefined {
  return typeof target.contract === "string" &&
    typeof target.function === "string"
    ? trustedDappSuggestion(target.contract, target.function, requestLabel)
    : undefined;
}

interface PreparedTransactionWording {
  title: string;
  description: string;
  approveLabel: string;
  chiTone: ApprovalDetail["tone"];
  highlights: (txPayload: Record<string, unknown>) => string[];
  warning: string;
  trustLabel: string;
}

function preparedTransactionView(
  wording: PreparedTransactionWording
): ApprovalViewBuilder {
  return (approval, payload, options) => {
    const txPayload = nestedOrSelf(requestPart(payload, "tx"), "payload");
    return {
      title: wording.title,
      description: wording.description,
      approveLabel: wording.approveLabel,
      details: preparedTransactionDetails(approval, txPayload, options, wording.chiTone),
      highlights: wording.highlights(txPayload),
      warnings: [wording.warning],
      trustSuggestion: targetTrustSuggestion(txPayload, wording.trustLabel),
      payload: prettyJson(payload),
      payloadLabel: "Raw transaction"
    };
  };
}

const signTransactionView = preparedTransactionView({
  title: "Sign prepared transaction",
  description:
    "The site already prepared a full transaction payload. Verify the sender, target contract, function, and chi budget before signing.",
  approveLabel: "Sign transaction",
  chiTone: undefined,
  highlights: (txPayload) => [targetLabel(txPayload)],
  warning:
    "Prepared transactions may perform arbitrary contract actions. Inspect the raw payload if anything looks unfamiliar.",
  trustLabel: "prepared-signature requests"
});

const sendTransactionView = preparedTransactionView({
  title: "Send prepared transaction",
  description:
    "The site supplied a full unsigned transaction. Approving will sign and broadcast it from your wallet.",
  approveLabel: "Send transaction",
  chiTone: "warning",
  highlights: () => ["This request can broadcast immediately after approval."],
  warning: "Broadcasting a transaction may move funds or execute irreversible contract logic.",
  trustLabel: "prepared-transaction broadcasts"
});

const SEND_CALL_INTENT_WARNING =
  "The wallet will fill the sender and nonce at approval time. Confirm the contract and arguments match your intent.";
const UNKNOWN_CHI_WARNING =
  "The wallet could not estimate chi for this call. The chi limit will be chosen when it is sent.";

function intentKwargs(
  intent: Record<string, unknown>
): Record<string, unknown> | undefined {
  return typeof intent.kwargs === "object" && intent.kwargs != null
    ? (intent.kwargs as Record<string, unknown>)
    : undefined;
}

function targetLabel(target: Record<string, unknown>): string {
  return `${stringifyValue(target.contract ?? "unknown")}.${stringifyValue(
    target.function ?? "unknown"
  )}`;
}

function sendCallChiDetail(
  chi: unknown,
  options: ApprovalViewOptions | undefined
): ApprovalDetail | null {
  return chi == null || chi === ""
    ? compactDetail("Chi", "Not estimated", { tone: "danger" })
    : compactDetail("Chi", formatChiWithXianCost(chi, options?.chiRate), {
        tone: "warning"
      });
}

function sendCallView(
  approval: PendingApprovalRecord,
  payload: unknown,
  options: ApprovalViewOptions | undefined
): ApprovalViewBody {
  const intent = requestPart(payload, "intent");
  const kwargs = intentKwargs(intent);
  const chiDetail = sendCallChiDetail(intent.chiSupplied ?? intent.chi, options);
  const chiKnown = chiDetail?.tone === "warning";
  return {
    title: "Send contract call",
    description:
      "The wallet will prepare, sign, and broadcast this intent on your behalf using the active account and latest nonce.",
    approveLabel: "Approve call",
    details: compactDetails([
      siteDetail(approval),
      compactDetail("Account", options?.account, { monospace: true }),
      compactDetail("Contract", intent.contract),
      compactDetail("Function", intent.function),
      compactDetail("Network", intent.chainId ?? options?.chainId),
      chiDetail,
      compactDetail(
        "Arguments",
        kwargs ? `${Object.keys(kwargs).length} field(s)` : undefined
      ),
      ...argumentDetails(kwargs)
    ]),
    highlights: [targetLabel(intent)],
    warnings: chiKnown
      ? [SEND_CALL_INTENT_WARNING]
      : [SEND_CALL_INTENT_WARNING, UNKNOWN_CHI_WARNING],
    // An auto-approval rule needs a chi cap, so none is offered without one.
    trustSuggestion: chiKnown
      ? targetTrustSuggestion(intent, "contract calls")
      : undefined,
    payload: prettyJson(payload),
    payloadLabel: "Raw call intent"
  };
}

function watchAssetView(
  approval: PendingApprovalRecord,
  payload: unknown,
  _options: ApprovalViewOptions | undefined
): ApprovalViewBody {
  const asset = requestPart(payload, "options");
  return {
    title: "Add asset to wallet",
    description:
      "Allow this site to add an asset to your wallet list. This does not verify the asset’s legitimacy.",
    approveLabel: "Add asset",
    details: compactDetails([
      siteDetail(approval),
      compactDetail("Name", asset.name),
      compactDetail("Symbol", asset.symbol),
      compactDetail("Contract", asset.contract, { monospace: true }),
      compactDetail("Decimals", asset.decimals)
    ]),
    highlights: [
      "Always verify the asset contract from an independent trusted source."
    ],
    warnings: [
      "Token metadata can be spoofed. Matching names and symbols do not prove authenticity."
    ],
    payload: prettyJson(payload),
    payloadLabel: "Asset metadata"
  };
}

const APPROVAL_VIEW_BUILDERS: Record<ApprovalKind, ApprovalViewBuilder> = {
  connect: connectView,
  switchChain: switchChainView,
  signMessage: signMessageView,
  signTransaction: signTransactionView,
  sendTransaction: sendTransactionView,
  sendCall: sendCallView,
  watchAsset: watchAssetView
};

function revealHiddenText(body: ApprovalViewBody): ApprovalViewBody {
  const details = body.details?.map((detail) => ({
    ...detail,
    label: revealHiddenCharacters(detail.label),
    value: revealHiddenCharacters(detail.value)
  }));
  const highlights = body.highlights?.map(revealHiddenCharacters);
  const payload = revealHiddenCharacters(body.payload);
  const revealed =
    payload !== body.payload ||
    JSON.stringify([details, highlights]) !==
      JSON.stringify([body.details, body.highlights]);
  return {
    ...body,
    details,
    highlights,
    payload,
    warnings: revealed
      ? [HIDDEN_CHARACTERS_WARNING, ...(body.warnings ?? [])]
      : body.warnings
  };
}

export function buildApprovalView(
  approval: PendingApprovalRecord,
  options?: ApprovalViewOptions
): ApprovalView {
  const body = APPROVAL_VIEW_BUILDERS[approval.kind](
    approval,
    payloadForRequest(approval.request),
    options
  );
  return {
    id: approval.id,
    origin: approval.origin,
    kind: approval.kind,
    ...revealHiddenText(body),
    account: options?.account,
    chainId: options?.chainId,
    createdAt: approval.createdAt
  };
}
