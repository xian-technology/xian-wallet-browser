import type { StoredProviderRequest } from "@xian-tech/wallet-core";
import { describe, expect, it } from "vitest";

import { completedProviderRequestMessage } from "./provider-request-notification";

const storedRequest: StoredProviderRequest = {
  requestId: "request-1",
  origin: "http://127.0.0.1:5173",
  request: {
    method: "xian_sendCall",
    params: {
      intent: {
        contract: "con_dex",
        function: "addLiquidity",
        kwargs: {}
      }
    }
  },
  createdAt: 1,
  updatedAt: 2,
  status: "fulfilled",
  result: { submitted: true, accepted: true, finalized: true }
};

describe("completedProviderRequestMessage", () => {
  it("reconstructs a consumed approval-mediated transaction request", () => {
    expect(
      completedProviderRequestMessage(
        {
          type: "provider_request_status",
          origin: storedRequest.origin,
          requestId: storedRequest.requestId,
          consume: true
        },
        storedRequest,
        {
          status: "fulfilled",
          result: storedRequest.result
        }
      )
    ).toEqual({
      type: "provider_request",
      origin: storedRequest.origin,
      requestId: storedRequest.requestId,
      request: storedRequest.request,
      dappMetadata: undefined
    });
  });

  it("does not notify for unconsumed or non-fulfilled status reads", () => {
    expect(
      completedProviderRequestMessage(
        {
          type: "provider_request_status",
          origin: storedRequest.origin,
          requestId: storedRequest.requestId
        },
        storedRequest,
        { status: "fulfilled", result: storedRequest.result }
      )
    ).toBeNull();

    expect(
      completedProviderRequestMessage(
        {
          type: "provider_request_status",
          origin: storedRequest.origin,
          requestId: storedRequest.requestId,
          consume: true
        },
        storedRequest,
        { status: "pending" }
      )
    ).toBeNull();
  });

  it("does not notify a different origin", () => {
    expect(
      completedProviderRequestMessage(
        {
          type: "provider_request_status",
          origin: "https://other.example",
          requestId: storedRequest.requestId,
          consume: true
        },
        storedRequest,
        { status: "fulfilled", result: storedRequest.result }
      )
    ).toBeNull();
  });
});
