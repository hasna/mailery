import type { Database } from "./database.js";
import { getDatabase, now } from "./database.js";

export interface GmailSyncState {
  provider_id: string;
  last_synced_at: string | null;
  last_message_id: string | null;
  history_id: string | null;
  next_page_token: string | null;
  updated_at: string;
}

export function getGmailSyncState(providerId: string, db?: Database): GmailSyncState | null {
  const d = db ?? getDatabase();
  return d.query("SELECT * FROM gmail_sync_state WHERE provider_id = ?").get(providerId) as GmailSyncState | null;
}

export function listGmailSyncStatesByProviderIds(providerIds: Iterable<string>, db?: Database): Map<string, GmailSyncState> {
  const ids = [...new Set([...providerIds].map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const d = db ?? getDatabase();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = d
    .query(`SELECT * FROM gmail_sync_state WHERE provider_id IN (${placeholders})`)
    .all(...ids) as GmailSyncState[];
  return new Map(rows.map((row) => [row.provider_id, row]));
}

export function setGmailSyncState(
  providerId: string,
  state: Partial<Omit<GmailSyncState, "provider_id" | "updated_at">>,
  db?: Database,
): GmailSyncState {
  const d = db ?? getDatabase();
  const updated = now();

  d.run(
    `INSERT INTO gmail_sync_state (provider_id, last_synced_at, last_message_id, history_id, next_page_token, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider_id) DO UPDATE SET
       last_synced_at   = COALESCE(excluded.last_synced_at, last_synced_at),
       last_message_id  = COALESCE(excluded.last_message_id, last_message_id),
       history_id       = COALESCE(excluded.history_id, history_id),
       next_page_token  = excluded.next_page_token,
       updated_at       = excluded.updated_at`,
    [
      providerId,
      state.last_synced_at ?? null,
      state.last_message_id ?? null,
      state.history_id ?? null,
      state.next_page_token ?? null,
      updated,
    ],
  );

  return d.query("SELECT * FROM gmail_sync_state WHERE provider_id = ?").get(providerId) as GmailSyncState;
}

export function updateLastSynced(providerId: string, lastMessageId?: string, db?: Database): GmailSyncState {
  return setGmailSyncState(
    providerId,
    {
      last_synced_at: now(),
      last_message_id: lastMessageId ?? null,
      next_page_token: null,
    },
    db,
  );
}

export function clearGmailSyncState(providerId: string, db?: Database): boolean {
  const d = db ?? getDatabase();
  const result = d.run("DELETE FROM gmail_sync_state WHERE provider_id = ?", [providerId]);
  return result.changes > 0;
}
