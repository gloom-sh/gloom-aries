# Aries API notes

How the Aries REST API behaved while building this plugin, where it differs from what a client would assume, and what the adapter does about it. Observations come from a personal-token client on simulation accounts in October 2026, against the [Finance.dev documentation](https://finance.dev/llms-full.txt) and [OpenAPI schema](https://finance.dev/openapi.json).

## Accounts

- Account requests take `trading_account_id` from `GET /v2/users/me/accounts`. The integer `id` from the older account list is not interchangeable with it.
- Simulation and live accounts share one client and the same user-scoped market data. Quote endpoints take no account, so a simulation and a live account cannot be told apart by their quotes.

## Quotes

- **Chart quotes have no source time.** The chart quote envelope (`s`, `d`, `n`, `v`) gives `lp` with no timestamp and no delayed or real-time flag. Its `lp` matched the equity details' `lastPrice` and stayed unchanged while details `price` moved and its trade timestamp advanced, so the details timestamp cannot be attached to `lp` either.
- **The last-trade endpoint does.** `GET /v1/stocks/last-trade` returns `results.price` with its `sipTimestamp` and `status: DELAYED`. It needs `market:supplemental`. Trades it returned were 15 to 77 minutes old. The adapter quotes stocks from it, caches each symbol for 60 seconds and reads it one symbol at a time, and labels quotes delayed.
- **Option details have no trade time.** `/v1/marketdata/options/details` gives prices without a usable timestamp, so the adapter leaves the source time unknown (`lastUpdated: 0`). Gloom's market data drops an undated quote, so an option has a current quote only from the socket. Without `lastPrice`, the adapter quotes the mid. Option chains do carry trade and quote times.
- The chart WebSocket documents `isDelayed` but says it is currently always false.

## WebSockets

The adapter opens two sockets per profile, each only while something needs it: the market socket (`wss://api.aries.com/v1/market/ws`) while quotes are subscribed, and the account socket (`/v1/accounts/ws`) while Gloom's order feed listens. Both sign in with the REST access token in a `POST /auth` request, are pinged every 30 seconds, reconnect with backoff from 1 to 60 seconds, and are renewed by reconnecting a minute before the session ends (`expiresIn`: 45 minutes for market data, 65 for accounts).

- **Messages are NDJSON.** A frame can carry several newline-separated messages.
- **Equity fields are strings, option fields numbers.** `"340.2000"` for a stock's bid, `5.41` for an option's.
- **Stock trades are real-time, in every session.** A pre-market trade arrived 25 ms after its `tradeTimestamp` (ISO, with the New York offset). Quotes from the socket are therefore marked live.
- **`price` is the last trade, `lastPrice` the last regular-session trade.** Before the open, a stock's `lastPrice` is yesterday's close, `closePrice` the close before that, and `netChange` is `price - lastPrice`. The adapter takes the previous close as `price - netChange`. An option's `netChange` can still be the previous session's while its `lastPrice` equals `closePrice`, so an option's move is taken against `closePrice`, as the REST quote does.
- **A stock's `midPrice` can be wrong.** One snapshot gave 302.455 against a 340.20 / 340.58 market. The adapter computes the mark from bid and ask.
- **Before the open, `openPrice`, `highPrice` and `lowPrice` are the previous session's.** The adapter leaves the day's range out until the regular session.
- **The session comes from `marketStatus`.** It arrives after sign-in and says `earlyHours`, `afterHours` and `market` (`open`, `extended-hours`, `closed`); the adapter uses it as the quote's market state.
- **Snapshots, then changes only.** Each subscription answers with a snapshot per type (`quote`, `trade`), then pushes only the fields that changed. The adapter keeps the fields per subscribed symbol to build whole quotes, and repeats an unchanged quote once a minute while the socket is up so Gloom does not take a quiet contract for a stale stream.
- **An unknown symbol is not an error.** It gets an empty snapshot (`{ "hasOptions": true }`) and nothing after.
- **The account socket confirms each account with a snapshot.** `subscribed` with `topic: account` carries the account, positions and `ordersV2`, today's orders including filled ones; `account.order` events follow, in the same row format as `/v2/accounts/{id}/orders`. Simulation accounts stream too.

## Charts and options

- `/v1/chart/history` returns source-timestamped OHLC. With `includeExtended`, intraday bars include pre- and post-market trading; the adapter asks for it when the chart shows extended hours, and for any intraday request made outside the regular session (09:30 to 16:00 New York time on weekdays), so a chart opened after the close shows the evening session.
- Option chain endpoints use `O:`-prefixed OSI symbols (`O:AAPL261026C00345000`); chart history takes the plain OSI symbol. The adapter maps both to the plain form.
- Chains include adjusted contracts; the adapter keeps standard 100-share contracts only.

## Orders

- **A changed order stays on the open list as REPLACED.** After a successful replace, `/v2/accounts/{id}/orders` lists the working order with `ordStatus: REPLACED` ("the modification took effect") and `leavesQty` above zero. Treating REPLACED as final makes a repriced order disappear. The adapter reads REPLACED with remaining quantity on the open list as working.
- **A cancel is a new row.** In `/orders/history` (newest first), a cancel or replace is a new row with a new `clOrdId` whose `origClOrdId` names the order it acted on. The adapter follows that link to read an order's latest status, and keeps the order's host handle on the newer row. A replacement's new `clOrdId` becomes the order's native ID; a cancel's does not, since it names a request, not an order. The account socket pushes these rows the same way.
- The open-orders endpoint also returned already cancelled orders. The adapter filters final states.
- Order reads carry `"0"` for prices the type does not use (a `stopPrice` on a LIMIT order). Sent back in a replace, that turns the order into a stop order, so the adapter drops prices the type does not use.
- Simulation does not run `timeInForce: EXTENDED_HOURS` orders. Three stock LIMIT orders, placed during regular hours on two days, stayed `PENDING_NEW` with text "upstream pending" and were never acknowledged; a cancel or replacement came back "TE: Order cannot be found" and left them pending until they dropped off the list at the end of the day. The adapter does not offer extended hours on a simulation account, and reports a pending order whose cancel or change found nothing as ended (rejected), since it is not working anywhere.
- Options and spreads accept DAY or GTC only once `legs` is present.

## Spreads

Aries takes 2 to 4 option legs as one atomic order ([multi-leg option orders](https://finance.dev/api-reference/orders/multi-leg-option)). Three behaviors were not clear from the documentation:

- **The order's side is its last leg's.** Whatever `side` the request sends, Aries stores and returns the side of the last leg in `legs`. The adapter sends a leg on the order's own side last, so a debit spread reads back as BUY and a credit as SELL.
- **The price is a signed net debit.** A credit is a negative price. A short call vertical sent as SELL at +4.95 (a credit no market pays) filled at once at its 1.64 market credit, as if +4.95 were the most it would pay; the same spread at -4.95 rested. The adapter sends credits negative and reads the price's sign back as the side.
- **A spread cancel takes no security type.** A cancel with `securityType: OPT` and no single-contract option fields returns HTTP 400. The adapter omits `securityType` for spreads.

Legs may also read back in a different order than they were sent.

## Access and limits

- Personal-token (client-credentials) access tokens last 900 seconds with no refresh token; the adapter renews in memory before expiry, one renewal at a time.
- No numeric REST rate limit is documented. The adapter honours HTTP 429 and `Retry-After`, polls quotes only while they are subscribed and the market socket is down (15 seconds by default), and batches chart quotes 50 symbols at a time.
- Three unauthenticated cross-origin probes (the token preflight, a GET preflight and a GET) returned HTTP 403 without `Access-Control-Allow-Origin`, so the API cannot be called from a browser and the plugin does not ship Gloom's web target.
- Error bodies are not shown to users: a fixed message stands in for each status, in case a body echoes request data.

## OAuth for other users

The plugin only supports personal-token clients. For a partner integration that signs in other users:

1. Authorization-code and PKCE access tokens last 3,600 seconds. The schema's refresh-token example is 31,536,000 seconds, not a guaranteed lifetime: honour `refresh_token_expires_in` and replace a rotated refresh token.
2. Both flows need a pre-registered redirect URI matching exactly. The guide requires HTTPS in production and does not document loopback HTTP, variable ports or custom schemes, which a desktop app would need.
3. Confidential clients send `client_secret`; PKCE uses S256, a 43 to 128 character verifier and random `state`, with no secret. Authorization codes are single-use and documented as valid for ten minutes.
4. Refresh needs only `client_id`, `grant_type: refresh_token` and `refresh_token`.
5. Key creation in Client Center is self-service, but the [Developer Agreement](https://finance.dev/legal/developer-agreement) requires written authorization to facilitate other users' account access or trading.
