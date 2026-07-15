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

  it("includes explicit MX switch flags for domain provisioning", () => {
    expect(cliEquivalentForTool("provision_domain", {
      domain: "example.com",
      provider_id: "provider-1",
      add_mx: true,
      force_mx_switch: true,
    })).toBe("emails provision domain example.com --provider provider-1 --add-mx --force-mx-switch --json");
  });

  it("includes forwarding rule commands", () => {
    expect(cliEquivalentForTool("add_forwarding_rule", {
      source_address: "user@example.com",
      target_address: "archive@example.net",
      provider_id: "provider-1",
      from_address: "user@example.com",
      enabled: false,
    })).toBe("emails forwarding add user@example.com archive@example.net --provider provider-1 --from user@example.com --disabled --json");

    expect(cliEquivalentForTool("run_forwarding_rules", { provider_id: "provider-1", limit: 5, backfill: true }))
      .toBe("emails forwarding run --provider provider-1 --limit 5 --backfill --json");
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

  it("includes inbound link extraction commands", () => {
    expect(cliEquivalentForTool("get_inbound_email", { id: "abc123" }))
      .toBe("emails inbox read abc123 --json");
    expect(cliEquivalentForTool("extract_inbound_email_links", { id: "abc123", include_non_web: true }))
      .toBe("emails inbox links abc123 --all --json");
  });

  it("includes mailbox source and folder commands", () => {
    expect(cliEquivalentForTool("list_mailbox_sources", { search: "legacy", limit: 5 }))
      .toBe("emails inbox sources --search legacy --limit 5 --json");
    expect(cliEquivalentForTool("list_mailboxes", { source_id: "legacy" }))
      .toBe("emails inbox mailboxes --source legacy --json");
    expect(cliEquivalentForTool("search_mailbox", {
      query: "invoice",
      mailbox: "sent",
      source_id: "provider:abc",
      limit: 2,
      offset: 1,
    })).toBe("emails inbox search invoice --folder sent --source provider:abc --limit 2 --offset 1 --json");
  });

  it("includes inbound attachment commands", () => {
    expect(cliEquivalentForTool("get_attachment", { email_id: "abc123", filename: "invoice.pdf" }))
      .toBe("emails inbox attachment abc123 --filename invoice.pdf --json");
    expect(cliEquivalentForTool("download_attachment", {
      email_id: "abc123",
      index: 2,
      output_dir: "/tmp/email files",
      max_bytes: 4096,
    })).toBe('emails inbox attachment abc123 --download --index 2 --output-dir "/tmp/email files" --max-bytes 4096 --json');
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
