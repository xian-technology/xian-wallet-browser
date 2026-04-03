import {
  errorFromSerializedWalletError,
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
      request: data.request
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
