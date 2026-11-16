import { describe, expect, it } from "vitest";

import { renderUnusedChiBanner } from "./unused-chi";

// A manual chi limit is reviewed against the call's simulation: the user
// pays half of whatever the limit leaves unused, and can switch to the estimate.
describe("renderUnusedChiBanner", () => {
  it("warns with the extra cost and offers the estimate for a generous limit", () => {
    const html = renderUnusedChiBanner({
      supplied: 600,
      estimate: { estimated: 400, supply: 402 },
      chiRate: 20
    });

    expect(html).toContain('class="banner banner-warning');
    expect(html).toContain("leaves 200 chi unused");
    expect(html).toContain("about 100 (~5 XIAN) more");
    expect(html).toContain("data-use-chi-estimate");
    expect(html).toContain("Use estimate (402 chi)");
  });

  it("escalates to danger once the extra at least doubles the fee", () => {
    const html = renderUnusedChiBanner({
      supplied: 50_000,
      estimate: { estimated: 312, supply: 314 },
      chiRate: 20
    });

    expect(html).toContain('class="banner banner-danger');
    expect(html).toContain(`${(160).toLocaleString()}x what the call needs`);
  });

  it("shows nothing near the estimate or without a simulation", () => {
    expect(renderUnusedChiBanner({ supplied: 402, estimate: { estimated: 400, supply: 402 }, chiRate: 20 })).toBe("");
    expect(renderUnusedChiBanner({ supplied: 50_000, estimate: null, chiRate: 20 })).toBe("");
  });
});
