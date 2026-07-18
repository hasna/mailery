import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { ApiError, EmailsSelfHostClient } from "./selfhost.js";

function okFetch(capture: (request: Request) => void): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    capture(new Request(input, init));
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

describe("generated self-hosted SDK identity contract", () => {
  it("sends a user session as Authorization Bearer and does not duplicate credentials", async () => {
    let request: Request | null = null;
    const client = new EmailsSelfHostClient({
      baseUrl: "https://emails.example.test",
      apiKey: "api-key-placeholder",
      bearerToken: "session-placeholder",
      fetch: okFetch((value) => { request = value; }),
    });

    await client.listTenants();
    expect(request?.headers.get("authorization")).toBe("Bearer session-placeholder");
    expect(request?.headers.has("x-api-key")).toBe(false);
  });

  it("keeps tenant API-key authentication and exposes the formalized identity surface", async () => {
    let request: Request | null = null;
    const client = new EmailsSelfHostClient({
      baseUrl: "https://emails.example.test",
      apiKey: "api-key-placeholder",
      fetch: okFetch((value) => { request = value; }),
    });

    await client.getCurrentPrincipal();
    expect(request?.headers.get("x-api-key")).toBe("api-key-placeholder");
    expect(request?.headers.has("authorization")).toBe(false);
    expect(typeof client.signUp).toBe("function");
    expect(typeof client.bootstrapPrimarySuperAdmin).toBe("function");
    expect(typeof client.listEmailIdentities).toBe("function");
    expect(typeof client.updateMembership).toBe("function");
    expect(typeof client.createTenantKey).toBe("function");
  });

  it("serializes the bounded attachment byte limit on the typed SDK operation", async () => {
    let request: Request | null = null;
    const client = new EmailsSelfHostClient({
      baseUrl: "https://emails.example.test",
      apiKey: "api-key-placeholder",
      fetch: okFetch((value) => { request = value; }),
    });

    await client.getMessageAttachment("message/one", 2, { max_bytes: 4096 });
    expect(request?.url).toBe("https://emails.example.test/v1/messages/message%2Fone/attachments/2?max_bytes=4096");
    expect(request?.headers.get("x-api-key")).toBe("api-key-placeholder");
  });

  it("forces redirect rejection so custom authentication is never forwarded", async () => {
    let redirect: RequestRedirect | undefined;
    const client = new EmailsSelfHostClient({
      baseUrl: "https://emails.example.test",
      apiKey: "api-key-placeholder",
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        redirect = init?.redirect;
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch,
    });

    await client.getHealth({ redirect: "follow" });
    expect(redirect).toBe("error");
  });

  it("keeps send-intent keys in JSON bodies for typed lookup and cancellation", async () => {
    const requests: Request[] = [];
    const client = new EmailsSelfHostClient({
      baseUrl: "https://emails.example.test",
      apiKey: "api-key-placeholder",
      fetch: okFetch((value) => { requests.push(value); }),
    });

    await client.lookupSendIntent({ idempotency_key: "tenant-scoped-key" });
    await client.cancelSendIntent({ idempotency_key: "tenant-scoped-key" });

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/messages/send-intents/lookup",
      "/v1/messages/send-intents/cancel",
    ]);
    expect(requests.every((request) => new URL(request.url).search === "")).toBe(true);
    expect(await requests[0]!.json()).toEqual({ idempotency_key: "tenant-scoped-key" });
    expect(await requests[1]!.json()).toEqual({ idempotency_key: "tenant-scoped-key" });
  });

  it("generates the bounded recovery-visible send-state union", () => {
    const generated = readFileSync(new URL("./selfhost.ts", import.meta.url), "utf8");
    expect(generated).toContain(
      `export interface SendIntentMessage { "id": string; "send_state": "none" | "pending" | "blocked" | "cancelled" | "sending" | "sent" | "uncertain" }`,
    );
  });

  for (const status of [409, 502]) {
    it(`preserves the exact message id and send state in ${status} send errors`, async () => {
      const exactMessageId = "12345678-1234-4234-8234-123456789abc";
      const requests: Request[] = [];
      const client = new EmailsSelfHostClient({
        baseUrl: "https://emails.example.test",
        apiKey: "api-key-placeholder",
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          requests.push(request);
          if (request.method === "GET") {
            return new Response(JSON.stringify({ message: { id: exactMessageId } }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify({
            error: "reconciliation required",
            retry_safe: false,
            message: {
              id: exactMessageId,
              send_state: status === 409 ? "sending" : "uncertain",
              from_addr: "sender@example.test",
              subject: "backward-compatible public message",
            },
          }), {
            status,
            headers: { "Content-Type": "application/json" },
          });
        }) as typeof fetch,
      });

      let projection: { id: string; send_state: string } | undefined;
      let rawBody: unknown;
      try {
        await client.sendMessage({
          from: "sender@example.test",
          to: ["recipient@example.test"],
          subject: "subject",
          idempotency_key: "tenant-scoped-key",
        });
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        projection = (error as ApiError).sendIntentMessage;
        rawBody = (error as ApiError).body;
      }
      expect(projection).toEqual({
        id: exactMessageId,
        send_state: status === 409 ? "sending" : "uncertain",
      });
      expect(rawBody).toMatchObject({
        message: { subject: "backward-compatible public message" },
      });

      await client.getMessage(projection!.id);
      expect(new URL(requests[1]!.url).pathname).toBe(`/v1/messages/${exactMessageId}`);
      expect(requests[1]!.method).toBe("GET");
    });
  }

  it("preserves pending intents returned by a failed policy-state transition", async () => {
    const exactMessageId = "12345678-1234-4234-8234-123456789abc";
    const client = new EmailsSelfHostClient({
      baseUrl: "https://emails.example.test",
      apiKey: "api-key-placeholder",
      fetch: (async () => new Response(JSON.stringify({
        error: "policy transition failed",
        retry_safe: false,
        message: { id: exactMessageId, send_state: "pending" },
      }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch,
    });
    try {
      await client.sendMessage({
        from: "sender@example.test",
        to: ["recipient@example.test"],
        subject: "subject",
        idempotency_key: "tenant-scoped-key",
      });
      throw new Error("expected ApiError");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).sendIntentMessage).toEqual({
        id: exactMessageId,
        send_state: "pending",
      });
    }
  });

  it("preserves legacy none-state keyed intents for reconciliation", async () => {
    const exactMessageId = "12345678-1234-4234-8234-123456789abc";
    const client = new EmailsSelfHostClient({
      baseUrl: "https://emails.example.test",
      apiKey: "api-key-placeholder",
      fetch: (async () => new Response(JSON.stringify({
        error: "durable send-intent ledger rows cannot be deleted",
        retry_safe: false,
        message: { id: exactMessageId, send_state: "none" },
      }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch,
    });
    try {
      await client.deleteMessage(exactMessageId);
      throw new Error("expected ApiError");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).sendIntentMessage).toEqual({
        id: exactMessageId,
        send_state: "none",
      });
    }
  });

  it("rejects non-canonical ids and non-recovery states from error projections", async () => {
    const bodies = [
      { message: { id: "../../not-a-message", send_state: "cancelled" } },
      { message: { id: "12345678-1234-4234-8234-123456789abc", send_state: "attacker_state" } },
    ];
    for (const body of bodies) {
      const client = new EmailsSelfHostClient({
        baseUrl: "https://emails.example.test",
        apiKey: "api-key-placeholder",
        fetch: (async () => new Response(JSON.stringify(body), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch,
      });
      try {
        await client.sendMessage({
          from: "sender@example.test",
          to: ["recipient@example.test"],
          subject: "subject",
          idempotency_key: "tenant-scoped-key",
        });
        throw new Error("expected ApiError");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).sendIntentMessage).toBeUndefined();
      }
    }
  });
});
