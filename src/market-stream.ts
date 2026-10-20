import type { Quote } from "gloomberb/types/financials";
import { zonedWallClockToUtcMs } from "gloomberb/utils";
import { finiteNumber, parseOptionSymbol } from "./instruments";
import { ariesTradeSession } from "./market-data";
import { AriesSocket, type AriesSocketMessage, type AriesSocketOptions } from "./socket";

export const ARIES_MARKET_SOCKET_URL = "wss://api.aries.com/v1/market/ws";

/** Only the fields a quote is built from; the snapshot's fundamentals stay on the server. */
const QUOTE_FIELDS = ["bidPrice", "bidSize", "askPrice", "askSize", "quoteTimestamp"];
const TRADE_FIELDS = ["price", "lastPrice", "totalVolume", "openPrice", "highPrice", "lowPrice", "closePrice", "netChange", "tradeTimestamp"];
const OPTION_QUOTE_FIELDS = [...QUOTE_FIELDS, "openInterest"];
/** While the socket is up, an unchanged quote is delivered again this often, so a freshness window sees a live subscription. */
const HOLD_MS = 60_000;
/** A symbol no subscriber holds any more leaves the socket after this, so a re-subscription does not churn it. */
const RELEASE_MS = 2_000;
/** With nothing subscribed for this long, the socket closes. */
const IDLE_CLOSE_MS = 60_000;

type Fields = Record<string, unknown>;
type Session = "PRE" | "REGULAR" | "POST" | "CLOSED";

interface SymbolState {
  holders: number;
  option: boolean;
  fields: Fields;
  quote?: Quote;
  deliveredAt: number;
  releaseTimer?: ReturnType<typeof setTimeout>;
}

const record = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
// Pushed changes can carry binary float noise ("price": 340.46000000000004); prices keep six places.
const round = (value: number) => Math.round(value * 1e6) / 1e6;
const positive = (value: unknown): number | undefined => {
  const number = finiteNumber(value);
  return number !== undefined && number > 0 ? round(number) : undefined;
};
const nonnegative = (value: unknown): number | undefined => {
  const number = finiteNumber(value);
  return number !== undefined && number >= 0 ? round(number) : undefined;
};
/**
 * Aries stamps updates as ISO strings with the New York offset. An option's snapshot frame gives epoch
 * milliseconds of the New York wall clock read as UTC, four or five hours behind the update that follows it.
 */
function stamp(value: unknown): number | undefined {
  const number = finiteNumber(value);
  const time = number !== undefined ? newYorkWallClock(number) : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > Date.UTC(2000, 0, 1) ? time : undefined;
}

function newYorkWallClock(wall: number): number {
  if (!Number.isFinite(wall)) return NaN;
  const at = new Date(wall);
  return zonedWallClockToUtcMs("America/New_York", at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate(),
    at.getUTCHours(), at.getUTCMinutes(), at.getUTCSeconds(), at.getUTCMilliseconds());
}

/** The exchange session Aries says is in progress, from its marketStatus event. */
export function ariesMarketSession(data: unknown): Session | undefined {
  const status = record(data);
  if (status.earlyHours === true) return "PRE";
  if (status.afterHours === true) return "POST";
  if (status.market === "open") return "REGULAR";
  if (status.market === "closed") return "CLOSED";
  return undefined;
}

/**
 * A quote from the fields Aries has pushed for a symbol so far. Equity
 * `netChange` is against the last regular close (in pre-market, yesterday's),
 * so the previous close is `price - netChange`. An option's `netChange` can
 * still be the previous session's, so its move is against `closePrice`, as
 * the REST option quote reads it.
 */
export function ariesStreamQuote(symbol: string, fields: Fields, option: boolean, session: Session | undefined, receivedAt: number): Quote | null {
  const tradeTime = stamp(fields.tradeTimestamp), quoteTime = stamp(fields.quoteTimestamp);
  const bid = nonnegative(fields.bidPrice), ask = nonnegative(fields.askPrice);
  const times = [tradeTime, quoteTime].filter((value): value is number => value !== undefined && value <= receivedAt + 60_000);
  if (!times.length) return null;
  const base = {
    symbol, providerId: "aries", currency: "USD", priceBasis: "per-unit" as const,
    bid, ask, bidSize: nonnegative(fields.bidSize), askSize: nonnegative(fields.askSize),
    lastUpdated: Math.max(...times), receivedAt, delivery: "stream" as const, dataSource: "live" as const,
    // The socket vouches that this is the current market even when the last trade is old (an option before the
    // open): the host counts only quotes that say so as live, as in the options chain's real-time coverage.
    stale: false,
  };
  if (option) {
    const last = positive(fields.lastPrice);
    const mark = bid !== undefined && ask !== undefined && ask >= bid && ask > 0 ? round((bid + ask) / 2) : undefined;
    const price = last ?? mark;
    if (price === undefined) return null;
    const previousClose = positive(fields.closePrice);
    const change = previousClose !== undefined ? round(price - previousClose) : 0;
    return {
      ...base, instrumentType: "OPTION", price, mark, previousClose, change, changePercent: previousClose ? change / previousClose * 100 : 0,
      ...(last !== undefined && tradeTime !== undefined ? { lastTradePrice: last, lastTradeTime: tradeTime } : {}),
      volume: nonnegative(fields.totalVolume), sessionConfidence: "unknown",
    };
  }
  const price = positive(fields.price) ?? positive(fields.lastPrice);
  if (price === undefined) return null;
  const netChange = finiteNumber(fields.netChange);
  const previousClose = netChange !== undefined && price - netChange > 0 ? round(price - netChange) : undefined;
  const change = previousClose !== undefined ? round(price - previousClose) : 0;
  const changePercent = previousClose ? change / previousClose * 100 : 0;
  const print = tradeTime !== undefined ? ariesTradeSession(tradeTime) : undefined;
  const marketState = session ?? print;
  const extended = marketState === "PRE" || marketState === "POST";
  // The day's open, high and low are the regular session's; before the open they are still yesterday's.
  const dayRange = marketState === "REGULAR" || marketState === "POST";
  return {
    ...base, price, previousClose, change, changePercent, volume: nonnegative(fields.totalVolume),
    ...(tradeTime !== undefined ? { lastTradePrice: price, lastTradeTime: tradeTime } : {}),
    ...(dayRange ? { open: positive(fields.openPrice), high: positive(fields.highPrice), low: positive(fields.lowPrice) } : {}),
    marketState, sessionConfidence: session ? "explicit" : print ? "derived" : "unknown",
    ...(extended ? { extendedSessionPrint: print === marketState } : {}),
    ...(marketState === "PRE" && print === "PRE" ? { preMarketPrice: price, preMarketChange: change, preMarketChangePercent: changePercent } : {}),
    ...(marketState === "POST" && print === "POST" ? { postMarketPrice: price } : {}),
  };
}

export interface AriesMarketStreamOptions extends Pick<AriesSocketOptions, "token" | "connect" | "now" | "setTimer" | "clearTimer" | "random"> {
  onQuote(symbol: string, quote: Quote): void;
  onLive(live: boolean): void;
}

/**
 * The Aries market socket for one profile, shared by every subscriber: each
 * symbol is subscribed once, however many panes ask for it, and leaves the
 * socket when the last one lets go. Aries pushes partial updates, so the
 * fields seen so far are kept per subscribed symbol to build whole quotes.
 */
export class AriesMarketStream {
  private readonly symbols = new Map<string, SymbolState>();
  private readonly socket: AriesSocket;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<AriesSocketOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<AriesSocketOptions["clearTimer"]>;
  private session?: Session;
  private pendingAdd = new Set<string>();
  private pendingRemove = new Set<string>();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private holdTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private readonly options: AriesMarketStreamOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.socket = new AriesSocket({
      url: ARIES_MARKET_SOCKET_URL, token: options.token, connect: options.connect, now: options.now,
      setTimer: options.setTimer, clearTimer: options.clearTimer, random: options.random,
      onReady: (send) => {
        this.pendingAdd.clear();
        this.pendingRemove.clear();
        const items = [...this.symbols].map(([symbol, state]) => this.item(symbol, state.option));
        for (let index = 0; index < items.length; index += 100) send({ type: "subscribe", id: this.socket.nextId("sub"), payload: items.slice(index, index + 100) });
        this.scheduleHold();
      },
      onMessage: (message) => this.receive(message),
      onLive: (live) => {
        if (!live && this.holdTimer !== undefined) { this.clearTimer(this.holdTimer); this.holdTimer = undefined; }
        options.onLive(live);
      },
    });
  }

  get live(): boolean { return this.socket.live; }

  /** The latest whole quote pushed for a symbol this stream holds. */
  current(symbol: string): Quote | undefined { return this.symbols.get(symbol)?.quote; }

  retain(symbol: string): void {
    if (this.disposed) return;
    const existing = this.symbols.get(symbol);
    if (existing) {
      existing.holders++;
      if (existing.releaseTimer !== undefined) { this.clearTimer(existing.releaseTimer); existing.releaseTimer = undefined; }
      return;
    }
    this.symbols.set(symbol, { holders: 1, option: !!parseOptionSymbol(symbol), fields: {}, deliveredAt: 0 });
    if (this.idleTimer !== undefined) { this.clearTimer(this.idleTimer); this.idleTimer = undefined; }
    this.pendingRemove.delete(symbol);
    this.pendingAdd.add(symbol);
    this.socket.start();
    this.scheduleFlush();
  }

  release(symbol: string): void {
    const state = this.symbols.get(symbol);
    if (!state || --state.holders > 0 || state.releaseTimer !== undefined) return;
    state.releaseTimer = this.setTimer(() => {
      state.releaseTimer = undefined;
      if (state.holders > 0 || this.symbols.get(symbol) !== state) return;
      this.symbols.delete(symbol);
      if (!this.pendingAdd.delete(symbol)) this.pendingRemove.add(symbol);
      this.scheduleFlush();
      if (!this.symbols.size && this.idleTimer === undefined) {
        this.idleTimer = this.setTimer(() => { this.idleTimer = undefined; if (!this.symbols.size) this.socket.stop(); }, IDLE_CLOSE_MS);
      }
    }, RELEASE_MS);
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of [this.flushTimer, this.holdTimer, this.idleTimer, ...[...this.symbols.values()].map((state) => state.releaseTimer)]) {
      if (timer !== undefined) this.clearTimer(timer);
    }
    this.symbols.clear();
    this.socket.stop();
  }

  private item(symbol: string, option: boolean) {
    return option
      ? { symbol, symbolType: "option", quoteFields: OPTION_QUOTE_FIELDS, tradeFields: TRADE_FIELDS }
      : { symbol, quoteFields: QUOTE_FIELDS, tradeFields: TRADE_FIELDS };
  }

  /** Subscription changes in one turn go out as one message each way. */
  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) return;
    this.flushTimer = this.setTimer(() => {
      this.flushTimer = undefined;
      if (!this.socket.live) return;
      const add = [...this.pendingAdd].filter((symbol) => this.symbols.has(symbol));
      const remove = [...this.pendingRemove].filter((symbol) => !this.symbols.has(symbol));
      this.pendingAdd.clear();
      this.pendingRemove.clear();
      if (remove.length) this.socket.send({ type: "unsubscribe", id: this.socket.nextId("unsub"), payload: remove });
      for (let index = 0; index < add.length; index += 100) {
        this.socket.send({ type: "subscribe", id: this.socket.nextId("sub"), payload: add.slice(index, index + 100).map((symbol) => this.item(symbol, this.symbols.get(symbol)!.option)) });
      }
    }, 0);
  }

  private scheduleHold(): void {
    if (this.holdTimer !== undefined) this.clearTimer(this.holdTimer);
    this.holdTimer = this.setTimer(() => {
      this.holdTimer = undefined;
      if (!this.socket.live) return;
      const now = this.now();
      for (const [symbol, state] of this.symbols) {
        if (state.quote && now - state.deliveredAt >= HOLD_MS - 5_000) this.deliver(symbol, state, { ...state.quote, receivedAt: now });
      }
      this.scheduleHold();
    }, HOLD_MS);
  }

  private deliver(symbol: string, state: SymbolState, quote: Quote): void {
    state.quote = quote;
    state.deliveredAt = quote.receivedAt ?? this.now();
    this.options.onQuote(symbol, quote);
  }

  private receive(message: AriesSocketMessage): void {
    if (message.type !== "event") return;
    const payload = record(message.payload);
    if (payload.type === "marketStatus") {
      const session = ariesMarketSession(payload.data);
      if (session && session !== this.session) {
        this.session = session;
        for (const [symbol, state] of this.symbols) this.rebuild(symbol, state);
      }
      return;
    }
    if (payload.action !== "snapshot" && payload.action !== "update") return;
    if (payload.type !== "quote" && payload.type !== "trade") return;
    const symbol = typeof payload.symbol === "string" ? payload.symbol.toUpperCase() : "";
    const state = this.symbols.get(symbol);
    if (!state) return;
    const data = record(payload.data);
    for (const [key, value] of Object.entries(data)) if (value !== null && value !== "") state.fields[key] = value;
    this.rebuild(symbol, state);
  }

  private rebuild(symbol: string, state: SymbolState): void {
    const quote = ariesStreamQuote(symbol, state.fields, state.option, this.session, this.now());
    if (quote) this.deliver(symbol, state, quote);
  }
}
