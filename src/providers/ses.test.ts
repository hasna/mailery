import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { Provider } from "../types/index.js";

// ─── Mocks for @aws-sdk/client-sesv2 ─────────────────────────────────────────

// Track the most-recent command sent to client.send()
const mockSend = mock(async (_command: unknown) => ({}));
const mockClassicSend = mock(async (_command: unknown) => ({}));

// We track command instances via their constructor names
class MockSESv2Client {
  send = mockSend;
  constructor(_config: unknown) {}
}

class MockListEmailIdentitiesCommand {
  constructor(public input: unknown) {}
}

class MockGetEmailIdentityCommand {
  constructor(public input: unknown) {}
}

class MockCreateEmailIdentityCommand {
  constructor(public input: unknown) {}
}

class MockSendEmailCommand {
  constructor(public input: unknown) {}
}

class MockBatchGetMetricDataCommand {
  constructor(public input: unknown) {}
}

class MockPutEmailIdentityMailFromAttributesCommand {
  constructor(public input: unknown) {}
}

class MockSESClassicClient {
  send = mockClassicSend;
  constructor(_config: unknown) {}
}

class MockGetIdentityVerificationAttributesCommand {
  constructor(public input: unknown) {}
}

class MockVerifyDomainIdentityCommand {
  constructor(public input: unknown) {}
}

class MockVerifyDomainDkimCommand {
  constructor(public input: unknown) {}
}

// Mock the entire @aws-sdk/client-sesv2 module
mock.module("@aws-sdk/client-sesv2", () => ({
  SESv2Client: MockSESv2Client,
  ListEmailIdentitiesCommand: MockListEmailIdentitiesCommand,
  GetEmailIdentityCommand: MockGetEmailIdentityCommand,
  CreateEmailIdentityCommand: MockCreateEmailIdentityCommand,
  SendEmailCommand: MockSendEmailCommand,
  BatchGetMetricDataCommand: MockBatchGetMetricDataCommand,
  PutEmailIdentityMailFromAttributesCommand: MockPutEmailIdentityMailFromAttributesCommand,
}));

mock.module("@aws-sdk/client-ses", () => ({
  SESClient: MockSESClassicClient,
  GetIdentityVerificationAttributesCommand: MockGetIdentityVerificationAttributesCommand,
  VerifyDomainIdentityCommand: MockVerifyDomainIdentityCommand,
  VerifyDomainDkimCommand: MockVerifyDomainDkimCommand,
}));

// Import after mock setup
const { SESAdapter } = await import("./ses.js");

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "provider-ses-1",
    name: "My SES",
    type: "ses",
    api_key: null,
    region: "us-east-1",
    access_key: "AKIAIOSFODNN7EXAMPLE",
    secret_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    oauth_client_id: null,
    oauth_client_secret: null,
    oauth_refresh_token: null,
    oauth_access_token: null,
    oauth_token_expiry: null,
    active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  mockClassicSend.mockReset();
  mockClassicSend.mockImplementation(async () => ({}));
});

// ─── Constructor ─────────────────────────────────────────────────────────────

describe("SESAdapter constructor", () => {
  it("constructs successfully with region set", () => {
    expect(() => new SESAdapter(makeProvider())).not.toThrow();
  });

  it("constructs successfully without access keys (uses environment/role auth)", () => {
    expect(() => new SESAdapter(makeProvider({ access_key: null, secret_key: null }))).not.toThrow();
  });

  it("falls back to AWS_REGION env var", () => {
    const original = process.env["AWS_REGION"];
    process.env["AWS_REGION"] = "eu-west-1";
    expect(() => new SESAdapter(makeProvider({ region: null }))).not.toThrow();
    process.env["AWS_REGION"] = original;
  });

  it("uses us-east-1 as ultimate fallback region", () => {
    const originalRegion = process.env["AWS_REGION"];
    delete process.env["AWS_REGION"];
    expect(() => new SESAdapter(makeProvider({ region: null }))).not.toThrow();
    process.env["AWS_REGION"] = originalRegion;
  });
});

// ─── listDomains ─────────────────────────────────────────────────────────────

describe("SESAdapter.listDomains", () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it("returns domain identities only (excludes email addresses)", async () => {
    let callCount = 0;
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof MockListEmailIdentitiesCommand) {
        return {
          EmailIdentities: [
            { IdentityName: "example.com", IdentityType: "DOMAIN" },
            { IdentityName: "user@example.com", IdentityType: "EMAIL_ADDRESS" },
            { IdentityName: "test.com", IdentityType: "DOMAIN" },
          ],
        };
      }
      if (cmd instanceof MockGetEmailIdentityCommand) {
        callCount++;
        const input = (cmd as MockGetEmailIdentityCommand).input as { EmailIdentity: string };
        return {
          VerifiedForSendingStatus: true,
          DkimAttributes: { Status: "SUCCESS" },
        };
      }
      return {};
    });

    const adapter = new SESAdapter(makeProvider());
    const domains = await adapter.listDomains();

    expect(domains).toHaveLength(2);
    expect(domains.map((d) => d.domain)).toContain("example.com");
    expect(domains.map((d) => d.domain)).toContain("test.com");
    expect(domains.map((d) => d.domain)).not.toContain("user@example.com");
  });

  it("maps DKIM SUCCESS status to verified", async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof MockListEmailIdentitiesCommand) {
        return {
          EmailIdentities: [{ IdentityName: "example.com", IdentityType: "DOMAIN" }],
        };
      }
      if (cmd instanceof MockGetEmailIdentityCommand) {
        return {
          VerifiedForSendingStatus: true,
          DkimAttributes: { Status: "SUCCESS" },
        };
      }
      return {};
    });

    const adapter = new SESAdapter(makeProvider());
    const domains = await adapter.listDomains();

    expect(domains[0]!.dkim_status).toBe("verified");
    expect(domains[0]!.spf_status).toBe("verified");
    expect(domains[0]!.dmarc_status).toBe("pending");
  });

  it("maps DKIM FAILED to failed", async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof MockListEmailIdentitiesCommand) {
        return {
          EmailIdentities: [{ IdentityName: "failed.com", IdentityType: "DOMAIN" }],
        };
      }
      if (cmd instanceof MockGetEmailIdentityCommand) {
        return {
          VerifiedForSendingStatus: false,
          DkimAttributes: { Status: "FAILED" },
        };
      }
      return {};
    });

    const adapter = new SESAdapter(makeProvider());
    const domains = await adapter.listDomains();

    expect(domains[0]!.dkim_status).toBe("failed");
    expect(domains[0]!.spf_status).toBe("pending");
  });

  it("returns pending status when GetEmailIdentity throws", async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof MockListEmailIdentitiesCommand) {
        return {
          EmailIdentities: [{ IdentityName: "error.com", IdentityType: "DOMAIN" }],
        };
      }
      if (cmd instanceof MockGetEmailIdentityCommand) {
        throw new Error("Not found");
      }
      return {};
    });

    const adapter = new SESAdapter(makeProvider());
    const domains = await adapter.listDomains();

    expect(domains).toHaveLength(1);
    expect(domains[0]!.dkim_status).toBe("pending");
    expect(domains[0]!.spf_status).toBe("pending");
  });

  it("returns empty array when no identities", async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof MockListEmailIdentitiesCommand) {
        return { EmailIdentities: [] };
      }
      return {};
    });

    const adapter = new SESAdapter(makeProvider());
    const domains = await adapter.listDomains();

    expect(domains).toEqual([]);
  });

  it("skips identities with no IdentityName", async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof MockListEmailIdentitiesCommand) {
        return {
          EmailIdentities: [
            { IdentityName: null },
            { IdentityName: "valid.com" },
          ],
        };
      }
      if (cmd instanceof MockGetEmailIdentityCommand) {
        return {
          VerifiedForSendingStatus: true,
          DkimAttributes: { Status: "SUCCESS" },
        };
      }
      return {};
    });

    const adapter = new SESAdapter(makeProvider());
    const domains = await adapter.listDomains();

    expect(domains).toHaveLength(1);
    expect(domains[0]!.domain).toBe("valid.com");
  });
});

// ─── getDnsRecords ───────────────────────────────────────────────────────────

describe("SESAdapter.getDnsRecords", () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it("returns CNAME records from DKIM tokens", async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof MockGetEmailIdentityCommand) {
        return {
          DkimAttributes: {
            Tokens: ["abc123", "def456", "ghi789"],
            Status: "SUCCESS",
          },
        };
      }
      return {};
    });

    const adapter = new SESAdapter(makeProvider());
    const records = await adapter.getDnsRecords("example.com");

    const cnames = records.filter((r) => r.type === "CNAME");
    expect(cnames).toHaveLength(3);
    expect(cnames[0]!.name).toBe("abc123._domainkey.example.com");
    expect(cnames[0]!.value).toBe("abc123.dkim.amazonses.com");
    expect(cnames[0]!.purpose).toBe("DKIM");
  });

  it("includes the SES identity verification TXT record when a token is available", async () => {
    mockClassicSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof MockGetIdentityVerificationAttributesCommand) {
        return {
          VerificationAttributes: {
            "example.com": { VerificationToken: "identity-token" },
          },
        };
      }
      return {};
    });
    mockSend.mockImplementation(async () => ({
      DkimAttributes: { Tokens: ["token1"] },
    }));

    const adapter = new SESAdapter(makeProvider());
    const records = await adapter.getDnsRecords("example.com");

    const identity = records.find((r) => r.purpose === "SES_IDENTITY");
    expect(identity).toEqual({
      type: "TXT",
      name: "_amazonses.example.com",
      value: "identity-token",
      purpose: "SES_IDENTITY",
    });
  });

  it("always includes SPF TXT record", async () => {
    mockSend.mockImplementation(async () => ({
      DkimAttributes: { Tokens: ["token1"] },
    }));

    const adapter = new SESAdapter(makeProvider());
    const records = await adapter.getDnsRecords("example.com");

    const spf = records.find((r) => r.purpose === "SPF");
    expect(spf).toBeDefined();
    expect(spf!.type).toBe("TXT");
    expect(spf!.name).toBe("example.com");
    expect(spf!.value).toContain("v=spf1");
    expect(spf!.value).toContain("amazonses.com");
  });

  it("always includes DMARC TXT record", async () => {
    mockSend.mockImplementation(async () => ({
      DkimAttributes: { Tokens: [] },
    }));

    const adapter = new SESAdapter(makeProvider());
    const records = await adapter.getDnsRecords("example.com");

    const dmarc = records.find((r) => r.purpose === "DMARC");
    expect(dmarc).toBeDefined();
    expect(dmarc!.type).toBe("TXT");
    expect(dmarc!.name).toBe("_dmarc.example.com");
    expect(dmarc!.value).toContain("v=DMARC1");
  });

  it("returns only SPF+DMARC when GetEmailIdentity throws (unregistered domain)", async () => {
    mockSend.mockImplementation(async () => {
      throw new Error("Domain not registered");
    });

    const adapter = new SESAdapter(makeProvider());
    const records = await adapter.getDnsRecords("new.com");

    expect(records).toHaveLength(2);
    expect(records[0]!.purpose).toBe("SPF");
    expect(records[1]!.purpose).toBe("DMARC");
  });

  it("returns only SPF+DMARC when no DKIM tokens", async () => {
    mockSend.mockImplementation(async () => ({
      DkimAttributes: { Tokens: [] },
    }));

    const adapter = new SESAdapter(makeProvider());
    const records = await adapter.getDnsRecords("example.com");

    expect(records).toHaveLength(2);
    expect(records.map((r) => r.purpose)).toEqual(["SPF", "DMARC"]);
  });
});

describe("SESAdapter.reinitiateDomainVerification", () => {
  beforeEach(() => {
    mockClassicSend.mockReset();
  });

  it("calls classic SES identity and DKIM verification and returns records to publish", async () => {
    mockClassicSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof MockVerifyDomainIdentityCommand) {
        return { VerificationToken: "identity-token" };
      }
      if (cmd instanceof MockVerifyDomainDkimCommand) {
        return { DkimTokens: ["abc123", "def456", "ghi789"] };
      }
      return {};
    });

    const adapter = new SESAdapter(makeProvider());
    const records = await adapter.reinitiateDomainVerification("example.com");

    expect(mockClassicSend).toHaveBeenCalledTimes(2);
    expect((mockClassicSend.mock.calls[0]![0] as MockVerifyDomainIdentityCommand).input).toEqual({ Domain: "example.com" });
    expect((mockClassicSend.mock.calls[1]![0] as MockVerifyDomainDkimCommand).input).toEqual({ Domain: "example.com" });
    expect(records.map((r) => r.purpose)).toEqual(["SES_IDENTITY", "DKIM", "DKIM", "DKIM"]);
    expect(records[0]!).toMatchObject({
      type: "TXT",
      name: "_amazonses.example.com",
      value: "identity-token",
    });
  });
});

// ─── verifyDomain ─────────────────────────────────────────────────────────────

describe("SESAdapter.verifyDomain", () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it("returns verified when DKIM status is SUCCESS and VerifiedForSendingStatus is true", async () => {
    mockSend.mockImplementation(async () => ({
      VerifiedForSendingStatus: true,
      DkimAttributes: { Status: "SUCCESS" },
    }));

    const adapter = new SESAdapter(makeProvider());
    const result = await adapter.verifyDomain("example.com");

    expect(result.dkim).toBe("verified");
    expect(result.spf).toBe("verified");
    expect(result.dmarc).toBe("pending");
  });

  it("returns pending when not yet verified", async () => {
    mockSend.mockImplementation(async () => ({
      VerifiedForSendingStatus: false,
      DkimAttributes: { Status: "PENDING" },
    }));

    const adapter = new SESAdapter(makeProvider());
    const result = await adapter.verifyDomain("example.com");

    expect(result.dkim).toBe("pending");
    expect(result.spf).toBe("pending");
  });

  it("returns failed when DKIM status is FAILED", async () => {
    mockSend.mockImplementation(async () => ({
      VerifiedForSendingStatus: false,
      DkimAttributes: { Status: "FAILED" },
    }));

    const adapter = new SESAdapter(makeProvider());
    const result = await adapter.verifyDomain("example.com");

    expect(result.dkim).toBe("failed");
  });

  it("returns failed when SES identity verification status is FAILED", async () => {
    mockSend.mockImplementation(async () => ({
      VerifiedForSendingStatus: false,
      VerificationStatus: "FAILED",
      DkimAttributes: { Status: "SUCCESS" },
    }));

    const adapter = new SESAdapter(makeProvider());
    const result = await adapter.verifyDomain("example.com");

    expect(result.dkim).toBe("verified");
    expect(result.spf).toBe("failed");
  });

  it("returns all pending when GetEmailIdentity throws", async () => {
    mockSend.mockImplementation(async () => {
      throw new Error("Not found");
    });

    const adapter = new SESAdapter(makeProvider());
    const result = await adapter.verifyDomain("example.com");

    expect(result).toEqual({ dkim: "pending", spf: "pending", dmarc: "pending" });
  });

  it("maps TEMPORARY_FAILURE to failed", async () => {
    mockSend.mockImplementation(async () => ({
      VerifiedForSendingStatus: false,
      DkimAttributes: { Status: "TEMPORARY_FAILURE" },
    }));

    const adapter = new SESAdapter(makeProvider());
    const result = await adapter.verifyDomain("example.com");

    expect(result.dkim).toBe("failed");
  });
});

// ─── addDomain ────────────────────────────────────────────────────────────────

describe("SESAdapter.addDomain", () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it("calls CreateEmailIdentityCommand with the domain name", async () => {
    mockSend.mockImplementation(async () => ({}));

    const adapter = new SESAdapter(makeProvider());
    await adapter.addDomain("newdomain.com");

    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0]![0] as MockCreateEmailIdentityCommand;
    expect(cmd).toBeInstanceOf(MockCreateEmailIdentityCommand);
    const input = cmd.input as { EmailIdentity: string };
    expect(input.EmailIdentity).toBe("newdomain.com");
  });

  it("resolves without error on success", async () => {
    mockSend.mockImplementation(async () => ({}));

    const adapter = new SESAdapter(makeProvider());
    await expect(adapter.addDomain("newdomain.com")).resolves.toBeUndefined();
  });

  it("swallows AlreadyExistsException", async () => {
    mockSend.mockImplementation(async () => {
      const err = new Error("Already exists");
      err.name = "AlreadyExistsException";
      throw err;
    });

    const adapter = new SESAdapter(makeProvider());
    await expect(adapter.addDomain("existing.com")).resolves.toBeUndefined();
  });

  it("re-throws other errors", async () => {
    mockSend.mockImplementation(async () => {
      throw new Error("Permission denied");
    });

    const adapter = new SESAdapter(makeProvider());
    await expect(adapter.addDomain("nope.com")).rejects.toThrow(/Permission denied/);
  });
});

// ─── listAddresses ────────────────────────────────────────────────────────────

describe("SESAdapter.listAddresses", () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it("returns only EMAIL_ADDRESS identities (excludes domains)", async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof MockListEmailIdentitiesCommand) {
        return {
          EmailIdentities: [
            { IdentityName: "example.com", IdentityType: "DOMAIN" },
            { IdentityName: "user@example.com", IdentityType: "EMAIL_ADDRESS" },
            { IdentityName: "other@example.com", IdentityType: "EMAIL_ADDRESS" },
          ],
        };
      }
      if (cmd instanceof MockGetEmailIdentityCommand) {
        return { VerifiedForSendingStatus: true };
      }
      return {};
    });

    const adapter = new SESAdapter(makeProvider());
    const addresses = await adapter.listAddresses();

    expect(addresses).toHaveLength(2);
    expect(addresses.map((a) => a.email)).toContain("user@example.com");
    expect(addresses.map((a) => a.email)).toContain("other@example.com");
    expect(addresses.map((a) => a.email)).not.toContain("example.com");
  });

  it("marks verified addresses correctly", async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof MockListEmailIdentitiesCommand) {
        return {
          EmailIdentities: [{ IdentityName: "user@example.com" }],
        };
      }
      if (cmd instanceof MockGetEmailIdentityCommand) {
        return { VerifiedForSendingStatus: true };
      }
      return {};
    });

    const adapter = new SESAdapter(makeProvider());
    const addresses = await adapter.listAddresses();

    expect(addresses[0]!.verified).toBe(true);
  });

  it("marks unverified addresses correctly", async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof MockListEmailIdentitiesCommand) {
        return {
          EmailIdentities: [{ IdentityName: "unverified@example.com" }],
        };
      }
      if (cmd instanceof MockGetEmailIdentityCommand) {
        return { VerifiedForSendingStatus: false };
      }
      return {};
    });

    const adapter = new SESAdapter(makeProvider());
    const addresses = await adapter.listAddresses();

    expect(addresses[0]!.verified).toBe(false);
  });

  it("returns false verified when GetEmailIdentity throws", async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof MockListEmailIdentitiesCommand) {
        return {
          EmailIdentities: [{ IdentityName: "err@example.com" }],
        };
      }
      throw new Error("Not found");
    });

    const adapter = new SESAdapter(makeProvider());
    const addresses = await adapter.listAddresses();

    expect(addresses[0]!.verified).toBe(false);
  });

  it("returns empty array when no identities", async () => {
    mockSend.mockImplementation(async () => ({ EmailIdentities: [] }));

    const adapter = new SESAdapter(makeProvider());
    const addresses = await adapter.listAddresses();

    expect(addresses).toEqual([]);
  });
});

// ─── addAddress ───────────────────────────────────────────────────────────────

describe("SESAdapter.addAddress", () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it("calls CreateEmailIdentityCommand with the email", async () => {
    mockSend.mockImplementation(async () => ({}));

    const adapter = new SESAdapter(makeProvider());
    await adapter.addAddress("new@example.com");

    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0]![0] as MockCreateEmailIdentityCommand;
    expect(cmd).toBeInstanceOf(MockCreateEmailIdentityCommand);
    const input = cmd.input as { EmailIdentity: string };
    expect(input.EmailIdentity).toBe("new@example.com");
  });

  it("resolves without error", async () => {
    mockSend.mockImplementation(async () => ({}));

    const adapter = new SESAdapter(makeProvider());
    await expect(adapter.addAddress("new@example.com")).resolves.toBeUndefined();
  });

  it("swallows AlreadyExistsException", async () => {
    mockSend.mockImplementation(async () => {
      const err = new Error("Already exists");
      err.name = "AlreadyExistsException";
      throw err;
    });

    const adapter = new SESAdapter(makeProvider());
    await expect(adapter.addAddress("existing@example.com")).resolves.toBeUndefined();
  });

  it("re-throws other errors", async () => {
    mockSend.mockImplementation(async () => {
      throw new Error("Quota exceeded");
    });

    const adapter = new SESAdapter(makeProvider());
    await expect(adapter.addAddress("new@example.com")).rejects.toThrow(/Quota exceeded/);
  });
});

// ─── verifyAddress ────────────────────────────────────────────────────────────

describe("SESAdapter.verifyAddress", () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it("returns true when VerifiedForSendingStatus is true", async () => {
    mockSend.mockImplementation(async () => ({ VerifiedForSendingStatus: true }));

    const adapter = new SESAdapter(makeProvider());
    const result = await adapter.verifyAddress("user@example.com");

    expect(result).toBe(true);
  });

  it("returns false when VerifiedForSendingStatus is false", async () => {
    mockSend.mockImplementation(async () => ({ VerifiedForSendingStatus: false }));

    const adapter = new SESAdapter(makeProvider());
    const result = await adapter.verifyAddress("user@example.com");

    expect(result).toBe(false);
  });

  it("returns false when GetEmailIdentity throws", async () => {
    mockSend.mockImplementation(async () => {
      throw new Error("Not found");
    });

    const adapter = new SESAdapter(makeProvider());
    const result = await adapter.verifyAddress("user@example.com");

    expect(result).toBe(false);
  });
});

// ─── sendEmail ────────────────────────────────────────────────────────────────

describe("SESAdapter.sendEmail", () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockImplementation(async () => ({ MessageId: "ses-message-id-abc" }));
  });

  it("calls SendEmailCommand and returns MessageId", async () => {
    const adapter = new SESAdapter(makeProvider());
    const id = await adapter.sendEmail({
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "Hello",
      text: "World",
    });

    expect(id).toBe("ses-message-id-abc");
    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0]![0];
    expect(cmd).toBeInstanceOf(MockSendEmailCommand);
  });

  it("sends plain text email using Simple content", async () => {
    const adapter = new SESAdapter(makeProvider());
    await adapter.sendEmail({
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "Plain Text",
      text: "Hello plain text",
    });

    const cmd = mockSend.mock.calls[0]![0] as MockSendEmailCommand;
    const input = cmd.input as {
      Content: { Simple: { Body: { Text?: { Data: string }; Html?: { Data: string } }; Subject: { Data: string } } };
    };
    expect(input.Content.Simple.Body.Text?.Data).toBe("Hello plain text");
    expect(input.Content.Simple.Body.Html).toBeUndefined();
  });

  it("sends HTML email using Simple content", async () => {
    const adapter = new SESAdapter(makeProvider());
    await adapter.sendEmail({
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "HTML Email",
      html: "<h1>Hello</h1>",
    });

    const cmd = mockSend.mock.calls[0]![0] as MockSendEmailCommand;
    const input = cmd.input as {
      Content: { Simple: { Body: { Html?: { Data: string } } } };
    };
    expect(input.Content.Simple.Body.Html?.Data).toBe("<h1>Hello</h1>");
  });

  it("includes CC addresses", async () => {
    const adapter = new SESAdapter(makeProvider());
    await adapter.sendEmail({
      from: "sender@example.com",
      to: "to@example.com",
      cc: "cc@example.com",
      subject: "CC",
      text: "Body",
    });

    const cmd = mockSend.mock.calls[0]![0] as MockSendEmailCommand;
    const input = cmd.input as { Destination: { CcAddresses: string[] } };
    expect(input.Destination.CcAddresses).toEqual(["cc@example.com"]);
  });

  it("includes BCC addresses", async () => {
    const adapter = new SESAdapter(makeProvider());
    await adapter.sendEmail({
      from: "sender@example.com",
      to: "to@example.com",
      bcc: "bcc@example.com",
      subject: "BCC",
      text: "Body",
    });

    const cmd = mockSend.mock.calls[0]![0] as MockSendEmailCommand;
    const input = cmd.input as { Destination: { BccAddresses: string[] } };
    expect(input.Destination.BccAddresses).toEqual(["bcc@example.com"]);
  });

  it("includes reply-to addresses", async () => {
    const adapter = new SESAdapter(makeProvider());
    await adapter.sendEmail({
      from: "sender@example.com",
      to: "to@example.com",
      reply_to: "reply@example.com",
      subject: "Reply-To",
      text: "Body",
    });

    const cmd = mockSend.mock.calls[0]![0] as MockSendEmailCommand;
    const input = cmd.input as { ReplyToAddresses: string[] };
    expect(input.ReplyToAddresses).toEqual(["reply@example.com"]);
  });

  it("handles array 'to' field", async () => {
    const adapter = new SESAdapter(makeProvider());
    await adapter.sendEmail({
      from: "sender@example.com",
      to: ["a@example.com", "b@example.com"],
      subject: "Multi",
      text: "Body",
    });

    const cmd = mockSend.mock.calls[0]![0] as MockSendEmailCommand;
    const input = cmd.input as { Destination: { ToAddresses: string[] } };
    expect(input.Destination.ToAddresses).toEqual(["a@example.com", "b@example.com"]);
  });

  it("sends raw MIME message when attachments are included", async () => {
    const adapter = new SESAdapter(makeProvider());
    await adapter.sendEmail({
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "With Attachment",
      text: "See attached",
      attachments: [
        {
          filename: "test.txt",
          content: Buffer.from("file content").toString("base64"),
          content_type: "text/plain",
        },
      ],
    });

    const cmd = mockSend.mock.calls[0]![0] as MockSendEmailCommand;
    const input = cmd.input as { Content: { Raw?: { Data: Buffer }; Simple?: unknown } };
    expect(input.Content.Raw).toBeDefined();
    expect(input.Content.Simple).toBeUndefined();
    expect(input.Content.Raw!.Data).toBeInstanceOf(Buffer);
  });

  it("raw MIME contains attachment filename", async () => {
    const adapter = new SESAdapter(makeProvider());
    await adapter.sendEmail({
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "Attachment",
      text: "Body",
      attachments: [
        {
          filename: "document.pdf",
          content: Buffer.from("pdf content").toString("base64"),
          content_type: "application/pdf",
        },
      ],
    });

    const cmd = mockSend.mock.calls[0]![0] as MockSendEmailCommand;
    const input = cmd.input as { Content: { Raw: { Data: Buffer } } };
    const rawText = input.Content.Raw.Data.toString("utf-8");
    expect(rawText).toContain("document.pdf");
    expect(rawText).toContain("Content-Transfer-Encoding: base64");
  });

  it("returns empty string when MessageId is missing", async () => {
    mockSend.mockImplementation(async () => ({}));

    const adapter = new SESAdapter(makeProvider());
    const id = await adapter.sendEmail({
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "Test",
      text: "Body",
    });

    expect(id).toBe("");
  });

  it("includes email tags", async () => {
    const adapter = new SESAdapter(makeProvider());
    await adapter.sendEmail({
      from: "sender@example.com",
      to: "to@example.com",
      subject: "Tagged",
      text: "Body",
      tags: { campaign: "newsletter" },
    });

    const cmd = mockSend.mock.calls[0]![0] as MockSendEmailCommand;
    const input = cmd.input as { EmailTags: Array<{ Name: string; Value: string }> };
    expect(input.EmailTags).toHaveLength(1);
    expect(input.EmailTags[0]!.Name).toBe("campaign");
    expect(input.EmailTags[0]!.Value).toBe("newsletter");
  });
});

// ─── pullEvents ───────────────────────────────────────────────────────────────

describe("SESAdapter.pullEvents", () => {
  it("returns empty array (SES uses SNS webhooks for events)", async () => {
    const adapter = new SESAdapter(makeProvider());
    const events = await adapter.pullEvents();
    expect(events).toEqual([]);
  });

  it("returns empty array even with a since parameter", async () => {
    const adapter = new SESAdapter(makeProvider());
    const events = await adapter.pullEvents("2024-01-01T00:00:00.000Z");
    expect(events).toEqual([]);
  });
});

// ─── getStats ─────────────────────────────────────────────────────────────────

describe("SESAdapter.getStats", () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it("returns Stats object with correct provider_id", async () => {
    mockSend.mockImplementation(async () => ({
      Results: [
        { Id: "sent", Values: [100, 50] },
        { Id: "delivered", Values: [90, 45] },
        { Id: "bounced", Values: [5, 2] },
        { Id: "complained", Values: [1, 0] },
        { Id: "opened", Values: [40, 20] },
        { Id: "clicked", Values: [10, 5] },
      ],
    }));

    const adapter = new SESAdapter(makeProvider());
    const stats = await adapter.getStats("30d");

    expect(stats.provider_id).toBe("provider-ses-1");
  });

  it("returns Stats with correct period", async () => {
    mockSend.mockImplementation(async () => ({ Results: [] }));

    const adapter = new SESAdapter(makeProvider());
    const stats = await adapter.getStats("7d");

    expect(stats.period).toBe("7d");
  });

  it("uses default period of 30d", async () => {
    mockSend.mockImplementation(async () => ({ Results: [] }));

    const adapter = new SESAdapter(makeProvider());
    const stats = await adapter.getStats();

    expect(stats.period).toBe("30d");
  });

  it("aggregates metric values correctly", async () => {
    mockSend.mockImplementation(async () => ({
      Results: [
        { Id: "sent", Values: [100, 50] },
        { Id: "delivered", Values: [90, 45] },
        { Id: "bounced", Values: [5, 2] },
        { Id: "complained", Values: [1, 0] },
        { Id: "opened", Values: [40, 20] },
        { Id: "clicked", Values: [10, 5] },
      ],
    }));

    const adapter = new SESAdapter(makeProvider());
    const stats = await adapter.getStats("30d");

    expect(stats.sent).toBe(150);
    expect(stats.delivered).toBe(135);
    expect(stats.bounced).toBe(7);
    expect(stats.complained).toBe(1);
    expect(stats.opened).toBe(60);
    expect(stats.clicked).toBe(15);
  });

  it("computes delivery_rate correctly", async () => {
    mockSend.mockImplementation(async () => ({
      Results: [
        { Id: "sent", Values: [100] },
        { Id: "delivered", Values: [90] },
        { Id: "bounced", Values: [0] },
        { Id: "complained", Values: [0] },
        { Id: "opened", Values: [0] },
        { Id: "clicked", Values: [0] },
      ],
    }));

    const adapter = new SESAdapter(makeProvider());
    const stats = await adapter.getStats("30d");

    expect(stats.delivery_rate).toBe(90);
    expect(stats.bounce_rate).toBe(0);
  });

  it("returns all zeros when BatchGetMetricData throws", async () => {
    mockSend.mockImplementation(async () => {
      throw new Error("VDM not enabled");
    });

    const adapter = new SESAdapter(makeProvider());
    const stats = await adapter.getStats("30d");

    expect(stats.sent).toBe(0);
    expect(stats.delivered).toBe(0);
    expect(stats.bounced).toBe(0);
    expect(stats.delivery_rate).toBe(0);
    expect(stats.bounce_rate).toBe(0);
    expect(stats.open_rate).toBe(0);
  });

  it("uses BatchGetMetricDataCommand for metrics", async () => {
    mockSend.mockImplementation(async () => ({ Results: [] }));

    const adapter = new SESAdapter(makeProvider());
    await adapter.getStats("30d");

    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0]![0];
    expect(cmd).toBeInstanceOf(MockBatchGetMetricDataCommand);
  });

  it("handles empty Results gracefully", async () => {
    mockSend.mockImplementation(async () => ({ Results: [] }));

    const adapter = new SESAdapter(makeProvider());
    const stats = await adapter.getStats("30d");

    expect(stats.sent).toBe(0);
    expect(stats.delivery_rate).toBe(0);
  });
});
