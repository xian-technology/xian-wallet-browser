import {
  errorFromSerializedWalletError,
  type WalletConnectedDappMetadata,
} from "@xian-tech/wallet-core";

import {
  PAGE_BRIDGE_SOURCE,
  fail,
  isPageBridgeMessage,
  ok,
  type ProviderRequestRuntimeResult,
  type PageProviderEventMessage,
  type PageProviderResponseMessage
} from "../shared/messages";

const REQUEST_POLL_INTERVAL_MS = 500;

function injectProviderScript(): void {
  if (document.documentElement.dataset.xianWalletShellInjected === "true") {
    return;
  }

  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("inpage.js");
  script.type = "module";
  script.onload = () => {
    script.remove();
  };
  (document.head || document.documentElement).appendChild(script);
  document.documentElement.dataset.xianWalletShellInjected = "true";
}

function postToPage(
  message: PageProviderResponseMessage | PageProviderEventMessage
): void {
  window.postMessage(message, window.location.origin);
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, durationMs);
  });
}

function metadataText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 120) : undefined;
}

function absoluteHttpUrl(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 2048) {
    return undefined;
  }
  try {
    const url = new URL(trimmed, document.baseURI || window.location.href);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function largestIconSize(sizes: string | null): number {
  if (!sizes) {
    return 0;
  }
  if (sizes.toLowerCase().split(/\s+/).includes("any")) {
    return 10_000;
  }
  return sizes
    .split(/\s+/)
    .map((entry) => {
      const match = /^(\d+)x(\d+)$/i.exec(entry);
      return match ? Math.max(Number(match[1]), Number(match[2])) : 0;
    })
    .reduce((largest, size) => Math.max(largest, size), 0);
}

function faviconScore(link: HTMLLinkElement): number {
  const rel = link.rel.toLowerCase();
  const href = link.getAttribute("href") ?? "";
  const isSvg = /\.svg(?:[?#]|$)/i.test(href);
  const size = largestIconSize(link.getAttribute("sizes"));
  return (
    size +
    (isSvg ? 20_000 : 0) +
    (rel.includes("apple-touch-icon") ? 5_000 : 0) +
    (rel.includes("shortcut") ? 500 : 0) +
    (rel.includes("icon") ? 1_000 : 0)
  );
}

function collectPageMetadata(): WalletConnectedDappMetadata {
  const siteName = metadataText(
    document
      .querySelector<HTMLMetaElement>(
        'meta[property="og:site_name"], meta[name="application-name"]'
      )
      ?.content
  );
  const title = metadataText(document.title);
  const iconUrl =
    Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel*="icon"]'))
      .map((link) => ({
        href: absoluteHttpUrl(link.href || link.getAttribute("href")),
        score: faviconScore(link)
      }))
      .filter((candidate): candidate is { href: string; score: number } =>
        Boolean(candidate.href)
      )
      .sort((left, right) => right.score - left.score)[0]?.href ??
    absoluteHttpUrl("/favicon.ico");

  return {
    name: siteName ?? title,
    iconUrl
  };
}

async function sendRuntimeMessage<T>(message: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(
      message,
      (response: ReturnType<typeof ok> | ReturnType<typeof fail>) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response.ok) {
          const error = new Error(response.error.message) as Error & {
            code?: number;
            data?: unknown;
            name: string;
          };
          error.name = response.error.name ?? "Error";
          error.code = response.error.code;
          error.data = response.error.data;
          reject(error);
          return;
        }
        resolve(response.result as T);
      }
    );
  });
}

async function awaitProviderRequestResult(requestId: string): Promise<unknown> {
  for (;;) {
    await sleep(REQUEST_POLL_INTERVAL_MS);

    const status = await sendRuntimeMessage<ProviderRequestRuntimeResult>({
      type: "provider_request_status",
      requestId,
      consume: true
    });

    switch (status.status) {
      case "pending":
        continue;
      case "not_found":
        throw new Error("provider request is no longer active");
      case "fulfilled":
        return status.result;
      case "rejected":
        throw errorFromSerializedWalletError(status.error);
    }
  }
}

injectProviderScript();

window.addEventListener("message", async (event: MessageEvent<unknown>) => {
  const data = event.data;
  if (event.source !== window || !isPageBridgeMessage(data)) {
    return;
  }
  if (data.direction !== "request") {
    return;
  }

  try {
    const start = await sendRuntimeMessage<ProviderRequestRuntimeResult>({
      type: "provider_request",
      origin: window.location.origin,
      requestId: data.id,
      request: data.request,
      dappMetadata: collectPageMetadata()
    });

    let result: unknown;
    switch (start.status) {
      case "pending":
        result = await awaitProviderRequestResult(data.id);
        break;
      case "fulfilled":
        result = start.result;
        break;
      case "rejected":
        throw errorFromSerializedWalletError(start.error);
      case "not_found":
        throw new Error("provider request was not registered");
    }

    postToPage({
      source: PAGE_BRIDGE_SOURCE,
      direction: "response",
      id: data.id,
      success: true,
      result
    });
  } catch (error) {
    postToPage({
      source: PAGE_BRIDGE_SOURCE,
      direction: "response",
      id: data.id,
      success: false,
      error: fail(error).error
    });
  }
});

chrome.runtime.onMessage.addListener((message: {
  type?: string;
  event?: string;
  args?: unknown[];
  targetOrigin?: string;
}) => {
  if (message.type !== "provider_event") {
    return;
  }
  if (message.targetOrigin && message.targetOrigin !== window.location.origin) {
    return;
  }
  postToPage({
    source: PAGE_BRIDGE_SOURCE,
    direction: "event",
    event: message.event ?? "unknown",
    args: message.args ?? []
  });
});
