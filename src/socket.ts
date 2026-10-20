/**
 * One Aries WebSocket connection: NDJSON frames, the `/auth` request, a ping
 * every 30 seconds, and reconnection with backoff from 1 to 60 seconds. A
 * session is renewed by reconnecting shortly before Aries would close it.
 * The owner says what to subscribe once the socket is signed in, and is told
 * when pushes stop so it can fall back to REST until they resume.
 */
export type AriesSocketMessage = { type?: unknown; id?: unknown; payload?: unknown; timestamp?: unknown };

export interface AriesSocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface AriesSocketOptions {
  url: string;
  /** A current access token. Never logged, never kept beyond the auth request. */
  token(): Promise<string>;
  /** Signed in: (re)send every subscription. */
  onReady(send: (message: unknown) => void): void;
  onMessage(message: AriesSocketMessage): void;
  /** Pushes started (true) or stopped (false). */
  onLive(live: boolean): void;
  connect?: (url: string) => AriesSocketLike;
  now?: () => number;
  setTimer?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  random?: () => number;
}

const OPEN = 1;
const PING_MS = 30_000;
/** No frame at all, pong included, for this long: the connection is dead. */
const SILENT_MS = 75_000;
const AUTH_TIMEOUT_MS = 10_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/** Reconnect this long before Aries ends the signed-in session. */
const RENEW_BEFORE_MS = 60_000;

export class AriesSocket {
  private socket?: AriesSocketLike;
  private running = false;
  private signedIn = false;
  private attempts = 0;
  private lastFrameAt = 0;
  private sequence = 0;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly now: () => number;
  private readonly setTimer: NonNullable<AriesSocketOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<AriesSocketOptions["clearTimer"]>;
  private readonly random: () => number;

  constructor(private readonly options: AriesSocketOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.random = options.random ?? Math.random;
  }

  get live(): boolean { return this.signedIn; }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempts = 0;
    this.open();
  }

  stop(): void {
    this.running = false;
    this.teardown();
  }

  /** Sends now when signed in; otherwise the next onReady resends the state. */
  send(message: unknown): boolean {
    if (!this.signedIn || this.socket?.readyState !== OPEN) return false;
    try { this.socket.send(JSON.stringify(message)); return true; } catch { return false; }
  }

  nextId(prefix: string): string { return `${prefix}-${++this.sequence}`; }

  private later(callback: () => void, milliseconds: number): void {
    const timer = this.setTimer(() => { this.timers.delete(timer); callback(); }, milliseconds);
    this.timers.add(timer);
  }

  private teardown(): void {
    for (const timer of this.timers) this.clearTimer(timer);
    this.timers.clear();
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try { socket.close(1000); } catch { /* Already closed. */ }
    }
    this.setSignedIn(false);
  }

  private setSignedIn(value: boolean): void {
    if (this.signedIn === value) return;
    this.signedIn = value;
    try { this.options.onLive(value); } catch { /* An observer cannot break the connection. */ }
  }

  private retry(immediate = false): void {
    this.teardown();
    if (!this.running) return;
    const delay = immediate ? 0 : Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempts) + Math.floor(this.random() * 250);
    if (!immediate) this.attempts = Math.min(this.attempts + 1, 6);
    this.later(() => { if (this.running && !this.socket) this.open(); }, delay);
  }

  private open(): void {
    let socket: AriesSocketLike;
    try {
      socket = (this.options.connect ?? ((url) => new WebSocket(url) as unknown as AriesSocketLike))(this.options.url);
    } catch { this.retry(); return; }
    this.socket = socket;
    this.lastFrameAt = this.now();
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.options.token().then((token) => {
        if (this.socket !== socket || socket.readyState !== OPEN) return;
        socket.send(JSON.stringify({ type: "request", id: this.nextId("auth"), payload: { method: "POST", path: "/auth", body: { token } } }));
      }).catch(() => { if (this.socket === socket) this.retry(); });
      this.later(() => { if (this.socket === socket && !this.signedIn) this.retry(); }, AUTH_TIMEOUT_MS);
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.lastFrameAt = this.now();
      for (const line of String(event.data).split("\n")) {
        if (!line.trim()) continue;
        let message: AriesSocketMessage;
        try { message = JSON.parse(line) as AriesSocketMessage; } catch { continue; }
        if (!message || typeof message !== "object") continue;
        this.receive(socket, message);
        if (this.socket !== socket) return;
      }
    };
    socket.onclose = () => { if (this.socket === socket) this.retry(); };
    socket.onerror = () => { if (this.socket === socket) this.retry(); };
  }

  private receive(socket: AriesSocketLike, message: AriesSocketMessage): void {
    const payload = message.payload && typeof message.payload === "object" ? message.payload as Record<string, unknown> : {};
    if (message.type === "event" && payload.action === "authSuccess") {
      const data = payload.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
      const expiresIn = typeof data.expiresIn === "number" && Number.isFinite(data.expiresIn) ? data.expiresIn : 45 * 60_000;
      this.attempts = 0;
      this.setSignedIn(true);
      // Aries closes the socket when the session ends; a fresh one carries on with no gap in subscriptions.
      this.later(() => { if (this.socket === socket) this.retry(true); }, Math.max(30_000, expiresIn - RENEW_BEFORE_MS));
      this.ping(socket);
      try { this.options.onReady((value) => { this.send(value); }); } catch { /* The owner resends on the next session. */ }
      return;
    }
    if (!this.signedIn) {
      // A refused sign-in or a server-side expiry: start again later with a new token.
      if (message.type === "error" || payload.action === "authError" || payload.action === "authTimeout" || payload.action === "sessionExpired") this.retry();
      return;
    }
    if (message.type === "pong") return;
    if (payload.action === "sessionExpired" || payload.action === "authTimeout") { this.retry(true); return; }
    try { this.options.onMessage(message); } catch { /* One bad message does not end the stream. */ }
  }

  private ping(socket: AriesSocketLike): void {
    this.later(() => {
      if (this.socket !== socket) return;
      if (this.now() - this.lastFrameAt > SILENT_MS) { this.retry(); return; }
      this.send({ type: "ping", id: this.nextId("ping") });
      this.ping(socket);
    }, PING_MS);
  }
}
