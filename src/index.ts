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

// Database utilities
export { getDatabase, closeDatabase, resetDatabase, runInTransaction, uuid, now, resolvePartialId } from "./db/database.js";

// Lib functions
export { getLocalStats, formatStatsTable } from "./lib/stats.js";
export { generateSpfRecord, generateDmarcRecord, formatDnsTable } from "./lib/dns.js";
export { getAnalytics, formatAnalytics } from "./lib/analytics.js";
export { parseCsv } from "./lib/csv.js";
export { extractEmailLinks, formatEmailLinks } from "./lib/email-links.js";
export type { ExtractEmailLinksInput, ExtractedEmailLink, EmailLinkSource } from "./lib/email-links.js";
export {
  buildReadOnlyMaileryTools,
  formatMaileryAgentResult,
  resolveMaileryAgentDefaults,
  runMaileryAgent,
  MAILERY_AGENT_SYSTEM_PROMPT,
} from "./lib/mailery-agent.js";
export type { MaileryAgentOptions, MaileryAgentProvider, MaileryAgentResult } from "./lib/mailery-agent.js";
export {
  buildManagedEmailAgentTools,
  formatEmailAgentRun,
  formatEmailAgentSetting,
  formatEmailOrganizationResult,
  runAlwaysOnEmailAgents,
  runEmailAgentBatch,
  runEmailOrganization,
  runManagedEmailAgent,
} from "./lib/email-agents.js";
export type {
  AlwaysOnEmailAgentsResult,
  EmailOrganizationResult,
  RunEmailAgentBatchOptions,
  RunEmailAgentBatchResult,
  RunManagedEmailAgentOptions,
} from "./lib/email-agents.js";
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
  assertBrowserPlanAddressCapacity,
  defaultBrowserPlanIdentityStorePath,
  deriveBrowserPlanIdentityFromEmail,
  detectedBrowserPlanMachineId,
  listBrowserPlanAddresses,
  loadBrowserPlanIdentityIndex,
  reserveBrowserPlanAddress,
  resolveBrowserPlanMachineId,
  validateBrowserPlanAddress,
  BrowserPlanCapacityError,
  BrowserPlanConflictError,
  BrowserPlanInputError,
  BrowserPlanMachineMismatchError,
  BrowserPlanNotFoundError,
} from "./lib/browserplan.js";
export type {
  BrowserPlanAddressListResult,
  BrowserPlanAddressProfile,
  BrowserPlanIdentityRecord,
  BrowserPlanIdentityStore,
  BrowserPlanIdentitySummary,
  BrowserPlanListOptions,
  BrowserPlanReservationResult,
  BrowserPlanReserveIdentityInput,
  BrowserPlanReserveOptions,
  BrowserPlanValidationResult,
  BrowserPlanValidateOptions,
} from "./lib/browserplan.js";
export {
  EMAIL_AGENT_DEFINITIONS,
  ensureEmailAgentSettings,
  getEmailAgentDefinition,
  getEmailAgentRun,
  getEmailAgentSetting,
  listEmailAgentRuns,
  listEmailAgentSettings,
  listEnabledAlwaysOnEmailAgents,
  listPendingInboundEmailsForAgent,
  normalizeEmailAgentKey,
  saveEmailAgentRun,
  updateEmailAgentSetting,
} from "./db/email-agents.js";
export type {
  EmailAgentDefinition,
  EmailAgentKey,
  EmailAgentProvider,
  EmailAgentRun,
  EmailAgentRunFilter,
  EmailAgentRunStatus,
  EmailAgentSetting,
  PendingAgentEmail,
  SaveEmailAgentRunInput,
  SaveEmailAgentSettingInput,
} from "./db/email-agents.js";
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
export { exportEmailsCsv, exportEmailsJson, exportEventsCsv, exportEventsJson } from "./lib/export.js";
export {
  CANONICAL_OPEN_EMAILS_S3_BUCKET,
  CANONICAL_OPEN_EMAILS_S3_REGION,
  CANONICAL_OPEN_EMAILS_SECRET_PATHS,
  CANONICAL_OPEN_EMAILS_RDS_CLUSTER,
  CANONICAL_OPEN_EMAILS_RDS_DATABASE,
  CANONICAL_OPEN_EMAILS_RDS_SECRET_PATH,
  getCanonicalOpenEmailsRdsConfig,
  getDefaultGmailArchiveS3Bucket,
  getDefaultGmailArchiveS3Prefix,
  getDefaultGmailArchiveS3Region,
  loadConfig,
  saveConfig,
  getConfigValue,
  setConfigValue,
  getDefaultProviderId,
} from "./lib/config.js";
export { log, setLogLevel } from "./lib/logger.js";
export { colorStatus, colorDnsStatus, truncate, formatDate } from "./lib/format.js";
export { buildGmailArchiveKeys } from "./lib/gmail-archive-keys.js";
export type { GmailArchiveKeyInput, GmailArchiveKeys } from "./lib/gmail-archive-keys.js";
export { formatVerifyResult } from "./lib/email-verify-format.js";
export type { VerifyResult } from "./lib/email-verify-format.js";
export { CerebrasError } from "./lib/cerebras-error.js";
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

// Triage (AI)
export {
  saveTriage, getTriage, getTriageById, listTriaged, listTriagedSummaries,
  getUntriaged, deleteTriage, deleteTriageByEmail,
  getTriageStats, clearTriage,
} from "./db/triage.js";
export type { TriageResult, TriageSummary, TriageLabel, TriageSentiment, SaveTriageInput, TriageFilter, TriageStats } from "./db/triage.js";
export type { ClassifyResult, EmailContext, TriageOptions } from "./lib/triage.js";
export type { CerebrasMessage, CerebrasCompletionOptions, CerebrasResponse } from "./lib/cerebras.js";
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
type GmailArchiveModule = typeof import("./lib/gmail-archive.js");
type EmailVerifyModule = typeof import("./lib/email-verify.js");
type TriageModule = typeof import("./lib/triage.js");
type CerebrasModule = typeof import("./lib/cerebras.js");
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

export async function uploadGmailArchive(...args: Parameters<GmailArchiveModule["uploadGmailArchive"]>): Promise<Awaited<ReturnType<GmailArchiveModule["uploadGmailArchive"]>>> {
  const { uploadGmailArchive } = await import("./lib/gmail-archive.js");
  return uploadGmailArchive(...args);
}

export async function uploadGmailArchiveAttachment(...args: Parameters<GmailArchiveModule["uploadGmailArchiveAttachment"]>): Promise<Awaited<ReturnType<GmailArchiveModule["uploadGmailArchiveAttachment"]>>> {
  const { uploadGmailArchiveAttachment } = await import("./lib/gmail-archive.js");
  return uploadGmailArchiveAttachment(...args);
}

export async function uploadGmailArchiveManifest(...args: Parameters<GmailArchiveModule["uploadGmailArchiveManifest"]>): Promise<Awaited<ReturnType<GmailArchiveModule["uploadGmailArchiveManifest"]>>> {
  const { uploadGmailArchiveManifest } = await import("./lib/gmail-archive.js");
  return uploadGmailArchiveManifest(...args);
}

export async function verifyGmailArchive(...args: Parameters<GmailArchiveModule["verifyGmailArchive"]>): Promise<Awaited<ReturnType<GmailArchiveModule["verifyGmailArchive"]>>> {
  const { verifyGmailArchive } = await import("./lib/gmail-archive.js");
  return verifyGmailArchive(...args);
}

export async function migrateS3Prefix(...args: Parameters<GmailArchiveModule["migrateS3Prefix"]>): Promise<Awaited<ReturnType<GmailArchiveModule["migrateS3Prefix"]>>> {
  const { migrateS3Prefix } = await import("./lib/gmail-archive.js");
  return migrateS3Prefix(...args);
}

export async function verifyEmailAddress(...args: Parameters<EmailVerifyModule["verifyEmailAddress"]>): Promise<Awaited<ReturnType<EmailVerifyModule["verifyEmailAddress"]>>> {
  const { verifyEmailAddress } = await import("./lib/email-verify.js");
  return verifyEmailAddress(...args);
}

export async function classifyEmail(...args: Parameters<TriageModule["classifyEmail"]>): Promise<Awaited<ReturnType<TriageModule["classifyEmail"]>>> {
  const { classifyEmail } = await import("./lib/triage.js");
  return classifyEmail(...args);
}

export async function scorePriority(...args: Parameters<TriageModule["scorePriority"]>): Promise<Awaited<ReturnType<TriageModule["scorePriority"]>>> {
  const { scorePriority } = await import("./lib/triage.js");
  return scorePriority(...args);
}

export async function summarizeEmail(...args: Parameters<TriageModule["summarizeEmail"]>): Promise<Awaited<ReturnType<TriageModule["summarizeEmail"]>>> {
  const { summarizeEmail } = await import("./lib/triage.js");
  return summarizeEmail(...args);
}

export async function analyzeSentiment(...args: Parameters<TriageModule["analyzeSentiment"]>): Promise<Awaited<ReturnType<TriageModule["analyzeSentiment"]>>> {
  const { analyzeSentiment } = await import("./lib/triage.js");
  return analyzeSentiment(...args);
}

export async function generateDraftReply(...args: Parameters<TriageModule["generateDraftReply"]>): Promise<Awaited<ReturnType<TriageModule["generateDraftReply"]>>> {
  const { generateDraftReply } = await import("./lib/triage.js");
  return generateDraftReply(...args);
}

export async function triageEmail(...args: Parameters<TriageModule["triageEmail"]>): Promise<Awaited<ReturnType<TriageModule["triageEmail"]>>> {
  const { triageEmail } = await import("./lib/triage.js");
  return triageEmail(...args);
}

export async function triageBatch(...args: Parameters<TriageModule["triageBatch"]>): Promise<Awaited<ReturnType<TriageModule["triageBatch"]>>> {
  const { triageBatch } = await import("./lib/triage.js");
  return triageBatch(...args);
}

export async function generateDraftForEmail(...args: Parameters<TriageModule["generateDraftForEmail"]>): Promise<Awaited<ReturnType<TriageModule["generateDraftForEmail"]>>> {
  const { generateDraftForEmail } = await import("./lib/triage.js");
  return generateDraftForEmail(...args);
}

export async function chatCompletion(...args: Parameters<CerebrasModule["chatCompletion"]>): Promise<Awaited<ReturnType<CerebrasModule["chatCompletion"]>>> {
  const { chatCompletion } = await import("./lib/cerebras.js");
  return chatCompletion(...args);
}

export async function prompt(...args: Parameters<CerebrasModule["prompt"]>): Promise<Awaited<ReturnType<CerebrasModule["prompt"]>>> {
  const { prompt } = await import("./lib/cerebras.js");
  return prompt(...args);
}

export async function promptJson<T = unknown>(
  systemPrompt: string,
  userPrompt: string,
  opts?: { model?: string; temperature?: number; max_tokens?: number },
): Promise<T> {
  const { promptJson } = await import("./lib/cerebras.js");
  return promptJson<T>(systemPrompt, userPrompt, opts);
}
