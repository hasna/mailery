import { describe, expect, it } from "bun:test";
import { cliEquivalentForTool } from "./contracts.js";

describe("MCP CLI equivalents", () => {
  it("includes provider pagination flags", () => {
    expect(cliEquivalentForTool("list_providers", { limit: 2, offset: 1 }))
      .toBe("mailery provider list --limit 2 --offset 1 --json");
  });

  it("includes sequence pagination flags", () => {
    expect(cliEquivalentForTool("list_sequences", { limit: 2, offset: 1 }))
      .toBe("mailery sequence list --limit 2 --offset 1 --json");
  });

  it("includes optional enrollment filters and pagination flags", () => {
    expect(cliEquivalentForTool("list_enrollments", {
      sequence_id: "welcome",
      status: "active",
      limit: 2,
      offset: 1,
    })).toBe("mailery sequence enrollments welcome --status active --limit 2 --offset 1 --json");

    expect(cliEquivalentForTool("list_enrollments", { limit: 2 }))
      .toBe("mailery sequence enrollments --limit 2 --json");

    expect(cliEquivalentForTool("list_replies", { email_id: "email-1", limit: 2, offset: 1 }))
      .toBe("mailery replies email-1 --limit 2 --offset 1 --json");
  });

  it("includes group pagination flags", () => {
    expect(cliEquivalentForTool("list_groups", { limit: 2, offset: 1 }))
      .toBe("mailery group list --limit 2 --offset 1 --json");

    expect(cliEquivalentForTool("list_group_members", {
      group_name: "newsletter",
      limit: 2,
      offset: 1,
    })).toBe("mailery group members newsletter --limit 2 --offset 1 --json");
  });

  it("includes template pagination flags", () => {
    expect(cliEquivalentForTool("list_templates", { limit: 2, offset: 1 }))
      .toBe("mailery template list --limit 2 --offset 1 --json");

    expect(cliEquivalentForTool("get_template", { name_or_id: "welcome" }))
      .toBe("mailery template show welcome --json");
  });

  it("includes scheduled list filters and pagination flags", () => {
    expect(cliEquivalentForTool("list_scheduled", { status: "pending", limit: 2, offset: 1 }))
      .toBe("mailery schedule list --status pending --limit 2 --offset 1 --json");
  });

  it("includes alias pagination flags", () => {
    expect(cliEquivalentForTool("list_aliases", { domain: "example.com", limit: 2, offset: 1 }))
      .toBe("mailery alias list --domain example.com --limit 2 --offset 1 --json");
  });

  it("includes send key pagination flags", () => {
    expect(cliEquivalentForTool("list_send_keys", { owner_id: "agent-1", limit: 2, offset: 1 }))
      .toBe("mailery sendkey list --owner agent-1 --limit 2 --offset 1 --json");
  });

  it("includes domain and address pagination flags", () => {
    expect(cliEquivalentForTool("list_domains", { provider_id: "provider-1", limit: 2, offset: 1 }))
      .toBe("mailery domain list --provider provider-1 --limit 2 --offset 1 --json");

    expect(cliEquivalentForTool("list_addresses", { provider_id: "provider-1", limit: 2, offset: 1 }))
      .toBe("mailery address list --provider provider-1 --limit 2 --offset 1 --json");
  });

  it("includes explicit MX switch flags for domain provisioning", () => {
    expect(cliEquivalentForTool("provision_domain", {
      domain: "example.com",
      provider_id: "provider-1",
      add_mx: true,
      force_mx_switch: true,
    })).toBe("mailery provision domain example.com --provider provider-1 --add-mx --force-mx-switch --json");
  });

  it("includes forwarding rule commands", () => {
    expect(cliEquivalentForTool("add_forwarding_rule", {
      source_address: "user@example.com",
      target_address: "archive@example.net",
      provider_id: "provider-1",
      from_address: "user@example.com",
      enabled: false,
    })).toBe("mailery forwarding add user@example.com archive@example.net --provider provider-1 --from user@example.com --disabled --json");

    expect(cliEquivalentForTool("run_forwarding_rules", { provider_id: "provider-1", limit: 5, backfill: true }))
      .toBe("mailery forwarding run --provider provider-1 --limit 5 --backfill --json");
  });

  it("includes usable domain and address pagination flags", () => {
    expect(cliEquivalentForTool("list_usable_domains", { provider_id: "provider-1", send: true, limit: 2, offset: 1 }))
      .toBe("mailery domain usable --provider provider-1 --send --limit 2 --offset 1 --json");

    expect(cliEquivalentForTool("list_usable_from_addresses", { provider_id: "provider-1", limit: 2, offset: 1 }))
      .toBe("mailery address list --provider provider-1 --limit 2 --offset 1 --json");
  });

  it("includes warming schedule pagination flags", () => {
    expect(cliEquivalentForTool("list_warming_schedules", { status: "active", limit: 2, offset: 1 }))
      .toBe("mailery domain warm-list --status active --limit 2 --offset 1 --json");
  });

  it("includes sent-email sender filters", () => {
    expect(cliEquivalentForTool("list_emails", {
      status: "sent",
      from_address: "ops@example.com",
      since: "2026-01-01T00:00:00.000Z",
      limit: 2,
      offset: 1,
    })).toBe("mailery log --status sent --from ops@example.com --since 2026-01-01T00:00:00.000Z --limit 2 --offset 1 --json");
    expect(cliEquivalentForTool("search_emails", {
      query: "invoice",
      since: "2026-01-01T00:00:00.000Z",
      limit: 2,
      offset: 1,
    })).toBe("mailery search invoice --since 2026-01-01T00:00:00.000Z --limit 2 --offset 1 --json");
  });

  it("includes inbound link extraction commands", () => {
    expect(cliEquivalentForTool("extract_inbound_email_links", { id: "abc123", include_non_web: true }))
      .toBe("mailery inbox links abc123 --all --json");
  });

  it("includes inbound attachment commands", () => {
    expect(cliEquivalentForTool("get_attachment", { email_id: "abc123", filename: "invoice.pdf" }))
      .toBe("mailery inbox attachment abc123 --filename invoice.pdf --json");
  });

  it("includes storage sync commands", () => {
    expect(cliEquivalentForTool("storage_status", {}))
      .toBe("mailery storage status --json");
    expect(cliEquivalentForTool("storage_push", { tables: "providers,domains", batch_size: 250 }))
      .toBe('mailery storage push --tables "providers,domains" --batch-size 250 --json');
    expect(cliEquivalentForTool("storage_sync", { tables: "providers,domains", batch_size: 250, force: true }))
      .toBe('mailery storage sync --tables "providers,domains" --batch-size 250 --force --json');
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
    })).toBe("mailery export emails --provider provider-1 --from ops@example.com --since 2026-01-01T00:00:00.000Z --until 2026-02-01T00:00:00.000Z --limit 2 --offset 1 --format csv");

    expect(cliEquivalentForTool("export_events", { limit: 2 }))
      .toBe("mailery export events --limit 2 --format json");
  });
});
