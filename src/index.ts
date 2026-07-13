// Public API — types
export type {
  Provider,
  ProviderSummary,
  ProviderType,
  CreateProviderInput,
  Domain,
  DnsStatus,
  DnsRecord,
  EmailAddress,
  CreateAddressInput,
  Attachment,
  SendEmailOptions,
  Email,
  EmailStatus,
  EmailEvent,
  EventSummary,
  EventType,
  Stats,
  EmailFilter,
  EventFilter,
} from "./types/index.js";

export {
  ProviderNotFoundError,
  DomainNotFoundError,
  AddressNotFoundError,
  EmailNotFoundError,
  ProviderConfigError,
} from "./types/index.js";

// DB functions
export {
  createProvider,
  getProvider,
  listProviders,
  listProviderSummaries,
  updateProvider,
  deleteProvider,
  getActiveProvider,
} from "./db/providers.js";

export {
  createDomain,
  getDomain,
  getDomainByName,
  listDomains,
  updateDomain,
  deleteDomain,
  updateDnsStatus,
} from "./db/domains.js";

export {
  createAddress,
  getAddress,
  getAddressByEmail,
  listAddresses,
  updateAddress,
  deleteAddress,
  markVerified,
} from "./db/addresses.js";

export {
  createEmail,
  getEmail,
  listEmails,
  searchEmails,
  updateEmailStatus,
  deleteEmail,
} from "./db/emails.js";

export {
  createEvent,
  getEvent,
  listEvents,
  listEventSummaries,
  getEventsByEmail,
  upsertEvent,
} from "./db/events.js";

export { storeEmailContent, getEmailContent } from "./db/email-content.js";

export {
  upsertContact, getContact, listContacts, suppressContact,
  unsuppressContact, incrementSendCount, incrementBounceCount,
  incrementSendCounts, incrementBounceCounts, incrementComplaintCount,
  incrementComplaintCounts, isContactSuppressed,
  getSuppressedEmailSet,
} from "./db/contacts.js";

export {
  createTemplate, getTemplate, getTemplateByName, listTemplates, listTemplateSummaries,
  deleteTemplate, renderTemplate,
} from "./db/templates.js";
export type { Template, TemplateSummary } from "./db/templates.js";

export {
  createGroup, getGroup, getGroupByName, listGroups, deleteGroup,
  addMember, removeMember, listMembers, listMemberSummaries, getMember,
  getMemberCount, getMemberCounts,
} from "./db/groups.js";
export type { GroupMember, GroupMemberSummary } from "./db/groups.js";

export {
  createOwner, getOwner, getOwnerByName, listOwners,
  getOwnerByExternalId, getOwnerByContactEmail,
  assignAddressOwner, transferAddressOwner, unassignAddressOwner,
  getAddressOwnership, listAddressOwnershipEvents, getAddressOwnershipEvent,
  listAddressesByOwner,
} from "./db/owners.js";
export type {
  Owner, OwnerType, CreateOwnerInput, AddressOwnership,
  AddressOwnershipAction, AddressOwnershipEvent,
} from "./db/owners.js";

export {
  createSendKey, getSendKey, verifySendKey, listSendKeys, listSendKeySummaries,
  listSendKeySummariesByOwners,
  revokeSendKey, canOwnerSendFrom, assertSendAuthorized,
} from "./db/send-keys.js";
export type { SendKey, SendKeySummary } from "./db/send-keys.js";

export {
  createForwardingRule, getForwardingRule, listForwardingRules,
  setForwardingRuleEnabled, removeForwardingRule, listPendingForwarding,
  recordForwardingDelivery,
} from "./db/forwarding.js";
export type {
  ForwardingRule, ForwardingDelivery, ForwardingMode,
  ForwardingDeliveryStatus, PendingForwarding,
} from "./db/forwarding.js";

export {
  createScheduledEmail, listScheduledEmails, listScheduledEmailSummaries, getScheduledEmail,
  cancelScheduledEmail, getDueEmails, markSent, markFailed,
} from "./db/scheduled.js";
export type { ScheduledEmail, ScheduledEmailSummary } from "./db/scheduled.js";

export {
  storeSandboxEmail, listSandboxEmails, listSandboxEmailSummaries, getSandboxEmail,
  clearSandboxEmails, getSandboxCount,
} from "./db/sandbox.js";

// Runtime utilities (self-hosted-only; local SQLite database.ts is removed)
export { uuid, now } from "./db/runtime.js";
export { resolveResourceId, resolveResourceIdOrThrow, listResourceIdMatches } from "./db/self-hosted-store.js";

// Lib functions
export { getLocalStats, formatStatsTable } from "./lib/stats.js";
export { generateSpfRecord, generateDmarcRecord, formatDnsTable } from "./lib/dns.js";
export { getAnalytics, formatAnalytics } from "./lib/analytics.js";
export { parseCsv } from "./lib/csv.js";
export { extractEmailLinks, formatEmailLinks } from "./lib/email-links.js";
export type { ExtractEmailLinksInput, ExtractedEmailLink, EmailLinkSource } from "./lib/email-links.js";
export {
  formatEmailDigest,
  generateEmailDigest,
  loadEmailDigest,
  resolveEmailDigestWindow,
} from "./lib/email-digest.js";
export type {
  EmailDigestWindow,
  GenerateEmailDigestOptions,
  LoadEmailDigestOptions,
} from "./lib/email-digest.js";
export {
  emailDigestPeriodLabel,
  getEmailDigest,
  getLatestEmailDigest,
  listEmailDigests,
  normalizeEmailDigestPeriod,
  saveEmailDigest,
} from "./db/email-digests.js";
export type {
  EmailDigest,
  EmailDigestPeriod,
  EmailDigestProvider,
  EmailDigestStatus,
  ListEmailDigestsOptions,
  SaveEmailDigestInput,
} from "./db/email-digests.js";
export { formatDnsCheck } from "./lib/dns-check-format.js";
export type { DnsCheckResult } from "./lib/dns-check-format.js";
export { formatDiagnostics } from "./lib/diagnostics-format.js";
export type { DoctorCheck } from "./lib/diagnostics-format.js";
export {
  assessDomainLifecycleReadiness,
  buildDomainLifecycleSummaries,
  buildDomainLifecycleSummary,
  createDomainReadinessService,
  defaultDomainSourceOfTruth,
  disableDomainOutboundReadiness,
  enableDomainInboundReadiness,
  enableDomainOutboundReadiness,
  getDomainLifecycleSummary,
  listDomainLifecycleSummaries,
  resolveDomainLifecycleRecord,
  updateDomainLifecycleReadiness,
} from "./lib/domain-readiness-service.js";
export type {
  BuildDomainLifecycleSummaryOptions,
  DomainDnsLifecycleStatus,
  DomainLifecycleReadiness,
  DomainLifecycleSummary,
  DomainReadinessMutationInput,
  DomainReadinessMutationResult,
  DomainReadinessProviderSummary,
  DomainReadinessService,
  ListDomainLifecycleSummaryOptions,
  ResolveDomainLifecycleOptions,
} from "./lib/domain-readiness-service.js";
export {
  assessDomainReadiness,
  formatDomainReadinessState,
} from "./lib/domain-readiness.js";
export type {
  DomainReadiness,
  DomainReadinessSignals,
  DomainReadinessState,
} from "./lib/domain-readiness.js";
export {
  domainInboundReadinessSignals,
  listDomainLiveS3Sources,
} from "./lib/domain-inbound-evidence.js";
export { exportEmailsCsv, exportEmailsJson, exportEventsCsv, exportEventsJson } from "./lib/export.js";
export {
  CANONICAL_OPEN_EMAILS_S3_BUCKET,
  CANONICAL_OPEN_EMAILS_S3_REGION,
  CANONICAL_OPEN_EMAILS_SECRET_PATHS,
  CANONICAL_OPEN_EMAILS_RDS_CLUSTER,
  CANONICAL_OPEN_EMAILS_RDS_DATABASE,
  CANONICAL_OPEN_EMAILS_RDS_SECRET_PATH,
  getCanonicalOpenEmailsRdsConfig,
  getInboundAttachmentStorageConfig,
  loadConfig,
  saveConfig,
  getConfigValue,
  setConfigValue,
  getDefaultProviderId,
} from "./lib/config.js";
export { log, setLogLevel } from "./lib/logger.js";
export { colorStatus, colorDnsStatus, truncate, formatDate } from "./lib/format.js";
export { formatVerifyResult } from "./lib/email-verify-format.js";
export type { VerifyResult } from "./lib/email-verify-format.js";
export {
  formatProviderHealth,
} from "./lib/provider-health-format.js";
export type { ProviderHealth } from "./lib/provider-health-format.js";

// New modules (v0.4.x)
export {
  verifyResendSignature, verifySnsStructure,
  parseResendWebhook, parseSesWebhook,
} from "./lib/webhook-events.js";
export type { WebhookEvent } from "./lib/webhook-events.js";
export { createWebhookServer } from "./lib/webhook.js";
export { injectOpenPixel, injectClickTracking, prepareTrackedHtml } from "./lib/tracking.js";
export { getFailoverProviderIds } from "./lib/config.js";
export {
  resolveAddressRef, enrichAddress, listEnrichedAddresses,
  getAddressOwnershipDetail, setAddressOwnerByRef,
  transferAddressOwnerByRef, unassignAddressOwnerByRef,
  getAddressOwnershipHistoryByRef, suggestAddressLocalParts,
} from "./lib/address-ownership.js";
export type { EnrichedAddress, AddressOwnershipDetail } from "./lib/address-ownership.js";
export {
  createSequence, getSequence, listSequences, updateSequence, deleteSequence,
  addStep, listSteps, removeStep,
  enroll, unenroll, listEnrollments, getDueEnrollments, advanceEnrollment,
} from "./db/sequences.js";
export {
  storeInboundEmail, getInboundEmail, getInboundEmailSummary, listInboundEmails, listInboundEmailSummaries,
  listInboundEmailsForOwner, listInboundEmailSummariesForOwner,
  getInboundAttachmentPaths,
  setInboundReadSummary, setInboundArchivedSummary, setInboundStarredSummary,
  addInboundLabelSummary, removeInboundLabelSummary,
  getReceivedInboundCount, getLatestReceivedInboundAt,
  deleteInboundEmail, clearInboundEmails,
  listReplies, listReplySummaries, getReplyCount,
} from "./db/inbound.js";
export type { InboundEmail, InboundEmailSummary } from "./db/inbound.js";

export {
  createWarmingSchedule, getWarmingSchedule, listWarmingSchedules, updateWarmingStatus, deleteWarmingSchedule,
} from "./db/warming.js";
export { generateWarmingPlan, getTodayLimit, getTodaySentCount, formatWarmingStatus } from "./lib/warming.js";
export type { WarmingSchedule, WarmingDay } from "./lib/warming.js";

export type { ForwardingRunOptions, ForwardingRunResult, ForwardingRunItem } from "./lib/forwarding.js";

// Provider factory
export { getAdapter } from "./providers/index.js";
export type { ProviderAdapter, RemoteDomain, RemoteAddress, RemoteEvent } from "./providers/interface.js";

type SyncModule = typeof import("./lib/sync.js");
type SendModule = typeof import("./lib/send.js");
type BatchModule = typeof import("./lib/batch.js");
type DoctorModule = typeof import("./lib/doctor.js");
type HealthModule = typeof import("./lib/health.js");
type DnsCheckModule = typeof import("./lib/dns-check.js");
type EmailVerifyModule = typeof import("./lib/email-verify.js");
type ForwardingModule = typeof import("./lib/forwarding.js");

export async function syncProvider(...args: Parameters<SyncModule["syncProvider"]>): Promise<Awaited<ReturnType<SyncModule["syncProvider"]>>> {
  const { syncProvider } = await import("./lib/sync.js");
  return syncProvider(...args);
}

export async function syncAll(...args: Parameters<SyncModule["syncAll"]>): Promise<Awaited<ReturnType<SyncModule["syncAll"]>>> {
  const { syncAll } = await import("./lib/sync.js");
  return syncAll(...args);
}

export async function sendWithFailover(...args: Parameters<SendModule["sendWithFailover"]>): Promise<Awaited<ReturnType<SendModule["sendWithFailover"]>>> {
  const { sendWithFailover } = await import("./lib/send.js");
  return sendWithFailover(...args);
}

export async function batchSend(...args: Parameters<BatchModule["batchSend"]>): Promise<Awaited<ReturnType<BatchModule["batchSend"]>>> {
  const { batchSend } = await import("./lib/batch.js");
  return batchSend(...args);
}

export async function runDiagnostics(...args: Parameters<DoctorModule["runDiagnostics"]>): Promise<Awaited<ReturnType<DoctorModule["runDiagnostics"]>>> {
  const { runDiagnostics } = await import("./lib/doctor.js");
  return runDiagnostics(...args);
}

export async function processForwardingRules(...args: Parameters<ForwardingModule["processForwardingRules"]>): Promise<Awaited<ReturnType<ForwardingModule["processForwardingRules"]>>> {
  const { processForwardingRules } = await import("./lib/forwarding.js");
  return processForwardingRules(...args);
}

export async function checkProviderHealth(...args: Parameters<HealthModule["checkProviderHealth"]>): Promise<Awaited<ReturnType<HealthModule["checkProviderHealth"]>>> {
  const { checkProviderHealth } = await import("./lib/health.js");
  return checkProviderHealth(...args);
}

export async function checkAllProviders(...args: Parameters<HealthModule["checkAllProviders"]>): Promise<Awaited<ReturnType<HealthModule["checkAllProviders"]>>> {
  const { checkAllProviders } = await import("./lib/health.js");
  return checkAllProviders(...args);
}

export async function checkDnsRecords(...args: Parameters<DnsCheckModule["checkDnsRecords"]>): Promise<Awaited<ReturnType<DnsCheckModule["checkDnsRecords"]>>> {
  const { checkDnsRecords } = await import("./lib/dns-check.js");
  return checkDnsRecords(...args);
}

export async function verifyEmailAddress(...args: Parameters<EmailVerifyModule["verifyEmailAddress"]>): Promise<Awaited<ReturnType<EmailVerifyModule["verifyEmailAddress"]>>> {
  const { verifyEmailAddress } = await import("./lib/email-verify.js");
  return verifyEmailAddress(...args);
}
