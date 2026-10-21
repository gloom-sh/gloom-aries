import { describe, expect, test } from "bun:test";
import { ARIES_PARTNER_CLIENT_ID, ARIES_REDIRECT_URI, ARIES_SCOPES, ariesBrowserSignIn, listenForAriesCallback, reopenAriesSignIn } from "./sign-in";

const base64Url = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64url");
/** A port nothing listens on, standing in for 47613. */
const freePort = () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
};

describe("Aries browser sign-in", () => {
  test("the page Aries opens carries an S256 challenge of the verifier the exchange sends, and the registered redirect", async () => {
    let opened = "";
    const port = freePort();
    const signIn = ariesBrowserSignIn({ port, open: async (url) => { opened = url; return true; } });
    while (!opened) await Bun.sleep(1);
    const page = new URL(opened);
    expect(page.origin + page.pathname).toBe("https://app.aries.com/oauth2/authorize");
    const params = Object.fromEntries(page.searchParams);
    expect(params).toMatchObject({ response_type: "code", client_id: ARIES_PARTNER_CLIENT_ID, scope: ARIES_SCOPES, code_challenge_method: "S256" });
    expect(params.redirect_uri).toBe("https://api.gloom.sh/brokers/aries/callback");
    // Gloom's API passes the browser on with the code.
    const back = await fetch(`http://127.0.0.1:${port}/callback?code=synthetic-code&state=${params.state}`);
    expect(await back.text()).toContain("Signed in to Aries");
    const authorization = await signIn;
    // The exchange names the same redirect.
    expect(authorization).toMatchObject({ code: "synthetic-code", redirectUri: ARIES_REDIRECT_URI });
    expect(base64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(authorization.verifier)))).toBe(params.code_challenge!);
  });

  test("an old tab's answer is turned away, the sign-in's own ends it, and the port is let go", async () => {
    const listener = listenForAriesCallback({ state: "synthetic-state", port: 0 });
    const base = `http://127.0.0.1:${listener.port}/callback`;
    expect(await (await fetch(`${base}?code=stale&state=other`)).text()).toContain("out of date");
    expect((await fetch(`http://127.0.0.1:${listener.port}/favicon.ico`)).status).toBe(404);
    await fetch(`${base}?code=fresh&state=synthetic-state`);
    expect(await listener.code).toBe("fresh");
    await Bun.sleep(120);
    await expect(fetch(`${base}?code=late&state=synthetic-state`)).rejects.toThrow();
  });

  test("asking again while a sign-in waits opens its page again and shares its answer, without a second listener", async () => {
    const opened: string[] = [];
    const open = async (url: string) => { opened.push(url); return true; };
    const port = freePort();
    const first = ariesBrowserSignIn({ port, open });
    const again = ariesBrowserSignIn({ port, open });
    while (opened.length < 2) await Bun.sleep(1);
    expect(opened[1]).toBe(opened[0]!);
    expect(await reopenAriesSignIn(open)).toBe(true);
    const state = new URL(opened[0]!).searchParams.get("state");
    await fetch(`http://127.0.0.1:${port}/callback?code=shared-code&state=${state}`);
    expect((await first).code).toBe("shared-code");
    expect(await again).toBe(await first);
    expect(await reopenAriesSignIn(open)).toBe(false);
  });

  test("a refusal at Aries, or no browser to open, ends the sign-in with a fixed reason", async () => {
    const refused = listenForAriesCallback({ state: "synthetic-state", port: 0 });
    await fetch(`http://127.0.0.1:${refused.port}/callback?error=access_denied&error_description=echo&state=synthetic-state`);
    await expect(refused.code).rejects.toThrow("Aries sign-in was cancelled.");
    await expect(ariesBrowserSignIn({ port: 0, open: async () => false })).rejects.toThrow("Could not open a browser");
  });
});
