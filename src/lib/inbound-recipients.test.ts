import { describe, it, expect } from "bun:test";
import { withRecipient, withoutRecipient, addRecipient, removeRecipient } from "./inbound-recipients.js";

describe("pure recipient set ops", () => {
  it("withRecipient adds case-insensitively without dupes", () => {
    expect(withRecipient(["a@x.com"], "B@x.com")).toEqual(["a@x.com", "b@x.com"]);
    expect(withRecipient(["a@x.com"], "A@x.com")).toEqual(["a@x.com"]);
  });
  it("withoutRecipient removes case-insensitively", () => {
    expect(withoutRecipient(["a@x.com", "b@x.com"], "A@x.com")).toEqual(["b@x.com"]);
  });
});

function fakeClient(rule: any) {
  const calls: any[] = [];
  return {
    calls,
    client: {
      // Distinguish by input shape (robust to constructor-name mangling from
      // other test files' mock.module): Update carries a full Rule; Describe
      // carries only RuleName.
      send: async (cmd: any) => {
        if (cmd.input?.Rule) { calls.push(cmd.input.Rule.Recipients); rule = cmd.input.Rule; return {}; }
        if (cmd.input?.RuleName) return { Rule: rule };
        return {};
      },
    },
  };
}

describe("addRecipient / removeRecipient", () => {
  const ref = { ruleSetName: "rs", ruleName: "rule-x.com" };
  it("adds a new recipient and updates the rule", async () => {
    const f = fakeClient({ Name: "rule-x.com", Recipients: ["x.com"], Actions: [] });
    const r = await addRecipient(f.client, ref, "andrew@x.com");
    expect(r.changed).toBe(true);
    expect(r.recipients).toContain("andrew@x.com");
    expect(f.calls[0]).toContain("andrew@x.com");
  });
  it("is a no-op when recipient already present", async () => {
    const f = fakeClient({ Name: "r", Recipients: ["andrew@x.com"], Actions: [] });
    const r = await addRecipient(f.client, ref, "andrew@x.com");
    expect(r.changed).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
  it("removes a recipient", async () => {
    const f = fakeClient({ Name: "r", Recipients: ["a@x.com", "b@x.com"], Actions: [] });
    const r = await removeRecipient(f.client, ref, "a@x.com");
    expect(r.changed).toBe(true);
    expect(r.recipients).toEqual(["b@x.com"]);
  });
});
