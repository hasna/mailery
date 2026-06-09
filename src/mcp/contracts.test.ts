import { describe, expect, it } from "bun:test";
import { cliEquivalentForTool } from "./contracts.js";

describe("MCP CLI equivalents", () => {
  it("includes provider pagination flags", () => {
    expect(cliEquivalentForTool("list_providers", { limit: 2, offset: 1 }))
      .toBe("emails provider list --limit 2 --offset 1 --json");
  });

  it("includes sequence pagination flags", () => {
    expect(cliEquivalentForTool("list_sequences", { limit: 2, offset: 1 }))
      .toBe("emails sequence list --limit 2 --offset 1 --json");
  });

  it("includes optional enrollment filters and pagination flags", () => {
    expect(cliEquivalentForTool("list_enrollments", {
      sequence_id: "welcome",
      status: "active",
      limit: 2,
      offset: 1,
    })).toBe("emails sequence enrollments welcome --status active --limit 2 --offset 1 --json");

    expect(cliEquivalentForTool("list_enrollments", { limit: 2 }))
      .toBe("emails sequence enrollments --limit 2 --json");

    expect(cliEquivalentForTool("list_replies", { email_id: "email-1", limit: 2, offset: 1 }))
      .toBe("emails replies email-1 --limit 2 --offset 1 --json");
  });

  it("includes group pagination flags", () => {
    expect(cliEquivalentForTool("list_groups", { limit: 2, offset: 1 }))
      .toBe("emails group list --limit 2 --offset 1 --json");

    expect(cliEquivalentForTool("list_group_members", {
      group_name: "newsletter",
      limit: 2,
      offset: 1,
    })).toBe("emails group members newsletter --limit 2 --offset 1 --json");
  });

  it("includes template pagination flags", () => {
    expect(cliEquivalentForTool("list_templates", { limit: 2, offset: 1 }))
      .toBe("emails template list --limit 2 --offset 1 --json");

    expect(cliEquivalentForTool("get_template", { name_or_id: "welcome" }))
      .toBe("emails template show welcome --json");
  });

  it("includes scheduled list filters and pagination flags", () => {
    expect(cliEquivalentForTool("list_scheduled", { status: "pending", limit: 2, offset: 1 }))
      .toBe("emails schedule list --status pending --limit 2 --offset 1 --json");
  });

  it("includes alias pagination flags", () => {
    expect(cliEquivalentForTool("list_aliases", { domain: "example.com", limit: 2, offset: 1 }))
      .toBe("emails alias list --domain example.com --limit 2 --offset 1 --json");
  });

  it("includes send key pagination flags", () => {
    expect(cliEquivalentForTool("list_send_keys", { owner_id: "agent-1", limit: 2, offset: 1 }))
      .toBe("emails sendkey list --owner agent-1 --limit 2 --offset 1 --json");
  });

  it("includes domain and address pagination flags", () => {
    expect(cliEquivalentForTool("list_domains", { provider_id: "provider-1", limit: 2, offset: 1 }))
      .toBe("emails domain list --provider provider-1 --limit 2 --offset 1 --json");

    expect(cliEquivalentForTool("list_addresses", { provider_id: "provider-1", limit: 2, offset: 1 }))
      .toBe("emails address list --provider provider-1 --limit 2 --offset 1 --json");
  });

  it("includes usable domain and address pagination flags", () => {
    expect(cliEquivalentForTool("list_usable_domains", { provider_id: "provider-1", send: true, limit: 2, offset: 1 }))
      .toBe("emails domain usable --provider provider-1 --send --limit 2 --offset 1 --json");

    expect(cliEquivalentForTool("list_usable_from_addresses", { provider_id: "provider-1", limit: 2, offset: 1 }))
      .toBe("emails address list --provider provider-1 --limit 2 --offset 1 --json");
  });

  it("includes warming schedule pagination flags", () => {
    expect(cliEquivalentForTool("list_warming_schedules", { status: "active", limit: 2, offset: 1 }))
      .toBe("emails domain warm-list --status active --limit 2 --offset 1 --json");
  });

  it("includes sent-email sender filters", () => {
    expect(cliEquivalentForTool("list_emails", {
      status: "sent",
      from_address: "ops@example.com",
      since: "2026-01-01T00:00:00.000Z",
      limit: 2,
      offset: 1,
    })).toBe("emails log --status sent --from ops@example.com --since 2026-01-01T00:00:00.000Z --limit 2 --offset 1 --json");
    expect(cliEquivalentForTool("search_emails", {
      query: "invoice",
      since: "2026-01-01T00:00:00.000Z",
      limit: 2,
      offset: 1,
    })).toBe("emails search invoice --since 2026-01-01T00:00:00.000Z --limit 2 --offset 1 --json");
  });

  it("includes storage sync commands", () => {
    expect(cliEquivalentForTool("storage_status", {}))
      .toBe("emails storage status --json");
    expect(cliEquivalentForTool("storage_push", { tables: "providers,domains", batch_size: 250 }))
      .toBe('emails storage push --tables "providers,domains" --batch-size 250 --json');
  });

  it("includes export filters and pagination flags", () => {
    expect(cliEquivalentForTool("export_emails", {
      format: "csv",
      provider_id: "provider-1",
      from_address: "ops@example.com",
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-02-01T00:00:00.000Z",
      limit: 2,
      offset: 1,
    })).toBe("emails export emails --provider provider-1 --from ops@example.com --since 2026-01-01T00:00:00.000Z --until 2026-02-01T00:00:00.000Z --limit 2 --offset 1 --format csv");

    expect(cliEquivalentForTool("export_events", { limit: 2 }))
      .toBe("emails export events --limit 2 --format json");
  });
});
