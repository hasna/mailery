// Provider types
export type ProviderType = "resend" | "ses" | "sandbox";

export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  api_key: string | null;
  region: string | null;
  access_key: string | null;
  secret_key: string | null;
  oauth_client_id: string | null;
  oauth_client_secret: string | null;
  oauth_refresh_token: string | null;
  oauth_access_token: string | null;
  oauth_token_expiry: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export type ProviderSummary = Pick<Provider, "id" | "name" | "type" | "region" | "active" | "created_at" | "updated_at">;

export interface CreateProviderInput {
  name: string;
  type: ProviderType;
  api_key?: string;
  region?: string;
  access_key?: string;
  secret_key?: string;
}

export interface ProviderRow {
  id: string;
  name: string;
  type: string;
  api_key: string | null;
  region: string | null;
  access_key: string | null;
  secret_key: string | null;
  oauth_client_id: string | null;
  oauth_client_secret: string | null;
  oauth_refresh_token: string | null;
  oauth_access_token: string | null;
  oauth_token_expiry: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

// Core mail architecture model
export type MailboxStatus = "active" | "inactive";
export type MailFolderRole = "inbox" | "sent" | "archive" | "spam" | "trash" | "custom";
export type MailboxSourceType = "ses" | "ses_s3" | "resend" | "sandbox" | "legacy_inbound" | "manual";
export type MailboxSourceStatus = "active" | "inactive" | "legacy";
export type MailboxMessageDirection = "inbound" | "outbound" | "sent";

export interface Mailbox {
  id: string;
  address: string;
  display_name: string | null;
  owner_id: string | null;
  status: MailboxStatus;
  created_at: string;
  updated_at: string;
}

export interface MailboxRow {
  id: string;
  address: string;
  display_name: string | null;
  owner_id: string | null;
  status: MailboxStatus;
  created_at: string;
  updated_at: string;
}

export interface CreateMailboxInput {
  address: string;
  display_name?: string | null;
  owner_id?: string | null;
  status?: MailboxStatus;
}

export interface MailFolder {
  id: string;
  mailbox_id: string;
  role: MailFolderRole;
  name: string;
  path: string;
  provider_folder_id: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface MailFolderRow {
  id: string;
  mailbox_id: string;
  role: MailFolderRole;
  name: string;
  path: string;
  provider_folder_id: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface CreateMailFolderInput {
  mailbox_id: string;
  role: MailFolderRole;
  name: string;
  path: string;
  provider_folder_id?: string | null;
  sort_order?: number;
}

export interface ProviderProvenanceSnapshot {
  id: string;
  name: string;
  type: ProviderType;
  region: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface MailboxSource {
  id: string;
  mailbox_id: string;
  provider_id: string | null;
  type: MailboxSourceType;
  name: string;
  external_account_id: string | null;
  external_mailbox: string | null;
  status: MailboxSourceStatus;
  settings: Record<string, unknown>;
  provider_snapshot: ProviderProvenanceSnapshot | Record<string, unknown>;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MailboxSourceRow {
  id: string;
  mailbox_id: string;
  provider_id: string | null;
  type: MailboxSourceType;
  name: string;
  external_account_id: string | null;
  external_mailbox: string | null;
  status: MailboxSourceStatus;
  settings_json: string;
  provider_snapshot_json: string;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateMailboxSourceInput {
  mailbox_id: string;
  provider_id?: string | null;
  type: MailboxSourceType;
  name: string;
  external_account_id?: string | null;
  external_mailbox?: string | null;
  status?: MailboxSourceStatus;
  settings?: Record<string, unknown>;
  provider_snapshot?: ProviderProvenanceSnapshot | Record<string, unknown>;
  last_synced_at?: string | null;
}

export interface MailMessage {
  id: string;
  rfc_message_id: string | null;
  subject: string;
  from_address: string | null;
  to_addresses: string[];
  cc_addresses: string[];
  bcc_addresses: string[];
  text_body: string | null;
  html_body: string | null;
  headers: Record<string, unknown>;
  attachments: unknown[];
  raw_s3_url: string | null;
  metadata_s3_url: string | null;
  raw_size: number;
  sent_at: string | null;
  received_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MailMessageRow {
  id: string;
  rfc_message_id: string | null;
  subject: string;
  from_address: string | null;
  to_addresses: string;
  cc_addresses: string;
  bcc_addresses: string;
  text_body: string | null;
  html_body: string | null;
  headers_json: string;
  attachments_json: string;
  raw_s3_url: string | null;
  metadata_s3_url: string | null;
  raw_size: number;
  sent_at: string | null;
  received_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateMailMessageInput {
  rfc_message_id?: string | null;
  subject?: string;
  from_address?: string | null;
  to_addresses?: string[];
  cc_addresses?: string[];
  bcc_addresses?: string[];
  text_body?: string | null;
  html_body?: string | null;
  headers?: Record<string, unknown>;
  attachments?: unknown[];
  raw_s3_url?: string | null;
  metadata_s3_url?: string | null;
  raw_size?: number;
  sent_at?: string | null;
  received_at?: string | null;
}

export interface MailboxMessageState {
  id: string;
  mailbox_id: string;
  mail_message_id: string;
  folder_id: string | null;
  source_id: string | null;
  source_dedupe_key: string | null;
  direction: MailboxMessageDirection;
  provider_message_id: string | null;
  provider_thread_id: string | null;
  thread_id: string | null;
  labels: string[];
  is_read: boolean;
  read_at: string | null;
  is_archived: boolean;
  is_starred: boolean;
  is_spam: boolean;
  is_trash: boolean;
  received_at: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MailboxMessageStateRow {
  id: string;
  mailbox_id: string;
  mail_message_id: string;
  folder_id: string | null;
  source_id: string | null;
  source_dedupe_key: string | null;
  direction: MailboxMessageDirection;
  provider_message_id: string | null;
  provider_thread_id: string | null;
  thread_id: string | null;
  labels_json: string;
  is_read: number;
  read_at: string | null;
  is_archived: number;
  is_starred: number;
  is_spam: number;
  is_trash: number;
  received_at: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertMailboxMessageStateInput {
  mailbox_id: string;
  mail_message_id: string;
  folder_id?: string | null;
  source_id?: string | null;
  source_dedupe_key?: string | null;
  direction?: MailboxMessageDirection;
  provider_message_id?: string | null;
  provider_thread_id?: string | null;
  thread_id?: string | null;
  labels?: string[];
  is_read?: boolean;
  read_at?: string | null;
  is_archived?: boolean;
  is_starred?: boolean;
  is_spam?: boolean;
  is_trash?: boolean;
  received_at?: string | null;
  sent_at?: string | null;
}

// Domain types
export type DnsStatus = "pending" | "verified" | "failed";
export type DomainType = "system" | "self_hosted" | "local_only";
export type DomainSourceOfTruth = "local" | "postgres";
export type DomainOwnershipStatus = "pending" | "verified" | "failed";
export type DomainRouteStatus = "pending" | "ready" | "disabled" | "failed";
export type DomainMonitoringStatus = "none" | "monitoring" | "clean" | "risky";

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

export interface DnsRecord {
  type: "TXT" | "CNAME" | "MX";
  name: string;
  value: string;
  purpose: "DKIM" | "SPF" | "DMARC" | "MX" | "MAIL_FROM" | "SES_IDENTITY";
}

// Address lifecycle status. `active` can send/receive; `suspended` is blocked
// from sending (and excluded from delivery) but retained.
export type AddressStatus = "active" | "suspended";

// Email address (sender identity)
export interface EmailAddress {
  id: string;
  provider_id: string;
  email: string;
  display_name: string | null;
  verified: boolean;
  owner_id: string | null;
  administrator_id: string | null;
  status: AddressStatus;
  daily_quota: number | null;
  created_at: string;
  updated_at: string;
}

export interface AddressRow {
  id: string;
  provider_id: string;
  email: string;
  display_name: string | null;
  verified: number;
  owner_id: string | null;
  administrator_id: string | null;
  status: AddressStatus | null;
  daily_quota: number | null;
  created_at: string;
  updated_at: string;
}

export interface CreateAddressInput {
  provider_id: string;
  email: string;
  display_name?: string;
}

// Attachment
export interface Attachment {
  filename: string;
  content: string; // base64 encoded
  content_type: string;
}

// Send email options
export interface SendEmailOptions {
  provider_id?: string;
  from: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  reply_to?: string;
  subject: string;
  html?: string;
  text?: string;
  attachments?: Attachment[];
  tags?: Record<string, string>;
  headers?: Record<string, string>;
  unsubscribe_url?: string;  // Auto-injects List-Unsubscribe + List-Unsubscribe-Post headers (RFC 8058)
  idempotency_key?: string;  // If provided and already sent, returns existing email instead of re-sending
  auth_token?: string;       // Scoped send key (esk_…); restricts sending to addresses the key's owner owns/administers
  bypass_warming?: boolean;  // Trusted local override for active domain warming limits
}

// Email log
export type EmailStatus = "sent" | "delivered" | "bounced" | "complained" | "failed";

export interface Email {
  id: string;
  provider_id: string;
  provider_message_id: string | null;
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  bcc_addresses: string[];
  reply_to: string | null;
  subject: string;
  status: EmailStatus;
  has_attachments: boolean;
  attachment_count: number;
  tags: Record<string, string>;
  idempotency_key?: string | null;
  sent_at: string;
  created_at: string;
  updated_at: string;
}

export interface EmailRow {
  id: string;
  provider_id: string;
  provider_message_id: string | null;
  from_address: string;
  to_addresses: string;
  cc_addresses: string;
  bcc_addresses: string;
  reply_to: string | null;
  subject: string;
  status: string;
  has_attachments: number;
  attachment_count: number;
  tags: string;
  idempotency_key?: string | null;
  sent_at: string;
  created_at: string;
  updated_at: string;
}

// Event
export type EventType = "delivered" | "bounced" | "complained" | "opened" | "clicked" | "unsubscribed";

export interface EmailEvent {
  id: string;
  email_id: string | null;
  provider_id: string;
  provider_event_id: string | null;
  type: EventType;
  recipient: string | null;
  metadata: Record<string, unknown>;
  occurred_at: string;
  created_at: string;
}

export type EventSummary = Omit<EmailEvent, "metadata">;

export interface EventRow {
  id: string;
  email_id: string | null;
  provider_id: string;
  provider_event_id: string | null;
  type: string;
  recipient: string | null;
  metadata: string;
  occurred_at: string;
  created_at: string;
}

// Stats
export interface Stats {
  provider_id: string;
  period: string;
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

// Filter types
export interface EmailFilter {
  provider_id?: string;
  status?: EmailStatus | EmailStatus[];
  from_address?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface EventFilter {
  email_id?: string;
  provider_id?: string;
  type?: EventType | EventType[];
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

// Error classes
export class ProviderNotFoundError extends Error {
  constructor(public providerId: string) {
    super(`Provider not found: ${providerId}`);
    this.name = "ProviderNotFoundError";
  }
}

export class DomainNotFoundError extends Error {
  constructor(public domainId: string) {
    super(`Domain not found: ${domainId}`);
    this.name = "DomainNotFoundError";
  }
}

export class AddressNotFoundError extends Error {
  constructor(public addressId: string) {
    super(`Email address not found: ${addressId}`);
    this.name = "AddressNotFoundError";
  }
}

export class EmailNotFoundError extends Error {
  constructor(public emailId: string) {
    super(`Email not found: ${emailId}`);
    this.name = "EmailNotFoundError";
  }
}

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}
