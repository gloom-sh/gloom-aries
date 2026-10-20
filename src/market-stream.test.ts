import { describe, expect, test } from "bun:test";
import type { Quote } from "gloomberb/types/financials";
import { AriesMarketData, type AriesMarketClient } from "./market-data";
import { ariesStreamQuote } from "./market-stream";
import type { AriesSocketLike } from "./socket";

/** 05:00 New York, Tuesday: pre-market. */
const NOW = Date.parse("2026-10-20T09:00:00Z");
const OPTION = "SPY261023C00766000";

function timers() {
  let now = NOW, next = 1;
  const tasks = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimer(callback: () => void, milliseconds: number) { const id = next++; tasks.set(id, { at: now + milliseconds, callback }); return id as unknown as ReturnType<typeof setTimeout>; },
    clearTimer(timer: ReturnType<typeof setTimeout>) { tasks.delete(timer as unknown as number); },
    /** Runs every timer due within the next `milliseconds`, in time order. */
    advance(milliseconds: number) {
      const end = now + milliseconds;
      for (;;) {
        const due = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        tasks.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].callback();
      }
      now = end;
    },
  };
}

class FakeSocket implements AriesSocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.({}); }
  push(...messages: unknown[]) { this.onmessage?.({ data: messages.map((message) => JSON.stringify(message)).join("\n") }); }
  drop() { this.readyState = 3; this.onclose?.({}); }
  subscribed() { return this.sent.filter((message) => message.type === "subscribe").flatMap((message) => (message.payload as { symbol: string }[]).map((item) => item.symbol)); }
}

const drain = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const signIn = async (socket: FakeSocket) => {
  socket.open();
  await drain();
  socket.push({ type: "event", payload: { action: "authSuccess", data: { expiresIn: 2_700_000 } } });
};
const trade = (symbol: string, data: Record<string, unknown>) => ({ type: "event", payload: { action: "update", type: "trade", symbol, data } });

function setup(rest: (symbols: string) => unknown = () => ({ s: "ok", d: [] })) {
  const clock = timers();
  const sockets: FakeSocket[] = [];
  const requests: string[] = [];
  const client: AriesMarketClient = { async get<T>(path: string, query?: Record<string, string | number | undefined>) { requests.push(path); return rest(String(query?.symbols ?? query?.ticker)) as T; } };
  const market = new AriesMarketData(client, {
    ...clock, stream: { token: async () => "synthetic-token", connect: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; }, random: () => 0 },
  });
  return { clock, sockets, requests, market };
}

describe("Aries market socket", () => {
  test("a pre-market equity print moves against yesterday's close, and an option against its own close", () => {
    const fields = { price: "339.50", lastPrice: "342.94", closePrice: "343.46", netChange: "-3.44", highPrice: "346", tradeTimestamp: "2026-10-20T04:54:24.831-04:00", bidPrice: "339.25", askPrice: "339.59" };
    const equity = ariesStreamQuote("AAPL", fields, false, "PRE", NOW)!;
    expect(equity).toMatchObject({ price: 339.5, previousClose: 342.94, change: -3.44, marketState: "PRE", sessionConfidence: "explicit", preMarketPrice: 339.5, extendedSessionPrint: true, delivery: "stream", dataSource: "live" });
    // Before the open, the day's high is still yesterday's.
    expect(equity.high).toBeUndefined();
    // An option's snapshot stamp is the New York wall clock read as UTC: 04:59 in New York is 08:59 UTC.
    const option = ariesStreamQuote(OPTION, { lastPrice: 5.48, closePrice: 5.48, netChange: 0.97, bidPrice: 5.41, askPrice: 5.46, quoteTimestamp: Date.parse("2026-10-20T04:59:00Z") }, true, "PRE", NOW)!;
    expect(option).toMatchObject({ price: 5.48, previousClose: 5.48, change: 0, mark: 5.435, lastUpdated: NOW - 60_000, instrumentType: "OPTION" });
    expect(option.marketState).toBeUndefined();
  });

  test("shared symbols are subscribed once, a re-subscription does not churn the socket, and a reconnect resubscribes after backoff", async () => {
    const { clock, sockets, market } = setup();
    const quotes: [string, Quote][] = [];
    const offA = market.subscribeQuotes([{ symbol: "AAPL" }], (target, quote) => quotes.push([target.symbol, quote]));
    const offB = market.subscribeQuotes([{ symbol: "AAPL" }, { symbol: OPTION, exchange: "OPTIONS" }], (target, quote) => quotes.push([target.symbol, quote]));
    expect(sockets).toHaveLength(1);
    await signIn(sockets[0]!);
    clock.advance(0);
    expect(sockets[0]!.subscribed()).toEqual(["AAPL", OPTION]);
    sockets[0]!.push(trade("AAPL", { price: "340", netChange: "-2.94", tradeTimestamp: "2026-10-20T04:59:00-04:00" }));
    expect(quotes.map(([symbol]) => symbol)).toEqual(["AAPL", "AAPL"]);
    // The router opens the new target set before closing the old: nothing leaves the socket.
    const offC = market.subscribeQuotes([{ symbol: "AAPL" }], (target, quote) => quotes.push([target.symbol, quote]));
    expect(quotes).toHaveLength(3);
    offA();
    clock.advance(5_000);
    expect(sockets[0]!.sent.filter((message) => message.type === "unsubscribe")).toEqual([]);
    offB();
    clock.advance(5_000);
    expect(sockets[0]!.sent.filter((message) => message.type === "unsubscribe").map((message) => message.payload)).toEqual([[OPTION]]);
    sockets[0]!.drop();
    clock.advance(999);
    expect(sockets).toHaveLength(1);
    clock.advance(1);
    expect(sockets).toHaveLength(2);
    await signIn(sockets[1]!);
    expect(sockets[1]!.subscribed()).toEqual(["AAPL"]);
    offC();
    market.dispose();
  });

  test("REST stands in only while the socket is down", async () => {
    const { clock, sockets, requests, market } = setup((symbols) => ({ s: "ok", d: symbols.split(",").map((s) => ({ s, v: { lp: 100, prev_close_price: 99 } })) }));
    const off = market.subscribeQuotes([{ symbol: "AAPL" }], () => {});
    await signIn(sockets[0]!);
    clock.advance(60_000);
    expect(requests).toEqual([]);
    sockets[0]!.drop();
    clock.advance(1_000);
    // The reconnect has not signed in yet: after the grace period REST polls.
    clock.advance(4_000);
    await drain();
    expect(requests).toContain("/v1/chart/quotes");
    const polled = requests.length;
    await signIn(sockets[1]!);
    clock.advance(60_000);
    await drain();
    expect(requests).toHaveLength(polled);
    off();
    market.dispose();
  });
});
