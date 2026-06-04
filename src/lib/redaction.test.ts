import { describe, expect, it } from "bun:test";
import { redactSecrets } from "./redaction.js";

describe("redactSecrets", () => {
  it("redacts provider credential fields recursively without mutating input", () => {
    const input = {
      id: "provider-1",
      api_key: "re_real",
      access_key: "AKIA_REAL",
      secret_key: "secret",
      oauth_refresh_token: "refresh",
      nested: { clientSecret: "client-secret", safe: "value" },
      arr: [{ token: "tok", name: "ok" }],
      null_secret_key: null,
    };

    const redacted = redactSecrets(input);

    expect(redacted.api_key).toBe("***");
    expect(redacted.access_key).toBe("***");
    expect(redacted.secret_key).toBe("***");
    expect(redacted.oauth_refresh_token).toBe("***");
    expect(redacted.nested.clientSecret).toBe("***");
    expect(redacted.nested.safe).toBe("value");
    expect(redacted.arr[0]!.token).toBe("***");
    expect(redacted.null_secret_key).toBeNull();
    expect(input.api_key).toBe("re_real");
  });
});

