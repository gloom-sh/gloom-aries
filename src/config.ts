import * as hostBroker from "gloomberb/broker";
import type { BrokerConfigField } from "gloomberb/types/broker";
import type { BrokerInstanceConfig } from "gloomberb/types/config";

export const ARIES_CONFIG_FIELDS: BrokerConfigField[] = [
  { key: "auth", label: "Sign in with", type: "select", required: true, defaultValue: "account", options: [
    { value: "account", label: "Aries account", description: "Sign in to Aries in your browser" },
    { value: "personal", label: "Personal API client", description: "A client ID and secret from Aries Client Center" },
  ] },
  { key: "clientToken", label: "Client ID", type: "text", required: true, placeholder: "ARI-PERSONAL-TK...", dependsOn: { key: "auth", value: "personal" } },
  { key: "clientSecret", label: "Client secret", type: "password", required: true, dependsOn: { key: "auth", value: "personal" } },
  { key: "accounts", label: "Include accounts", type: "select", required: true, defaultValue: "simulation", options: [
    { value: "simulation", label: "Simulation only" }, { value: "live", label: "Live only" }, { value: "both", label: "Simulation and live" },
  ] },
  { key: "enableTrading", label: "Enable trading", type: "select", required: true, defaultValue: "false", options: [
    { value: "false", label: "Off (read only)" }, { value: "true", label: "On (orders allowed)" },
  ] },
];

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

/**
 * How a profile signs in: its own Aries account in the browser, or a personal API client. A profile
 * saved before sign-in existed has a client ID and no choice, and keeps using it.
 */
export function ariesAuth(values: Record<string, unknown>): "account" | "personal" {
  if (values.auth === "account" || values.auth === "personal") return values.auth;
  return text(values.clientToken) ? "personal" : "account";
}

/** What a session is: changing any of these starts a new one. Sign-in tokens are not part of it, so renewing them keeps the session. */
export function ariesConfig(values: Record<string, unknown>) {
  const auth = ariesAuth(values);
  return {
    auth,
    clientToken: auth === "personal" ? text(values.clientToken) : "",
    clientSecret: auth === "personal" ? text(values.clientSecret) : "",
    accounts: (values.accounts === "live" || values.accounts === "both" ? values.accounts : "simulation") as "live" | "both" | "simulation",
    enableTrading: values.enableTrading === "true" || values.enableTrading === true,
  };
}

/** The tokens an Aries account sign-in left in a profile. They stay on this device and are never shown. */
export interface AriesTokens { accessToken?: string; accessTokenExpiresAt?: number; refreshToken?: string }
const TOKEN_KEYS = ["accessToken", "accessTokenExpiresAt", "refreshToken"] as const;

export function ariesTokens(values: Record<string, unknown>): AriesTokens {
  const expires = Number(values.accessTokenExpiresAt);
  return {
    ...(text(values.accessToken) ? { accessToken: text(values.accessToken) } : {}),
    ...(Number.isFinite(expires) && expires > 0 ? { accessTokenExpiresAt: expires } : {}),
    ...(text(values.refreshToken) ? { refreshToken: text(values.refreshToken) } : {}),
  };
}

/** Config values that replace a profile's tokens: unset keys clear them. */
export function ariesTokenValues(tokens: AriesTokens | null): Record<string, unknown> {
  return Object.fromEntries(TOKEN_KEYS.map((key) => [key, tokens?.[key]]));
}

/** The form's values: the fields, never the tokens. */
export function ariesFormValues(instance: BrokerInstanceConfig): Record<string, unknown> {
  const config = ariesConfig(instance.config);
  return {
    auth: config.auth,
    clientToken: text(instance.config.clientToken),
    clientSecret: text(instance.config.clientSecret),
    accounts: config.accounts,
    enableTrading: String(config.enableTrading),
  };
}

/**
 * A saved form. An account profile keeps the sign-in it has, unless the form was saved on another
 * method, and one that has none yet signs in on its first sync. A personal profile keeps no tokens.
 */
export function ariesConfigFromForm(values: Record<string, unknown>, previous?: BrokerInstanceConfig): Record<string, unknown> {
  const auth = ariesAuth({ ...values, auth: values.auth ?? "account" });
  const base = { auth, accounts: values.accounts, enableTrading: values.enableTrading };
  if (auth === "personal") return { ...base, clientToken: text(values.clientToken), clientSecret: text(values.clientSecret) };
  const kept = previous && ariesAuth(previous.config) === "account" ? ariesTokens(previous.config) : {};
  return { ...base, ...kept, ...(kept.refreshToken || kept.accessToken ? {} : { signInPending: true }) };
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
