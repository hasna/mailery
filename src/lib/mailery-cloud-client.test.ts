import { describe, expect, it } from "bun:test";
import { MaileryCloudClient, MaileryCloudError } from "./mailery-cloud-client.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: { "content-type": "application/json" },
  });
}

describe("MaileryCloudClient", () => {
  it("requires relative API paths", async () => {
    const client = new MaileryCloudClient({ apiUrl: "https://mailery.co", token: "ml_test" });

    await expect(client.request("https://evil.example/api")).rejects.toThrow("path must start");
  });

  it("sends auth, JSON, client, and idempotency headers", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const client = new MaileryCloudClient({
      apiUrl: "https://mailery.co/",
      token: "ml_secret",
      fetchImpl: (async (url, init) => {
        seen.push({ url: String(url), init });
        return jsonResponse({ ok: true });
      }) as typeof fetch,
    });

    const data = await client.request<{ ok: boolean }>("/api/v1/messages", {
      method: "POST",
      idempotencyKey: "local:123",
      body: { subject: "Hello" },
    });

    expect(data).toEqual({ ok: true });
    expect(seen[0]?.url).toBe("https://mailery.co/api/v1/messages");
    expect(seen[0]?.init?.headers).toMatchObject({
      authorization: "Bearer ml_secret",
      "content-type": "application/json",
      "x-mailery-client": "mailery-cli",
      "idempotency-key": "local:123",
    });
    expect(seen[0]?.init?.body).toBe(JSON.stringify({ subject: "Hello" }));
  });

  it("retries retryable GET failures", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const client = new MaileryCloudClient({
      apiUrl: "https://mailery.co",
      token: "ml_test",
      sleep: async (ms) => { sleeps.push(ms); },
      fetchImpl: (async () => {
        calls += 1;
        return calls === 1
          ? jsonResponse({ error: { message: "temporary" } }, { status: 500 })
          : jsonResponse({ ok: true });
      }) as typeof fetch,
    });

    await expect(client.request("/api/v1/auth/me")).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(sleeps.length).toBe(1);
  });

  it("does not retry non-idempotent POST by default", async () => {
    let calls = 0;
    const client = new MaileryCloudClient({
      apiUrl: "https://mailery.co",
      token: "ml_test",
      sleep: async () => {},
      fetchImpl: (async () => {
        calls += 1;
        return jsonResponse({ error: "temporary" }, { status: 500 });
      }) as typeof fetch,
    });

    await expect(client.request("/api/v1/messages", { method: "POST", body: {} })).rejects.toThrow("temporary");
    expect(calls).toBe(1);
  });

  it("retries idempotent POST requests", async () => {
    let calls = 0;
    const client = new MaileryCloudClient({
      apiUrl: "https://mailery.co",
      token: "ml_test",
      sleep: async () => {},
      fetchImpl: (async () => {
        calls += 1;
        return calls === 1
          ? jsonResponse({ error: "temporary" }, { status: 500 })
          : jsonResponse({ ok: true });
      }) as typeof fetch,
    });

    await expect(client.request("/api/v1/messages", { method: "POST", idempotencyKey: "msg-1", body: {} })).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("throws structured cloud errors for API failures", async () => {
    const client = new MaileryCloudClient({
      apiUrl: "https://mailery.co",
      token: "ml_test",
      fetchImpl: (async () => jsonResponse({ error: { message: "bad token" } }, { status: 401 })) as typeof fetch,
    });

    try {
      await client.request("/api/v1/auth/me");
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(MaileryCloudError);
      expect((error as MaileryCloudError).status).toBe(401);
      expect((error as MaileryCloudError).retryable).toBe(false);
      expect((error as Error).message).toContain("bad token");
    }
  });
});
