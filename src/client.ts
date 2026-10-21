import type { AriesTokens } from "./config";
import type { AriesAuthorization } from "./sign-in";

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

/** Signing in with an Aries account instead of a personal client: Gloom's public client, and the user's own tokens. */
export interface AriesAccountAuth {
  clientId: string;
  /** What the last sign-in left, to start from. */
  tokens?: AriesTokens;
  /** Every new set of tokens, and null once they no longer work. */
  onTokens?: (tokens: AriesTokens | null) => void;
}

/** The account sign-in needs doing (again): a request alone never opens a browser. */
export const ARIES_SIGN_IN_NEEDED = "Sign in to Aries: press Connect in Brokers.";
export const ARIES_SIGN_IN_EXPIRED = "Your Aries sign-in has ended. Press Connect in Brokers to sign in again.";

export interface AriesClientOptions {
  clientToken: string;
  clientSecret: string;
  account?: AriesAccountAuth;
  fetch?: AriesFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  assertActive?: () => void;
}

const ORIGIN = "https://api.aries.com";
interface TokenResponse { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown }
const ORDER_PATHS = new Set(["/v1/orders", "/v1/orders/preview", "/v1/orders/replace", "/v1/orders/cancel"]);

export class AriesClient implements AriesTransport {
  private token?: { value: string; expiresAt: number };
  private refreshToken?: string;
  private tokenFlight?: Promise<string>;
  private signInFlight?: Promise<void>;
  private blockedUntil = 0;
  private disposed = false;
  private readonly fetcher: AriesFetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: AriesClientOptions) {
    this.fetcher = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const saved = options.account?.tokens;
    if (saved?.accessToken && saved.accessTokenExpiresAt) this.token = { value: saved.accessToken, expiresAt: saved.accessTokenExpiresAt };
    this.refreshToken = saved?.refreshToken;
  }

  dispose(): void { this.disposed = true; this.token = undefined; this.refreshToken = undefined; }

  /** An account client that can make requests without a new sign-in: a live token, or one to renew it with. */
  signedIn(): boolean {
    return !this.options.account || !!this.refreshToken || !!this.token && this.token.expiresAt > this.now() + 60_000;
  }

  /** A browser sign-in is under way. */
  signingIn(): boolean { return !!this.signInFlight; }

  /** The tokens as they stand, for a client that signs in with an account. */
  tokens(): AriesTokens | null {
    if (!this.options.account || !this.token && !this.refreshToken) return null;
    return {
      ...(this.token ? { accessToken: this.token.value, accessTokenExpiresAt: this.token.expiresAt } : {}),
      ...(this.refreshToken ? { refreshToken: this.refreshToken } : {}),
    };
  }

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
      401: this.options.account ? ARIES_SIGN_IN_EXPIRED : "Aries authentication failed. Check your personal client credentials.",
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
    this.tokenFlight = (this.options.account ? this.renew(this.options.account) : (async () => {
      const response = await this.send("/v1/oauth2/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.options.clientToken, client_secret: this.options.clientSecret }),
      });
      return this.keep(await this.json<TokenResponse>(response));
    })()).finally(() => { this.tokenFlight = undefined; });
    return this.tokenFlight;
  }

  /** A token answer kept: the access token, and the refresh token when Aries sends one (or a new one). */
  private keep(result: TokenResponse): string {
    const expires = Number(result.expires_in);
    if (typeof result.access_token !== "string" || !result.access_token || !Number.isFinite(expires) || expires <= 0) {
      throw new AriesError("Aries returned an invalid authentication response.");
    }
    if (this.disposed) throw new AriesError("Aries connection is closed.");
    this.token = { value: result.access_token, expiresAt: this.now() + expires * 1000 };
    if (typeof result.refresh_token === "string" && result.refresh_token) this.refreshToken = result.refresh_token;
    this.options.account?.onTokens?.(this.tokens());
    return result.access_token;
  }

  /** Renews an account's access token with its refresh token. Gloom has no client secret, so it sends none. */
  private async renew(account: AriesAccountAuth): Promise<string> {
    const refresh = this.refreshToken;
    if (!refresh) throw new AriesError(this.token ? ARIES_SIGN_IN_EXPIRED : ARIES_SIGN_IN_NEEDED, 401);
    const response = await this.send("/v1/oauth2/token", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", client_id: account.clientId, refresh_token: refresh }),
    });
    if (response.status === 429 || response.status >= 500) return this.reject(response);
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* Already consumed. */ }
      // Refused: the sign-in is over, and only a new one helps.
      if (this.refreshToken === refresh) {
        this.token = undefined;
        this.refreshToken = undefined;
        account.onTokens?.(null);
      }
      throw new AriesError(ARIES_SIGN_IN_EXPIRED, 401);
    }
    return this.keep(await this.json<TokenResponse>(response));
  }

  /**
   * Signs in with an Aries account: `authorize` gets the code in the browser, and this exchanges it,
   * with the verifier that proves the sign-in started here. A sign-in already under way is joined.
   */
  signIn(authorize: () => Promise<AriesAuthorization>): Promise<void> {
    const account = this.options.account;
    if (!account) return Promise.reject(new AriesError("This Aries profile uses a personal client."));
    if (this.signInFlight) return this.signInFlight;
    this.signInFlight = (async () => {
      const { code, verifier, redirectUri } = await authorize();
      if (this.disposed) throw new AriesError("Aries connection is closed.");
      const response = await this.send("/v1/oauth2/token", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "code", client_id: account.clientId, code, redirect_uri: redirectUri, code_verifier: verifier }),
      });
      if (response.status === 429) return void await this.reject(response);
      if (!response.ok) {
        try { await response.body?.cancel(); } catch { /* Already consumed. */ }
        throw new AriesError("Aries could not finish the sign-in. Press Connect to try again.", 401);
      }
      this.keep(await this.json<TokenResponse>(response));
    })().finally(() => { this.signInFlight = undefined; });
    return this.signInFlight;
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
