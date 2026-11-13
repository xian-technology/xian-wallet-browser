import type { PopupState } from "@xian-tech/wallet-core";

import type {
  ProviderRequestRuntimeMessage,
  WalletTransactionSubmittedRuntimeMessage
} from "../shared/messages";
import type { StoredLocalActivityTx } from "../shared/storage";

// Reads what a dapp submitted through xian_sendTransaction / xian_sendCall
// into the wallet_transaction_submitted broadcast and the local activity
// entry. Provider requests and submission results are untyped JSON, so every
// field is read defensively.

type JsonRecord = Record<string, unknown>;
type SubmittedProviderMethod = WalletTransactionSubmittedRuntimeMessage["method"];

interface ProviderTransactionDetails {
  sender?: string;
  contract?: string;
  function?: string;
  kwargs?: JsonRecord;
}

export interface LocalProviderActivity {
  networkKey: string;
  tx: StoredLocalActivityTx;
}

const TX_HASH_KEYS = ["txHash", "tx_hash", "hash"] as const;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readBooleanOrNull(value: unknown): boolean | null | undefined {
  return value === null || typeof value === "boolean" ? value : undefined;
}

function isSubmittedProviderMethod(
  method: string
): method is SubmittedProviderMethod {
  return method === "xian_sendTransaction" || method === "xian_sendCall";
}

/** The record found by following `keys` from `record`, or null. */
function recordPath(record: JsonRecord | null, ...keys: string[]): JsonRecord | null {
  return keys.reduce<JsonRecord | null>((current, key) => {
    const value = current?.[key];
    return isRecord(value) ? value : null;
  }, record);
}

function firstParamRecord(params: unknown): JsonRecord {
  const first = Array.isArray(params) ? params[0] : params;
  return isRecord(first) ? first : {};
}

function detailsFromPayload(payload: JsonRecord | null): ProviderTransactionDetails {
  const fields = payload ?? {};
  return {
    sender: readString(fields.sender),
    contract: readString(fields.contract),
    function: readString(fields.function),
    kwargs: recordPath(fields, "kwargs") ?? undefined
  };
}

function detailsFromProviderRequest(
  method: SubmittedProviderMethod,
  requestParams: unknown
): ProviderTransactionDetails {
  const params = firstParamRecord(requestParams);
  if (method === "xian_sendCall") {
    return detailsFromPayload(recordPath(params, "intent") ?? params);
  }
  const tx = recordPath(params, "tx") ?? params;
  return detailsFromPayload(recordPath(tx, "payload") ?? recordPath(params, "payload"));
}

function detailsFromSubmission(submission: JsonRecord): ProviderTransactionDetails {
  return detailsFromPayload(
    recordPath(submission, "transaction", "payload") ??
      recordPath(submission, "payload") ??
      recordPath(submission, "receipt", "transaction", "payload")
  );
}

function firstTxHash(record: JsonRecord | null): string | undefined {
  return TX_HASH_KEYS.map((key) => readString(record?.[key])).find(
    (hash) => hash !== undefined
  );
}

function txHashFromSubmission(submission: JsonRecord): string | undefined {
  return firstTxHash(submission) ?? firstTxHash(recordPath(submission, "receipt"));
}

/** Submission details win; the request fills what the submission lacks. */
function mergeDetails(
  primary: ProviderTransactionDetails,
  fallback: ProviderTransactionDetails
): ProviderTransactionDetails {
  return {
    sender: primary.sender ?? fallback.sender,
    contract: primary.contract ?? fallback.contract,
    function: primary.function ?? fallback.function,
    kwargs: primary.kwargs ?? fallback.kwargs
  };
}

/** The broadcast for a fulfilled submitting request, or null for other methods. */
export function buildTransactionSubmittedMessage(
  runtimeMessage: ProviderRequestRuntimeMessage,
  result: { status: "fulfilled"; result: unknown },
  autoApproved: boolean
): WalletTransactionSubmittedRuntimeMessage | null {
  const { method, params } = runtimeMessage.request;
  if (!isSubmittedProviderMethod(method)) {
    return null;
  }

  const submission = isRecord(result.result) ? result.result : {};
  return {
    type: "wallet_transaction_submitted",
    origin: runtimeMessage.origin,
    requestId: runtimeMessage.requestId,
    method,
    autoApproved,
    submitted: readBoolean(submission.submitted),
    accepted: readBooleanOrNull(submission.accepted),
    finalized: readBoolean(submission.finalized),
    txHash: txHashFromSubmission(submission),
    ...mergeDetails(
      detailsFromSubmission(submission),
      detailsFromProviderRequest(method, params)
    ),
    message: submission.message,
    execution: recordPath(submission, "receipt")?.execution
  };
}

function localStatus(
  notification: WalletTransactionSubmittedRuntimeMessage
): StoredLocalActivityTx["local_status"] {
  if (notification.finalized === true) {
    return "finalized";
  }
  return notification.accepted === true ? "accepted" : undefined;
}

function localActivityTx(
  notification: WalletTransactionSubmittedRuntimeMessage,
  txHash: string,
  sender: string
): StoredLocalActivityTx {
  const contract = notification.contract ?? "unknown";
  const functionName = notification.function ?? "transaction";
  const status = localStatus(notification);
  const tx: StoredLocalActivityTx = {
    tx_hash: txHash,
    sender,
    contract,
    function: functionName,
    success: status !== undefined,
    created_at: new Date().toISOString(),
    payload: {
      sender,
      contract,
      function: functionName,
      kwargs: notification.kwargs ?? {}
    },
    local: true
  };
  if (status) {
    tx.local_status = status;
  }
  if (notification.message !== undefined) {
    tx.result = { message: notification.message };
  }
  return tx;
}

/**
 * The local activity entry for a submitted transaction of the active account,
 * or null when there is no active account or another account sent it.
 */
export function localProviderActivity(
  notification: WalletTransactionSubmittedRuntimeMessage,
  txHash: string,
  state: Pick<PopupState, "publicKey" | "activeNetworkId" | "rpcUrl">
): LocalProviderActivity | null {
  const sender = notification.sender ?? state.publicKey;
  if (!state.publicKey || sender !== state.publicKey) {
    return null;
  }
  return {
    networkKey: `${state.activeNetworkId ?? state.rpcUrl}|${state.rpcUrl}|${sender}`,
    tx: localActivityTx(notification, txHash, sender)
  };
}
