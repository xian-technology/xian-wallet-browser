import type { RuntimeMessage } from "../shared/messages";

export interface MessageSender {
  id?: string;
  url?: string;
  origin?: string;
  tab?: { id?: number };
}

export function authorizeRuntimeMessage(message: RuntimeMessage, sender: MessageSender, extensionId: string): RuntimeMessage {
  if (!sender || sender.id !== extensionId) throw new Error("untrusted runtime sender");
  const url = new URL(sender.url ?? "");
  if (isWalletPage(url, extensionId)) return message;
  if (message.type !== "provider_request" && message.type !== "provider_request_status") {
    throw new Error("wallet commands require a packaged wallet page");
  }
  return {...message, origin: pageOrigin(url, sender)};
}

function isWalletPage(url: URL, extensionId: string): boolean {
  return url.protocol === "chrome-extension:" && url.hostname === extensionId &&
    (url.pathname === "/popup.html" || url.pathname === "/approval.html");
}

function pageOrigin(url: URL, sender: MessageSender): string {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported provider sender");
  if (typeof sender.tab?.id !== "number" || sender.tab.id < 0) throw new Error("provider sender must belong to a tab");
  if (sender.origin !== undefined && sender.origin !== url.origin) throw new Error("opaque or mismatched sender origin");
  return url.origin;
}
