import { describe, expect, it } from "vitest";

import { renderAppFavicon } from "./app-favicon";

// The connected-apps list must not tell a third party which dapps the user
// connected: only the dapp's own icon (from its own page) is ever loaded.
describe("renderAppFavicon", () => {
  it("shows only the letter placeholder when the dapp declared no icon", () => {
    const html = renderAppFavicon({ letter: "S", background: "#123", iconUrl: undefined });

    expect(html).toContain('class="app-favicon-placeholder"');
    expect(html).toContain(">S<");
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("loads the dapp's own icon over the placeholder", () => {
    const html = renderAppFavicon({
      letter: "S",
      background: "#123",
      iconUrl: "https://snakx.example/icon.svg"
    });

    expect(html).toContain('src="https://snakx.example/icon.svg"');
    expect(html).toContain("data-app-favicon");
    expect(html.match(/https?:\/\/[^"]+/g)).toEqual(["https://snakx.example/icon.svg"]);
  });

  it("escapes the icon URL and the letter", () => {
    const html = renderAppFavicon({ letter: "<", background: "#123", iconUrl: 'https://x.example/"a' });

    expect(html).toContain("&lt;");
    expect(html).not.toContain('"a"');
  });
});
