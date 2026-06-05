// Provider types
export type ProviderType = "resend" | "ses" | "gmail" | "sandbox";

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

export interface CreateProviderInput {
  name: string;
  type: ProviderType;
  api_key?: string;
  region?: string;
  access_key?: string;
  secret_key?: string;
  oauth_client_id?: string;
  oauth_client_secret?: string;
  oauth_refresh_token?: string;
  oauth_access_token?: string;
  oauth_token_expiry?: string;
}

export interface CreateGmailProviderInput {
  name: string;
  oauth_client_id: string;
  oauth_client_secret: string;
  oauth_refresh_token: string;
  oauth_access_token: string;
  oauth_token_expiry: string;
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

// Domain types
export type DnsStatus = "pending" | "verified" | "failed";

export interface Domain {
  id: string;
  provider_id: string;
  domain: string;
  dkim_status: DnsStatus;
  spf_status: DnsStatus;
  dmarc_status: DnsStatus;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DnsRecord {
  type: "TXT" | "CNAME" | "MX";
  name: string;
  value: string;
  purpose: "DKIM" | "SPF" | "DMARC" | "MX";
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
