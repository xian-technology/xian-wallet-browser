import {
  registerInjectedXianProvider,
  type XianProvider,
  type XianProviderRequest
} from "@xian-tech/provider";

import {
  PAGE_BRIDGE_SOURCE,
  isPageBridgeMessage,
  makeBridgeId
} from "../shared/messages";

type Listener = (...args: unknown[]) => void;

class EventEmitter {
  private readonly listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener): void {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
  }

  removeListener(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

class ExtensionInjectedProvider implements XianProvider {
  private readonly events = new EventEmitter();
  private readonly pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(reason: unknown): void;
    }
  >();

  constructor() {
    window.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (event.source !== window || !isPageBridgeMessage(event.data)) {
        return;
      }
      if (event.data.direction === "response") {
        const pending = this.pending.get(event.data.id);
        if (!pending) {
          return;
        }
        this.pending.delete(event.data.id);
        if (event.data.success) {
          pending.resolve(event.data.result);
          return;
        }
        const error = new Error(event.data.error?.message ?? "provider request failed") as Error & {
          code?: number;
          data?: unknown;
          name: string;
        };
        error.name = event.data.error?.name ?? "Error";
        error.code = event.data.error?.code;
        error.data = event.data.error?.data;
        pending.reject(error);
        return;
      }

      if (event.data.direction === "event") {
        this.events.emit(event.data.event, ...(event.data.args ?? []));
      }
    });
  }

  request(args: XianProviderRequest): Promise<unknown> {
    const id = makeBridgeId();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      window.postMessage(
        {
          source: PAGE_BRIDGE_SOURCE,
          direction: "request",
          id,
          request: args
        },
        window.location.origin
      );
    });
  }

  on(event: string, listener: Listener): void {
    this.events.on(event, listener);
  }

  removeListener(event: string, listener: Listener): void {
    this.events.removeListener(event, listener);
  }
}

if (!window.__xianWalletShellInjected__) {
  window.__xianWalletShellInjected__ = true;
  registerInjectedXianProvider({
    provider: new ExtensionInjectedProvider(),
    metadata: {
      id: "xian-wallet-shell",
      name: "Xian Wallet",
      rdns: "org.xian.wallet.shell"
    },
    setAsDefault: true
  });
}
