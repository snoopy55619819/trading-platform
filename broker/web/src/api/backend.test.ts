import { afterEach, describe, expect, test, vi } from "vitest";

import { ApiError, backend } from "./backend.ts";
import { session } from "./session.ts";

function respond(status: number, body: object) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  session.end();
});

describe("backend client", () => {
  test("sends the session token, and JSON only when there is a body", async () => {
    session.start("tok");
    const fetchMock = respond(200, { orders: [] });
    await backend.orders();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:8080/orders");
    expect(init.headers).toEqual({ authorization: "Bearer tok" });
  });

  test("a rejected order surfaces its named reason and the recorded order", async () => {
    session.start("tok");
    respond(422, { orderId: "01ABC", status: "REJECTED", rejectReason: "INSUFFICIENT_BUYING_POWER", rejectText: "needs more" });
    const error = await backend
      .placeOrder({ clientOrderId: "c", symbol: "ACME", side: "BUY", orderType: "MARKET", timeInForce: "IOC", qty: 1 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).reason).toBe("INSUFFICIENT_BUYING_POWER");
    expect((error as ApiError).order?.orderId).toBe("01ABC");
    expect((error as ApiError).message).toBe("needs more");
  });

  test("a 401 on a signed-in request signs out", async () => {
    session.start("expired");
    respond(401, { text: "sign in first" });
    await expect(backend.positions()).rejects.toBeInstanceOf(ApiError);
    expect(session.token()).toBeUndefined();
  });
});
