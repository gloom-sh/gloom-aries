import { expect, test } from "bun:test";
import type { BrokerAdapter } from "gloomberb/types/broker";
import type { AppConfig, BrokerInstanceConfig } from "gloomberb/types/config";
import type { MarketDataRequestContext, QuoteSubscriptionTarget } from "gloomberb/types/data-provider";
import type { Quote } from "gloomberb/types/financials";
import { ariesMarketCapability, createAriesMarketProvider } from "./market-provider";
import { optionBrokerContract } from "./instruments";

const instance: BrokerInstanceConfig = { id: "synthetic-profile", brokerType: "aries", label: "Synthetic", config: {} };
const quote: Quote = { symbol: "AAPL", price: 200, currency: "USD", change: 1, changePercent: 0.5, lastUpdated: 1, providerId: "aries", dataSource: "delayed" };
const config = (profiles = [instance]): AppConfig => ({ brokerInstances: profiles, disabledPlugins: ["gloomberb-cloud"] }) as AppConfig;

function fixture() {
  const calls: { method: string; args: unknown[] }[] = [];
  const capture = (method: string, args: unknown[]) => calls.push({ method, args });
  let stopped = false;
  const broker = {
    async getQuote(...args: unknown[]) { capture("quote", args); return quote; },
    async searchInstruments(...args: unknown[]) { capture("search", args); return []; },
    async getPriceHistory(...args: unknown[]) { capture("history", args); return []; },
    async getPriceHistoryForResolution(...args: unknown[]) { capture("resolution", args); return []; },
    async getDetailedPriceHistory(...args: unknown[]) { capture("detail", args); return []; },
    getChartResolutionSupport(...args: unknown[]) { capture("support", args); return [{ resolution: "1m", maxRange: "1W" }]; },
    getChartResolutionCapabilities(...args: unknown[]) { capture("capabilities", args); return ["1m"]; },
    async getOptionsChain(...args: unknown[]) { capture("options", args); return { underlyingSymbol: "AAPL", expirationDates: [], calls: [], puts: [] }; },
    subscribeQuotes(profile: BrokerInstanceConfig, targets: QuoteSubscriptionTarget[], onQuote: (target: QuoteSubscriptionTarget, quote: Quote) => void) {
      capture("subscribe", [profile, targets]);
      if (targets[0]) onQuote(targets[0], quote);
      return () => { stopped = true; };
    },
  } as unknown as BrokerAdapter;
  let current = config();
  const provider = createAriesMarketProvider(() => current, broker);
  return { provider, calls, setConfig(value: AppConfig) { current = value; }, get stopped() { return stopped; } };
}

test("static asset-data capability is available to the CLI router", () => {
  expect(ariesMarketCapability).toMatchObject({ id: "asset-data.aries", sourceId: "aries", kind: "asset-data" });
  expect(ariesMarketCapability.provider.id).toBe("aries");
  expect(ariesMarketCapability.operations.getQuote?.handler).toBeFunction();
});

test("routes quote and quote-only financials through the selected broker without extra endpoints", async () => {
  const f = fixture();
  const instrument = optionBrokerContract("AAPL261016C00200000", instance.id)!;
  const context: MarketDataRequestContext = { brokerId: "aries", brokerInstanceId: instance.id, instrument };
  expect(await f.provider.getQuote("AAPL", "OPRA", context)).toBe(quote);
  expect(f.calls).toEqual([{ method: "quote", args: ["AAPL", instance, "OPRA", instrument] }]);
  expect(await f.provider.getTickerFinancials("AAPL", "NASDAQ")).toEqual({ quote, annualStatements: [], quarterlyStatements: [], priceHistory: [] });
  expect(f.calls.map((call) => call.method)).toEqual(["quote", "quote"]);
});

test("forwards history resolutions, date bounds, chain expiry and search to the same broker", async () => {
  const f = fixture();
  const start = new Date("2026-01-01"), end = new Date("2026-02-01");
  await f.provider.getPriceHistory("AAPL", "NASDAQ", "1M");
  await f.provider.getPriceHistoryForResolution!("AAPL", "NASDAQ", "1M", "15m");
  await f.provider.getDetailedPriceHistory!("AAPL", "NASDAQ", start, end, "5m");
  await f.provider.getOptionsChain!("AAPL", "NASDAQ", 1792108800);
  await f.provider.search(".AAPL");
  expect(f.calls).toEqual([
    { method: "history", args: ["AAPL", instance, "NASDAQ", "1M", undefined] },
    { method: "resolution", args: ["AAPL", instance, "NASDAQ", "1M", "15m", undefined] },
    { method: "detail", args: ["AAPL", instance, "NASDAQ", start, end, "5m", undefined] },
    { method: "options", args: ["AAPL", instance, "NASDAQ", 1792108800, undefined] },
    { method: "search", args: [".AAPL", instance] },
  ]);
});

test("rejects ambiguous profiles and mismatched instrument identities before transport", () => {
  const f = fixture();
  f.setConfig(config([instance, { ...instance, id: "synthetic-second" }]));
  expect(() => f.provider.getQuote("AAPL")).toThrow("exactly one enabled Aries profile");
  f.setConfig(config());
  expect(() => f.provider.getQuote("AAPL", "NASDAQ", { brokerInstanceId: "synthetic-other" })).toThrow("different broker profile");
  expect(f.calls).toEqual([]);
});

test("enforces the local-profile guard and US instrument scope on every request", () => {
  const f = fixture();
  expect(f.provider.canProvide!("AAPL", "NASDAQ")).toBe(true);
  expect(f.provider.canProvide!("SHEL", "LSE")).toBe(false);
  expect(f.provider.canProvide!("AAPL", "NASDAQ", { brokerId: "another-broker" })).toBe(false);
  f.setConfig({ ...config(), disabledPlugins: [] });
  expect(() => f.provider.getQuote("AAPL")).toThrow("dedicated local profile");
  f.setConfig(config([{ ...instance, enabled: false }]));
  expect(() => f.provider.getQuote("AAPL")).toThrow("Connect an Aries profile");
  expect(f.calls).toEqual([]);
});

test("uses existing broker subscriptions and does not start empty subscriptions", () => {
  const f = fixture();
  f.provider.subscribeQuotes!([], () => {});
  expect(f.calls).toEqual([]);
  const received: Quote[] = [];
  const targets = [{ symbol: "AAPL", exchange: "NASDAQ" }];
  const off = f.provider.subscribeQuotes!(targets, (_target, value) => received.push(value));
  expect(f.calls).toEqual([{ method: "subscribe", args: [instance, targets] }]);
  expect(received).toEqual([quote]);
  off();
  expect(f.stopped).toBe(true);
});

test("supports the host OPTIONS namespace and filters unsupported or foreign stream targets", () => {
  const f = fixture();
  const contract = { symbol: "AAPL261016C00200000", exchange: "OPTIONS", surface: "options" as const, visible: true };
  const underlying = { symbol: "AAPL", exchange: "NASDAQ", surface: "options" as const };
  const targets = [
    contract, underlying,
    { symbol: "SHEL", exchange: "LSE" },
    { symbol: "BTC-USD", exchange: "CCC" },
    { symbol: "AAPL", exchange: "OPTIONS" },
    { symbol: "MSFT", context: { brokerId: "another-broker" } },
    { symbol: "SPY", context: { brokerInstanceId: "another-profile" } },
    { symbol: "QQQ", context: { brokerInstanceId: instance.id, instrument: { brokerId: "aries", brokerInstanceId: "another-profile", symbol: "QQQ" } } },
  ];
  expect(f.provider.canProvide!(contract.symbol, contract.exchange)).toBe(true);
  expect(f.provider.canProvide!("AAPL", "OPTIONS")).toBe(false);
  expect(() => f.provider.subscribeQuotes!(targets, () => {})).not.toThrow();
  expect(f.calls).toEqual([{ method: "subscribe", args: [instance, [contract, underlying]] }]);
});

test("availability probes and subscriptions do not throw during setup, disabled profiles or ambiguous profiles", () => {
  const f = fixture();
  for (const unavailable of [config([]), config([{ ...instance, enabled: false }]), config([instance, { ...instance, id: "second" }]), { ...config(), disabledPlugins: [] }]) {
    f.setConfig(unavailable);
    expect(f.provider.canProvide!("AAPL", "NASDAQ")).toBe(false);
    expect(() => f.provider.subscribeQuotes!([{ symbol: "AAPL", exchange: "NASDAQ" }], () => {})).not.toThrow();
    expect(() => f.provider.getQuote("AAPL", "NASDAQ")).toThrow();
  }
  f.setConfig(config());
  expect(() => f.provider.subscribeQuotes!([{ symbol: "SHEL", exchange: "LSE" }], () => {})).not.toThrow();
  expect(f.calls).toEqual([]);
});

test("does not invent foreign currency rates or article data", async () => {
  const f = fixture();
  expect(await f.provider.getExchangeRate("USD")).toBe(1);
  await expect(f.provider.getExchangeRate("EUR")).rejects.toThrow("does not provide currency conversion");
  expect(await f.provider.getArticleSummary("https://example.invalid/article")).toBeNull();
  expect(f.calls).toEqual([]);
});

// The chart opens the day at the pre-market only when the bars say they include it.
test("resolution history says it includes pre-market and after-hours only when the chart asked for intraday bars", async () => {
  const sessions: unknown[] = [];
  const history = { async getPriceHistoryForResolution(...args: unknown[]) { sessions.push(args[5]); return []; }, async getDetailedPriceHistory() { return []; } };
  const provider = createAriesMarketProvider(() => config(), { history } as unknown as BrokerAdapter);
  const read = (resolution: "15m" | "1d", historySession?: "extended") => provider.getPriceHistoryForResolutionWithMetadata!("AAPL", "NASDAQ", "1D", resolution, historySession ? { historySession } : undefined);
  expect(await read("15m", "extended")).toEqual({ points: [], resolution: "15m", extendedHours: true });
  expect(await read("15m")).toEqual({ points: [], resolution: "15m" });
  expect(await read("1d", "extended")).toEqual({ points: [], resolution: "1d" });
  expect(sessions).toEqual(["extended", undefined, "extended"]);
});
