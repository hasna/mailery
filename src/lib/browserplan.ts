import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { Database } from "../db/database.js";
import { getDatabase } from "../db/database.js";
import { findAddressesByEmail, getAddress, listAddresses } from "../db/addresses.js";
import {
  assignAddressOwner,
  createOwner,
  getOwner,
  getOwnerByExternalId,
  getOwnerByName,
  listAddressesByOwner,
  type Owner,
  type OwnerType,
} from "../db/owners.js";
import type { EmailAddress } from "../types/index.js";
import { enrichAddress, enrichAddresses, type EnrichedAddress } from "./address-ownership.js";

export interface BrowserPlanIdentityEmail {
  address: string;
  primary?: boolean;
}

export interface BrowserPlanIdentityRecord {
  id: string;
  kind?: string;
  fullName?: string;
  displayName?: string;
  identifier?: string;
  emails?: Array<string | BrowserPlanIdentityEmail>;
  primaryEmail?: string;
}

export interface BrowserPlanIdentityStore {
  identities?: BrowserPlanIdentityRecord[];
}

export interface BrowserPlanIdentitySummary {
  source: "mailery-owner" | "open-identities" | "fallback";
  id: string | null;
  external_id: string | null;
  identifier: string | null;
  kind: string | null;
  name: string;
  display_name: string;
  first_name: string;
  email: string | null;
  tentative: boolean;
}

export interface BrowserPlanAddressProfile {
  machine_id: string;
  address_id: string;
  email: string;
  provider_id: string;
  provider_name: string | null;
  display_name: string | null;
  status: string;
  provisioning_status: string;
  receive_strategy: string | null;
  ready: boolean;
  reserved: boolean;
  available_for_reservation: boolean;
  owner: Owner | null;
  administrator: Owner | null;
  identity: BrowserPlanIdentitySummary;
}

export interface BrowserPlanAddressListResult {
  machine_id: string;
  machine_id_source: "env" | "hostname" | "requested" | "unknown";
  target: number;
  total_addresses: number;
  ready_addresses: number;
  identity_linked_ready_addresses: number;
  available_ready_addresses: number;
  gap_to_target_ready: number;
  gap_to_target_identity_linked_ready: number;
  addresses: BrowserPlanAddressProfile[];
}

export interface BrowserPlanListOptions {
  machineId?: string;
  allowRequestedMachineId?: boolean;
  target?: number;
  limit?: number;
  offset?: number;
  includeUnready?: boolean;
  identityStorePath?: string;
  db?: Database;
}

export interface BrowserPlanValidateOptions {
  machineId?: string;
  allowRequestedMachineId?: boolean;
  email: string;
  identityStorePath?: string;
  db?: Database;
}

export interface BrowserPlanValidationResult {
  machine_id: string;
  email: string;
  found: boolean;
  valid: boolean;
  reason: string | null;
  address: BrowserPlanAddressProfile | null;
}

export interface BrowserPlanReserveIdentityInput {
  id?: string;
  name?: string;
  displayName?: string;
  email?: string;
  kind?: string;
  identifier?: string;
}

export interface BrowserPlanReserveOptions {
  machineId?: string;
  allowRequestedMachineId?: boolean;
  addressId?: string;
  email?: string;
  identity: BrowserPlanReserveIdentityInput;
  administratorOwnerRef?: string;
  identityStorePath?: string;
  dryRun?: boolean;
  db?: Database;
}

export interface BrowserPlanReservationResult {
  machine_id: string;
  address: BrowserPlanAddressProfile;
  owner: Owner;
  existing_reservation: boolean;
  dry_run: boolean;
}

export class BrowserPlanCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserPlanCapacityError";
  }
}

export class BrowserPlanInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserPlanInputError";
  }
}

export class BrowserPlanMachineMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserPlanMachineMismatchError";
  }
}

export class BrowserPlanNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserPlanNotFoundError";
  }
}

export class BrowserPlanConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserPlanConflictError";
  }
}

interface IdentityIndexEntry {
  id: string;
  kind: string | null;
  fullName: string | null;
  displayName: string | null;
  identifier: string | null;
  email: string;
}

type AddressWithProvisioning = EnrichedAddress & {
  provisioning_status?: string | null;
  receive_strategy?: string | null;
};

type AddressRowWithProvisioning = EmailAddress & {
  verified: boolean | number;
  provisioning_status?: string | null;
  receive_strategy?: string | null;
};

interface ResolvedMachineId {
  id: string;
  source: BrowserPlanAddressListResult["machine_id_source"];
}

function positiveInt(value: number | undefined, fallback: number, max = 1000): number {
  if (!Number.isFinite(value ?? Number.NaN)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(value!)));
}

function nonNegativeInt(value: number | undefined): number {
  if (!Number.isFinite(value ?? Number.NaN)) return 0;
  return Math.max(0, Math.trunc(value!));
}

export function defaultBrowserPlanIdentityStorePath(): string {
  return process.env["OPEN_IDENTITIES_STORE"] || join(homedir(), ".hasna", "identities", "identities.json");
}

export function detectedBrowserPlanMachineId(): ResolvedMachineId {
  const envValue = (process.env["MAILERY_MACHINE_ID"] || process.env["MACHINE_ID"] || "").trim();
  if (envValue) return { id: envValue, source: "env" };

  const host = hostname().split(".")[0]?.trim().toLowerCase() ?? "";
  if (/^(machine\d{3}|spark\d+|apple\d+)$/.test(host)) return { id: host, source: "hostname" };

  return { id: "local", source: "unknown" };
}

export function resolveBrowserPlanMachineId(
  requested: string | undefined,
  opts: { allowRequestedWhenUnknown?: boolean } = {},
): ResolvedMachineId {
  const normalizedRequested = requested?.trim();
  const detected = detectedBrowserPlanMachineId();
  if (!normalizedRequested) return detected;
  if (opts.allowRequestedWhenUnknown !== false) return { id: normalizedRequested, source: "requested" };
  if (detected.source === "unknown") {
    throw new BrowserPlanMachineMismatchError(
      `Cannot assert BrowserPlan machine '${normalizedRequested}' because this Mailery process has no MAILERY_MACHINE_ID/MACHINE_ID and hostname is not a fleet machine id`,
    );
  }
  if (detected.id !== normalizedRequested) {
    throw new BrowserPlanMachineMismatchError(
      `BrowserPlan machine assertion '${normalizedRequested}' does not match local Mailery machine '${detected.id}'`,
    );
  }
  return detected;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function localPart(email: string): string {
  return normalizeEmail(email).split("@")[0] ?? "";
}

function titleWord(word: string): string {
  if (!word) return "";
  return `${word[0]!.toUpperCase()}${word.slice(1).toLowerCase()}`;
}

export function deriveBrowserPlanIdentityFromEmail(email: string): Pick<BrowserPlanIdentitySummary, "name" | "display_name" | "first_name"> {
  const base = localPart(email)
    .split("+")[0]!
    .replace(/[._-]+/g, " ")
    .replace(/\d+/g, " ")
    .trim();
  const words = base.split(/\s+/).filter(Boolean).map(titleWord);
  const firstName = words[0] || titleWord(localPart(email)) || "Email";
  const displayName = words.length ? words.join(" ") : firstName;
  return { name: displayName, display_name: displayName, first_name: firstName };
}

function identityEmailValues(identity: BrowserPlanIdentityRecord): string[] {
  const emails = identity.emails ?? [];
  const values = emails.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    return entry.address ? [entry.address] : [];
  });
  if (identity.primaryEmail) values.push(identity.primaryEmail);
  return values.map(normalizeEmail).filter(Boolean);
}

export function loadBrowserPlanIdentityIndex(identityStorePath = defaultBrowserPlanIdentityStorePath()): Map<string, IdentityIndexEntry> {
  if (!existsSync(identityStorePath)) return new Map();
  const parsed = JSON.parse(readFileSync(identityStorePath, "utf8")) as BrowserPlanIdentityStore | BrowserPlanIdentityRecord[];
  const identities = Array.isArray(parsed) ? parsed : parsed.identities ?? [];
  const index = new Map<string, IdentityIndexEntry>();
  for (const identity of identities) {
    for (const email of identityEmailValues(identity)) {
      if (!index.has(email)) {
        index.set(email, {
          id: identity.id,
          kind: identity.kind ?? null,
          fullName: identity.fullName ?? null,
          displayName: identity.displayName ?? identity.fullName ?? null,
          identifier: identity.identifier ?? null,
          email,
        });
      }
    }
  }
  return index;
}

function identityFromOwner(address: EnrichedAddress): BrowserPlanIdentitySummary | null {
  if (!address.owner) return null;
  const owner = address.owner;
  const derived = deriveBrowserPlanIdentityFromEmail(owner.contact_email || address.email);
  return {
    source: "mailery-owner",
    id: owner.id,
    external_id: owner.external_id,
    identifier: null,
    kind: owner.type,
    name: owner.name,
    display_name: owner.name,
    first_name: owner.name.split(/\s+/)[0] ?? derived.first_name,
    email: owner.contact_email,
    tentative: false,
  };
}

function identityFromOpenIdentities(address: EnrichedAddress, index: Map<string, IdentityIndexEntry>): BrowserPlanIdentitySummary | null {
  const match = index.get(normalizeEmail(address.email));
  if (!match) return null;
  const name = match.displayName ?? match.fullName ?? deriveBrowserPlanIdentityFromEmail(address.email).display_name;
  return {
    source: "open-identities",
    id: match.id,
    external_id: match.id,
    identifier: match.identifier,
    kind: match.kind,
    name,
    display_name: name,
    first_name: name.split(/\s+/)[0] ?? deriveBrowserPlanIdentityFromEmail(address.email).first_name,
    email: match.email,
    tentative: false,
  };
}

function fallbackIdentity(address: EnrichedAddress): BrowserPlanIdentitySummary {
  const derived = deriveBrowserPlanIdentityFromEmail(address.email);
  return {
    source: "fallback",
    id: null,
    external_id: null,
    identifier: null,
    kind: null,
    name: derived.name,
    display_name: derived.display_name,
    first_name: derived.first_name,
    email: address.email,
    tentative: true,
  };
}

function addressReady(address: AddressWithProvisioning): boolean {
  return (address.status ?? "active") === "active" && address.provisioning_status === "ready";
}

function rowToAddress(row: AddressRowWithProvisioning): EmailAddress {
  return {
    ...row,
    verified: !!row.verified,
    status: row.status ?? "active",
    daily_quota: row.daily_quota ?? null,
  } as EmailAddress;
}

function listReadyAddressRows(db: Database, opts: { limit?: number; offset?: number } = {}): EmailAddress[] {
  const page = opts.limit !== undefined ? " LIMIT ? OFFSET ?" : "";
  const params = opts.limit !== undefined ? [opts.limit, opts.offset ?? 0] : [];
  const rows = db
    .query(`SELECT *
      FROM addresses
      WHERE COALESCE(status, 'active') = 'active'
        AND provisioning_status = 'ready'
      ORDER BY created_at DESC${page}`)
    .all(...params) as AddressRowWithProvisioning[];
  return rows.map(rowToAddress);
}

function countReadyAddresses(db: Database): number {
  const row = db
    .query(`SELECT COUNT(*) AS count
      FROM addresses
      WHERE COALESCE(status, 'active') = 'active'
        AND provisioning_status = 'ready'`)
    .get() as { count: unknown } | null;
  return Number(row?.count ?? 0) || 0;
}

function countAllAddresses(db: Database): number {
  const row = db.query("SELECT COUNT(*) AS count FROM addresses").get() as { count: unknown } | null;
  return Number(row?.count ?? 0) || 0;
}

function profileAddress(
  machineId: string,
  address: EnrichedAddress,
  identityIndex: Map<string, IdentityIndexEntry>,
): BrowserPlanAddressProfile {
  const provisioned = address as AddressWithProvisioning;
  const ready = addressReady(provisioned);
  const ownerIdentity = identityFromOwner(address);
  const openIdentity = ownerIdentity ? null : identityFromOpenIdentities(address, identityIndex);
  const identity = ownerIdentity ?? openIdentity ?? fallbackIdentity(address);
  return {
    machine_id: machineId,
    address_id: address.id,
    email: address.email,
    provider_id: address.provider_id,
    provider_name: address.provider_name,
    display_name: address.display_name,
    status: address.status ?? "active",
    provisioning_status: provisioned.provisioning_status ?? "none",
    receive_strategy: provisioned.receive_strategy ?? null,
    ready,
    reserved: !!address.owner_id || identity.source === "open-identities",
    available_for_reservation: ready && !address.owner_id && identity.source === "fallback",
    owner: address.owner,
    administrator: address.administrator,
    identity,
  };
}

export function listBrowserPlanAddresses(opts: BrowserPlanListOptions = {}): BrowserPlanAddressListResult {
  const db = opts.db ?? getDatabase();
  const machine = resolveBrowserPlanMachineId(opts.machineId, { allowRequestedWhenUnknown: opts.allowRequestedMachineId !== false });
  const target = positiveInt(opts.target, 8, 1000);
  const limit = positiveInt(opts.limit, 100, 1000);
  const offset = nonNegativeInt(opts.offset);
  const identityIndex = loadBrowserPlanIdentityIndex(opts.identityStorePath);
  const raw = opts.includeUnready
    ? enrichAddresses(listAddresses(undefined, db, { limit, offset }), db)
    : enrichAddresses(listReadyAddressRows(db, { limit, offset }), db);
  const addresses = raw
    .map((address) => profileAddress(machine.id, address, identityIndex))
    .filter((address) => opts.includeUnready || address.ready);
  const readyAddresses = enrichAddresses(listReadyAddressRows(db), db)
    .map((address) => profileAddress(machine.id, address, identityIndex));
  const identityLinkedReady = readyAddresses.filter((address) => address.identity.source !== "fallback");
  const availableReady = readyAddresses.filter((address) => address.available_for_reservation);
  return {
    machine_id: machine.id,
    machine_id_source: machine.source,
    target,
    total_addresses: countAllAddresses(db),
    ready_addresses: countReadyAddresses(db),
    identity_linked_ready_addresses: identityLinkedReady.length,
    available_ready_addresses: availableReady.length,
    gap_to_target_ready: Math.max(0, target - readyAddresses.length),
    gap_to_target_identity_linked_ready: Math.max(0, target - identityLinkedReady.length),
    addresses,
  };
}

export function validateBrowserPlanAddress(opts: BrowserPlanValidateOptions): BrowserPlanValidationResult {
  const db = opts.db ?? getDatabase();
  const machine = resolveBrowserPlanMachineId(opts.machineId, { allowRequestedWhenUnknown: opts.allowRequestedMachineId !== false });
  const matches = findAddressesByEmail(opts.email, db);
  if (matches.length === 0) {
    return { machine_id: machine.id, email: opts.email, found: false, valid: false, reason: "address_not_found", address: null };
  }
  if (matches.length > 1) {
    return { machine_id: machine.id, email: opts.email, found: true, valid: false, reason: "address_ambiguous_across_providers", address: null };
  }
  const identityIndex = loadBrowserPlanIdentityIndex(opts.identityStorePath);
  const address = profileAddress(machine.id, enrichAddress(matches[0]!, db), identityIndex);
  const reason = address.ready ? null : "address_not_receive_ready";
  return { machine_id: machine.id, email: address.email, found: true, valid: address.ready, reason, address };
}

function ownerTypeForIdentity(identity: BrowserPlanReserveIdentityInput): OwnerType {
  const kind = identity.kind?.trim();
  if (!kind) return "agent";
  if (kind === "agent" || kind === "human") return kind;
  throw new BrowserPlanInputError("BrowserPlan identity kind must be 'agent' or 'human'");
}

function identityExternalId(identity: BrowserPlanReserveIdentityInput): string {
  const value = (identity.id || identity.identifier || "").trim();
  if (!value) throw new BrowserPlanInputError("BrowserPlan reservation requires identity.id or identity.identifier from open-identities");
  return value;
}

function identityName(identity: BrowserPlanReserveIdentityInput): string {
  const name = identity.displayName || identity.name;
  if (name?.trim()) return name.trim();
  if (identity.email?.trim()) return deriveBrowserPlanIdentityFromEmail(identity.email).display_name;
  if (identity.id?.trim()) return identity.id.trim();
  return "BrowserPlan Identity";
}

function resolveOwnerRef(ref: string, db: Database): Owner | null {
  return getOwnerByExternalId(ref, db) ?? getOwnerByName(ref, db) ?? getOwner(ref, db);
}

function findExistingOwner(identity: BrowserPlanReserveIdentityInput, db: Database): Owner | null {
  const externalId = identityExternalId(identity);
  return getOwnerByExternalId(externalId, db);
}

function plannedOwner(identity: BrowserPlanReserveIdentityInput): Owner {
  const ts = new Date(0).toISOString();
  return {
    id: identityExternalId(identity),
    type: ownerTypeForIdentity(identity),
    name: identityName(identity),
    contact_email: identity.email?.trim() || null,
    external_id: identityExternalId(identity),
    created_at: ts,
    updated_at: ts,
  };
}

function findOrCreateOwner(identity: BrowserPlanReserveIdentityInput, db: Database): Owner {
  const existing = findExistingOwner(identity, db);
  if (existing) return existing;
  const externalId = identityExternalId(identity);
  const contactEmail = identity.email?.trim() || undefined;
  return createOwner({
    type: ownerTypeForIdentity(identity),
    name: identityName(identity),
    contact_email: contactEmail,
    external_id: externalId,
  }, db);
}

function existingReservation(owner: Owner, db: Database): EnrichedAddress | null {
  const owned = listAddressesByOwner(owner.id, "owner", db);
  return owned[0] ? enrichAddress(owned[0], db) : null;
}

function identityRefs(identity: BrowserPlanReserveIdentityInput): Set<string> {
  return new Set([identity.id, identity.identifier].map((value) => value?.trim()).filter((value): value is string => !!value));
}

function openIdentityMatches(identity: BrowserPlanReserveIdentityInput, openIdentity: BrowserPlanIdentitySummary): boolean {
  const refs = identityRefs(identity);
  return (!!openIdentity.id && refs.has(openIdentity.id)) || (!!openIdentity.identifier && refs.has(openIdentity.identifier));
}

function assertOpenIdentityCompatible(
  address: EnrichedAddress,
  identity: BrowserPlanReserveIdentityInput,
  identityIndex: Map<string, IdentityIndexEntry>,
): void {
  const openIdentity = identityFromOpenIdentities(address, identityIndex);
  if (openIdentity && !openIdentityMatches(identity, openIdentity)) {
    throw new BrowserPlanConflictError(`Address ${address.email} already belongs to open-identities identity ${openIdentity.id ?? openIdentity.identifier}`);
  }
}

function chooseReservationAddress(
  opts: {
    email?: string;
    addressId?: string;
    allowRequestedMachineId?: boolean;
    identity: BrowserPlanReserveIdentityInput;
    identityIndex: Map<string, IdentityIndexEntry>;
  },
  db: Database,
): EnrichedAddress {
  if (opts.addressId?.trim()) {
    const address = getAddress(opts.addressId.trim(), db);
    if (!address) throw new BrowserPlanNotFoundError(`Address not found: ${opts.addressId}`);
    const enriched = enrichAddress(address, db);
    if (!addressReady(enriched as AddressWithProvisioning)) {
      throw new BrowserPlanCapacityError(`Address is not receive-ready: ${enriched.email}`);
    }
    assertOpenIdentityCompatible(enriched, opts.identity, opts.identityIndex);
    return enriched;
  }

  const email = opts.email;
  if (email?.trim()) {
    const validation = validateBrowserPlanAddress({
      email,
      allowRequestedMachineId: opts.allowRequestedMachineId,
      db,
    });
    if (validation.reason === "address_ambiguous_across_providers") {
      const candidates = findAddressesByEmail(email, db)
        .map((address) => `${address.id}:${address.provider_id}`)
        .join(", ");
      throw new BrowserPlanConflictError(`Address is ambiguous across providers: ${email} (${candidates})`);
    }
    if (!validation.address) throw new BrowserPlanNotFoundError(`Address not found: ${email}`);
    if (!validation.address.ready) throw new BrowserPlanCapacityError(`Address is not receive-ready: ${email}`);
    const address = enrichAddress(findAddressesByEmail(email, db)[0]!, db);
    assertOpenIdentityCompatible(address, opts.identity, opts.identityIndex);
    return address;
  }
  const rows = db
    .query(`SELECT *
      FROM addresses
      WHERE COALESCE(status, 'active') = 'active'
        AND provisioning_status = 'ready'
        AND owner_id IS NULL
      ORDER BY created_at DESC`)
    .all() as AddressRowWithProvisioning[];

  let fallback: EnrichedAddress | null = null;
  for (const row of rows) {
    const address = enrichAddress(rowToAddress(row), db);
    const openIdentity = identityFromOpenIdentities(address, opts.identityIndex);
    if (!openIdentity) {
      fallback ??= address;
      continue;
    }
    if (openIdentityMatches(opts.identity, openIdentity)) return address;
  }
  if (fallback) return fallback;
  throw new BrowserPlanCapacityError("No unowned receive-ready Mailery address is available to reserve");
}

export function reserveBrowserPlanAddress(opts: BrowserPlanReserveOptions): BrowserPlanReservationResult {
  const db = opts.db ?? getDatabase();
  const machine = resolveBrowserPlanMachineId(opts.machineId, { allowRequestedWhenUnknown: opts.allowRequestedMachineId !== false });
  identityExternalId(opts.identity);
  const ownerType = ownerTypeForIdentity(opts.identity);
  const existingOwner = findExistingOwner(opts.identity, db);
  const identityIndex = loadBrowserPlanIdentityIndex(opts.identityStorePath);
  if (existingOwner) {
    const existing = existingReservation(existingOwner, db);
    if (existing) {
      const requestedDifferentAddress = (opts.email && normalizeEmail(existing.email) !== normalizeEmail(opts.email))
        || (opts.addressId && existing.id !== opts.addressId);
      if (requestedDifferentAddress) {
        throw new BrowserPlanConflictError(`Identity ${existingOwner.external_id ?? existingOwner.name} already has reserved address ${existing.email}`);
      }
      return {
        machine_id: machine.id,
        address: profileAddress(machine.id, existing, identityIndex),
        owner: existingOwner,
        existing_reservation: true,
        dry_run: !!opts.dryRun,
      };
    }
  }

  const address = chooseReservationAddress({
    email: opts.email,
    addressId: opts.addressId,
    allowRequestedMachineId: opts.allowRequestedMachineId,
    identity: opts.identity,
    identityIndex,
  }, db);
  if (address.owner_id && address.owner_id !== existingOwner?.id) {
    throw new BrowserPlanConflictError(`Address ${address.email} is already reserved by another owner`);
  }

  let administratorId: string | undefined;
  if (ownerType === "human") {
    if (!opts.administratorOwnerRef) {
      throw new BrowserPlanInputError("Human BrowserPlan identities require an agent administrator owner reference");
    }
    const administrator = resolveOwnerRef(opts.administratorOwnerRef, db);
    if (!administrator) throw new BrowserPlanNotFoundError(`Administrator owner not found: ${opts.administratorOwnerRef}`);
    administratorId = administrator.id;
  }

  const owner = opts.dryRun ? existingOwner ?? plannedOwner(opts.identity) : existingOwner ?? findOrCreateOwner(opts.identity, db);
  if (!opts.dryRun) assignAddressOwner(address.id, owner.id, administratorId, db);
  const reserved = opts.dryRun ? address : enrichAddress(getAddress(address.id, db)!, db);
  return {
    machine_id: machine.id,
    address: profileAddress(machine.id, reserved, identityIndex),
    owner,
    existing_reservation: false,
    dry_run: !!opts.dryRun,
  };
}

export function assertBrowserPlanAddressCapacity(result: BrowserPlanAddressListResult): void {
  if (result.ready_addresses < result.target) {
    throw new BrowserPlanCapacityError(
      `${result.machine_id} has ${result.ready_addresses} receive-ready address(es), target is ${result.target}`,
    );
  }
}
