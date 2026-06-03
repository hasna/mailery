import { describe, it, expect } from "bun:test";
import { buildSesBucketPolicy } from "./aws-inbound.js";

describe("buildSesBucketPolicy", () => {
  it("uses aws:SourceAccount (lowercase) with the real account id", () => {
    const p = buildSesBucketPolicy("b", "inbound/x.com/", "638389534677") as any;
    const stmt = p.Statement[0];
    expect(stmt.Principal.Service).toBe("ses.amazonaws.com");
    expect(stmt.Action).toBe("s3:PutObject");
    expect(stmt.Resource).toBe("arn:aws:s3:::b/inbound/x.com/*");
    expect(stmt.Condition.StringEquals["aws:SourceAccount"]).toBe("638389534677");
  });
  it("omits the condition when account id is unknown (never uses literal '*')", () => {
    const p = buildSesBucketPolicy("b", "inbound/x.com/") as any;
    expect(p.Statement[0].Condition).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain('"*"');
  });
});
