import type { BrokerPosition } from "gloomberb/types/broker";
import type { BrokerAccount } from "gloomberb/types/trading";
import type { AriesTransport } from "./client";
import { finiteNumber, optionBrokerContract } from "./instruments";

export interface AriesAccount {
  accountId: string;
  name: string;
  isSim: boolean;
  status: string;
  accountType?: string;
}
type Row = Record<string, unknown>;

function accountLabel(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[A-Z_ ]{1,32}$/i.test(value)) return undefined;
  return value.toLowerCase().replaceAll("_", " ").trim().replace(/ +/g, " ") || undefined;
}

export function parseAccounts(response: { accounts?: Row[] | null }, filter: "simulation" | "live" | "both"): AriesAccount[] {
  if (!Array.isArray(response.accounts)) throw new Error("Aries returned an invalid account list.");
  return response.accounts.map((row): AriesAccount => {
    if (typeof row.trading_account_id !== "string" || !row.trading_account_id || typeof row.is_sim !== "boolean") {
      throw new Error("Aries returned an account without its trading ID or simulation status.");
    }
    const accountType = accountLabel(row.account_type);
    const accountClass = accountLabel(row.account_class);
    const classification = row.account_class == null ? accountType : accountClass;
    return {
      accountId: row.trading_account_id, name: `Aries ${accountType ?? "account"}${accountClass ? ` ${accountClass}` : ""} (${row.is_sim ? "simulation" : "LIVE"})`,
      isSim: row.is_sim, status: String(row.status ?? ""), accountType: classification?.replace(/\b[a-z]/g, (letter) => letter.toUpperCase()),
    };
  }).filter((row) => filter === "both" || row.isSim === (filter === "simulation"));
}

export function mapBalance(account: AriesAccount, row: Row, now = Date.now()): BrokerAccount {
  if (row.accountId !== undefined && row.accountId !== account.accountId) throw new Error("Aries returned a balance for a different account.");
  const cash = finiteNumber(row.cashBalance);
  return {
    accountId: account.accountId, name: account.name, tradingMode: account.isSim ? "simulation" : "live", accountType: account.accountType, currency: "USD", source: "gateway", updatedAt: now,
    netLiquidation: finiteNumber(row.balance), grossPositionValue: finiteNumber(row.marketValue),
    totalCashValue: cash, settledCash: finiteNumber(row.settledFunds), buyingPower: finiteNumber(row.netBuyingPower),
    availableFunds: finiteNumber(row.fundsAvailableForWithdrawal ?? row.amountAvailableToWithdraw),
    maintMarginReq: finiteNumber(row.maintReq), dailyPnl: finiteNumber(row.dayTotalPnl),
    previousNetLiquidation: finiteNumber(row.sodTtlEquity), unrealizedPnl: finiteNumber(row.openPnl ?? row.unrealizedPl),
    realizedPnl: finiteNumber(row.realizedPl),
    cashBalances: cash === undefined ? undefined : [{ currency: "USD", quantity: cash, baseValue: cash, baseCurrency: "USD" }],
  };
}

export function mapPositions(account: AriesAccount, response: { positions?: Row[] | null }, instanceId?: string): BrokerPosition[] {
  if (!Array.isArray(response.positions)) {
    if (response.positions === null) return [];
    throw new Error("Aries returned an invalid position list.");
  }
  return response.positions.map((row): BrokerPosition => {
    if (row.accountId !== undefined && row.accountId !== account.accountId) throw new Error("Aries returned a position for a different account.");
    const quantity = finiteNumber(row.quantity);
    if (quantity === undefined || typeof row.symbol !== "string" || !row.symbol) throw new Error("Aries returned an invalid position.");
    const security = String(row.securityType).toUpperCase();
    const assetCategory = security === "EQUITY" || security === "STOCK" || security === "STK" ? "STK" : security === "OPTION" || security === "OPT" ? "OPT" : security === "ETF" ? "ETF" : undefined;
    if (!assetCategory) throw new Error("This Aries position type is not supported yet.");
    const contract = assetCategory === "OPT" ? optionBrokerContract(row.symbol, instanceId) : {
      brokerId: "aries", brokerInstanceId: instanceId, symbol: row.symbol, localSymbol: row.symbol, secType: assetCategory, currency: "USD", exchange: "SMART",
    };
    if (!contract) throw new Error("Aries returned an option symbol that could not be resolved.");
    return {
      ticker: row.symbol, exchange: "", shares: Math.abs(quantity), side: quantity < 0 ? "short" : "long",
      avgCost: finiteNumber(row.averagePrice), currency: "USD", accountId: account.accountId,
      assetCategory, markPrice: finiteNumber(row.price), marketValue: finiteNumber(row.marketValue),
      unrealizedPnl: finiteNumber(row.unrealizedPl), multiplier: assetCategory === "OPT" ? 100 : 1,
      brokerContract: contract,
    };
  }).filter((row) => row.shares !== 0);
}

export class AriesAccounts {
  private cached?: { at: number; accounts: AriesAccount[] };
  private flight?: Promise<AriesAccount[]>;
  constructor(private client: AriesTransport, private filter: "simulation" | "live" | "both", private instanceId?: string) {}

  list(force = false): Promise<AriesAccount[]> {
    if (!force && this.cached && this.cached.at + 30_000 > Date.now()) return Promise.resolve(this.cached.accounts);
    return this.flight ??= this.client.get<{ accounts: Row[] }>("/v2/users/me/accounts").then((response) => {
      const accounts = parseAccounts(response, this.filter);
      this.cached = { at: Date.now(), accounts };
      return accounts;
    }).finally(() => { this.flight = undefined; });
  }

  async balances(): Promise<BrokerAccount[]> {
    const result: BrokerAccount[] = [];
    for (const account of await this.list()) result.push(mapBalance(account, await this.client.get<Row>(`/v2/accounts/${encodeURIComponent(account.accountId)}/balance`)));
    return result;
  }

  async positionsFor(account: AriesAccount): Promise<BrokerPosition[]> {
    return mapPositions(account, await this.client.get<{ positions: Row[] }>(`/v1/accounts/${encodeURIComponent(account.accountId)}/positions`), this.instanceId);
  }

  async positions(): Promise<BrokerPosition[]> {
    const result: BrokerPosition[] = [];
    for (const account of await this.list()) result.push(...await this.positionsFor(account));
    return result;
  }
}
