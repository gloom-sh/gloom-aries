# Aries for Gloom

Trade your Aries account from Gloom: accounts, live quotes, charts, option chains and orders.

![Gloom's order ticket beside an AAPL chart, with the draft limit and average cost drawn on it](docs/images/ticket.png)

## Set up

1. In [Aries Client Center → API](https://app.aries.com/client-center/api), choose **Generate Key** and copy the Client Secret. It is shown once.
2. Run `gloomberb install gloom-sh/gloom-aries`.
3. In Gloom, open **Brokers** (`ARA`), add **Aries** and paste the key.
4. Start on **Simulation**. Turn on **Enable trading** to place orders.

[Setup](docs/setup.md) lists the scopes the key needs. Trading needs a Gloom release with the order ticket; until then, [TESTING.md](TESTING.md) runs the preview.

## What works

- Simulation and live accounts, balances and positions
- Real-time quotes, charts and option chains
- Stock, ETF and option orders, and spreads of 2 to 4 legs
- Live order updates and 90 days of history

## Good to know

- Trading is off until you turn it on. A live order asks you to type its symbol.
- Your key and Aries quotes stay on your machine. Accounts sync with Gloom Cloud unless you keep them local.
- Independent plugin, not affiliated with Aries.

## More

[Setup](docs/setup.md) · [Features](docs/features.md) · [Trading](docs/trading.md) · [Privacy and terms](docs/privacy.md) · [API notes](docs/aries-api-notes.md) · [Development](docs/development.md)
