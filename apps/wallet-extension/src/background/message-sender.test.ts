import { describe, expect, it } from "vitest";
import type { RuntimeMessage } from "../shared/messages";
import { authorizeRuntimeMessage } from "./message-sender";

const id = "wallet-extension";
const page = {id, url: "https://actual.example/path", origin: "https://actual.example", tab: {id: 1}};
const popup = {id, url: `chrome-extension://${id}/popup.html`};
const request = {type: "provider_request_status", requestId: "request", origin: "https://forged.example", consume: true} as RuntimeMessage;

describe("runtime sender boundary", () => {
  it("binds provider status consumption to the browser-supplied frame origin", () => {
    expect(authorizeRuntimeMessage(request, page, id)).toMatchObject({origin: "https://actual.example"});
  });
  it("binds provider request approval to the browser-supplied frame origin", () => {
    const message = {type: "provider_request", requestId: "request", origin: "https://forged.example", request: {method: "xian_accounts"}} as RuntimeMessage;
    expect(authorizeRuntimeMessage(message, page, id)).toMatchObject({origin: "https://actual.example"});
  });
  it.each(["wallet_export", "wallet_remove", "wallet_send_direct_transaction", "approval_resolve"])("blocks page command %s", type => {
    expect(() => authorizeRuntimeMessage({type} as RuntimeMessage, page, id)).toThrow();
  });
  it.each([{...page, id: "other"}, {...page, id: undefined}, {...page, origin: "null"}, {...page, origin: "https://other.example"}, {...page, tab: undefined}, {...page, url: "file:///tmp/page"}])("rejects untrusted sender %j", sender => {
    expect(() => authorizeRuntimeMessage(request, sender, id)).toThrow();
  });
  it("allows privileged commands only from packaged wallet UI pages", () => {
    const message = {type: "wallet_remove"} as RuntimeMessage;
    expect(authorizeRuntimeMessage(message, popup, id)).toEqual(message);
    expect(authorizeRuntimeMessage(message, {...popup, url: `chrome-extension://${id}/approval.html?id=1`}, id)).toEqual(message);
    expect(() => authorizeRuntimeMessage(message, {...popup, url: `chrome-extension://${id}/inpage.js`}, id)).toThrow();
  });
  it("uses sender URL when an older browser omits origin", () => {
    expect(authorizeRuntimeMessage(request, {...page, origin: undefined}, id)).toMatchObject({origin: "https://actual.example"});
  });
});
