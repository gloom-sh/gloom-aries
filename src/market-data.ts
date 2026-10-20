import type { QuoteSubscriptionTarget } from "gloomberb/types/data-provider";
import type { OptionContract, OptionsChain, PricePoint, Quote } from "gloomberb/types/financials";
import type { BrokerContractRef, InstrumentSearchResult } from "gloomberb/types/instrument";
import type { ChartResolutionSupport, ManualChartResolution, TimeRange } from "gloomberb/time-series";
import * as hostMarketData from "gloomberb/market-data";
import { zonedDateTimeParts } from "gloomberb/utils";
import { AriesError } from "./client";
import { ariesInstrumentSymbol, finiteNumber, optionBrokerContract, parseOptionSymbol } from "./instruments";
import { AriesMarketStream, type AriesMarketStreamOptions } from "./market-stream";

export interface AriesMarketClient {
  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T>;
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const rows = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const nonnegative = (value: unknown): number | undefined => {
  const number = finiteNumber(value);
  return number !== undefined && number >= 0 ? number : undefined;
};
const DAY_MS = 86_400_000;
const MAX_PAGES = 12;
const QUOTE_BATCH_SIZE = 50;
const LAST_TRADE_TTL_MS = 60_000;

export const ARIES_CHART_RESOLUTIONS: ManualChartResolution[] = ["1m", "5m", "15m", "30m", "45m", "1h", "1d", "1wk", "1mo"];
export const ARIES_CHART_RESOLUTION_SUPPORT: ChartResolutionSupport[] = [
  { resolution: "1m", maxRange: "1W" },
  { resolution: "5m", maxRange: "1M" },
  { resolution: "15m", maxRange: "3M" },
  { resolution: "30m", maxRange: "6M" },
  { resolution: "45m", maxRange: "6M" },
  { resolution: "1h", maxRange: "1Y" },
  { resolution: "1d", maxRange: "ALL" },
  { resolution: "1wk", maxRange: "ALL" },
  { resolution: "1mo", maxRange: "ALL" },
];
const RESOLUTIONS: Record<ManualChartResolution, string> = {
  "1m": "1", "5m": "5", "15m": "15", "30m": "30", "45m": "45", "1h": "60", "1d": "D", "1wk": "W", "1mo": "M",
};
const PRESET_RESOLUTIONS: Record<TimeRange, ManualChartResolution> = {
  "1D": "1m", "1W": "5m", "1M": "15m", "3M": "1h", "6M": "1d", "1Y": "1d", "5Y": "1wk", ALL: "1mo",
};

export function ariesChartResolution(barSize: string): string {
  if (barSize in RESOLUTIONS) return RESOLUTIONS[barSize as ManualChartResolution];
  const match = /^(\d+)\s*(min|mins|minute|minutes|hour|hours|day|days|week|weeks|month|months)$/i.exec(barSize.trim());
  if (match) {
    const count = Number(match[1]);
    const unit = match[2]!.toLowerCase();
    const resolution = unit.startsWith("min") ? String(count) : unit.startsWith("hour") ? String(count * 60) : `${count}${unit.startsWith("day") ? "D" : unit.startsWith("week") ? "W" : "M"}`;
    if (["1", "3", "5", "15", "30", "45", "60", "120", "180", "240", "1D", "1W", "1M", "3M", "6M", "12M"].includes(resolution)) return resolution;
  }
  throw new Error("Aries does not support this chart resolution. Choose minute, hourly, daily, weekly or monthly bars.");
}

function rangeStart(range: TimeRange, now: number): number {
  const date = new Date(now);
  if (range === "ALL") return 0;
  if (range === "1D") return Math.max(0, now - DAY_MS);
  if (range === "1W") return Math.max(0, now - 7 * DAY_MS);
  const months = { "1M": 1, "3M": 3, "6M": 6, "1Y": 12, "5Y": 60 }[range];
  date.setUTCMonth(date.getUTCMonth() - months);
  return Math.max(0, date.getTime());
}

/** The REST chart quote does not document a source timestamp or entitlement flag. */
export function mapAriesQuote(value: unknown, receivedAt: number): Quote | null {
  const raw = record(value);
  const v = record(raw.v);
  const symbol = text(raw.s);
  const price = nonnegative(v.lp);
  if (!symbol || price === undefined) return null;
  const previousClose = nonnegative(v.prev_close_price);
  const change = finiteNumber(v.ch) ?? (previousClose !== undefined ? price - previousClose : 0);
  return {
    symbol, providerId: "aries", price, lastTradePrice: price, currency: "USD", priceBasis: "per-unit",
    change, changePercent: finiteNumber(v.chp) ?? (previousClose ? change / previousClose * 100 : 0),
    previousClose, name: text(v.description) ?? text(raw.n),
    bid: nonnegative(v.bid), ask: nonnegative(v.ask), volume: nonnegative(v.volume),
    open: nonnegative(v.open_price), high: nonnegative(v.high_price), low: nonnegative(v.low_price),
    exchangeName: text(v.exchange),
    lastUpdated: 0, receivedAt, delivery: "poll", dataSource: "delayed", sessionConfidence: "unknown",
  };
}

interface LastTrade { price: number; timestamp: number }

export function mapAriesLastTrade(value: unknown, symbol: string, receivedAt: number): LastTrade | null {
  const raw = record(value), trade = record(raw.results);
  if (raw.status !== "OK" && raw.status !== "DELAYED") throw new Error("Aries could not return a timestamped trade.");
  const price = nonnegative(trade.price), nanoseconds = finiteNumber(trade.sipTimestamp);
  const timestamp = nanoseconds !== undefined ? Math.floor(nanoseconds / 1_000_000) : NaN;
  if (trade.ticker !== symbol || price === undefined || price === 0 || !Number.isFinite(timestamp) || timestamp < Date.UTC(2000, 0, 1) || timestamp > receivedAt) return null;
  return { price, timestamp };
}

/** Weekday 09:30 to 16:00 New York time. Holidays and early closes count as regular; the host has no exchange calendar. */
export function isRegularSession(timestamp: number): boolean {
  const parts = zonedDateTimeParts(timestamp, "America/New_York");
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  const minutes = parts.hour * 60 + parts.minute;
  return weekday !== 0 && weekday !== 6 && minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

const isIntradayBar = (resolution: string) => /^\d+$/.test(resolution);

/** The public host has timezone tools but no exchange calendar. Ambiguous early-close hours stay unknown. */
export function ariesTradeSession(timestamp: number): "PRE" | "REGULAR" | "POST" | undefined {
  const parts = zonedDateTimeParts(timestamp, "America/New_York");
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  if (weekday === 0 || weekday === 6) return undefined;
  const minutes = parts.hour * 60 + parts.minute;
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return "PRE";
  if (minutes >= 9 * 60 + 30 && minutes < 13 * 60) return "REGULAR";
  if (minutes >= 16 * 60 && minutes < 20 * 60) return "POST";
  return undefined;
}

export function withAriesLastTrade(quote: Quote, trade: LastTrade, receivedAt: number): Quote {
  const marketState = ariesTradeSession(trade.timestamp);
  // Before the open, the snapshot's price is the last regular close and its prev_close_price the close before
  // that, so the move is from the snapshot's price.
  const previousClose = marketState === "PRE" && quote.price > 0 ? quote.price : quote.previousClose;
  const change = previousClose !== undefined && previousClose > 0 ? trade.price - previousClose : 0;
  return {
    ...quote,
    price: trade.price, lastTradePrice: trade.price, lastTradeTime: trade.timestamp,
    lastUpdated: trade.timestamp, receivedAt, previousClose, change,
    changePercent: previousClose && previousClose > 0 ? change / previousClose * 100 : 0,
    marketState, sessionConfidence: marketState ? "derived" : "unknown",
    preMarketPrice: marketState === "PRE" ? trade.price : undefined,
    postMarketPrice: marketState === "POST" ? trade.price : undefined,
    // The snapshot's bid and ask stay: the ticket sets a limit from them. They carry no source time, and the
    // quote stays marked delayed. Before the open they, and the day's open, high and low, are the last
    // session's: a limit set from them would be far from the pre-market, and its range is not today's.
    ...(marketState === "PRE" ? { bid: undefined, ask: undefined, mark: undefined, open: undefined, high: undefined, low: undefined } : {}),
  };
}

export function mapAriesHistory(value: unknown): PricePoint[] {
  const raw = record(value);
  if (raw.s === "no_data") return [];
  if (raw.s !== "ok") throw new Error("Aries could not return chart data.");
  const times = rows(raw.t);
  const closes = rows(raw.c);
  const open = rows(raw.o), high = rows(raw.h), low = rows(raw.l), volume = rows(raw.v);
  const points = new Map<number, PricePoint>();
  for (let i = 0; i < times.length; i++) {
    const time = nonnegative(times[i]);
    const close = nonnegative(closes[i]);
    if (time === undefined || close === undefined || !Number.isFinite(new Date(time * 1000).getTime())) continue;
    points.set(time, { date: new Date(time * 1000), close, open: nonnegative(open[i]), high: nonnegative(high[i]), low: nonnegative(low[i]), volume: nonnegative(volume[i]) });
  }
  return [...points.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
}

function expirationSeconds(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date.getTime() / 1000 : undefined;
}

/** Snapshot timestamps are Unix nanoseconds; preserve source time, never local receipt time. */
function snapshotMilliseconds(value: unknown): number | undefined {
  const timestamp = nonnegative(value);
  if (timestamp === undefined || timestamp === 0) return undefined;
  const milliseconds = Math.floor(timestamp / 1_000_000);
  return Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : undefined;
}

export function mapAriesOption(value: unknown): { contract: OptionContract; right: "C" | "P" } | null {
  const raw = record(value), details = record(raw.details), quote = record(raw.lastQuote), trade = record(raw.lastTrade), day = record(raw.day), underlying = record(raw.underlyingAsset);
  const symbol = text(details.ticker);
  const parsed = symbol ? parseOptionSymbol(symbol) : null;
  const expiration = expirationSeconds(details.expirationDate);
  const strike = nonnegative(details.strikePrice);
  const right = details.contractType === "call" ? "C" : details.contractType === "put" ? "P" : undefined;
  if (!parsed || expiration === undefined || strike === undefined || !right || parsed.right !== right || parsed.strike !== strike || parsed.expiration !== details.expirationDate) return null;
  // Adjusted contracts do not have the standard 100-share deliverable the host assumes.
  if (finiteNumber(details.sharesPerContract) !== 100) return null;
  const underlyingPrice = nonnegative(underlying.price);
  return {
    right,
    contract: {
      contractSymbol: parsed.symbol, strike, currency: "USD", expiration,
      lastPrice: nonnegative(trade.price) ?? 0,
      change: finiteNumber(day.change) ?? 0, percentChange: finiteNumber(day.changePercent) ?? 0,
      bid: nonnegative(quote.bid) ?? 0, ask: nonnegative(quote.ask) ?? 0,
      volume: nonnegative(day.volume), openInterest: nonnegative(raw.openInterest),
      impliedVolatility: nonnegative(raw.impliedVolatility) ?? 0,
      inTheMoney: underlyingPrice !== undefined && (right === "C" ? underlyingPrice > strike : underlyingPrice < strike),
      lastTradeDate: (snapshotMilliseconds(trade.sipTimestamp) ?? 0) / 1000,
      lastUpdated: snapshotMilliseconds(quote.lastUpdated),
    },
  };
}

interface Subscription {
  targets: QuoteSubscriptionTarget[];
  onQuote: (target: QuoteSubscriptionTarget, quote: Quote) => void;
}
interface MarketDataOptions {
  now?: () => number;
  pollIntervalMs?: number;
  onError?: (error: Error) => void;
  /** A successful poll, with a freshness notice when some source times are unknown. */
  onSuccess?: (notice?: string) => void;
  setTimer?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  /** Streams quotes over the market socket when given; otherwise subscriptions poll REST. */
  stream?: Pick<AriesMarketStreamOptions, "token" | "connect" | "random">;
  /** The market socket started (true) or stopped (false) pushing quotes. */
  onStream?: (live: boolean) => void;
}

/** A dropped socket gets this long to come back before REST polling stands in for it. */
const STREAM_FALLBACK_GRACE_MS = 5_000;
/**
 * A symbol Aries answered with no quote and no trade is asked about again
 * only after this long: a pane that refreshes it every 30 seconds would
 * otherwise repeat three requests each time for nothing.
 */
const NO_QUOTE_RETRY_MS = 5 * 60_000;
const NO_QUOTE_LIMIT = 500;

/**
 * A request Aries has no answer for, as opposed to one that failed: a miss in
 * the host's terms, which tries its next source without logging a failure,
 * and shows `reason`, when there is one, where the data would be. A host
 * without `createProviderMiss` gets a plain error.
 */
export function ariesMiss(message: string, reason?: string): Error {
  const miss = (hostMarketData as { createProviderMiss?: (message: string, reason?: unknown) => Error }).createProviderMiss;
  return miss ? miss(message, reason) : new Error(message);
}

/** Aries has nothing for a symbol it was asked about. */
export function ariesQuoteMiss(symbol: string): Error {
  const message = `No quote for ${symbol}.`;
  return ariesMiss(message, message);
}

export class AriesMarketData {
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly setTimer: NonNullable<MarketDataOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<MarketDataOptions["clearTimer"]>;
  private readonly onError?: MarketDataOptions["onError"];
  private readonly onSuccess?: MarketDataOptions["onSuccess"];
  private readonly subscriptions = new Set<Subscription>();
  private readonly lastTrades = new Map<string, { fetchedAt: number; trade: LastTrade | null }>();
  /** When Aries last answered a symbol with nothing, by symbol. */
  private readonly noQuote = new Map<string, number>();
  private readonly lastTradeFlights = new Map<string, { trade: Promise<LastTrade | null>; priority: boolean }>();
  private lastTradeQueue: Promise<unknown> = Promise.resolve();
  private supplementalBlockedUntil = 0;
  private quoteNotice?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private polling = false;
  private failures = 0;
  private disposed = false;
  private readonly stream?: AriesMarketStream;

  constructor(private readonly client: AriesMarketClient, options: MarketDataOptions = {}) {
    this.now = options.now ?? Date.now;
    this.pollIntervalMs = Math.max(10_000, options.pollIntervalMs ?? 15_000);
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.onError = options.onError;
    this.onSuccess = options.onSuccess;
    if (options.stream) {
      this.stream = new AriesMarketStream({
        ...options.stream, now: this.now, setTimer: this.setTimer, clearTimer: this.clearTimer,
        onQuote: (symbol, quote) => this.deliver(symbol, quote),
        onLive: (live) => {
          if (live && this.timer !== undefined) { this.clearTimer(this.timer); this.timer = undefined; }
          if (!live && this.subscriptions.size && !this.timer && !this.polling) this.schedule(STREAM_FALLBACK_GRACE_MS);
          try { options.onStream?.(live); } catch { /* Status observers do not control the stream. */ }
        },
      });
    }
  }

  /** Quotes are pushed over the market socket now, not polled. */
  get streaming(): boolean { return this.stream?.live === true; }

  async getQuote(ticker: string, instrument?: BrokerContractRef | null): Promise<Quote> {
    const symbol = ariesInstrumentSymbol(ticker, instrument);
    // A snapshot can omit a row for a moment. Ask once more, then build the
    // quote from the timestamped last trade rather than fail an order ticket.
    // One instrument is someone looking at it (an order ticket, a detail
    // pane), so its trade skips the queue a heatmap's symbols wait in.
    const missedAt = this.noQuote.get(symbol);
    if (missedAt !== undefined && this.now() - missedAt < NO_QUOTE_RETRY_MS) throw ariesQuoteMiss(symbol);
    const quote = (await this.getQuotes([symbol], undefined, true)).get(symbol) ?? (await this.getQuotes([symbol], undefined, true)).get(symbol);
    if (quote) { this.noQuote.delete(symbol); return { ...quote, symbol: ticker }; }
    let failed = false;
    // A request Aries could not serve (rate limit, outage, network) is not an answer; a trade it gave that is unusable is.
    const trade = parseOptionSymbol(symbol) ? null : await this.getLastTrade(symbol, true).catch((error: unknown) => { failed = error instanceof AriesError; return null; });
    // A miss, not a failure: the host tries its next source, shows the reason and does not log it. Only an
    // answer of nothing is remembered; a failed request is asked again next time.
    if (!trade) {
      if (!failed) this.rememberNoQuote(symbol);
      throw ariesQuoteMiss(symbol);
    }
    this.noQuote.delete(symbol);
    const receivedAt = this.now();
    return withAriesLastTrade({
      symbol: ticker, providerId: "aries", price: trade.price, currency: "USD", priceBasis: "per-unit", change: 0, changePercent: 0,
      lastUpdated: 0, receivedAt, delivery: "poll", dataSource: "delayed", sessionConfidence: "unknown",
    }, trade, receivedAt);
  }

  async getQuotes(symbols: string[], isActive: () => boolean = () => true, priority = false): Promise<Map<string, Quote>> {
    const unique = [...new Set(symbols.map((symbol) => ariesInstrumentSymbol(symbol)).filter(Boolean))];
    const result = new Map<string, Quote>();
    const equities = unique.filter((symbol) => !parseOptionSymbol(symbol));
    const options = unique.filter((symbol) => parseOptionSymbol(symbol));
    for (let offset = 0; offset < equities.length; offset += QUOTE_BATCH_SIZE) {
      if (!isActive()) return result;
      const batch = equities.slice(offset, offset + QUOTE_BATCH_SIZE);
      const raw = record(await this.client.get<unknown>("/v1/chart/quotes", { symbols: batch.join(",") }));
      if (raw.s !== "ok") throw new Error("Aries could not return quotes.");
      const receivedAt = this.now();
      for (const row of rows(raw.d)) {
        const quote = mapAriesQuote(row, receivedAt);
        if (quote && batch.includes(quote.symbol)) result.set(quote.symbol, quote);
      }
    }
    let unknownSourceTime = options.length > 0;
    for (const symbol of equities) {
      if (!isActive()) return result;
      const quote = result.get(symbol);
      if (!quote) continue;
      const trade = await this.getLastTrade(symbol, priority);
      if (trade) result.set(symbol, withAriesLastTrade(quote, trade, this.now()));
      else unknownSourceTime = true;
    }
    this.quoteNotice = unknownSourceTime
      ? this.supplementalBlockedUntil > this.now()
        ? "Quote source time unavailable. Add the market:supplemental scope to your Aries client."
        : "Quote source time unavailable; the snapshot may be stale."
      : undefined;
    for (let offset = 0; offset < options.length; offset += QUOTE_BATCH_SIZE) {
      if (!isActive()) return result;
      const batch = options.slice(offset, offset + QUOTE_BATCH_SIZE);
      const raw = record(await this.client.get<unknown>("/v1/marketdata/options/details", { symbols: batch.join(",") }));
      const receivedAt = this.now();
      for (const item of rows(raw.data)) {
        const row = record(item), symbol = text(row.symbol);
        if (!symbol || !batch.includes(symbol)) continue;
        // A contract that has not traded still has a market: a spread's legs need its bid and ask.
        const price = nonnegative(row.lastPrice) ?? nonnegative(row.midPrice);
        if (price === undefined) continue;
        const previousClose = nonnegative(row.closePrice);
        const change = previousClose !== undefined ? price - previousClose : 0;
        result.set(symbol, {
          symbol, providerId: "aries", instrumentType: "OPTION", price, currency: "USD", priceBasis: "per-unit",
          previousClose, change, changePercent: previousClose ? change / previousClose * 100 : 0,
          bid: nonnegative(row.bidPrice), ask: nonnegative(row.askPrice), mark: nonnegative(row.midPrice),
          lastUpdated: 0, receivedAt, dataSource: "delayed", delivery: "poll", sessionConfidence: "unknown",
        });
      }
    }
    return result;
  }

  getQuoteNotice(): string | undefined { return this.quoteNotice; }

  /** Trades are read one at a time; `priority` starts at once instead of behind the queue. */
  private getLastTrade(symbol: string, priority = false): Promise<LastTrade | null> {
    if (this.supplementalBlockedUntil > this.now()) return Promise.resolve(null);
    const cached = this.lastTrades.get(symbol);
    if (cached && cached.fetchedAt + LAST_TRADE_TTL_MS > this.now()) return Promise.resolve(cached.trade);
    const existing = this.lastTradeFlights.get(symbol);
    if (existing && (existing.priority || !priority)) return existing.trade;
    const read = async () => {
      if (this.disposed) throw new Error("Aries connection is closed.");
      if (this.supplementalBlockedUntil > this.now()) return null;
      let trade: LastTrade | null;
      try {
        const response = await this.client.get<unknown>("/v1/stocks/last-trade", { ticker: symbol });
        trade = mapAriesLastTrade(response, symbol, this.now());
      } catch (error) {
        if (!(error instanceof AriesError) || (error.status !== 403 && error.status !== 404)) throw error;
        if (error.status === 403) this.supplementalBlockedUntil = this.now() + LAST_TRADE_TTL_MS;
        trade = null;
      }
      if (!this.disposed) {
        for (const [key, value] of this.lastTrades) if (value.fetchedAt + LAST_TRADE_TTL_MS <= this.now()) this.lastTrades.delete(key);
        if (this.lastTrades.size >= 200) this.lastTrades.delete(this.lastTrades.keys().next().value!);
        this.lastTrades.set(symbol, { fetchedAt: this.now(), trade });
      }
      return trade;
    };
    const flight = (priority ? read() : this.lastTradeQueue.then(read)).finally(() => {
      if (this.lastTradeFlights.get(symbol)?.trade === flight) this.lastTradeFlights.delete(symbol);
    });
    this.lastTradeFlights.set(symbol, { trade: flight, priority });
    if (!priority) this.lastTradeQueue = flight.catch(() => {});
    return flight;
  }

  async searchInstruments(query: string, instanceId?: string): Promise<InstrumentSearchResult[]> {
    if (!query.trim()) return [];
    const raw = await this.client.get<unknown>("/v1/chart/search", { query: query.trim(), limit: 20 });
    const results: InstrumentSearchResult[] = [];
    for (const item of rows(raw)) {
      const row = record(item), symbol = text(row.symbol) ?? text(row.ticker);
      if (!symbol) continue;
      const type = text(row.type) ?? "stock";
      const option = optionBrokerContract(symbol, instanceId);
      const exchange = text(row.exchange) ?? "";
      const secType = type === "option" ? "OPT" : type === "etf" || type === "fund" ? "ETF" : type === "stock" ? "STK" : type.toUpperCase();
      results.push({
        providerId: "aries", brokerInstanceId: instanceId, symbol: option?.localSymbol ?? symbol,
        name: text(row.description) ?? symbol, exchange, type, currency: "USD", primaryExchange: exchange || undefined,
        brokerContract: option ?? { brokerId: "aries", brokerInstanceId: instanceId, symbol, localSymbol: symbol, secType, currency: "USD", primaryExchange: exchange || undefined },
      });
    }
    return results;
  }

  getPriceHistory(ticker: string, range: TimeRange, instrument?: BrokerContractRef | null, session?: "extended"): Promise<PricePoint[]> {
    return this.getPriceHistoryForResolution(ticker, range, PRESET_RESOLUTIONS[range], instrument, session);
  }

  getPriceHistoryForResolution(ticker: string, range: TimeRange, resolution: ManualChartResolution, instrument?: BrokerContractRef | null, session?: "extended"): Promise<PricePoint[]> {
    const now = this.now();
    return this.getDetailedPriceHistory(ticker, new Date(rangeStart(range, now)), new Date(now), resolution, instrument, session);
  }

  /**
   * Pre- and post-market bars when the chart asks for them (its Ext hours
   * toggle), and always outside the regular session, so a chart opened in the
   * evening or before the open shows what is trading now.
   */
  includesExtendedHours(session?: "extended"): boolean {
    return session === "extended" || !isRegularSession(this.now());
  }

  async getDetailedPriceHistory(ticker: string, startDate: Date, endDate: Date, barSize: string, instrument?: BrokerContractRef | null, session?: "extended"): Promise<PricePoint[]> {
    const from = Math.max(0, Math.floor(startDate.getTime() / 1000)), end = Math.floor(endDate.getTime() / 1000);
    if (!Number.isFinite(from) || !Number.isFinite(end) || end <= from) throw new Error("Choose a valid Aries chart date range.");
    const symbol = ariesInstrumentSymbol(ticker, instrument), resolution = ariesChartResolution(barSize);
    let to = end;
    const points = new Map<number, PricePoint>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const raw = record(await this.client.get<unknown>("/v1/chart/history", { symbol, resolution, from, to, firstDataRequest: page ? "0" : "1", includeExtended: this.includesExtendedHours(session) && isIntradayBar(resolution) ? "true" : "false" }));
      const batch = mapAriesHistory(raw);
      for (const point of batch) {
        const time = point.date.getTime() / 1000;
        if (time >= from && time <= end) points.set(time, point);
      }
      const more = raw.nextTo !== undefined || raw.nextTime !== undefined;
      if (!more || batch.length === 0) return [...points.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
      // The opaque nextTo format is unspecified. Continue using the oldest observed bar.
      const oldest = batch[0]!.date.getTime() / 1000;
      if (oldest <= from) return [...points.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
      if (oldest - 1 >= to) throw new Error("Aries chart pagination did not advance. Choose a shorter date range.");
      to = oldest - 1;
    }
    throw new Error("Aries chart data exceeded the request limit. Choose a shorter date range or larger bars.");
  }

  async getOptionsChain(ticker: string, expirationDate?: number): Promise<OptionsChain> {
    const symbol = ticker.trim().toUpperCase();
    const expiryResponse = record(await this.client.get<unknown>(`/v1/options/${encodeURIComponent(symbol)}/expiry-dates`));
    const expirationDates = [...new Set(rows(expiryResponse.expiryDates).map(expirationSeconds).filter((value): value is number => value !== undefined))].sort((a, b) => a - b);
    const today = Math.floor(this.now() / DAY_MS) * DAY_MS / 1000;
    const expiration = expirationDate ?? expirationDates.find((date) => date >= today);
    const chain: OptionsChain = { underlyingSymbol: symbol, expirationDates, calls: [], puts: [], providerId: "aries", dataSource: "delayed", realtimeEligible: false };
    if (expiration === undefined) return chain;
    if (!Number.isFinite(expiration) || !expirationDates.includes(expiration)) throw new Error("Choose an available Aries option expiration.");
    const date = new Date(expiration * 1000).toISOString().slice(0, 10);
    const path = `/v1/options/snapshot/chain/${encodeURIComponent(symbol)}`;
    const query: Record<string, string | number | undefined> = { expirationDate: date, limit: 250, order: "asc", sort: "strike_price" };
    const seenCursors = new Set<string>();
    const contracts = new Map<string, { contract: OptionContract; right: "C" | "P" }>();
    let sourceTime: number | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const raw = record(await this.client.get<unknown>(path, query));
      if (raw.status !== "OK") throw new Error("Aries could not return the options chain.");
      for (const item of rows(raw.results)) {
        const mapped = mapAriesOption(item);
        const parsed = mapped ? parseOptionSymbol(mapped.contract.contractSymbol) : null;
        if (!mapped || mapped.contract.expiration !== expiration || parsed?.underlying !== symbol) continue;
        contracts.set(mapped.contract.contractSymbol, mapped);
        if (mapped.contract.lastUpdated !== undefined) sourceTime = Math.max(sourceTime ?? 0, mapped.contract.lastUpdated);
      }
      const nextUrl = text(raw.nextUrl);
      if (!nextUrl) {
        for (const { contract, right } of contracts.values()) (right === "C" ? chain.calls : chain.puts).push(contract);
        chain.calls.sort((a, b) => a.strike - b.strike);
        chain.puts.sort((a, b) => a.strike - b.strike);
        if (sourceTime !== undefined) chain.asOf = new Date(sourceTime).toISOString();
        return chain;
      }
      let next: URL;
      try { next = new URL(nextUrl, "https://api.aries.com"); } catch { throw new Error("Aries returned invalid option pagination."); }
      const cursor = next.searchParams.get("next");
      if (next.origin !== "https://api.aries.com" || next.pathname !== path || next.username || next.password || !cursor || seenCursors.has(cursor)) throw new Error("Aries returned invalid option pagination.");
      seenCursors.add(cursor);
      // Only the opaque cursor is retained. Never send credentials to a response-provided URL.
      query.next = cursor;
    }
    throw new Error("Aries options chain exceeded the request limit. Choose a different expiration.");
  }

  /**
   * Quotes for the targets, pushed from the market socket as Aries sends them.
   * While the socket is down (or there is none) the same targets poll REST
   * instead, and stop polling once it is back.
   */
  subscribeQuotes(targets: QuoteSubscriptionTarget[], onQuote: Subscription["onQuote"]): () => void {
    if (this.disposed || targets.length === 0) return () => {};
    const subscription = { targets, onQuote };
    this.subscriptions.add(subscription);
    const symbols = [...new Set(targets.map((target) => ariesInstrumentSymbol(target.symbol, target.context?.instrument)))];
    if (this.stream) {
      for (const symbol of symbols) this.stream.retain(symbol);
      // A symbol another subscriber already streams has its quote now, not at its next tick.
      for (const symbol of symbols) {
        const quote = this.stream.current(symbol);
        if (quote) this.deliverTo(subscription, symbol, quote);
      }
    }
    if (!this.streaming && !this.timer && !this.polling) this.schedule(this.stream ? STREAM_FALLBACK_GRACE_MS : 0);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.subscriptions.delete(subscription);
      if (this.stream) for (const symbol of symbols) this.stream.release(symbol);
      if (this.subscriptions.size === 0 && this.timer !== undefined) {
        this.clearTimer(this.timer);
        this.timer = undefined;
      }
    };
  }

  dispose(): void {
    this.disposed = true;
    this.subscriptions.clear();
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    this.lastTrades.clear();
    this.stream?.dispose();
  }

  private deliverTo(subscription: Subscription, symbol: string, quote: Quote): void {
    for (const target of subscription.targets) {
      if (ariesInstrumentSymbol(target.symbol, target.context?.instrument) !== symbol) continue;
      try { subscription.onQuote(target, { ...quote, symbol: target.symbol }); } catch { /* Consumer failures must not break other subscriptions. */ }
    }
  }

  private rememberNoQuote(symbol: string): void {
    this.noQuote.delete(symbol);
    this.noQuote.set(symbol, this.now());
    if (this.noQuote.size > NO_QUOTE_LIMIT) this.noQuote.delete(this.noQuote.keys().next().value!);
  }

  private deliver(symbol: string, quote: Quote): void {
    if (this.disposed) return;
    // The socket has a quote for it after all.
    this.noQuote.delete(symbol);
    for (const subscription of [...this.subscriptions]) if (this.subscriptions.has(subscription)) this.deliverTo(subscription, symbol, quote);
  }

  private schedule(delay: number): void {
    this.timer = this.setTimer(() => { this.timer = undefined; void this.poll(); }, delay);
  }

  private async poll(): Promise<void> {
    if (this.polling || this.disposed || this.subscriptions.size === 0 || this.streaming) return;
    this.polling = true;
    const symbols = [...this.subscriptions].flatMap(({ targets }) => targets.map((target) => ariesInstrumentSymbol(target.symbol, target.context?.instrument)));
    try {
      const quotes = await this.getQuotes(symbols, () => !this.disposed && this.subscriptions.size > 0);
      this.failures = 0;
      if (!this.disposed && this.subscriptions.size > 0) {
        try {
          // A freshness notice is not a failure: the connection is still up.
          this.onSuccess?.(this.quoteNotice);
        } catch { /* Status observers do not control polling. */ }
      }
      // The socket came back while this poll ran: its quotes are newer than these.
      for (const subscription of this.streaming ? [] : this.subscriptions) {
        for (const target of subscription.targets) {
          if (!this.subscriptions.has(subscription)) break;
          const quote = quotes.get(ariesInstrumentSymbol(target.symbol, target.context?.instrument));
          if (quote) {
            try { subscription.onQuote(target, { ...quote, symbol: target.symbol }); } catch { /* Consumer failures must not break other subscriptions. */ }
          }
        }
      }
    } catch (error) {
      this.failures = Math.min(this.failures + 1, 4);
      if (!this.disposed && this.subscriptions.size > 0) {
        try { this.onError?.(error instanceof Error ? error : new Error("Aries quotes unavailable.")); } catch { /* Status observers do not control retries. */ }
      }
    } finally {
      this.polling = false;
      if (!this.disposed && this.subscriptions.size > 0 && !this.streaming) this.schedule(Math.min(120_000, this.pollIntervalMs * 2 ** this.failures));
    }
  }
}
