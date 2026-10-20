import { afterEach, describe, expect, test } from "bun:test";
import type { BrokerOrderRequest } from "gloomberb/types/trading";
import { AriesOrderService, type AriesOrderClient, type AriesOrderServiceOptions } from "./orders";

interface Recorded { method: string; path: string; query: URLSearchParams; body?: Record<string, unknown> }
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

const accounts = [{ accountId: "SYNTH-SIM-001", isSim: true }, { accountId: "SYNTH-LIVE-002", isSim: false }];
const request = (changes: Partial<BrokerOrderRequest> = {}): BrokerOrderRequest => ({
  brokerInstanceId: "profile-test", accountId: accounts[0]!.accountId,
  contract: { brokerId: "aries", brokerInstanceId: "profile-test", symbol: "AAPL", secType: "STK", currency: "USD" },
  action: "BUY", orderType: "LMT", quantity: 10, limitPrice: 150.25, tif: "DAY", ...changes,
});
const optionRequest = (changes: Partial<BrokerOrderRequest> = {}): BrokerOrderRequest => request({
  contract: { brokerId: "aries", symbol: "AAPL", localSymbol: "AAPL  270115C00150000", secType: "OPT", currency: "USD", multiplier: "100" },
  quantity: 1, limitPrice: 2.5, ...changes,
});
const active = (changes: Record<string, unknown> = {}) => ({
  accountId: accounts[0]!.accountId, clOrdId: "synthetic-client-001", ordId: "synthetic-broker-001", symbol: "AAPL",
  side: "BUY", type: "LIMIT", timeInForce: "DAY", qty: "10", price: "150.25", stopPrice: "", ordStatus: "NEW",
  cumQty: "2", leavesQty: "8", avgPrice: "150.2", currency: "USD", exDestination: "MNGD", securityType: "EQUITY",
  category: "EQUITY", legs: [], createdAt: "2026-10-09T14:00:00Z", updatedAt: "2026-10-09T14:01:00Z", ...changes,
});

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function mock(options: Partial<AriesOrderServiceOptions> = {}, handler?: (record: Recorded) => unknown | Promise<unknown>) {
  const records: Recorded[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const record: Recorded = { method: req.method, path: url.pathname, query: url.searchParams };
      if (req.method === "POST") record.body = await req.json() as Record<string, unknown>;
      records.push(record);
      if (handler) return Response.json(await handler(record));
      if (req.method === "GET") return Response.json({ orders: [], nextCursor: 0 });
      if (url.pathname.endsWith("/preview")) return Response.json({ estimatedCost: "1502.50", commission: "0", fees: "0.05", buyingPowerImpact: "1502.55" });
      if (url.pathname.endsWith("/cancel")) return Response.json({ success: true, status: "CANCELED", clOrdId: "synthetic-cancel-001" });
      return Response.json({ success: true, status: "NEW", clOrdId: "synthetic-client-001", cumQty: "0", leavesQty: record.body?.qty, transactTime: "2026-10-09T14:02:00Z" });
    },
  });
  servers.push(server);
  const client: AriesOrderClient = {
    async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
      const url = new URL(path, server.url);
      for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
      return await (await fetch(url)).json() as T;
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      return await (await fetch(new URL(path, server.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json() as T;
    },
  };
  return {
    records,
    service: new AriesOrderService(client, {
      accounts: async () => accounts, tradingEnabled: () => true, brokerInstanceId: "profile-test",
      optionPositions: async () => [], now: () => Date.parse("2026-10-09T14:30:00Z"), ...options,
    }),
  };
}

describe("Aries option spreads", () => {
  const leg = (osi: string, action: "BUY" | "SELL", ratio = 1) => ({ contract: { brokerId: "aries", brokerInstanceId: "profile-test", symbol: "AAPL", localSymbol: osi, secType: "OPT", currency: "USD", multiplier: "100" }, action, ratio });
  const vertical = [leg("AAPL261026C00345000", "BUY"), leg("AAPL261026C00350000", "SELL")];
  const spread = (changes: Record<string, unknown> = {}) => request({
    contract: { brokerId: "aries", brokerInstanceId: "profile-test", symbol: "AAPL", secType: "BAG", exchange: "SMART", currency: "USD", multiplier: "100" },
    quantity: 2, limitPrice: 1.5, ...changes, legs: (changes.legs as unknown) ?? vertical,
  } as Partial<BrokerOrderRequest>);
  const bodyLegs = (body: Record<string, unknown> | undefined) => (body?.legs as Record<string, unknown>[]).map((value) => `${value.side} ${value.ratioQty} ${value.strikePrice} ${value.positionEffect}`);

  // Aries keeps a spread's side as its last leg's and prices it as a signed net debit (simulation, 2026-10-19):
  // a credit sent with a positive price filled at the market.
  test("a debit goes out with a BUY leg last and a positive price; a credit with a SELL leg last and a negative price", async () => {
    const { service, records } = mock({ optionPositions: async () => [{ symbol: "AAPL261026C00350000", quantity: 3 }] });
    await service.previewOrder(spread());
    expect(records.at(-1)!.body).toMatchObject({ symbol: "AAPL", side: "BUY", type: "LIMIT", qty: "2", price: "1.5", timeInForce: "DAY" });
    // Selling the held 350 call closes it; two spreads sell two of the three.
    expect(bodyLegs(records.at(-1)!.body)).toEqual(["SELL 1 350 CLOSE", "BUY 1 345 OPEN"]);
    await service.previewOrder(spread({ action: "SELL", limitPrice: 1.2, legs: vertical.map((value) => ({ ...value, action: value.action === "BUY" ? "SELL" : "BUY" })) }));
    expect(records.at(-1)!.body).toMatchObject({ side: "SELL", price: "-1.2" });
    expect(bodyLegs(records.at(-1)!.body)).toEqual(["BUY 1 350 OPEN", "SELL 1 345 OPEN"]);
    await expect(service.previewOrder(spread({ orderType: "STP", limitPrice: undefined, stopPrice: 1 }))).rejects.toThrow("market and limit spreads");
    await expect(service.previewOrder(spread({ legs: [vertical[0]!] }))).rejects.toThrow("2 to 4 legs");
  });

  test("a spread read back trades as one order: its side from the price's sign, changed with its legs and cancelled by its ID", async () => {
    const row = { accountId: accounts[0]!.accountId, clOrdId: "synthetic-spread", symbol: "AAPL", side: "BUY", type: "LIMIT", timeInForce: "DAY", qty: "1", price: "-1.25",
      ordStatus: "NEW", cumQty: "0", leavesQty: "1", securityType: "OPTION", category: "MULTI_LEG", updatedAt: "2026-10-19T22:00:00Z",
      legs: [{ symbol: "AAPL", side: "SELL", ratioQty: "1", maturity: "2026-10-26", strikePrice: "345", putCall: "CALL", positionEffect: "CLOSE" },
        { symbol: "AAPL", side: "BUY", ratioQty: "1", maturity: "2026-10-26", strikePrice: "350", putCall: "CALL", positionEffect: "OPEN" }] };
    const { service, records } = mock({ accounts: async () => [accounts[0]!], optionPositions: async () => { throw new Error("A replacement keeps each leg's effect."); } }, (record) => record.method === "GET"
      ? { orders: record.path.endsWith("history") ? [] : [row], nextCursor: 0 } : { success: true, status: "NEW", clOrdId: "synthetic-spread-2" });
    const [order] = await service.listOpenOrders() as (Awaited<ReturnType<typeof service.listOpenOrders>>[number] & { legs?: { action: string; ratio: number; contract: { localSymbol?: string } }[] })[];
    expect([order!.action, order!.limitPrice, order!.contract.secType]).toEqual(["SELL", 1.25, "BAG"]);
    expect(order!.legs!.map((value) => `${value.action} ${value.contract.localSymbol}`)).toEqual(["SELL AAPL261026C00345000", "BUY AAPL261026C00350000"]);
    expect(order!.warningText).not.toContain("Manage it in Aries");
    // The legs in another order are the same spread; the replacement resends each leg's effect.
    await service.modifyOrder(order!.orderId, { ...spread({ action: "SELL", quantity: 1, limitPrice: 1.3 }), legs: [...order!.legs!].reverse() } as BrokerOrderRequest);
    expect(records.at(-1)!.path).toBe("/v1/orders/replace");
    expect(records.at(-1)!.body).toMatchObject({ side: "SELL", price: "-1.3", origClOrdId: "synthetic-spread" });
    expect(bodyLegs(records.at(-1)!.body)).toEqual(["BUY 1 350 OPEN", "SELL 1 345 CLOSE"]);
    await expect(service.modifyOrder(order!.orderId, { ...spread({ action: "SELL", quantity: 1 }), legs: [order!.legs![0]!] } as BrokerOrderRequest)).rejects.toThrow("keeps the spread's legs");
    await service.cancelOrder(order!.orderId);
    // Aries rejects a spread cancel that names OPT without one contract's fields.
    expect(records.at(-1)!.body).toEqual({ tradingAccountId: accounts[0]!.accountId, origClOrdId: "synthetic-spread-2", symbol: "AAPL", side: "SELL" });
  });
});

describe("Aries order requests against a recording loopback server", () => {
  test("zero price placeholders from an order read do not leak into LIMIT replacement requests", async () => {
    const { service, records } = mock({ accounts: async () => [accounts[0]!] }, (record) => {
      if (record.method === "GET") return { orders: [active({ stopPrice: "0", cumQty: "0", leavesQty: "10" })] };
      return { success: true, status: "REPLACED", clOrdId: "synthetic-replaced", cumQty: "0", leavesQty: "10" };
    });
    const order = (await service.listOpenOrders())[0]!;
    expect(order.stopPrice).toBeUndefined();
    const changed = await service.modifyOrder(order.orderId, request({ limitPrice: 149.25, stopPrice: order.stopPrice }));
    expect(changed.orderId).toBe(order.orderId);
    expect(changed.brokerOrderId).toBe("synthetic-replaced");
    const sent = records.find((record) => record.path.endsWith("/replace"))!.body!;
    expect(sent.price).toBe("149.25");
    expect(sent).not.toHaveProperty("stopPrice");
  });
  test("terminal lookup matches the current client ID in zero-fill history without inferring from absence", async () => {
    let history: unknown[] = [];
    let open = true;
    const { service } = mock({ accounts: async () => [accounts[0]!] }, (record) => record.path.endsWith("/history") ? { orders: history } : { orders: open ? [active({ cumQty: "0" })] : [] });
    const order = (await service.listOpenOrders())[0]!;
    open = false;
    expect(await service.getOrderStatus(order.orderId)).toBeNull();
    history = [active({ clOrdId: "unrelated", ordStatus: "CANCELED", cumQty: "0" })];
    expect(await service.getOrderStatus(order.orderId)).toBeNull();
    history = [active({ ordStatus: "CANCELED", cumQty: "0", leavesQty: "0" })];
    expect(await service.getOrderStatus(order.orderId)).toMatchObject({ orderId: order.orderId, brokerOrderId: order.brokerOrderId, status: "CANCELED", filled: 0 });
  });
  test.each([
    ["MKT", undefined, undefined, "MARKET"], ["LMT", 150.25, undefined, "LIMIT"],
    ["STP", undefined, 149, "STOP"], ["STP LMT", 150.25, 149, "STOP_LIMIT"],
  ] as const)("maps %s without dropping price fields", async (orderType, limitPrice, stopPrice, type) => {
    const { service, records } = mock();
    await service.previewOrder(request({ orderType, limitPrice, stopPrice, quantity: 1.25 }));
    expect(records).toHaveLength(1);
    expect(records[0]?.path).toBe("/v1/orders/preview");
    expect(records[0]?.body).toEqual({
      tradingAccountId: "SYNTH-SIM-001", symbol: "AAPL", side: "BUY", type, qty: "1.25", timeInForce: "DAY", currency: "USD",
      ...(limitPrice === undefined ? {} : { price: String(limitPrice) }), ...(stopPrice === undefined ? {} : { stopPrice: String(stopPrice) }),
    });
  });

  test("trading off guards every mutation before any request", async () => {
    const { service, records } = mock({ tradingEnabled: () => false });
    for (const action of [() => service.previewOrder(request()), () => service.placeOrder(request()), () => service.modifyOrder(1, request()), () => service.cancelOrder(1)]) {
      await expect(action()).rejects.toThrow("Trading is disabled");
    }
    expect(records).toHaveLength(0);
  });

  test("requires an explicitly selected included account and correct profile", async () => {
    const { service, records } = mock();
    await expect(service.previewOrder(request({ accountId: undefined }))).rejects.toThrow("explicitly");
    await expect(service.previewOrder(request({ accountId: "SYNTH-UNKNOWN" }))).rejects.toThrow("not included");
    await expect(service.previewOrder(request({ brokerInstanceId: "other" }))).rejects.toThrow("different broker profile");
    expect(records).toHaveLength(0);
    const preview = await service.previewOrder(request({ accountId: accounts[1]!.accountId }));
    expect(records[0]?.body?.tradingAccountId).toBe(accounts[1]!.accountId);
    expect(preview.warningText).toContain("LIVE account. Orders use real money");
  });

  test("preview shows labelled estimates without inventing before/after margin values", async () => {
    const { service } = mock();
    const preview = await service.previewOrder(request());
    expect(preview.commission).toBe(0);
    expect(preview.commissionCurrency).toBe("USD");
    expect(preview).toMatchObject({ currency: "USD", estimatedCost: 1502.5, fees: 0.05, buyingPowerImpact: 1502.55 });
    expect(preview.buyingPowerBefore).toBeUndefined();
    expect(preview.buyingPowerAfter).toBeUndefined();
    expect(preview.warnings).toEqual(["Simulation account. No real money is used."]);
    expect(preview.initMarginAfter).toBeUndefined();
    expect(preview.warningText).toContain("Simulation account");
    expect(preview.warningText).toContain("Estimated cost: USD 1502.50");
    expect(preview.warningText).toContain("Buying power impact: USD 1502.55");
  });

  test("equity preview omits inapplicable zero option estimates and preserves nonzero values", async () => {
    let optionFees = "0";
    const { service } = mock({}, () => ({ estimatedCost: "1502.50", estimatedMargin: "84.06", optionFees, optionRequirement: "0" }));
    const equity = await service.previewOrder(request());
    expect(equity.warnings).toEqual(["Simulation account. No real money is used.", "Estimated margin: USD 84.06."]);
    expect(equity.warningText).not.toContain("Option");
    const option = await service.previewOrder(optionRequest());
    expect(option.warnings).toContain("Option fees: USD 0.00.");
    expect(option.warnings).toContain("Option requirement: USD 0.00.");
    optionFees = "0.65";
    expect((await service.previewOrder(request())).warnings).toContain("Option fees: USD 0.65.");
  });

  test.each(["DAY", "GTC", "IOC", "FOK", "EXTENDED_HOURS", "AT_THE_OPENING", "AT_THE_CLOSE"])("preserves supported equity TIF %s", async (tif) => {
    const { service, records } = mock();
    await service.previewOrder(request({ tif }));
    expect(records[0]?.body?.timeInForce).toBe(tif);
  });

  test("maps extended hours explicitly and rejects conflicting TIF", async () => {
    const { service, records } = mock();
    await service.previewOrder(request({ outsideRth: true }));
    expect(records[0]?.body?.timeInForce).toBe("EXTENDED_HOURS");
    await expect(service.previewOrder(request({ tif: "GTC", outsideRth: true }))).rejects.toThrow("Extended hours require");
    await expect(service.previewOrder(request({ tif: "GTD" }))).rejects.toThrow("time in force");
  });

  test("rejects unsupported or contradictory order fields without making requests", async () => {
    const { service, records } = mock();
    const invalid: Partial<BrokerOrderRequest>[] = [
      { quantity: 0 }, { quantity: NaN }, { quantity: Infinity }, { limitPrice: 0 }, { limitPrice: 1.123456 },
      { orderType: "MKT" }, { stopPrice: 149 }, { orderType: "STP LMT", stopPrice: undefined },
      { contract: { brokerId: "aries", symbol: "BTC", secType: "CRYPTO" } },
      { contract: { brokerId: "aries", symbol: "SPY", secType: "BAG" } },
      { contract: { brokerId: "aries", symbol: "AAPL", currency: "EUR" } },
      { contract: { brokerId: "other", symbol: "AAPL" } },
    ];
    for (const change of invalid) await expect(service.previewOrder(request(change))).rejects.toThrow();
    expect(records).toHaveLength(0);
  });

  test("serializes small prices as decimal strings without floating rounding", async () => {
    const { service, records } = mock();
    await service.previewOrder(request({ limitPrice: 0.00001 }));
    expect(records[0]?.body?.price).toBe("0.00001");
    await expect(service.previewOrder(request({ limitPrice: 0.000001 }))).rejects.toThrow("five decimal places");
  });

  test.each([
    [0, "BUY", "OPEN"], [2, "SELL", "CLOSE"], [-2, "BUY", "CLOSE"], [-2, "SELL", "OPEN"],
  ] as const)("derives option position effect from signed quantity %s and %s", async (quantity, action, positionEffect) => {
    let fetched = 0;
    const { service, records } = mock({ optionPositions: async (accountId) => {
      expect(accountId).toBe(accounts[0]!.accountId); fetched++;
      return [{ symbol: "AAPL  270115C00150000", quantity }];
    } });
    await service.previewOrder(optionRequest({ action }));
    expect(fetched).toBe(1);
    expect(records[0]?.body?.legs).toEqual([{
      symbol: "AAPL", maturity: "2027-01-15", putCall: "CALL", strikePrice: "150", securityType: "OPT", side: action, ratioQty: "1", positionEffect,
    }]);
  });

  test("option matching uses the complete contract and refuses a reversal", async () => {
    const { service, records } = mock({ optionPositions: async () => [
      { symbol: "AAPL270115C00150000", quantity: 1 }, { symbol: "AAPL270115P00150000", quantity: 100 },
    ] });
    await expect(service.previewOrder(optionRequest({ action: "SELL", quantity: 2 }))).rejects.toThrow("cross through zero");
    await expect(service.previewOrder(optionRequest({ tif: "IOC" }))).rejects.toThrow("DAY and GTC");
    await expect(service.previewOrder(optionRequest({ outsideRth: true }))).rejects.toThrow("Extended hours");
    await expect(service.previewOrder(optionRequest({ quantity: 0.5 }))).rejects.toThrow("whole number");
    expect(records).toHaveLength(0);
  });

  test("prefixed option holdings are matched before deriving opening or closing intent", async () => {
    const { service, records } = mock({ optionPositions: async () => [{ symbol: "O:AAPL  270115C00150000", quantity: 2 }] });
    await service.previewOrder(optionRequest({ action: "SELL", contract: {
      brokerId: "aries", symbol: "AAPL", localSymbol: "O:AAPL270115C00150000", secType: "OPT", multiplier: "100",
    } }));
    expect((records[0]?.body?.legs as Record<string, unknown>[])[0]?.positionEffect).toBe("CLOSE");
    await expect(service.previewOrder(optionRequest({ action: "SELL", quantity: 3 }))).rejects.toThrow("cross through zero");
    expect(records).toHaveLength(1);
  });

  test("constructs a single put leg from host contract fields and rejects contradictory metadata", async () => {
    const { service, records } = mock();
    const contract = { brokerId: "aries", symbol: "SPY", secType: "OPT", lastTradeDateOrContractMonth: "20270115", right: "P" as const, strike: 450, multiplier: "100" };
    await service.previewOrder(optionRequest({ contract }));
    expect(records[0]?.body?.legs).toEqual([{
      symbol: "SPY", maturity: "2027-01-15", putCall: "PUT", strikePrice: "450", securityType: "OPT", side: "BUY", ratioQty: "1", positionEffect: "OPEN",
    }]);
    await expect(service.previewOrder(optionRequest({ contract: { ...contract, localSymbol: "SPY270115C00450000" } }))).rejects.toThrow("do not match");
    await expect(service.previewOrder(optionRequest({ contract: { ...contract, multiplier: "10" } }))).rejects.toThrow("100-share");
    await expect(service.previewOrder(optionRequest({ contract: { ...contract, lastTradeDateOrContractMonth: "20270230" } }))).rejects.toThrow("valid expiration");
  });

  test("placement previews first and an acknowledgement does not imply a fill", async () => {
    const { service, records } = mock();
    const order = await service.placeOrder(request());
    expect(records.map((record) => record.path)).toEqual(["/v1/orders/preview", "/v1/orders"]);
    expect(order.filled).toBe(0);
    expect(order.remaining).toBe(10);
    expect(order.status).toBe("NEW");
    expect(order.orderId).toBeGreaterThan(0);
    expect(order.brokerOrderId).toBe("synthetic-client-001");
    expect(Number.isSafeInteger(order.orderId)).toBe(true);
  });

  test("turning trading off while preview is pending prevents placement", async () => {
    let enabled = true;
    const { service, records } = mock({ tradingEnabled: () => enabled }, () => {
      enabled = false;
      return { estimatedCost: "1500" };
    });
    await expect(service.placeOrder(request())).rejects.toThrow("Trading is disabled");
    expect(records.map((record) => record.path)).toEqual(["/v1/orders/preview"]);
  });

  test("malformed previews cannot silently authorize placement", async () => {
    const { service, records } = mock({}, () => ({ success: true }));
    await expect(service.placeOrder(request())).rejects.toThrow("valid order estimates");
    expect(records).toHaveLength(1);
  });

  test("blocking preview errors prevent placement and upstream secrets never reach text", async () => {
    const sentinel = "synthetic-secret-must-not-leak";
    const { service, records } = mock({}, () => ({ errors: [`Invalid ${sentinel}`], warnings: [sentinel], text: sentinel }));
    let message = "";
    try { await service.placeOrder(request()); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("rejected this order preview");
    expect(message).not.toContain(sentinel);
    expect(records.map((record) => record.path)).toEqual(["/v1/orders/preview"]);
  });

  test("warning strings and malformed numeric strings are not displayed", async () => {
    const { service } = mock({}, () => ({ commission: "0x100", fees: "Infinity", warnings: ["synthetic-secret"], estimatedCost: "1.25", warnRuleId: "synthetic-secret" }));
    const preview = await service.previewOrder(request());
    expect(preview.commission).toBeUndefined();
    expect(preview.fees).toBeUndefined();
    expect(preview.estimatedCost).toBe(1.25);
    expect(preview.warnings).toContain("Aries returned a risk warning. Review this order in Aries before submitting.");
    expect(JSON.stringify(preview)).not.toContain("synthetic-secret");
    expect(preview.warningText).not.toContain("synthetic-secret");
    expect(preview.warningText).not.toContain("Infinity");
    expect(preview.warningText).toContain("risk warning");
  });
});

describe("Aries order records and ID lifecycle", () => {
  test("native identity survives a new session without reusing its mutation handle", async () => {
    const respond = () => ({ orders: [active()], nextCursor: 0 });
    const before = mock({ accounts: async () => [accounts[0]!] }, respond);
    const after = mock({ accounts: async () => [accounts[0]!] }, respond);
    const oldOrder = (await before.service.listOpenOrders())[0]!;
    const currentOrder = (await after.service.listOpenOrders())[0]!;
    expect(currentOrder.brokerOrderId).toBe(oldOrder.brokerOrderId);
    expect(currentOrder.accountId).toBe(oldOrder.accountId);
    expect(currentOrder.orderId).not.toBe(oldOrder.orderId);
    await expect(after.service.cancelOrder(oldOrder.orderId)).rejects.toThrow("current Aries session");
    expect(after.records).toHaveLength(1);
  });

  test("paginates, parses numeric strings and excludes today's terminal activity", async () => {
    const { service, records } = mock({ accounts: async () => [accounts[0]!] }, (record) => {
      if (record.query.get("cursor") === "0") return { orders: [active(), active({ clOrdId: "done", ordStatus: "FILLED" })], nextCursor: "9007199254740993" };
      expect(record.query.get("cursor")).toBe("9007199254740993");
      return { orders: null, nextCursor: 0 };
    });
    const orders = await service.listOpenOrders();
    expect(records).toHaveLength(2);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ quantity: 10, filled: 2, remaining: 8, avgFillPrice: 150.2, limitPrice: 150.25, orderType: "LMT", status: "NEW" });
    expect(orders[0]?.stopPrice).toBeUndefined();
  });

  test("rejects lossy or repeated pagination cursors", async () => {
    const unsafe = mock({ accounts: async () => [accounts[0]!] }, () => ({ orders: [], nextCursor: 9007199254740992 }));
    await expect(unsafe.service.listOpenOrders()).rejects.toThrow("invalid orders cursor");
    const repeated = mock({ accounts: async () => [accounts[0]!] }, () => ({ orders: [], nextCursor: 5 }));
    await expect(repeated.service.listOpenOrders()).rejects.toThrow("invalid orders cursor");
    expect(repeated.records).toHaveLength(2);
  });

  test("same string ID in two accounts receives separate host IDs and cancel stays in its account", async () => {
    const { service, records } = mock({}, (record) => record.method === "GET"
      ? { orders: [active({ accountId: record.path.includes("LIVE") ? accounts[1]!.accountId : accounts[0]!.accountId })], nextCursor: 0 }
      : { success: true, status: "CANCELED" });
    const orders = await service.listOpenOrders();
    expect(orders[0]?.orderId).not.toBe(orders[1]?.orderId);
    expect(orders.map((order) => order.brokerOrderId)).toEqual(["synthetic-client-001", "synthetic-client-001"]);
    expect(orders[0]?.warningText).toContain("Simulation");
    expect(orders[1]?.warningText).toContain("LIVE");
    await expect(service.modifyOrder(orders[0]!.orderId, request({ accountId: accounts[1]!.accountId }))).rejects.toThrow("original selected account");
    await service.cancelOrder(orders[1]!.orderId);
    expect(records.at(-1)?.body).toEqual({ tradingAccountId: "SYNTH-LIVE-002", origClOrdId: "synthetic-client-001", symbol: "AAPL", side: "BUY", securityType: "CS" });
  });

  test("replacement cycles client IDs, preserves numeric ID and history cannot restore the old cancel target", async () => {
    let replacements = 0;
    const { service, records } = mock({ accounts: async () => [accounts[0]!] }, (record) => {
      if (record.method === "GET") return { orders: [active(record.path.endsWith("history") ? { ordStatus: "REPLACED" } : {})], nextCursor: 0 };
      if (record.path.endsWith("replace")) return { success: true, status: "REPLACED", clOrdId: `synthetic-replace-${++replacements}`, price: record.body?.price, qty: record.body?.qty };
      return { success: true, status: "CANCELED" };
    });
    const id = (await service.listOpenOrders())[0]!.orderId;
    const first = await service.modifyOrder(id, request({ limitPrice: 151 }));
    const second = await service.modifyOrder(id, request({ limitPrice: 152 }));
    expect(first.orderId).toBe(id);
    expect(second.orderId).toBe(id);
    expect(first.brokerOrderId).toBe("synthetic-replace-1");
    expect(second.brokerOrderId).toBe("synthetic-replace-2");
    expect(records.filter((record) => record.path.endsWith("replace")).map((record) => record.body?.origClOrdId)).toEqual(["synthetic-client-001", "synthetic-replace-1"]);
    const history = await service.listExecutions();
    expect(history[0]?.brokerOrderId).toBe("synthetic-client-001");
    await service.cancelOrder(id);
    expect(records.at(-1)?.body?.origClOrdId).toBe("synthetic-replace-2");
  });

  // Regression (live simulation, 2026-10-19): a repriced option order stayed open in Aries under REPLACED and
  // vanished from the app, so it could not be cancelled there.
  test("an open order Aries lists as REPLACED still works, can be cancelled, and then reads as cancelled", async () => {
    const replaced = active({ ordStatus: "REPLACED", cumQty: "0", leavesQty: "1", qty: "1", price: "0.55" });
    let cancelled = false;
    const { service, records } = mock({ accounts: async () => [accounts[0]!] }, (record) => {
      if (record.method === "POST") { cancelled = true; return { success: true, status: "PENDING_CANCEL" }; }
      if (!record.path.endsWith("history")) return { orders: cancelled ? [] : [replaced], nextCursor: 0 };
      // History, newest first: the cancel is a new row naming the replacement as its origin.
      return { orders: [active({ ...replaced, clOrdId: "synthetic-cancel", origClOrdId: "synthetic-client-001", ordStatus: "CANCELED", leavesQty: "0" }), replaced], nextCursor: 0 };
    });
    const orders = await service.listOpenOrders();
    expect(orders.map((order) => [order.status, order.limitPrice, order.remaining])).toEqual([["NEW", 0.55, 1]]);
    await service.cancelOrder(orders[0]!.orderId);
    expect(records.at(-1)?.path).toBe("/v1/orders/cancel");
    expect(await service.getOrderStatus(orders[0]!.orderId)).toMatchObject({ orderId: orders[0]!.orderId, status: "CANCELED", remaining: 0 });
  });

  test("rejects unknown IDs, excluded accounts and attempts to change instruments", async () => {
    let included = true;
    const { service, records } = mock({ accounts: async () => included ? [accounts[0]!] : [] }, () => ({ orders: [active()], nextCursor: 0 }));
    await expect(service.cancelOrder(123)).rejects.toThrow("current Aries session");
    const id = (await service.listOpenOrders())[0]!.orderId;
    await expect(service.modifyOrder(id, request({ contract: { brokerId: "aries", symbol: "MSFT", secType: "STK" } }))).rejects.toThrow("instrument or order side");
    included = false;
    await expect(service.cancelOrder(id)).rejects.toThrow("not included");
    expect(records.filter((record) => record.method === "POST")).toHaveLength(0);
  });

  test("option cancellation carries the complete instrument and original side", async () => {
    const { service, records } = mock({ accounts: async () => [accounts[0]!] }, (record) => record.method === "GET"
      ? { orders: [active({ symbol: "AAPL270115P00150000", securityType: "OPTION", side: "SELL", category: "SINGLE_LEG" })], nextCursor: 0 }
      : { success: true, status: "CANCELED" });
    const id = (await service.listOpenOrders())[0]!.orderId;
    await service.cancelOrder(id);
    expect(records.at(-1)?.body).toEqual({ tradingAccountId: "SYNTH-SIM-001", origClOrdId: "synthetic-client-001", symbol: "AAPL", securityType: "OPT", side: "SELL", maturity: "2027-01-15", putCall: "PUT", strikePrice: "150" });
  });

  test("option replacement preserves the original close effect even after partial fills", async () => {
    const leg = { symbol: "AAPL", securityType: "OPTION", side: "SELL", ratioQty: "1", maturity: "2027-01-15", strikePrice: "150", putCall: "CALL", positionEffect: "CLOSE", avgPrice: "2.55" };
    const { service, records } = mock({ accounts: async () => [accounts[0]!], optionPositions: async () => { throw new Error("Replacement must retain the original position effect."); } }, (record) => record.method === "GET"
      ? { orders: [active({ securityType: "OPTION", side: "SELL", qty: "2", cumQty: "1", leavesQty: "1", legs: [leg] })], nextCursor: 0 }
      : { success: true, status: "REPLACED", clOrdId: "synthetic-replaced-option" });
    const order = (await service.listOpenOrders())[0]!;
    await service.modifyOrder(order.orderId, optionRequest({ action: "SELL", quantity: 2 }));
    expect((records.at(-1)?.body?.legs as Record<string, unknown>[])[0]?.positionEffect).toBe("CLOSE");
  });

  test("an order Aries is still replacing, or has not acknowledged, can be cancelled, not replaced", async () => {
    const { service, records } = mock({ accounts: async () => [accounts[0]!] }, (record) => record.method === "GET"
      ? { orders: [active({ ordStatus: "PENDING_REPLACE" })], nextCursor: 0 }
      : { success: true, status: "PENDING_CANCEL" });
    const id = (await service.listOpenOrders())[0]!.orderId;
    await expect(service.modifyOrder(id, request())).rejects.toThrow("has not taken the last change");
    await service.cancelOrder(id);
    const unacknowledged = mock({ accounts: async () => [accounts[0]!] }, () => ({ orders: [active({ ordStatus: "PENDING_NEW" })], nextCursor: 0 }));
    await expect(unacknowledged.service.modifyOrder((await unacknowledged.service.listOpenOrders())[0]!.orderId, request())).rejects.toThrow("not acknowledged");
    expect(records.filter((record) => record.method === "POST").map((record) => record.path)).toEqual(["/v1/orders/cancel"]);
  });

  test("concurrent cancellation submits once and pending acknowledgement needs a refresh", async () => {
    const { service, records } = mock({ accounts: async () => [accounts[0]!] }, (record) => record.method === "GET"
      ? { orders: [active()], nextCursor: 0 }
      : { success: true, status: "PENDING_CANCEL" });
    const id = (await service.listOpenOrders())[0]!.orderId;
    const results = await Promise.allSettled([service.cancelOrder(id), service.cancelOrder(id)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(records.filter((record) => record.method === "POST")).toHaveLength(1);
    await expect(service.cancelOrder(id)).rejects.toThrow("already being cancelled");
  });

  test("transport ambiguity blocks a retry until a fresh order snapshot", async () => {
    let writes = 0;
    const client: AriesOrderClient = {
      get: async <T>() => ({ orders: [active()], nextCursor: 0 }) as T,
      post: async <T>() => { writes++; throw new Error("Request failed. Refresh orders before retrying."); },
    };
    const service = new AriesOrderService(client, { accounts: async () => [accounts[0]!], tradingEnabled: () => true });
    const id = (await service.listOpenOrders())[0]!.orderId;
    await expect(service.cancelOrder(id)).rejects.toThrow("Request failed");
    await expect(service.cancelOrder(id)).rejects.toThrow("status needs confirmation");
    expect(writes).toBe(1);
    await service.listOpenOrders();
    await expect(service.cancelOrder(id)).rejects.toThrow("Request failed");
    expect(writes).toBe(2);
  });

  test.each(["open orders", "history"])("a concurrent %s refresh cannot detach a pending cancel acknowledgement", async (kind) => {
    const started = gate<void>();
    const response = gate<Record<string, unknown>>();
    let posts = 0;
    const client: AriesOrderClient = {
      get: async <T>() => ({ orders: [active()], nextCursor: 0 }) as T,
      post: async <T>() => { posts++; started.resolve(); return await response.promise as T; },
    };
    const service = new AriesOrderService(client, { accounts: async () => [accounts[0]!], tradingEnabled: () => true });
    const id = (await service.listOpenOrders())[0]!.orderId;
    const cancellation = service.cancelOrder(id);
    await started.promise;
    if (kind === "history") await service.listExecutions();
    else await service.listOpenOrders();
    response.resolve({ success: true, status: "CANCELED" });
    await cancellation;
    await expect(service.cancelOrder(id)).rejects.toThrow("no longer open");
    expect(posts).toBe(1);
  });

  test("an order refresh during account validation cannot detach the pending mutation", async () => {
    const accountStarted = gate<void>();
    const accountRelease = gate<void>();
    let accountReads = 0;
    let posts = 0;
    const client: AriesOrderClient = {
      get: async <T>() => ({ orders: [active()], nextCursor: 0 }) as T,
      post: async <T>() => { posts++; return { success: true, status: "CANCELED" } as T; },
    };
    const service = new AriesOrderService(client, {
      tradingEnabled: () => true,
      accounts: async () => {
        if (++accountReads === 2) { accountStarted.resolve(); await accountRelease.promise; }
        return [accounts[0]!];
      },
    });
    const id = (await service.listOpenOrders())[0]!.orderId;
    const cancellation = service.cancelOrder(id);
    await accountStarted.promise;
    await service.listOpenOrders();
    accountRelease.resolve();
    await cancellation;
    await expect(service.cancelOrder(id)).rejects.toThrow("no longer open");
    expect(posts).toBe(1);
  });

  test("a stale snapshot arriving after a failed mutation cannot clear its unknown outcome", async () => {
    const postStarted = gate<void>();
    const postRelease = gate<void>();
    const readStarted = gate<void>();
    const readRelease = gate<void>();
    let reads = 0;
    let posts = 0;
    const client: AriesOrderClient = {
      get: async <T>() => {
        if (++reads > 1) { readStarted.resolve(); await readRelease.promise; }
        return { orders: [active()], nextCursor: 0 } as T;
      },
      post: async <T>() => { posts++; postStarted.resolve(); await postRelease.promise; throw new Error("Synthetic transport failure"); },
    };
    const service = new AriesOrderService(client, { accounts: async () => [accounts[0]!], tradingEnabled: () => true });
    const id = (await service.listOpenOrders())[0]!.orderId;
    const cancellation = service.cancelOrder(id).then(() => undefined, (error: unknown) => error);
    await postStarted.promise;
    const staleRefresh = service.listOpenOrders();
    await readStarted.promise;
    postRelease.resolve();
    expect(await cancellation).toBeInstanceOf(Error);
    readRelease.resolve();
    await staleRefresh;
    await expect(service.cancelOrder(id)).rejects.toThrow("status needs confirmation");
    expect(posts).toBe(1);
  });

  test("a concurrent history refresh cannot detach an ambiguous replacement outcome", async () => {
    const started = gate<void>();
    const release = gate<void>();
    let posts = 0;
    const client: AriesOrderClient = {
      get: async <T>() => ({ orders: [active()], nextCursor: 0 }) as T,
      post: async <T>() => { posts++; started.resolve(); await release.promise; throw new Error("Synthetic transport failure"); },
    };
    const service = new AriesOrderService(client, { accounts: async () => [accounts[0]!], tradingEnabled: () => true, brokerInstanceId: "profile-test" });
    const id = (await service.listOpenOrders())[0]!.orderId;
    const replacement = service.modifyOrder(id, request()).then(() => undefined, (error: unknown) => error);
    await started.promise;
    await service.listExecutions();
    release.resolve();
    expect(await replacement).toBeInstanceOf(Error);
    await expect(service.modifyOrder(id, request())).rejects.toThrow("status needs confirmation");
    expect(posts).toBe(1);
  });

  test("accepted replacements retain the new client ID without any follow-up read", async () => {
    let accountReadsBlocked = false;
    const posts: { path: string; body: unknown }[] = [];
    const client: AriesOrderClient = {
      get: async <T>() => ({ orders: [active()], nextCursor: 0 }) as T,
      post: async <T>(path: string, body: unknown) => {
        posts.push({ path, body });
        if (path.endsWith("/replace")) {
          accountReadsBlocked = true;
          return { success: true, status: "REPLACED", clOrdId: "synthetic-new-client-id" } as T;
        }
        return { success: true, status: "CANCELED" } as T;
      },
    };
    const service = new AriesOrderService(client, {
      accounts: async () => { if (accountReadsBlocked) throw new Error("Synthetic read failure"); return [accounts[0]!]; },
      tradingEnabled: () => true, brokerInstanceId: "profile-test",
    });
    const id = (await service.listOpenOrders())[0]!.orderId;
    const replacement = await service.modifyOrder(id, request());
    expect(replacement.orderId).toBe(id);
    accountReadsBlocked = false;
    await service.cancelOrder(id);
    expect((posts.at(-1)?.body as Record<string, unknown>).origClOrdId).toBe("synthetic-new-client-id");
  });

  test("an accepted replacement with no new ID requires reconciliation before retry", async () => {
    const { service, records } = mock({ accounts: async () => [accounts[0]!] }, (record) => record.method === "GET"
      ? { orders: [active()], nextCursor: 0 }
      : { success: true, status: "REPLACED" });
    const id = (await service.listOpenOrders())[0]!.orderId;
    await expect(service.modifyOrder(id, request())).rejects.toThrow("order identifier");
    await expect(service.modifyOrder(id, request())).rejects.toThrow("status needs confirmation");
    expect(records.filter((record) => record.method === "POST")).toHaveLength(1);
  });

  test("multi-leg orders stay visible and cannot be modified through a single-contract ticket", async () => {
    const { service, records } = mock({ accounts: async () => [accounts[0]!] }, () => ({ orders: [active({ category: "MULTI_LEG", securityType: "OPTION" })], nextCursor: 0 }));
    const order = (await service.listOpenOrders())[0]!;
    expect(order.contract.secType).toBe("BAG");
    expect(order.warningText).toContain("Manage it in Aries");
    await expect(service.cancelOrder(order.orderId)).rejects.toThrow("Manage it in Aries");
    expect(records).toHaveLength(1);
  });

  test("history exposes cumulative fills with per-leg average prices and a bounded window", async () => {
    const leg = { symbol: "AAPL", securityType: "OPTION", side: "SELL", ratioQty: "1", maturity: "2027-01-15", strikePrice: "150", putCall: "CALL", positionEffect: "CLOSE", avgPrice: "2.55" };
    const { service, records } = mock({ accounts: async () => [accounts[0]!] }, () => ({
      orders: [active({ clOrdId: "filled-option", securityType: "OPTION", cumQty: "2", qty: "2", leavesQty: "0", avgPrice: "0", ordStatus: "FILLED", legs: [leg] }), active({ clOrdId: "unfilled", cumQty: "0" })], nextCursor: 0,
    }));
    const fills = await service.listExecutions();
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ shares: 2, price: 2.55, side: "SELL", contract: { secType: "OPT", multiplier: "100", localSymbol: "AAPL270115C00150000" } });
    expect(fills[0]?.execId).toContain(":cumulative:leg0");
    expect(records[0]?.path).toBe("/v2/accounts/SYNTH-SIM-001/orders/history");
    const from = Date.parse(records[0]!.query.get("from")!);
    const to = Date.parse(records[0]!.query.get("to")!);
    expect(to - from).toBe(90 * 86400000);
  });

  test("a rejected action is sanitized and leaves the original target intact", async () => {
    const { service, records } = mock({ accounts: async () => [accounts[0]!] }, (record) => record.method === "GET"
      ? { orders: [active()], nextCursor: 0 }
      : { success: false, status: "REJECTED", text: "synthetic-secret", ordRejReason: "synthetic-secret" });
    const id = (await service.listOpenOrders())[0]!.orderId;
    let message = "";
    try { await service.cancelOrder(id); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("did not accept");
    expect(message).not.toContain("synthetic-secret");
    await expect(service.cancelOrder(id)).rejects.toThrow("did not accept");
    expect(records.at(-1)?.body?.origClOrdId).toBe("synthetic-client-001");
    const lost = mock({ accounts: async () => [accounts[0]!] }, (record) => record.method === "GET"
      ? { orders: [active()], nextCursor: 0 } : { success: false, status: "REJECTED", text: "TE: Order cannot be found" });
    await expect(lost.service.cancelOrder((await lost.service.listOpenOrders())[0]!.orderId)).rejects.toThrow("Aries cannot find this order.");
  });
});

describe("Aries account socket rows", () => {
  test("a pushed cancel keeps the order's host ID, and a later row for the replaced ID changes nothing", async () => {
    const { service } = mock({ accounts: async () => [accounts[0]!] }, () => ({ orders: [active()], nextCursor: 0 }));
    const [listed] = await service.listOpenOrders();
    const fill = service.applyPushedOrder(active({ cumQty: "4", leavesQty: "6", ordStatus: "PARTIALLY_FILLED" }), accounts[0]!);
    expect(fill).toMatchObject({ orderId: listed!.orderId, filled: 4, status: "PARTIALLY_FILLED" });
    const cancel = service.applyPushedOrder(active({ clOrdId: "synthetic-cancel", origClOrdId: "synthetic-client-001", ordStatus: "CANCELED", cumQty: "4", leavesQty: "0" }), accounts[0]!);
    expect(cancel).toMatchObject({ orderId: listed!.orderId, status: "CANCELED", brokerOrderId: "synthetic-client-001" });
    expect(service.applyPushedOrder(active({ ordStatus: "NEW", cumQty: "4", leavesQty: "6" }), accounts[0]!)).toBeUndefined();
    expect(service.applyPushedOrder(active({ accountId: "SYNTH-OTHER" }), accounts[0]!)).toBeUndefined();
  });
});
