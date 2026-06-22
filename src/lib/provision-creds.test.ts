import { describe, it, expect } from "bun:test";
import { checkProvisionCredentials } from "./provision-creds.js";

describe("checkProvisionCredentials", () => {
  it("detects AWS profile, Cloudflare global key+account, Resend", () => {
    const s = checkProvisionCredentials({
      AWS_PROFILE: "hasna",
      CLOUDFLARE_API_KEY: "k", CLOUDFLARE_EMAIL: "a@b.com", CLOUDFLARE_ACCOUNT_ID: "acct",
      RESEND_API_KEY: "re_x",
    });
    expect(s.find((x) => x.provider === "aws")!.configured).toBe(true);
    expect(s.find((x) => x.provider === "aws")!.status).toBe("pass");
    const cf = s.find((x) => x.provider === "cloudflare")!;
    expect(cf.configured).toBe(true);
    expect(cf.detail).toContain("global key");
    expect(cf.detail).toContain("account");
    expect(s.find((x) => x.provider === "resend")!.configured).toBe(true);
  });

  it("flags missing cloudflare account id", () => {
    const cf = checkProvisionCredentials({ CLOUDFLARE_API_TOKEN: "t" }).find((x) => x.provider === "cloudflare")!;
    expect(cf.status).toBe("warn");
    expect(cf.detail).toMatch(/account id/i);
  });

  it("detects Cloudflare global key from stored config", () => {
    const cf = checkProvisionCredentials({}, {
      cloudflare_api_key: "k",
      cloudflare_email: "a@b.com",
      cloudflare_account_id: "acct",
    }).find((x) => x.provider === "cloudflare")!;
    expect(cf.configured).toBe(true);
    expect(cf.status).toBe("pass");
    expect(cf.detail).toContain("global key");
    expect(cf.detail).toContain("account");
  });

  it("warns that stored SES provider credentials do not prove full AWS provisioning", () => {
    const aws = checkProvisionCredentials({}, {
      aws_provider_credentials: true,
    }).find((x) => x.provider === "aws")!;
    expect(aws.configured).toBe(true);
    expect(aws.status).toBe("warn");
    expect(aws.detail).toContain("Stored SES provider credentials");
    expect(aws.detail).toContain("Route53");
  });

  it("resend optional when absent", () => {
    expect(checkProvisionCredentials({}).find((x) => x.provider === "resend")!.configured).toBe(false);
  });
});
