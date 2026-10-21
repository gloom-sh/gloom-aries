import { describe, expect, test } from "bun:test";
import { ARIES_PARTNER_CLIENT_ID, ARIES_SCOPES, ariesBrowserSignIn, listenForAriesCallback, reopenAriesSignIn } from "./sign-in";

const base64Url = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64url");

describe("Aries browser sign-in", () => {
  test("the page Aries opens carries an S256 challenge of the verifier the exchange sends, and the redirect it listens on", async () => {
    let opened = "";
    const signIn = ariesBrowserSignIn({ port: 0, open: async (url) => { opened = url; return true; } });
    while (!opened) await Bun.sleep(1);
    const page = new URL(opened);
    expect(page.origin + page.pathname).toBe("https://app.aries.com/oauth2/authorize");
    const params = Object.fromEntries(page.searchParams);
    expect(params).toMatchObject({ response_type: "code", client_id: ARIES_PARTNER_CLIENT_ID, scope: ARIES_SCOPES, code_challenge_method: "S256" });
    expect(params.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    // The browser comes back with the code.
    const back = await fetch(`${params.redirect_uri}?code=synthetic-code&state=${params.state}`);
    expect(await back.text()).toContain("Signed in to Aries");
    const authorization = await signIn;
    expect(authorization).toMatchObject({ code: "synthetic-code", redirectUri: params.redirect_uri });
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
    const first = ariesBrowserSignIn({ port: 0, open });
    const again = ariesBrowserSignIn({ port: 0, open });
    while (opened.length < 2) await Bun.sleep(1);
    expect(opened[1]).toBe(opened[0]!);
    expect(await reopenAriesSignIn(open)).toBe(true);
    const redirect = new URL(opened[0]!).searchParams;
    await fetch(`${redirect.get("redirect_uri")}?code=shared-code&state=${redirect.get("state")}`);
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
