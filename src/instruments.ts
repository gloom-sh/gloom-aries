import type { BrokerContractRef } from "gloomberb/types/instrument";

export function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  if (typeof value === "string" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseOptionSymbol(value: string): {
  symbol: string;
  underlying: string;
  expiration: string;
  right: "C" | "P";
  strike: number;
} | null {
  const symbol = value.trim().toUpperCase().replace(/^O:/, "").replace(/\s+/g, "");
  const match = /^([A-Z][A-Z0-9.]{0,5})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(symbol);
  if (!match) return null;
  const expiration = `20${match[2]}-${match[3]}-${match[4]}`;
  const date = new Date(`${expiration}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== expiration) return null;
  return { symbol, underlying: match[1]!, expiration, right: match[5] as "C" | "P", strike: Number(match[6]) / 1000 };
}

export function optionBrokerContract(value: string, instanceId?: string): BrokerContractRef | undefined {
  const parsed = parseOptionSymbol(value);
  if (!parsed) return undefined;
  return {
    brokerId: "aries",
    brokerInstanceId: instanceId,
    symbol: parsed.underlying,
    localSymbol: parsed.symbol,
    secType: "OPT",
    currency: "USD",
    lastTradeDateOrContractMonth: parsed.expiration.replace(/-/g, ""),
    right: parsed.right,
    strike: parsed.strike,
    multiplier: "100",
  };
}

export function ariesInstrumentSymbol(ticker: string, instrument?: BrokerContractRef | null): string {
  const symbol = (instrument?.localSymbol || ticker).trim().toUpperCase();
  return parseOptionSymbol(symbol)?.symbol ?? symbol;
}
