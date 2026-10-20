import { expect, test } from "bun:test";
import { mapBalance, mapPositions, parseAccounts } from "./accounts";
import { ariesConfig, assertLocalProfile } from "./config";

const sim = { trading_account_id: "SIM-SYNTHETIC", broker_account_id: "BROKER-WRONG", id: 42, is_sim: true, account_type: "INDIVIDUAL", account_class: "CASH", status: "OPEN" };
const live = { ...sim, trading_account_id: "LIVE-SYNTHETIC", is_sim: false };

test("account routing uses trading IDs, defaults to sim and clearly labels both", () => {
  const accounts = parseAccounts({ accounts: [live, sim] }, "both");
  expect(accounts.map((a) => a.accountId)).toEqual(["LIVE-SYNTHETIC", "SIM-SYNTHETIC"]);
  expect(accounts[0]?.name).toContain("LIVE");
  expect(accounts[1]?.name).toContain("simulation");
  expect(parseAccounts({ accounts: [live, sim] }, "simulation")).toHaveLength(1);
  expect(ariesConfig({}).accounts).toBe("simulation");
  expect(ariesConfig({}).enableTrading).toBe(false);
  expect(() => parseAccounts({ accounts: [{ id: 42 }] }, "both")).toThrow("trading ID");
  expect(() => assertLocalProfile({ disabledPlugins: [] })).toThrow("dedicated local profile");
  expect(() => assertLocalProfile({ disabledPlugins: ["gloomberb-cloud"] })).not.toThrow();
});

test("decimal balances distinguish missing values from zero", () => {
  const account = parseAccounts({ accounts: [sim] }, "both")[0]!;
  const mapped = mapBalance(account, { balance: "12500.20", cashBalance: "0", netBuyingPower: "25000.4", marketValue: "", openPnl: "-4.5", settledFunds: "unknown" }, 123);
  expect(mapped.netLiquidation).toBe(12500.2);
  expect(mapped.totalCashValue).toBe(0);
  expect(mapped.buyingPower).toBe(25000.4);
  expect(mapped.grossPositionValue).toBeUndefined();
  expect(mapped.settledCash).toBeUndefined();
  expect(mapped.unrealizedPnl).toBe(-4.5);
  expect(mapped.accountType).toBe("Cash");
  const variants = parseAccounts({ accounts: [
    { ...sim, account_class: "MARGIN" }, { ...sim, account_class: undefined },
    { ...sim, account_class: undefined, account_type: undefined }, { ...sim, account_class: "invalid<script>" },
  ] }, "simulation");
  expect(variants.map((item) => mapBalance(item, {}).accountType)).toEqual(["Margin", "Individual", undefined, undefined]);
});

test("short equity and option contracts preserve quantity, mark and multiplier", () => {
  const account = parseAccounts({ accounts: [sim] }, "both")[0]!;
  const mapped = mapPositions(account, { positions: [
    { symbol: "AAPL", securityType: "EQUITY", quantity: "-2.5", averagePrice: "170.25", price: "175.4", marketValue: "-438.5", unrealizedPl: "-12.875" },
    { symbol: "AAPL261218C00200000", securityType: "OPTION", quantity: "2", averagePrice: "3.1", price: "3.5", marketValue: "700" },
    { symbol: "SPY", securityType: "ETF", quantity: "1", averagePrice: "500" },
  ] }, "profile-synthetic");
  expect(mapped[0]).toMatchObject({ shares: 2.5, side: "short", avgCost: 170.25, marketValue: -438.5 });
  expect(mapped[1]).toMatchObject({ shares: 2, assetCategory: "OPT", multiplier: 100, markPrice: 3.5 });
  expect(mapped[1]?.brokerContract).toMatchObject({ brokerId: "aries", brokerInstanceId: "profile-synthetic", symbol: "AAPL", right: "C", strike: 200, multiplier: "100" });
  expect(mapped[2]?.assetCategory).toBe("ETF");
  expect(() => mapPositions(account, { positions: [{ symbol: "AAPL", securityType: "EQUITY", quantity: "NaN" }] })).toThrow("invalid position");
});
