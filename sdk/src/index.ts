/**
 * @hasna/emails-sdk
 * Zero-dependency TypeScript client for the @hasna/emails REST API.
 * Works in Node.js, Bun, Deno, and browser environments.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface Provider {
  id: string;
  name: string;
  type: string;
  region: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export type DnsStatus = "pending" | "verified" | "failed";
export type DomainType = "system" | "self_hosted" | "local_only";
export type DomainSourceOfTruth = "local" | "postgres";
export type DomainOwnershipStatus = "pending" | "verified" | "failed";
export type DomainRouteStatus = "pending" | "ready" | "disabled" | "failed";
export type DomainMonitoringStatus = "none" | "monitoring" | "clean" | "risky";
export type DomainReadinessState =
  | "ready_to_send_and_receive"
  | "ready_to_send"
  | "ready_to_receive"
  | "needs_dns"
  | "broken";

export interface Domain {
  id: string;
  provider_id: string;
  domain: string;
  domain_type: DomainType;
  source_of_truth: DomainSourceOfTruth;
  ownership_status: DomainOwnershipStatus;
  inbound_status: DomainRouteStatus;
  outbound_status: DomainRouteStatus;
  monitoring_status: DomainMonitoringStatus;
  dkim_status: DnsStatus;
  spf_status: DnsStatus;
  dmarc_status: DnsStatus;
  dns_records: Record<string, unknown>;
  provider_metadata: Record<string, unknown>;
  verified_at: string | null;
  last_dns_check_at: string | null;
  last_inbound_check_at: string | null;
  last_outbound_check_at: string | null;
  last_monitored_at: string | null;
  restricted_at: string | null;
  suspended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DomainProvisioning {
  provisioning_status: string;
  purchase_provider: string | null;
  dns_provider: string;
  send_provider: string | null;
  cf_zone_id: string | null;
  registrar: string | null;
  nameservers: string[];
  mail_from_domain: string | null;
  last_error: string | null;
  next_check_at: string | null;
}

export interface DomainReadiness {
  state: DomainReadinessState;
  send_ready: boolean;
  receive_ready: boolean;
  inbound_evidence_ready: boolean;
  ready_addresses: number;
  inbound_evidence: {
    mode?: "local" | "self_hosted";
    source_of_truth?: DomainSourceOfTruth;
    inbound_status?: DomainRouteStatus;
    live_s3_sources: number;
    inbound_buckets: number;
  };
  issues: string[];
  fix_commands: string[];
}

export interface DomainLifecycleReadiness extends DomainReadiness {
  inbound_ready: boolean;
  outbound_ready: boolean;
  monitored: boolean;
  restricted: boolean;
  suspended: boolean;
}

export interface DomainLifecycleSummary {
  id: string;
  domain: string;
  mode: "local" | "self_hosted";
  mode_label: "Local" | "Self-hosted";
  source_of_truth: DomainSourceOfTruth;
  domain_type: DomainType;
  provider: Pick<Provider, "id" | "name" | "type" | "region" | "active"> | null;
  ownership_status: DomainOwnershipStatus;
  inbound_status: DomainRouteStatus;
  outbound_status: DomainRouteStatus;
  monitoring_status: DomainMonitoringStatus;
  readiness: DomainLifecycleReadiness;
  dns: {
    dkim: DnsStatus;
    spf: DnsStatus;
    dmarc: DnsStatus;
    missing_records: string[];
    warnings: string[];
  };
  provisioning: DomainProvisioning | null;
  provider_metadata: Record<string, unknown>;
  missing_requirements: string[];
  next_actions: string[];
}

export interface EmailAddress {
  id: string;
  provider_id: string;
  email: string;
  display_name: string | null;
  verified: boolean;
  created_at: string;
}

export interface Email {
  id: string;
  provider_id: string;
  provider_message_id: string | null;
  from_address: string;
  to_addresses: string[];
  subject: string;
  status: string;
  sent_at: string;
}

export interface EventSummary {
  id: string;
  email_id: string | null;
  provider_id: string;
  provider_event_id: string | null;
  type: string;
  recipient: string | null;
  occurred_at: string;
  created_at: string;
}

export interface EmailEvent extends EventSummary {
  metadata: Record<string, unknown>;
}

export interface PageParams {
  limit?: number;
  offset?: number;
}

export interface ListProviderParams extends PageParams {}

export interface ListDomainParams extends PageParams {
  provider_id?: string;
}

export interface DomainReadinessMutationInput {
  domain_type?: DomainType;
  source_of_truth?: DomainSourceOfTruth;
  ownership_status?: DomainOwnershipStatus;
  inbound_status?: DomainRouteStatus;
  outbound_status?: DomainRouteStatus;
  monitoring_status?: DomainMonitoringStatus;
  dns_records?: Record<string, unknown>;
  provider_metadata?: Record<string, unknown>;
  last_dns_check_at?: string | null;
  last_inbound_check_at?: string | null;
  last_outbound_check_at?: string | null;
  last_monitored_at?: string | null;
  restricted_at?: string | null;
  suspended_at?: string | null;
  force?: boolean;
}

export interface ListAddressParams extends PageParams {
  provider_id?: string;
}

export interface ListEventParams {
  email_id?: string;
  provider_id?: string;
  type?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface Contact {
  id: string;
  email: string;
  name: string | null;
  send_count: number;
  bounce_count: number;
  suppressed: boolean;
}

export interface ListContactParams extends PageParams {
  suppressed?: boolean;
}

export interface TemplateSummary {
  id: string;
  name: string;
  subject_template: string;
  has_html_template: boolean;
  has_text_template: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Template extends Omit<TemplateSummary, "has_html_template" | "has_text_template"> {
  html_template: string | null;
  text_template: string | null;
}

export interface ListTemplateParams extends PageParams {}

export interface Group {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
}

export interface ListGroupParams extends PageParams {}

export interface GroupMemberSummary {
  group_id: string;
  email: string;
  name: string | null;
  added_at: string;
}

export interface GroupMember extends GroupMemberSummary {
  vars: Record<string, string>;
}

export interface ScheduledEmailSummary {
  id: string;
  provider_id: string;
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  bcc_addresses: string[];
  reply_to: string | null;
  subject: string;
  template_name: string | null;
  scheduled_at: string;
  status: string;
  error: string | null;
  created_at: string;
}

export type ScheduledEmail = ScheduledEmailSummary;

export interface ListScheduledParams {
  status?: string;
  limit?: number;
  offset?: number;
}

export interface Sequence {
  id: string;
  name: string;
  status: string;
  created_at: string;
}

export interface ListSequenceParams extends PageParams {}

export interface SequenceStep {
  id: string;
  sequence_id: string;
  step_number: number;
  delay_hours: number;
  template_name: string;
}

export interface Enrollment {
  id: string;
  sequence_id: string;
  contact_email: string;
  current_step: number;
  status: string;
}

export interface ListEnrollmentParams extends PageParams {
  status?: string;
}

export interface SandboxEmail {
  id: string;
  from_address: string;
  to_addresses: string[];
  subject: string;
  created_at: string;
}

export interface ListSandboxEmailParams extends PageParams {
  provider_id?: string;
}

export interface InboundEmail {
  id: string;
  from_address: string;
  to_addresses: string[];
  subject: string;
  in_reply_to_email_id: string | null;
  received_at: string;
}

export interface ListInboundEmailParams extends PageParams {
  provider_id?: string;
  since?: string;
  to?: string;
  unread?: boolean;
  read?: boolean;
  archived?: boolean;
}

export interface MailboxSourceSummary {
  id: string;
  label: string;
  kind: string;
  providerId?: string | null;
  providerName?: string | null;
  providerType?: string | null;
  bucket?: string | null;
  region?: string | null;
  badges: string[];
  counts: Record<string, number>;
  total: number;
  unread: number;
  latestReceivedAt: string | null;
}

export interface MailboxStatus {
  source: unknown | null;
  inbox: number;
  unread: number;
  starred: number;
  sent: number;
  archived: number;
  spam: number;
  trash: number;
}

export interface MailboxMessage {
  id: string;
  kind: string;
  from: string;
  to: string[];
  subject: string;
  date: string;
  isRead: boolean;
  isStarred: boolean;
  labels: string[];
  threadId: string | null;
  providerThreadId: string | null;
  snippet: string | null;
  attachments: number;
}

export interface ListSourcesParams extends PageParams {
  search?: string;
}

export interface MailboxQueryParams extends PageParams {
  source_id?: string;
  search?: string;
  label?: string;
  sort?: "newest" | "oldest";
}

export interface MailboxSearchParams extends PageParams {
  source_id?: string;
  folder?: string;
  label?: string;
  sort?: "newest" | "oldest";
}

export interface WarmingSchedule {
  id: string;
  domain: string;
  target_daily_volume: number;
  start_date: string;
  status: string;
}

export interface ListWarmingScheduleParams extends PageParams {
  status?: string;
}

export interface WarmingStatus {
  schedule: WarmingSchedule;
  today_limit: number;
  today_sent: number;
  current_day: number;
}

export interface ExportEmailParams extends PageParams {
  provider_id?: string;
  from_address?: string;
  from?: string;
  since?: string;
  until?: string;
}

export interface ExportEventParams extends PageParams {
  provider_id?: string;
  since?: string;
  until?: string;
}

export interface Stats {
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  opened: number;
  clicked: number;
  delivery_rate: number;
  bounce_rate: number;
  open_rate: number;
}

export interface Analytics {
  dailyVolume: { date: string; count: number }[];
  topRecipients: { email: string; count: number }[];
  busiestHours: { hour: number; count: number }[];
  deliveryTrend: { date: string; sent: number; delivered: number; bounced: number }[];
}

export interface DnsRecord {
  type: string;
  name: string;
  value: string;
  purpose: string;
}

export interface DoctorCheck {
  name: string;
  status: string;
  message: string;
}

export interface EmailsClientOptions {
  /** Base URL of the emails server, e.g. "http://localhost:3900" */
  serverUrl: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function checkResponse(res: Response): Promise<void> {
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // ignore JSON parse errors — use status code message
    }
    throw new Error(message);
  }
}

function qs(params?: object): string {
  if (!params) return "";
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
  ) as [string, string | number | boolean][];
  if (entries.length === 0) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of entries) sp.set(k, String(v));
  return "?" + sp.toString();
}

function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

// ── Client ─────────────────────────────────────────────────────────────────

export class EmailsClient {
  private readonly baseUrl: string;

  constructor(options: EmailsClientOptions) {
    this.baseUrl = options.serverUrl.replace(/\/$/, "");
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      ...init,
      headers: { "Content-Type": "application/json", ...init.headers },
    });
    await checkResponse(res);
    return res.json() as Promise<T>;
  }

  // ── Providers ──

  async listProviders(params?: ListProviderParams): Promise<Provider[]> {
    return this.request(`/api/providers${qs(params)}`);
  }

  async addProvider(body: {
    name: string;
    type: string;
    api_key?: string;
    region?: string;
    access_key?: string;
    secret_key?: string;
  }): Promise<Provider> {
    return this.request("/api/providers", { method: "POST", body: JSON.stringify(body) });
  }

  async updateProvider(id: string, body: Record<string, unknown>): Promise<Provider> {
    return this.request(`/api/providers/${id}`, { method: "PUT", body: JSON.stringify(body) });
  }

  async removeProvider(id: string): Promise<void> {
    await this.request(`/api/providers/${id}`, { method: "DELETE" });
  }

  // ── Domains ──

  async listDomains(providerId?: string): Promise<Domain[]>;
  async listDomains(params?: ListDomainParams): Promise<Domain[]>;
  async listDomains(providerIdOrParams?: string | ListDomainParams): Promise<Domain[]> {
    const params = typeof providerIdOrParams === "string" ? { provider_id: providerIdOrParams } : providerIdOrParams;
    return this.request(`/api/domains${qs(params)}`);
  }

  async listDomainReadiness(providerId?: string): Promise<DomainLifecycleSummary[]>;
  async listDomainReadiness(params?: ListDomainParams): Promise<DomainLifecycleSummary[]>;
  async listDomainReadiness(providerIdOrParams?: string | ListDomainParams): Promise<DomainLifecycleSummary[]> {
    const params = typeof providerIdOrParams === "string" ? { provider_id: providerIdOrParams } : providerIdOrParams;
    return this.request(`/api/domains/readiness${qs(params)}`);
  }

  async getDomainReadiness(id: string): Promise<DomainLifecycleSummary> {
    return this.request(`/api/domains/${encodeURIComponent(id)}/readiness`);
  }

  async updateDomainReadiness(id: string, body: DomainReadinessMutationInput): Promise<DomainLifecycleSummary> {
    return this.request(`/api/domains/${encodeURIComponent(id)}/readiness`, { method: "PATCH", body: JSON.stringify(body) });
  }

  async addDomain(body: { provider_id: string; domain: string }): Promise<Domain> {
    return this.request("/api/domains", { method: "POST", body: JSON.stringify(body) });
  }

  async getDnsRecords(id: string): Promise<DnsRecord[]> {
    return this.request(`/api/domains/${id}/dns`);
  }

  async verifyDomain(id: string): Promise<unknown> {
    return this.request(`/api/domains/${id}/verify`, { method: "POST" });
  }

  async removeDomain(id: string): Promise<void> {
    await this.request(`/api/domains/${id}`, { method: "DELETE" });
  }

  // ── Addresses ──

  async listAddresses(params?: ListAddressParams): Promise<EmailAddress[]> {
    return this.request(`/api/addresses${qs(params)}`);
  }

  async addAddress(body: { provider_id: string; email: string; display_name?: string }): Promise<EmailAddress> {
    return this.request("/api/addresses", { method: "POST", body: JSON.stringify(body) });
  }

  async removeAddress(id: string): Promise<void> {
    await this.request(`/api/addresses/${id}`, { method: "DELETE" });
  }

  // ── Emails ──

  async listEmails(params?: {
    status?: string;
    limit?: number;
    offset?: number;
    provider_id?: string;
  }): Promise<Email[]> {
    return this.request(`/api/emails${qs(params as Record<string, string | number | undefined>)}`);
  }

  async getEmail(id: string): Promise<Email> {
    return this.request(`/api/emails/${id}`);
  }

  async searchEmails(query: string, params?: { since?: string; limit?: number; offset?: number }): Promise<Email[]> {
    return this.request(`/api/emails/search${qs({ q: query, ...params })}`);
  }

  async getEmailContent(id: string): Promise<{
    html: string | null;
    text_body: string | null;
    headers: Record<string, string>;
  }> {
    return this.request(`/api/email-content/${id}`);
  }

  // ── Events ──

  async listEvents(params?: ListEventParams): Promise<EventSummary[]> {
    return this.request(`/api/events${qs(params as Record<string, string | number | undefined>)}`);
  }

  async getEvent(id: string): Promise<EmailEvent> {
    return this.request(`/api/events/${encodeURIComponent(id)}`);
  }

  // ── Stats & Analytics ──

  async getStats(period?: string): Promise<Stats> {
    return this.request(`/api/stats${qs({ period })}`);
  }

  async getAnalytics(params?: { period?: string; provider_id?: string }): Promise<Analytics> {
    return this.request(`/api/analytics${qs(params)}`);
  }

  // ── Sync ──

  async pull(providerId?: string): Promise<Record<string, number>> {
    return this.request("/api/pull", {
      method: "POST",
      body: providerId ? JSON.stringify({ provider_id: providerId }) : "{}",
    });
  }

  // ── Contacts ──

  async listContacts(suppressed?: boolean): Promise<Contact[]>;
  async listContacts(params?: ListContactParams): Promise<Contact[]>;
  async listContacts(suppressedOrParams?: boolean | ListContactParams): Promise<Contact[]> {
    const params = typeof suppressedOrParams === "boolean" ? { suppressed: suppressedOrParams } : suppressedOrParams;
    return this.request(`/api/contacts${qs(params)}`);
  }

  async suppressContact(email: string): Promise<void> {
    await this.request(`/api/contacts/${encodeURIComponent(email)}/suppress`, { method: "POST" });
  }

  async unsuppressContact(email: string): Promise<void> {
    await this.request(`/api/contacts/${encodeURIComponent(email)}/unsuppress`, { method: "POST" });
  }

  // ── Templates ──

  async listTemplates(params?: ListTemplateParams): Promise<TemplateSummary[]> {
    return this.request(`/api/templates${qs(params)}`);
  }

  async getTemplate(nameOrId: string): Promise<Template> {
    return this.request(`/api/templates/${encodeURIComponent(nameOrId)}`);
  }

  async addTemplate(body: {
    name: string;
    subject_template: string;
    html_template?: string;
    text_template?: string;
  }): Promise<Template> {
    return this.request("/api/templates", { method: "POST", body: JSON.stringify(body) });
  }

  async removeTemplate(id: string): Promise<void> {
    await this.request(`/api/templates/${pathSegment(id)}`, { method: "DELETE" });
  }

  // ── Groups ──

  async listGroups(params?: ListGroupParams): Promise<Group[]> {
    return this.request(`/api/groups${qs(params)}`);
  }

  async createGroup(body: { name: string; description?: string }): Promise<Group> {
    return this.request("/api/groups", { method: "POST", body: JSON.stringify(body) });
  }

  async deleteGroup(id: string): Promise<void> {
    await this.request(`/api/groups/${pathSegment(id)}`, { method: "DELETE" });
  }

  async listGroupMembers(id: string, params?: { limit?: number; offset?: number }): Promise<GroupMemberSummary[]> {
    return this.request(`/api/groups/${pathSegment(id)}/members${qs(params)}`);
  }

  async getGroupMember(id: string, email: string): Promise<GroupMember> {
    return this.request(`/api/groups/${pathSegment(id)}/members/${pathSegment(email)}`);
  }

  async addGroupMember(id: string, body: { email: string; name?: string }): Promise<void> {
    await this.request(`/api/groups/${pathSegment(id)}/members`, { method: "POST", body: JSON.stringify(body) });
  }

  async removeGroupMember(id: string, email: string): Promise<void> {
    await this.request(`/api/groups/${pathSegment(id)}/members/${pathSegment(email)}`, { method: "DELETE" });
  }

  // ── Scheduled ──

  async listScheduled(status?: string): Promise<ScheduledEmailSummary[]>;
  async listScheduled(params?: ListScheduledParams): Promise<ScheduledEmailSummary[]>;
  async listScheduled(statusOrParams?: string | ListScheduledParams): Promise<ScheduledEmailSummary[]> {
    const params = typeof statusOrParams === "string" ? { status: statusOrParams } : statusOrParams;
    return this.request(`/api/scheduled${qs(params)}`);
  }

  async cancelScheduled(id: string): Promise<void> {
    await this.request(`/api/scheduled/${id}`, { method: "DELETE" });
  }

  // ── Sequences ──

  async listSequences(params?: ListSequenceParams): Promise<Sequence[]> {
    return this.request(`/api/sequences${qs(params)}`);
  }

  async createSequence(body: { name: string; description?: string }): Promise<Sequence> {
    return this.request("/api/sequences", { method: "POST", body: JSON.stringify(body) });
  }

  async deleteSequence(id: string): Promise<void> {
    await this.request(`/api/sequences/${pathSegment(id)}`, { method: "DELETE" });
  }

  async listSequenceSteps(id: string): Promise<SequenceStep[]> {
    return this.request(`/api/sequences/${pathSegment(id)}/steps`);
  }

  async addSequenceStep(
    id: string,
    body: { step_number: number; delay_hours: number; template_name: string }
  ): Promise<SequenceStep> {
    return this.request(`/api/sequences/${pathSegment(id)}/steps`, { method: "POST", body: JSON.stringify(body) });
  }

  async listEnrollments(id: string, params?: ListEnrollmentParams): Promise<Enrollment[]> {
    return this.request(`/api/sequences/${pathSegment(id)}/enrollments${qs(params)}`);
  }

  async enrollContact(
    id: string,
    body: { contact_email: string; provider_id?: string }
  ): Promise<Enrollment> {
    return this.request(`/api/sequences/${pathSegment(id)}/enroll`, { method: "POST", body: JSON.stringify(body) });
  }

  async unenrollContact(id: string, email: string): Promise<void> {
    await this.request(`/api/sequences/${pathSegment(id)}/enrollments/${pathSegment(email)}`, {
      method: "DELETE",
    });
  }

  // ── Sandbox ──

  async listSandboxEmails(params?: ListSandboxEmailParams): Promise<SandboxEmail[]> {
    return this.request(`/api/sandbox${qs(params)}`);
  }

  async getSandboxEmail(id: string): Promise<SandboxEmail> {
    return this.request(`/api/sandbox/${id}`);
  }

  async clearSandboxEmails(providerId?: string): Promise<{ deleted: number }> {
    return this.request(`/api/sandbox${qs({ provider_id: providerId })}`, { method: "DELETE" });
  }

  // ── Inbound ──

  async listInboundEmails(params?: ListInboundEmailParams): Promise<InboundEmail[]> {
    return this.request(`/api/inbound${qs(params)}`);
  }

  async getInboundEmail(id: string): Promise<InboundEmail> {
    return this.request(`/api/inbound/${id}`);
  }

  async clearInboundEmails(providerId?: string): Promise<void> {
    await this.request(`/api/inbound${qs({ provider_id: providerId })}`, { method: "DELETE" });
  }

  async listSources(params?: ListSourcesParams): Promise<MailboxSourceSummary[]> {
    const payload = await this.request<{ sources: MailboxSourceSummary[] }>(`/api/sources${qs(params)}`);
    return payload.sources;
  }

  async listMailboxes(sourceId?: string): Promise<MailboxStatus> {
    return this.request(`/api/mailboxes${qs({ source_id: sourceId })}`);
  }

  async listMailbox(folder: string, params?: MailboxQueryParams): Promise<{ items: MailboxMessage[]; truncated: boolean; limit: number; offset: number }> {
    return this.request(`/api/mailbox/${pathSegment(folder)}${qs(params)}`);
  }

  async searchMailbox(query: string, params?: MailboxSearchParams): Promise<{ items: MailboxMessage[]; truncated: boolean; limit: number; offset: number }> {
    return this.request(`/api/mailbox/search${qs({ q: query, ...params })}`);
  }

  // ── Warming ──

  async listWarmingSchedules(params?: ListWarmingScheduleParams): Promise<WarmingSchedule[]> {
    return this.request(`/api/warming${qs(params)}`);
  }

  async createWarmingSchedule(body: {
    domain: string;
    target_daily_volume: number;
    start_date?: string;
    provider_id?: string;
  }): Promise<WarmingSchedule> {
    return this.request("/api/warming", { method: "POST", body: JSON.stringify(body) });
  }

  async getWarmingStatus(
    domain: string
  ): Promise<WarmingStatus> {
    return this.request(`/api/warming/${pathSegment(domain)}`);
  }

  async updateWarmingStatus(domain: string, status: string): Promise<WarmingSchedule> {
    return this.request(`/api/warming/${pathSegment(domain)}`, { method: "PUT", body: JSON.stringify({ status }) });
  }

  async deleteWarmingSchedule(domain: string): Promise<void> {
    await this.request(`/api/warming/${pathSegment(domain)}`, { method: "DELETE" });
  }

  // ── Export ──

  async exportEmails(
    format?: "csv" | "json",
    params?: ExportEmailParams
  ): Promise<string> {
    const res = await fetch(
      this.baseUrl + `/api/export/emails${qs({ format: format || "json", ...params })}`
    );
    await checkResponse(res);
    return res.text();
  }

  async exportEvents(
    format?: "csv" | "json",
    params?: ExportEventParams
  ): Promise<string> {
    const res = await fetch(
      this.baseUrl + `/api/export/events${qs({ format: format || "json", ...params })}`
    );
    await checkResponse(res);
    return res.text();
  }

  // ── Doctor ──

  async runDoctor(): Promise<DoctorCheck[]> {
    return this.request("/api/doctor");
  }
}
