import { describe, expect, test } from "bun:test";
import type { Quote } from "gloomberb/types/financials";
import { AriesMarketData, ariesChartResolution, ariesTradeSession, mapAriesHistory, mapAriesLastTrade, mapAriesOption, mapAriesQuote, type AriesMarketClient } from "./market-data";
import { AriesError } from "./client";
import { ariesInstrumentSymbol, finiteNumber, optionBrokerContract, parseOptionSymbol } from "./instruments";

const NOW = Date.UTC(2026, 9, 9, 15, 0);
const EXPIRATION = Date.UTC(2026, 9, 16) / 1000;
const OPTION = "AAPL261016C00200000";
type Request = { path: string; query?: Record<string, string | number | undefined> };

function fakeClient(handler: (request: Request) => unknown | Promise<unknown>): { client: AriesMarketClient; requests: Request[] } {
  const requests: Request[] = [];
  return {
    requests,
    client: {
      async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
        const request = { path, query: query ? { ...query } : undefined };
        requests.push(request);
        return await handler(request) as T;
      },
    },
  };
}

function quote(symbol: string) {
  return { s: symbol, n: "Synthetic Company", v: { lp: "205.5", ch: "2.5", chp: "1.2315", prev_close_price: "203", ask: "205.6", bid: "205.4", exchange: "NASDAQ", volume: "12500", open_price: "204", high_price: "206", low_price: "202" } };
}

/** A Monday at 11:00 New York time. */
const REGULAR_HOURS = Date.parse("2026-10-19T15:00:00Z");
function lastTrade(symbol: string, timestamp = NOW - 1000) {
  return { status: "DELAYED", results: { ticker: symbol, price: 205.5, sipTimestamp: timestamp * 1_000_000 } };
}

function option(overrides: Record<string, unknown> = {}) {
  return {
    details: { ticker: `O:${OPTION}`, contractType: "call", expirationDate: "2026-10-16", strikePrice: "200", sharesPerContract: 100 },
    day: { change: "0.2", changePercent: "3", volume: 0 },
    lastQuote: { bid: "6.5", ask: "6.7", lastUpdated: NOW * 1_000_000, timeframe: "REAL-TIME" },
    lastTrade: { price: "6.6", sipTimestamp: (NOW - 60_000) * 1_000_000, timeframe: "REAL-TIME" },
    underlyingAsset: { price: "205.5", timeframe: "DELAYED" },
    openInterest: "123", impliedVolatility: "0.3", ...overrides,
  };
}

describe("instrument numbers and identities", () => {
  test("accepts finite strings and numbers while preserving zero", () => {
    expect(["12.3", "-2", 0, "0"].map(finiteNumber)).toEqual([12.3, -2, 0, 0]);
    for (const value of [null, undefined, "", " ", "Infinity", "NaN", NaN, Infinity, true, {}]) expect(finiteNumber(value)).toBeUndefined();
  });

  test("parses OSI roots, strike thousandths and valid calendar dates", () => {
    expect(parseOptionSymbol(`O:AAPL 261016C00200500`)).toEqual({ symbol: "AAPL261016C00200500", underlying: "AAPL", expiration: "2026-10-16", right: "C", strike: 200.5 });
    expect(parseOptionSymbol("AAPL260230C00200000")).toBeNull();
    expect(parseOptionSymbol("AAPL")).toBeNull();
    expect(optionBrokerContract(OPTION, "synthetic-profile")).toMatchObject({ brokerId: "aries", brokerInstanceId: "synthetic-profile", symbol: "AAPL", localSymbol: OPTION, secType: "OPT", multiplier: "100", lastTradeDateOrContractMonth: "20261016", right: "C", strike: 200 });
    expect(ariesInstrumentSymbol("AAPL", optionBrokerContract(`O:${OPTION}`))).toBe(OPTION);
  });
});

describe("quotes", () => {
  test("maps schema fields without inventing realtime entitlement or a trade timestamp", () => {
    expect(mapAriesQuote(quote("AAPL"), NOW)).toMatchObject({ symbol: "AAPL", price: 205.5, lastTradePrice: 205.5, bid: 205.4, ask: 205.6, volume: 12500, previousClose: 203, open: 204, high: 206, low: 202, dataSource: "delayed", delivery: "poll", lastUpdated: 0, receivedAt: NOW, sessionConfidence: "unknown", exchangeName: "NASDAQ" });
    expect(mapAriesQuote(quote("AAPL"), NOW)?.listingExchangeName).toBeUndefined();
    expect(mapAriesQuote(quote("AAPL"), NOW)?.lastTradeTime).toBeUndefined();
    expect(mapAriesQuote({ s: "AAPL", v: { lp: "bad" } }, NOW)).toBeNull();
    expect(mapAriesQuote({ s: "AAPL", v: { lp: 5, prev_close_price: 4 } }, NOW)).toMatchObject({ change: 1, changePercent: 25 });
  });

  test("batches deduplicated symbols and never returns unsolicited symbols", async () => {
    const { client, requests } = fakeClient(({ path, query }) => path.endsWith("last-trade") ? lastTrade(String(query?.ticker)) : { s: "ok", d: [...String(query?.symbols).split(",").map(quote), quote("UNREQUESTED")] });
    const market = new AriesMarketData(client, { now: () => NOW });
    const result = await market.getQuotes(["aapl", "AAPL", ...Array.from({ length: 51 }, (_, index) => `S${index}`)]);
    expect(requests.filter(({ path }) => path.endsWith("quotes"))).toHaveLength(2);
    expect(String(requests[0]!.query?.symbols).split(",")).toHaveLength(50);
    expect(result.size).toBe(52);
    expect(result.has("UNREQUESTED")).toBe(false);
    await market.getQuotes([]);
    expect(requests).toHaveLength(54);
  });

  test("uses option details for OSI contracts and keeps the target symbol", async () => {
    const { client, requests } = fakeClient(() => ({ data: [{ symbol: OPTION, lastPrice: "6.6", bidPrice: "6.5", askPrice: "6.7", midPrice: "6.6", closePrice: "6" }], errors: [] }));
    const market = new AriesMarketData(client, { now: () => NOW });
    expect(await market.getQuote("AAPL", optionBrokerContract(OPTION))).toMatchObject({ symbol: "AAPL", price: 6.6, mark: 6.6, instrumentType: "OPTION", dataSource: "delayed", changePercent: expect.closeTo(10) });
    expect(requests).toEqual([{ path: "/v1/marketdata/options/details", query: { symbols: OPTION } }]);
  });

  test("does not leak response error text", async () => {
    const { client } = fakeClient(() => ({ s: "error", errmsg: "synthetic-private-key" }));
    await expect(new AriesMarketData(client).getQuote("AAPL")).rejects.toThrow("Aries could not return quotes.");
  });

  test("uses the timestamped last-trade pair and never dates an unrelated chart price", async () => {
    const receivedAt = Date.parse("2026-10-09T21:10:00Z");
    const observedAt = Date.parse("2026-10-09T20:50:00Z");
    const { client } = fakeClient(({ path }) => path.endsWith("last-trade") ? lastTrade("AAPL", observedAt) : { s: "ok", d: [{ ...quote("AAPL"), v: { ...quote("AAPL").v, lp: 210 } }] });
    const result = await new AriesMarketData(client, { now: () => receivedAt }).getQuote("AAPL");
    expect(result).toMatchObject({ price: 205.5, lastTradePrice: 205.5, lastTradeTime: observedAt, lastUpdated: observedAt, receivedAt, marketState: "POST", postMarketPrice: 205.5, sessionConfidence: "derived", dataSource: "delayed", change: 2.5 });
    expect(result.regularClose).toBeUndefined();
    // The ticket's Bid, Mid and Ask picks need the snapshot's bid and ask.
    expect(result).toMatchObject({ bid: 205.4, ask: 205.6 });
    expect(mapAriesLastTrade(lastTrade("MSFT"), "AAPL", receivedAt)).toBeNull();
    expect(mapAriesLastTrade(lastTrade("AAPL", receivedAt + 1000), "AAPL", receivedAt)).toBeNull();
  });

  test("before the open a delayed quote moves from the last close and offers no closing bid, ask or range", async () => {
    const receivedAt = Date.parse("2026-10-20T12:30:00Z"), observedAt = Date.parse("2026-10-20T12:10:00Z");
    const snapshot = { ...quote("SPY"), v: { ...quote("SPY").v, lp: 766.48, prev_close_price: 763.25, bid: 766.54, ask: 766.55, high_price: 770.46, low_price: 765.82 } };
    const { client } = fakeClient(({ path }) => path.endsWith("last-trade") ? { ...lastTrade("SPY", observedAt), results: { ticker: "SPY", price: 764.5, sipTimestamp: observedAt * 1_000_000 } } : { s: "ok", d: [snapshot] });
    const result = await new AriesMarketData(client, { now: () => receivedAt }).getQuote("SPY");
    expect(result).toMatchObject({ price: 764.5, previousClose: 766.48, change: expect.closeTo(-1.98), marketState: "PRE", preMarketPrice: 764.5 });
    expect([result.bid, result.ask, result.high, result.low]).toEqual([undefined, undefined, undefined, undefined]);
  });

  test("uses New York source time across DST and leaves early-close hours ambiguous", () => {
    expect(ariesTradeSession(Date.parse("2026-07-01T20:30:00Z"))).toBe("POST");
    expect(ariesTradeSession(Date.parse("2026-01-02T21:30:00Z"))).toBe("POST");
    expect(ariesTradeSession(Date.parse("2026-07-01T12:00:00Z"))).toBe("PRE");
    expect(ariesTradeSession(Date.parse("2026-01-02T13:00:00Z"))).toBe("PRE");
    expect(ariesTradeSession(Date.parse("2026-07-01T15:00:00Z"))).toBe("REGULAR");
    expect(ariesTradeSession(Date.parse("2026-11-27T18:30:00Z"))).toBeUndefined();
    expect(ariesTradeSession(Date.parse("2026-10-10T21:00:00Z"))).toBeUndefined();
  });

  test("caches supplemental trades for 60 seconds and shares in-flight requests", async () => {
    let now = NOW, complete: (value: unknown) => void = () => {};
    let tradeCalls = 0;
    const { client } = fakeClient(({ path }) => {
      if (!path.endsWith("last-trade")) return { s: "ok", d: [quote("AAPL")] };
      tradeCalls++;
      return tradeCalls === 1 ? new Promise((resolve) => { complete = resolve; }) : lastTrade("AAPL");
    });
    const market = new AriesMarketData(client, { now: () => now });
    const first = market.getQuote("AAPL"), second = market.getQuote("AAPL");
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(tradeCalls).toBe(1);
    complete(lastTrade("AAPL"));
    await Promise.all([first, second]);
    now += 59_000;
    await market.getQuote("AAPL");
    expect(tradeCalls).toBe(1);
    now += 1001;
    await market.getQuote("AAPL");
    expect(tradeCalls).toBe(2);
  });

  test("a missing supplemental scope falls back to an undated snapshot without repeated attempts", async () => {
    const { client, requests } = fakeClient(({ path, query }) => {
      if (path.endsWith("last-trade")) throw new AriesError("Aries denied this request.", 403);
      return { s: "ok", d: String(query?.symbols).split(",").map(quote) };
    });
    const market = new AriesMarketData(client, { now: () => NOW });
    const result = await market.getQuotes(["AAPL", "MSFT"]);
    expect(result.get("AAPL")).toMatchObject({ price: 205.5, lastUpdated: 0, receivedAt: NOW, sessionConfidence: "unknown" });
    expect(result.get("AAPL")?.lastTradeTime).toBeUndefined();
    expect(market.getQuoteNotice()).toContain("market:supplemental");
    expect(requests.filter(({ path }) => path.endsWith("last-trade"))).toHaveLength(1);
    await market.getQuotes(["AAPL", "MSFT"]);
    expect(requests.filter(({ path }) => path.endsWith("last-trade"))).toHaveLength(1);
  });

  test("propagates rate limits instead of silently serving an undated quote", async () => {
    const { client } = fakeClient(({ path }) => {
      if (path.endsWith("last-trade")) throw new AriesError("Aries is rate limiting requests.", 429);
      return { s: "ok", d: [quote("AAPL")] };
    });
    await expect(new AriesMarketData(client).getQuote("AAPL")).rejects.toThrow("rate limiting");
  });
});

describe("history and search", () => {
  test("maps seconds to dates, sorts and deduplicates bars, rejects nonnumeric values", () => {
    const result = mapAriesHistory({ s: "ok", t: [300, 100, 100, "bad", 400], c: [3, 1, 2, 9, null], o: [2.5, 0.5, "1.5"], v: [0, "25", "30"] });
    expect(result.map((bar) => [bar.date.getTime(), bar.close, bar.volume])).toEqual([[100_000, 2, 30], [300_000, 3, 0]]);
    expect(result[0]?.open).toBe(1.5);
    expect(mapAriesHistory({ s: "no_data" })).toEqual([]);
    expect(() => mapAriesHistory({ s: "error", errmsg: "synthetic-private-key" })).toThrow("Aries could not return chart data.");
  });

  test("maps host bar sizes and refuses stale tick resolution claims", () => {
    expect(["1m", "1h", "1d", "1wk", "1mo", "3 hours", "5 mins", "1 day"].map(ariesChartResolution)).toEqual(["1", "60", "D", "W", "M", "180", "5", "1D"]);
    expect(() => ariesChartResolution("1T")).toThrow("does not support");
    expect(() => ariesChartResolution("2 seconds")).toThrow("does not support");
  });

  test("asks for pre- and post-market bars on request and outside the regular session", async () => {
    const { client, requests } = fakeClient(() => ({ s: "ok", t: [100], c: [1] }));
    const extended = () => requests.at(-1)?.query?.includeExtended;
    await new AriesMarketData(client, { now: () => REGULAR_HOURS }).getDetailedPriceHistory("AAPL", new Date(100_000), new Date(500_000), "15m");
    expect(extended()).toBe("false");
    await new AriesMarketData(client, { now: () => REGULAR_HOURS }).getDetailedPriceHistory("AAPL", new Date(100_000), new Date(500_000), "15m", undefined, "extended");
    expect(extended()).toBe("true");
    await new AriesMarketData(client, { now: () => Date.parse("2026-10-19T23:00:00Z") }).getDetailedPriceHistory("AAPL", new Date(100_000), new Date(500_000), "15m");
    expect(extended()).toBe("true");
    // Daily bars have no session to extend.
    await new AriesMarketData(client, { now: () => Date.parse("2026-10-19T23:00:00Z") }).getDetailedPriceHistory("AAPL", new Date(100_000), new Date(500_000), "1d");
    expect(extended()).toBe("false");
  });

  test("a ticket quote falls back to the timestamped trade when the snapshot omits the row", async () => {
    const observedAt = Date.parse("2026-10-19T18:55:00Z");
    const { client } = fakeClient(({ path }) => path.endsWith("last-trade") ? lastTrade("AAPL", observedAt) : { s: "ok", d: [] });
    const result = await new AriesMarketData(client, { now: () => observedAt + 60_000 }).getQuote("AAPL");
    expect(result).toMatchObject({ symbol: "AAPL", price: 205.5, lastTradeTime: observedAt, dataSource: "delayed" });
  });

  test("a symbol Aries has nothing for is a miss the host shows and does not log, naming the symbol", async () => {
    const { client, requests } = fakeClient(({ path }) => path.endsWith("last-trade") ? { status: "NOT_FOUND" } : { s: "ok", d: [] });
    let now = NOW;
    const market = new AriesMarketData(client, { now: () => now });
    const error = await market.getQuote("ZZZQ").catch((value: unknown) => value as Error & { reason?: string });
    expect(error).toMatchObject({ name: "ProviderMissError", message: "No quote for ZZZQ.", reason: "No quote for ZZZQ." });
    // A pane refreshing it does not ask Aries again for five minutes.
    const asked = requests.length;
    now += 4 * 60_000;
    await expect(market.getQuote("ZZZQ")).rejects.toThrow("No quote for ZZZQ.");
    expect(requests).toHaveLength(asked);
    now += 2 * 60_000;
    await expect(market.getQuote("ZZZQ")).rejects.toThrow("No quote for ZZZQ.");
    expect(requests.length).toBeGreaterThan(asked);
  });

  test("one instrument's quote does not wait behind a list's queued trades", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const { client } = fakeClient(async ({ path, query }) => {
      if (!path.endsWith("last-trade")) return { s: "ok", d: String(query?.symbols).split(",").map(quote) };
      if (query?.ticker !== "AAPL") await blocked;
      return lastTrade(String(query?.ticker));
    });
    const market = new AriesMarketData(client, { now: () => NOW });
    const list = market.getQuotes(["MSFT", "NVDA", "AMD"]);
    const ticket = await Promise.race([market.getQuote("AAPL"), Bun.sleep(200).then(() => "waited")]);
    expect(ticket).toMatchObject({ symbol: "AAPL", lastUpdated: NOW - 1000 });
    release();
    expect((await list).size).toBe(3);
  });

  test("requests the chosen resolution and paginates backward without duplicate bars", async () => {
    const { client, requests } = fakeClient(({ query }) => query?.to === 500 ? { s: "ok", t: [300, 400], c: [3, 4], nextTo: "opaque" } : { s: "ok", t: [100, 200], c: [1, 2] });
    const result = await new AriesMarketData(client, { now: () => REGULAR_HOURS }).getDetailedPriceHistory("AAPL", new Date(100_000), new Date(500_000), "5m");
    expect(result.map((bar) => bar.close)).toEqual([1, 2, 3, 4]);
    expect(requests.map(({ query }) => query)).toEqual([
      { symbol: "AAPL", resolution: "5", from: 100, to: 500, firstDataRequest: "1", includeExtended: "false" },
      { symbol: "AAPL", resolution: "5", from: 100, to: 299, firstDataRequest: "0", includeExtended: "false" },
    ]);
  });

  test("does not silently return truncated data when pagination stops advancing", async () => {
    const { client } = fakeClient(() => ({ s: "ok", t: [300], c: [3], nextTime: 200 }));
    await expect(new AriesMarketData(client).getDetailedPriceHistory("AAPL", new Date(100_000), new Date(500_000), "1d")).rejects.toThrow("pagination did not advance");
  });

  test("provides preset windows in seconds", async () => {
    const { client, requests } = fakeClient(() => ({ s: "no_data" }));
    await new AriesMarketData(client, { now: () => NOW }).getPriceHistory("AAPL", "1D");
    expect(requests[0]?.query).toMatchObject({ from: NOW / 1000 - 86400, to: NOW / 1000, resolution: "1" });
  });

  test("search retains exchange and resolvable standard option metadata", async () => {
    const { client, requests } = fakeClient(() => [{ symbol: "AAPL", description: "Synthetic Stock", exchange: "NASDAQ", type: "stock" }, { symbol: OPTION, description: "Synthetic Option", exchange: "OPRA", type: "option" }]);
    const market = new AriesMarketData(client);
    expect(await market.searchInstruments("  ")).toEqual([]);
    const result = await market.searchInstruments("AAPL", "test-instance");
    expect(requests).toHaveLength(1);
    expect(result[0]?.brokerContract).toMatchObject({ secType: "STK", primaryExchange: "NASDAQ" });
    expect(result[1]?.brokerContract).toMatchObject({ secType: "OPT", symbol: "AAPL", localSymbol: OPTION, multiplier: "100", brokerInstanceId: "test-instance" });
  });
});

describe("option chains", () => {
  test("maps snapshot nanoseconds, optional activity and OSI symbology", () => {
    expect(mapAriesOption(option())?.contract).toMatchObject({ contractSymbol: OPTION, strike: 200, lastPrice: 6.6, bid: 6.5, ask: 6.7, lastUpdated: NOW, lastTradeDate: (NOW - 60000) / 1000, volume: 0, openInterest: 123, impliedVolatility: 0.3, inTheMoney: true, expiration: EXPIRATION });
    expect(mapAriesOption(option({ day: {}, openInterest: null }))?.contract.volume).toBeUndefined();
    expect(mapAriesOption(option({ day: {}, openInterest: null }))?.contract.openInterest).toBeUndefined();
    expect(mapAriesOption(option({ lastTrade: {}, lastQuote: {} }))?.contract.lastTradeDate).toBe(0);
    expect(mapAriesOption(option({ details: { ...option().details, sharesPerContract: 50 } }))).toBeNull();
    expect(mapAriesOption(option({ details: { ...option().details, strikePrice: 201 } }))).toBeNull();
  });

  test("fetches one selected expiry, follows same-origin cursor and conservatively labels delayed", async () => {
    const putSymbol = "AAPL261016P00200000";
    const { client, requests } = fakeClient(({ path, query }) => {
      if (path.endsWith("/expiry-dates")) return { expiryDates: ["2026-10-23", "invalid", "2026-10-16", "2026-10-16"] };
      if (!query?.next) return { status: "OK", results: [option()], nextUrl: "https://api.aries.com/v1/options/snapshot/chain/AAPL?next=second-page&limit=250" };
      return { status: "OK", results: [option({ details: { ...option().details, ticker: `O:${putSymbol}`, contractType: "put" } })] };
    });
    const chain = await new AriesMarketData(client, { now: () => NOW }).getOptionsChain("aapl");
    expect(chain).toMatchObject({ underlyingSymbol: "AAPL", expirationDates: [EXPIRATION, Date.UTC(2026, 9, 23) / 1000], dataSource: "delayed", realtimeEligible: false, asOf: new Date(NOW).toISOString() });
    expect(chain.calls).toHaveLength(1);
    expect(chain.puts).toHaveLength(1);
    expect(requests[1]?.query).toMatchObject({ expirationDate: "2026-10-16", limit: 250 });
    expect(requests[2]?.query).toMatchObject({ expirationDate: "2026-10-16", next: "second-page" });
  });

  test("never follows response-provided foreign URLs or another API path", async () => {
    for (const nextUrl of ["https://outside.invalid/v1/options/snapshot/chain/AAPL?next=x", "https://api.aries.com/v1/orders?next=x", "https://api.aries.com@outside.invalid/v1/options/snapshot/chain/AAPL?next=x"]) {
      const { client, requests } = fakeClient(({ path }) => path.endsWith("/expiry-dates") ? { expiryDates: ["2026-10-16"] } : { status: "OK", results: [option()], nextUrl });
      await expect(new AriesMarketData(client, { now: () => NOW }).getOptionsChain("AAPL")).rejects.toThrow("invalid option pagination");
      expect(requests).toHaveLength(2);
    }
  });

  test("rejects repeated cursors and provider errors without printing their body", async () => {
    const { client, requests } = fakeClient(({ path }) => path.endsWith("/expiry-dates") ? { expiryDates: ["2026-10-16"] } : { status: "OK", results: [], nextUrl: "https://api.aries.com/v1/options/snapshot/chain/AAPL?next=repeated" });
    await expect(new AriesMarketData(client, { now: () => NOW }).getOptionsChain("AAPL")).rejects.toThrow("invalid option pagination");
    expect(requests).toHaveLength(3);
    const failure = fakeClient(({ path }) => path.endsWith("/expiry-dates") ? { expiryDates: ["2026-10-16"] } : { status: "ERROR", error: "synthetic-private-key" });
    await expect(new AriesMarketData(failure.client, { now: () => NOW }).getOptionsChain("AAPL")).rejects.toThrow("Aries could not return the options chain.");
  });
});

describe("polled subscriptions", () => {
  function scheduler() {
    const tasks = new Map<number, { callback: () => void; delay: number }>();
    let id = 0;
    return {
      tasks,
      setTimer(callback: () => void, delay: number) {
        tasks.set(++id, { callback, delay });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer(timer: ReturnType<typeof setTimeout>) { tasks.delete(timer as unknown as number); },
      run() {
        const entry = tasks.entries().next().value;
        if (!entry) throw new Error("No pending timer");
        tasks.delete(entry[0]);
        entry[1].callback();
      },
    };
  }

  const drain = async () => { for (let i = 0; i < 64; i++) await Promise.resolve(); };

  test("coalesces subscriptions and stops requesting after the last unsubscribe", async () => {
    const timer = scheduler();
    const { client, requests } = fakeClient(({ path, query }) => path.endsWith("last-trade") ? lastTrade(String(query?.ticker)) : { s: "ok", d: String(query?.symbols).split(",").map(quote) });
    const market = new AriesMarketData(client, { now: () => NOW, ...timer });
    market.subscribeQuotes([], () => {});
    expect(timer.tasks.size).toBe(0);
    const observed: Quote[] = [];
    const offA = market.subscribeQuotes([{ symbol: "AAPL" }], (_, value) => observed.push(value));
    const offB = market.subscribeQuotes([{ symbol: "AAPL" }, { symbol: "MSFT" }], (_, value) => observed.push(value));
    expect(timer.tasks.size).toBe(1);
    timer.run();
    await drain();
    expect(requests).toHaveLength(3);
    expect(requests[0]?.query?.symbols).toBe("AAPL,MSFT");
    expect(observed).toHaveLength(3);
    expect([...timer.tasks.values()][0]?.delay).toBe(15_000);
    offA();
    offB();
    expect(timer.tasks.size).toBe(0);
    expect(requests).toHaveLength(3);
  });

  test("does not emit an in-flight response after unsubscribe and backs off failures", async () => {
    const timer = scheduler();
    let complete: (value: unknown) => void = () => {};
    const { client } = fakeClient(() => new Promise((resolve) => { complete = resolve; }));
    const market = new AriesMarketData(client, timer);
    let emissions = 0;
    const off = market.subscribeQuotes([{ symbol: "AAPL" }], () => emissions++);
    timer.run();
    off();
    complete({ s: "ok", d: [quote("AAPL")] });
    await drain();
    expect(emissions).toBe(0);
    expect(timer.tasks.size).toBe(0);

    const failureTimer = scheduler();
    const failure = fakeClient(() => { throw new Error("synthetic network failure"); });
    const failing = new AriesMarketData(failure.client, failureTimer);
    failing.subscribeQuotes([{ symbol: "AAPL" }], () => {});
    failureTimer.run();
    await drain();
    expect([...failureTimer.tasks.values()][0]?.delay).toBe(30_000);
    failing.dispose();
    expect(failureTimer.tasks.size).toBe(0);
  });

  test("a poll with an untimed quote reports a notice, not a connection failure", async () => {
    const timer = scheduler();
    const { client } = fakeClient(({ path }) => {
      if (path.endsWith("last-trade")) throw new AriesError("Aries could not find the requested account or instrument.", 404);
      return { s: "ok", d: [quote("AAPL")] };
    });
    const errors: Error[] = [];
    const notices: (string | undefined)[] = [];
    const market = new AriesMarketData(client, { ...timer, onError: (error) => errors.push(error), onSuccess: (notice) => notices.push(notice) });
    market.subscribeQuotes([{ symbol: "AAPL" }], () => {});
    timer.run();
    await drain();
    expect(errors).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("source time unavailable");
    market.dispose();
  });
  test("reports polling failure and recovery without letting status observers interrupt polling", async () => {
    const timer = scheduler();
    let fail = true;
    const safeError = new Error("Aries temporarily limited requests. Try again shortly.");
    const { client } = fakeClient(({ path }) => {
      if (fail) throw safeError;
      if (path.endsWith("last-trade")) return lastTrade("AAPL");
      return { s: "ok", d: [quote("AAPL")] };
    });
    const errors: Error[] = [];
    let successes = 0, emissions = 0;
    const market = new AriesMarketData(client, {
      ...timer,
      onError(error) { errors.push(error); throw new Error("Synthetic observer failure"); },
      onSuccess() { successes++; throw new Error("Synthetic observer failure"); },
    });
    market.subscribeQuotes([{ symbol: "AAPL" }], () => emissions++);
    timer.run();
    await drain();
    expect(errors).toEqual([safeError]);
    expect(successes).toBe(0);
    expect([...timer.tasks.values()][0]?.delay).toBe(30_000);
    fail = false;
    timer.run();
    await drain();
    expect(successes).toBe(1);
    expect(emissions).toBe(1);
    expect([...timer.tasks.values()][0]?.delay).toBe(15_000);
    market.dispose();
  });
});
