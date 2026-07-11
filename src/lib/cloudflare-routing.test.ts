import { describe, it, expect } from "bun:test";
import { CloudflareRoutingClient, type FetchImpl } from "./cloudflare-routing.js";

function recorder(result: any = {}) {
  const calls: { url: string; method: string; headers: Record<string,string>; body?: any }[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    return { ok: true, status: 200, json: async () => ({ success: true, result }) };
  };
  return { calls, fetchImpl };
}

const auth = { kind: "token", token: "T" } as const;

describe("CloudflareRoutingClient", () => {
  it("enableRouting POSTs the enable endpoint with Bearer auth", async () => {
    const r = recorder();
    await new CloudflareRoutingClient({ auth, fetchImpl: r.fetchImpl }).enableRouting("Z");
    expect(r.calls[0].url).toContain("/zones/Z/email/routing/enable");
    expect(r.calls[0].method).toBe("POST");
    expect(r.calls[0].headers.Authorization).toBe("Bearer T");
  });

  it("createForwardRule builds a literal matcher + forward action", async () => {
    const r = recorder({ id: "rule1" });
    const res = await new CloudflareRoutingClient({ auth, fetchImpl: r.fetchImpl }).createForwardRule("Z", "andrew@d.com", ["me@example.net"]);
    expect(res.id).toBe("rule1");
    const body = r.calls[0].body;
    expect(body.matchers[0]).toEqual({ type: "literal", field: "to", value: "andrew@d.com" });
    expect(body.actions[0]).toEqual({ type: "forward", value: ["me@example.net"] });
  });

  it("createWorkerRule targets a worker", async () => {
    const r = recorder();
    await new CloudflareRoutingClient({ auth, fetchImpl: r.fetchImpl }).createWorkerRule("Z", "a@d.com", "my-worker");
    expect(r.calls[0].body.actions[0]).toEqual({ type: "worker", value: ["my-worker"] });
  });

  it("addDestination is account-scoped", async () => {
    const r = recorder();
    await new CloudflareRoutingClient({ auth, fetchImpl: r.fetchImpl }).addDestination("ACC", "me@example.net");
    expect(r.calls[0].url).toContain("/accounts/ACC/email/routing/addresses");
    expect(r.calls[0].body).toEqual({ email: "me@example.net" });
  });

  it("setCatchAllForward PUTs catch_all", async () => {
    const r = recorder();
    await new CloudflareRoutingClient({ auth, fetchImpl: r.fetchImpl }).setCatchAllForward("Z", ["me@example.net"]);
    expect(r.calls[0].method).toBe("PUT");
    expect(r.calls[0].url).toContain("/rules/catch_all");
  });

  it("uses X-Auth-Key/Email for a global key", async () => {
    const r = recorder();
    await new CloudflareRoutingClient({ auth: { kind: "global", apiKey: "K", email: "a@b.com" }, fetchImpl: r.fetchImpl }).enableRouting("Z");
    expect(r.calls[0].headers["X-Auth-Key"]).toBe("K");
    expect(r.calls[0].headers["X-Auth-Email"]).toBe("a@b.com");
  });

  it("throws on API error", async () => {
    const fetchImpl: FetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ success: false, errors: [{ message: "bad" }] }) });
    await expect(new CloudflareRoutingClient({ auth, fetchImpl }).enableRouting("Z")).rejects.toThrow("bad");
  });
});
