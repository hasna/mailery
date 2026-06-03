import { describe, it, expect } from "bun:test";
import { SESAdapter } from "./ses.js";

describe("SESAdapter.setMailFrom", () => {
  it("sends PutEmailIdentityMailFromAttributes with default mail.<domain>", async () => {
    const adapter = new SESAdapter({ id: "p", name: "ses", type: "ses", region: "us-east-1", access_key: "x", secret_key: "y", active: true } as any);
    let input: any;
    (adapter as any).client = { send: async (cmd: any) => { input = cmd.input; return {}; } };
    const mf = await adapter.setMailFrom("example.com");
    expect(mf).toBe("mail.example.com");
    expect(input.EmailIdentity).toBe("example.com");
    expect(input.MailFromDomain).toBe("mail.example.com");
    expect(input.BehaviorOnMxFailure).toBe("USE_DEFAULT_VALUE");
  });
  it("honors a custom mail-from", async () => {
    const adapter = new SESAdapter({ id: "p", name: "ses", type: "ses", region: "us-east-1", access_key: "x", secret_key: "y", active: true } as any);
    (adapter as any).client = { send: async () => ({}) };
    expect(await adapter.setMailFrom("example.com", "bounce.example.com")).toBe("bounce.example.com");
  });
});
