import type { GloomPlugin } from "gloomberb/types/plugin";
import { ariesBroker, setAriesLocalGuard } from "./src/broker-adapter";
import { assertLocalProfile } from "./src/config";
import { ariesAccountsTemplate } from "./src/headless";
import { ariesMarketCapability, setAriesMarketConfig } from "./src/market-provider";

export const ariesPlugin: GloomPlugin = {
  id: "aries", name: "Aries", version: "0.1.0",
  description: "Aries brokerage accounts, quotes and orders",
  toggleable: true, targets: ["cli", "tui", "desktop"], hosts: ["api.aries.com"],
  capabilities: [ariesMarketCapability],
  setup(ctx) {
    setAriesLocalGuard(
      () => assertLocalProfile(ctx.getConfig()),
      (id) => ctx.getConfig().brokerInstances.find((instance) => instance.id === id),
      // A renewed sign-in is saved with the profile on this device; broker settings never sync.
      (id, values) => ctx.updateBrokerInstance?.(id, values),
    );
    setAriesMarketConfig(() => ctx.getConfig());
    ctx.registerBroker(ariesBroker);
    ctx.registerPaneTemplate(ariesAccountsTemplate);
  },
  dispose() { ariesBroker.dispose(); setAriesMarketConfig(undefined); },
};
export default ariesPlugin;
