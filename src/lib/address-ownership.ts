import type { Database } from "../db/database.js";
import { getDatabase, resolvePartialId } from "../db/database.js";
import { findAddressesByEmail, getAddress, listAddresses, type ListAddressOptions } from "../db/addresses.js";
import { listProviderNamesByIds } from "../db/providers.js";
import {
  assignAddressOwner,
  getOwner,
  getOwnerByName,
  listOwnersByIds,
  listAddressOwnershipEvents,
  transferAddressOwner,
  unassignAddressOwner,
  type AddressOwnership,
  type AddressOwnershipEvent,
  type Owner,
} from "../db/owners.js";
import type { EmailAddress } from "../types/index.js";

export interface EnrichedAddress extends EmailAddress {
  provider_name: string | null;
  owner: Owner | null;
  administrator: Owner | null;
}

export interface AddressOwnershipDetail {
  address: EnrichedAddress;
  ownership: AddressOwnership | null;
  history: AddressOwnershipEvent[];
}

function resolveOwnerRef(ref: string, db: Database): Owner | null {
  const partialId = resolvePartialId(db, "owners", ref);
  return getOwnerByName(ref, db)
    ?? getOwner(ref, db)
    ?? (partialId ? getOwner(partialId, db) : null);
}

export function resolveAddressRef(ref: string, db: Database = getDatabase()): EmailAddress {
  const trimmed = ref.trim();
  const exact = getAddress(trimmed, db);
  if (exact) return exact;

  const id = resolvePartialId(db, "addresses", trimmed);
  if (id) {
    const address = getAddress(id, db);
    if (address) return address;
  }

  const lowered = trimmed.toLowerCase();
  const matches = findAddressesByEmail(lowered, db);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    const ids = matches.map((address) => `${address.id.slice(0, 8)}:${address.provider_id.slice(0, 8)}`).join(", ");
    throw new Error(`Address '${trimmed}' exists on multiple providers; use an address ID (${ids})`);
  }
  throw new Error(`Address not found: ${trimmed}`);
}

export function enrichAddress(address: EmailAddress, db: Database = getDatabase()): EnrichedAddress {
  const providers = listProviderNamesByIds([address.provider_id], db);
  const owner = address.owner_id ? getOwner(address.owner_id, db) : null;
  const administrator = address.administrator_id ? getOwner(address.administrator_id, db) : null;
  return {
    ...address,
    provider_name: providers.get(address.provider_id) ?? null,
    owner,
    administrator,
  };
}

export function enrichAddresses(addresses: EmailAddress[], db: Database = getDatabase()): EnrichedAddress[] {
  const providers = listProviderNamesByIds(addresses.map((address) => address.provider_id), db);
  const ownerIds = addresses.flatMap((address) => [address.owner_id, address.administrator_id])
    .filter((id): id is string => !!id);
  const owners = listOwnersByIds(ownerIds, db);
  return addresses.map((address) => ({
    ...address,
    provider_name: providers.get(address.provider_id) ?? null,
    owner: address.owner_id ? owners.get(address.owner_id) ?? null : null,
    administrator: address.administrator_id ? owners.get(address.administrator_id) ?? null : null,
  }));
}

export function listEnrichedAddresses(providerId?: string, db: Database = getDatabase(), opts?: ListAddressOptions): EnrichedAddress[] {
  return enrichAddresses(listAddresses(providerId, db, opts), db);
}

export function getAddressOwnershipDetail(ref: string, db: Database = getDatabase()): AddressOwnershipDetail {
  const address = resolveAddressRef(ref, db);
  const enriched = enrichAddress(address, db);
  return {
    address: enriched,
    ownership: enriched.owner
      ? {
          owner_id: enriched.owner.id,
          owner_type: enriched.owner.type,
          administrator_id: enriched.administrator?.id ?? enriched.owner.id,
        }
      : null,
    history: listAddressOwnershipEvents(address.id, 10, db),
  };
}

export function setAddressOwnerByRef(
  addressRef: string,
  ownerRef: string,
  administratorRef?: string,
  db: Database = getDatabase(),
): AddressOwnershipDetail {
  const address = resolveAddressRef(addressRef, db);
  const owner = resolveOwnerRef(ownerRef, db);
  if (!owner) throw new Error(`Owner not found: ${ownerRef}`);
  const administrator = administratorRef ? resolveOwnerRef(administratorRef, db) : null;
  assignAddressOwner(address.id, owner.id, administrator?.id, db);
  return getAddressOwnershipDetail(address.id, db);
}

export function transferAddressOwnerByRef(
  addressRef: string,
  ownerRef: string,
  administratorRef: string | undefined,
  options: { actor?: string; reason: string },
  db: Database = getDatabase(),
): AddressOwnershipDetail {
  const address = resolveAddressRef(addressRef, db);
  const owner = resolveOwnerRef(ownerRef, db);
  if (!owner) throw new Error(`Owner not found: ${ownerRef}`);
  const administrator = administratorRef ? resolveOwnerRef(administratorRef, db) : null;
  transferAddressOwner(address.id, owner.id, administrator?.id, options, db);
  return getAddressOwnershipDetail(address.id, db);
}

export function unassignAddressOwnerByRef(
  addressRef: string,
  options: { actor?: string; reason: string },
  db: Database = getDatabase(),
): AddressOwnershipDetail {
  const address = resolveAddressRef(addressRef, db);
  unassignAddressOwner(address.id, options, db);
  return getAddressOwnershipDetail(address.id, db);
}

export function getAddressOwnershipHistoryByRef(
  addressRef: string,
  limit = 20,
  db: Database = getDatabase(),
): { address: EnrichedAddress; history: AddressOwnershipEvent[] } {
  const address = resolveAddressRef(addressRef, db);
  return {
    address: enrichAddress(address, db),
    history: listAddressOwnershipEvents(address.id, limit, db),
  };
}

export function suggestAddressLocalParts(domain: string, existingEmails: string[]): string[] {
  const normalized = domain.trim().toLowerCase();
  const used = new Set(
    existingEmails
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.endsWith(`@${normalized}`))
      .map((email) => email.split("@")[0]),
  );
  const candidates = [
    "hello", "hi", "contact", "support", "team", "admin", "inbox",
    "mail", "me", "bot", "agent", "verify", "accounts", "notify",
  ];
  return candidates.filter((local) => !used.has(local)).slice(0, 8).map((local) => `${local}@${normalized}`);
}
