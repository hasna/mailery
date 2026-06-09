import { getDatabase, runInTransaction } from "../db/database.js";
import { getProvider, listActiveProviderSummaries } from "../db/providers.js";
import { upsertEventWithResult } from "../db/events.js";
import { incrementBounceCounts, incrementComplaintCounts } from "../db/contacts.js";
import { getAdapter } from "../providers/index.js";
import { getLocalStats } from "./stats.js";
import { getConfigValue } from "./config.js";
import type { Database } from "../db/database.js";
import type { ProviderAdapter, RemoteEvent } from "../providers/interface.js";
import type { EmailStatus } from "../types/index.js";

interface EmailLink {
  id: string;
  status: EmailStatus;
}

interface EmailStatusUpdate {
  id: string;
  status: EmailStatus;
}

const EMAIL_LINK_CHUNK_SIZE = 500;
const EMAIL_STATUS_UPDATE_CHUNK_SIZE = 500;
const EVENT_ID_CHUNK_SIZE = 500;

function resolveEmailLinks(providerId: string, remoteEvents: RemoteEvent[], db: Database): Map<string, EmailLink> {
  const messageIds = [...new Set(remoteEvents
    .map((event) => event.provider_message_id)
    .filter((id): id is string => !!id))];
  const links = new Map<string, EmailLink>();

  for (let i = 0; i < messageIds.length; i += EMAIL_LINK_CHUNK_SIZE) {
    const chunk = messageIds.slice(i, i + EMAIL_LINK_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db.query(
      `SELECT provider_message_id, id, status
         FROM emails
        WHERE provider_id = ?
          AND provider_message_id IN (${placeholders})`,
    ).all(providerId, ...chunk) as Array<{ provider_message_id: string | null; id: string; status: EmailStatus }>;
    for (const row of rows) {
      if (row.provider_message_id) links.set(row.provider_message_id, { id: row.id, status: row.status });
    }
  }

  return links;
}

function resolveExistingProviderEventIds(providerId: string, remoteEvents: RemoteEvent[], db: Database): Set<string> {
  const eventIds = [...new Set(remoteEvents
    .map((event) => event.provider_event_id)
    .filter((id): id is string => !!id))];
  const existing = new Set<string>();

  for (let i = 0; i < eventIds.length; i += EVENT_ID_CHUNK_SIZE) {
    const chunk = eventIds.slice(i, i + EVENT_ID_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db.query(
      `SELECT provider_event_id
         FROM events
        WHERE provider_id = ?
          AND provider_event_id IN (${placeholders})`,
    ).all(providerId, ...chunk) as Array<{ provider_event_id: string | null }>;
    for (const row of rows) {
      if (row.provider_event_id) existing.add(row.provider_event_id);
    }
  }

  return existing;
}

function applyEmailStatusUpdates(updates: EmailStatusUpdate[], db: Database): void {
  if (updates.length === 0) return;

  const byStatus = new Map<EmailStatus, string[]>();
  for (const update of updates) {
    const ids = byStatus.get(update.status) ?? [];
    ids.push(update.id);
    byStatus.set(update.status, ids);
  }

  for (const [status, ids] of byStatus) {
    for (let i = 0; i < ids.length; i += EMAIL_STATUS_UPDATE_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + EMAIL_STATUS_UPDATE_CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(", ");
      db.run(
        `UPDATE emails
            SET status = ?,
                updated_at = datetime('now')
          WHERE id IN (${placeholders})`,
        [status, ...chunk],
      );
    }
  }
}

const STATUS_MAP: Partial<Record<RemoteEvent["type"], EmailStatus>> = {
  delivered: "delivered",
  bounced: "bounced",
  complained: "complained",
};

function checkAlerts(providerId: string, providerName: string, d: Database): void {
  const bounceThreshold = Number(getConfigValue("bounce-alert-threshold") ?? 0);
  const complaintThreshold = Number(getConfigValue("complaint-alert-threshold") ?? 0);
  if (!bounceThreshold && !complaintThreshold) return;

  try {
    const stats = getLocalStats(providerId, "30d", d);
    if (bounceThreshold && stats.bounce_rate > bounceThreshold) {
      process.stderr.write(
        `\n⚠️  ALERT [${providerName}]: Bounce rate ${stats.bounce_rate.toFixed(1)}% exceeds threshold ${bounceThreshold}% (last 30d)\n`,
      );
    }
    if (complaintThreshold && stats.complained > complaintThreshold) {
      process.stderr.write(
        `\n⚠️  ALERT [${providerName}]: Complaint rate ${(stats.complained / Math.max(stats.sent, 1) * 100).toFixed(2)}% exceeds threshold ${complaintThreshold}% (last 30d)\n`,
      );
    }
  } catch {
    // Don't fail sync if alert check errors
  }
}

export async function syncProvider(providerId: string, db?: Database, adapterOverride?: ProviderAdapter): Promise<number> {
  const d = db || getDatabase();
  const provider = getProvider(providerId, d);
  if (!provider) throw new Error(`Provider not found: ${providerId}`);

  const adapter = adapterOverride ?? getAdapter(provider);

  // Get last sync time from most recent event
  const lastEvent = d
    .query("SELECT occurred_at FROM events WHERE provider_id = ? ORDER BY occurred_at DESC LIMIT 1")
    .get(providerId) as { occurred_at: string } | null;

  const since = lastEvent?.occurred_at;

  const remoteEvents = await adapter.pullEvents(since);
  const emailLinks = resolveEmailLinks(providerId, remoteEvents, d);
  const existingProviderEventIds = resolveExistingProviderEventIds(providerId, remoteEvents, d);
  let inserted = 0;

  runInTransaction(d, () => {
    const bouncedRecipients: string[] = [];
    const complainedRecipients: string[] = [];
    const statusUpdates: EmailStatusUpdate[] = [];

    for (const remoteEvent of remoteEvents) {
      if (remoteEvent.provider_event_id && existingProviderEventIds.has(remoteEvent.provider_event_id)) continue;

      const emailLink = remoteEvent.provider_message_id ? emailLinks.get(remoteEvent.provider_message_id) : undefined;

      const upserted = upsertEventWithResult(
        {
          email_id: emailLink?.id ?? null,
          provider_id: providerId,
          provider_event_id: remoteEvent.provider_event_id,
          type: remoteEvent.type,
          recipient: remoteEvent.recipient ?? null,
          metadata: remoteEvent.metadata ?? {},
          occurred_at: remoteEvent.occurred_at,
        },
        d,
      );
      if (!upserted.created) continue;
      if (remoteEvent.provider_event_id) existingProviderEventIds.add(remoteEvent.provider_event_id);
      inserted++;

      // Update email status if we have a linked email
      if (emailLink) {
        const newStatus = STATUS_MAP[remoteEvent.type];
        if (newStatus && emailLink.status === "sent") {
          statusUpdates.push({ id: emailLink.id, status: newStatus });
          emailLink.status = newStatus;
        }
      }

      // Track bounce/complaint counts on contacts
      if (remoteEvent.recipient) {
        if (remoteEvent.type === "bounced") {
          bouncedRecipients.push(remoteEvent.recipient);
        } else if (remoteEvent.type === "complained") {
          complainedRecipients.push(remoteEvent.recipient);
        }
      }
    }

    applyEmailStatusUpdates(statusUpdates, d);
    incrementBounceCounts(bouncedRecipients, d);
    incrementComplaintCounts(complainedRecipients, d);
  });

  // Check bounce/complaint thresholds after sync
  if (inserted > 0) {
    checkAlerts(providerId, provider.name, d);
  }

  return inserted;
}

export async function syncAll(db?: Database): Promise<Record<string, number>> {
  const d = db || getDatabase();
  const providers = listActiveProviderSummaries(undefined, d);
  const results: Record<string, number> = {};

  for (const provider of providers) {
    try {
      results[provider.id] = await syncProvider(provider.id, d);
    } catch (err) {
      console.error(`Failed to sync provider ${provider.id}: ${err instanceof Error ? err.message : err}`);
      results[provider.id] = 0;
    }
  }

  return results;
}
