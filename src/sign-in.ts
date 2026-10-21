/**
 * Signing in with an Aries account: OAuth2 with PKCE in the user's own browser, caught on this
 * machine. Gloom is a public client, so it has no secret; the code verifier proves the sign-in
 * started here. The redirect is a loopback address Aries has registered for Gloom.
 */

/** Gloom's partner client at Aries. Public by design: a PKCE client has no secret. */
export const ARIES_PARTNER_CLIENT_ID = "ARI-PARTNER.MTc5MjUyNzgwMzA3NTQ2MzAwMg.7vBKF7dYtJ5z8nNnV7QsMPeNjmPhcCqNSglzpuJqSfk";
export const ARIES_SIGN_IN_PORT = 47613;
export const ARIES_REDIRECT_URI = `http://127.0.0.1:${ARIES_SIGN_IN_PORT}/callback`;
export const ARIES_SCOPES = "account:information market:information market:supplemental order:information order:execution";
const AUTHORIZE_URL = "https://app.aries.com/oauth2/authorize";
/** The browser tab can stay open this long before the sign-in is given up. */
const LISTEN_MS = 5 * 60_000;

export class AriesSignInError extends Error {
  constructor(message: string) { super(message); this.name = "AriesSignInError"; }
}

/** What the browser brought back: the code, and what the token exchange must repeat. */
export interface AriesAuthorization { code: string; verifier: string; redirectUri: string }

const base64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomUrlSafe = (size: number) => base64Url(crypto.getRandomValues(new Uint8Array(size)));

/** A fresh code verifier, its S256 challenge and a state value for one sign-in. */
export async function ariesPkce(): Promise<{ verifier: string; challenge: string; state: string }> {
  const verifier = randomUrlSafe(32);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: base64Url(digest), state: randomUrlSafe(24) };
}

export function ariesAuthorizeUrl(request: { clientId: string; redirectUri: string; challenge: string; state: string }): string {
  return `${AUTHORIZE_URL}?${new URLSearchParams({
    response_type: "code", client_id: request.clientId, redirect_uri: request.redirectUri, scope: ARIES_SCOPES,
    state: request.state, code_challenge: request.challenge, code_challenge_method: "S256",
  })}`;
}

const page = (title: string, body: string) => new Response(
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:4rem auto;max-width:28rem;padding:0 1rem"><h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body>`,
  { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
);

/** A loopback listener waiting for one sign-in's answer. */
export interface AriesCallbackListener { port: number; code: Promise<string>; close(): void }

/**
 * Listens on the loopback redirect for Aries to send the browser back with this sign-in's code. A
 * request with another state (an old tab) is turned away and the wait goes on; an answer for this
 * one, a code or a refusal, ends it.
 */
export function listenForAriesCallback(options: { state: string; port?: number; timeoutMs?: number }): AriesCallbackListener {
  const port = options.port ?? ARIES_SIGN_IN_PORT;
  let resolve!: (code: string) => void, reject!: (error: AriesSignInError) => void;
  const code = new Promise<string>((done, fail) => { resolve = done; reject = fail; });
  // An answer can come before anyone waits on it; whoever waits still gets it.
  code.catch(() => {});
  let settled = false;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (result: { code: string } | { error: AriesSignInError }) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    // Once this answer's page is sent, closing kept-alive connections too: nothing else is answered here.
    setTimeout(() => server?.stop(true), 50);
    if ("code" in result) resolve(result.code); else reject(result.error);
  };
  try {
    server = Bun.serve({
      hostname: "127.0.0.1", port,
      fetch(request) {
        const url = new URL(request.url);
        if (request.method !== "GET" || url.pathname !== "/callback") return new Response("Not found", { status: 404 });
        if (settled || url.searchParams.get("state") !== options.state) {
          return page("This sign-in is out of date", "Go back to Gloom and start the Aries sign-in again.");
        }
        const answer = url.searchParams.get("code");
        if (answer) {
          finish({ code: answer });
          return page("Signed in to Aries", "You can close this tab and go back to Gloom.");
        }
        const denied = url.searchParams.get("error") === "access_denied";
        finish({ error: new AriesSignInError(denied ? "Aries sign-in was cancelled." : "Aries could not sign you in. Try again.") });
        return page("Aries sign-in did not finish", "Go back to Gloom and try again.");
      },
    });
  } catch {
    throw new AriesSignInError(`Another Aries sign-in is waiting, or port ${port} is in use. Finish or close it, then try again.`);
  }
  timer = setTimeout(() => finish({ error: new AriesSignInError("Aries sign-in timed out. Press Connect to try again.") }), options.timeoutMs ?? LISTEN_MS);
  return {
    port: server.port ?? port, code,
    close: () => finish({ error: new AriesSignInError("Aries sign-in was stopped.") }),
  };
}

/** Opens a URL in the default browser. False when there is no browser to open it in. */
export async function openInBrowser(url: string): Promise<boolean> {
  // Not cmd's start: it would cut the URL at its first &.
  const command = process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["rundll32", "url.dll,FileProtocolHandler", url]
      : ["xdg-open", url];
  try {
    const opened = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return await opened.exited === 0;
  } catch {
    return false;
  }
}

/** The sign-in under way, if any: one at a time, since its listener holds the port. */
let pending: { url: Promise<string>; authorization: Promise<AriesAuthorization> } | undefined;

/**
 * One sign-in in the browser: the Aries page opens, and this answers once Aries sends the browser
 * back. Asked again while one is under way, it opens that page again and waits on the same answer.
 */
export function ariesBrowserSignIn(options: { clientId?: string; port?: number; open?: (url: string) => Promise<boolean>; timeoutMs?: number } = {}): Promise<AriesAuthorization> {
  const open = options.open ?? openInBrowser;
  if (pending) {
    const current = pending;
    void current.url.then(open).catch(() => false);
    return current.authorization;
  }
  let shown!: (url: string) => void;
  const url = new Promise<string>((resolve) => { shown = resolve; });
  const authorization = (async () => {
    const { verifier, challenge, state } = await ariesPkce();
    const listener = listenForAriesCallback({ state, port: options.port, timeoutMs: options.timeoutMs });
    const redirectUri = `http://127.0.0.1:${listener.port}/callback`;
    const page = ariesAuthorizeUrl({ clientId: options.clientId ?? ARIES_PARTNER_CLIENT_ID, redirectUri, challenge, state });
    shown(page);
    if (!await open(page)) {
      listener.close();
      throw new AriesSignInError("Could not open a browser for the Aries sign-in.");
    }
    return { code: await listener.code, verifier, redirectUri };
  })();
  const current = { url, authorization };
  pending = current;
  const clear = () => { if (pending === current) pending = undefined; };
  authorization.then(clear, clear);
  return authorization;
}

/** Opens the page of the sign-in under way again, for a tab that was closed. False when there is none. */
export function reopenAriesSignIn(open: (url: string) => Promise<boolean> = openInBrowser): Promise<boolean> {
  return pending ? pending.url.then(open) : Promise.resolve(false);
}
