import { assetDataProvider } from "gloomberb/capabilities";
import type { BrokerAdapter } from "gloomberb/types/broker";
import type { AppConfig, BrokerInstanceConfig } from "gloomberb/types/config";
import type { AssetDataProvider, MarketDataRequestContext } from "gloomberb/types/data-provider";
import { ariesBroker, type AriesSessionHistory } from "./broker-adapter";
import { assertLocalProfile } from "./config";
import { parseOptionSymbol } from "./instruments";
import { ariesMiss } from "./market-data";

const US_EXCHANGES = new Set(["", "SMART", "NASDAQ", "NMS", "NGM", "NCM", "NYSE", "NYS", "AMEX", "ARCA", "NYSE ARCA", "NYSEARCA", "BATS", "BAT", "BTS", "IEX", "OPRA", "XNAS", "XNYS", "XASE", "ARCX", "EDGX", "EDGA", "CBOE"]);

function supported(ticker: string, exchange?: string, context?: MarketDataRequestContext): boolean {
  if (context?.brokerId && context.brokerId !== "aries") return false;
  const contract = context?.instrument;
  if (contract?.brokerId && contract.brokerId !== "aries") return false;
  if (contract?.secType && !["STK", "ETF", "OPT"].includes(contract.secType.toUpperCase())) return false;
  const option = !!parseOptionSymbol(contract?.localSymbol ?? ticker);
  const venue = (exchange ?? "").toUpperCase();
  // The host keys visible option-chain quotes under this synthetic exchange.
  if (venue === "OPTIONS") return option;
  if (!US_EXCHANGES.has(venue)) return false;
  return option || /^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker.toUpperCase());
}

function selectedProfile(config: AppConfig, context?: MarketDataRequestContext): BrokerInstanceConfig {
  assertLocalProfile(config);
  const profiles = config.brokerInstances.filter((instance) => instance.brokerType === "aries" && instance.enabled !== false);
  if (profiles.length === 0) throw new Error("Connect an Aries profile in Brokers first.");
  if (profiles.length !== 1) throw new Error("Aries market data requires exactly one enabled Aries profile. Disable the other profiles before continuing.");
  const instance = profiles[0]!;
  // Not this provider's instrument: a miss, so the host asks another source without logging a failure.
  if ([context?.brokerInstanceId, context?.instrument?.brokerInstanceId].some((requested) => requested && requested !== instance.id)) throw ariesMiss("This instrument belongs to a different broker profile.");
  return instance;
}

/** The CLI market router reads static capabilities, without registering broker adapters. */
export function createAriesMarketProvider(getConfig: () => AppConfig, broker: BrokerAdapter & { history?: AriesSessionHistory } = ariesBroker): AssetDataProvider {
  const profile = (context?: MarketDataRequestContext): BrokerInstanceConfig => selectedProfile(getConfig(), context);
  const availableProfile = (context?: MarketDataRequestContext): BrokerInstanceConfig | undefined => {
    try { return profile(context); } catch { return undefined; }
  };
  const target = (ticker: string, exchange?: string, context?: MarketDataRequestContext): BrokerInstanceConfig => {
    const instance = profile(context);
    if (!supported(ticker, exchange, context)) throw ariesMiss("Aries market data supports US stocks, ETFs and standard options.");
    return instance;
  };
  const provider: AssetDataProvider = {
    id: "aries",
    name: "Aries",
    priority: 50,
    canProvide(ticker, exchange, context) {
      return supported(ticker, exchange, context) && availableProfile(context) !== undefined;
    },
    getQuote(ticker, exchange, context) {
      return broker.getQuote!(ticker, target(ticker, exchange, context), exchange, context?.instrument);
    },
    async getTickerFinancials(ticker, exchange, context) {
      const quote = await provider.getQuote(ticker, exchange, context);
      return { quote, annualStatements: [], quarterlyStatements: [], priceHistory: [] };
    },
    async getExchangeRate(currency) {
      profile();
      if (currency.toUpperCase() !== "USD") throw new Error("Aries does not provide currency conversion rates.");
      return 1;
    },
    async getArticleSummary() { return null; },
    search(query) { return broker.searchInstruments!(query, profile()); },
    getPriceHistory(ticker, exchange, range, context) {
      return broker.getPriceHistory!(ticker, target(ticker, exchange, context), exchange, range, context?.instrument);
    },
    getPriceHistoryForResolution(ticker, exchange, range, resolution, context) {
      if (broker.history) return broker.history.getPriceHistoryForResolution(ticker, target(ticker, exchange, context), range, resolution, context?.instrument, context?.historySession);
      return broker.getPriceHistoryForResolution!(ticker, target(ticker, exchange, context), exchange, range, resolution, context?.instrument);
    },
    // Says when the bars include pre-market and after-hours, so the chart opens the day at 04:00 New York.
    async getPriceHistoryForResolutionWithMetadata(ticker, exchange, range, resolution, context) {
      const points = await provider.getPriceHistoryForResolution!(ticker, exchange, range, resolution, context);
      const extendedHours = !!broker.history && context?.historySession === "extended" && /^\d+(m|h)$/.test(resolution);
      return { points, resolution, ...(extendedHours ? { extendedHours: true } : {}) };
    },
    getDetailedPriceHistory(ticker, exchange, startDate, endDate, barSize, context) {
      if (broker.history) return broker.history.getDetailedPriceHistory(ticker, target(ticker, exchange, context), startDate, endDate, barSize, context?.instrument, context?.historySession);
      return broker.getDetailedPriceHistory!(ticker, target(ticker, exchange, context), exchange, startDate, endDate, barSize, context?.instrument);
    },
    getChartResolutionSupport(ticker, exchange, context) {
      return broker.getChartResolutionSupport!(ticker, target(ticker, exchange, context), exchange, context?.instrument);
    },
    getChartResolutionCapabilities(ticker, exchange, context) {
      return broker.getChartResolutionCapabilities!(ticker, target(ticker, exchange, context), exchange, context?.instrument);
    },
    getOptionsChain(ticker, exchange, expirationDate, context) {
      return broker.getOptionsChain!(ticker, target(ticker, exchange, context), exchange, expirationDate, context?.instrument);
    },
    subscribeQuotes(targets, onQuote) {
      if (!targets.length) return () => {};
      const instance = availableProfile();
      if (!instance) return () => {};
      // The host's stream router does not call canProvide per target. It can
      // include unrelated markets alongside this pane's underlying/options.
      const accepted = targets.filter((item) => supported(item.symbol, item.exchange, item.context)
        && availableProfile(item.context)?.id === instance.id);
      if (!accepted.length) return () => {};
      return broker.subscribeQuotes!(instance, accepted, onQuote);
    },
  };
  return provider;
}

let runtimeConfig: (() => AppConfig) | undefined;
export function setAriesMarketConfig(getConfig: (() => AppConfig) | undefined): void { runtimeConfig = getConfig; }

export const ariesMarketProvider = createAriesMarketProvider(() => {
  if (!runtimeConfig) throw new Error("Open Aries in a dedicated local profile first.");
  return runtimeConfig();
});
export const ariesMarketCapability = assetDataProvider(ariesMarketProvider);
