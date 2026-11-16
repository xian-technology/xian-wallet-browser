import { unusedChiCost, unusedChiWarning } from "@xian-tech/wallet-core";

import { escapeHtml } from "./format";

/**
 * The review banner for a manual chi limit: what its unused chi costs (half of
 * it is charged) and a one-tap switch to the simulated estimate. Empty when the
 * call was not simulated or the limit costs nothing extra.
 */
export function renderUnusedChiBanner(input: {
  supplied: number;
  estimate: { estimated: number; supply: number } | null;
  chiRate: number | null;
}): string {
  if (!input.estimate) {
    return "";
  }
  const cost = unusedChiCost({ supplied: input.supplied, estimated: input.estimate.estimated });
  const warning = cost ? unusedChiWarning(cost, input.chiRate) : null;
  if (!cost || !warning) {
    return "";
  }
  const tone = cost.severity === "high" ? "danger" : "warning";
  return `
    <div class="banner banner-${tone} text-sm stack">
      <div>${escapeHtml(warning)}</div>
      <button class="ghost-sm" data-use-chi-estimate>Use estimate (${escapeHtml(
        input.estimate.supply.toLocaleString()
      )} chi)</button>
    </div>
  `;
}
