import { describe, it, expect } from "bun:test";
import { buildDnsPlan, type PlannedRecord } from "./dns-plan.js";

const TOKENS = ["tokenaaa", "tokenbbb", "tokenccc"];

function find(records: PlannedRecord[], purpose: string): PlannedRecord[] {
  return records.filter((r) => r.purpose === purpose);
}

describe("buildDnsPlan — SES send + ses-s3 receive (primary path)", () => {
  const plan = buildDnsPlan({
    domain: "example.com",
    region: "us-east-1",
    sendProvider: "ses",
    receiveStrategy: "ses-s3",
    dkimTokens: TOKENS,
    mailFromDomain: "mail.example.com",
  });

  it("emits exactly 3 DKIM CNAME records pointing at amazonses", () => {
    const dkim = find(plan, "dkim");
    expect(dkim).toHaveLength(3);
    expect(dkim[0]).toMatchObject({
      type: "CNAME",
      name: "tokenaaa._domainkey.example.com",
      content: "tokenaaa.dkim.amazonses.com",
      managedBy: "cloudflare",
    });
    expect(dkim[2]!.name).toBe("tokenccc._domainkey.example.com");
  });

  it("emits a DMARC TXT at _dmarc with a default policy", () => {
    const dmarc = find(plan, "dmarc");
    expect(dmarc).toHaveLength(1);
    expect(dmarc[0]!.type).toBe("TXT");
    expect(dmarc[0]!.name).toBe("_dmarc.example.com");
    expect(dmarc[0]!.content).toContain("v=DMARC1");
  });

  it("emits MAIL FROM MX + SPF on the mail-from subdomain", () => {
    const mx = find(plan, "mail_from_mx");
    expect(mx).toHaveLength(1);
    expect(mx[0]).toMatchObject({
      type: "MX",
      name: "mail.example.com",
      content: "feedback-smtp.us-east-1.amazonses.com",
      priority: 10,
    });
    const spf = find(plan, "mail_from_spf");
    expect(spf[0]).toMatchObject({
      type: "TXT",
      name: "mail.example.com",
      content: "v=spf1 include:amazonses.com ~all",
    });
  });

  it("emits an inbound MX at the root for ses-s3 receive", () => {
    const inbound = find(plan, "inbound_mx");
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({
      type: "MX",
      name: "example.com",
      content: "inbound-smtp.us-east-1.amazonaws.com",
      priority: 10,
    });
  });

  it("uses the region in both SES hostnames", () => {
    const plan2 = buildDnsPlan({
      domain: "ex.com",
      region: "eu-west-1",
      sendProvider: "ses",
      receiveStrategy: "ses-s3",
      dkimTokens: TOKENS,
      mailFromDomain: "mail.ex.com",
    });
    expect(find(plan2, "mail_from_mx")[0]!.content).toBe("feedback-smtp.eu-west-1.amazonses.com");
    expect(find(plan2, "inbound_mx")[0]!.content).toBe("inbound-smtp.eu-west-1.amazonaws.com");
  });
});

describe("buildDnsPlan — receive strategy variations", () => {
  it("cf-routing receive does NOT emit a root inbound MX (Cloudflare owns it)", () => {
    const plan = buildDnsPlan({
      domain: "example.com",
      region: "us-east-1",
      sendProvider: "ses",
      receiveStrategy: "cf-routing",
      dkimTokens: TOKENS,
      mailFromDomain: "mail.example.com",
    });
    expect(find(plan, "inbound_mx")).toHaveLength(0);
    // still has DKIM for sending
    expect(find(plan, "dkim")).toHaveLength(3);
  });

  it("defaults mailFromDomain to mail.<domain> when omitted", () => {
    const plan = buildDnsPlan({
      domain: "example.com",
      sendProvider: "ses",
      receiveStrategy: "ses-s3",
      dkimTokens: TOKENS,
    });
    expect(find(plan, "mail_from_mx")[0]!.name).toBe("mail.example.com");
  });
});

describe("buildDnsPlan — validation", () => {
  it("throws when SES send is requested without exactly 3 DKIM tokens", () => {
    expect(() =>
      buildDnsPlan({
        domain: "example.com",
        sendProvider: "ses",
        receiveStrategy: "ses-s3",
        dkimTokens: ["only-one"],
      }),
    ).toThrow(/3 DKIM tokens/);
  });

  it("resend send passes through provider-supplied records", () => {
    const resendRecords: PlannedRecord[] = [
      { type: "TXT", name: "send.example.com", content: "v=spf1 include:amazonses.com ~all", purpose: "resend_spf", managedBy: "cloudflare" },
    ];
    const plan = buildDnsPlan({
      domain: "example.com",
      sendProvider: "resend",
      receiveStrategy: "ses-s3",
      resendRecords,
    });
    expect(find(plan, "resend_spf")).toHaveLength(1);
    // no SES DKIM when send=resend
    expect(find(plan, "dkim")).toHaveLength(0);
  });
});
