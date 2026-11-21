import { expect, test } from "@playwright/test";
import { Ed25519Signer, XianClient, fixedValueText, generatePrivateKey, publicKeyFromPrivateKey } from "@xian-tech/client";
import {
  cleanupExtension,
  createWalletInPopup,
  launchExtension,
  openExtensionPage,
  sendRuntimeMessage
} from "./helpers";

const rpcUrl = process.env.XIAN_LIVE_SDK_RPC;
const fundingKey = process.env.XIAN_WALLET_TEST_FUNDING_KEY;

test("shows and transfers an exact decimal through the extension on a dev node", async () => {
  test.skip(!rpcUrl || !fundingKey, "requires a disposable dev node and funded development key");
  const client = new XianClient({ rpcUrl: rpcUrl! });
  const signer = new Ed25519Signer(fundingKey!);
  const recipient = publicKeyFromPrivateKey(generatePrivateKey());
  const { context, extensionId, userDataDir } = await launchExtension();
  try {
    const popup = await openExtensionPage(context, extensionId, "popup.html");
    await createWalletInPopup(popup, "isolated wallet test");
    const { publicKey } = await sendRuntimeMessage<{ publicKey: string }>(popup, {
      type: "wallet_get_popup_state"
    });
    const funding = await client.token().transfer({
      signer, to: publicKey, amount: "10000.125", chi: 20_000, waitForTx: true
    });
    expect(funding.receipt?.success).toBe(true);
    await sendRuntimeMessage(popup, {
      type: "wallet_update_settings",
      networkName: "SDK dev node",
      expectedChainId: await client.getChainId(),
      rpcUrl,
      dashboardUrl: rpcUrl
    });
    await popup.reload();
    const readWallet = () => sendRuntimeMessage<{ balances: Record<string, string> }>(popup, {
      type: "wallet_get_asset_balances"
    });
    await expect.poll(async () => (await readWallet()).balances.currency).toBe("10000.125");

    await expect(popup.locator("[data-go-send]")).toBeVisible();
    await popup.locator("[data-go-send]").click();
    await popup.locator("#simple-to").fill(recipient);
    await popup.locator("#simple-amount").fill("0.125");
    const review = popup.getByRole("button", { name: "Review" });
    await expect(review).toBeEnabled();
    await review.click();
    await expect.poll(async () => {
      if (await popup.getByText("Transaction summary").isVisible()) return "ready";
      return await popup.locator(".flash-toast").textContent({ timeout: 1_000 }).catch(() => "");
    }).toBe("ready");
    await popup.getByRole("button", { name: "Send Transaction" }).click({ timeout: 10_000 });
    await expect(popup.locator(".flash-toast")).toContainText("Transaction finalized.");
    await expect.poll(async () => fixedValueText(await client.getBalance(recipient))).toBe("0.125");
    await expect.poll(async () => (await readWallet()).balances.currency).toBe("10000");
  } finally {
    await cleanupExtension(context, userDataDir);
  }
});
