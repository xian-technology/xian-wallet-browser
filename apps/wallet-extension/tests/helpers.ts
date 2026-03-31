import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, expect, type BrowserContext, type Page } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(__dirname, "../dist");

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json"
  });
  response.end(JSON.stringify(body));
}

function html(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8"
  });
  response.end(body);
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

export async function launchExtension(): Promise<{
  context: BrowserContext;
  extensionId: string;
  userDataDir: string;
}> {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "xian-wallet-extension-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    viewport: {
      width: 420,
      height: 780
    },
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`
    ]
  });

  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker");
  }

  return {
    context,
    extensionId: new URL(serviceWorker.url()).host,
    userDataDir
  };
}

export async function cleanupExtension(
  context: BrowserContext,
  userDataDir: string
): Promise<void> {
  await context.close();
  await rm(userDataDir, { recursive: true, force: true });
}

export async function openExtensionPage(
  context: BrowserContext,
  extensionId: string,
  relativePath: string
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${relativePath}`);
  return page;
}

export async function sendRuntimeMessage<T>(
  page: Page,
  message: unknown
): Promise<T> {
  return page.evaluate(
    (payload) =>
      new Promise<T>((resolve, reject) => {
        chrome.runtime.sendMessage(payload, (response: unknown) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          const runtimeResponse = response as
            | { ok: true; result: T }
            | { ok: false; error?: { message?: string } }
            | undefined;

          if (!runtimeResponse) {
            reject(new Error("extension returned no response"));
            return;
          }

          if (!runtimeResponse.ok) {
            reject(
              new Error(runtimeResponse.error?.message ?? "runtime message failed")
            );
            return;
          }

          resolve(runtimeResponse.result);
        });
      }),
    message
  );
}

export async function waitForApprovalPage(
  context: BrowserContext,
  existingPages: Set<Page>
): Promise<Page> {
  const approvalPage =
    context.pages().find(
      (candidate) =>
        !existingPages.has(candidate) || candidate.url().includes("approval.html")
    ) ??
    (await context.waitForEvent("page", {
      predicate: (candidate) =>
        !existingPages.has(candidate) || candidate.url().includes("approval.html")
    }));

  await approvalPage.waitForURL(/approval\.html/);
  await approvalPage.waitForLoadState("domcontentloaded");
  return approvalPage;
}

export async function closeApprovalPages(
  context: BrowserContext,
  keep?: Page
): Promise<void> {
  for (const openPage of context.pages()) {
    if (openPage !== keep && openPage.url().includes("approval.html")) {
      await openPage.close().catch(() => undefined);
    }
  }
}

export async function createWalletInPopup(
  popup: Page,
  password: string,
  createButtonLabel = "Create wallet"
): Promise<void> {
  await expect(
    popup.getByRole("heading", { name: "Xian Wallet" })
  ).toBeVisible();
  await expect(
    popup.getByRole("button", { name: "Create wallet" })
  ).toBeVisible();
  await popup.getByLabel("Password").fill(password);
  await popup.getByRole("button", { name: createButtonLabel }).click();
  await expect(popup.getByText("Recovery phrase")).toBeVisible();
  await expect
    .poll(() =>
      sendRuntimeMessage<{ hasWallet: boolean; unlocked: boolean }>(popup, {
        type: "wallet_get_popup_state"
      })
    )
    .toMatchObject({
      hasWallet: true,
      unlocked: true
    });
}

export async function waitForInjectedProvider(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () => Boolean((window as typeof window & { xian?: { provider?: unknown } }).xian?.provider)
      )
    )
    .toBe(true);
}

export async function startMockRpcServer(options?: {
  chainId?: string;
  nextNonce?: number;
  txHash?: string;
}) {
  const chainId = options?.chainId ?? "xian-local";
  const nextNonce = options?.nextNonce ?? 7;
  const txHash = options?.txHash ?? "ABC123";
  const requests: string[] = [];

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(`${request.method ?? "GET"} ${url.pathname}${url.search}`);

    switch (url.pathname) {
      case "/genesis":
        json(response, 200, {
          result: {
            genesis: {
              chain_id: chainId
            }
          }
        });
        return;
      case "/status":
        json(response, 200, {
          result: {
            node_info: {
              network: chainId
            }
          }
        });
        return;
      case "/abci_query": {
        const rawPath = url.searchParams.get("path") ?? "\"\"";
        const queryPath = rawPath.replace(/^"/, "").replace(/"$/, "");
        if (queryPath.startsWith("/get_next_nonce/")) {
          json(response, 200, {
            result: {
              response: {
                code: 0,
                value: base64(String(nextNonce))
              }
            }
          });
          return;
        }
        json(response, 200, {
          result: {
            response: {
              code: 0,
              value: "AA=="
            }
          }
        });
        return;
      }
      case "/broadcast_tx_sync":
        json(response, 200, {
          result: {
            code: 0,
            hash: txHash
          }
        });
        return;
      case "/broadcast_tx_async":
        json(response, 200, {
          result: {
            hash: txHash
          }
        });
        return;
      case "/tx":
        json(response, 200, {
          result: {
            hash: txHash,
            tx_result: {
              code: 0,
              log: ""
            }
          }
        });
        return;
      default:
        json(response, 404, {
          error: `unsupported test RPC route: ${url.pathname}`
        });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    chainId,
    nextNonce,
    txHash,
    requests,
    url: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

export async function startDappServer(htmlBody?: string) {
  const markup =
    htmlBody ??
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Xian Wallet Test Dapp</title>
  </head>
  <body>
    <main>
      <h1>Xian Wallet Test Dapp</h1>
      <p id="status">ready</p>
    </main>
  </body>
</html>`;

  const server = createServer(
    (_request: IncomingMessage, response: ServerResponse) => {
      html(response, 200, markup);
    }
  );

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}
