# Privacy, storage and terms

## Where requests go

Requests go straight from your machine to `https://api.aries.com`. The access token lives in memory only. Credentials and raw Aries error bodies are never logged or shown.

## With Gloom Cloud on

- **Syncs:** the profile's name, your Aries accounts, balances and positions, like any broker's. Daily roundups, the weekly brief, position alerts, the mobile app and Ask Gloom use them.
- **Never leaves your machine:** the Client ID and Client Secret, and Aries quotes and bars. The Aries terms restrict redistributing market data, and Gloom Cloud has its own.
- **Keep everything local:** in Brokers, edit the Aries profile and set **Account data** to **Keep on this device**. Its accounts and positions then stay off Cloud too, and the features above go without them.

Gloom releases from before this sync Aries quotes. There the plugin asks you to switch off Gloom Cloud before it connects.

## Storage

Gloom stores broker settings, the Client Secret included, in plaintext in the profile directory, so protect that directory. Market data stays in Gloom's normal local caches.

## Terms

Use your own authorized Aries client and safeguard its credentials. The [Aries Developer Agreement](https://finance.dev/legal/developer-agreement) prohibits sublicensing and benchmarking without consent.

It also limits collecting, caching, aggregating and redistributing data to what your application needs. The plugin adds no bulk download or export.
