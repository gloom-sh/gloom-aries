# Features

| Area | Support |
| --- | --- |
| Sign-in | Sign in with Aries in the browser (OAuth with PKCE), renewed on its own and kept on this device. A personal API client from Aries Client Center also works. |
| Accounts | Simulation and live accounts (`/v2/users/me/accounts`), balances, buying power and positions, with stock, ETF and option positions and short sides. |
| Quotes | Streamed over Aries' market WebSocket: bid, ask, last trade with its time, the day's volume and move, for stocks, ETFs and options, real-time including pre- and post-market trades. They feed Gloom's own quote stream, so quotes, the chart's live bar, option chains, OSA and the order ticket all update from it. While the socket is down, REST polling (delayed, marked as such) stands in. |
| Order updates | Pushed over Aries' account WebSocket: fills, cancels, replacements and rejections reach Gloom's order list and notifications as they happen. Gloom polls open orders while the socket is down. |
| Charts | Intraday to monthly bars from `/v1/chart/history`, including pre- and post-market bars when the chart asks for extended hours. |
| Options | Chains with bid, ask, last, volume, open interest and implied volatility, standard 100-share contracts. |
| Orders | Market, limit, stop and stop-limit for stocks and ETFs, with Aries' time-in-force choices, and extended hours on live accounts. Single options and spreads of 2 to 4 legs, DAY or GTC. Preview, place, change and cancel. |
| Order history | 90 days of order history as cumulative fills per order (and per leg), not individual executions. |

See [trading](trading.md) for the order mapping and [Aries API notes](aries-api-notes.md) for API behavior the adapter works around.

## Not supported

- Level 2, time and sales, and streamed Greeks
- Explicit sell-short and buy-to-cover instructions
- Prediction markets, news and fundamentals
- The browser build: Aries' API does not allow cross-origin requests
