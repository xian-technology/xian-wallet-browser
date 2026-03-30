import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(__dirname, "../dist");
async function launchExtension(): Promise<{
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

async function openExtensionPage(
  context: BrowserContext,
  extensionId: string,
  relativePath: string
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${relativePath}`);
  return page;
}

async function sendRuntimeMessage<T>(page: Page, message: unknown): Promise<T> {
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

async function startApprovedRequest(
  context: BrowserContext,
  page: Page,
  message: {
    origin: string;
    requestId: string;
    request: Record<string, unknown>;
  }
): Promise<void> {
  const existingPages = new Set(context.pages());

  const start = await sendRuntimeMessage<{ status: string; approvalId?: string }>(page, {
    type: "provider_request",
    ...message
  });

  if (start.status !== "pending") {
    throw new Error(`expected pending approval request, received ${JSON.stringify(start)}`);
  }
  expect(start.approvalId).toBeTruthy();

  const approvalPage =
    context.pages().find(
      (candidate) =>
        !existingPages.has(candidate) || candidate.url().includes("approval.html")
    ) ?? (await context.waitForEvent("page"));
  await approvalPage.waitForURL(/approval\.html/);
  await approvalPage.waitForLoadState("domcontentloaded");
  await sendRuntimeMessage(page, {
    type: "approval_resolve",
    approvalId: start.approvalId,
    approved: true
  });
  await approvalPage.waitForTimeout(150);
}

async function closeApprovalPages(
  context: BrowserContext,
  keep?: Page
): Promise<void> {
  for (const openPage of context.pages()) {
    if (openPage !== keep && openPage.url().includes("approval.html")) {
      await openPage.close().catch(() => undefined);
    }
  }
}

test("captures popup and approval visuals for the wallet extension", async ({}, testInfo) => {
  const { context, extensionId, userDataDir } = await launchExtension();

  try {
    const popup = await openExtensionPage(context, extensionId, "popup.html");

    await expect(popup.getByText("Set up wallet")).toBeVisible();
    await popup.screenshot({
      path: testInfo.outputPath("popup-setup.png"),
      fullPage: true
    });

    await popup.getByLabel("Password").fill("correct horse battery");
    await popup.getByRole("button", { name: "Create wallet" }).click();

    await expect(popup.getByText("Recovery phrase")).toBeVisible();
    await popup.screenshot({
      path: testInfo.outputPath("popup-security-created.png"),
      fullPage: true
    });
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

    await startApprovedRequest(context, popup, {
      origin: "https://swap.example",
      requestId: "visual-connect-1",
      request: {
        method: "xian_requestAccounts"
      }
    });

    await closeApprovalPages(context);

    const existingPages = new Set(context.pages());

    const providerStart = await sendRuntimeMessage<{ status: string }>(popup, {
      type: "provider_request",
      origin: "https://swap.example",
      requestId: "visual-send-call",
      request: {
        method: "xian_sendCall",
        params: [
          {
            intent: {
              contract: "currency",
              function: "transfer",
              kwargs: {
                to: "bob",
                amount: "5"
              },
              stamps: 500
            }
          }
        ]
      }
    });

    if (providerStart.status !== "pending") {
      throw new Error(
        `expected pending send-call approval, received ${JSON.stringify(providerStart)}`
      );
    }

    const approvalPage =
      context.pages().find(
        (candidate) =>
          !existingPages.has(candidate) || candidate.url().includes("approval.html")
      ) ?? (await context.waitForEvent("page"));
    await approvalPage.waitForURL(/approval\.html/);
    await approvalPage.waitForLoadState("domcontentloaded");
    await expect(approvalPage.getByText("Send contract call")).toBeVisible();
    await approvalPage.screenshot({
      path: testInfo.outputPath("approval-send-call.png"),
      fullPage: true
    });

    await popup.reload();
    await expect(popup.getByText("Pending approvals")).toBeVisible();
    await popup.screenshot({
      path: testInfo.outputPath("popup-overview.png"),
      fullPage: true
    });

    await popup.getByRole("button", { name: "Apps" }).click();
    await expect(
      popup.getByRole("heading", { name: "Connected apps" })
    ).toBeVisible();
    await popup.screenshot({
      path: testInfo.outputPath("popup-apps.png"),
      fullPage: true
    });

    await popup.getByRole("button", { name: "Security" }).click();
    await expect(
      popup.getByRole("heading", { name: "Network presets" })
    ).toBeVisible();
    await popup.screenshot({
      path: testInfo.outputPath("popup-security.png"),
      fullPage: true
    });
    await closeApprovalPages(context, approvalPage);
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});
