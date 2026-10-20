# Setup

## Requirements

- Gloom 0.16.2 or later for accounts, quotes, charts and option chains.
- Trading needs a Gloom release with the shared order ticket, and spreads one with spread orders.
- Gloom Cloud can stay on with a release that keeps Aries market data local. Older releases ask you to switch it off before the plugin connects ([privacy](privacy.md)).

## Create a key

In [Aries Client Center](https://app.aries.com/client-center/api), open the **API** tab and choose **Generate Key**. Create a personal-token client: its Client ID starts with `ARI-PERSONAL-TK.`. Partner clients do not support this connection method.

Save the Client Secret when it is shown, because Aries shows it only once.

## Scopes

| Scope | For |
| --- | --- |
| `account:information` | Accounts, balances and positions |
| `market:information` | Quotes, charts and option chains |
| `market:supplemental` | Timestamped trades and option chains. Without it, quotes have no trustworthy source time |
| `order:information` | Open orders and order history |
| `order:execution` | Previews and orders, only if you intend to trade |

## Connect

Open **Brokers**, add **Aries** and enter the Client ID and Client Secret.

- **Accounts** starts on **Simulation**. Choose **Live** or **Both** only when you mean to import those accounts.
- **Enable trading** starts **Off**.
- **Account data** decides whether your accounts and positions sync with Gloom Cloud ([privacy](privacy.md)).

## Where it shows up

- Brokers and Portfolio list the accounts and holdings, labelled simulation or live.
- Quotes, charts and option chains appear wherever Gloom shows a ticker.
- With trading on, a ticker's **Trade** tab places orders, and **Orders** lists open orders and history.
- `ARA` opens Brokers and the read-only **Aries Accounts** report (`gloomberb fn ARA`, `--view positions` for holdings).

## Keep the key safe

Keep credentials out of shell arguments, pane parameters, screenshots and shared layouts. The Client ID field is plain text, so it shows while you edit it, and the Brokers pane can show full account identifiers.
