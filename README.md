# Aries for Gloom

Aries brokerage accounts, quotes, charts, option chains and orders in Gloom. Connect your own personal-token client to see simulation or live accounts, balances and positions, and trade stocks, ETFs, options and option spreads through Gloom's order ticket. This is an independent plugin, not made by or affiliated with Aries.

To try it with a simulation account, follow [TESTING.md](TESTING.md).

## Setup

1. Use Gloom 0.16.2 or later for accounts, quotes, charts and option chains. Trading needs a Gloom release with the shared order ticket, and spreads one with spread orders. Gloom Cloud can stay on with a release that keeps Aries market data local; older releases ask you to switch it off (see [Privacy and storage](#privacy-and-storage)).
2. In [Aries Client Center](https://app.aries.com/client-center/api), open the **API** tab and choose **Generate Key**. Create a personal-token client; its Client ID starts with `ARI-PERSONAL-TK.`. Partner clients do not support this connection method. Save the Client Secret when it is shown, because Aries shows it only once.
3. Request these scopes:
   - `account:information` for accounts, balances and positions.
   - `market:information` and `market:supplemental` for quotes, charts and option chains. Supplemental supplies timestamped stock trades and option chains; without it, quotes have no trustworthy source time.
   - `order:information` to read orders and order history.
   - `order:execution` only if you intend to trade, including order previews.
4. Install the plugin, open **Brokers**, add **Aries** and enter the Client ID and Client Secret. **Accounts** defaults to **Simulation** and **Enable trading** to **Off**. Choose **Live** or **Both** only when you mean to import those accounts.
5. Connect. Brokers and Portfolio show the accounts and holdings, labelled simulation or live. Quotes, charts and option chains appear wherever Gloom shows a ticker. With trading enabled, a ticker's **Trade** tab places orders and **Orders** lists open orders and order history. `ARA` opens Brokers and provides the read-only **Aries Accounts** report (`gloomberb fn ARA`, `--view positions` for holdings).

Keep credentials out of shell arguments, pane parameters, screenshots and shared layouts. The Client ID field is plain text, so it is visible while editing, and the Brokers pane can show full account identifiers.

## What it supports

| Area | Support |
| --- | --- |
| Accounts | Simulation and live accounts (`/v2/users/me/accounts`), balances, buying power and positions, with stock, ETF and option positions and short sides. |
| Quotes | Streamed over Aries' market WebSocket: bid, ask, last trade with its time, the day's volume and move, for stocks, ETFs and options, real-time including pre- and post-market trades. They feed Gloom's own quote stream, so quotes, the chart's live bar, option chains, OSA and the order ticket all update from it. While the socket is down, REST polling (delayed, marked as such) stands in. |
| Order updates | Pushed over Aries' account WebSocket: fills, cancels, replacements and rejections reach Gloom's order list and notifications as they happen. Gloom polls open orders while the socket is down. |
| Charts | Intraday to monthly bars from `/v1/chart/history`, including pre- and post-market bars when the chart asks for extended hours. |
| Options | Chains with bid, ask, last, volume, open interest and implied volatility, standard 100-share contracts. |
| Orders | Market, limit, stop and stop-limit for stocks and ETFs, with Aries' time-in-force choices and extended hours. Single options and spreads of 2 to 4 legs, DAY or GTC. Preview, place, change and cancel. |
| Order history | 90 days of order history as cumulative fills per order (and per leg), not individual executions. |

See [trading](docs/trading.md) for the order mapping and [Aries API notes](docs/aries-api-notes.md) for API behavior the adapter works around.

Not supported: Level 2, time and sales and streamed Greeks, explicit sell-short and buy-to-cover instructions, OAuth sign-in for other users, prediction markets, news and fundamentals, and the browser build (Aries' API does not allow cross-origin requests).

## Trading safety

Trading is off until enabled per profile. With it off, preview, placement, changes and cancellation fail before any request reaches Aries; reading orders still works. Every order needs an explicitly selected account, never a silent live fallback, and the preview repeats whether the account is simulation or live. Gloom's ticket adds review and typed confirmation for live accounts.

An acknowledgement is not a fill. A timeout can leave an order's outcome unknown: refresh orders, or check in Aries, before trying again. The adapter never retries an order request on its own.

On a simulation account, stock orders were placed and cancelled, and single options and spreads placed, changed and cancelled, against the Aries API. Live-account orders are not verified.

## Privacy and storage

Requests go straight from your machine to `https://api.aries.com`. The access token lives in memory only. Credentials and raw Aries error bodies are never logged or shown.

With Gloom Cloud on:

- **Syncs:** the profile's name, your Aries accounts, balances and positions, like any broker's. Daily roundups, the weekly brief, position alerts, the mobile app and Ask Gloom use them.
- **Never leaves your machine:** the Client ID and Client Secret, and Aries quotes and bars. The Aries terms restrict redistributing market data, and Gloom Cloud has its own.
- **Keep everything local:** in Brokers, edit the Aries profile and set **Account data** to **Keep on this device**. Its accounts and positions then stay off Cloud too, and the features above go without them.

Gloom stores broker settings, Client Secret included, in plaintext in the profile directory, so protect it. Gloom releases from before this sync Aries quotes; there the plugin asks you to switch off Gloom Cloud before it connects.

## Terms

Use your own authorized Aries client and safeguard its credentials. The [Aries Developer Agreement](https://finance.dev/legal/developer-agreement) prohibits sublicensing and benchmarking without consent and limits collecting, caching, aggregating and redistributing data to what your application needs. The plugin adds no bulk download or export; market data stays in Gloom's normal local caches.

## Development

```sh
bun install
bun run typecheck
bun run test
```

Tests use synthetic fixtures and local mock servers; they never call Aries. CI type-checks and tests against the Gloom revision pinned in `.github/workflows/ci.yml`.
