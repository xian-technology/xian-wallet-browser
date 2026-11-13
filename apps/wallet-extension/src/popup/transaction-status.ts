import { failureMessage } from "./activity";

/** What a wallet send returns to the popup: the SDK submission, with a receipt once executed. */
export interface SendTransactionResult {
  submitted: boolean;
  accepted: boolean | null;
  finalized: boolean;
  txHash?: string;
  message?: unknown;
  receipt?: unknown;
}

export interface TransactionFlashLabels {
  sent?: string;
  finalized?: string;
  accepted?: string;
  failed?: string;
}

export interface TransactionFinalStatus {
  message: string;
  tone: "success" | "danger";
  icon: "success" | "danger";
  detail?: string;
}

/** The receipt of an executed transaction whose execution failed, if any. */
function failedReceipt(result: SendTransactionResult): { message?: unknown } | null {
  const receipt = result.receipt as { success?: unknown; message?: unknown } | null | undefined;
  return receipt?.success === false ? receipt : null;
}

export function transactionAccepted(result: SendTransactionResult): boolean {
  return (result.finalized === true || result.accepted === true) && !failedReceipt(result);
}

function failedStatus(labels: TransactionFlashLabels, detail: string | null): TransactionFinalStatus {
  return {
    message: labels.failed || "Transaction failed.",
    tone: "danger",
    icon: "danger",
    detail: detail || undefined
  };
}

/** The outcome of a submission whose execution has no failed receipt. */
function submissionStatus(
  result: SendTransactionResult,
  labels: TransactionFlashLabels
): TransactionFinalStatus | null {
  if (result.finalized === true) {
    return { message: labels.finalized || "Transaction finalized.", tone: "success", icon: "success" };
  }
  if (result.accepted === true) {
    return { message: labels.accepted || "Transaction accepted.", tone: "success", icon: "success" };
  }
  if (result.accepted === false || result.submitted === false) {
    const message = typeof result.message === "string" ? result.message.trim() : "";
    return failedStatus(labels, message ? failureMessage(message) : null);
  }
  return null;
}

/** The final flash for a send: an executed failure (e.g. out of chi) wins over finalized. */
export function transactionFinalStatus(
  result: SendTransactionResult,
  labels: TransactionFlashLabels = {}
): TransactionFinalStatus | null {
  const failed = failedReceipt(result);
  return failed ? failedStatus(labels, failureMessage(failed.message)) : submissionStatus(result, labels);
}
