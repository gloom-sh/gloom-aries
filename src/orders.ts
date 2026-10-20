import type { BrokerContractRef } from "gloomberb/types/instrument";
import type { BrokerExecution, BrokerOrder, BrokerOrderPreview, BrokerOrderRequest, BrokerTradingCapabilities } from "gloomberb/types/trading";

/**
 * A spread order's leg as the host writes it: the side is what happens to that
 * contract, the ratio its contracts per spread. Declared here, with the request,
 * order and capability fields that carry it, so the plugin still builds against
 * hosts from before spread orders.
 */
interface HostOrderLeg { contract: BrokerContractRef; action: "BUY" | "SELL"; ratio: number }
type LegRequest = BrokerOrderRequest & { legs?: HostOrderLeg[] };
type LegOrder = BrokerOrder & { legs?: HostOrderLeg[] };
type Capabilities = BrokerTradingCapabilities & { maxLegs?: number };
/** Aries fills 2 to 4 legs as one order. */
const MAX_LEGS = 4;

export interface AriesOrderClient {
  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

export interface AriesOrderServiceOptions {
  accounts: () => Promise<readonly { accountId: string; isSim: boolean }[]>;
  tradingEnabled: () => boolean;
  brokerInstanceId?: string;
  /** Fetch current signed option quantities. Symbols must identify the complete OSI contract. */
  optionPositions?: (accountId: string) => Promise<readonly { symbol: string; quantity: number }[]>;
  now?: () => number;
}

interface OptionDetails {
  symbol: string;
  localSymbol: string;
  maturity: string;
  putCall: "CALL" | "PUT";
  strikePrice: string;
}

interface OrderLeg extends OptionDetails {
  securityType: "OPT";
  side: "BUY" | "SELL";
  ratioQty: string;
  positionEffect: "OPEN" | "CLOSE";
}

interface AriesOrderBody {
  tradingAccountId: string;
  symbol: string;
  side: string;
  type: string;
  qty: string;
  timeInForce: string;
  currency: string;
  price?: string;
  stopPrice?: string;
  legs?: Omit<OrderLeg, "localSymbol">[];
}

type Row = Record<string, unknown>;
interface StoredOrder {
  accountId: string;
  clOrdId: string;
  order: BrokerOrder;
  cancel: Row;
  positionEffect?: "OPEN" | "CLOSE";
  /** A spread's legs' effects by OSI symbol: a replacement must send them unchanged. */
  legEffects?: Record<string, "OPEN" | "CLOSE">;
  mutable: boolean;
}

const orderTypes: Record<string, string> = { MKT: "MARKET", LMT: "LIMIT", STP: "STOP", "STP LMT": "STOP_LIMIT" };
const hostOrderTypes: Record<string, string> = { MARKET: "MKT", LIMIT: "LMT", STOP: "STP", STOP_LIMIT: "STP LMT" };
const terminal = new Set(["FILLED", "CANCELED", "REJECTED", "EXPIRED", "CALCULATED", "SUPERSEDED", "REPLACED"]);
/**
 * The open list keeps a changed order under REPLACED ("the modification took
 * effect") while it still works; only history's superseded versions are done.
 */
const working = (source: Row): Row => source.ordStatus === "REPLACED" && (number(source.leavesQty) ?? 0) > 0 ? { ...source, ordStatus: "NEW" } : source;
const statuses = new Set(["NEW", "PARTIALLY_FILLED", "PENDING_NEW", "PENDING_CANCEL", "PENDING_REPLACE", "DONE_FOR_DAY", "STOPPED", "SUSPENDED", "ACCEPTED_FOR_BID", ...terminal]);
const tifs: Record<string, string> = {
  DAY: "DAY", GTC: "GTC", IOC: "IOC", FOK: "FOK", EXT: "EXTENDED_HOURS", EXTENDED_HOURS: "EXTENDED_HOURS",
  OPG: "AT_THE_OPENING", ATO: "AT_THE_OPENING", AT_THE_OPENING: "AT_THE_OPENING",
  MOC: "AT_THE_CLOSE", ATC: "AT_THE_CLOSE", AT_THE_CLOSE: "AT_THE_CLOSE",
};

function row(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function sourceLegs(source: Row): Row[] {
  return Array.isArray(source.legs) ? source.legs.map(row) : [];
}

/** An option leg as Aries takes it in an order body. */
function orderLeg({ localSymbol: _, ...fields }: OptionDetails, side: "BUY" | "SELL", ratio: number, positionEffect: "OPEN" | "CLOSE"): Omit<OrderLeg, "localSymbol"> {
  return { ...fields, securityType: "OPT", side, ratioQty: String(ratio), positionEffect };
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function number(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
  if (typeof value === "string" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function decimal(value: number | undefined, name: string, price = false): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${name} must be a positive, finite number.`);
  }
  const result = String(value).includes("e") ? value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 }) : String(value);
  if (Number(result) !== value || (price && (result.split(".")[1]?.length ?? 0) > 5)) {
    throw new Error(`${name} supports at most five decimal places.`);
  }
  return result;
}

function maturity(value: string | undefined): string {
  const formatted = value?.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
  const timestamp = Date.parse(`${formatted}T00:00:00Z`);
  if (!formatted || !/^\d{4}-\d{2}-\d{2}$/.test(formatted) || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== formatted) {
    throw new Error("Select an option with a valid expiration date.");
  }
  return formatted;
}

function compactSymbol(value: string): string {
  return value.trim().toUpperCase().replace(/^(?:O:|\.)/, "").replace(/\s+/g, "");
}

function parseOption(value: string | undefined): OptionDetails | undefined {
  if (!value) return undefined;
  const match = /^([A-Z][A-Z0-9.]{0,5})(\d{6})([CP])(\d{8})$/.exec(compactSymbol(value));
  if (!match) return undefined;
  const date = maturity(`20${match[2]}`);
  return {
    symbol: match[1]!, localSymbol: compactSymbol(value), maturity: date,
    putCall: match[3] === "C" ? "CALL" : "PUT", strikePrice: String(Number(match[4]) / 1000),
  };
}

function optionDetails(contract: BrokerContractRef): OptionDetails {
  const parsed = parseOption(contract.localSymbol) ?? parseOption(contract.symbol);
  if (contract.multiplier !== undefined && Number(contract.multiplier) !== 100) {
    throw new Error("Aries option orders support standard 100-share contracts only.");
  }
  if (parsed) {
    const symbol = compactSymbol(contract.symbol);
    if ((symbol !== parsed.symbol && symbol !== parsed.localSymbol) ||
        (contract.right && contract.right !== (parsed.putCall === "CALL" ? "C" : "P")) ||
        (contract.strike !== undefined && contract.strike !== Number(parsed.strikePrice)) ||
        (contract.lastTradeDateOrContractMonth && maturity(contract.lastTradeDateOrContractMonth) !== parsed.maturity)) {
      throw new Error("The option symbol and contract details do not match.");
    }
    return parsed;
  }
  const symbol = contract.symbol.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.]{0,5}$/.test(symbol) || !["C", "P"].includes(contract.right ?? "")) {
    throw new Error("Select an option with its underlying, expiration, strike and call or put side.");
  }
  const date = maturity(contract.lastTradeDateOrContractMonth);
  const strikePrice = decimal(contract.strike, "Option strike", true);
  const strike = Number(strikePrice) * 1000;
  if (!Number.isInteger(strike) || strike > 99999999) throw new Error("The option strike cannot be represented as an OSI symbol.");
  return {
    symbol, maturity: date, putCall: contract.right === "C" ? "CALL" : "PUT", strikePrice,
    localSymbol: `${symbol}${date.replace(/-/g, "").slice(2)}${contract.right}${String(strike).padStart(8, "0")}`,
  };
}

function sameContract(left: BrokerContractRef, right: BrokerContractRef): boolean {
  if (left.secType === "OPT" || right.secType === "OPT") {
    try { return optionDetails(left).localSymbol === optionDetails(right).localSymbol; } catch { return false; }
  }
  return left.symbol === right.symbol && left.secType === right.secType;
}

function orderContract(contract: BrokerContractRef, instanceId?: string): { symbol: string; option?: OptionDetails; spread?: boolean } {
  if (contract.brokerId !== "aries" || (contract.brokerInstanceId && contract.brokerInstanceId !== instanceId)) {
    throw new Error("Select an instrument from this Aries broker profile.");
  }
  const secType = contract.secType?.toUpperCase() ?? (parseOption(contract.localSymbol ?? contract.symbol) ? "OPT" : "STK");
  if (contract.currency && contract.currency !== "USD") throw new Error("Aries orders through this adapter support USD instruments only.");
  if (secType === "BAG") {
    const symbol = contract.symbol.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.]{0,5}$/.test(symbol)) throw new Error("Select the spread's underlying stock or fund.");
    return { symbol, spread: true };
  }
  if (!["STK", "ETF", "CS", "EQUITY", "OPT", "OPTION"].includes(secType)) throw new Error("Aries orders through this adapter support stocks, ETFs, options and option spreads.");
  const option = ["OPT", "OPTION"].includes(secType) ? optionDetails(contract) : undefined;
  const symbol = option?.symbol ?? contract.symbol.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,20}$/.test(symbol)) throw new Error("Select a valid Aries instrument symbol.");
  return { symbol, option };
}

/** Describes the same contract rules used by the request mapper without any API access. */
export function ariesOrderCapabilities(contract?: BrokerContractRef, instanceId?: string): Capabilities {
  let option: OptionDetails | undefined;
  let spread = false;
  try { if (contract) ({ option, spread = false } = orderContract(contract, instanceId)); }
  catch (error) {
    return { enabled: false, disabledReason: error instanceof Error ? error.message : "This instrument is not supported by Aries.", orderTypes: [], tif: [], executionKind: "order-summaries" };
  }
  // A spread is priced as one net debit or credit; Aries takes market and limit spreads, DAY or GTC.
  if (spread) return { enabled: true, orderTypes: ["MKT", "LMT"], tif: ["DAY", "GTC"], extendedHours: false, extendedHoursTif: [], fractionalQuantity: false,
    shortSelling: false, minQuantity: 1, quantityStep: 1, priceDecimals: 2, modify: true, cancel: true, executionKind: "order-summaries", maxLegs: MAX_LEGS };
  return {
    enabled: true, orderTypes: ["MKT", "LMT", "STP", "STP LMT"],
    tif: option ? ["DAY", "GTC"] : [...new Set(Object.values(tifs))],
    extendedHours: !option, extendedHoursTif: option ? [] : ["DAY", "EXTENDED_HOURS"],
    fractionalQuantity: !option, shortSelling: false, ...(option ? { minQuantity: 1, quantityStep: 1 } : {}),
    priceDecimals: 5, modify: true, cancel: true, executionKind: "order-summaries",
  };
}

// Session-scoped opaque IDs prevent coercing a UUID into a host order number. A random
// starting point also keeps stale IDs from another session from addressing a new order.
const random = crypto.getRandomValues(new Uint32Array(2));
let nextOrderId = (random[0]! & 0xfffff) * 0x100000000 + random[1]!;

export class AriesOrderService {
  private readonly ids = new Map<string, number>();
  private readonly orders = new Map<number, StoredOrder>();
  private readonly busy = new Set<number>();
  private mutationVersion = 0;
  private readonly now: () => number;

  constructor(private readonly client: AriesOrderClient, private readonly options: AriesOrderServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  private trading(): void {
    if (!this.options.tradingEnabled()) throw new Error("Trading is disabled. Enable trading in this Aries broker profile to preview or submit orders.");
  }

  private async account(accountId: string | undefined): Promise<{ accountId: string; isSim: boolean }> {
    if (!accountId) throw new Error("Select an Aries simulation or live account explicitly before continuing.");
    const account = (await this.options.accounts()).find((entry) => entry.accountId === accountId);
    if (!account) throw new Error("The selected account is not included in this Aries broker profile. Refresh accounts and select one again.");
    return account;
  }

  /** Whether this many contracts open or close the position held in one contract; never through zero. */
  private async effect(accountId: string, option: OptionDetails, action: "BUY" | "SELL", quantity: number, held?: readonly { symbol: string; quantity: number }[]): Promise<"OPEN" | "CLOSE"> {
    if (!held && !this.options.optionPositions) throw new Error("Current option positions are required to determine whether this order opens or closes a position.");
    const positions = held ?? await this.options.optionPositions!(accountId);
    const matching = positions.filter((position) => compactSymbol(position.symbol) === option.localSymbol);
    if (matching.some((position) => !Number.isFinite(position.quantity))) throw new Error("Current option quantities could not be verified. Refresh positions before trading.");
    const current = matching.reduce((sum, position) => sum + position.quantity, 0);
    const closing = (action === "SELL" && current > 0) || (action === "BUY" && current < 0);
    if (closing && quantity > Math.abs(current)) throw new Error("This option order would cross through zero. Close the existing position before opening the opposite side.");
    return closing ? "CLOSE" : "OPEN";
  }

  /** Each leg trades its side, at ratio times the spread count, and opens or closes its own contract. */
  private async spreadLegs(request: LegRequest, symbol: string, effects?: Readonly<Record<string, "OPEN" | "CLOSE">>): Promise<NonNullable<AriesOrderBody["legs"]>> {
    const legs = request.legs ?? [];
    if (legs.length < 2 || legs.length > MAX_LEGS) throw new Error(`Aries takes spreads of 2 to ${MAX_LEGS} legs.`);
    const held = effects ? undefined : await this.options.optionPositions?.(request.accountId!);
    const seen = new Set<string>();
    const output: NonNullable<AriesOrderBody["legs"]> = [];
    for (const leg of legs) {
      if (!["BUY", "SELL"].includes(leg.action) || !Number.isSafeInteger(leg.ratio) || leg.ratio <= 0) throw new Error("Every leg needs a side and a whole number of contracts.");
      orderContract({ ...leg.contract, secType: "OPT" }, this.options.brokerInstanceId);
      const option = optionDetails(leg.contract);
      if (option.symbol !== symbol) throw new Error("Every leg must be an option on the spread's underlying.");
      if (seen.has(option.localSymbol)) throw new Error("A contract can appear in only one leg.");
      seen.add(option.localSymbol);
      if (effects && !effects[option.localSymbol]) throw new Error("The original legs' position effects are unavailable. Manage this order in Aries.");
      const positionEffect = effects?.[option.localSymbol] ?? await this.effect(request.accountId!, option, leg.action, leg.ratio * request.quantity, held);
      output.push(orderLeg(option, leg.action, leg.ratio, positionEffect));
    }
    // Aries keeps a spread's side as its last leg's, whatever side was sent (observed in simulation). A leg
    // trading the order's own side goes last, so a debit stays a BUY and a credit a SELL however it is read.
    const last = output.findLastIndex((leg) => leg.side === request.action);
    if (last < 0) throw new Error(request.action === "BUY" ? "A debit spread buys at least one leg." : "A credit spread sells at least one leg.");
    return [...output.slice(0, last), ...output.slice(last + 1), output[last]!];
  }

  private async body(request: LegRequest, positionEffect?: "OPEN" | "CLOSE", legEffects?: Readonly<Record<string, "OPEN" | "CLOSE">>): Promise<AriesOrderBody> {
    this.trading();
    await this.account(request.accountId);
    if (request.brokerInstanceId && request.brokerInstanceId !== this.options.brokerInstanceId) throw new Error("The order belongs to a different broker profile.");
    const contract = request.contract;
    const { symbol, option, spread } = orderContract(contract, this.options.brokerInstanceId);
    if (!!spread !== !!request.legs?.length) throw new Error(spread ? "A spread needs its legs." : "Only a spread contract takes legs.");
    if (!["BUY", "SELL"].includes(request.action)) throw new Error("Aries supports BUY and SELL through this adapter.");
    const type = orderTypes[request.orderType];
    if (!type) throw new Error("Aries supports market, limit, stop and stop-limit orders.");
    const tif = tifs[(request.tif ?? "DAY").toUpperCase()];
    if (!tif) throw new Error("This time in force is not supported by Aries.");
    let timeInForce = tif;
    if (request.outsideRth) {
      if (option || !["DAY", "EXTENDED_HOURS"].includes(tif)) throw new Error("Extended hours require an equity order with DAY time in force.");
      timeInForce = "EXTENDED_HOURS";
    }
    if ((option || spread) && !["DAY", "GTC"].includes(timeInForce)) throw new Error("Aries option orders support DAY and GTC only.");
    if ((option || spread) && !Number.isInteger(request.quantity)) throw new Error("Option quantity must be a whole number of contracts.");
    if (spread && !["MARKET", "LIMIT"].includes(type)) throw new Error("Aries takes market and limit spreads.");
    const body: AriesOrderBody = { tradingAccountId: request.accountId!, symbol, side: request.action, type, qty: decimal(request.quantity, "Quantity"), timeInForce, currency: "USD" };
    // A spread's price is its signed net debit: a credit goes negative. In simulation, a short
    // vertical sent as SELL at +4.95 filled at once at its 1.64 market credit, and rested at -4.95.
    if (["LIMIT", "STOP_LIMIT"].includes(type)) body.price = `${spread && request.action === "SELL" ? "-" : ""}${decimal(request.limitPrice, "Limit price", true)}`;
    else if (request.limitPrice !== undefined) throw new Error("A limit price is only supported for limit and stop-limit orders.");
    if (["STOP", "STOP_LIMIT"].includes(type)) body.stopPrice = decimal(request.stopPrice, "Stop price", true);
    else if (request.stopPrice !== undefined) throw new Error("A stop price is only supported for stop and stop-limit orders.");
    if (option) {
      positionEffect ??= await this.effect(request.accountId!, option, request.action, request.quantity);
      body.legs = [orderLeg(option, request.action, 1, positionEffect)];
    }
    // The order's side says debit (BUY) or credit (SELL); each leg's side is what that contract does.
    if (spread) body.legs = await this.spreadLegs(request, symbol, legEffects);
    return body;
  }

  private confirmation(isSim: boolean): string {
    return isSim ? "Simulation account. No real money is used." : "LIVE account. Orders use real money.";
  }

  private async preview(body: AriesOrderBody, isSim: boolean): Promise<BrokerOrderPreview> {
    const result = row(await this.client.post<unknown>("/v1/orders/preview", body));
    // Upstream strings can contain echoed request data. Only show our own text and numbers.
    if (result.error || (result.errors != null && (!Array.isArray(result.errors) || result.errors.length))) throw new Error("Aries rejected this order preview. Review the order and buying power in Aries before submitting.");
    if (number(result.estimatedCost) === undefined && number(result.buyingPowerImpact) === undefined) throw new Error("Aries did not return valid order estimates. Refresh the preview before submitting.");
    const warnings = [this.confirmation(isSim)];
    if (body.legs?.length === 1) warnings.push(`Option position: ${body.legs[0]!.positionEffect.toLowerCase()}.`);
    else if (body.legs?.length) warnings.push(`Legs: ${body.legs.map((leg) => `${leg.side === "BUY" ? "buy" : "sell"} to ${leg.positionEffect.toLowerCase()}`).join(", ")}.`);
    for (const [key, label] of [["estimatedMargin", "Estimated margin"], ["optionFees", "Option fees"], ["optionRequirement", "Option requirement"]]) {
      const value = number(result[key!]);
      if (!body.legs?.length && key?.startsWith("option") && value === 0) continue;
      if (value !== undefined) warnings.push(`${label}: USD ${value.toFixed(2)}.`);
    }
    if ((Array.isArray(result.warnings) && result.warnings.length) || (string(result.warnRuleId) && result.warnRuleId !== "0")) {
      warnings.push("Aries returned a risk warning. Review this order in Aries before submitting.");
    }
    const estimates: string[] = [];
    for (const [key, label] of [["estimatedCost", "Estimated cost"], ["buyingPowerImpact", "Buying power impact"], ["fees", "Fees"]]) {
      const value = number(result[key!]);
      if (value !== undefined) estimates.push(`${label}: USD ${value.toFixed(2)}.`);
    }
    return {
      currency: "USD", estimatedCost: number(result.estimatedCost), fees: number(result.fees),
      buyingPowerImpact: number(result.buyingPowerImpact), commission: number(result.commission), commissionCurrency: "USD",
      warnings, warningText: [...warnings, ...estimates].join(" "),
    };
  }

  async previewOrder(request: LegRequest): Promise<BrokerOrderPreview> {
    const body = await this.body(request);
    const account = await this.account(request.accountId);
    return this.preview(body, account.isSim);
  }

  private id(accountId: string, clOrdId: string): number {
    const key = JSON.stringify([accountId, clOrdId]);
    let id = this.ids.get(key);
    if (id === undefined) {
      id = ++nextOrderId;
      if (!Number.isSafeInteger(id)) throw new Error("Reconnect Aries before loading more orders.");
      this.ids.set(key, id);
    }
    return id;
  }

  private contract(source: Row, fallback?: BrokerContractRef): BrokerContractRef {
    if (fallback) return { ...fallback, brokerId: "aries", brokerInstanceId: this.options.brokerInstanceId };
    const legs = sourceLegs(source);
    const leg = legs.length === 1 ? legs[0]! : source;
    const symbol = string(leg.symbol) ?? string(source.symbol) ?? "UNKNOWN";
    const parsed = parseOption(symbol);
    const isOption = ["OPTION", "OPT"].includes(String(source.securityType)) || Boolean(parsed) || legs.length === 1;
    // The host's combo contract for a spread: its underlying, as one order.
    if (legs.length > 1 || source.category === "MULTI_LEG") return { brokerId: "aries", brokerInstanceId: this.options.brokerInstanceId, symbol: string(source.symbol) ?? symbol, secType: "BAG", exchange: "SMART", currency: "USD", multiplier: "100" };
    const contract: BrokerContractRef = {
      brokerId: "aries", brokerInstanceId: this.options.brokerInstanceId, symbol: parsed?.symbol ?? symbol,
      secType: isOption ? "OPT" : "STK", currency: "USD", exchange: "SMART",
    };
    if (isOption) {
      contract.multiplier = "100";
      contract.right = parsed ? (parsed.putCall === "CALL" ? "C" : "P") : leg.putCall === "CALL" || leg.putCall === "C" ? "C" : leg.putCall === "PUT" || leg.putCall === "P" ? "P" : undefined;
      contract.strike = parsed ? Number(parsed.strikePrice) : number(leg.strikePrice);
      contract.lastTradeDateOrContractMonth = parsed?.maturity ?? string(leg.maturity);
      try { contract.localSymbol = optionDetails(contract).localSymbol; } catch { /* Incomplete contract stays visible but cannot be changed. */ }
    }
    return contract;
  }

  /** A filled spread's net price per spread, debit or credit as its action says: Aries reports fill prices per leg. */
  private netFill(source: Row, action: "BUY" | "SELL"): number | undefined {
    const order = number(source.avgPrice);
    if (order !== undefined && order !== 0) return Math.abs(order);
    const legs = sourceLegs(source);
    if (!(number(source.cumQty)! > 0) || !legs.length) return undefined;
    let debit = 0;
    for (const leg of legs) {
      const price = number(leg.avgPrice), ratio = number(leg.ratioQty) ?? 1;
      if (price === undefined || !(price > 0)) return undefined;
      debit += (["BUY", "B"].includes(String(leg.side)) ? 1 : -1) * ratio * price;
    }
    return Math.round(Math.abs(action === "BUY" ? debit : -debit) * 1e5) / 1e5;
  }

  /** A spread leg's contract, its underlying from the order when the leg omits it. */
  private legContract(leg: Row, source: Row): BrokerContractRef {
    return this.contract({ ...leg, symbol: string(leg.symbol) ?? string(source.symbol), securityType: "OPT", legs: [leg] });
  }

  /** Each spread leg's open or close, by OSI symbol, as Aries holds it; undefined when one is missing. */
  private legEffects(source: Row): Record<string, "OPEN" | "CLOSE"> | undefined {
    const legs = sourceLegs(source);
    const entries = legs.map((leg) => {
      const value = string(leg.positionEffect)?.toUpperCase();
      const effect = value === "O" || value === "OPEN" ? "OPEN" : value === "C" || value === "CLOSE" ? "CLOSE" : undefined;
      const symbol = this.legContract(leg, source).localSymbol;
      return effect && symbol ? [symbol, effect] as const : null;
    });
    return legs.length > 1 && entries.every((entry) => entry) ? Object.fromEntries(entries as (readonly [string, "OPEN" | "CLOSE"])[]) : undefined;
  }

  /** A spread's legs from the request that placed it, else as Aries reads them back. */
  private legs(source: Row, fallback?: LegRequest): HostOrderLeg[] | undefined {
    if (fallback?.legs?.length) return fallback.legs.map((leg) => ({ ...leg, contract: { ...leg.contract, brokerId: "aries", brokerInstanceId: this.options.brokerInstanceId } }));
    const legs = sourceLegs(source);
    if (legs.length < 2) return undefined;
    const mapped = legs.map((leg) => {
      const side = string(leg.side) === "B" ? "BUY" : string(leg.side) === "S" ? "SELL" : string(leg.side);
      const ratio = number(leg.ratioQty) ?? 1;
      return side === "BUY" || side === "SELL" ? { contract: this.legContract(leg, source), action: side, ratio } as HostOrderLeg : null;
    });
    return mapped.every((leg) => leg !== null) ? mapped as HostOrderLeg[] : undefined;
  }

  private remember(source: Row, account: { accountId: string; isSim: boolean }, fallback?: LegRequest, existingId?: number, snapshotVersion = this.mutationVersion): BrokerOrder {
    const clOrdId = string(source.clOrdId);
    if (!clOrdId) throw new Error("Aries did not return an order identifier. Refresh orders before retrying any action.");
    if (source.accountId !== undefined && source.accountId !== account.accountId) throw new Error("Aries returned an order for an unexpected account.");
    const id = existingId ?? this.id(account.accountId, clOrdId);
    this.ids.set(JSON.stringify([account.accountId, clOrdId]), id);
    const previous = this.orders.get(id);
    const contract = this.contract(source, fallback?.contract);
    const quantity = number(source.qty) ?? fallback?.quantity ?? 0;
    const filled = number(source.cumQty) ?? previous?.order.filled ?? 0;
    const status = statuses.has(String(source.ordStatus ?? source.status)) ? String(source.ordStatus ?? source.status) : "UNKNOWN";
    const rawSide = string(source.side) ?? fallback?.action ?? "";
    if (!["BUY", "BUY_TO_COVER", "SELL", "SELL_SHORT", "SELL_SHORT_EXEMPT"].includes(rawSide)) throw new Error("Aries returned an unsupported order side.");
    const rawType = string(source.type) ?? (fallback ? orderTypes[fallback.orderType] : undefined);
    const rawTif = string(source.timeInForce) ?? fallback?.tif;
    const spreadLegs = contract.secType === "BAG" ? this.legs(source, fallback) : undefined;
    // A spread's net price says debit or credit by its sign; its side is only its last leg's.
    const signed = contract.secType === "BAG" ? number(source.price) : undefined;
    const action = signed !== undefined && signed !== 0 ? signed < 0 ? "SELL" : "BUY" : ["BUY", "BUY_TO_COVER"].includes(rawSide) ? "BUY" : "SELL";
    // A cancel arrives under its own client ID, but it ends the order it names: the order keeps its native ID,
    // so a ticket matching on it sees the cancel. A replacement is a new native order and takes the new ID.
    const cancelRow = existingId !== undefined && !!previous && previous.clOrdId !== clOrdId && ["CANCELED", "PENDING_CANCEL"].includes(status);
    const order: LegOrder = {
      orderId: id, brokerOrderId: cancelRow ? previous!.order.brokerOrderId ?? previous!.clOrdId : clOrdId, brokerInstanceId: this.options.brokerInstanceId, accountId: account.accountId,
      status, action, orderType: hostOrderTypes[rawType ?? ""] ?? "UNKNOWN",
      quantity, filled, remaining: number(source.leavesQty) ?? Math.max(0, quantity - filled),
      avgFillPrice: spreadLegs ? this.netFill(source, action) : number(source.avgPrice),
      // Aries order reads include zero placeholders for prices the type does not use.
      // Carrying those into a replacement makes a LIMIT request look like a stop order.
      limitPrice: rawType === "LIMIT" || rawType === "STOP_LIMIT" ? (signed !== undefined ? Math.abs(signed) : number(source.price)) ?? fallback?.limitPrice : undefined,
      stopPrice: rawType === "STOP" || rawType === "STOP_LIMIT" ? number(source.stopPrice) ?? fallback?.stopPrice : undefined,
      tif: rawTif && tifs[rawTif] ? tifs[rawTif] : undefined,
      updatedAt: Date.parse(String(source.updatedAt ?? source.transactTime ?? source.createdAt)) || this.now(), contract,
      warningText: `${this.confirmation(account.isSim)}${contract.secType === "BAG" && !spreadLegs ? " Multi-leg order. Manage it in Aries." : ""}`,
      ...(spreadLegs ? { legs: spreadLegs } : {}),
    };
    const effect = sourceLegs(source)[0]?.positionEffect;
    const legEffects = spreadLegs ? this.legEffects(source) ?? previous?.legEffects : undefined;
    // A spread's cancel names no security type: Aries rejects one with OPT and no option fields (observed in simulation).
    const cancel: Row = { tradingAccountId: account.accountId, origClOrdId: clOrdId, symbol: contract.symbol, side: rawSide, ...(contract.secType === "BAG" ? {} : { securityType: contract.secType === "OPT" ? "OPT" : "CS" }) };
    // A spread changes only with its legs and their effects known, as a replacement must resend them.
    let mutable = contract.secType !== "BAG" || (!!spreadLegs && !!legEffects);
    if (contract.secType === "OPT") {
      try {
        const { localSymbol: _, ...fields } = optionDetails(contract);
        Object.assign(cancel, fields);
      } catch { mutable = false; }
    }
    // A read started before or during a mutation must not overwrite its acknowledgement.
    // Historical rows for an earlier replacement ID must not restore the old cancel target.
    const currentSnapshot = snapshotVersion === this.mutationVersion && !this.busy.has(id);
    const terminalRegression = previous && terminal.has(previous.order.status) && !terminal.has(order.status);
    if (existingId !== undefined || !previous || (currentSnapshot && previous.clOrdId === clOrdId && !terminalRegression)) {
      this.orders.set(id, { accountId: account.accountId, clOrdId, order, cancel, mutable, positionEffect: effect === "OPEN" || effect === "CLOSE" ? effect : previous?.positionEffect, legEffects });
    }
    return order;
  }

  private accepted(response: Row): void {
    if (response.success === true && response.status !== "REJECTED") return;
    // Aries' rejection text is not shown as it comes, since it may carry identifiers; reasons known to be
    // safe are named.
    const text = [response.text, response.ordRejReason, response.message].filter((value) => typeof value === "string").join(" ");
    const known = /order cannot be found/i.test(text) ? " Aries cannot find this order." : "";
    throw new Error(`Aries did not accept this order action.${known} Refresh orders and review the account in Aries before retrying.`);
  }

  private acceptMutation(stored: StoredOrder, response: Row): void {
    // Only an explicit rejection proves the old order is unchanged. A malformed or
    // incomplete acknowledgement needs reconciliation before another mutation.
    if (response.success !== false && response.status !== "REJECTED") stored.order.status = "UNKNOWN";
    this.accepted(response);
  }

  async placeOrder(request: LegRequest): Promise<BrokerOrder> {
    const body = await this.body(request);
    const account = await this.account(request.accountId);
    // A new preview catches blocking risk errors even when a caller bypasses the host ticket.
    await this.preview(body, account.isSim);
    this.trading();
    const response = row(await this.client.post<unknown>("/v1/orders", body));
    this.accepted(response);
    return this.remember({ ...body, ...response }, account, request);
  }

  private async stored(orderId: number, action: "modify" | "cancel"): Promise<StoredOrder> {
    this.trading();
    const stored = this.orders.get(orderId);
    if (!stored) throw new Error("This order is not known in the current Aries session. Refresh open orders before changing it.");
    // Lock before the account lookup yields, otherwise a concurrent refresh can
    // replace this record before the caller receives it.
    this.reserve(orderId);
    try {
      await this.account(stored.accountId);
      if (!stored.mutable) throw new Error("This order cannot be changed safely through Gloom. Manage it in Aries.");
      if (terminal.has(stored.order.status)) throw new Error("This order is no longer open. Refresh open orders before changing it.");
      if (stored.order.status === "PENDING_CANCEL") throw new Error("This order is already being cancelled.");
      // An order Aries is still replacing can be cancelled, not replaced again.
      if (stored.order.status === "PENDING_REPLACE" && action === "modify") throw new Error("Aries has not taken the last change yet. Wait for it, or cancel the order.");
      // A replacement of an order Aries has not acknowledged lost the order in simulation: it stayed pending
      // replace with "Order cannot be found".
      if (stored.order.status === "PENDING_NEW" && action === "modify") throw new Error("Aries has not acknowledged this order yet. Wait for it to work, or cancel it.");
      if (stored.order.status === "UNKNOWN") throw new Error("The order status needs confirmation. Refresh open orders before changing it.");
      return stored;
    } catch (error) { this.release(orderId); throw error; }
  }

  async modifyOrder(orderId: number, request: LegRequest): Promise<BrokerOrder> {
    const stored = await this.stored(orderId, "modify");
    try {
      if (request.accountId !== stored.accountId) throw new Error("A replacement must use the original selected account.");
      if (!sameContract(stored.order.contract, request.contract) || request.action !== stored.order.action) throw new Error("A replacement cannot change the instrument or order side.");
      if (stored.order.contract.secType === "OPT" && !stored.positionEffect) throw new Error("The original option position effect is unavailable. Manage this order in Aries.");
      const storedLegs = (stored.order as LegOrder).legs;
      // Aries may list the legs in another order than they were sent.
      const legKey = (legs: readonly HostOrderLeg[]) => JSON.stringify(legs.map((leg) => [optionDetails(leg.contract).localSymbol, leg.action, leg.ratio]).sort());
      if (storedLegs && legKey(storedLegs) !== legKey(request.legs ?? [])) throw new Error("A replacement keeps the spread's legs.");
      const body = await this.body(request, stored.positionEffect, stored.legEffects);
      // A spread's side is its last leg's, which the body has just set.
      if (stored.order.contract.secType !== "BAG") body.side = String(stored.cancel.side);
      const account = await this.account(stored.accountId);
      this.trading();
      let response: Row;
      try { response = row(await this.client.post<unknown>("/v1/orders/replace", { ...body, origClOrdId: stored.clOrdId })); }
      catch (error) { stored.order.status = "UNKNOWN"; throw error; }
      this.acceptMutation(stored, response);
      // A replacement has a new client ID. Keep the host ID attached to the current ID.
      // Save it immediately; no follow-up read may prevent retaining the new ID.
      return this.remember({ ...body, ...response, status: response.status === "REPLACED" ? "NEW" : response.status }, account, request, orderId);
    } finally { this.release(orderId); }
  }

  async cancelOrder(orderId: number): Promise<void> {
    const stored = await this.stored(orderId, "cancel");
    try {
      this.trading();
      let response: Row;
      try { response = row(await this.client.post<unknown>("/v1/orders/cancel", stored.cancel)); }
      catch (error) { stored.order.status = "UNKNOWN"; throw error; }
      this.acceptMutation(stored, response);
      stored.order.status = response.status === "CANCELED" ? "CANCELED" : "PENDING_CANCEL";
    } finally { this.release(orderId); }
  }

  private reserve(orderId: number): void {
    if (this.busy.has(orderId)) throw new Error("An action is already pending for this order. Wait and refresh open orders.");
    this.busy.add(orderId);
    this.mutationVersion++;
  }

  private release(orderId: number): void {
    this.busy.delete(orderId);
    this.mutationVersion++;
  }

  private async pages(accountId: string, history: boolean): Promise<Row[]> {
    const orders: Row[] = [];
    let cursor: string | number = 0;
    const seen = new Set<string>();
    const now = this.now();
    for (let page = 0; page < 20; page++) {
      const result = row(await this.client.get<unknown>(`/v2/accounts/${encodeURIComponent(accountId)}/orders${history ? "/history" : ""}`, {
        limit: 100, cursor,
        ...(history ? { from: new Date(now - 90 * 86400000).toISOString(), to: new Date(now).toISOString(), order_by: "desc" } : {}),
      }));
      if (result.orders !== null && !Array.isArray(result.orders)) throw new Error("Aries returned an invalid orders response.");
      orders.push(...(Array.isArray(result.orders) ? result.orders.map(row).map((source) => history ? source : working(source)) : []));
      const next = result.nextCursor;
      if (next === 0 || next === "0" || next === undefined || next === null) return orders;
      if ((typeof next !== "string" && typeof next !== "number") || (typeof next === "number" && !Number.isSafeInteger(next)) || !/^\d+$/.test(String(next)) || seen.has(String(next))) {
        throw new Error("Aries returned an invalid orders cursor. Refresh orders before trading.");
      }
      seen.add(String(next));
      cursor = next;
    }
    throw new Error("Aries returned too many orders for this view. Review the complete order list in Aries.");
  }

  async listOpenOrders(): Promise<BrokerOrder[]> {
    const snapshotVersion = this.mutationVersion;
    const output: BrokerOrder[] = [];
    for (const account of await this.options.accounts()) {
      for (const source of await this.pages(account.accountId, false)) {
        if (!terminal.has(String(source.ordStatus))) output.push(this.remember(source, account, undefined, undefined, snapshotVersion));
      }
    }
    return output;
  }

  /**
   * An order row Aries pushed on the account socket, as the host order it
   * changes. A cancel or replacement arrives as a new client ID naming the
   * order it changes in `origClOrdId`, and keeps that order's host ID. A row
   * for an ID the order has since moved on from changes nothing: undefined.
   */
  applyPushedOrder(source: Record<string, unknown>, account: { accountId: string; isSim: boolean }): BrokerOrder | undefined {
    const pushed = working(source);
    const clOrdId = string(pushed.clOrdId);
    if (!clOrdId || (pushed.accountId !== undefined && pushed.accountId !== account.accountId)) return undefined;
    const key = (id: string) => JSON.stringify([account.accountId, id]);
    const original = string(pushed.origClOrdId);
    const id = this.ids.get(key(clOrdId)) ?? (original ? this.ids.get(key(original)) : undefined);
    const stored = id !== undefined ? this.orders.get(id) : undefined;
    if (stored && stored.clOrdId !== clOrdId && stored.clOrdId !== original) return undefined;
    try {
      return this.remember(pushed, account, undefined, stored && stored.clOrdId !== clOrdId ? id : undefined);
    } catch { return undefined; }
  }

  /** A missing open row is not a terminal status. Match the current native ID in history. */
  async getOrderStatus(orderId: number): Promise<BrokerOrder | null> {
    const stored = this.orders.get(orderId);
    if (!stored) return null;
    const snapshotVersion = this.mutationVersion;
    const account = (await this.options.accounts()).find((value) => value.accountId === stored.accountId);
    if (!account) throw new Error("Select an included Aries account.");
    for (const history of [false, true]) {
      // A cancel or replace made elsewhere is a newer row that names this one as its origClOrdId; history lists newest first.
      const source = (await this.pages(account.accountId, history)).find((value) => value.clOrdId === stored.clOrdId || value.origClOrdId === stored.clOrdId);
      if (source) {
        this.remember(source, account, undefined, source.clOrdId === stored.clOrdId ? undefined : orderId, snapshotVersion);
        if (snapshotVersion !== this.mutationVersion || this.busy.has(orderId)) return null;
        return { ...this.orders.get(orderId)!.order };
      }
    }
    return null;
  }

  /** History exposes cumulative fills, not individual execution IDs or timestamps. */
  async listExecutions(): Promise<BrokerExecution[]> {
    const snapshotVersion = this.mutationVersion;
    const output = new Map<string, BrokerExecution>();
    for (const account of await this.options.accounts()) {
      for (const source of await this.pages(account.accountId, true)) {
        if (!(number(source.cumQty)! > 0)) continue;
        const order = this.remember(source, account, undefined, undefined, snapshotVersion);
        const legs = sourceLegs(source);
        const fills = legs.length ? legs : [source];
        for (let index = 0; index < fills.length; index++) {
          const fill = fills[index]!;
          const price = number(fill.avgPrice) ?? (fills.length === 1 ? order.avgFillPrice : undefined);
          if (price === undefined) continue;
          const execId = `aries:${account.accountId}:${String(source.clOrdId)}:cumulative${legs.length ? `:leg${index}` : ""}`;
          output.set(execId, {
            execId, brokerInstanceId: this.options.brokerInstanceId, accountId: account.accountId, orderId: order.orderId, brokerOrderId: order.brokerOrderId,
            side: string(fill.side) ?? order.action, shares: order.filled * (legs.length ? number(fill.ratioQty) ?? 1 : 1), price,
            time: order.updatedAt, contract: legs.length ? this.contract({ ...fill, legs: [fill] }) : order.contract,
          });
        }
      }
    }
    return [...output.values()];
  }
}
