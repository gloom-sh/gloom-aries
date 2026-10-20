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

export function assertLocalProfile(config: { disabledPlugins?: string[] }): void {
  if (!config.disabledPlugins?.includes("gloomberb-cloud")) {
    throw new Error("Aries requires a dedicated local profile with Gloom Cloud disabled. Disable Gloom Cloud in this profile before connecting.");
  }
}
