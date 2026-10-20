import type { BrokerAdapter, BrokerConnectionStatus } from "gloomberb/types/broker";
import type { BrokerInstanceConfig } from "gloomberb/types/config";
import type { PricePoint } from "gloomberb/types/financials";
import type { BrokerContractRef } from "gloomberb/types/instrument";
import type { ManualChartResolution, TimeRange } from "gloomberb/time-series";
import { AriesAccounts } from "./accounts";
import { AriesClient, AriesError, type AriesFetch, type AriesTransport } from "./client";
import { ARIES_CONFIG_FIELDS, ariesConfig } from "./config";
import { AriesMarketData, ARIES_CHART_RESOLUTIONS, ARIES_CHART_RESOLUTION_SUPPORT } from "./market-data";
import { AriesOrderStream, type AriesOrderListener } from "./order-stream";
import { AriesOrderService, ariesOrderCapabilities } from "./orders";

interface Session {
  config: ReturnType<typeof ariesConfig>;
  client: AriesClient;
  accounts: AriesAccounts;
  market: AriesMarketData;
  orders: AriesOrderService;
  orderStream: AriesOrderStream;
  assertCurrent(): void;
}

/** The host's BrokerHistoryOptions, which older hosts do not declare. */
export interface AriesHistoryOptions { session?: "extended" }

/** History with a session choice for the market provider, which reads it from the chart's request context. */
export interface AriesSessionHistory {
  getPriceHistoryForResolution(ticker: string, instance: BrokerInstanceConfig, range: TimeRange, resolution: ManualChartResolution, instrument?: BrokerContractRef | null, session?: "extended"): Promise<PricePoint[]>;
  getDetailedPriceHistory(ticker: string, instance: BrokerInstanceConfig, startDate: Date, endDate: Date, barSize: string, instrument?: BrokerContractRef | null, session?: "extended"): Promise<PricePoint[]>;
}

/**
 * Only a failed sign-in or a changed profile disconnects. A rate limit, a
 * server hiccup or one instrument without data leaves a connected profile
 * connected, so an order ticket does not flip to "disconnected" mid-order.
 * Each request still reports its own failure.
 */
export class AriesSessionError extends Error {}
const DELAYED_NOTICE = "Delayed quotes; source time shown when available";
const STREAM_NOTICE = "Real-time quotes";
const disconnects = (error: unknown) => error instanceof AriesSessionError || error instanceof AriesError && (error.status === 401 || error.status === 403);

/** The host's order stream, which hosts from before it do not declare. */
export interface AriesOrderStreaming {
  subscribeOrders(instance: BrokerInstanceConfig, listener: AriesOrderListener): () => void;
}

export interface AriesBrokerOptions {
  fetch?: AriesFetch;
  assertLocal?: () => void;
  getInstance?: (id: string) => BrokerInstanceConfig | undefined;
  /** Stream quotes and order changes over Aries' WebSockets (default). Off, quotes poll REST and the host polls orders. */
  sockets?: boolean;
}

export function createAriesBroker(options: AriesBrokerOptions = {}): BrokerAdapter & AriesOrderStreaming & { dispose(): void; history: AriesSessionHistory; extendedHoursHistory: boolean } {
  const sessions = new Map<string, Session>();
  const statuses = new Map<string, BrokerConnectionStatus>();
  const listeners = new Map<string, Set<() => void>>();
  const status = (instance: BrokerInstanceConfig, state: BrokerConnectionStatus["state"], message?: string) => {
    // The market socket is real-time, so the session is. While it is down, REST stands in and each of
    // those quotes says it is delayed; the session's entitlement does not flip with the socket.
    const streaming = sessions.get(instance.id)?.market.streaming === true;
    const quoteNotice = message === undefined || message === DELAYED_NOTICE || message.startsWith("Quote source time unavailable");
    const notice = streaming && quoteNotice && state === "connected" ? STREAM_NOTICE : message;
    statuses.set(instance.id, { state, message: notice, mode: ariesConfig(instance.config).enableTrading ? "Trading enabled" : "Read only", quoteData: sockets ? "realtime" : "delayed", updatedAt: Date.now() });
    for (const listener of listeners.get(instance.id) ?? []) listener();
  };
  const sockets = options.sockets ?? true;
  const local = () => {
    if (!options.assertLocal) throw new AriesSessionError("Aries requires a dedicated local profile with Gloom Cloud disabled.");
    try { options.assertLocal(); } catch (error) { throw new AriesSessionError(error instanceof Error ? error.message : "Aries requires a dedicated local profile with Gloom Cloud disabled."); }
  };
  const session = (instance: BrokerInstanceConfig): Session => {
    local();
    const config = ariesConfig(instance.config);
    if (!config.clientToken.startsWith("ARI-PERSONAL-TK.") || !config.clientSecret) throw new Error("Enter your Aries personal client ID and client secret.");
    const old = sessions.get(instance.id);
    if (old && Object.keys(config).every((key) => config[key as keyof typeof config] === old.config[key as keyof typeof config])) return old;
    if (old) { old.market.dispose(); old.orderStream.dispose(); old.client.dispose(); sessions.delete(instance.id); }
    const current = () => options.getInstance ? options.getInstance(instance.id) : instance;
    const assertCurrent = () => {
      local();
      const latest = current();
      if (!latest || latest.enabled === false || Object.keys(config).some((key) => config[key as keyof typeof config] !== ariesConfig(latest.config)[key as keyof typeof config])) {
        throw new AriesSessionError("Aries profile changed. Reconnect before continuing.");
      }
    };
    const client = new AriesClient({ ...config, fetch: options.fetch, assertActive: assertCurrent });
    const transport: AriesTransport = {
      get: (path, query) => { local(); return client.get(path, query); },
      post: (path, body) => { local(); return client.post(path, body); },
    };
    const accounts = new AriesAccounts(transport, config.accounts, instance.id);
    // Both sockets sign in with the session's own token and stop with it.
    const token = () => { local(); return client.socketToken(); };
    const market = new AriesMarketData(transport, {
      onError: (error) => {
        if (sessions.get(instance.id)?.client !== client) return;
        status(instance, statuses.get(instance.id)?.state === "connected" && !disconnects(error) ? "connected" : "error", error.message);
      },
      onSuccess: (notice) => { if (sessions.get(instance.id)?.client === client) status(instance, "connected", notice ?? DELAYED_NOTICE); },
      ...(sockets ? { stream: { token } } : {}),
      onStream: () => {
        if (sessions.get(instance.id)?.client !== client || statuses.get(instance.id)?.state !== "connected") return;
        status(instance, "connected", DELAYED_NOTICE);
      },
    });
    const orders = new AriesOrderService(transport, {
      accounts: () => accounts.list(true), tradingEnabled: () => { assertCurrent(); return config.enableTrading; }, brokerInstanceId: instance.id,
      optionPositions: async (accountId) => {
        const account = (await accounts.list()).find((item) => item.accountId === accountId);
        if (!account) throw new Error("Select an included Aries account.");
        return (await accounts.positionsFor(account)).filter((position) => position.assetCategory === "OPT").map((position) => ({ symbol: position.ticker, quantity: position.shares * (position.side === "short" ? -1 : 1) }));
      },
    });
    const orderStream = new AriesOrderStream({
      token, accounts: () => accounts.list(true),
      apply: (row, account) => sessions.get(instance.id)?.client === client ? orders.applyPushedOrder(row, account) : undefined,
    });
    const result = { config, client, accounts, market, orders, orderStream, assertCurrent };
    sessions.set(instance.id, result);
    return result;
  };
  const run = async <T>(instance: BrokerInstanceConfig, action: (value: Session) => Promise<T>): Promise<T> => {
    let active: Session | undefined;
    try {
      active = session(instance);
      const value = await action(active);
      if (sessions.get(instance.id) !== active) throw new AriesSessionError("Aries connection changed. Reconnect before continuing.");
      active.assertCurrent();
      status(instance, "connected", active.market.getQuoteNotice() ?? DELAYED_NOTICE);
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Aries request failed.";
      const keep = !!active && !disconnects(error) && statuses.get(instance.id)?.state === "connected";
      if (!keep && (!active || sessions.get(instance.id) === active)) status(instance, "error", message);
      throw error;
    }
  };
  return {
    id: "aries", name: "Aries", configSchema: ARIES_CONFIG_FIELDS,
    async validate(instance) { const config = ariesConfig(instance.config); return config.clientToken.startsWith("ARI-PERSONAL-TK.") && !!config.clientSecret; },
    async connect(instance) {
      // Reconnecting a connected profile keeps it usable until the answer.
      if (statuses.get(instance.id)?.state !== "connected") status(instance, "connecting", "Connecting to Aries");
      await run(instance, async (s) => {
        if (!(await s.accounts.list(true)).length) throw new Error("No Aries accounts match this profile. Change Include accounts.");
      });
    },
    async disconnect(instance) {
      const s = sessions.get(instance.id);
      s?.market.dispose(); s?.orderStream.dispose(); s?.client.dispose(); sessions.delete(instance.id);
      status(instance, "disconnected");
    },
    getStatus: (instance) => statuses.get(instance.id) ?? { state: "disconnected", quoteData: sockets ? "realtime" : "delayed", updatedAt: 0 },
    subscribeStatus(instance, listener) {
      const set = listeners.get(instance.id) ?? new Set(); set.add(listener); listeners.set(instance.id, set);
      return () => { set.delete(listener); if (!set.size) listeners.delete(instance.id); };
    },
    importPositions: (instance) => run(instance, (s) => s.accounts.positions()),
    importPortfolioSnapshot: (instance) => run(instance, async (s) => ({ accounts: await s.accounts.balances(), positions: await s.accounts.positions() })),
    listAccounts: (instance) => run(instance, (s) => s.accounts.balances()),
    describeInstance: (instance) => ({ brokerName: "Aries", method: ariesConfig(instance.config).enableTrading ? "Trading enabled" : "Read only" }),
    searchInstruments: (query, instance) => run(instance, (s) => s.market.searchInstruments(query, instance.id)),
    getQuote: (ticker, instance, _exchange, instrument) => run(instance, (s) => s.market.getQuote(ticker, instrument)),
    getPriceHistory: (ticker, instance, _exchange, range, instrument) => run(instance, (s) => s.market.getPriceHistory(ticker, range, instrument)),
    // A host that knows extendedHoursHistory passes the chart's Ext hours as a last argument; an older host passes nothing.
    extendedHoursHistory: true,
    getPriceHistoryForResolution: (ticker, instance, _exchange, range, resolution, instrument, options?: AriesHistoryOptions) => run(instance, (s) => s.market.getPriceHistoryForResolution(ticker, range, resolution, instrument, options?.session)),
    getDetailedPriceHistory: (ticker, instance, _exchange, start, end, bar, instrument, options?: AriesHistoryOptions) => run(instance, (s) => s.market.getDetailedPriceHistory(ticker, start, end, bar, instrument, options?.session)),
    getChartResolutionCapabilities: () => ARIES_CHART_RESOLUTIONS,
    getChartResolutionSupport: () => ARIES_CHART_RESOLUTION_SUPPORT,
    getOptionsChain: (ticker, instance, _exchange, expiration) => run(instance, (s) => s.market.getOptionsChain(ticker, expiration)),
    // What the adapter can do, not whether this process holds the session: the desktop app asks in its view,
    // while the session lives in the backend. The host checks the connection itself.
    canStreamQuotes: () => sockets,
    subscribeQuotes(instance, targets, onQuote) {
      if (!targets.length) return () => {};
      try { return session(instance).market.subscribeQuotes(targets, onQuote); }
      catch (error) { status(instance, "error", error instanceof Error ? error.message : "Aries quotes unavailable."); return () => {}; }
    },
    // Order changes as Aries pushes them on the account socket, for the host's app-wide order feed.
    subscribeOrders(instance, listener) {
      if (!sockets) { try { listener.live?.(false); } catch { /* The host polls. */ } return () => {}; }
      try { return session(instance).orderStream.subscribe(listener); }
      catch { try { listener.live?.(false); } catch { /* The host polls. */ } return () => {}; }
    },
    listOpenOrders: (instance) => run(instance, (s) => s.orders.listOpenOrders()),
    getOrderStatus: (instance, orderId) => run(instance, (s) => s.orders.getOrderStatus(orderId)),
    listExecutions: (instance) => run(instance, (s) => s.orders.listExecutions()),
    getTradingCapabilities(instance, contract) {
      const capabilities = ariesOrderCapabilities(contract, instance.id);
      if (instance.enabled === false) return { ...capabilities, enabled: false, disabledReason: "Enable and connect this Aries profile before trading." };
      if (!ariesConfig(instance.config).enableTrading) return { ...capabilities, enabled: false, disabledReason: "Trading is off. Enable trading for this Aries profile before continuing." };
      return capabilities;
    },
    getTradingConfigUpdate: (_instance, enabled) => ({ enableTrading: enabled }),
    previewOrder: (instance, request) => run(instance, (s) => s.orders.previewOrder(request)),
    placeOrder: (instance, request) => run(instance, (s) => s.orders.placeOrder(request)),
    modifyOrder: (instance, orderId, request) => run(instance, (s) => s.orders.modifyOrder(orderId, request)),
    cancelOrder: (instance, orderId) => run(instance, (s) => s.orders.cancelOrder(orderId)),
    history: {
      getPriceHistoryForResolution: (ticker, instance, range, resolution, instrument, session) => run(instance, (s) => s.market.getPriceHistoryForResolution(ticker, range, resolution, instrument, session)),
      getDetailedPriceHistory: (ticker, instance, start, end, bar, instrument, session) => run(instance, (s) => s.market.getDetailedPriceHistory(ticker, start, end, bar, instrument, session)),
    },
    dispose() { for (const s of sessions.values()) { s.market.dispose(); s.orderStream.dispose(); s.client.dispose(); } sessions.clear(); statuses.clear(); listeners.clear(); },
  };
}

let assertRuntimeLocal: () => void = () => { throw new Error("Open Aries in a dedicated local profile with Gloom Cloud disabled."); };
let runtimeInstance: (id: string) => BrokerInstanceConfig | undefined = () => undefined;
export function setAriesLocalGuard(guard: () => void, getInstance?: (id: string) => BrokerInstanceConfig | undefined): void {
  assertRuntimeLocal = guard;
  runtimeInstance = getInstance ?? (() => undefined);
}
export const ariesBroker = createAriesBroker({ assertLocal: () => assertRuntimeLocal(), getInstance: (id) => runtimeInstance(id) });
