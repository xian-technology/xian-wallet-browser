// Messages the wallet UI sends on its own (state refreshes, balance polling,
// lookups) and dapp traffic. Neither is user activity, so neither may keep an
// unlocked wallet from auto-locking.
const PASSIVE_MESSAGE_TYPES = new Set([
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
]);

export function countsAsWalletActivity(type: string): boolean {
  return !PASSIVE_MESSAGE_TYPES.has(type);
}
