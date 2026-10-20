# Test Gloom with your Aries simulation account

About 15 minutes. You need macOS or Linux, Git, and an Aries **simulation** account.

![Gloom's order ticket next to the chart](docs/images/ticket.png)

## 1. Create an Aries key

In [Aries Client Center → API](https://app.aries.com/client-center/api), choose **Generate Key** to create a personal-token client. Its Client ID starts with `ARI-PERSONAL-TK.`.

Scopes: `account:information`, `market:information`, `market:supplemental`, `order:information` and `order:execution`.

Copy the Client Secret right away. Aries shows it only once.

## 2. Run Gloom

The order ticket isn't in a Gloom release yet, so run it from source:

```sh
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.11"
git clone -b preview/glo-383-aries https://github.com/gloom-sh/gloomberb.git
cd gloomberb && bun install
export GLOOMBERB_HOME=~/gloom-aries-test     # a separate profile
bun src/cli/entry.ts install gloom-sh/gloom-aries
bun run desktop:dev                          # or: bun dev for the terminal
```

## 3. Connect

1. Open **Brokers** (`ARA`), choose **Add Broker Account**, then **Aries**, and paste the Client ID and Client Secret.
2. Leave **Accounts** on **Simulation**, and turn **Enable trading** on.

Gloom Cloud can stay on: Aries quotes and charts stay on your machine. Your accounts and positions sync like any broker's, unless you set **Account data** to **Keep on this device**.

Your simulation account and positions appear in Brokers and Portfolio.

## 4. Test script

Use a limit far from the market so nothing fills.

| # | Try | Expect |
|---|---|---|
| 1 | Open `AAPL`, then **Trade** → Buy, Limit, 1 share at about half the last price | Ticket beside the chart, account marked **SIM** |
| 2 | **Review**, then **Place** | Submitted → **Working** |
| 3 | In Open Orders, edit the order (pencil) and change the price | The review shows the change, e.g. `Limit $160.00 → $161.00` |
| 4 | Cancel it (×) | "Order cancelled" toast within a second |
| 5 | **Options** tab → pick a contract → Trade, then place and cancel | Same flow for one contract |
| 6 | `OSA` → add two legs from the chain → trade the spread, then cancel | One spread order with both legs |
| 7 | Watch any quote during market hours | Bid and ask update live |

## 5. Send us

- Anything that looks wrong or slow, with a screenshot. Please crop out account numbers.
- The time (with time zone) and the symbol, so we can match it to our logs.
- What you'd expect a professional trader to need that's missing.

Send it to hello@gloom.sh.

## Remove everything

Quit Gloom, then run `rm -rf ~/gloom-aries-test`. That deletes the profile and the stored key. To retire the key itself, delete it in Aries Client Center → API.
