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

test("approves connect and send-call requests through the injected provider bridge", async () => {
  const rpc = await startMockRpcServer({
    chainId: "xian-local",
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
            },
            stamps: 500
          }
        }
      ]
    });
    const sendApproval = await waitForApprovalPage(context, sendExistingPages);
    await expect(sendApproval.getByText("Send contract call")).toBeVisible();
    const sendClose = sendApproval.waitForEvent("close");
    await sendApproval.getByRole("button", { name: "Approve call" }).click();
    await sendClose;

    expect(await waitForInjectedProviderResult(dappPage, "send-call")).toEqual({
      status: "fulfilled",
      result: expect.objectContaining({
        accepted: true,
        txHash: "ABC123",
        nonce: 12,
        stampsSupplied: 500
      })
    });

    expect(rpc.requests).toEqual(
      expect.arrayContaining([
        "GET /genesis",
        expect.stringContaining("POST /abci_query?path=%22%2Fget_next_nonce%2F"),
        expect.stringContaining("POST /broadcast_tx_sync?tx=%22")
      ])
    );
  } finally {
    await cleanupExtension(context, userDataDir);
    await dapp.close();
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
