# Test Aries in Gloom

About 10 minutes. You need an Aries login with a **simulation** account.

![Gloom's order ticket next to the chart](docs/images/ticket.png)

## 1. Install

1. Install Gloom 0.18.2 or later from [gloom.sh](https://gloom.sh/download/desktop).
2. Open **Plugins** (`PL`), find **Aries** and press **Install**.

## 2. Sign in

1. Open **Brokers** (`BR`), choose **Add Broker Account**, then **Aries**.
2. Leave **Sign in with** on **Aries account** and **Include accounts** on **Simulation only**. Set **Enable trading** to **On**.
3. Press **Connect**. Your browser opens Aries: log in and allow Gloom.

Your simulation account and positions appear in Brokers and Portfolio. Gloom keeps you signed in on this device.

## 3. Place a test order

Use a limit far from the market so nothing fills.

| # | Try | Expect |
|---|---|---|
| 1 | Open `AAPL`, then **Trade** → Buy, Limit, 1 share at about half the last price | Ticket beside the chart, account marked **SIM** |
| 2 | **Review**, then **Place** | Submitted → **Working** |
| 3 | In Open Orders, edit the order (pencil) and change the price | The review shows the change, e.g. `Limit $160.00 → $161.00` |
| 4 | Cancel it (×) and confirm | "Order cancelled" within a second |
| 5 | **Options** tab → pick a contract → Trade, then place and cancel | Same flow for one contract |
| 6 | Watch any quote during market hours | Bid and ask update live |

## 4. Tell us

Email hello@gloom.sh with:

- what looked wrong or slow, with a screenshot (crop out account numbers);
- the time, with time zone, and the symbol;
- what a professional trader would miss.

## Remove it

In **Brokers**, remove the Aries profile: that signs Gloom out on this device. Then uninstall Aries in **Plugins**.
