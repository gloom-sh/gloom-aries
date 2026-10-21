import { afterEach, describe, expect, test } from "bun:test";
import type { BrokerInstanceConfig } from "gloomberb/types/config";
import type { BrokerOrderRequest } from "gloomberb/types/trading";
import { createAriesBroker } from "./broker-adapter";
import type { AriesFetch } from "./client";

const syntheticAccounts = [
  { id: 11, trading_account_id: "SYNTH-LIVE-ACCOUNT", is_sim: false, account_type: "INDIVIDUAL", account_class: "CASH", status: "OPEN" },
  { id: 22, trading_account_id: "SYNTH-SIM-ACCOUNT", is_sim: true, account_type: "INDIVIDUAL", account_class: "MARGIN", status: "OPEN" },
];
const profile = (config: Record<string, unknown> = {}): BrokerInstanceConfig => ({
  id: "synthetic-profile", brokerType: "aries", label: "Aries test",
  config: { clientToken: "ARI-PERSONAL-TK.synthetic-client", clientSecret: "synthetic-secret", ...config },
});
const order = (accountId?: string): BrokerOrderRequest => ({
  brokerInstanceId: "synthetic-profile", accountId,
  contract: { brokerId: "aries", brokerInstanceId: "synthetic-profile", symbol: "AAPL", secType: "STK", currency: "USD" },
  action: "BUY", orderType: "LMT", quantity: 1, limitPrice: 100, tif: "DAY",
});
const json = (value: unknown, status = 200) => Response.json(value, { status });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
interface Call { path: string; method: string; body?: unknown; init?: RequestInit; query?: URLSearchParams }
const brokers: ReturnType<typeof createAriesBroker>[] = [];
afterEach(() => { for (const broker of brokers.splice(0)) broker.dispose(); });

function setup(options: {
  assertLocal?: () => void;
  getInstance?: (id: string) => BrokerInstanceConfig | undefined;
  response?: (call: Call) => Response | undefined | Promise<Response | undefined>;
} = {}) {
  const calls: Call[] = [];
  const fetch: AriesFetch = async (url, init) => {
    const path = new URL(url).pathname;
    const call: Call = { path, method: init?.method ?? "GET", init, query: new URL(url).searchParams };
    if (call.method === "POST" && !path.endsWith("/token")) call.body = JSON.parse(String(init?.body));
    calls.push(call);
    const override = await options.response?.(call);
    if (override) return override;
    if (path.endsWith("/token")) return json({ access_token: "synthetic-bearer", expires_in: 900 });
    if (path === "/v2/users/me/accounts") return json({ accounts: syntheticAccounts });
    if (path.endsWith("/balance")) return json({ balance: "1000.25", cashBalance: "900", netBuyingPower: "1800" });
    if (path.endsWith("/positions")) return json({ positions: [] });
    if (path.endsWith("/preview")) return json({ commission: "0", estimatedCost: "100" });
    if (path === "/v1/orders") return json({ success: true, clOrdId: "synthetic-new-order", status: "NEW", cumQty: "0", leavesQty: "1" });
    if (path.endsWith("/orders")) return json({ orders: [], nextCursor: 0 });
    if (path === "/v1/chart/quotes") return json({ s: "ok", d: [{ s: "ok", n: "AAPL", v: { lp: 100, prev_close_price: 99, ch: 1, chp: 1, volume: 1000 } }] });
    return json({});
  };
  const broker = createAriesBroker({ fetch, sockets: false, assertLocal: options.assertLocal ?? (() => {}), ...(options.getInstance ? { getInstance: options.getInstance } : {}) });
  brokers.push(broker);
  return { broker, calls };
}

describe("Aries adapter integration with synthetic transport", () => {
  test("shared ticket capabilities and consent are synchronous and start disabled", () => {
    const { broker, calls } = setup();
    const instance = profile();
    const initialConfig = { ...instance.config };
    expect(broker.getTradingCapabilities!(instance, order().contract)).toMatchObject({
      enabled: false, orderTypes: ["MKT", "LMT", "STP", "STP LMT"], executionKind: "order-summaries",
    });
    expect(broker.getTradingCapabilities!(instance).disabledReason).toContain("Trading is off");
    const enable = broker.getTradingConfigUpdate!(instance, true);
    expect(enable).toEqual({ enableTrading: true });
    expect(instance.config).toEqual(initialConfig);
    const updated = { ...instance, config: { ...instance.config, ...enable } };
    // Simulation does not run extended-hours orders; a profile that can reach a live account offers them.
    expect(broker.getTradingCapabilities!(updated, order().contract)).toMatchObject({
      enabled: true, fractionalQuantity: true, shortSelling: false, extendedHours: false, extendedHoursTif: [], priceDecimals: 5, modify: true, cancel: true,
    });
    expect(broker.getTradingCapabilities!(updated, order().contract).tif).not.toContain("EXTENDED_HOURS");
    expect(broker.getTradingCapabilities!({ ...updated, config: { ...updated.config, accounts: "both" } }, order().contract)).toMatchObject({
      extendedHours: true, extendedHoursTif: ["DAY", "EXTENDED_HOURS"],
    });
    expect(broker.getTradingCapabilities!({ ...updated, enabled: false }).enabled).toBe(false);
    expect(broker.getTradingConfigUpdate!(updated, false)).toEqual({ enableTrading: false });
    expect(calls).toHaveLength(0);
  });

  test("shared ticket option capabilities match request limits and invalid contracts stay disabled", () => {
    const { broker, calls } = setup();
    const instance = profile({ enableTrading: "true" });
    const contract = { brokerId: "aries", symbol: "AAPL270115C00150000", secType: "OPT", multiplier: "100" };
    expect(broker.getTradingCapabilities!(instance, contract)).toMatchObject({
      enabled: true, tif: ["DAY", "GTC"], fractionalQuantity: false, minQuantity: 1,
      quantityStep: 1, extendedHours: false, extendedHoursTif: [],
    });
    for (const invalid of [
      { ...contract, multiplier: "10" }, { ...contract, secType: "BAG" }, { ...contract, currency: "EUR" },
      { ...contract, brokerId: "other" }, { ...contract, brokerInstanceId: "other-profile" },
      { ...contract, symbol: "AAPL" },
    ]) expect(broker.getTradingCapabilities!(instance, invalid)).toMatchObject({ enabled: false, orderTypes: [], tif: [] });
    expect(calls).toHaveLength(0);
  });

  test("every declared order type and TIF reaches a matching synthetic preview", async () => {
    const { broker, calls } = setup();
    const instance = profile({ enableTrading: true });
    for (const contract of [order().contract, { brokerId: "aries", symbol: "AAPL270115C00150000", secType: "OPT", multiplier: "100" }]) {
      const caps = broker.getTradingCapabilities!(instance, contract);
      for (const orderType of caps.orderTypes) for (const tif of caps.tif) {
        const request = { ...order("SYNTH-SIM-ACCOUNT"), contract, orderType, tif,
          limitPrice: ["LMT", "STP LMT"].includes(orderType) ? 100 : undefined,
          stopPrice: ["STP", "STP LMT"].includes(orderType) ? 99 : undefined,
          quantity: caps.fractionalQuantity ? 1.25 : 1,
        };
        await broker.previewOrder!(instance, request);
        expect(calls.at(-1)?.body).toMatchObject({ timeInForce: tif, qty: String(request.quantity) });
      }
    }
    expect(calls.filter((call) => call.path === "/v1/orders")).toHaveLength(0);
  });

  test("default trading off blocks all mutations before even exchanging a token", async () => {
    const { broker, calls } = setup();
    const instance = profile();
    for (const action of [
      () => broker.previewOrder!(instance, order("SYNTH-SIM-ACCOUNT")),
      () => broker.placeOrder!(instance, order("SYNTH-SIM-ACCOUNT")),
      () => broker.modifyOrder!(instance, 100, order("SYNTH-SIM-ACCOUNT")),
      () => broker.cancelOrder!(instance, 100),
    ]) await expect(action()).rejects.toThrow("Trading is disabled");
    expect(calls).toHaveLength(0);
  });

  test("simulation default does not fetch live holdings or expose IDs in labels", async () => {
    const { broker, calls } = setup();
    const instance = profile();
    const snapshot = await broker.importPortfolioSnapshot!(instance);
    expect(snapshot.accounts).toHaveLength(1);
    expect(snapshot.accounts[0]?.accountId).toBe("SYNTH-SIM-ACCOUNT");
    expect(snapshot.accounts[0]?.name).toContain("simulation");
    expect(snapshot.accounts[0]?.tradingMode).toBe("simulation");
    expect(snapshot.accounts[0]?.name).not.toContain("SYNTH");
    expect(calls.some((call) => call.path.includes("LIVE-ACCOUNT"))).toBe(false);
    expect(broker.getStatus!(instance)).toMatchObject({ state: "connected", quoteData: "delayed", mode: "Read only" });
  });

  test("both-account mode still requires explicit selection and labels previews", async () => {
    const { broker, calls } = setup();
    const instance = profile({ enableTrading: true, accounts: "both" });
    await expect(broker.previewOrder!(instance, order())).rejects.toThrow("explicitly");
    expect(calls).toHaveLength(0);
    expect((await broker.listAccounts!(instance)).map((account) => account.tradingMode)).toEqual(["live", "simulation"]);
    const sim = await broker.previewOrder!(instance, order("SYNTH-SIM-ACCOUNT"));
    const live = await broker.previewOrder!(instance, order("SYNTH-LIVE-ACCOUNT"));
    expect(sim.warningText).toContain("Simulation account");
    expect(live.warningText).toContain("LIVE account");
    expect(calls.filter((call) => call.path === "/v1/orders/preview").map((call) => (call.body as Record<string, unknown>).tradingAccountId)).toEqual(["SYNTH-SIM-ACCOUNT", "SYNTH-LIVE-ACCOUNT"]);
  });

  test("changing credentials replaces token session and status subscriptions unsubscribe", async () => {
    const { broker, calls } = setup();
    const instance = profile();
    const transitions: string[] = [];
    const unsubscribe = broker.subscribeStatus!(instance, () => transitions.push(broker.getStatus!(instance).state));
    await broker.connect!(instance);
    expect(transitions).toEqual(["connecting", "connected"]);
    instance.config.clientSecret = "synthetic-replacement-secret";
    await broker.connect!(instance);
    const exchanges = calls.filter((call) => call.path.endsWith("/token"));
    expect(exchanges).toHaveLength(2);
    expect(new URLSearchParams(String(exchanges[1]?.init?.body)).get("client_secret")).toBe("synthetic-replacement-secret");
    unsubscribe();
    await broker.disconnect!(instance);
    // Reconnecting a connected profile never shows it disconnected in between.
    expect(transitions).toEqual(["connecting", "connected", "connected"]);
    expect(broker.getStatus!(instance).state).toBe("disconnected");
  });

  test("a rate limit or one instrument's failure keeps a connected profile connected; auth failures still mark it", async () => {
    let quoteStatus = 404;
    const { broker } = setup({ response: (call) => call.path === "/v1/chart/quotes" ? json({ error: "synthetic" }, quoteStatus) : undefined });
    const instance = profile();
    await broker.connect!(instance);
    await expect(broker.getQuote!("SIVE", instance)).rejects.toThrow();
    expect(broker.getStatus!(instance).state).toBe("connected");
    quoteStatus = 500;
    await expect(broker.listOpenOrders!(instance)).resolves.toBeDefined();
    await expect(broker.getQuote!("AAPL", instance)).rejects.toThrow();
    expect(broker.getStatus!(instance).state).toBe("connected");
    quoteStatus = 403;
    await expect(broker.getQuote!("AAPL", instance)).rejects.toThrow();
    expect(broker.getStatus!(instance).state).toBe("error");
  });

  test("403 response text stays out of exceptions and status", async () => {
    const sentinel = "synthetic-secret-live-account-balance";
    const { broker } = setup({ response: (call) => call.path.endsWith("/accounts") ? json({ error: sentinel }, 403) : undefined });
    const instance = profile();
    let errorText = "";
    try { await broker.connect!(instance); } catch (error) { errorText = String(error); }
    expect(errorText).toContain("denied this request");
    expect(errorText).not.toContain(sentinel);
    expect(broker.getStatus!(instance).message).not.toContain(sentinel);
    expect(broker.getStatus!(instance).state).toBe("error");
  });

  test("unknown asset errors are fixed messages and do not expose position strings", async () => {
    const { broker } = setup({ response: (call) => call.path.endsWith("/positions") ? json({ positions: [{ symbol: "synthetic-secret", quantity: "1", securityType: "PRIVATE-ASSET" }] }) : undefined });
    const instance = profile();
    await expect(broker.importPositions(instance)).rejects.toThrow("not supported");
    expect(broker.getStatus!(instance).message).not.toContain("synthetic-secret");
    expect(broker.getStatus!(instance).state).toBe("error");
  });

  test("short option import feeds signed current quantities into close previews", async () => {
    const { broker, calls } = setup({ response: (call) => call.path.endsWith("/positions") ? json({ positions: [{
      accountId: "SYNTH-SIM-ACCOUNT", symbol: "AAPL270115C00150000", securityType: "OPTION", quantity: "-2", averagePrice: "2.5", price: "2.75", marketValue: "-550",
    }] }) : undefined });
    const instance = profile({ enableTrading: true });
    const positions = await broker.importPositions(instance);
    expect(positions[0]).toMatchObject({ shares: 2, side: "short", multiplier: 100, avgCost: 2.5, markPrice: 2.75, marketValue: -550 });
    const option = { ...order("SYNTH-SIM-ACCOUNT"), contract: positions[0]!.brokerContract!, limitPrice: 2.75 };
    const preview = await broker.previewOrder!(instance, option);
    expect(preview.warningText).toContain("Option position: close");
    const body = calls.findLast((call) => call.path.endsWith("/preview"))?.body as { legs: { positionEffect: string }[] };
    expect(body.legs[0]?.positionEffect).toBe("CLOSE");
  });

  test("position responses cannot relabel another account as simulation", async () => {
    const { broker } = setup({ response: (call) => call.path.endsWith("/positions") ? json({ positions: [{
      accountId: "SYNTH-LIVE-ACCOUNT", symbol: "AAPL", securityType: "EQUITY", quantity: "1", averagePrice: "100",
    }] }) : undefined });
    const instance = profile();
    await expect(broker.importPositions(instance)).rejects.toThrow();
    expect(broker.getStatus!(instance).message).not.toContain("SYNTH-LIVE-ACCOUNT");
  });

  test("balance responses cannot relabel another account as simulation", async () => {
    const { broker } = setup({ response: (call) => call.path.endsWith("/balance") ? json({ accountId: "SYNTH-LIVE-ACCOUNT", balance: "1000" }) : undefined });
    const instance = profile();
    await expect(broker.listAccounts!(instance)).rejects.toThrow();
    expect(broker.getStatus!(instance).message).not.toContain("SYNTH-LIVE-ACCOUNT");
  });
});

describe("Aries profile changes during pending requests", () => {
  test("Cloud enablement during token exchange blocks the following authenticated request", async () => {
    let local = true;
    const tokenStarted = deferred<void>();
    const tokenReply = deferred<Response>();
    const { broker, calls } = setup({
      assertLocal: () => { if (!local) throw new Error("Gloom Cloud must be disabled."); },
      response: (call) => { if (call.path.endsWith("/token")) { tokenStarted.resolve(); return tokenReply.promise; } },
    });
    const instance = profile();
    const connection = broker.connect!(instance);
    const result = connection.then(() => undefined, (error: unknown) => error);
    await tokenStarted.promise;
    local = false;
    tokenReply.resolve(json({ access_token: "synthetic-bearer", expires_in: 900 }));
    expect(await result).toBeInstanceOf(Error);
    expect(calls.map((call) => call.path)).toEqual(["/v1/oauth2/token"]);
    expect(broker.getStatus!(instance).state).toBe("error");
  });

  test("Cloud enablement after a 401 blocks the refresh token exchange", async () => {
    let local = true;
    const { broker, calls } = setup({
      assertLocal: () => { if (!local) throw new Error("Gloom Cloud must be disabled."); },
      response: (call) => {
        if (call.path.endsWith("/accounts")) { local = false; return json({ error: "synthetic-secret" }, 401); }
      },
    });
    const instance = profile();
    await expect(broker.connect!(instance)).rejects.toThrow();
    expect(calls.filter((call) => call.path.endsWith("/token"))).toHaveLength(1);
    expect(calls.filter((call) => call.path.endsWith("/accounts"))).toHaveLength(1);
  });

  test("Cloud enablement while the final GET is pending prevents a connected result", async () => {
    let local = true;
    const started = deferred<void>();
    const reply = deferred<Response>();
    const { broker } = setup({
      assertLocal: () => { if (!local) throw new Error("Gloom Cloud must be disabled."); },
      response: (call) => { if (call.path.endsWith("/accounts")) { started.resolve(); return reply.promise; } },
    });
    const instance = profile();
    const connection = broker.connect!(instance).then(() => undefined, (error: unknown) => error);
    await started.promise;
    local = false;
    reply.resolve(json({ accounts: syntheticAccounts }));
    expect(await connection).toBeInstanceOf(Error);
    expect(broker.getStatus!(instance).state).toBe("error");
  });

  test("a config edit while the final GET is pending prevents a stale connected result", async () => {
    const instance = profile({ accounts: "both" });
    const started = deferred<void>();
    const reply = deferred<Response>();
    const { broker } = setup({ response: (call) => { if (call.path.endsWith("/accounts")) { started.resolve(); return reply.promise; } } });
    const connection = broker.connect!(instance).then(() => undefined, (error: unknown) => error);
    await started.promise;
    instance.config.accounts = "simulation";
    reply.resolve(json({ accounts: syntheticAccounts }));
    expect(await connection).toBeInstanceOf(Error);
    expect(broker.getStatus!(instance).state).toBe("error");
  });

  test("disconnect during account fetch cannot resurrect connected status", async () => {
    const started = deferred<void>();
    const reply = deferred<Response>();
    const { broker } = setup({ response: (call) => {
      if (call.path.endsWith("/accounts")) { started.resolve(); return reply.promise; }
    } });
    const instance = profile();
    const connection = broker.connect!(instance).then(() => undefined, (error: unknown) => error);
    await started.promise;
    await broker.disconnect!(instance);
    reply.resolve(json({ accounts: syntheticAccounts }));
    expect(await connection).toBeInstanceOf(Error);
    expect(broker.getStatus!(instance).state).toBe("disconnected");
  });

  test("trading toggled off during preview cannot send the placement POST", async () => {
    const instance = profile({ enableTrading: true });
    const { broker, calls } = setup({ response: (call) => {
      if (call.path.endsWith("/preview")) { instance.config.enableTrading = false; return json({ estimatedCost: "100" }); }
    } });
    await expect(broker.placeOrder!(instance, order("SYNTH-SIM-ACCOUNT"))).rejects.toThrow();
    expect(calls.some((call) => call.path === "/v1/orders")).toBe(false);
  });

  test("a removed current profile blocks the next physical request", async () => {
    let current: BrokerInstanceConfig | undefined = profile();
    const instance = current;
    const started = deferred<void>();
    const reply = deferred<Response>();
    const { broker, calls } = setup({
      getInstance: () => current,
      response: (call) => { if (call.path.endsWith("/token")) { started.resolve(); return reply.promise; } },
    });
    const connection = broker.connect!(instance).then(() => undefined, (error: unknown) => error);
    await started.promise;
    current = undefined;
    reply.resolve(json({ access_token: "synthetic-bearer", expires_in: 900 }));
    expect(await connection).toBeInstanceOf(Error);
    expect(calls.map((call) => call.path)).toEqual(["/v1/oauth2/token"]);
  });

  test("obsolete config completion cannot replace the newer connection status", async () => {
    const oldStarted = deferred<void>();
    const oldReply = deferred<Response>();
    let accountReads = 0;
    const { broker } = setup({ response: (call) => {
      if (call.path.endsWith("/accounts") && ++accountReads === 1) { oldStarted.resolve(); return oldReply.promise; }
    } });
    const old = profile();
    const oldConnection = broker.connect!(old).then(() => undefined, (error: unknown) => error);
    await oldStarted.promise;
    const next = profile({ clientSecret: "synthetic-new-secret" });
    await broker.connect!(next);
    oldReply.resolve(json({ accounts: [] }));
    expect(await oldConnection).toBeInstanceOf(Error);
    expect(broker.getStatus!(next).state).toBe("connected");
  });

  // Regression: the host could not pass Ext hours to a broker, so a linked chart showed the regular day in regular hours.
  test("a chart's Ext hours reaches the history request through the host's broker options", async () => {
    const { broker, calls } = setup({ response: (call) => call.path === "/v1/chart/history" ? json({ s: "no_data" }) : undefined });
    expect(broker.extendedHoursHistory).toBe(true);
    const start = new Date("2026-10-19T13:00:00Z"), end = new Date("2026-10-19T15:00:00Z");
    // Hosts before the options argument type these methods one argument shorter.
    type Loose = (...args: unknown[]) => Promise<unknown>;
    await (broker.getDetailedPriceHistory as Loose)("AAPL", profile(), "SMART", start, end, "15m", null, { session: "extended" });
    await (broker.getPriceHistoryForResolution as Loose)("AAPL", profile(), "SMART", "1D", "15m", null, { session: "extended" });
    const history = calls.filter((call) => call.path === "/v1/chart/history");
    expect(history.map((call) => call.query?.get("includeExtended"))).toEqual(["true", "true"]);
  });

  test("changing session stops delivery from the previous quote subscription", async () => {
    const quoteStarted = deferred<void>();
    const quoteReply = deferred<Response>();
    const { broker } = setup({ response: (call) => {
      if (call.path === "/v1/chart/quotes") { quoteStarted.resolve(); return quoteReply.promise; }
    } });
    const instance = profile();
    await broker.connect!(instance);
    let deliveries = 0;
    const unsubscribe = broker.subscribeQuotes!(instance, [{ symbol: "AAPL" }], () => { deliveries++; });
    await quoteStarted.promise;
    await broker.connect!(profile({ clientSecret: "synthetic-new-secret" }));
    quoteReply.resolve(json({ s: "ok", d: [{ s: "ok", n: "AAPL", v: { lp: 100 } }] }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deliveries).toBe(0);
    unsubscribe();
  });
});

describe("Aries account sign-in in the adapter", () => {
  function signInSetup(signIn: { authorize?: () => Promise<{ code: string; verifier: string; redirectUri: string }>; signInWaitMs?: number } = {}) {
    const authorizations: number[] = [];
    const saved: Array<{ id: string; values: Record<string, unknown> }> = [];
    const fetch: AriesFetch = async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/token")) return json({ access_token: "account-bearer", expires_in: 3600, refresh_token: "account-refresh" });
      if (path === "/v2/users/me/accounts") return json({ accounts: syntheticAccounts });
      if (path.endsWith("/balance")) return json({ balance: "1000", cashBalance: "900", netBuyingPower: "1800" });
      if (path.endsWith("/positions")) return json({ positions: [] });
      return json({});
    };
    const broker = createAriesBroker({
      fetch, sockets: false, assertLocal: () => {},
      persist: (id, values) => { saved.push({ id, values }); },
      authorize: async () => { authorizations.push(Date.now()); return { code: "synthetic-code", verifier: "synthetic-verifier", redirectUri: "https://api.gloom.sh/brokers/aries/callback" }; },
      ...signIn,
    });
    brokers.push(broker);
    const account = (id: string, config: Record<string, unknown> = {}): BrokerInstanceConfig => ({ id, brokerType: "aries", label: "Aries", config: { auth: "account", accounts: "simulation", ...config } });
    return { broker, authorizations, saved, account };
  }

  test("a profile just added signs in on its first sync and keeps its tokens; one from before only says to connect", async () => {
    const { broker, authorizations, saved, account } = signInSetup();
    const added = account("added-profile", { signInPending: true });
    const snapshot = await broker.importPortfolioSnapshot!(added);
    expect(snapshot.accounts.map((value) => value.accountId)).toEqual(["SYNTH-SIM-ACCOUNT"]);
    expect(authorizations).toHaveLength(1);
    expect(saved.at(-1)).toEqual({ id: "added-profile", values: { accessToken: "account-bearer", accessTokenExpiresAt: expect.any(Number), refreshToken: "account-refresh", signInPending: false } });
    // A launch syncs every profile: one without a sign-in never opens the browser for it.
    const earlier = account("earlier-profile");
    await expect(broker.importPortfolioSnapshot!(earlier)).rejects.toThrow("press Connect");
    expect(broker.getStatus!(earlier).state).toBe("error");
    expect(authorizations).toHaveLength(1);
    await broker.connect!(earlier);
    expect(authorizations).toHaveLength(2);
    expect(broker.getStatus!(earlier).state).toBe("connected");
  });

  test("saving the form keeps an account sign-in, a personal client keeps none, and a profile from before sign-in stays personal", () => {
    const { broker, account } = signInSetup();
    const signedIn = account("signed-in", { accessToken: "account-bearer", accessTokenExpiresAt: 5, refreshToken: "account-refresh" });
    const form = broker.toConfigValues!(signedIn);
    expect(form).toEqual({ auth: "account", clientToken: "", clientSecret: "", accounts: "simulation", enableTrading: "false" });
    expect(broker.fromConfigValues!({ ...form, enableTrading: "true" }, signedIn)).toMatchObject({ refreshToken: "account-refresh", enableTrading: "true" });
    expect(broker.fromConfigValues!({ ...form, auth: "personal", clientToken: "ARI-PERSONAL-TK.x", clientSecret: "s" }, signedIn)).not.toHaveProperty("refreshToken");
    expect(broker.fromConfigValues!(form)).toMatchObject({ auth: "account", signInPending: true });
    expect(broker.toConfigValues!(profile())).toMatchObject({ auth: "personal", clientToken: "ARI-PERSONAL-TK.synthetic-client" });
  });

  test("syncs during a sign-in wait for it, and one that lands after Connect stopped waiting connects on its own", async () => {
    let finish!: () => void;
    let asked = 0;
    const { broker, account } = signInSetup({
      signInWaitMs: 50,
      authorize: () => { asked++; return new Promise((resolve) => { finish = () => resolve({ code: "synthetic-code", verifier: "synthetic-verifier", redirectUri: "https://api.gloom.sh/brokers/aries/callback" }); }); },
    });
    const added = account("added-profile", { signInPending: true });
    const syncs = Promise.allSettled([broker.importPortfolioSnapshot!(added), broker.listAccounts!(added)]);
    await Bun.sleep(5);
    expect(broker.getStatus!(added)).toMatchObject({ state: "connecting", message: "Finish signing in to Aries in your browser" });
    finish();
    expect((await syncs).map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(asked).toBe(1);
    const later = account("later-profile");
    await expect(broker.connect!(later)).rejects.toThrow("then press Connect");
    expect(broker.getStatus!(later).state).toBe("connecting");
    finish();
    for (let wait = 0; wait < 50 && broker.getStatus!(later).state !== "connected"; wait++) await Bun.sleep(5);
    expect(broker.getStatus!(later).state).toBe("connected");
    expect(asked).toBe(2);
  });
});
