import { describe, expect, test } from "bun:test";
import type { BrokerPosition } from "gloomberb/types/broker";
import type { BrokerInstanceConfig } from "gloomberb/types/config";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "gloomberb/types/plugin";
import type { BrokerAccount } from "gloomberb/types/trading";
import { ariesAccountsTemplate, createAriesAccountsHeadless } from "./headless";

const profiles: BrokerInstanceConfig[] = [{ id: "synthetic-private-profile", label: "Synthetic private label", brokerType: "aries", config: { clientToken: "synthetic-private-client", clientSecret: "synthetic-private-secret" } }];
const accounts: BrokerAccount[] = [
  { accountId: "synthetic-private-sim-id", name: "Aries individual (simulation)", currency: "USD", netLiquidation: 15000, totalCashValue: 10000, buyingPower: 12000, updatedAt: 1234 },
  { accountId: "synthetic-private-live-id", name: "Aries individual (LIVE)", currency: "USD", netLiquidation: 22000, totalCashValue: 5000, buyingPower: 6000, updatedAt: 1235 },
];
const positions: BrokerPosition[] = [
  { accountId: accounts[0]!.accountId, ticker: "SYNTH", exchange: "", shares: 5, side: "long", avgCost: 10, currency: "USD", assetCategory: "STK", markPrice: 11, marketValue: 55, unrealizedPnl: 5 },
  { accountId: accounts[1]!.accountId, ticker: "OTHER", exchange: "", shares: 3, side: "short", avgCost: 20, currency: "USD", assetCategory: "STK", markPrice: 18, marketValue: -54, unrealizedPnl: 6 },
];
const args = (options: HeadlessPaneLoadArgs["options"] = {}): HeadlessPaneLoadArgs => ({ rawArgument: "", argument: null, symbols: [], options });
const context = (instances = profiles, disabledPlugins = ["gloomberb-cloud"]): HeadlessPaneContext => ({ config: { brokerInstances: instances, disabledPlugins }, signal: new AbortController().signal }) as HeadlessPaneContext;

function fixture() {
  const calls: string[] = [];
  let disposed = false;
  const headless = createAriesAccountsHeadless(({ assertLocal }) => {
    assertLocal();
    return {
      async listAccounts(instance) { calls.push(`accounts:${instance.id}`); return accounts; },
      async importPortfolioSnapshot(instance) { calls.push(`positions:${instance.id}`); return { accounts, positions }; },
      dispose() { disposed = true; },
    };
  });
  return { calls, headless, get disposed() { return disposed; } };
}

describe("Aries account reports", () => {
  test("uses the existing Brokers pane and has no trading function", () => {
    expect(ariesAccountsTemplate.paneId).toBe("brokers");
    expect(ariesAccountsTemplate.shortcut?.prefix).toBe("ARA");
    expect(ariesAccountsTemplate.headless?.options.find((option) => option.key === "view")?.values).toEqual([{ value: "accounts" }, { value: "positions" }]);
  });

  test("returns balances through read-only methods and removes identifiers and credentials", async () => {
    const f = fixture();
    const result = await f.headless.load(args(), context());
    expect(f.calls).toEqual(["accounts:synthetic-private-profile"]);
    expect(result.sections[0]?.rows).toEqual([
      { account: "Account 1", mode: "simulation", currency: "USD", netLiquidation: 15000, cash: 10000, buyingPower: 12000, unrealizedPnl: undefined },
      { account: "Account 2", mode: "LIVE", currency: "USD", netLiquidation: 22000, cash: 5000, buyingPower: 6000, unrealizedPnl: undefined },
    ]);
    expect(JSON.stringify(result)).not.toContain("synthetic-private");
    expect(result.freshness).toMatchObject({ source: "Aries", status: "not-a-feed", asOf: 1235 });
    expect(f.disposed).toBe(true);
  });

  test("scopes positions by explicit account ordinal and labels simulation versus live", async () => {
    const f = fixture();
    const result = await f.headless.load(args({ view: "positions", account: 1 }), context());
    expect(f.calls).toEqual(["positions:synthetic-private-profile"]);
    expect(result.sections[0]?.rows).toHaveLength(1);
    expect(result.sections[1]?.rows).toEqual([expect.objectContaining({ account: "Account 1", mode: "simulation", symbol: "SYNTH", quantity: 5, side: "long" })]);
    expect(JSON.stringify(result)).not.toContain("OTHER");
    expect(JSON.stringify(result)).not.toContain("synthetic-private");
    expect(f.disposed).toBe(true);
  });

  test("requires an explicit profile when several are enabled", async () => {
    const f = fixture();
    const second = { ...profiles[0]!, id: "second-synthetic-profile" };
    await expect(f.headless.load(args(), context([...profiles, second]))).rejects.toThrow("Choose an Aries profile");
    expect(f.calls).toEqual([]);
    await f.headless.load(args({ profile: 2 }), context([...profiles, second]));
    expect(f.calls).toEqual(["accounts:second-synthetic-profile"]);
  });

  test("reads a profile with Gloom Cloud on, which keeps Aries data local", async () => {
    const f = fixture();
    await f.headless.load(args(), context(profiles, []));
    expect(f.calls).toEqual(["accounts:synthetic-private-profile"]);
  });

  test("disposes on failure and on cancellation", async () => {
    let disposed = false;
    const failing = createAriesAccountsHeadless(() => ({
      async listAccounts() { throw new Error("Synthetic read failure"); },
      dispose() { disposed = true; },
    }));
    await expect(failing.load(args(), context())).rejects.toThrow("Synthetic read failure");
    expect(disposed).toBe(true);

    const controller = new AbortController();
    disposed = false;
    const cancelled = createAriesAccountsHeadless(() => ({
      async listAccounts() { controller.abort(); return accounts; },
      dispose() { disposed = true; },
    }));
    await expect(cancelled.load(args(), { ...context(), signal: controller.signal })).rejects.toThrow();
    expect(disposed).toBe(true);
  });
});
