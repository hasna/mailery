import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { redactSecrets } from "../lib/redaction.js";
import { formatError } from "./helpers.js";

interface ToolResult {
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  [key: string]: unknown;
}

function quote(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return /^[A-Za-z0-9_@./:=+-]+$/.test(raw) ? raw : JSON.stringify(raw);
}

function arg(input: unknown, ...keys: string[]): string | undefined {
  const obj = input && typeof input === "object" ? input as Record<string, unknown> : {};
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== "") return quote(value);
  }
  return undefined;
}

function flag(input: unknown, key: string, name = key.replace(/_/g, "-")): string {
  const value = arg(input, key);
  return value ? ` --${name} ${value}` : "";
}

function enabled(input: unknown, key: string, name = key.replace(/_/g, "-")): string {
  const obj = input && typeof input === "object" ? input as Record<string, unknown> : {};
  return obj[key] === true ? ` --${name}` : "";
}

export function cliEquivalentForTool(name: string, input: unknown): string {
  const id = arg(input, "id", "provider_id", "domain_id", "address_id", "email_id", "sequence_id", "group_id");
  const email = arg(input, "email", "address", "contact_email");
  const domain = arg(input, "domain");
  const format = arg(input, "format");
  const provider = arg(input, "provider_id", "provider");
  const source = arg(input, "source_id", "source");

  const map: Record<string, () => string> = {
    prepare_inbox: () => `emails address provision ${email ?? "<email>"}${provider ? ` --provider ${provider}` : " --provider <provider>"} --json`,
    get_email_status: () => "emails status --json",
    get_agent_context: () => "emails agent context --json",
    get_next_action: () => "emails status --json",
    diagnose_inbound_delivery: () => `emails doctor delivery ${email ?? "<address>"} --json`,

    list_providers: () => `emails provider list${flag(input, "limit")}${flag(input, "offset")} --json`,
    add_provider: () => `emails provider add --name ${arg(input, "name") ?? "<name>"} --type ${arg(input, "type") ?? "<type>"} --json`,
    update_provider: () => `emails provider update ${id ?? "<provider-id>"} --json`,
    remove_provider: () => `emails provider remove ${id ?? "<provider-id>"} --yes --json`,

    list_domains: () => `emails domain list${provider ? ` --provider ${provider}` : ""}${flag(input, "limit")}${flag(input, "offset")} --json`,
    list_usable_domains: () => `emails domain usable${provider ? ` --provider ${provider}` : ""}${enabled(input, "send")}${enabled(input, "receive")}${flag(input, "limit")}${flag(input, "offset")} --json`,
    add_domain: () => `emails domain add ${domain ?? "<domain>"} --provider ${provider ?? "<provider-id>"} --json`,
    get_dns_records: () => `emails domain dns ${domain ?? id ?? "<domain-or-id>"} --json`,
    verify_domain: () => `emails domain verify ${domain ?? id ?? "<domain-or-id>"} --json`,
    remove_domain: () => `emails domain remove ${id ?? domain ?? "<domain-or-id>"} --yes --json`,
    provision_domain: () => `emails provision domain ${domain ?? "<domain>"} --provider ${provider ?? "<provider-id>"}${enabled(input, "add_mx")}${enabled(input, "force_mx_switch")} --json`,
    add_forwarding_rule: () => `emails forwarding add ${arg(input, "source_address") ?? "<source>"} ${arg(input, "target_address") ?? "<target>"}${provider ? ` --provider ${provider}` : ""}${flag(input, "from_address", "from")}${enabled(input, "enabled") ? "" : ((input as Record<string, unknown>)?.enabled === false ? " --disabled" : "")} --json`,
    list_forwarding_rules: () => `emails forwarding list${flag(input, "source_address", "source")}${enabled(input, "enabled")}${(input as Record<string, unknown>)?.enabled === false ? " --disabled" : ""}${flag(input, "limit")}${flag(input, "offset")} --json`,
    run_forwarding_rules: () => `emails forwarding run${provider ? ` --provider ${provider}` : ""}${flag(input, "from_address", "from")}${flag(input, "limit")}${enabled(input, "backfill")} --json`,
    list_warming_schedules: () => `emails domain warm-list${flag(input, "status")}${flag(input, "limit")}${flag(input, "offset")} --json`,

    list_addresses: () => `emails address list${provider ? ` --provider ${provider}` : ""}${flag(input, "limit")}${flag(input, "offset")} --json`,
    list_usable_from_addresses: () => `emails address list${provider ? ` --provider ${provider}` : ""}${flag(input, "limit")}${flag(input, "offset")} --json`,
    add_address: () => `emails address add ${email ?? "<email>"} --provider ${provider ?? "<provider-id>"} --json`,
    verify_address: () => `emails address verify ${email ?? id ?? "<address-or-id>"} --json`,
    remove_address: () => `emails address remove ${email ?? id ?? "<address-or-id>"} --yes --json`,
    suspend_address: () => `emails address suspend ${email ?? id ?? "<address-or-id>"} --json`,
    activate_address: () => `emails address activate ${email ?? id ?? "<address-or-id>"} --json`,
    set_address_quota: () => `emails address quota ${email ?? id ?? "<address-or-id>"} ${arg(input, "quota", "daily_quota") ?? "<quota>"} --json`,
    provision_address: () => `emails address provision ${email ?? "<email>"} --provider ${provider ?? "<provider-id>"} --json`,
    suggest_address: () => `emails address suggest --domain ${domain ?? "<domain>"} --json`,
    get_address_owner: () => `emails address owner ${email ?? id ?? "<address-or-id>"} --json`,
    set_address_owner: () => `emails address set-owner ${email ?? id ?? "<address-or-id>"} --owner ${arg(input, "owner") ?? "<owner>"} --json`,
    transfer_address_owner: () => `emails address transfer-owner ${email ?? id ?? "<address-or-id>"} --owner ${arg(input, "owner") ?? "<owner>"} --reason ${arg(input, "reason") ?? "<reason>"} --yes --json`,
    unassign_address_owner: () => `emails address unassign-owner ${email ?? id ?? "<address-or-id>"} --reason ${arg(input, "reason") ?? "<reason>"} --yes --json`,
    list_address_owner_history: () => `emails address owner-history ${email ?? id ?? "<address-or-id>"} --json`,

    add_alias: () => `emails alias add ${arg(input, "alias") ?? "<alias>"} ${arg(input, "target") ?? "<target>"} --json`,
    add_catch_all: () => `emails alias catch-all ${domain ?? "<domain>"} ${arg(input, "target") ?? "<target>"} --json`,
    list_aliases: () => `emails alias list${flag(input, "domain")}${flag(input, "limit")}${flag(input, "offset")} --json`,
    remove_alias: () => `emails alias remove ${arg(input, "alias") ?? "<alias>"} --json`,
    resolve_alias: () => `emails alias resolve ${email ?? "<email>"} --json`,
    create_send_key: () => `emails sendkey create ${arg(input, "owner") ?? arg(input, "owner_id") ?? "<owner>"} --json`,
    list_send_keys: () => `emails sendkey list${flag(input, "owner_id", "owner")}${flag(input, "limit")}${flag(input, "offset")} --json`,
    revoke_send_key: () => `emails sendkey revoke ${id ?? "<key-id>"} --json`,
    check_send_authorization: () => `emails sendkey check ${arg(input, "owner") ?? "<owner>"} ${email ?? "<from-email>"} --json`,

    send_email: () => `emails send --from ${arg(input, "from") ?? "<from>"} --to ${arg(input, "to") ?? "<to>"} --subject ${arg(input, "subject") ?? "<subject>"} --json`,
    list_emails: () => `emails log${flag(input, "status")}${flag(input, "from_address", "from")}${flag(input, "since")}${flag(input, "limit")}${flag(input, "offset")} --json`,
    search_emails: () => `emails search ${arg(input, "query") ?? "<query>"}${flag(input, "since")}${flag(input, "limit")}${flag(input, "offset")} --json`,
    get_email: () => `emails show ${id ?? "<email-id>"} --json`,
    get_email_content: () => `emails show ${id ?? "<email-id>"} --content --json`,
    pull_events: () => `emails sync${provider ? ` --provider ${provider}` : ""} --json`,
    get_stats: () => `emails stats${provider ? ` --provider ${provider}` : ""} --json`,

    list_templates: () => `emails template list${flag(input, "limit")}${flag(input, "offset")} --json`,
    get_template: () => `emails template show ${arg(input, "name_or_id") ?? arg(input, "name") ?? id ?? "<template>"} --json`,
    add_template: () => `emails template add ${arg(input, "name") ?? "<name>"} --subject ${arg(input, "subject_template") ?? "<subject>"} --json`,
    remove_template: () => `emails template remove ${arg(input, "name") ?? "<name>"} --json`,
    list_contacts: () => "emails contact list --json",
    suppress_contact: () => `emails contact suppress ${email ?? "<email>"} --json`,
    unsuppress_contact: () => `emails contact unsuppress ${email ?? "<email>"} --json`,

    schedule_email: () => "emails schedule create --json",
    list_scheduled: () => `emails schedule list${flag(input, "status")}${flag(input, "limit")}${flag(input, "offset")} --json`,
    cancel_scheduled: () => `emails schedule cancel ${id ?? "<scheduled-id>"} --json`,

    list_mailboxes: () => `emails inbox mailboxes${source ? ` --source ${source}` : provider ? ` --provider ${provider}` : ""}${flag(input, "address")}${flag(input, "domain")} --json`,
    list_mailbox_sources: () => `emails inbox sources${flag(input, "search")}${flag(input, "limit")} --json`,
    search_mailbox: () => `emails inbox search ${arg(input, "query") ?? "<query>"}${flag(input, "mailbox", "folder")}${source ? ` --source ${source}` : provider ? ` --provider ${provider}` : ""}${flag(input, "address")}${flag(input, "domain")}${flag(input, "label")}${flag(input, "limit")}${flag(input, "offset")} --json`,
    list_inbound_emails: () => `emails inbox list${provider ? ` --provider ${provider}` : ""} --json`,
    get_latest_inbound_email: () => `emails inbox latest ${email ?? "<address>"} --json`,
    wait_for_email: () => `emails inbox wait ${email ?? "<address>"} --json`,
    wait_for_verification_code: () => `emails inbox wait-code ${email ?? "<address>"} --json`,
    wait_for_code: () => `emails inbox wait-code ${email ?? "<address>"} --json`,
    get_inbound_email: () => `emails inbox read ${id ?? "<inbound-id>"} --json`,
    extract_inbound_email_links: () => `emails inbox links ${id ?? "<inbound-id>"}${enabled(input, "include_non_web", "all")} --json`,
    clear_inbound_emails: () => "emails inbox clear --json",
    mark_email_read: () => `emails inbox read ${id ?? "<inbound-id>"} --json`,
    archive_email: () => `emails inbox archive ${id ?? "<inbound-id>"} --json`,
    star_email: () => `emails inbox star ${id ?? "<inbound-id>"} --json`,
    label_email: () => `emails inbox label ${id ?? "<inbound-id>"} --json`,
    get_attachment: () => `emails inbox attachment ${id ?? "<inbound-id>"}${flag(input, "filename")} --json`,
    download_attachment: () => `emails inbox attachment ${id ?? "<inbound-id>"} --download${flag(input, "index")}${flag(input, "output_dir", "output-dir")}${flag(input, "max_bytes", "max-bytes")} --json`,
    search_inbound: () => `emails inbox search ${arg(input, "query") ?? "<query>"} --json`,
    get_inbox_sync_status: () => "emails inbox sync-status --json",

    list_sequences: () => `emails sequence list${flag(input, "limit")}${flag(input, "offset")} --json`,
    create_sequence: () => `emails sequence create ${arg(input, "name") ?? "<name>"} --json`,
    add_sequence_step: () => `emails sequence step add ${id ?? "<sequence-id>"} --json`,
    enroll_contact: () => `emails sequence enroll ${id ?? "<sequence-id>"} ${email ?? "<email>"} --json`,
    unenroll_contact: () => `emails sequence unenroll ${id ?? "<sequence-id>"} ${email ?? "<email>"} --json`,
    list_enrollments: () => `emails sequence enrollments${id ? ` ${id}` : ""}${flag(input, "status")}${flag(input, "limit")}${flag(input, "offset")} --json`,
    list_replies: () => `emails replies ${id ?? "<email-id>"}${flag(input, "limit")}${flag(input, "offset")} --json`,

    list_groups: () => `emails group list${flag(input, "limit")}${flag(input, "offset")} --json`,
    create_group: () => `emails group create ${arg(input, "name") ?? "<name>"} --json`,
    delete_group: () => `emails group delete ${id ?? "<group-id>"} --json`,
    add_group_member: () => `emails group add ${id ?? "<group-id>"} ${email ?? "<email>"} --json`,
    remove_group_member: () => `emails group remove-member ${id ?? "<group-id>"} ${email ?? "<email>"} --json`,
    list_group_members: () => `emails group members ${arg(input, "group_name", "group_id", "id") ?? "<group-name>"}${flag(input, "limit")}${flag(input, "offset")} --json`,
    list_sandbox_emails: () => "emails sandbox list --json",
    get_sandbox_email: () => `emails sandbox show ${id ?? "<sandbox-id>"} --json`,
    clear_sandbox_emails: () => "emails sandbox clear --json",
    get_analytics: () => "emails analytics --json",
    run_doctor: () => "emails doctor --json",
    export_emails: () => `emails export emails${provider ? ` --provider ${provider}` : ""}${flag(input, "from_address", "from")}${flag(input, "since")}${flag(input, "until")}${flag(input, "limit")}${flag(input, "offset")} --format ${format ?? "json"}`,
    export_events: () => `emails export events${provider ? ` --provider ${provider}` : ""}${flag(input, "since")}${flag(input, "until")}${flag(input, "limit")}${flag(input, "offset")} --format ${format ?? "json"}`,
    verify_email_address: () => `emails verify-email ${email ?? "<email>"} --json`,
    batch_send: () => "emails batch --json",
  };

  return map[name]?.() ?? `emails --help # MCP tool: ${name}`;
}

function errorCode(message: string): string {
  if (/could not resolve id|not found/i.test(message)) return "not_found";
  if (/requires|missing|required/i.test(message)) return "missing_required_input";
  if (/invalid|must be/i.test(message)) return "invalid_input";
  if (/credential|oauth|auth/i.test(message)) return "auth_error";
  if (/rate limit|too many/i.test(message)) return "rate_limited";
  return "error";
}

function fixCommands(message: string, cliEquivalent: string): string[] {
  const lower = message.toLowerCase();
  if (lower.includes("provider")) return ["emails provider list --json", "emails provider add --help", cliEquivalent];
  if (lower.includes("domain")) return ["emails domain list --json", "emails domain add --help", cliEquivalent];
  if (lower.includes("address")) return ["emails address list --json", "emails address provision --help", cliEquivalent];
  if (lower.includes("inbox") || lower.includes("inbound")) return ["emails inbox sync-status --json", "emails doctor delivery <address> --json", cliEquivalent];
  return [cliEquivalent, "emails status --json", "emails doctor --json"];
}

function structuredError(toolName: string, input: unknown, error: unknown): ToolResult {
  const message = formatError(error).replace(/^Error:\s*/i, "");
  const cliEquivalent = cliEquivalentForTool(toolName, input);
  const commands = fixCommands(message, cliEquivalent);
  return {
    isError: true,
    content: [{
      type: "text",
      text: JSON.stringify(redactSecrets({
        error: {
          message,
          code: errorCode(message),
          cause: message,
          fix_command: commands[0],
          fix_commands: commands,
          retryable: /timeout|rate limit|temporary|network|unavailable/i.test(message),
        },
        cli_equivalent: cliEquivalent,
      }), null, 2),
    }],
  };
}

function normalizeResult(toolName: string, input: unknown, result: ToolResult): ToolResult {
  const cliEquivalent = cliEquivalentForTool(toolName, input);
  if (result.isError) {
    const text = result.content?.find((item) => item.type === "text")?.text ?? "Tool failed";
    return structuredError(toolName, input, text);
  }

  if (!result.content?.length) {
    return {
      ...result,
      content: [{ type: "text", text: JSON.stringify({ cli_equivalent: cliEquivalent }, null, 2) }],
    };
  }

  const [first, ...rest] = result.content;
  if (!first || first.type !== "text" || typeof first.text !== "string") return result;

  let payload: unknown;
  try {
    payload = JSON.parse(first.text);
  } catch {
    payload = { result: first.text };
  }

  if (Array.isArray(payload)) {
    payload = { items: payload };
  } else if (!payload || typeof payload !== "object") {
    payload = { result: payload };
  }

  const obj = payload as Record<string, unknown>;
  if (!obj["cli_equivalent"]) obj["cli_equivalent"] = cliEquivalent;
  const redacted = redactSecrets(obj);
  if (toolName === "create_send_key" && typeof obj["token"] === "string") {
    (redacted as Record<string, unknown>)["token"] = obj["token"];
  }
  return {
    ...result,
    content: [{ ...first, text: JSON.stringify(redacted, null, 2) }, ...rest],
  };
}

export function installMcpToolContracts(server: McpServer): void {
  const target = server as unknown as { tool: (...args: unknown[]) => unknown };
  const originalTool = target.tool.bind(server);
  target.tool = (...args: unknown[]) => {
    const name = typeof args[0] === "string" ? args[0] : "unknown";
    let handlerIndex = -1;
    for (let i = args.length - 1; i >= 0; i -= 1) {
      if (typeof args[i] === "function") {
        handlerIndex = i;
        break;
      }
    }
    if (handlerIndex >= 0) {
      const handler = args[handlerIndex] as (...handlerArgs: unknown[]) => Promise<ToolResult> | ToolResult;
      args[handlerIndex] = async (...handlerArgs: unknown[]) => {
        const input = handlerArgs[0];
        try {
          return normalizeResult(name, input, await handler(...handlerArgs));
        } catch (error) {
          return structuredError(name, input, error);
        }
      };
    }
    return originalTool(...args);
  };
}
