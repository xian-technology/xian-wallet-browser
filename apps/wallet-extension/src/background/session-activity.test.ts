import { describe, expect, it } from "vitest";

import { countsAsWalletActivity } from "./session-activity";

describe("wallet session activity", () => {
  it.each([
    "wallet_send_direct_transaction",
    "wallet_switch_account",
    "wallet_update_settings",
    "wallet_estimate_transaction",
    "approval_resolve",
    "contacts_save"
  ])("treats %s as explicit wallet activity", (type) => {
    expect(countsAsWalletActivity(type)).toBe(true);
  });

  it.each([
    "provider_request",
    "provider_request_status",
    "wallet_get_popup_state",
    "wallet_get_asset_balances",
    "wallet_get_detected_assets",
    "wallet_get_token_metadata",
    "wallet_get_chi_rate",
    "wallet_get_contract_methods",
    "wallet_get_dex_snapshot",
    "wallet_get_shielded_snapshot_history",
    "wallet_get_auto_lock",
    "contacts_get",
    "approval_get"
  ])("does not let %s keep the wallet unlocked", (type) => {
    expect(countsAsWalletActivity(type)).toBe(false);
  });
});
