import type { DnsRecord, DnsStatus, EventType, SendEmailOptions, Stats } from "../types/index.js";

export interface RemoteDomain {
  domain: string;
  dkim_status: DnsStatus;
  spf_status: DnsStatus;
  dmarc_status: DnsStatus;
}

export interface RemoteAddress {
  email: string;
  verified: boolean;
  display_name?: string;
}

export interface RemoteEvent {
  provider_event_id: string;
  type: EventType;
  recipient?: string;
  occurred_at: string;
  provider_message_id?: string;
  metadata?: Record<string, unknown>;
}

export interface ProviderAdapter {
  listDomains(): Promise<RemoteDomain[]>;
  getDnsRecords(domain: string): Promise<DnsRecord[]>;
  verifyDomain(domain: string): Promise<{ dkim: DnsStatus; spf: DnsStatus; dmarc: DnsStatus }>;
  addDomain(domain: string): Promise<void>;
  /** Optional: set a custom MAIL FROM domain (SES). Returns the mail-from domain used. */
  setMailFrom?(domain: string, mailFromDomain?: string): Promise<string>;
  listAddresses(): Promise<RemoteAddress[]>;
  addAddress(email: string): Promise<void>;
  verifyAddress(email: string): Promise<boolean>;
  sendEmail(opts: SendEmailOptions): Promise<string>;
  pullEvents(since?: string): Promise<RemoteEvent[]>;
  getStats(period?: string): Promise<Stats>;
}
