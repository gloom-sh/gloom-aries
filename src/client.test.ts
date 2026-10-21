import { describe, expect, test } from "bun:test";
import { AriesClient, type AriesFetch } from "./client";

const credentials = { clientToken: "ARI-PERSONAL-TK.synthetic-client", clientSecret: "synthetic-secret-123" };
const json = (value: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(value), { status, headers });

describe("Aries authentication and transport", () => {
  test("form exchange stays single in flight and refreshes before expiry", async () => {
    let now = 0;
    let exchanges = 0;
    const client = new AriesClient({ ...credentials, now: () => now, fetch: async (url, init) => {
      if (url.endsWith("/token")) {
        exchanges++;
        expect(init?.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
        const body = new URLSearchParams(String(init?.body));
        expect(Object.fromEntries(body)).toEqual({ grant_type: "client_credentials", client_id: credentials.clientToken, client_secret: credentials.clientSecret });
        await Promise.resolve();
        return json({ access_token: `synthetic-bearer-${exchanges}`, expires_in: 900 });
      }
      return json({ ok: true });
    } });
    await Promise.all(Array.from({ length: 12 }, () => client.get("/v2/users/me/accounts")));
    expect(exchanges).toBe(1);
    now = 841_000;
    await Promise.all([client.get("/v2/users/me/accounts"), client.get("/v1/chart/quotes")]);
    expect(exchanges).toBe(2);
    client.dispose();
    await expect(client.get("/v1/chart/quotes")).rejects.toThrow("closed");
  });

  test("concurrent 401 responses renew once and replay GET only", async () => {
    let exchanges = 0;
    let calls = 0;
    const client = new AriesClient({ ...credentials, fetch: async (url, init) => {
      if (url.endsWith("/token")) return json({ access_token: `bearer-${++exchanges}`, expires_in: 900 });
      calls++;
      return new Headers(init?.headers).get("Authorization") === "Bearer bearer-1" ? json({ echo: credentials }, 401) : json({ ok: true });
    } });
    await Promise.all([client.get("/v1/chart/quotes"), client.get("/v2/users/me/accounts")]);
    expect(exchanges).toBe(2);
    expect(calls).toBe(4);
  });

  test("mutation failures never retry and never echo secrets", async () => {
    for (const status of [400, 401, 403, 429, 500]) {
      let orders = 0;
      const client = new AriesClient({ ...credentials, fetch: async (url) => {
        if (url.endsWith("/token")) return json({ access_token: "synthetic-bearer", expires_in: 900 });
        orders++;
        return json({ message: JSON.stringify(credentials), token: "synthetic-bearer" }, status);
      } });
      let message = "";
      try { await client.post("/v1/orders", {}); } catch (error) { message = String(error); }
      expect(orders).toBe(1);
      expect(message).not.toContain(credentials.clientToken);
      expect(message).not.toContain(credentials.clientSecret);
      expect(message).not.toContain("synthetic-bearer");
      expect(message).not.toBe("");
    }
  });

  test("429 respects Retry-After across calls without retry loops", async () => {
    let now = Date.parse("2026-01-01T00:00:00Z");
    let calls = 0;
    for (const retry of ["60", "Thu, 01 Jan 2026 00:01:00 GMT"]) {
      now = Date.parse("2026-01-01T00:00:00Z");
      const client = new AriesClient({ ...credentials, now: () => now, fetch: async (url) => {
        if (url.endsWith("/token")) return json({ access_token: "bearer", expires_in: 900 });
        calls++;
        return json({}, 429, { "Retry-After": retry });
      } });
      const before = calls;
      await expect(client.get("/v1/chart/quotes")).rejects.toThrow("rate limiting");
      now += 59_000;
      await expect(client.get("/v1/chart/quotes")).rejects.toThrow("rate limiting");
      expect(calls).toBe(before + 1);
      now += 1_001;
      await expect(client.get("/v1/chart/quotes")).rejects.toThrow("rate limiting");
      expect(calls).toBe(before + 2);
    }
  });

  test("network and malformed response errors cannot leak upstream text", async () => {
    const cases: AriesFetch[] = [async () => { throw new Error(credentials.clientSecret); }, async () => new Response(credentials.clientSecret)];
    for (const fetch of cases) {
      const client = new AriesClient({ ...credentials, fetch });
      let message = "";
      try { await client.get("/v1/chart/quotes"); } catch (error) { message = String(error); }
      expect(message).not.toContain(credentials.clientSecret);
      expect(message).toMatch(/Could not reach|unreadable/);
    }
  });

  test("bounded GET server retries, no credential forwarding to redirects or other hosts", async () => {
    let calls = 0;
    const waits: number[] = [];
    const client = new AriesClient({ ...credentials, sleep: async (ms) => { waits.push(ms); }, fetch: async (url, init) => {
      expect(new URL(url).origin).toBe("https://api.aries.com");
      expect(init?.redirect).toBe("error");
      if (url.endsWith("/token")) return json({ access_token: "bearer", expires_in: 900 });
      calls++;
      return json({}, 503);
    } });
    await expect(client.get("/v1/chart/quotes")).rejects.toThrow("unavailable");
    expect(calls).toBe(3);
    expect(waits).toEqual([500, 1000]);
    await expect(client.get("https://example.invalid/leak")).rejects.toThrow("Unsupported");
    await expect(client.get("/v1/../leak")).rejects.toThrow("Unsupported");
    await expect(client.post("/v1/predictions/orders", {})).rejects.toThrow("Unsupported");
  });
});

describe("Aries account sign-in", () => {
  const account = (tokens?: Record<string, unknown>, saved: unknown[] = []) => ({ clientId: "ARI-PARTNER.synthetic", tokens, onTokens: (value: unknown) => { saved.push(value); } });

  test("a sign-in exchanges the browser's code with its verifier and no secret, and keeps a renewed token Aries rotates", async () => {
    let now = 1_000_000;
    const saved: unknown[] = [];
    const grants: Record<string, unknown>[] = [];
    const client = new AriesClient({ clientToken: "", clientSecret: "", account: account(undefined, saved), now: () => now, fetch: async (url, init) => {
      if (!url.endsWith("/token")) return json({ bearer: new Headers(init?.headers).get("Authorization") });
      const grant = JSON.parse(String(init?.body));
      grants.push(grant);
      return grant.grant_type === "code"
        ? json({ access_token: "account-bearer-1", expires_in: 3600, refresh_token: "account-refresh-1" })
        : json({ access_token: "account-bearer-2", expires_in: 3600, refresh_token: "account-refresh-2" });
    } });
    await expect(client.get("/v2/users/me/accounts")).rejects.toThrow("press Connect");
    await client.signIn(async () => ({ code: "synthetic-code", verifier: "synthetic-verifier", redirectUri: "https://api.gloom.sh/brokers/aries/callback" }));
    expect(grants[0]).toEqual({ grant_type: "code", client_id: "ARI-PARTNER.synthetic", code: "synthetic-code", redirect_uri: "https://api.gloom.sh/brokers/aries/callback", code_verifier: "synthetic-verifier" });
    expect(await client.get<{ bearer: string }>("/v2/users/me/accounts")).toEqual({ bearer: "Bearer account-bearer-1" });
    now += 3_600_000;
    expect(await client.get<{ bearer: string }>("/v2/users/me/accounts")).toEqual({ bearer: "Bearer account-bearer-2" });
    expect(grants[1]).toEqual({ grant_type: "refresh_token", client_id: "ARI-PARTNER.synthetic", refresh_token: "account-refresh-1" });
    expect(saved.at(-1)).toEqual({ accessToken: "account-bearer-2", accessTokenExpiresAt: now + 3_600_000, refreshToken: "account-refresh-2" });
  });

  test("a refused renewal forgets the sign-in and says to sign in again, without asking Aries again", async () => {
    const saved: unknown[] = [];
    let renewals = 0;
    const client = new AriesClient({ clientToken: "", clientSecret: "", account: account({ refreshToken: "account-refresh-old" }, saved), fetch: async (url) => {
      if (url.endsWith("/token")) { renewals++; return json({ error: "Invalid or expired refresh token", echo: "account-refresh-old" }, 401); }
      return json({});
    } });
    expect(client.signedIn()).toBe(true);
    const failure = await client.get("/v1/chart/quotes").catch((error) => error);
    expect(failure).toMatchObject({ status: 401, message: "Your Aries sign-in has ended. Press Connect in Brokers to sign in again." });
    expect(saved).toEqual([null]);
    expect(client.signedIn()).toBe(false);
    await expect(client.get("/v1/chart/quotes")).rejects.toThrow("press Connect");
    expect(renewals).toBe(1);
  });
});

