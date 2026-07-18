import type {
  ProviderRequestStatusResult,
  StoredProviderRequest
} from "@xian-tech/wallet-core";

import type {
  ProviderRequestRuntimeMessage,
  ProviderRequestStatusRuntimeMessage
} from "../shared/messages";

/**
 * Reconstruct the original provider request when the content script consumes a
 * fulfilled, approval-mediated request. The initial provider_request response
 * was only "pending", so this is the first point where the background knows the
 * transaction completed and can notify an open popup or side panel.
 */
export function completedProviderRequestMessage(
  message: ProviderRequestStatusRuntimeMessage,
  stored: StoredProviderRequest | null,
  result: ProviderRequestStatusResult
): ProviderRequestRuntimeMessage | null {
  if (
    message.consume !== true ||
    result.status !== "fulfilled" ||
    !stored ||
    stored.requestId !== message.requestId ||
    (message.origin != null && stored.origin !== message.origin)
  ) {
    return null;
  }

  return {
    type: "provider_request",
    origin: stored.origin,
    requestId: stored.requestId,
    request: stored.request,
    dappMetadata: stored.dappMetadata
  };
}
