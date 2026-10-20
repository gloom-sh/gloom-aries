import * as hostBroker from "gloomberb/broker";
import type { BrokerConfigField } from "gloomberb/types/broker";

export const ARIES_CONFIG_FIELDS: BrokerConfigField[] = [
  { key: "clientToken", label: "Client ID", type: "text", required: true, placeholder: "ARI-PERSONAL-TK..." },
  { key: "clientSecret", label: "Client secret", type: "password", required: true },
  { key: "accounts", label: "Include accounts", type: "select", required: true, defaultValue: "simulation", options: [
    { value: "simulation", label: "Simulation only" }, { value: "live", label: "Live only" }, { value: "both", label: "Simulation and live" },
  ] },
  { key: "enableTrading", label: "Enable trading", type: "select", required: true, defaultValue: "false", options: [
    { value: "false", label: "Off (read only)" }, { value: "true", label: "On (orders allowed)" },
  ] },
];

export function ariesConfig(values: Record<string, unknown>) {
  return {
    clientToken: typeof values.clientToken === "string" ? values.clientToken.trim() : "",
    clientSecret: typeof values.clientSecret === "string" ? values.clientSecret.trim() : "",
    accounts: (values.accounts === "live" || values.accounts === "both" ? values.accounts : "simulation") as "live" | "both" | "simulation",
    enableTrading: values.enableTrading === "true" || values.enableTrading === true,
  };
}

/** Whether this Gloom keeps a broker's market data off Gloom Cloud (`BrokerAdapter.localMarketData`); older versions sync it. */
export const hostKeepsMarketDataLocal = (hostBroker as unknown as { LOCAL_BROKER_MARKET_DATA?: unknown }).LOCAL_BROKER_MARKET_DATA === true;

/**
 * Aries quotes and bars must not reach Gloom Cloud. This Gloom keeps them on the device, with Cloud
 * on; an older one would sync them, so there the profile needs Gloom Cloud switched off.
 */
export function assertLocalProfile(config: { disabledPlugins?: string[] }, keepsLocal = hostKeepsMarketDataLocal): void {
  if (keepsLocal || config.disabledPlugins?.includes("gloomberb-cloud")) return;
  throw new Error("This version of Gloom would sync Aries market data to Gloom Cloud. Update Gloom, or switch off Gloom Cloud in this profile.");
}
