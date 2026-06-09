/**
 * Provisioning DB layer — lifecycle fields for automated domain/address
 * provisioning plus an append-only audit trail (provisioning_events).
 *
 * The provisioning columns live on the existing `domains` and `addresses`
 * tables (added in migration 19). This module provides typed read/write access
 * to those columns and the daemon's "due work" queue, without disturbing the
 * existing domains.ts / addresses.ts APIs.
 */

import type { Database } from "./database.js";
import { getDatabase, now, uuid } from "./database.js";
import type { DomainState, AddressState } from "../lib/provision/state-machine.js";
import { parseJsonArray, parseJsonObject } from "./json.js";
import { countValue } from "./scalars.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Terminal states never re-enter the daemon queue. */
export const TERMINAL_STATES = ["ready", "failed", "none"] as const;

/**
 * Persisted provisioning status. The canonical state names come from the
 * state machine (src/lib/provision/state-machine.ts); `none` is the
 * not-yet-started default for rows that were never enrolled in provisioning.
 */
export type DomainProvisioningStatus = DomainState | "none";

export type AddressProvisioningStatus = AddressState | "none";

export type ReceiveStrategy = "ses-s3" | "cf-routing" | "resend-webhook";

export interface DomainProvisioning {
  provisioning_status: DomainProvisioningStatus;
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

export interface DomainProvisioningInput {
  provisioning_status?: DomainProvisioningStatus;
  purchase_provider?: string | null;
  dns_provider?: string;
  send_provider?: string | null;
  cf_zone_id?: string | null;
  registrar?: string | null;
  nameservers?: string[];
  mail_from_domain?: string | null;
  last_error?: string | null;
  next_check_at?: string | null;
}

export interface AddressProvisioning {
  domain_id: string | null;
  receive_strategy: ReceiveStrategy | null;
  forward_to: string | null;
  routing_rule_id: string | null;
  provisioning_status: AddressProvisioningStatus;
  last_validated_at: string | null;
  last_error: string | null;
  next_check_at: string | null;
}

export interface AddressProvisioningInput {
  domain_id?: string | null;
  receive_strategy?: ReceiveStrategy | null;
  forward_to?: string | null;
  routing_rule_id?: string | null;
  provisioning_status?: AddressProvisioningStatus;
  last_validated_at?: string | null;
  last_error?: string | null;
  next_check_at?: string | null;
}

export interface ProvisioningEvent {
  id: string;
  entity_type: "domain" | "address";
  entity_id: string;
  from_state: string | null;
  to_state: string;
  detail: Record<string, unknown>;
  created_at: string;
}

// ─── Domain provisioning ────────────────────────────────────────────────────

interface DomainProvRow {
  id?: string;
  provisioning_status: string;
  purchase_provider: string | null;
  dns_provider: string;
  send_provider: string | null;
  cf_zone_id: string | null;
  registrar: string | null;
  nameservers_json: string;
  mail_from_domain: string | null;
  last_error: string | null;
  next_check_at: string | null;
}

function rowToDomainProvisioning(row: DomainProvRow): DomainProvisioning {
  return {
    provisioning_status: row.provisioning_status as DomainProvisioningStatus,
    purchase_provider: row.purchase_provider,
    dns_provider: row.dns_provider,
    send_provider: row.send_provider,
    cf_zone_id: row.cf_zone_id,
    registrar: row.registrar,
    nameservers: safeJsonArray(row.nameservers_json),
    mail_from_domain: row.mail_from_domain,
    last_error: row.last_error,
    next_check_at: row.next_check_at,
  };
}

export function getDomainProvisioning(id: string, db?: Database): DomainProvisioning | null {
  const d = db || getDatabase();
  const row = d
    .query(
      `SELECT provisioning_status, purchase_provider, dns_provider, send_provider,
              cf_zone_id, registrar, nameservers_json, mail_from_domain, last_error, next_check_at
       FROM domains WHERE id = ?`,
    )
    .get(id) as DomainProvRow | null;
  if (!row) return null;
  return rowToDomainProvisioning(row);
}

export function listDomainProvisioningById(db?: Database): Map<string, DomainProvisioning> {
  const d = db || getDatabase();
  const rows = d
    .query(
      `SELECT id, provisioning_status, purchase_provider, dns_provider, send_provider,
              cf_zone_id, registrar, nameservers_json, mail_from_domain, last_error, next_check_at
       FROM domains`,
    )
    .all() as Array<DomainProvRow & { id: string }>;
  return new Map(rows.map((row) => [row.id, rowToDomainProvisioning(row)]));
}

export function listDomainProvisioningByIds(domainIds: Iterable<string>, db?: Database): Map<string, DomainProvisioning> {
  const ids = [...new Set([...domainIds].map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const d = db || getDatabase();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = d
    .query(
      `SELECT id, provisioning_status, purchase_provider, dns_provider, send_provider,
              cf_zone_id, registrar, nameservers_json, mail_from_domain, last_error, next_check_at
       FROM domains
       WHERE id IN (${placeholders})`,
    )
    .all(...ids) as Array<DomainProvRow & { id: string }>;
  return new Map(rows.map((row) => [row.id, rowToDomainProvisioning(row)]));
}

export function setDomainProvisioning(
  id: string,
  input: DomainProvisioningInput,
  db?: Database,
): DomainProvisioning | null {
  const d = db || getDatabase();
  const sets: string[] = ["updated_at = ?"];
  const params: (string | null)[] = [now()];

  const col = (name: string, value: string | null) => { sets.push(`${name} = ?`); params.push(value); };

  if (input.provisioning_status !== undefined) col("provisioning_status", input.provisioning_status);
  if (input.purchase_provider !== undefined) col("purchase_provider", input.purchase_provider);
  if (input.dns_provider !== undefined) col("dns_provider", input.dns_provider);
  if (input.send_provider !== undefined) col("send_provider", input.send_provider);
  if (input.cf_zone_id !== undefined) col("cf_zone_id", input.cf_zone_id);
  if (input.registrar !== undefined) col("registrar", input.registrar);
  if (input.nameservers !== undefined) col("nameservers_json", JSON.stringify(input.nameservers));
  if (input.mail_from_domain !== undefined) col("mail_from_domain", input.mail_from_domain);
  if (input.last_error !== undefined) col("last_error", input.last_error);
  if (input.next_check_at !== undefined) col("next_check_at", input.next_check_at);

  params.push(id);
  d.run(`UPDATE domains SET ${sets.join(", ")} WHERE id = ?`, params);
  return getDomainProvisioning(id, d);
}

// ─── Address provisioning ───────────────────────────────────────────────────

interface AddressProvRow {
  id?: string;
  domain_id: string | null;
  receive_strategy: string | null;
  forward_to: string | null;
  routing_rule_id: string | null;
  provisioning_status: string;
  last_validated_at: string | null;
  last_error: string | null;
  next_check_at: string | null;
}

function rowToAddressProvisioning(row: AddressProvRow): AddressProvisioning {
  return {
    domain_id: row.domain_id,
    receive_strategy: row.receive_strategy as ReceiveStrategy | null,
    forward_to: row.forward_to,
    routing_rule_id: row.routing_rule_id,
    provisioning_status: row.provisioning_status as AddressProvisioningStatus,
    last_validated_at: row.last_validated_at,
    last_error: row.last_error,
    next_check_at: row.next_check_at,
  };
}

export function getAddressProvisioning(id: string, db?: Database): AddressProvisioning | null {
  const d = db || getDatabase();
  const row = d
    .query(
      `SELECT domain_id, receive_strategy, forward_to, routing_rule_id,
              provisioning_status, last_validated_at, last_error, next_check_at
       FROM addresses WHERE id = ?`,
    )
    .get(id) as AddressProvRow | null;
  if (!row) return null;
  return rowToAddressProvisioning(row);
}

export function listAddressProvisioningById(db?: Database): Map<string, AddressProvisioning> {
  const d = db || getDatabase();
  const rows = d
    .query(
      `SELECT id, domain_id, receive_strategy, forward_to, routing_rule_id,
              provisioning_status, last_validated_at, last_error, next_check_at
       FROM addresses`,
    )
    .all() as Array<AddressProvRow & { id: string }>;
  return new Map(rows.map((row) => [row.id, rowToAddressProvisioning(row)]));
}

export function listAddressProvisioningByIds(addressIds: Iterable<string>, db?: Database): Map<string, AddressProvisioning> {
  const ids = [...new Set([...addressIds].map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const d = db || getDatabase();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = d
    .query(
      `SELECT id, domain_id, receive_strategy, forward_to, routing_rule_id,
              provisioning_status, last_validated_at, last_error, next_check_at
       FROM addresses
       WHERE id IN (${placeholders})`,
    )
    .all(...ids) as Array<AddressProvRow & { id: string }>;
  return new Map(rows.map((row) => [row.id, rowToAddressProvisioning(row)]));
}

export interface AddressProvisioningByDomain {
  id: string;
  email: string;
  provisioning: AddressProvisioning;
}

function rowToAddressProvisioningByDomain(row: AddressProvRow & { id: string; email: string }): AddressProvisioningByDomain {
  return { id: row.id, email: row.email, provisioning: rowToAddressProvisioning(row) };
}

export function listAddressProvisioningByDomain(db?: Database): Map<string, AddressProvisioningByDomain[]> {
  const d = db || getDatabase();
  const rows = d
    .query(
      `SELECT id, email, domain_id, receive_strategy, forward_to, routing_rule_id,
              provisioning_status, last_validated_at, last_error, next_check_at
       FROM addresses
       WHERE domain_id IS NOT NULL
       ORDER BY created_at DESC`,
    )
    .all() as Array<AddressProvRow & { id: string; email: string }>;
  const byDomain = new Map<string, AddressProvisioningByDomain[]>();
  for (const row of rows) {
    if (!row.domain_id) continue;
    const items = byDomain.get(row.domain_id) ?? [];
    items.push(rowToAddressProvisioningByDomain(row));
    byDomain.set(row.domain_id, items);
  }
  return byDomain;
}

export function listAddressProvisioningByDomains(domainIds: Iterable<string>, db?: Database): Map<string, AddressProvisioningByDomain[]> {
  const ids = [...new Set([...domainIds].map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const d = db || getDatabase();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = d
    .query(
      `SELECT id, email, domain_id, receive_strategy, forward_to, routing_rule_id,
              provisioning_status, last_validated_at, last_error, next_check_at
       FROM addresses
       WHERE domain_id IN (${placeholders})
       ORDER BY created_at DESC`,
    )
    .all(...ids) as Array<AddressProvRow & { id: string; email: string }>;
  const byDomain = new Map<string, AddressProvisioningByDomain[]>();
  for (const row of rows) {
    if (!row.domain_id) continue;
    const items = byDomain.get(row.domain_id) ?? [];
    items.push(rowToAddressProvisioningByDomain(row));
    byDomain.set(row.domain_id, items);
  }
  return byDomain;
}

export function listAddressProvisioningForDomain(domainId: string, db?: Database): AddressProvisioningByDomain[] {
  const d = db || getDatabase();
  const rows = d
    .query(
      `SELECT id, email, domain_id, receive_strategy, forward_to, routing_rule_id,
              provisioning_status, last_validated_at, last_error, next_check_at
       FROM addresses
       WHERE domain_id = ?
       ORDER BY created_at DESC`,
    )
    .all(domainId) as Array<AddressProvRow & { id: string; email: string }>;
  return rows.map(rowToAddressProvisioningByDomain);
}

export function listReadyAddressCountsByDomain(db?: Database): Map<string, number> {
  const d = db || getDatabase();
  const rows = d
    .query(
      `SELECT domain_id, COUNT(*) AS count
       FROM addresses
       WHERE domain_id IS NOT NULL AND provisioning_status = 'ready'
       GROUP BY domain_id`,
    )
    .all() as Array<{ domain_id: string; count: unknown }>;
  return new Map(rows.map((row) => [row.domain_id, countValue(row.count)]));
}

export function listReadyAddressCountsByDomains(domainIds: Iterable<string>, db?: Database): Map<string, number> {
  const ids = [...new Set([...domainIds].map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const d = db || getDatabase();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = d
    .query(
      `SELECT domain_id, COUNT(*) AS count
       FROM addresses
       WHERE domain_id IN (${placeholders}) AND provisioning_status = 'ready'
       GROUP BY domain_id`,
    )
    .all(...ids) as Array<{ domain_id: string; count: unknown }>;
  return new Map(rows.map((row) => [row.domain_id, countValue(row.count)]));
}

export function countReadyAddressesForDomain(domainId: string, db?: Database): number {
  const d = db || getDatabase();
  const row = d
    .query(
      `SELECT COUNT(*) AS count
       FROM addresses
       WHERE domain_id = ? AND provisioning_status = 'ready'`,
    )
    .get(domainId) as { count: unknown } | null;
  return countValue(row?.count);
}

export function setAddressProvisioning(
  id: string,
  input: AddressProvisioningInput,
  db?: Database,
): AddressProvisioning | null {
  const d = db || getDatabase();
  const sets: string[] = ["updated_at = ?"];
  const params: (string | null)[] = [now()];
  const col = (name: string, value: string | null) => { sets.push(`${name} = ?`); params.push(value); };

  if (input.domain_id !== undefined) col("domain_id", input.domain_id);
  if (input.receive_strategy !== undefined) col("receive_strategy", input.receive_strategy);
  if (input.forward_to !== undefined) col("forward_to", input.forward_to);
  if (input.routing_rule_id !== undefined) col("routing_rule_id", input.routing_rule_id);
  if (input.provisioning_status !== undefined) col("provisioning_status", input.provisioning_status);
  if (input.last_validated_at !== undefined) col("last_validated_at", input.last_validated_at);
  if (input.last_error !== undefined) col("last_error", input.last_error);
  if (input.next_check_at !== undefined) col("next_check_at", input.next_check_at);

  params.push(id);
  d.run(`UPDATE addresses SET ${sets.join(", ")} WHERE id = ?`, params);
  return getAddressProvisioning(id, d);
}

// ─── Audit trail ────────────────────────────────────────────────────────────

export function recordProvisioningEvent(
  entity_type: "domain" | "address",
  entity_id: string,
  from_state: string | null,
  to_state: string,
  detail: Record<string, unknown> = {},
  db?: Database,
): ProvisioningEvent {
  const d = db || getDatabase();
  const id = uuid();
  const created_at = now();
  d.run(
    `INSERT INTO provisioning_events (id, entity_type, entity_id, from_state, to_state, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, entity_type, entity_id, from_state, to_state, JSON.stringify(detail), created_at],
  );
  return { id, entity_type, entity_id, from_state, to_state, detail, created_at };
}

interface ProvEventRow {
  id: string;
  entity_type: string;
  entity_id: string;
  from_state: string | null;
  to_state: string;
  detail_json: string;
  created_at: string;
}

export function listProvisioningEvents(
  entity_type: "domain" | "address",
  entity_id: string,
  db?: Database,
): ProvisioningEvent[] {
  const d = db || getDatabase();
  const rows = d
    .query(
      `SELECT * FROM provisioning_events WHERE entity_type = ? AND entity_id = ? ORDER BY created_at ASC, rowid ASC`,
    )
    .all(entity_type, entity_id) as ProvEventRow[];
  return rows.map((r) => ({
    id: r.id,
    entity_type: r.entity_type as "domain" | "address",
    entity_id: r.entity_id,
    from_state: r.from_state,
    to_state: r.to_state,
    detail: safeJsonObject(r.detail_json),
    created_at: r.created_at,
  }));
}

// ─── Daemon queue ───────────────────────────────────────────────────────────

const TERMINAL_SQL = "('ready','failed','none')";

export function claimDueDomains(asOf?: string, db?: Database): { id: string }[] {
  const d = db || getDatabase();
  const ts = asOf || now();
  return d
    .query(
      `SELECT id FROM domains
       WHERE provisioning_status NOT IN ${TERMINAL_SQL}
         AND next_check_at IS NOT NULL AND next_check_at <= ?
       ORDER BY next_check_at ASC`,
    )
    .all(ts) as { id: string }[];
}

export function claimDueAddresses(asOf?: string, db?: Database): { id: string }[] {
  const d = db || getDatabase();
  const ts = asOf || now();
  return d
    .query(
      `SELECT id FROM addresses
       WHERE provisioning_status NOT IN ${TERMINAL_SQL}
         AND next_check_at IS NOT NULL AND next_check_at <= ?
       ORDER BY next_check_at ASC`,
    )
    .all(ts) as { id: string }[];
}

export interface ProvisioningWorkSummary {
  due_domains: number;
  due_addresses: number;
  failed_domains: number;
  failed_addresses: number;
}

export function getProvisioningWorkSummary(asOf?: string, db?: Database): ProvisioningWorkSummary {
  const d = db || getDatabase();
  const ts = asOf || now();
  const row = d
    .query(
      `SELECT
         (SELECT COUNT(*) FROM domains
          WHERE provisioning_status NOT IN ${TERMINAL_SQL}
            AND next_check_at IS NOT NULL AND next_check_at <= ?) AS due_domains,
         (SELECT COUNT(*) FROM addresses
          WHERE provisioning_status NOT IN ${TERMINAL_SQL}
            AND next_check_at IS NOT NULL AND next_check_at <= ?) AS due_addresses,
         (SELECT COUNT(*) FROM domains WHERE provisioning_status = 'failed') AS failed_domains,
         (SELECT COUNT(*) FROM addresses WHERE provisioning_status = 'failed') AS failed_addresses`,
    )
    .get(ts, ts) as Record<keyof ProvisioningWorkSummary, unknown> | null;
  return {
    due_domains: countValue(row?.due_domains),
    due_addresses: countValue(row?.due_addresses),
    failed_domains: countValue(row?.failed_domains),
    failed_addresses: countValue(row?.failed_addresses),
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

const safeJsonArray = parseJsonArray<string>;
const safeJsonObject = parseJsonObject;
