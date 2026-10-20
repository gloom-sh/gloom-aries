import type { BrokerOrder } from "gloomberb/types/trading";
import { AriesSocket, type AriesSocketMessage, type AriesSocketOptions } from "./socket";

export const ARIES_ACCOUNT_SOCKET_URL = "wss://api.aries.com/v1/accounts/ws";
/** With no listener left for this long, the account socket closes. */
const IDLE_CLOSE_MS = 30_000;

/** The host's order stream listener, declared here so the plugin builds against hosts from before it. */
export interface AriesOrderListener {
  order(order: BrokerOrder): void;
  live?(live: boolean): void;
}

export interface AriesOrderStreamOptions extends Pick<AriesSocketOptions, "token" | "connect" | "now" | "setTimer" | "clearTimer" | "random"> {
  accounts(): Promise<readonly { accountId: string; isSim: boolean }[]>;
  /** The host order a pushed row changes, or undefined when it changes nothing. */
  apply(row: Record<string, unknown>, account: { accountId: string; isSim: boolean }): BrokerOrder | undefined;
}

type Fields = Record<string, unknown>;
const record = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};

/**
 * The Aries account socket for one profile: one connection subscribed to each
 * included account, pushing every order change (placement, fills, cancels,
 * replacements, rejections) to the host as it happens. It is live once an
 * account subscription is confirmed, and says when it stops so the host can
 * poll open orders instead.
 */
export class AriesOrderStream {
  private readonly listeners = new Set<AriesOrderListener>();
  private readonly socket: AriesSocket;
  private readonly setTimer: NonNullable<AriesSocketOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<AriesSocketOptions["clearTimer"]>;
  private accounts = new Map<string, { accountId: string; isSim: boolean }>();
  private confirmed = false;
  private idleTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: AriesOrderStreamOptions) {
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.socket = new AriesSocket({
      url: ARIES_ACCOUNT_SOCKET_URL, token: options.token, connect: options.connect, now: options.now,
      setTimer: options.setTimer, clearTimer: options.clearTimer, random: options.random,
      onReady: (send) => {
        void options.accounts().then((accounts) => {
          this.accounts = new Map(accounts.map((account) => [account.accountId, account]));
          for (const account of accounts) send({ type: "subscribe", id: this.socket.nextId("account"), payload: { topic: "account", params: { accountId: account.accountId } } });
        }).catch(() => { /* No account list: stay on polling until the next session. */ });
      },
      onMessage: (message) => this.receive(message),
      onLive: (live) => { if (!live) this.setConfirmed(false); },
    });
  }

  get live(): boolean { return this.confirmed; }

  subscribe(listener: AriesOrderListener): () => void {
    this.listeners.add(listener);
    if (this.idleTimer !== undefined) { this.clearTimer(this.idleTimer); this.idleTimer = undefined; }
    this.socket.start();
    try { listener.live?.(this.confirmed); } catch { /* A listener cannot stop the stream. */ }
    return () => {
      if (!this.listeners.delete(listener) || this.listeners.size || this.idleTimer !== undefined) return;
      this.idleTimer = this.setTimer(() => { this.idleTimer = undefined; if (!this.listeners.size) { this.socket.stop(); } }, IDLE_CLOSE_MS);
    };
  }

  dispose(): void {
    this.listeners.clear();
    if (this.idleTimer !== undefined) this.clearTimer(this.idleTimer);
    this.socket.stop();
  }

  private setConfirmed(value: boolean): void {
    if (this.confirmed === value) return;
    this.confirmed = value;
    for (const listener of [...this.listeners]) { try { listener.live?.(value); } catch { /* Next listener. */ } }
  }

  private emit(row: unknown, accountId: string | undefined): void {
    const source = record(row);
    const account = this.accounts.get(String(source.accountId ?? accountId ?? ""));
    if (!account) return;
    const order = this.options.apply(source, account);
    if (!order) return;
    for (const listener of [...this.listeners]) { try { listener.order({ ...order }); } catch { /* Next listener. */ } }
  }

  private receive(message: AriesSocketMessage): void {
    const payload = record(message.payload);
    if (message.type === "subscribed" && payload.topic === "account") {
      if (payload.status !== undefined && payload.status !== 200) return;
      const accountId = typeof record(payload.params).accountId === "string" ? String(record(payload.params).accountId) : undefined;
      const orders = record(payload.data).ordersV2;
      if (Array.isArray(orders)) for (const row of orders) this.emit(row, accountId);
      this.setConfirmed(true);
      return;
    }
    if (message.type === "event" && payload.name === "account.order") {
      const target = typeof payload.target === "string" ? payload.target.replace(/^account:/, "") : undefined;
      this.emit(payload.data, target);
    }
  }
}
