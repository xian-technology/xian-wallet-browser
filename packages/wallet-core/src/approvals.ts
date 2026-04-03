import type { XianProviderRequest } from "@xian-tech/provider";

import type {
  ApprovalDetail,
  ApprovalKind,
  ApprovalView,
  PendingApprovalRecord
} from "./types.js";

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
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

function compactDetails(
  details: Array<ApprovalDetail | null>
): ApprovalDetail[] {
  return details.filter((detail): detail is ApprovalDetail => detail != null);
}

function txPayloadFromRequestPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload == null) {
    return {};
  }
  const root = payload as Record<string, unknown>;
  const tx =
    typeof root.tx === "object" && root.tx != null
      ? (root.tx as Record<string, unknown>)
      : root;
  const txPayload =
    typeof tx.payload === "object" && tx.payload != null
      ? (tx.payload as Record<string, unknown>)
      : tx;
  return txPayload;
}

function intentFromRequestPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload == null) {
    return {};
  }
  const root = payload as Record<string, unknown>;
  return typeof root.intent === "object" && root.intent != null
    ? (root.intent as Record<string, unknown>)
    : root;
}

function assetFromRequestPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload == null) {
    return {};
  }
  const root = payload as Record<string, unknown>;
  return typeof root.options === "object" && root.options != null
    ? (root.options as Record<string, unknown>)
    : root;
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

export function buildApprovalView(
  approval: PendingApprovalRecord,
  options?: {
    account?: string;
    chainId?: string;
  }
): ApprovalView {
  const payload = payloadForRequest(approval.request);

  switch (approval.kind) {
    case "connect":
      return {
        id: approval.id,
        origin: approval.origin,
        kind: approval.kind,
        title: "Connect wallet",
        description:
          "Allow this site to view your active address and request wallet actions.",
        approveLabel: "Connect",
        details: compactDetails([
          compactDetail("Site", approval.origin, { monospace: true }),
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
        payloadLabel: "Connection request",
        account: options?.account,
        chainId: options?.chainId,
        createdAt: approval.createdAt
      };
    case "signMessage":
      {
        const message =
          typeof payload === "object" && payload != null
            ? String((payload as { message?: unknown }).message ?? "")
            : String(payload ?? "");
        return {
          id: approval.id,
          origin: approval.origin,
          kind: approval.kind,
          title: "Sign message",
          description:
            "Review the exact message carefully. Message signing should never be used as a substitute for transaction approval.",
          approveLabel: "Sign message",
          details: compactDetails([
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
          payloadLabel: "Full message",
          account: options?.account,
          chainId: options?.chainId,
          createdAt: approval.createdAt
        };
      }
    case "signTransaction":
      {
        const txPayload = txPayloadFromRequestPayload(payload);
        return {
          id: approval.id,
          origin: approval.origin,
          kind: approval.kind,
          title: "Sign prepared transaction",
          description:
            "The site already prepared a full transaction payload. Verify the sender, target contract, function, and stamp budget before signing.",
          approveLabel: "Sign transaction",
          details: compactDetails([
            compactDetail("Sender", txPayload.sender, { monospace: true }),
            compactDetail("Contract", txPayload.contract, { monospace: true }),
            compactDetail("Function", txPayload.function),
            compactDetail("Network", txPayload.chain_id ?? options?.chainId),
            compactDetail("Nonce", txPayload.nonce),
            compactDetail("Stamps", txPayload.stamps_supplied)
          ]),
          highlights: [
            `${stringifyValue(txPayload.contract ?? "unknown")}.${stringifyValue(
              txPayload.function ?? "unknown"
            )}`
          ],
          warnings: [
            "Prepared transactions may perform arbitrary contract actions. Inspect the raw payload if anything looks unfamiliar."
          ],
          payload: prettyJson(payload),
          payloadLabel: "Raw transaction",
          account: options?.account,
          chainId: options?.chainId,
          createdAt: approval.createdAt
        };
      }
    case "sendTransaction":
      {
        const txPayload = txPayloadFromRequestPayload(payload);
        return {
          id: approval.id,
          origin: approval.origin,
          kind: approval.kind,
          title: "Send prepared transaction",
          description:
            "The site supplied a full unsigned transaction. Approving will sign and broadcast it from your wallet.",
          approveLabel: "Send transaction",
          details: compactDetails([
            compactDetail("Sender", txPayload.sender, { monospace: true }),
            compactDetail("Contract", txPayload.contract, { monospace: true }),
            compactDetail("Function", txPayload.function),
            compactDetail("Network", txPayload.chain_id ?? options?.chainId),
            compactDetail("Nonce", txPayload.nonce),
            compactDetail("Stamps", txPayload.stamps_supplied, {
              tone: "warning"
            })
          ]),
          highlights: [
            "This request can broadcast immediately after approval."
          ],
          warnings: [
            "Broadcasting a transaction may move funds or execute irreversible contract logic."
          ],
          payload: prettyJson(payload),
          payloadLabel: "Raw transaction",
          account: options?.account,
          chainId: options?.chainId,
          createdAt: approval.createdAt
        };
      }
    case "sendCall":
      {
        const intent = intentFromRequestPayload(payload);
        const kwargs =
          typeof intent.kwargs === "object" && intent.kwargs != null
            ? (intent.kwargs as Record<string, unknown>)
            : undefined;
        return {
          id: approval.id,
          origin: approval.origin,
          kind: approval.kind,
          title: "Send contract call",
          description:
            "The wallet will prepare, sign, and broadcast this intent on your behalf using the active account and latest nonce.",
          approveLabel: "Approve call",
          details: compactDetails([
            compactDetail("Contract", intent.contract, { monospace: true }),
            compactDetail("Function", intent.function),
            compactDetail("Network", intent.chainId ?? options?.chainId),
            compactDetail(
              "Stamps",
              intent.stampsSupplied ?? intent.stamps,
              { tone: "warning" }
            ),
            compactDetail(
              "Arguments",
              kwargs ? `${Object.keys(kwargs).length} field(s)` : undefined
            )
          ]),
          highlights: [
            `${stringifyValue(intent.contract ?? "unknown")}.${stringifyValue(
              intent.function ?? "unknown"
            )}`
          ],
          warnings: [
            "The wallet will fill the sender and nonce at approval time. Confirm the contract and arguments match your intent."
          ],
          payload: prettyJson(payload),
          payloadLabel: "Raw call intent",
          account: options?.account,
          chainId: options?.chainId,
          createdAt: approval.createdAt
        };
      }
    case "watchAsset":
      {
        const asset = assetFromRequestPayload(payload);
        return {
          id: approval.id,
          origin: approval.origin,
          kind: approval.kind,
          title: "Add asset to wallet",
          description:
            "Allow this site to add an asset to your wallet list. This does not verify the asset’s legitimacy.",
          approveLabel: "Add asset",
          details: compactDetails([
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
          payloadLabel: "Asset metadata",
          account: options?.account,
          chainId: options?.chainId,
          createdAt: approval.createdAt
        };
      }
  }
}
