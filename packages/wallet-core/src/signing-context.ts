import { ProviderUnauthorizedError } from "@xian-tech/provider";
import type { ApprovalContext, PopupState } from "./types.js";

/** Preserve the account and network the wallet page showed before signing. */
export function signingContextForPopup(state: PopupState): ApprovalContext {
  if (!state.publicKey || !state.activeNetworkId) {
    throw new ProviderUnauthorizedError("wallet signing context is unavailable");
  }
  return {
    account: state.publicKey,
    network: {
      presetId: state.activeNetworkId,
      rpcUrl: state.rpcUrl,
      configuredChainId: state.configuredChainId,
      chainId: state.chainId
    }
  };
}

export function popupSigningContextChanged(previous: PopupState | null, next: PopupState): boolean {
  if (!previous?.publicKey || !next.publicKey) return false;
  return JSON.stringify(signingContextForPopup(previous)) !== JSON.stringify(signingContextForPopup(next));
}
