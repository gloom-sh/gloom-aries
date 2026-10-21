# Privacy, storage and terms

## Where requests go

Requests go straight from your machine to `https://api.aries.com`. Tokens, credentials and raw Aries error bodies are never logged or shown.

Signing in opens `app.aries.com` in your browser. Aries sends the browser back to `api.gloom.sh/brokers/aries/callback`, the address it registered for Gloom, and that page passes it straight on to Gloom on `127.0.0.1` with the one-time code. Gloom's server exchanges, stores and logs nothing, and the code is useless without the key Gloom keeps on your machine for that sign-in (PKCE). Gloom then exchanges it with Aries directly.

## With Gloom Cloud on

- **Syncs:** the profile's name, your Aries accounts, balances and positions, like any broker's. Daily roundups, the weekly brief, position alerts, the mobile app and Ask Gloom use them.
- **Never leaves your machine:** your Aries sign-in, a personal Client ID and Client Secret, and Aries quotes and bars. The Aries terms restrict redistributing market data, and Gloom Cloud has its own.
- **Keep everything local:** in Brokers, edit the Aries profile and set **Account data** to **Keep on this device**. Its accounts and positions then stay off Cloud too, and the features above go without them.

## Storage

Gloom stores broker settings in plaintext in the profile directory, the sign-in's tokens and a Client Secret included, so protect that directory. Removing the Aries profile deletes them. Market data stays in Gloom's normal local caches.

## Terms

Sign in only to your own Aries account, and safeguard a personal client's credentials. The [Aries Developer Agreement](https://finance.dev/legal/developer-agreement) prohibits sublicensing and benchmarking without consent.

It also limits collecting, caching, aggregating and redistributing data to what your application needs. The plugin adds no bulk download or export.
