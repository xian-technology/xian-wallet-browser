import { writeFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

import {
  cleanupExtension,
  createWalletInPopup,
  launchExtension,
  openExtensionPage,
  sendRuntimeMessage,
  startDappServer,
  startMockRpcServer,
  waitForApprovalPage,
  waitForInjectedProvider
} from "./helpers";

async function installProviderEventLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const provider = (
      window as typeof window & {
        xian?: { provider?: { on(event: string, listener: (...args: unknown[]) => void): void } };
        __xianEventLog?: Array<{ event: string; args: unknown[] }>;
      }
    ).xian?.provider;

    if (!provider) {
      throw new Error("window.xian.provider is not available");
    }

    const events: Array<{ event: string; args: unknown[] }> = [];
    (window as typeof window & { __xianEventLog: typeof events }).__xianEventLog = events;

    for (const event of ["connect", "accountsChanged", "chainChanged", "disconnect"]) {
      provider.on(event, (...args: unknown[]) => {
        events.push({ event, args });
      });
    }
  });
}

async function readProviderEventLog(
  page: Page
): Promise<Array<{ event: string; args: unknown[] }>> {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          __xianEventLog?: Array<{ event: string; args: unknown[] }>;
        }
      ).__xianEventLog ?? []
  );
}

async function setUnlockedSessionExpiry(
  page: Page,
  expiresAt: number
): Promise<void> {
  await page.evaluate((nextExpiresAt) => {
    const sessionKey = "xianWalletShellSession";
    return new Promise<void>((resolve, reject) => {
      chrome.storage.session.get([sessionKey], (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        const session = result[sessionKey] as { expiresAt?: number } | undefined;
        if (!session) {
          reject(new Error("missing unlocked session"));
          return;
        }
        chrome.storage.session.set(
          {
            [sessionKey]: {
              ...session,
              expiresAt: nextExpiresAt
            }
          },
          () => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            resolve();
          }
        );
      });
    });
  }, expiresAt);
}

async function startInjectedProviderRequest(
  page: Page,
  requestKey: string,
  request: Record<string, unknown>
): Promise<void> {
  await page.evaluate(
    ({ key, payload }) => {
      const win = window as typeof window & {
        xian?: { provider?: { request(args: unknown): Promise<unknown> } };
        __xianRequestResults?: Record<string, unknown>;
      };

      const results = win.__xianRequestResults ?? {};
      win.__xianRequestResults = results;
      results[key] = { status: "pending" };

      const provider = win.xian?.provider;
      if (!provider) {
        results[key] = {
          status: "rejected",
          error: {
            name: "Error",
            message: "window.xian.provider is not available"
          }
        };
        return;
      }

      void provider.request(payload).then(
        (result) => {
          results[key] = {
            status: "fulfilled",
            result
          };
        },
        (error) => {
          const candidate = error as {
            name?: unknown;
            message?: unknown;
            code?: unknown;
          };

          results[key] = {
            status: "rejected",
            error: {
              name: typeof candidate.name === "string" ? candidate.name : "Error",
              message:
                typeof candidate.message === "string"
                  ? candidate.message
                  : String(error),
              code: typeof candidate.code === "number" ? candidate.code : undefined
            }
          };
        }
      );
    },
    { key: requestKey, payload: request }
  );
}

async function waitForInjectedProviderResult(
  page: Page,
  requestKey: string
): Promise<
  | { status: "fulfilled"; result: unknown }
  | { status: "rejected"; error: { name: string; message: string; code?: number } }
> {
  await expect
    .poll(() =>
      page.evaluate(
        (key) =>
          (
            window as typeof window & {
              __xianRequestResults?: Record<string, { status?: string }>;
            }
          ).__xianRequestResults?.[key]?.status ?? "pending",
        requestKey
      )
    )
    .not.toBe("pending");

  return page.evaluate(
    (key) =>
      (
        window as typeof window & {
          __xianRequestResults?: Record<string, unknown>;
        }
      ).__xianRequestResults?.[key] as
        | { status: "fulfilled"; result: unknown }
        | {
            status: "rejected";
            error: { name: string; message: string; code?: number };
          },
    requestKey
  );
}

async function readLocalActivityTxs(
  page: Page,
  networkKey: string
): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(
    (key) =>
      new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        chrome.storage.local.get("xianWalletLocalActivity", (result) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          const store = result.xianWalletLocalActivity as
            | Record<string, Array<Record<string, unknown>>>
            | undefined;
          resolve(store?.[key] ?? []);
        });
      }),
    networkKey
  );
}

test("approves connect and send-call requests through the injected provider bridge", async () => {
  const rpc = await startMockRpcServer({
    chainId: "xian-local",
    chiRate: 25,
    chiEstimate: 500,
    nextNonce: 12,
    txHash: "ABC123"
  });
  const dapp = await startDappServer();
  const { context, extensionId, userDataDir } = await launchExtension();

  try {
    const popup = await openExtensionPage(context, extensionId, "popup.html");
    await createWalletInPopup(popup, "correct horse battery");

    await sendRuntimeMessage(popup, {
      type: "wallet_update_settings",
      networkName: "Mock local node",
      expectedChainId: rpc.chainId,
      rpcUrl: rpc.url,
      dashboardUrl: rpc.url
    });

    const dappPage = await context.newPage();
    await dappPage.goto(dapp.url);
    await waitForInjectedProvider(dappPage);
    await installProviderEventLog(dappPage);

    const connectExistingPages = new Set(context.pages());
    await startInjectedProviderRequest(dappPage, "connect", {
      method: "xian_requestAccounts"
    });
    const connectApproval = await waitForApprovalPage(context, connectExistingPages);
    await expect(connectApproval.getByText("Connect wallet")).toBeVisible();
    const connectClose = connectApproval.waitForEvent("close");
    await connectApproval.getByRole("button", { name: "Connect" }).click();
    await connectClose;

    const connectResult = await waitForInjectedProviderResult(dappPage, "connect");
    expect(connectResult).toEqual({
      status: "fulfilled",
      result: [expect.any(String)]
    });
    const [account] =
      connectResult.status === "fulfilled" && Array.isArray(connectResult.result)
        ? (connectResult.result as string[])
        : [];
    expect(account).toMatch(/^[a-f0-9]{64}$/);

    await expect
      .poll(() => readProviderEventLog(dappPage))
      .toEqual([
        { event: "connect", args: [{ chainId: rpc.chainId }] },
        { event: "accountsChanged", args: [[account]] },
        { event: "chainChanged", args: [rpc.chainId] }
      ]);

    const sendExistingPages = new Set(context.pages());
    await startInjectedProviderRequest(dappPage, "send-call", {
      method: "xian_sendCall",
      params: [
        {
          intent: {
            contract: "currency",
            function: "transfer",
            kwargs: {
              to: "bob",
              amount: "5"
            }
          }
        }
      ]
    });
    const sendApproval = await waitForApprovalPage(context, sendExistingPages);
    await expect(sendApproval.getByText("Send contract call")).toBeVisible();
    await expect(sendApproval.getByText("500 (~20 XIAN)")).toBeVisible();
    await expect(
      sendApproval
        .locator(".detail-row", { hasText: "Contract" })
        .locator("strong")
    ).not.toHaveClass(/code/);
    await sendApproval.locator("#trust-toggle").check({ force: true });
    const sendClose = sendApproval.waitForEvent("close");
    await sendApproval.getByRole("button", { name: "Approve call" }).click();
    await sendClose;

    expect(await waitForInjectedProviderResult(dappPage, "send-call")).toEqual({
      status: "fulfilled",
      result: expect.objectContaining({
        accepted: true,
        txHash: "ABC123",
        nonce: 12,
        chiSupplied: 500
      })
    });

    expect(rpc.requests).toEqual(
      expect.arrayContaining([
        "GET /genesis",
        expect.stringContaining("POST /abci_query?path=%22%2Fsimulate_tx%2F"),
        expect.stringContaining("POST /abci_query?path=%22%2Fget_next_nonce%2F"),
        expect.stringContaining("POST /broadcast_tx_sync?tx=%22")
      ])
    );

    await startInjectedProviderRequest(dappPage, "auto-send-call", {
      method: "xian_sendCall",
      params: [
        {
          intent: {
            contract: "currency",
            function: "transfer",
            kwargs: {
              to: "carol",
              amount: "7"
            },
            chi: 500
          }
        }
      ]
    });

    expect(await waitForInjectedProviderResult(dappPage, "auto-send-call")).toEqual({
      status: "fulfilled",
      result: expect.objectContaining({
        accepted: true,
        txHash: "ABC123",
        nonce: 12,
        chiSupplied: 500
      })
    });

    const popupState = await sendRuntimeMessage<{
      activeNetworkId?: string;
      publicKey?: string;
      rpcUrl: string;
    }>(popup, {
      type: "wallet_get_popup_state"
    });
    const networkKey = `${popupState.activeNetworkId ?? popupState.rpcUrl}|${popupState.rpcUrl}|${account}`;

    await expect
      .poll(() => readLocalActivityTxs(popup, networkKey))
      .toEqual([
        expect.objectContaining({
          hash: "ABC123",
          sender: account,
          contract: "currency",
          function: "transfer",
          success: true,
          local: true,
          local_status: "accepted",
          payload: expect.objectContaining({
            kwargs: {
              to: "carol",
              amount: "7"
            }
          })
        })
      ]);
  } finally {
    await cleanupExtension(context, userDataDir);
    await dapp.close();
    await rpc.close();
  }
});

test("switches an open popup to the locked screen when the unlocked session expires", async () => {
  const { context, extensionId, userDataDir } = await launchExtension();

  try {
    const popup = await openExtensionPage(context, extensionId, "popup.html");
    await createWalletInPopup(popup, "correct horse battery");
    await expect(popup.getByRole("button", { name: "Settings" })).toBeVisible();

    await setUnlockedSessionExpiry(popup, Date.now() + 250);

    await popup.reload();

    await expect(
      popup.getByRole("button", { name: "Unlock" })
    ).toBeVisible({ timeout: 3_000 });
    await expect(
      popup.getByText("Wallet is locked.")
    ).toBeVisible();
    await expect(
      popup.getByRole("button", { name: "Settings" })
    ).toHaveCount(0);
    await expect
      .poll(() =>
        sendRuntimeMessage<{ hasWallet: boolean; unlocked: boolean }>(popup, {
          type: "wallet_get_popup_state"
        })
      )
      .toMatchObject({
        hasWallet: true,
        unlocked: false
      });
  } finally {
    await cleanupExtension(context, userDataDir);
  }
});

test("reconciles a stale open popup to the locked screen when the session changes", async () => {
  const { context, extensionId, userDataDir } = await launchExtension();

  try {
    const popup = await openExtensionPage(context, extensionId, "popup.html");
    await createWalletInPopup(popup, "correct horse battery");

    await popup.getByRole("button", { name: "Home" }).click();
    await expect(popup.locator("[data-go-send]")).toBeVisible();

    await setUnlockedSessionExpiry(popup, Date.now() - 1_000);

    await expect(
      popup.getByRole("button", { name: "Unlock" })
    ).toBeVisible({ timeout: 3_000 });
    await expect(popup.getByText("Wallet is locked.")).toBeVisible();
    await expect(popup.locator("[data-max-amount]")).toHaveCount(0);
    await expect
      .poll(() =>
        sendRuntimeMessage<{ hasWallet: boolean; unlocked: boolean }>(popup, {
          type: "wallet_get_popup_state"
        })
      )
      .toMatchObject({
        hasWallet: true,
        unlocked: false
      });
  } finally {
    await cleanupExtension(context, userDataDir);
  }
});

test("locks the wallet when the header lock button is clicked", async () => {
  const { context, extensionId, userDataDir } = await launchExtension();

  try {
    const popup = await openExtensionPage(context, extensionId, "popup.html");
    await createWalletInPopup(popup, "correct horse battery");

    await popup.getByRole("button", { name: "Lock wallet" }).click();

    await expect(popup.getByRole("button", { name: "Unlock" })).toBeVisible();
    await expect(popup.getByText("Wallet is locked.")).toBeVisible();
    await expect
      .poll(() =>
        sendRuntimeMessage<{ hasWallet: boolean; unlocked: boolean }>(popup, {
          type: "wallet_get_popup_state"
        })
      )
      .toMatchObject({
        hasWallet: true,
        unlocked: false
      });
  } finally {
    await cleanupExtension(context, userDataDir);
  }
});

test("imports a wallet backup from file pickers", async ({}, testInfo) => {
  const first = await launchExtension();
  let backup: Record<string, unknown> | null = null;

  try {
    const popup = await openExtensionPage(
      first.context,
      first.extensionId,
      "popup.html"
    );
    await createWalletInPopup(popup, "correct horse battery");
    backup = await sendRuntimeMessage<Record<string, unknown>>(popup, {
      type: "wallet_export",
      password: "backup password"
    });

    const backupFilePath = testInfo.outputPath("xian-wallet-backup.json");
    await writeFile(backupFilePath, JSON.stringify(backup, null, 2), "utf8");

    await popup.getByRole("button", { name: "Settings" }).click();
    await popup.locator("#backup-password").fill("backup password");
    await popup.locator("[data-import-trigger]").click();
    await popup.locator("#import-backup-file").setInputFiles(backupFilePath);
    await expect(popup.locator("#import-backup-json")).toHaveValue(
      JSON.stringify(backup, null, 2)
    );
    await popup.locator("[data-confirm-import-backup]").click();
    await expect(popup.getByRole("button", { name: "Lock wallet" })).toBeVisible();
  } finally {
    await cleanupExtension(first.context, first.userDataDir);
  }
  if (!backup) {
    throw new Error("backup export did not complete");
  }
  const backupFilePath = testInfo.outputPath("xian-wallet-backup.json");

  const second = await launchExtension();

  try {
    const popup = await openExtensionPage(
      second.context,
      second.extensionId,
      "popup.html"
    );
    await expect(
      popup.getByRole("button", { name: "Create wallet" })
    ).toBeVisible();

    await popup.getByRole("button", { name: "Backup" }).click();
    await popup.getByLabel("Backup password").fill("backup password");
    await popup.locator("#setup-backup-file").setInputFiles(backupFilePath);
    await expect(popup.locator("#setup-backup-json")).toHaveValue(
      JSON.stringify(backup, null, 2)
    );
    await popup.getByRole("button", { name: "Import backup" }).click();

    await expect(popup.getByRole("button", { name: "Lock wallet" })).toBeVisible();
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
  } finally {
    await cleanupExtension(second.context, second.userDataDir);
  }
});

test("keeps settings position when actions re-render and updates auto-lock expiry", async () => {
  const { context, extensionId, userDataDir } = await launchExtension();

  try {
    const popup = await openExtensionPage(context, extensionId, "popup.html");
    await createWalletInPopup(popup, "correct horse battery");

    const content = popup.locator(".wallet-content");
    const before = await content.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    });
    expect(before).toBeGreaterThan(100);

    await popup.locator("[data-remove-wallet]").click();
    await expect(popup.locator("[data-confirm-remove]")).toBeVisible();
    await expect
      .poll(() => content.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(before - 120);

    await popup.locator("[data-cancel-remove]").click();
    await popup.locator("[data-toggle-auto-lock]").click();
    await expect(popup.locator("[data-toggle-auto-lock]")).toContainText("Disabled");

    await expect
      .poll(() =>
        sendRuntimeMessage<{
          unlocked: boolean;
          sessionExpiresAt?: number;
        }>(popup, {
          type: "wallet_get_popup_state"
        })
      )
      .toMatchObject({
        unlocked: true,
        sessionExpiresAt: Number.MAX_SAFE_INTEGER
      });
  } finally {
    await cleanupExtension(context, userDataDir);
  }
});

test("filters advanced methods by export decorator and formats structured review arguments", async () => {
  const rpc = await startMockRpcServer({
    contractMethods: {
      currency: [
        {
          name: "transfer",
          arguments: [
            { name: "amount", type: "float" },
            { name: "to", type: "str" }
          ]
        },
        {
          name: "balance_of",
          arguments: [{ name: "address", type: "str" }]
        },
        {
          name: "private_helper",
          arguments: []
        }
      ]
    },
    contractSources: {
      currency: `
@export
def transfer(amount: float, to: str):
    pass

@export(typecheck=False)
def balance_of(address: str):
    return 0

def private_helper():
    return "hidden"
`
    }
  });
  const { context, extensionId, userDataDir } = await launchExtension();

  try {
    const popup = await openExtensionPage(context, extensionId, "popup.html");
    await createWalletInPopup(popup, "correct horse battery");
    await sendRuntimeMessage(popup, {
      type: "wallet_update_settings",
      networkName: "Mock local node",
      expectedChainId: rpc.chainId,
      rpcUrl: rpc.url,
      dashboardUrl: rpc.url
    });

    await popup.getByRole("button", { name: "Home" }).click();
    await popup.locator("[data-go-send]").click();
    await popup.locator("[data-switch-advanced]").click();
    await popup.locator("#send-contract").fill("currency");
    await popup.locator("[data-review-tx]").click();

    const functionSelect = popup.locator("#send-function");
    await expect(functionSelect).toContainText("transfer");
    await expect(functionSelect).toContainText("balance_of");
    await expect(functionSelect).not.toContainText("private_helper");

    await functionSelect.selectOption("transfer");
    await popup.locator(".arg-value").nth(0).fill("1.25");
    await popup.locator(".arg-value").nth(1).fill("bob");
    await popup.locator("[data-chi-mode='manual']").check();
    await popup.locator("#send-chi").fill("50000");
    await popup.locator("[data-review-tx]").click();

    await expect(popup.getByText("Transaction summary")).toBeVisible();
    const summary = popup.locator(".s-card", { hasText: "Transaction summary" });
    await expect(summary.locator(".s-row-key")).toHaveText([
      "Contract",
      "Function",
      "amount",
      "to"
    ]);
    await expect(summary.locator(".s-section-label")).toHaveText("Arguments");
    await expect(
      summary.locator(".s-row").filter({ hasText: "amount" }).getByText("1.25")
    ).toBeVisible();
    await expect(
      summary.locator(".s-row").filter({ hasText: "to" }).getByText("bob")
    ).toBeVisible();
    const fee = popup.locator(".s-card", { hasText: "Transaction fee" });
    await expect(fee.locator(".s-row-key")).toHaveText(["Chi"]);
    await expect(fee.getByText("50,000")).toBeVisible();
    await expect(popup.getByText("[object Object]")).toHaveCount(0);
  } finally {
    await cleanupExtension(context, userDataDir);
    await rpc.close();
  }
});

test("rejects or dismisses pending approvals and returns provider errors to the page", async () => {
  const dapp = await startDappServer();
  const { context, extensionId, userDataDir } = await launchExtension();

  try {
    const popup = await openExtensionPage(context, extensionId, "popup.html");
    await createWalletInPopup(popup, "correct horse battery");

    const dappPage = await context.newPage();
    await dappPage.goto(dapp.url);
    await waitForInjectedProvider(dappPage);

    const connectExistingPages = new Set(context.pages());
    await startInjectedProviderRequest(dappPage, "connect", {
      method: "xian_requestAccounts"
    });
    const connectApproval = await waitForApprovalPage(context, connectExistingPages);
    const connectClose = connectApproval.waitForEvent("close");
    await connectApproval.getByRole("button", { name: "Connect" }).click();
    await connectClose;
    expect(await waitForInjectedProviderResult(dappPage, "connect")).toEqual({
      status: "fulfilled",
      result: [expect.any(String)]
    });

    const rejectExistingPages = new Set(context.pages());
    await startInjectedProviderRequest(dappPage, "reject-sign", {
      method: "xian_signMessage",
      params: [{ message: "reject this" }]
    });
    const rejectApproval = await waitForApprovalPage(context, rejectExistingPages);
    await expect(
      rejectApproval.getByRole("heading", { name: "Sign message" })
    ).toBeVisible();
    const rejectClose = rejectApproval.waitForEvent("close");
    await rejectApproval.getByRole("button", { name: "Reject" }).click();
    await rejectClose;

    expect(await waitForInjectedProviderResult(dappPage, "reject-sign")).toEqual({
      status: "rejected",
      error: expect.objectContaining({
        code: 4100,
        message: "user rejected the request",
        name: "ProviderUnauthorizedError"
      })
    });

    const dismissExistingPages = new Set(context.pages());
    await startInjectedProviderRequest(dappPage, "dismiss-sign", {
      method: "xian_signMessage",
      params: [{ message: "dismiss this" }]
    });
    const dismissApproval = await waitForApprovalPage(context, dismissExistingPages);
    await dismissApproval.close();

    expect(await waitForInjectedProviderResult(dappPage, "dismiss-sign")).toEqual({
      status: "rejected",
      error: expect.objectContaining({
        code: 4100,
        message: "approval dismissed",
        name: "ProviderUnauthorizedError"
      })
    });
  } finally {
    await cleanupExtension(context, userDataDir);
    await dapp.close();
  }
});

test("pushes chainChanged events to connected pages when the active network preset changes", async () => {
  const localRpc = await startMockRpcServer({ chainId: "xian-local" });
  const testRpc = await startMockRpcServer({ chainId: "xian-test" });
  const dapp = await startDappServer();
  const { context, extensionId, userDataDir } = await launchExtension();

  try {
    const popup = await openExtensionPage(context, extensionId, "popup.html");
    await createWalletInPopup(popup, "correct horse battery");

    await sendRuntimeMessage(popup, {
      type: "wallet_update_settings",
      networkName: "Local mock",
      expectedChainId: localRpc.chainId,
      rpcUrl: localRpc.url,
      dashboardUrl: localRpc.url
    });

    const dappPage = await context.newPage();
    await dappPage.goto(dapp.url);
    await waitForInjectedProvider(dappPage);
    await installProviderEventLog(dappPage);

    const connectExistingPages = new Set(context.pages());
    await startInjectedProviderRequest(dappPage, "connect", {
      method: "xian_requestAccounts"
    });
    const connectApproval = await waitForApprovalPage(context, connectExistingPages);
    const connectClose = connectApproval.waitForEvent("close");
    await connectApproval.getByRole("button", { name: "Connect" }).click();
    await connectClose;
    expect(await waitForInjectedProviderResult(dappPage, "connect")).toEqual({
      status: "fulfilled",
      result: [expect.any(String)]
    });

    await sendRuntimeMessage(popup, {
      type: "wallet_save_network_preset",
      id: "testnet-preset",
      name: "Test mock",
      chainId: testRpc.chainId,
      rpcUrl: testRpc.url,
      dashboardUrl: testRpc.url,
      makeActive: false
    });
    await sendRuntimeMessage(popup, {
      type: "wallet_switch_network",
      presetId: "testnet-preset"
    });

    await expect
      .poll(async () => {
        const events = await readProviderEventLog(dappPage);
        return events.at(-1);
      })
      .toEqual({
        event: "chainChanged",
        args: [testRpc.chainId]
      });

    await startInjectedProviderRequest(dappPage, "chain-id", {
      method: "xian_chainId"
    });
    expect(await waitForInjectedProviderResult(dappPage, "chain-id")).toEqual({
      status: "fulfilled",
      result: testRpc.chainId
    });
  } finally {
    await cleanupExtension(context, userDataDir);
    await dapp.close();
    await testRpc.close();
    await localRpc.close();
  }
});
