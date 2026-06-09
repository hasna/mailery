/**
 * Shared utilities for MCP tool modules.
 */

import { getDatabase, resolvePartialIdOrThrow } from "../db/database.js";
import {
  ProviderNotFoundError,
  DomainNotFoundError,
  AddressNotFoundError,
  EmailNotFoundError,
} from "../types/index.js";

export function formatError(error: unknown): string {
  if (error instanceof ProviderNotFoundError) return `Provider not found: ${error.providerId}`;
  if (error instanceof DomainNotFoundError) return `Domain not found: ${error.domainId}`;
  if (error instanceof AddressNotFoundError) return `Address not found: ${error.addressId}`;
  if (error instanceof EmailNotFoundError) return `Email not found: ${error.emailId}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function resolveId(table: string, partialId: string): string {
  const db = getDatabase();
  return resolvePartialIdOrThrow(db, table, partialId);
}

export { ProviderNotFoundError, DomainNotFoundError, AddressNotFoundError, EmailNotFoundError };
