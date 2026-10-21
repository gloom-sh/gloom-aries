# Setup

## Requirements

- Gloom 0.18.2 or later. It has the order ticket and keeps Aries market data on your machine with Gloom Cloud on.
- The desktop app or the terminal app for signing in. The command line uses a sign-in made there.

## Sign in

Open **Brokers**, add **Aries**, leave **Sign in with** on **Aries account** and press **Connect**. Your browser opens Aries: log in and allow Gloom. Aries sends the browser to `api.gloom.sh`, which passes it straight on to Gloom on `127.0.0.1` port 47613, so that port must be free. No Gloom account is needed.

Gloom renews the sign-in on its own. When Aries ends it, the profile says so: press **Connect** to sign in again.

## Personal API client

To use your own key instead, set **Sign in with** to **Personal API client**. In [Aries Client Center](https://app.aries.com/client-center/api), open the **API** tab and choose **Generate Key**. Create a personal-token client: its Client ID starts with `ARI-PERSONAL-TK.`. Save the Client Secret when it is shown, because Aries shows it only once.

Gloom asks for the same scopes when you sign in. A key needs them too:

| Scope | For |
| --- | --- |
| `account:information` | Accounts, balances and positions |
| `market:information` | Quotes, charts and option chains |
| `market:supplemental` | Timestamped trades and option chains. Without it, quotes have no trustworthy source time |
| `order:information` | Open orders and order history |
| `order:execution` | Previews and orders, only if you intend to trade |

## Profile settings

- **Include accounts** starts on **Simulation**. Choose **Live** or **Both** only when you mean to import those accounts.
- **Enable trading** starts **Off**.
- **Account data** decides whether your accounts and positions sync with Gloom Cloud ([privacy](privacy.md)).

## Where it shows up

- Brokers and Portfolio list the accounts and holdings, labelled simulation or live.
- Quotes, charts and option chains appear wherever Gloom shows a ticker.
- With trading on, a ticker's **Trade** tab places orders, and **Orders** lists open orders and history.
- `ARA` opens Brokers and the read-only **Aries Accounts** report (`gloomberb fn ARA`, `--view positions` for holdings).

## Keep it safe

Keep credentials out of shell arguments, pane parameters, screenshots and shared layouts. A personal Client ID shows while you edit it, and the Brokers pane can show full account identifiers.
