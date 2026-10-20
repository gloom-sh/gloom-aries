# Trading

The plugin implements Gloom's `BrokerAdapter` order methods: `getTradingCapabilities`, `previewOrder`, `placeOrder`, `modifyOrder`, `cancelOrder`, `listOpenOrders`, `getOrderStatus` and `listExecutions`. Gloom's own order ticket, review, confirmation and Orders view sit on top; the plugin adds no trading pane. Hosts without the shared ticket keep the read-only broker views.

## Order mapping

| Area | Behavior |
| --- | --- |
| Permission | Trading defaults off. Preview, place, change and cancel fail before any request unless it is enabled, and the account must be one the profile includes. Open orders and history stay readable with trading off. |
| Accounts | Every order names its account; there is no fallback account. A change keeps the original account, instrument and side; a cancel uses the loaded order's account. Simulation or live comes from Aries' `is_sim`, and every preview says which. |
| Order types | MKT, LMT, STP and STP LMT map to MARKET, LIMIT, STOP and STOP_LIMIT. Quantities and prices go as decimal strings, at most five price decimals. A price the order type does not use is dropped, since Aries' order reads carry zero placeholders. |
| Sides | BUY and SELL in USD. The host cannot ask for SELL_SHORT or BUY_TO_COVER; existing short-side orders still read and cancel correctly. |
| Time in force | Stocks: DAY, GTC, IOC, FOK, EXTENDED_HOURS, AT_THE_OPENING and AT_THE_CLOSE (also EXT, OPG/ATO, MOC/ATC). The host's outside-hours flag maps DAY to EXTENDED_HOURS. Options and spreads: DAY or GTC only, as Aries requires once `legs` is present. |
| Single options | One standard 100-share contract, by OSI symbol or by underlying, expiry, right and strike, in whole contracts. Mismatched symbol and fields, adjusted contracts and incomplete definitions are refused. |
| Open or close | The host has no position-effect field, so each option leg opens or closes from fresh signed holdings. An order that would cross through zero is refused. A change keeps the original effect. |
| Preview | Estimated cost, fees, commission and buying-power impact map to Gloom's preview. Warnings name the account mode, each leg's open or close, estimated margin and option requirements. A rejected preview, or one without estimates, blocks the order. Upstream warning text is replaced by a fixed risk warning, because Aries' messages can echo request data. |
| Placement | Places only after a fresh preview without errors. An acknowledgement is not a fill. |
| Identity | Aries' `clOrdId` is the host's `brokerOrderId`. Host order numbers are session-local handles mapped to `[account, clOrdId]`; a change keeps the handle and moves it to the new `clOrdId`. Refresh open orders after reconnecting. |
| Change and cancel | Use the current `clOrdId` and the stored account and contract fields. One change at a time per order; reads that start during a change cannot overwrite its acknowledgement. Any unclear outcome marks the order unknown until refreshed. |
| Order status | `getOrderStatus` finds the order on the open list, then in history, following a newer row whose `origClOrdId` names it (see [API notes](aries-api-notes.md#orders)). Not found returns null, never "cancelled". |
| Executions | 90 days of order history as cumulative filled quantity and average price per order, and per leg for spreads. These are order summaries (`executionKind: "order-summaries"`), not individual fills: no fill IDs, exact fill times or per-fill commissions. |
| Errors | Fixed messages for HTTP 400, 401, 403, 404, 409, 422, 429, network and server failures; raw upstream text is never shown. Reads retry a bounded number of times and honour `Retry-After`. Order requests are never retried. |

## Spreads

Gloom sends a spread as one order on a combo contract (`secType: "BAG"`, the underlying's symbol) with `legs`, each `{ contract, action, ratio }`, and the adapter declares `maxLegs: 4` for it. The order's `action` is BUY for a net debit and SELL for a net credit, and `limitPrice` is the net per spread, always positive. Market and limit, DAY or GTC.

| Gloom | Aries |
| --- | --- |
| `legs[].action`, `ratio` | each leg's `side` and `ratioQty` |
| leg contract | `putCall`, `strikePrice`, `maturity`, underlying `symbol` |
| open or close | each leg's `positionEffect`, from fresh signed holdings |
| `quantity` | `qty`, the number of spreads |
| `limitPrice`, BUY | `price`, the net debit |
| `limitPrice`, SELL | `price`, the net credit sent negative |
| `action` | `side`, with a leg on that side sent last |

The last two rows follow from how Aries reads a spread ([API notes](aries-api-notes.md#spreads)). Reading a spread back, the price's sign gives BUY or SELL. A change resends the legs with their original effects and may not change them. A cancel omits `securityType`.

On a simulation account, debit and credit verticals were placed, listed with their legs, changed and cancelled, and a filled credit vertical was closed with a debit spread. A credit spread filling at its limit rather than at the market has not been observed.
