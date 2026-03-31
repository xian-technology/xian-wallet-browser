import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import {
  cleanupExtension,
  closeApprovalPages,
  createWalletInPopup,
  launchExtension,
  openExtensionPage,
  sendRuntimeMessage,
  waitForApprovalPage
} from "./helpers";

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

  const approvalPage = await waitForApprovalPage(context, existingPages);
  await sendRuntimeMessage(page, {
    type: "approval_resolve",
    approvalId: start.approvalId,
    approved: true
  });
  await approvalPage.waitForTimeout(150);
}

test("captures popup and approval visuals for the wallet extension", async ({}, testInfo) => {
  const { context, extensionId, userDataDir } = await launchExtension();

  try {
    const popup = await openExtensionPage(context, extensionId, "popup.html");

    await expect(
      popup.getByRole("heading", { name: "Xian Wallet" })
    ).toBeVisible();
    await expect(
      popup.getByRole("button", { name: "Create wallet" })
    ).toBeVisible();
    await popup.screenshot({
      path: testInfo.outputPath("popup-setup.png"),
      fullPage: true
    });

    await createWalletInPopup(popup, "correct horse battery");
    await popup.screenshot({
      path: testInfo.outputPath("popup-security-created.png"),
      fullPage: true
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
    await expect(popup.getByText("Pending")).toBeVisible();
    await popup.screenshot({
      path: testInfo.outputPath("popup-overview.png"),
      fullPage: true
    });

    await popup.getByRole("button", { name: "Apps" }).click();
    await expect(popup.getByText("Connected apps")).toBeVisible();
    await popup.screenshot({
      path: testInfo.outputPath("popup-apps.png"),
      fullPage: true
    });

    await popup.getByRole("button", { name: "Settings" }).click();
    await expect(
      popup.getByRole("heading", { name: "Networks" })
    ).toBeVisible();
    await popup.screenshot({
      path: testInfo.outputPath("popup-security.png"),
      fullPage: true
    });
    await closeApprovalPages(context, approvalPage);
  } finally {
    await cleanupExtension(context, userDataDir);
  }
});
