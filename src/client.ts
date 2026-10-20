export type AriesQuery = Record<string, string | number | undefined>;
export interface AriesTransport {
  get<T>(path: string, query?: AriesQuery): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}
export type AriesFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Only fixed messages cross the broker boundary. Never retain upstream bodies. */
export class AriesError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = "AriesError"; }
}

export interface AriesClientOptions {
  clientToken: string;
  clientSecret: string;
  fetch?: AriesFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  assertActive?: () => void;
}

const ORIGIN = "https://api.aries.com";
const ORDER_PATHS = new Set(["/v1/orders", "/v1/orders/preview", "/v1/orders/replace", "/v1/orders/cancel"]);

export class AriesClient implements AriesTransport {
  private token?: { value: string; expiresAt: number };
  private tokenFlight?: Promise<string>;
  private blockedUntil = 0;
  private disposed = false;
  private readonly fetcher: AriesFetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: AriesClientOptions) {
    this.fetcher = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  dispose(): void { this.disposed = true; this.token = undefined; }

  private async send(path: string, init: RequestInit): Promise<Response> {
    if (this.disposed) throw new AriesError("Aries connection is closed.");
    this.options.assertActive?.();
    const delay = this.blockedUntil - this.now();
    if (delay > 0) throw new AriesError("Aries is rate limiting requests. Try again later.", 429);
    let response: Response;
    try {
      response = await this.fetcher(`${ORIGIN}${path}`, { ...init, redirect: "error", signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new AriesError("Could not reach Aries. Check your connection and try again.");
    }
    if (this.disposed) { await response.body?.cancel().catch(() => {}); throw new AriesError("Aries connection is closed."); }
    try { this.options.assertActive?.(); }
    catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    return response;
  }

  private async reject(response: Response): Promise<never> {
    // Cancel without parsing: an error body can echo client credentials or account details.
    try { await response.body?.cancel(); } catch { /* Transport may already have consumed it. */ }
    if (response.status === 429) {
      const retry = response.headers.get("retry-after");
      const seconds = retry && /^\d+(\.\d+)?$/.test(retry) ? Number(retry) : undefined;
      const until = seconds !== undefined ? this.now() + seconds * 1000 : retry ? Date.parse(retry) : NaN;
      this.blockedUntil = Math.max(this.now() + 1000, Number.isFinite(until) ? until : this.now() + 30_000);
      throw new AriesError("Aries is rate limiting requests. Try again later.", 429);
    }
    const messages: Record<number, string> = {
      400: "Aries could not accept this request. Check the selected account and order fields.",
      401: "Aries authentication failed. Check your personal client credentials.",
      403: "Aries denied this request. Check your client scopes and account permissions.",
      404: "Aries could not find the requested account or instrument.",
      409: "Aries reports a conflict. Refresh the order before trying again.",
      422: "Aries rejected the request fields. Review the order before trying again.",
    };
    throw new AriesError(messages[response.status] ?? "Aries is unavailable. Try again later.", response.status);
  }

  private async json<T>(response: Response): Promise<T> {
    if (!response.ok) return this.reject(response);
    try { return await response.json() as T; }
    catch { throw new AriesError("Aries returned an unreadable response. Try again later."); }
  }

  private accessToken(): Promise<string> {
    if (this.disposed) return Promise.reject(new AriesError("Aries connection is closed."));
    if (this.token && this.token.expiresAt > this.now() + 60_000) return Promise.resolve(this.token.value);
    if (this.tokenFlight) return this.tokenFlight;
    this.tokenFlight = (async () => {
      const response = await this.send("/v1/oauth2/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.options.clientToken, client_secret: this.options.clientSecret }),
      });
      const result = await this.json<{ access_token?: unknown; expires_in?: unknown }>(response);
      const expires = Number(result.expires_in);
      if (typeof result.access_token !== "string" || !result.access_token || !Number.isFinite(expires) || expires <= 0) {
        throw new AriesError("Aries returned an invalid authentication response.");
      }
      if (this.disposed) throw new AriesError("Aries connection is closed.");
      this.token = { value: result.access_token, expiresAt: this.now() + expires * 1000 };
      return result.access_token;
    })().finally(() => { this.tokenFlight = undefined; });
    return this.tokenFlight;
  }

  /** The bearer token for a WebSocket's `/auth` request. It is sent there and nowhere else. */
  socketToken(): Promise<string> {
    try { this.options.assertActive?.(); } catch (error) { return Promise.reject(error); }
    return this.accessToken();
  }

  async get<T>(path: string, query?: AriesQuery): Promise<T> {
    if (!/^\/v[12]\/[a-zA-Z0-9/_{}.%:-]+$/.test(path) || path.includes("..")) throw new AriesError("Unsupported Aries endpoint.");
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) params.set(key, String(value));
    return this.request<T>(`${path}${params.size ? `?${params}` : ""}`, "GET");
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    if (!ORDER_PATHS.has(path)) throw new AriesError("Unsupported Aries order endpoint.");
    return this.request<T>(path, "POST", body);
  }

  private async request<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
    let token = await this.accessToken();
    for (let attempt = 0; ; attempt++) {
      const response = await this.send(path, {
        method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // Never retry mutations: their outcome may be unknown, even after an auth error.
      if (method === "GET" && response.status === 401 && attempt === 0) {
        try { await response.body?.cancel(); } catch { /* Already consumed. */ }
        if (this.token?.value === token) this.token = undefined;
        token = await this.accessToken();
        continue;
      }
      if (method === "GET" && response.status >= 500 && attempt < 2) {
        try { await response.body?.cancel(); } catch { /* Already consumed. */ }
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      return this.json<T>(response);
    }
  }
}
