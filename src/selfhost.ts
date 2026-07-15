// @generated from src/server/self-hosted/openapi.ts by scripts/generate-selfhost-sdk.ts — DO NOT EDIT.
// Regenerate: bun run scripts/generate-selfhost-sdk.ts
// @generated from OpenAPI by @hasna/contracts SDK generator — DO NOT EDIT.
// Source: Emails Self-Hosted API 1.0.0

export interface User { "id": string; "email": string; "name"?: string | null; "status": string; "email_verified"?: boolean; "global_role"?: "user" | "super_admin"; "is_primary_super_admin"?: boolean }

export interface Tenant { "id": string; "slug": string; "name": string; "status": string; "created_at"?: string; "updated_at"?: string }

export interface EmailIdentity { "id": string; "email": string; "is_primary": boolean; "verified": boolean; "created_at"?: string }

export interface Membership { "id": string; "user_id"?: string; "tenant_id"?: string; "email"?: string; "name"?: string | null; "role": "owner" | "admin" | "member" | "viewer"; "status": string; "created_at"?: string }

export interface Domain { "id": string; "domain": string; "status": string; "provider"?: string | null; "verified": boolean; "notes"?: string | null; "provisioning_status"?: string; "purchase_provider"?: string | null; "dns_provider"?: string; "send_provider"?: string | null; "cf_zone_id"?: string | null; "registrar"?: string | null; "nameservers_json"?: Array<string>; "mail_from_domain"?: string | null; "last_error"?: string | null; "next_check_at"?: string | null; "created_at": string; "updated_at": string }

export interface Address { "id": string; "email": string; "domain"?: string | null; "display_name"?: string | null; "status": string; "verified"?: boolean; "daily_quota"?: number | null; "domain_id"?: string | null; "receive_strategy"?: string | null; "forward_to"?: string | null; "routing_rule_id"?: string | null; "provisioning_status"?: string; "last_validated_at"?: string | null; "last_error"?: string | null; "next_check_at"?: string | null; "created_at": string; "updated_at": string }

export interface MessageListItem { "id": string; "direction": string; "from_addr": string; "to_addrs": Array<string>; "cc_addrs"?: Array<string>; "subject"?: string | null; "snippet"?: string | null; "status": string; "provider_message_id"?: string | null; "message_id"?: string | null; "in_reply_to"?: string | null; "received_at"?: string | null; "is_read"?: boolean; "is_starred"?: boolean; "labels"?: Array<string>; "headers"?: Record<string, unknown>; "attachments"?: Array<Record<string, unknown>>; "source_id"?: string | null; "send_state"?: string; "send_started_at"?: string | null; "created_at": string; "updated_at": string }

export interface Message { "id": string; "direction": string; "from_addr": string; "to_addrs": Array<string>; "cc_addrs"?: Array<string>; "subject"?: string | null; "body_text"?: string | null; "body_html"?: string | null; "status": string; "provider_message_id"?: string | null; "message_id"?: string | null; "in_reply_to"?: string | null; "received_at"?: string | null; "is_read"?: boolean; "is_starred"?: boolean; "labels"?: Array<string>; "headers"?: Record<string, unknown>; "attachments"?: Array<Record<string, unknown>>; "source_id"?: string | null; "send_state"?: string; "send_started_at"?: string | null; "created_at": string; "updated_at": string }

export interface AttachmentContent { "filename": string; "content_type": string; "size": number; "content_base64": string }

export interface Thread { "thread_key": string; "subject"?: string | null; "message_count": number; "unread_count": number; "last_message_at"?: string | null; "first_message_at"?: string | null; "participants"?: Array<string> }

export interface Mailbox { "id": string; "address": string; "display_name"?: string | null; "status"?: string; "total": number; "unread": number }

export interface EmailsSelfHostClientOptions {
  /** Base URL, e.g. process.env.APP_API_URL. */
  baseUrl: string;
  /** API key, e.g. process.env.APP_API_KEY. Sent as the 'x-api-key' header. */
  apiKey?: string;
  /** Opaque emss_ user session (or bearer-compatible API key). */
  bearerToken?: string;
  /** Custom fetch (defaults to global fetch). */
  fetch?: typeof fetch;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

export class EmailsSelfHostClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly bearerToken: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly baseHeaders: Record<string, string>;

  constructor(options: EmailsSelfHostClientOptions) {
    if (!options.baseUrl) throw new Error("EmailsSelfHostClient requires a baseUrl.");
    const parsedBaseUrl = new URL(options.baseUrl);
    const loopback = parsedBaseUrl.hostname === "localhost"
      || parsedBaseUrl.hostname === "127.0.0.1"
      || parsedBaseUrl.hostname === "[::1]"
      || parsedBaseUrl.hostname === "::1";
    if (parsedBaseUrl.protocol !== "https:" && !(parsedBaseUrl.protocol === "http:" && loopback)) {
      throw new Error("EmailsSelfHostClient requires HTTPS except for loopback development URLs.");
    }
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.bearerToken = options.bearerToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseHeaders = options.headers ?? {};
  }

  private async request<T>(method: string, path: string, opts: { body?: unknown; query?: Record<string, unknown>; init?: RequestInit }): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (opts.query) {
      for (const [key, value] of Object.entries(opts.query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }
    const headers: Record<string, string> = { Accept: "application/json", ...this.baseHeaders, ...(opts.init?.headers as Record<string, string> | undefined) };
    if (this.bearerToken) headers["Authorization"] = `Bearer ${this.bearerToken}`;
    else if (this.apiKey) headers["x-api-key"] = this.apiKey;
    let payload: BodyInit | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(opts.body);
    }
    const response = await this.fetchImpl(url.toString(), { ...opts.init, method, headers, body: payload, redirect: "error" });
    const text = await response.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : undefined;
    if (!response.ok) {
      throw new ApiError(response.status, `${method} ${path} failed: ${response.status}`, data);
    }
    return data as T;
  }

    /** Liveness probe with database reachability */
    async getHealth(init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("GET", `/health`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Return this OpenAPI document */
    async getOpenApiDocument(init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("GET", `/openapi.json`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Readiness probe (reachable and fully migrated) */
    async getReady(init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("GET", `/ready`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** List tenant-scoped address-ownership-events */
    async listResourceAddressOwnershipEvents(query?: { "limit"?: number; "offset"?: number; "address_id"?: string | null; "action"?: string | null }, init?: RequestInit): Promise<{ "items": Array<{ "id"?: string | null; "address_id"?: string | null; "action"?: string | null; "previous_owner_id"?: string | null; "previous_administrator_id"?: string | null; "owner_id"?: string | null; "administrator_id"?: string | null; "actor"?: string | null; "reason"?: string | null; "created_at"?: string; "updated_at"?: string }> }> {
      return this.request("GET", `/v1/address-ownership-events`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Create a tenant-scoped address-ownership-events row */
    async createResourceAddressOwnershipEvents(body: { "id"?: string | null; "address_id"?: string | null; "action"?: string | null; "previous_owner_id"?: string | null; "previous_administrator_id"?: string | null; "owner_id"?: string | null; "administrator_id"?: string | null; "actor"?: string | null; "reason"?: string | null; "created_at"?: string | null }, init?: RequestInit): Promise<{ "id"?: string | null; "address_id"?: string | null; "action"?: string | null; "previous_owner_id"?: string | null; "previous_administrator_id"?: string | null; "owner_id"?: string | null; "administrator_id"?: string | null; "actor"?: string | null; "reason"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("POST", `/v1/address-ownership-events`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Get a tenant-scoped address-ownership-events row */
    async getResourceAddressOwnershipEvents(id: string, init?: RequestInit): Promise<{ "id"?: string | null; "address_id"?: string | null; "action"?: string | null; "previous_owner_id"?: string | null; "previous_administrator_id"?: string | null; "owner_id"?: string | null; "administrator_id"?: string | null; "actor"?: string | null; "reason"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("GET", `/v1/address-ownership-events/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Delete a tenant-scoped address-ownership-events row */
    async deleteResourceAddressOwnershipEvents(id: string, init?: RequestInit): Promise<{ "deleted": boolean; "id": string }> {
      return this.request("DELETE", `/v1/address-ownership-events/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Update a tenant-scoped address-ownership-events row */
    async updateResourceAddressOwnershipEvents(id: string, body: { "id"?: string | null; "address_id"?: string | null; "action"?: string | null; "previous_owner_id"?: string | null; "previous_administrator_id"?: string | null; "owner_id"?: string | null; "administrator_id"?: string | null; "actor"?: string | null; "reason"?: string | null; "created_at"?: string | null }, init?: RequestInit): Promise<{ "id"?: string | null; "address_id"?: string | null; "action"?: string | null; "previous_owner_id"?: string | null; "previous_administrator_id"?: string | null; "owner_id"?: string | null; "administrator_id"?: string | null; "actor"?: string | null; "reason"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("PATCH", `/v1/address-ownership-events/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    async listAddresses(query?: { "limit"?: number; "offset"?: number }, init?: RequestInit): Promise<{ "addresses"?: Array<Address> }> {
      return this.request("GET", `/v1/addresses`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Register an email address (scope emails:write) */
    async createAddress(body: { "email": string; "display_name"?: string | null; "status"?: string }, init?: RequestInit): Promise<{ "address"?: Address }> {
      return this.request("POST", `/v1/addresses`, {
        body,
        query: undefined,
        init,
      });
    }

    async getAddress(id: string, init?: RequestInit): Promise<{ "address"?: Address }> {
      return this.request("GET", `/v1/addresses/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    async deleteAddress(id: string, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("DELETE", `/v1/addresses/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    async updateAddress(id: string, body: { "display_name"?: string | null; "status"?: string; "verified"?: boolean; "daily_quota"?: number | null; "domain_id"?: string | null; "receive_strategy"?: string | null; "forward_to"?: string | null; "routing_rule_id"?: string | null; "provisioning_status"?: string; "last_validated_at"?: string | null; "last_error"?: string | null; "next_check_at"?: string | null }, init?: RequestInit): Promise<{ "address"?: Address }> {
      return this.request("PATCH", `/v1/addresses/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** List tenant-scoped aliases */
    async listResourceAliases(query?: { "limit"?: number; "offset"?: number; "domain"?: string | null; "local_part"?: string | null; "target_address"?: string | null }, init?: RequestInit): Promise<{ "items": Array<{ "id"?: string; "domain"?: string | null; "local_part"?: string | null; "target_address"?: string | null; "protected"?: boolean; "created_at"?: string; "updated_at"?: string }> }> {
      return this.request("GET", `/v1/aliases`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Create a tenant-scoped aliases row */
    async createResourceAliases(body: { "domain"?: string | null; "local_part"?: string | null; "target_address"?: string | null; "protected"?: boolean }, init?: RequestInit): Promise<{ "id"?: string; "domain"?: string | null; "local_part"?: string | null; "target_address"?: string | null; "protected"?: boolean; "created_at"?: string; "updated_at"?: string }> {
      return this.request("POST", `/v1/aliases`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Get a tenant-scoped aliases row */
    async getResourceAliases(id: string, init?: RequestInit): Promise<{ "id"?: string; "domain"?: string | null; "local_part"?: string | null; "target_address"?: string | null; "protected"?: boolean; "created_at"?: string; "updated_at"?: string }> {
      return this.request("GET", `/v1/aliases/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Delete a tenant-scoped aliases row */
    async deleteResourceAliases(id: string, init?: RequestInit): Promise<{ "deleted": boolean; "id": string }> {
      return this.request("DELETE", `/v1/aliases/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Update a tenant-scoped aliases row */
    async updateResourceAliases(id: string, body: { "domain"?: string | null; "local_part"?: string | null; "target_address"?: string | null; "protected"?: boolean }, init?: RequestInit): Promise<{ "id"?: string; "domain"?: string | null; "local_part"?: string | null; "target_address"?: string | null; "protected"?: boolean; "created_at"?: string; "updated_at"?: string }> {
      return this.request("PATCH", `/v1/aliases/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Create the first tenant owner using a tenant-bound operator API key */
    async bootstrapOwner(body: { "email": string; "password": string; "name"?: string | null }, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("POST", `/v1/auth/bootstrap-owner`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Idempotently register the configured primary platform super-admin */
    async bootstrapPrimarySuperAdmin(body: { "email"?: string | null; "password": string; "name"?: string | null }, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("POST", `/v1/auth/bootstrap-super-admin`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Authenticate a verified user and create a tenant-bound session */
    async logIn(body: { "email": string; "password": string; "tenant_slug"?: string | null }, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("POST", `/v1/auth/login`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Revoke the current user session */
    async logOut(init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("POST", `/v1/auth/logout`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Revoke every session for the current user */
    async logOutAll(init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("POST", `/v1/auth/logout-all`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Request a password reset without revealing account existence */
    async requestPasswordReset(body: { "email": string }, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("POST", `/v1/auth/password/forgot`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Consume a password-reset token and revoke existing sessions */
    async resetPassword(body: { "token": string; "new_password": string }, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("POST", `/v1/auth/password/reset`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Create an unverified user and owner membership, then send email verification */
    async signUp(body: { "email": string; "password": string; "name"?: string | null; "tenant_name": string; "tenant_slug"?: string | null }, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("POST", `/v1/auth/signup`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Rotate the current user session into another tenant membership */
    async switchTenant(body: { "tenant_slug": string }, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("POST", `/v1/auth/switch-tenant`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Verify a user email from a query-string token */
    async verifyEmailLink(query?: { "token": string }, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("GET", `/v1/auth/verify-email`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Verify a user email from a JSON token */
    async verifyEmailToken(body: { "token": string }, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("POST", `/v1/auth/verify-email`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Request another verification message without revealing account existence */
    async resendEmailVerification(body: { "email": string }, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("POST", `/v1/auth/verify-email/resend`, {
        body,
        query: undefined,
        init,
      });
    }

    /** List tenant-scoped contacts */
    async listResourceContacts(query?: { "limit"?: number; "offset"?: number; "suppressed"?: boolean; "email"?: string | null }, init?: RequestInit): Promise<{ "items": Array<{ "id"?: string; "email"?: string | null; "name"?: string | null; "send_count"?: number; "bounce_count"?: number; "complaint_count"?: number; "last_sent_at"?: string | null; "suppressed"?: boolean; "created_at"?: string; "updated_at"?: string }> }> {
      return this.request("GET", `/v1/contacts`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Create a tenant-scoped contacts row */
    async createResourceContacts(body: { "email"?: string | null; "name"?: string | null; "send_count"?: number; "bounce_count"?: number; "complaint_count"?: number; "last_sent_at"?: string | null; "suppressed"?: boolean }, init?: RequestInit): Promise<{ "id"?: string; "email"?: string | null; "name"?: string | null; "send_count"?: number; "bounce_count"?: number; "complaint_count"?: number; "last_sent_at"?: string | null; "suppressed"?: boolean; "created_at"?: string; "updated_at"?: string }> {
      return this.request("POST", `/v1/contacts`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Get a tenant-scoped contacts row */
    async getResourceContacts(id: string, init?: RequestInit): Promise<{ "id"?: string; "email"?: string | null; "name"?: string | null; "send_count"?: number; "bounce_count"?: number; "complaint_count"?: number; "last_sent_at"?: string | null; "suppressed"?: boolean; "created_at"?: string; "updated_at"?: string }> {
      return this.request("GET", `/v1/contacts/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Delete a tenant-scoped contacts row */
    async deleteResourceContacts(id: string, init?: RequestInit): Promise<{ "deleted": boolean; "id": string }> {
      return this.request("DELETE", `/v1/contacts/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Update a tenant-scoped contacts row */
    async updateResourceContacts(id: string, body: { "email"?: string | null; "name"?: string | null; "send_count"?: number; "bounce_count"?: number; "complaint_count"?: number; "last_sent_at"?: string | null; "suppressed"?: boolean }, init?: RequestInit): Promise<{ "id"?: string; "email"?: string | null; "name"?: string | null; "send_count"?: number; "bounce_count"?: number; "complaint_count"?: number; "last_sent_at"?: string | null; "suppressed"?: boolean; "created_at"?: string; "updated_at"?: string }> {
      return this.request("PATCH", `/v1/contacts/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** List sending domains */
    async listDomains(query?: { "limit"?: number; "offset"?: number }, init?: RequestInit): Promise<{ "domains"?: Array<Domain> }> {
      return this.request("GET", `/v1/domains`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Register a sending domain (scope emails:write) */
    async createDomain(body: { "domain": string; "status"?: string; "provider"?: string | null; "verified"?: boolean; "notes"?: string | null }, init?: RequestInit): Promise<{ "domain"?: Domain }> {
      return this.request("POST", `/v1/domains`, {
        body,
        query: undefined,
        init,
      });
    }

    async getDomain(id: string, init?: RequestInit): Promise<{ "domain"?: Domain }> {
      return this.request("GET", `/v1/domains/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    async deleteDomain(id: string, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("DELETE", `/v1/domains/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    async updateDomain(id: string, body: { "status"?: string; "provider"?: string | null; "verified"?: boolean; "notes"?: string | null; "provisioning_status"?: string; "purchase_provider"?: string | null; "dns_provider"?: string; "send_provider"?: string | null; "cf_zone_id"?: string | null; "registrar"?: string | null; "nameservers_json"?: Array<string>; "mail_from_domain"?: string | null; "last_error"?: string | null; "next_check_at"?: string | null }, init?: RequestInit): Promise<{ "domain"?: Domain }> {
      return this.request("PATCH", `/v1/domains/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** List tenant-scoped email-agent-runs */
    async listResourceEmailAgentRuns(query?: { "limit"?: number; "offset"?: number; "agent_key"?: string | null; "inbound_email_id"?: string | null; "status"?: string | null }, init?: RequestInit): Promise<{ "items": Array<{ "id"?: string; "agent_key"?: string | null; "inbound_email_id"?: string | null; "provider"?: string | null; "model"?: string | null; "status"?: string | null; "category"?: string | null; "labels_json"?: unknown; "priority"?: number; "confidence"?: number; "risk_score"?: number; "summary"?: string | null; "reasoning"?: string | null; "tool_calls_json"?: unknown; "output_json"?: unknown; "error"?: string | null; "started_at"?: string | null; "completed_at"?: string | null; "created_at"?: string; "updated_at"?: string }> }> {
      return this.request("GET", `/v1/email-agent-runs`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Create a tenant-scoped email-agent-runs row */
    async createResourceEmailAgentRuns(body: { "agent_key"?: string | null; "inbound_email_id"?: string | null; "provider"?: string | null; "model"?: string | null; "status"?: string | null; "category"?: string | null; "labels_json"?: unknown; "priority"?: number; "confidence"?: number; "risk_score"?: number; "summary"?: string | null; "reasoning"?: string | null; "tool_calls_json"?: unknown; "output_json"?: unknown; "error"?: string | null; "started_at"?: string | null; "completed_at"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "agent_key"?: string | null; "inbound_email_id"?: string | null; "provider"?: string | null; "model"?: string | null; "status"?: string | null; "category"?: string | null; "labels_json"?: unknown; "priority"?: number; "confidence"?: number; "risk_score"?: number; "summary"?: string | null; "reasoning"?: string | null; "tool_calls_json"?: unknown; "output_json"?: unknown; "error"?: string | null; "started_at"?: string | null; "completed_at"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("POST", `/v1/email-agent-runs`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Get a tenant-scoped email-agent-runs row */
    async getResourceEmailAgentRuns(id: string, init?: RequestInit): Promise<{ "id"?: string; "agent_key"?: string | null; "inbound_email_id"?: string | null; "provider"?: string | null; "model"?: string | null; "status"?: string | null; "category"?: string | null; "labels_json"?: unknown; "priority"?: number; "confidence"?: number; "risk_score"?: number; "summary"?: string | null; "reasoning"?: string | null; "tool_calls_json"?: unknown; "output_json"?: unknown; "error"?: string | null; "started_at"?: string | null; "completed_at"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("GET", `/v1/email-agent-runs/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Delete a tenant-scoped email-agent-runs row */
    async deleteResourceEmailAgentRuns(id: string, init?: RequestInit): Promise<{ "deleted": boolean; "id": string }> {
      return this.request("DELETE", `/v1/email-agent-runs/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Update a tenant-scoped email-agent-runs row */
    async updateResourceEmailAgentRuns(id: string, body: { "agent_key"?: string | null; "inbound_email_id"?: string | null; "provider"?: string | null; "model"?: string | null; "status"?: string | null; "category"?: string | null; "labels_json"?: unknown; "priority"?: number; "confidence"?: number; "risk_score"?: number; "summary"?: string | null; "reasoning"?: string | null; "tool_calls_json"?: unknown; "output_json"?: unknown; "error"?: string | null; "started_at"?: string | null; "completed_at"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "agent_key"?: string | null; "inbound_email_id"?: string | null; "provider"?: string | null; "model"?: string | null; "status"?: string | null; "category"?: string | null; "labels_json"?: unknown; "priority"?: number; "confidence"?: number; "risk_score"?: number; "summary"?: string | null; "reasoning"?: string | null; "tool_calls_json"?: unknown; "output_json"?: unknown; "error"?: string | null; "started_at"?: string | null; "completed_at"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("PATCH", `/v1/email-agent-runs/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** List tenant-scoped email-agents */
    async listResourceEmailAgents(query?: { "limit"?: number; "offset"?: number }, init?: RequestInit): Promise<{ "items": Array<{ "agent_key"?: string | null; "enabled"?: boolean; "always_on"?: boolean; "provider"?: string | null; "model"?: string | null; "apply_labels"?: boolean; "use_network_tools"?: boolean; "config_json"?: unknown; "created_at"?: string; "updated_at"?: string }> }> {
      return this.request("GET", `/v1/email-agents`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Create a tenant-scoped email-agents row */
    async createResourceEmailAgents(body: { "agent_key"?: string | null; "enabled"?: boolean; "always_on"?: boolean; "provider"?: string | null; "model"?: string | null; "apply_labels"?: boolean; "use_network_tools"?: boolean; "config_json"?: unknown }, init?: RequestInit): Promise<{ "agent_key"?: string | null; "enabled"?: boolean; "always_on"?: boolean; "provider"?: string | null; "model"?: string | null; "apply_labels"?: boolean; "use_network_tools"?: boolean; "config_json"?: unknown; "created_at"?: string; "updated_at"?: string }> {
      return this.request("POST", `/v1/email-agents`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Get a tenant-scoped email-agents row */
    async getResourceEmailAgents(id: string, init?: RequestInit): Promise<{ "agent_key"?: string | null; "enabled"?: boolean; "always_on"?: boolean; "provider"?: string | null; "model"?: string | null; "apply_labels"?: boolean; "use_network_tools"?: boolean; "config_json"?: unknown; "created_at"?: string; "updated_at"?: string }> {
      return this.request("GET", `/v1/email-agents/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Delete a tenant-scoped email-agents row */
    async deleteResourceEmailAgents(id: string, init?: RequestInit): Promise<{ "deleted": boolean; "id": string }> {
      return this.request("DELETE", `/v1/email-agents/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Update a tenant-scoped email-agents row */
    async updateResourceEmailAgents(id: string, body: { "agent_key"?: string | null; "enabled"?: boolean; "always_on"?: boolean; "provider"?: string | null; "model"?: string | null; "apply_labels"?: boolean; "use_network_tools"?: boolean; "config_json"?: unknown }, init?: RequestInit): Promise<{ "agent_key"?: string | null; "enabled"?: boolean; "always_on"?: boolean; "provider"?: string | null; "model"?: string | null; "apply_labels"?: boolean; "use_network_tools"?: boolean; "config_json"?: unknown; "created_at"?: string; "updated_at"?: string }> {
      return this.request("PATCH", `/v1/email-agents/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** List tenant-scoped email-digests */
    async listResourceEmailDigests(query?: { "limit"?: number; "offset"?: number; "period"?: string | null; "status"?: string | null }, init?: RequestInit): Promise<{ "items": Array<{ "id"?: string; "period"?: string | null; "since"?: string | null; "until"?: string | null; "provider"?: string | null; "model"?: string | null; "status"?: string | null; "message_count"?: number; "summary"?: string | null; "highlights_json"?: unknown; "action_items_json"?: unknown; "important_email_ids_json"?: unknown; "label_counts_json"?: unknown; "error"?: string | null; "started_at"?: string | null; "completed_at"?: string | null; "created_at"?: string; "updated_at"?: string }> }> {
      return this.request("GET", `/v1/email-digests`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Create a tenant-scoped email-digests row */
    async createResourceEmailDigests(body: { "period"?: string | null; "since"?: string | null; "until"?: string | null; "provider"?: string | null; "model"?: string | null; "status"?: string | null; "message_count"?: number; "summary"?: string | null; "highlights_json"?: unknown; "action_items_json"?: unknown; "important_email_ids_json"?: unknown; "label_counts_json"?: unknown; "error"?: string | null; "started_at"?: string | null; "completed_at"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "period"?: string | null; "since"?: string | null; "until"?: string | null; "provider"?: string | null; "model"?: string | null; "status"?: string | null; "message_count"?: number; "summary"?: string | null; "highlights_json"?: unknown; "action_items_json"?: unknown; "important_email_ids_json"?: unknown; "label_counts_json"?: unknown; "error"?: string | null; "started_at"?: string | null; "completed_at"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("POST", `/v1/email-digests`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Get a tenant-scoped email-digests row */
    async getResourceEmailDigests(id: string, init?: RequestInit): Promise<{ "id"?: string; "period"?: string | null; "since"?: string | null; "until"?: string | null; "provider"?: string | null; "model"?: string | null; "status"?: string | null; "message_count"?: number; "summary"?: string | null; "highlights_json"?: unknown; "action_items_json"?: unknown; "important_email_ids_json"?: unknown; "label_counts_json"?: unknown; "error"?: string | null; "started_at"?: string | null; "completed_at"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("GET", `/v1/email-digests/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Delete a tenant-scoped email-digests row */
    async deleteResourceEmailDigests(id: string, init?: RequestInit): Promise<{ "deleted": boolean; "id": string }> {
      return this.request("DELETE", `/v1/email-digests/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Update a tenant-scoped email-digests row */
    async updateResourceEmailDigests(id: string, body: { "period"?: string | null; "since"?: string | null; "until"?: string | null; "provider"?: string | null; "model"?: string | null; "status"?: string | null; "message_count"?: number; "summary"?: string | null; "highlights_json"?: unknown; "action_items_json"?: unknown; "important_email_ids_json"?: unknown; "label_counts_json"?: unknown; "error"?: string | null; "started_at"?: string | null; "completed_at"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "period"?: string | null; "since"?: string | null; "until"?: string | null; "provider"?: string | null; "model"?: string | null; "status"?: string | null; "message_count"?: number; "summary"?: string | null; "highlights_json"?: unknown; "action_items_json"?: unknown; "important_email_ids_json"?: unknown; "label_counts_json"?: unknown; "error"?: string | null; "started_at"?: string | null; "completed_at"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("PATCH", `/v1/email-digests/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** List tenant-scoped events */
    async listResourceEvents(query?: { "limit"?: number; "offset"?: number; "email_id"?: string | null; "provider_id"?: string | null; "type"?: string | null; "recipient"?: string | null }, init?: RequestInit): Promise<{ "items": Array<{ "id"?: string; "email_id"?: string | null; "provider_id"?: string | null; "provider_event_id"?: string | null; "type"?: string | null; "recipient"?: string | null; "metadata"?: unknown; "occurred_at"?: string | null; "created_at"?: string; "updated_at"?: string }> }> {
      return this.request("GET", `/v1/events`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Create a tenant-scoped events row */
    async createResourceEvents(body: { "email_id"?: string | null; "provider_id"?: string | null; "provider_event_id"?: string | null; "type"?: string | null; "recipient"?: string | null; "metadata"?: unknown; "occurred_at"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "email_id"?: string | null; "provider_id"?: string | null; "provider_event_id"?: string | null; "type"?: string | null; "recipient"?: string | null; "metadata"?: unknown; "occurred_at"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("POST", `/v1/events`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Get a tenant-scoped events row */
    async getResourceEvents(id: string, init?: RequestInit): Promise<{ "id"?: string; "email_id"?: string | null; "provider_id"?: string | null; "provider_event_id"?: string | null; "type"?: string | null; "recipient"?: string | null; "metadata"?: unknown; "occurred_at"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("GET", `/v1/events/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Delete a tenant-scoped events row */
    async deleteResourceEvents(id: string, init?: RequestInit): Promise<{ "deleted": boolean; "id": string }> {
      return this.request("DELETE", `/v1/events/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Update a tenant-scoped events row */
    async updateResourceEvents(id: string, body: { "email_id"?: string | null; "provider_id"?: string | null; "provider_event_id"?: string | null; "type"?: string | null; "recipient"?: string | null; "metadata"?: unknown; "occurred_at"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "email_id"?: string | null; "provider_id"?: string | null; "provider_event_id"?: string | null; "type"?: string | null; "recipient"?: string | null; "metadata"?: unknown; "occurred_at"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("PATCH", `/v1/events/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** List tenant-scoped forwarding */
    async listResourceForwarding(query?: { "limit"?: number; "offset"?: number; "source_address"?: string | null; "target_address"?: string | null; "mode"?: string | null }, init?: RequestInit): Promise<{ "items": Array<{ "id"?: string; "source_address"?: string | null; "target_address"?: string | null; "mode"?: string | null; "provider_id"?: string | null; "from_address"?: string | null; "enabled"?: boolean; "created_at"?: string; "updated_at"?: string }> }> {
      return this.request("GET", `/v1/forwarding`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Create a tenant-scoped forwarding row */
    async createResourceForwarding(body: { "source_address"?: string | null; "target_address"?: string | null; "mode"?: string | null; "provider_id"?: string | null; "from_address"?: string | null; "enabled"?: boolean }, init?: RequestInit): Promise<{ "id"?: string; "source_address"?: string | null; "target_address"?: string | null; "mode"?: string | null; "provider_id"?: string | null; "from_address"?: string | null; "enabled"?: boolean; "created_at"?: string; "updated_at"?: string }> {
      return this.request("POST", `/v1/forwarding`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Get a tenant-scoped forwarding row */
    async getResourceForwarding(id: string, init?: RequestInit): Promise<{ "id"?: string; "source_address"?: string | null; "target_address"?: string | null; "mode"?: string | null; "provider_id"?: string | null; "from_address"?: string | null; "enabled"?: boolean; "created_at"?: string; "updated_at"?: string }> {
      return this.request("GET", `/v1/forwarding/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Delete a tenant-scoped forwarding row */
    async deleteResourceForwarding(id: string, init?: RequestInit): Promise<{ "deleted": boolean; "id": string }> {
      return this.request("DELETE", `/v1/forwarding/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Update a tenant-scoped forwarding row */
    async updateResourceForwarding(id: string, body: { "source_address"?: string | null; "target_address"?: string | null; "mode"?: string | null; "provider_id"?: string | null; "from_address"?: string | null; "enabled"?: boolean }, init?: RequestInit): Promise<{ "id"?: string; "source_address"?: string | null; "target_address"?: string | null; "mode"?: string | null; "provider_id"?: string | null; "from_address"?: string | null; "enabled"?: boolean; "created_at"?: string; "updated_at"?: string }> {
      return this.request("PATCH", `/v1/forwarding/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** List tenant-scoped group-members */
    async listResourceGroupMembers(query?: { "limit"?: number; "offset"?: number; "group_id"?: string | null; "email"?: string | null }, init?: RequestInit): Promise<{ "items": Array<{ "id"?: string; "group_id"?: string | null; "email"?: string | null; "name"?: string | null; "vars"?: string | null; "added_at"?: string | null; "created_at"?: string; "updated_at"?: string }> }> {
      return this.request("GET", `/v1/group-members`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Create a tenant-scoped group-members row */
    async createResourceGroupMembers(body: { "group_id"?: string | null; "email"?: string | null; "name"?: string | null; "vars"?: string | null; "added_at"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "group_id"?: string | null; "email"?: string | null; "name"?: string | null; "vars"?: string | null; "added_at"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("POST", `/v1/group-members`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Get a tenant-scoped group-members row */
    async getResourceGroupMembers(id: string, init?: RequestInit): Promise<{ "id"?: string; "group_id"?: string | null; "email"?: string | null; "name"?: string | null; "vars"?: string | null; "added_at"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("GET", `/v1/group-members/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Delete a tenant-scoped group-members row */
    async deleteResourceGroupMembers(id: string, init?: RequestInit): Promise<{ "deleted": boolean; "id": string }> {
      return this.request("DELETE", `/v1/group-members/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Update a tenant-scoped group-members row */
    async updateResourceGroupMembers(id: string, body: { "group_id"?: string | null; "email"?: string | null; "name"?: string | null; "vars"?: string | null; "added_at"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "group_id"?: string | null; "email"?: string | null; "name"?: string | null; "vars"?: string | null; "added_at"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("PATCH", `/v1/group-members/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** List tenant-scoped groups */
    async listResourceGroups(query?: { "limit"?: number; "offset"?: number }, init?: RequestInit): Promise<{ "items": Array<{ "id"?: string; "name"?: string | null; "description"?: string | null; "created_at"?: string; "updated_at"?: string }> }> {
      return this.request("GET", `/v1/groups`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Create a tenant-scoped groups row */
    async createResourceGroups(body: { "name"?: string | null; "description"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "name"?: string | null; "description"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("POST", `/v1/groups`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Get a tenant-scoped groups row */
    async getResourceGroups(id: string, init?: RequestInit): Promise<{ "id"?: string; "name"?: string | null; "description"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("GET", `/v1/groups/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Delete a tenant-scoped groups row */
    async deleteResourceGroups(id: string, init?: RequestInit): Promise<{ "deleted": boolean; "id": string }> {
      return this.request("DELETE", `/v1/groups/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Update a tenant-scoped groups row */
    async updateResourceGroups(id: string, body: { "name"?: string | null; "description"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "name"?: string | null; "description"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("PATCH", `/v1/groups/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Accept an invitation and create a tenant-bound session */
    async acceptInvite(body: { "token": string; "password"?: string | null; "name"?: string | null }, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("POST", `/v1/invites/accept`, {
        body,
        query: undefined,
        init,
      });
    }

    /** List tenant API-key metadata; owner or admin user session required */
    async listTenantKeys(init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("GET", `/v1/keys`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Mint a tenant API key; plaintext token is returned once */
    async createTenantKey(body: { "scopes"?: Array<string>; "ttl_days"?: number | null }, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("POST", `/v1/keys`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Revoke a tenant API key; owner or admin user session required */
    async revokeTenantKey(id: string, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("DELETE", `/v1/keys/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Mail-view: registered addresses as mailboxes plus global folder counts */
    async listMailboxes(init?: RequestInit): Promise<{ "mailboxes"?: Array<Mailbox>; "counts"?: Record<string, unknown> }> {
      return this.request("GET", `/v1/mailboxes`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Return the authenticated user or API-key principal and active tenant */
    async getCurrentPrincipal(init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("GET", `/v1/me`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** List all login email identities for the current user */
    async listEmailIdentities(init?: RequestInit): Promise<{ "email_identities"?: Array<EmailIdentity> }> {
      return this.request("GET", `/v1/me/email-identities`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Add an email identity and send verification */
    async addEmailIdentity(body: { "email": string }, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("POST", `/v1/me/email-identities`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Remove a non-primary email identity */
    async removeEmailIdentity(id: string, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("DELETE", `/v1/me/email-identities/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Make a verified email identity primary */
    async makePrimaryEmailIdentity(id: string, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("POST", `/v1/me/email-identities/${encodeURIComponent(String(id))}/primary`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Compatibility alias for membership role update */
    async replaceMembership(id: string, body: { "role": "owner" | "admin" | "member" | "viewer" }, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("PUT", `/v1/memberships/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Remove a tenant membership under owner/admin role gates */
    async removeMembership(id: string, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("DELETE", `/v1/memberships/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Change a membership role under owner/admin role gates */
    async updateMembership(id: string, body: { "role": "owner" | "admin" | "member" | "viewer" }, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("PATCH", `/v1/memberships/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    async listMessages(query?: { "limit"?: number; "offset"?: number; "direction"?: "inbound" | "outbound"; "to"?: string; "from"?: string; "subject"?: string; "search"?: string; "since"?: string }, init?: RequestInit): Promise<{ "messages"?: Array<MessageListItem> }> {
      return this.request("GET", `/v1/messages`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Import an inbound message. Supplying source_id makes the write idempotent. Scope emails:write. */
    async createMessage(body: { "from": string; "to": Array<string>; "cc"?: Array<string>; "subject"?: string | null; "text"?: string | null; "html"?: string | null; "status"?: string; "direction": "inbound"; "received_at"?: string | null; "message_id"?: string | null; "in_reply_to"?: string | null; "is_read"?: boolean; "is_starred"?: boolean; "labels"?: Array<string>; "headers"?: Record<string, unknown>; "attachments"?: Array<Record<string, unknown>>; "provider_message_id"?: string | null; "source_id"?: string }, init?: RequestInit): Promise<{ "message"?: Message }> {
      return this.request("POST", `/v1/messages`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Return server-side mailbox counts */
    async getMessageCounts(init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("GET", `/v1/messages/counts`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Send through the configured SES or Resend provider and persist the resulting ledger row */
    async sendMessage(body: { "from": string; "to": Array<string>; "cc"?: Array<string>; "bcc"?: Array<string>; "reply_to"?: string; "subject": string; "text"?: string; "html"?: string; "attachments"?: Array<{ "filename": string; "content": string; "content_type": string }>; "send_key"?: string; "idempotency_key": string }, init?: RequestInit): Promise<{ "message"?: Message; "provider"?: string }> {
      return this.request("POST", `/v1/messages/send`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Mail-view: subject-rolled-up conversation list (newest activity first) */
    async listThreads(query?: { "limit"?: number; "offset"?: number }, init?: RequestInit): Promise<{ "threads"?: Array<Thread> }> {
      return this.request("GET", `/v1/messages/threads`, {
        body: undefined,
        query,
        init,
      });
    }

    async getMessage(id: string, init?: RequestInit): Promise<{ "message"?: Message }> {
      return this.request("GET", `/v1/messages/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    async deleteMessage(id: string, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("DELETE", `/v1/messages/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    async updateMessage(id: string, body: { "status"?: string; "provider_message_id"?: string | null; "is_read"?: boolean; "is_starred"?: boolean; "archived"?: boolean; "add_label"?: string; "remove_label"?: string }, init?: RequestInit): Promise<{ "message"?: Message }> {
      return this.request("PATCH", `/v1/messages/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    async getMessageAttachment(id: string, index: number, query?: { "max_bytes"?: number }, init?: RequestInit): Promise<{ "attachment": AttachmentContent }> {
      return this.request("GET", `/v1/messages/${encodeURIComponent(String(id))}/attachments/${encodeURIComponent(String(index))}`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Mail-view: reconstructed raw MIME for a stored message */
    async getMessageRaw(id: string, init?: RequestInit): Promise<{ "raw": string; "message_id"?: string | null }> {
      return this.request("GET", `/v1/messages/${encodeURIComponent(String(id))}/raw`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Return this OpenAPI document from the versioned API prefix */
    async getVersionedOpenApiDocument(init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("GET", `/v1/openapi.json`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** List tenant-scoped owners */
    async listResourceOwners(query?: { "limit"?: number; "offset"?: number; "type"?: string | null }, init?: RequestInit): Promise<{ "items": Array<{ "id"?: string; "type"?: string | null; "name"?: string | null; "contact_email"?: string | null; "external_id"?: string | null; "created_at"?: string; "updated_at"?: string }> }> {
      return this.request("GET", `/v1/owners`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Create a tenant-scoped owners row */
    async createResourceOwners(body: { "type"?: string | null; "name"?: string | null; "contact_email"?: string | null; "external_id"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "type"?: string | null; "name"?: string | null; "contact_email"?: string | null; "external_id"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("POST", `/v1/owners`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Get a tenant-scoped owners row */
    async getResourceOwners(id: string, init?: RequestInit): Promise<{ "id"?: string; "type"?: string | null; "name"?: string | null; "contact_email"?: string | null; "external_id"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("GET", `/v1/owners/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Delete a tenant-scoped owners row */
    async deleteResourceOwners(id: string, init?: RequestInit): Promise<{ "deleted": boolean; "id": string }> {
      return this.request("DELETE", `/v1/owners/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Update a tenant-scoped owners row */
    async updateResourceOwners(id: string, body: { "type"?: string | null; "name"?: string | null; "contact_email"?: string | null; "external_id"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "type"?: string | null; "name"?: string | null; "contact_email"?: string | null; "external_id"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("PATCH", `/v1/owners/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** List tenant-scoped providers */
    async listResourceProviders(query?: { "limit"?: number; "offset"?: number; "type"?: string | null }, init?: RequestInit): Promise<{ "items": Array<{ "id"?: string; "name"?: string | null; "type"?: string | null; "region"?: string | null; "active"?: boolean; "created_at"?: string; "updated_at"?: string }> }> {
      return this.request("GET", `/v1/providers`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Create a tenant-scoped providers row */
    async createResourceProviders(body: { "name"?: string | null; "type"?: string | null; "region"?: string | null; "active"?: boolean }, init?: RequestInit): Promise<{ "id"?: string; "name"?: string | null; "type"?: string | null; "region"?: string | null; "active"?: boolean; "created_at"?: string; "updated_at"?: string }> {
      return this.request("POST", `/v1/providers`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Get a tenant-scoped providers row */
    async getResourceProviders(id: string, init?: RequestInit): Promise<{ "id"?: string; "name"?: string | null; "type"?: string | null; "region"?: string | null; "active"?: boolean; "created_at"?: string; "updated_at"?: string }> {
      return this.request("GET", `/v1/providers/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Delete a tenant-scoped providers row */
    async deleteResourceProviders(id: string, init?: RequestInit): Promise<{ "deleted": boolean; "id": string }> {
      return this.request("DELETE", `/v1/providers/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Update a tenant-scoped providers row */
    async updateResourceProviders(id: string, body: { "name"?: string | null; "type"?: string | null; "region"?: string | null; "active"?: boolean }, init?: RequestInit): Promise<{ "id"?: string; "name"?: string | null; "type"?: string | null; "region"?: string | null; "active"?: boolean; "created_at"?: string; "updated_at"?: string }> {
      return this.request("PATCH", `/v1/providers/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** List tenant-scoped provisioning */
    async listResourceProvisioning(query?: { "limit"?: number; "offset"?: number; "entity_type"?: string | null; "entity_id"?: string | null; "to_state"?: string | null }, init?: RequestInit): Promise<{ "items": Array<{ "id"?: string; "entity_type"?: string | null; "entity_id"?: string | null; "from_state"?: string | null; "to_state"?: string | null; "detail_json"?: unknown; "created_at"?: string; "updated_at"?: string }> }> {
      return this.request("GET", `/v1/provisioning`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Create a tenant-scoped provisioning row */
    async createResourceProvisioning(body: { "entity_type"?: string | null; "entity_id"?: string | null; "from_state"?: string | null; "to_state"?: string | null; "detail_json"?: unknown }, init?: RequestInit): Promise<{ "id"?: string; "entity_type"?: string | null; "entity_id"?: string | null; "from_state"?: string | null; "to_state"?: string | null; "detail_json"?: unknown; "created_at"?: string; "updated_at"?: string }> {
      return this.request("POST", `/v1/provisioning`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Get a tenant-scoped provisioning row */
    async getResourceProvisioning(id: string, init?: RequestInit): Promise<{ "id"?: string; "entity_type"?: string | null; "entity_id"?: string | null; "from_state"?: string | null; "to_state"?: string | null; "detail_json"?: unknown; "created_at"?: string; "updated_at"?: string }> {
      return this.request("GET", `/v1/provisioning/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Delete a tenant-scoped provisioning row */
    async deleteResourceProvisioning(id: string, init?: RequestInit): Promise<{ "deleted": boolean; "id": string }> {
      return this.request("DELETE", `/v1/provisioning/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Update a tenant-scoped provisioning row */
    async updateResourceProvisioning(id: string, body: { "entity_type"?: string | null; "entity_id"?: string | null; "from_state"?: string | null; "to_state"?: string | null; "detail_json"?: unknown }, init?: RequestInit): Promise<{ "id"?: string; "entity_type"?: string | null; "entity_id"?: string | null; "from_state"?: string | null; "to_state"?: string | null; "detail_json"?: unknown; "created_at"?: string; "updated_at"?: string }> {
      return this.request("PATCH", `/v1/provisioning/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** List tenant-scoped sandbox-emails */
    async listResourceSandboxEmails(query?: { "limit"?: number; "offset"?: number; "provider_id"?: string | null }, init?: RequestInit): Promise<{ "items": Array<{ "id"?: string; "provider_id"?: string | null; "from_address"?: string | null; "to_addresses"?: unknown; "cc_addresses"?: unknown; "bcc_addresses"?: unknown; "reply_to"?: string | null; "subject"?: string | null; "html"?: string | null; "text_body"?: string | null; "attachments_json"?: string | null; "headers_json"?: string | null; "created_at"?: string; "updated_at"?: string }> }> {
      return this.request("GET", `/v1/sandbox-emails`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Create a tenant-scoped sandbox-emails row */
    async createResourceSandboxEmails(body: { "provider_id"?: string | null; "from_address"?: string | null; "to_addresses"?: unknown; "cc_addresses"?: unknown; "bcc_addresses"?: unknown; "reply_to"?: string | null; "subject"?: string | null; "html"?: string | null; "text_body"?: string | null; "attachments_json"?: string | null; "headers_json"?: string | null; "created_at"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "provider_id"?: string | null; "from_address"?: string | null; "to_addresses"?: unknown; "cc_addresses"?: unknown; "bcc_addresses"?: unknown; "reply_to"?: string | null; "subject"?: string | null; "html"?: string | null; "text_body"?: string | null; "attachments_json"?: string | null; "headers_json"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("POST", `/v1/sandbox-emails`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Get a tenant-scoped sandbox-emails row */
    async getResourceSandboxEmails(id: string, init?: RequestInit): Promise<{ "id"?: string; "provider_id"?: string | null; "from_address"?: string | null; "to_addresses"?: unknown; "cc_addresses"?: unknown; "bcc_addresses"?: unknown; "reply_to"?: string | null; "subject"?: string | null; "html"?: string | null; "text_body"?: string | null; "attachments_json"?: string | null; "headers_json"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("GET", `/v1/sandbox-emails/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Delete a tenant-scoped sandbox-emails row */
    async deleteResourceSandboxEmails(id: string, init?: RequestInit): Promise<{ "deleted": boolean; "id": string }> {
      return this.request("DELETE", `/v1/sandbox-emails/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Update a tenant-scoped sandbox-emails row */
    async updateResourceSandboxEmails(id: string, body: { "provider_id"?: string | null; "from_address"?: string | null; "to_addresses"?: unknown; "cc_addresses"?: unknown; "bcc_addresses"?: unknown; "reply_to"?: string | null; "subject"?: string | null; "html"?: string | null; "text_body"?: string | null; "attachments_json"?: string | null; "headers_json"?: string | null; "created_at"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "provider_id"?: string | null; "from_address"?: string | null; "to_addresses"?: unknown; "cc_addresses"?: unknown; "bcc_addresses"?: unknown; "reply_to"?: string | null; "subject"?: string | null; "html"?: string | null; "text_body"?: string | null; "attachments_json"?: string | null; "headers_json"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("PATCH", `/v1/sandbox-emails/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** List tenant-scoped scheduled */
    async listResourceScheduled(query?: { "limit"?: number; "offset"?: number; "status"?: string | null }, init?: RequestInit): Promise<{ "items": Array<{ "id"?: string; "provider_id"?: string | null; "from_address"?: string | null; "to_addresses"?: unknown; "cc_addresses"?: unknown; "bcc_addresses"?: unknown; "reply_to"?: string | null; "subject"?: string | null; "html"?: string | null; "text_body"?: string | null; "attachments_json"?: unknown; "template_name"?: string | null; "template_vars"?: unknown; "scheduled_at"?: string | null; "status"?: string | null; "error"?: string | null; "created_at"?: string; "updated_at"?: string }> }> {
      return this.request("GET", `/v1/scheduled`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Create a tenant-scoped scheduled row */
    async createResourceScheduled(body: { "provider_id"?: string | null; "from_address"?: string | null; "to_addresses"?: unknown; "cc_addresses"?: unknown; "bcc_addresses"?: unknown; "reply_to"?: string | null; "subject"?: string | null; "html"?: string | null; "text_body"?: string | null; "attachments_json"?: unknown; "template_name"?: string | null; "template_vars"?: unknown; "scheduled_at"?: string | null; "status"?: string | null; "error"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "provider_id"?: string | null; "from_address"?: string | null; "to_addresses"?: unknown; "cc_addresses"?: unknown; "bcc_addresses"?: unknown; "reply_to"?: string | null; "subject"?: string | null; "html"?: string | null; "text_body"?: string | null; "attachments_json"?: unknown; "template_name"?: string | null; "template_vars"?: unknown; "scheduled_at"?: string | null; "status"?: string | null; "error"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("POST", `/v1/scheduled`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Get a tenant-scoped scheduled row */
    async getResourceScheduled(id: string, init?: RequestInit): Promise<{ "id"?: string; "provider_id"?: string | null; "from_address"?: string | null; "to_addresses"?: unknown; "cc_addresses"?: unknown; "bcc_addresses"?: unknown; "reply_to"?: string | null; "subject"?: string | null; "html"?: string | null; "text_body"?: string | null; "attachments_json"?: unknown; "template_name"?: string | null; "template_vars"?: unknown; "scheduled_at"?: string | null; "status"?: string | null; "error"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("GET", `/v1/scheduled/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Delete a tenant-scoped scheduled row */
    async deleteResourceScheduled(id: string, init?: RequestInit): Promise<{ "deleted": boolean; "id": string }> {
      return this.request("DELETE", `/v1/scheduled/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Update a tenant-scoped scheduled row */
    async updateResourceScheduled(id: string, body: { "provider_id"?: string | null; "from_address"?: string | null; "to_addresses"?: unknown; "cc_addresses"?: unknown; "bcc_addresses"?: unknown; "reply_to"?: string | null; "subject"?: string | null; "html"?: string | null; "text_body"?: string | null; "attachments_json"?: unknown; "template_name"?: string | null; "template_vars"?: unknown; "scheduled_at"?: string | null; "status"?: string | null; "error"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "provider_id"?: string | null; "from_address"?: string | null; "to_addresses"?: unknown; "cc_addresses"?: unknown; "bcc_addresses"?: unknown; "reply_to"?: string | null; "subject"?: string | null; "html"?: string | null; "text_body"?: string | null; "attachments_json"?: unknown; "template_name"?: string | null; "template_vars"?: unknown; "scheduled_at"?: string | null; "status"?: string | null; "error"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("PATCH", `/v1/scheduled/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** List tenant-scoped send-keys */
    async listResourceSendKeys(query?: { "limit"?: number; "offset"?: number; "owner_id"?: string | null }, init?: RequestInit): Promise<{ "items": Array<{ "id"?: string; "owner_id"?: string | null; "prefix"?: string | null; "label"?: string | null; "last_used_at"?: string | null; "revoked_at"?: string | null; "created_at"?: string; "updated_at"?: string }> }> {
      return this.request("GET", `/v1/send-keys`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Create a tenant-scoped send-keys row */
    async createResourceSendKeys(body: { "owner_id"?: string | null; "prefix"?: string | null; "label"?: string | null; "last_used_at"?: string | null; "revoked_at"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "owner_id"?: string | null; "prefix"?: string | null; "label"?: string | null; "last_used_at"?: string | null; "revoked_at"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("POST", `/v1/send-keys`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Issue a scoped send key; the token is returned ONCE and never stored */
    async mintSendKey(body: { "owner_id": string; "label"?: string | null }, init?: RequestInit): Promise<{ "token": string; "key": Record<string, unknown> }> {
      return this.request("POST", `/v1/send-keys/mint`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Verify a send-key token and (optionally) that it may send from a given address */
    async verifySendKey(body: { "token": string; "from"?: string }, init?: RequestInit): Promise<{ "valid": boolean; "authorized": boolean; "key"?: Record<string, unknown> | null }> {
      return this.request("POST", `/v1/send-keys/verify`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Get a tenant-scoped send-keys row */
    async getResourceSendKeys(id: string, init?: RequestInit): Promise<{ "id"?: string; "owner_id"?: string | null; "prefix"?: string | null; "label"?: string | null; "last_used_at"?: string | null; "revoked_at"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("GET", `/v1/send-keys/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Delete a tenant-scoped send-keys row */
    async deleteResourceSendKeys(id: string, init?: RequestInit): Promise<{ "deleted": boolean; "id": string }> {
      return this.request("DELETE", `/v1/send-keys/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Update a tenant-scoped send-keys row */
    async updateResourceSendKeys(id: string, body: { "owner_id"?: string | null; "prefix"?: string | null; "label"?: string | null; "last_used_at"?: string | null; "revoked_at"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "owner_id"?: string | null; "prefix"?: string | null; "label"?: string | null; "last_used_at"?: string | null; "revoked_at"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("PATCH", `/v1/send-keys/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** List tenant-scoped sequence-enrollments */
    async listResourceSequenceEnrollments(query?: { "limit"?: number; "offset"?: number; "sequence_id"?: string | null; "status"?: string | null }, init?: RequestInit): Promise<{ "items": Array<{ "id"?: string; "sequence_id"?: string | null; "contact_email"?: string | null; "provider_id"?: string | null; "current_step"?: number; "status"?: string | null; "enrolled_at"?: string | null; "next_send_at"?: string | null; "completed_at"?: string | null; "created_at"?: string; "updated_at"?: string }> }> {
      return this.request("GET", `/v1/sequence-enrollments`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Create a tenant-scoped sequence-enrollments row */
    async createResourceSequenceEnrollments(body: { "sequence_id"?: string | null; "contact_email"?: string | null; "provider_id"?: string | null; "current_step"?: number; "status"?: string | null; "enrolled_at"?: string | null; "next_send_at"?: string | null; "completed_at"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "sequence_id"?: string | null; "contact_email"?: string | null; "provider_id"?: string | null; "current_step"?: number; "status"?: string | null; "enrolled_at"?: string | null; "next_send_at"?: string | null; "completed_at"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("POST", `/v1/sequence-enrollments`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Get a tenant-scoped sequence-enrollments row */
    async getResourceSequenceEnrollments(id: string, init?: RequestInit): Promise<{ "id"?: string; "sequence_id"?: string | null; "contact_email"?: string | null; "provider_id"?: string | null; "current_step"?: number; "status"?: string | null; "enrolled_at"?: string | null; "next_send_at"?: string | null; "completed_at"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("GET", `/v1/sequence-enrollments/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Delete a tenant-scoped sequence-enrollments row */
    async deleteResourceSequenceEnrollments(id: string, init?: RequestInit): Promise<{ "deleted": boolean; "id": string }> {
      return this.request("DELETE", `/v1/sequence-enrollments/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Update a tenant-scoped sequence-enrollments row */
    async updateResourceSequenceEnrollments(id: string, body: { "sequence_id"?: string | null; "contact_email"?: string | null; "provider_id"?: string | null; "current_step"?: number; "status"?: string | null; "enrolled_at"?: string | null; "next_send_at"?: string | null; "completed_at"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "sequence_id"?: string | null; "contact_email"?: string | null; "provider_id"?: string | null; "current_step"?: number; "status"?: string | null; "enrolled_at"?: string | null; "next_send_at"?: string | null; "completed_at"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("PATCH", `/v1/sequence-enrollments/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** List tenant-scoped sequence-steps */
    async listResourceSequenceSteps(query?: { "limit"?: number; "offset"?: number; "sequence_id"?: string | null }, init?: RequestInit): Promise<{ "items": Array<{ "id"?: string; "sequence_id"?: string | null; "step_number"?: number; "delay_hours"?: number; "template_name"?: string | null; "from_address"?: string | null; "subject_override"?: string | null; "created_at"?: string; "updated_at"?: string }> }> {
      return this.request("GET", `/v1/sequence-steps`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Create a tenant-scoped sequence-steps row */
    async createResourceSequenceSteps(body: { "sequence_id"?: string | null; "step_number"?: number; "delay_hours"?: number; "template_name"?: string | null; "from_address"?: string | null; "subject_override"?: string | null; "created_at"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "sequence_id"?: string | null; "step_number"?: number; "delay_hours"?: number; "template_name"?: string | null; "from_address"?: string | null; "subject_override"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("POST", `/v1/sequence-steps`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Get a tenant-scoped sequence-steps row */
    async getResourceSequenceSteps(id: string, init?: RequestInit): Promise<{ "id"?: string; "sequence_id"?: string | null; "step_number"?: number; "delay_hours"?: number; "template_name"?: string | null; "from_address"?: string | null; "subject_override"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("GET", `/v1/sequence-steps/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Delete a tenant-scoped sequence-steps row */
    async deleteResourceSequenceSteps(id: string, init?: RequestInit): Promise<{ "deleted": boolean; "id": string }> {
      return this.request("DELETE", `/v1/sequence-steps/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Update a tenant-scoped sequence-steps row */
    async updateResourceSequenceSteps(id: string, body: { "sequence_id"?: string | null; "step_number"?: number; "delay_hours"?: number; "template_name"?: string | null; "from_address"?: string | null; "subject_override"?: string | null; "created_at"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "sequence_id"?: string | null; "step_number"?: number; "delay_hours"?: number; "template_name"?: string | null; "from_address"?: string | null; "subject_override"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("PATCH", `/v1/sequence-steps/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** List tenant-scoped sequences */
    async listResourceSequences(query?: { "limit"?: number; "offset"?: number }, init?: RequestInit): Promise<{ "items": Array<{ "id"?: string; "name"?: string | null; "description"?: string | null; "status"?: string | null; "created_at"?: string; "updated_at"?: string }> }> {
      return this.request("GET", `/v1/sequences`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Create a tenant-scoped sequences row */
    async createResourceSequences(body: { "name"?: string | null; "description"?: string | null; "status"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "name"?: string | null; "description"?: string | null; "status"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("POST", `/v1/sequences`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Get a tenant-scoped sequences row */
    async getResourceSequences(id: string, init?: RequestInit): Promise<{ "id"?: string; "name"?: string | null; "description"?: string | null; "status"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("GET", `/v1/sequences/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Delete a tenant-scoped sequences row */
    async deleteResourceSequences(id: string, init?: RequestInit): Promise<{ "deleted": boolean; "id": string }> {
      return this.request("DELETE", `/v1/sequences/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Update a tenant-scoped sequences row */
    async updateResourceSequences(id: string, body: { "name"?: string | null; "description"?: string | null; "status"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "name"?: string | null; "description"?: string | null; "status"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("PATCH", `/v1/sequences/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** List tenant-scoped sources */
    async listResourceSources(query?: { "limit"?: number; "offset"?: number; "mailbox_id"?: string | null; "provider_id"?: string | null; "type"?: string | null; "status"?: string | null }, init?: RequestInit): Promise<{ "items": Array<{ "id"?: string; "mailbox_id"?: string | null; "provider_id"?: string | null; "type"?: string | null; "name"?: string | null; "external_account_id"?: string | null; "external_mailbox"?: string | null; "status"?: string | null; "settings_json"?: unknown; "provider_snapshot_json"?: unknown; "last_synced_at"?: string | null; "created_at"?: string; "updated_at"?: string }> }> {
      return this.request("GET", `/v1/sources`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Create a tenant-scoped sources row */
    async createResourceSources(body: { "mailbox_id"?: string | null; "provider_id"?: string | null; "type"?: string | null; "name"?: string | null; "external_account_id"?: string | null; "external_mailbox"?: string | null; "status"?: string | null; "settings_json"?: unknown; "provider_snapshot_json"?: unknown; "last_synced_at"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "mailbox_id"?: string | null; "provider_id"?: string | null; "type"?: string | null; "name"?: string | null; "external_account_id"?: string | null; "external_mailbox"?: string | null; "status"?: string | null; "settings_json"?: unknown; "provider_snapshot_json"?: unknown; "last_synced_at"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("POST", `/v1/sources`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Get a tenant-scoped sources row */
    async getResourceSources(id: string, init?: RequestInit): Promise<{ "id"?: string; "mailbox_id"?: string | null; "provider_id"?: string | null; "type"?: string | null; "name"?: string | null; "external_account_id"?: string | null; "external_mailbox"?: string | null; "status"?: string | null; "settings_json"?: unknown; "provider_snapshot_json"?: unknown; "last_synced_at"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("GET", `/v1/sources/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Delete a tenant-scoped sources row */
    async deleteResourceSources(id: string, init?: RequestInit): Promise<{ "deleted": boolean; "id": string }> {
      return this.request("DELETE", `/v1/sources/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Update a tenant-scoped sources row */
    async updateResourceSources(id: string, body: { "mailbox_id"?: string | null; "provider_id"?: string | null; "type"?: string | null; "name"?: string | null; "external_account_id"?: string | null; "external_mailbox"?: string | null; "status"?: string | null; "settings_json"?: unknown; "provider_snapshot_json"?: unknown; "last_synced_at"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "mailbox_id"?: string | null; "provider_id"?: string | null; "type"?: string | null; "name"?: string | null; "external_account_id"?: string | null; "external_mailbox"?: string | null; "status"?: string | null; "settings_json"?: unknown; "provider_snapshot_json"?: unknown; "last_synced_at"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("PATCH", `/v1/sources/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** List tenant-scoped templates */
    async listResourceTemplates(query?: { "limit"?: number; "offset"?: number }, init?: RequestInit): Promise<{ "items": Array<{ "id"?: string; "name"?: string | null; "subject_template"?: string | null; "html_template"?: string | null; "text_template"?: string | null; "metadata"?: unknown; "created_at"?: string; "updated_at"?: string }> }> {
      return this.request("GET", `/v1/templates`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Create a tenant-scoped templates row */
    async createResourceTemplates(body: { "name"?: string | null; "subject_template"?: string | null; "html_template"?: string | null; "text_template"?: string | null; "metadata"?: unknown }, init?: RequestInit): Promise<{ "id"?: string; "name"?: string | null; "subject_template"?: string | null; "html_template"?: string | null; "text_template"?: string | null; "metadata"?: unknown; "created_at"?: string; "updated_at"?: string }> {
      return this.request("POST", `/v1/templates`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Get a tenant-scoped templates row */
    async getResourceTemplates(id: string, init?: RequestInit): Promise<{ "id"?: string; "name"?: string | null; "subject_template"?: string | null; "html_template"?: string | null; "text_template"?: string | null; "metadata"?: unknown; "created_at"?: string; "updated_at"?: string }> {
      return this.request("GET", `/v1/templates/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Delete a tenant-scoped templates row */
    async deleteResourceTemplates(id: string, init?: RequestInit): Promise<{ "deleted": boolean; "id": string }> {
      return this.request("DELETE", `/v1/templates/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Update a tenant-scoped templates row */
    async updateResourceTemplates(id: string, body: { "name"?: string | null; "subject_template"?: string | null; "html_template"?: string | null; "text_template"?: string | null; "metadata"?: unknown }, init?: RequestInit): Promise<{ "id"?: string; "name"?: string | null; "subject_template"?: string | null; "html_template"?: string | null; "text_template"?: string | null; "metadata"?: unknown; "created_at"?: string; "updated_at"?: string }> {
      return this.request("PATCH", `/v1/templates/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** List the current user's active tenant memberships */
    async listTenants(init?: RequestInit): Promise<{ "tenants"?: Array<Tenant> }> {
      return this.request("GET", `/v1/tenants`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Create a tenant owned by the current user */
    async createTenant(body: { "name": string; "slug"?: string | null }, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("POST", `/v1/tenants`, {
        body,
        query: undefined,
        init,
      });
    }

    async getTenant(id: string, init?: RequestInit): Promise<{ "tenant"?: Tenant }> {
      return this.request("GET", `/v1/tenants/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Compatibility alias for tenant update */
    async replaceTenant(id: string, body: { "name"?: string; "slug"?: string; "status"?: string }, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("PUT", `/v1/tenants/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Suspend a tenant; owner role required */
    async suspendTenant(id: string, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("DELETE", `/v1/tenants/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    async updateTenant(id: string, body: { "name"?: string; "slug"?: string; "status"?: string }, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("PATCH", `/v1/tenants/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** List outstanding tenant invitations; owner or admin role required */
    async listTenantInvites(id: string, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("GET", `/v1/tenants/${encodeURIComponent(String(id))}/invites`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Invite a user; only an owner may grant the owner role */
    async createTenantInvite(id: string, body: { "email": string; "role"?: "owner" | "admin" | "member" }, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("POST", `/v1/tenants/${encodeURIComponent(String(id))}/invites`, {
        body,
        query: undefined,
        init,
      });
    }

    /** List tenant memberships; owner or admin role required */
    async listTenantMembers(id: string, init?: RequestInit): Promise<{ "members"?: Array<Membership> }> {
      return this.request("GET", `/v1/tenants/${encodeURIComponent(String(id))}/members`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** List tenant-scoped triage */
    async listResourceTriage(query?: { "limit"?: number; "offset"?: number; "label"?: string | null; "priority"?: number; "sentiment"?: string | null; "email_id"?: string | null; "inbound_email_id"?: string | null }, init?: RequestInit): Promise<{ "items": Array<{ "id"?: string; "email_id"?: string | null; "inbound_email_id"?: string | null; "label"?: string | null; "priority"?: number; "summary"?: string | null; "sentiment"?: string | null; "draft_reply"?: string | null; "confidence"?: number; "model"?: string | null; "triaged_at"?: string | null; "created_at"?: string; "updated_at"?: string }> }> {
      return this.request("GET", `/v1/triage`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Create a tenant-scoped triage row */
    async createResourceTriage(body: { "email_id"?: string | null; "inbound_email_id"?: string | null; "label"?: string | null; "priority"?: number; "summary"?: string | null; "sentiment"?: string | null; "draft_reply"?: string | null; "confidence"?: number; "model"?: string | null; "triaged_at"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "email_id"?: string | null; "inbound_email_id"?: string | null; "label"?: string | null; "priority"?: number; "summary"?: string | null; "sentiment"?: string | null; "draft_reply"?: string | null; "confidence"?: number; "model"?: string | null; "triaged_at"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("POST", `/v1/triage`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Get a tenant-scoped triage row */
    async getResourceTriage(id: string, init?: RequestInit): Promise<{ "id"?: string; "email_id"?: string | null; "inbound_email_id"?: string | null; "label"?: string | null; "priority"?: number; "summary"?: string | null; "sentiment"?: string | null; "draft_reply"?: string | null; "confidence"?: number; "model"?: string | null; "triaged_at"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("GET", `/v1/triage/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Delete a tenant-scoped triage row */
    async deleteResourceTriage(id: string, init?: RequestInit): Promise<{ "deleted": boolean; "id": string }> {
      return this.request("DELETE", `/v1/triage/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Update a tenant-scoped triage row */
    async updateResourceTriage(id: string, body: { "email_id"?: string | null; "inbound_email_id"?: string | null; "label"?: string | null; "priority"?: number; "summary"?: string | null; "sentiment"?: string | null; "draft_reply"?: string | null; "confidence"?: number; "model"?: string | null; "triaged_at"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "email_id"?: string | null; "inbound_email_id"?: string | null; "label"?: string | null; "priority"?: number; "summary"?: string | null; "sentiment"?: string | null; "draft_reply"?: string | null; "confidence"?: number; "model"?: string | null; "triaged_at"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("PATCH", `/v1/triage/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** List tenant-scoped warming */
    async listResourceWarming(query?: { "limit"?: number; "offset"?: number; "status"?: string | null; "domain"?: string | null }, init?: RequestInit): Promise<{ "items": Array<{ "id"?: string; "domain"?: string | null; "provider_id"?: string | null; "target_daily_volume"?: number; "start_date"?: string | null; "status"?: string | null; "created_at"?: string; "updated_at"?: string }> }> {
      return this.request("GET", `/v1/warming`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Create a tenant-scoped warming row */
    async createResourceWarming(body: { "domain"?: string | null; "provider_id"?: string | null; "target_daily_volume"?: number; "start_date"?: string | null; "status"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "domain"?: string | null; "provider_id"?: string | null; "target_daily_volume"?: number; "start_date"?: string | null; "status"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("POST", `/v1/warming`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Get a tenant-scoped warming row */
    async getResourceWarming(id: string, init?: RequestInit): Promise<{ "id"?: string; "domain"?: string | null; "provider_id"?: string | null; "target_daily_volume"?: number; "start_date"?: string | null; "status"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("GET", `/v1/warming/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Delete a tenant-scoped warming row */
    async deleteResourceWarming(id: string, init?: RequestInit): Promise<{ "deleted": boolean; "id": string }> {
      return this.request("DELETE", `/v1/warming/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Update a tenant-scoped warming row */
    async updateResourceWarming(id: string, body: { "domain"?: string | null; "provider_id"?: string | null; "target_daily_volume"?: number; "start_date"?: string | null; "status"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "domain"?: string | null; "provider_id"?: string | null; "target_daily_volume"?: number; "start_date"?: string | null; "status"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("PATCH", `/v1/warming/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** List tenant-scoped webhook-receipts */
    async listResourceWebhookReceipts(query?: { "limit"?: number; "offset"?: number; "provider"?: string | null; "event_id"?: string | null }, init?: RequestInit): Promise<{ "items": Array<{ "id"?: string; "provider"?: string | null; "event_id"?: string | null; "resource_id"?: string | null; "completed_at"?: string | null; "created_at"?: string; "updated_at"?: string }> }> {
      return this.request("GET", `/v1/webhook-receipts`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Create a tenant-scoped webhook-receipts row */
    async createResourceWebhookReceipts(body: { "provider"?: string | null; "event_id"?: string | null; "resource_id"?: string | null; "completed_at"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "provider"?: string | null; "event_id"?: string | null; "resource_id"?: string | null; "completed_at"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("POST", `/v1/webhook-receipts`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Get a tenant-scoped webhook-receipts row */
    async getResourceWebhookReceipts(id: string, init?: RequestInit): Promise<{ "id"?: string; "provider"?: string | null; "event_id"?: string | null; "resource_id"?: string | null; "completed_at"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("GET", `/v1/webhook-receipts/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Delete a tenant-scoped webhook-receipts row */
    async deleteResourceWebhookReceipts(id: string, init?: RequestInit): Promise<{ "deleted": boolean; "id": string }> {
      return this.request("DELETE", `/v1/webhook-receipts/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Update a tenant-scoped webhook-receipts row */
    async updateResourceWebhookReceipts(id: string, body: { "provider"?: string | null; "event_id"?: string | null; "resource_id"?: string | null; "completed_at"?: string | null }, init?: RequestInit): Promise<{ "id"?: string; "provider"?: string | null; "event_id"?: string | null; "resource_id"?: string | null; "completed_at"?: string | null; "created_at"?: string; "updated_at"?: string }> {
      return this.request("PATCH", `/v1/webhook-receipts/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Service version and mode */
    async getVersion(init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("GET", `/version`, {
        body: undefined,
        query: undefined,
        init,
      });
    }
}
