import { createContext, createMemo, createResource, onCleanup, onMount, useContext, type ParentProps } from "solid-js";
import { createStore } from "solid-js/store";
import {
  ALL_ADDRESSES,
  addressChoiceByAddress,
  COMMON_LABELS,
  MAILBOXES,
  defaultFromAddress,
	  getSettings,
	  groupMailboxMessages,
	  listDomainSummaries,
	  listInboxAddresses,
	  listSources,
  mailboxGroupModeLabel,
  labelNameKey,
  normalizeMailboxGroupMode,
  normalizedLabelName,
  replyDefaults,
  setSetting as persistSetting,
	  type DomainSummary,
	  type InboxAddressChoice,
	  type InboxSource,
	  type LabelSummary,
	  type Mailbox,
	  type MailboxSource,
  type MailboxGroupMode,
  type MailboxCounts,
  type MessageBody,
  type TuiMessageGroup,
  type TuiMessage,
  type TuiSettings,
  type TuiThreadBody,
} from "../../tui/data.js";
import { resolveMailDataSource } from "../../../lib/mail-data-source.js";
import { autoPull } from "../../tui/autopull.js";
import { extractEmailLinks, type ExtractedEmailLink } from "../../../lib/email-links.js";
import { loadEmailDigest } from "../../../lib/email-digest.js";
import type { EmailDigest, EmailDigestPeriod } from "../../../db/email-digests.js";

export type RouteName = "mailbox" | "reader" | "domains";
export type DialogName = "commands" | "address" | "source" | "filter" | "search" | "group" | "digest" | "domains" | "settings" | "labels" | "links" | "attachments" | "raw" | null;
export type ComposeMode = "new" | "reply" | "forward";
export type ComposeField = "from" | "to" | "subject" | "body";

export interface ComposeState {
  mode: ComposeMode;
  from: string;
  to: string;
  subject: string;
  body: string;
  field: ComposeField;
  replyTo?: TuiMessage;
}

export interface EmailsState {
  mailbox: Mailbox;
  route: RouteName;
  messages: TuiMessage[];
	  counts: MailboxCounts;
	  addresses: InboxAddressChoice[];
	  selectedAddressId: string;
	  sources: InboxSource[];
	  selectedSourceId: string;
	  selectedMessageId: string | null;
  page: number;
  hasMore: boolean;
  search: string;
  searchDraft: string;
  sort: "newest" | "oldest";
  groupMode: MailboxGroupMode;
  domains: DomainSummary[];
  domainsPage: number;
  domainsHasMore: boolean;
  labels: LabelSummary[];
  activeLabel: string | null;
  labelSearch: string;
  commandSearch: string;
  linkIndex: number;
  digestPeriod: EmailDigestPeriod;
  digest: EmailDigest | null;
	  digestLoading: boolean;
	  addressSearch: string;
	  sourceSearch: string;
	  dialog: DialogName;
  readerScroll: number;
  compose: ComposeState | null;
  settings: TuiSettings;
  now: number;
  loading: boolean;
  busyPull: boolean;
  lastError: string | null;
}

const PAGE_SIZE = 50;
const WORKSPACE_PAGE_SIZE = 50;
const CLOCK_MS = 4000;
const REFRESH_MS = 30000;
const PULL_MS = 45000;

function emptyCounts(): MailboxCounts {
  return { inbox: 0, unread: 0, starred: 0, sent: 0, archived: 0, spam: 0, trash: 0 };
}

function sourceForSelection(address: InboxAddressChoice | undefined, sourceId: string | undefined): MailboxSource | undefined {
  const source: MailboxSource = {};
  if (sourceId && sourceId !== "all") source.sourceId = sourceId;
  if (address?.address) source.address = address.address;
  return Object.keys(source).length > 0 ? source : undefined;
}

/**
 * Resolve a selected-address id to its choice. Falls back to the DB (addressChoiceByAddress)
 * so an address that sits beyond the picker's list cap — only reachable by typing in the
 * search box — never collapses to "All inboxes". Previously `find(id) ?? list[0]` would
 * fall back to ALL_ADDRESSES (list[0]) when the selected address wasn't in the capped list,
 * so selecting a searched-for address showed every inbox instead of that one.
 */
export function resolveAddressChoice(id: string, candidates: InboxAddressChoice[]): InboxAddressChoice {
  if (!id || id === ALL_ADDRESSES.id) return ALL_ADDRESSES;
  const inList = candidates.find((item) => item.id === id);
  if (inList) return inList;
  if (id.startsWith("a:")) return addressChoiceByAddress(id.slice(2));
  return ALL_ADDRESSES;
}

function selectedAddress(state: Pick<EmailsState, "addresses" | "selectedAddressId">): InboxAddressChoice {
  return resolveAddressChoice(state.selectedAddressId, state.addresses);
}

function selectedSource(state: Pick<EmailsState, "sources" | "selectedSourceId">): InboxSource {
  return state.sources.find((source) => source.id === state.selectedSourceId)
    ?? state.sources.find((source) => source.id === "all")
    ?? { id: "all", label: "All sources" };
}

function pageOffset(page: number): number {
  return Math.max(0, page) * PAGE_SIZE;
}

function clampMailbox(value: Mailbox | undefined): Mailbox {
  return value && MAILBOXES.includes(value) ? value : "inbox";
}

function selectedMessage(state: Pick<EmailsState, "messages" | "selectedMessageId">): TuiMessage | null {
  return state.messages.find((message) => message.id === state.selectedMessageId) ?? state.messages[0] ?? null;
}

function messageIndex(state: Pick<EmailsState, "messages" | "selectedMessageId">): number {
  const index = state.messages.findIndex((message) => message.id === state.selectedMessageId);
  return index >= 0 ? index : 0;
}

function loadAddresses(search?: string): InboxAddressChoice[] {
  return listInboxAddresses({ limit: 200, search: search || undefined });
}

function createEmailsStore(initialMailbox?: Mailbox) {
  const settings = getSettings();
  // Resolve only the persisted default address at startup (one indexed lookup) instead of
  // scanning the whole observed-address list (which can take >200ms on a large mailbox) —
  // the full list loads in the post-mount reload, so first paint isn't blocked on it.
  const defaultChoice = settings.defaultAddress ? addressChoiceByAddress(settings.defaultAddress) : ALL_ADDRESSES;
  const initialAddresses = defaultChoice.id === ALL_ADDRESSES.id ? [ALL_ADDRESSES] : [ALL_ADDRESSES, defaultChoice];
  // The active mail data source: `local` (SQLite) or `self_hosted` (API client). All
  // message reads/writes below flow through this seam so the TUI works in both
  // modes; local-only concepts (domains, address picker, settings, threaded
  // conversation bodies) still read the local store directly.
  const ds = resolveMailDataSource();
  const initialSources = ds.mode === "local" ? listSources().slice(0, 80) : [{ id: "all", label: "All sources" }];
  const [state, setState] = createStore<EmailsState>({
    mailbox: clampMailbox(initialMailbox ?? settings.defaultMailbox),
    route: "mailbox",
    messages: [],
    counts: emptyCounts(),
    addresses: initialAddresses,
    selectedAddressId: defaultChoice.id,
    sources: initialSources.length ? initialSources : [{ id: "all", label: "All sources" }],
    selectedSourceId: "all",
    selectedMessageId: null,
    page: 0,
    hasMore: false,
    search: "",
    searchDraft: "",
    sort: "newest",
    groupMode: "none",
    domains: [],
    domainsPage: 0,
    domainsHasMore: false,
    labels: [],
    activeLabel: null,
    labelSearch: "",
    commandSearch: "",
    linkIndex: 0,
    digestPeriod: "today",
    digest: null,
    digestLoading: false,
    addressSearch: "",
    sourceSearch: "",
    dialog: null,
    readerScroll: 0,
    compose: null,
    settings,
    now: Date.now(),
    loading: false,
    busyPull: false,
    lastError: null,
  });

  const currentAddress = createMemo(() => selectedAddress(state));
  const currentSource = createMemo(() => selectedSource(state));
  const currentMessage = createMemo(() => selectedMessage(state));
  const [currentBody] = createResource(currentMessage, async (message): Promise<MessageBody | null> => {
    return message ? await ds.getMessageBody(message) : null;
  });
  // Thread bodies flow through the seam so the reader's conversation view works in
  // both modes (self_hosted: listThread + per-message bodies; local: SQLite conversation).
  const [conversationResource] = createResource(currentMessage, async (message): Promise<TuiThreadBody[]> => {
    return message ? await ds.getConversationBodies(message, { limit: 12 }) : [];
  });
  const currentConversation = createMemo<TuiThreadBody[]>(() => conversationResource() ?? []);
  const currentLinks = createMemo<ExtractedEmailLink[]>(() => {
    const body = currentBody();
    return body ? extractEmailLinks({ text: body.text, html: body.html, includeNonWeb: true, max: 200 }) : [];
  });
  const groupedMessages = createMemo<TuiMessageGroup[]>(() => groupMailboxMessages(state.messages, state.groupMode));

  const loadDigestSnapshot = async (period = state.digestPeriod, options?: { fresh?: boolean; local?: boolean }) => {
    setState("digestLoading", true);
    setState("digestPeriod", period);
    try {
      const digest = await loadEmailDigest(period, {
        fresh: options?.fresh,
        offline: options?.local,
        allowLocalFallback: true,
      });
      setState("digest", digest);
      setState("lastError", null);
      return digest;
    } catch (error) {
      setState("lastError", error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setState("digestLoading", false);
    }
  };

  // Per-address folder counts and label summaries are the expensive part of a reload on a
  // large mailbox (e.g. mailboxCounts() over an address with 80k+ messages can take ~200ms),
  // but they are only secondary sidebar metadata. Compute them OFF the critical path so the
  // message list paints immediately; only the latest scheduled compute wins.
  let sidebarMetaTimer: ReturnType<typeof setTimeout> | undefined;
  let addressSearchTimer: ReturnType<typeof setTimeout> | undefined;
  let labelSearchTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleSidebarMeta = (source: MailboxSource | undefined, addressSearch?: string) => {
    if (sidebarMetaTimer) clearTimeout(sidebarMetaTimer);
    sidebarMetaTimer = setTimeout(() => {
      sidebarMetaTimer = undefined;
      void (async () => {
        try {
          // Load the full address list here (off the critical path): the observed-address scan
          // is the cold-start cost (~200ms on a large mailbox), and the message list doesn't
          // need it — only the picker + counts do.
          const loaded = loadAddresses(addressSearch);
          const selected = resolveAddressChoice(state.selectedAddressId, [...loaded, ...state.addresses]);
          // Keep the selected inbox in the rendered picker list even when it sits beyond the
          // list cap, so it shows its marker and the inbox stays filtered to it.
          const addresses = selected.id === ALL_ADDRESSES.id || loaded.some((item) => item.id === selected.id)
            ? loaded
            : loaded[0]?.id === ALL_ADDRESSES.id
              ? [loaded[0], selected, ...loaded.slice(1)]
              : [selected, ...loaded];
	          const [counts, labels] = await Promise.all([
	            ds.mailboxCounts({ source }),
	            ds.listLabelSummaries({ limit: 80, search: state.labelSearch || undefined }),
	          ]);
	          const sources = ds.mode === "local" ? listSources().slice(0, 80) : [{ id: "all", label: "All sources" }];
	          setState({ addresses, counts, labels, sources: sources.length ? sources : [{ id: "all", label: "All sources" }] });
        } catch (error) {
          setState("lastError", error instanceof Error ? error.message : String(error));
        }
      })();
    }, 0);
  };

  const reload = async (options?: { preserveSelection?: boolean; addressSearch?: string }): Promise<void> => {
    const preserveSelection = options?.preserveSelection ?? true;
    setState("loading", true);
    try {
      // Resolve the selected inbox cheaply (current in-memory list → DB) WITHOUT scanning the
      // full address list, so the message list — what the user is waiting for — paints first.
	      // The full address list, counts, and labels load off the critical path below.
	      const selected = resolveAddressChoice(state.selectedAddressId, state.addresses);
	      const selectedSrc = selectedSource(state);
	      const source = sourceForSelection(selected, selectedSrc.id);
      const messages = await ds.listMailbox(state.mailbox, {
        limit: PAGE_SIZE + 1,
        offset: pageOffset(state.page),
        search: state.search,
        label: state.activeLabel ?? undefined,
        source,
        sort: state.sort,
      });
      const visible = messages.slice(0, PAGE_SIZE);
      const selectedId = preserveSelection && state.selectedMessageId && visible.some((message) => message.id === state.selectedMessageId)
        ? state.selectedMessageId
        : visible[0]?.id ?? null;
      setState({
	        selectedAddressId: selected.id,
	        selectedSourceId: selectedSrc.id,
        messages: visible,
        hasMore: messages.length > PAGE_SIZE,
        selectedMessageId: selectedId,
        lastError: null,
      });
      scheduleSidebarMeta(source, options?.addressSearch);
    } catch (error) {
      setState("lastError", error instanceof Error ? error.message : String(error));
    } finally {
      setState("loading", false);
    }
  };

  const reloadWorkspace = () => {
    try {
      const domains = listDomainSummaries({ limit: WORKSPACE_PAGE_SIZE + 1, offset: state.domainsPage * WORKSPACE_PAGE_SIZE });
      setState({
        domains: domains.slice(0, WORKSPACE_PAGE_SIZE),
        domainsHasMore: domains.length > WORKSPACE_PAGE_SIZE,
      });
    } catch (error) {
      setState("lastError", error instanceof Error ? error.message : String(error));
    }
  };

  const openMessage = (id?: string) => {
    const message = id ? state.messages.find((item) => item.id === id) : currentMessage();
    if (!message) return;
    setState("selectedMessageId", message.id);
    if (!message.is_read) {
      void ds.setRead(message.id, true);
      setState("messages", (item) => item.id === message.id, "is_read", true);
      setState("counts", "unread", Math.max(0, state.counts.unread - 1));
    }
    setState("readerScroll", 0);
    setState("route", "reader");
  };

  const startCompose = (mode: ComposeMode, message?: TuiMessage) => {
    const source = sourceForSelection(currentAddress(), state.selectedSourceId);
    if (mode === "new" || !message) {
      setState("compose", {
        mode: "new",
        from: defaultFromAddress({ source, fallback: state.settings.defaultFrom ?? undefined }),
        to: "",
        subject: "",
        body: "",
        field: "to",
      });
      return;
    }
    if (mode === "reply") {
      const defaults = replyDefaults(message);
      setState("compose", {
        mode,
        from: defaults.from || defaultFromAddress({ source, fallback: state.settings.defaultFrom ?? undefined }),
        to: defaults.to,
        subject: defaults.subject,
        body: "",
        field: "body",
        replyTo: message,
      });
      return;
    }
    setState("compose", {
      mode,
      from: defaultFromAddress({ source, fallback: state.settings.defaultFrom ?? undefined }),
      to: "",
      subject: /^fwd:/i.test(message.subject) ? message.subject : `Fwd: ${message.subject}`,
      body: "",
      field: "to",
      replyTo: message,
    });
  };

  const sendCompose = async () => {
    if (!state.compose) return;
    const result = await ds.send({
      from: state.compose.from,
      to: state.compose.to,
      subject: state.compose.subject,
      body: state.compose.body,
      replyToId: state.compose.mode === "reply" ? state.compose.replyTo?.id : undefined,
    });
    setState("compose", null);
    void reload({ preserveSelection: false });
    return result;
  };

  const selectOffset = (delta: number) => {
    if (state.messages.length === 0) return;
    const next = Math.max(0, Math.min(state.messages.length - 1, messageIndex(state) + delta));
    setState("selectedMessageId", state.messages[next]?.id ?? null);
  };

  const toggleSelectedLabel = async (label: string) => {
    const message = currentMessage();
    if (!message) return;
    const normalized = normalizedLabelName(label);
    const has = message.labels.some((existing) => labelNameKey(existing) === labelNameKey(normalized));
    const labels = has
      ? await ds.removeLabel(message.id, normalized)
      : await ds.addLabel(message.id, normalized);
    setState("messages", (item) => item.id === message.id, "labels", labels);
    setState("labels", await ds.listLabelSummaries({ limit: 80, search: state.labelSearch || undefined }));
  };

  const actions = {
    reload,
    reloadWorkspace,
    openRoute(route: RouteName) {
      if (route === "domains") reloadWorkspace();
      setState("route", route);
    },
    openDialog(dialog: DialogName) {
      if (dialog === "address") {
        setState("addressSearch", "");
        setState("addresses", loadAddresses());
      }
      if (dialog === "filter" || dialog === "search") setState("searchDraft", state.search);
      if (dialog === "digest") void loadDigestSnapshot(state.digestPeriod, { local: true });
      if (dialog === "domains") reloadWorkspace();
      if (dialog === "labels") void ds.listLabelSummaries({ limit: 80 }).then((labels) => setState("labels", labels));
      setState("dialog", dialog);
    },
    closeDialog() {
      setState("dialog", null);
      setState("commandSearch", "");
      setState("addressSearch", "");
      setState("labelSearch", "");
    },
    setMailbox(mailbox: Mailbox) {
      setState({ mailbox, activeLabel: null, page: 0, route: "mailbox", selectedMessageId: null });
      reload({ preserveSelection: false });
    },
    filterLabel(label: string | null) {
      const nextLabel = label ? normalizedLabelName(label) : null;
      const active = nextLabel && state.activeLabel && labelNameKey(nextLabel) === labelNameKey(state.activeLabel);
      setState({
        activeLabel: active ? null : nextLabel,
        mailbox: "inbox",
        page: 0,
        route: "mailbox",
        selectedMessageId: null,
      });
      reload({ preserveSelection: false });
    },
    selectMessage(id: string) {
      setState("selectedMessageId", id);
    },
    selectOffset,
    openMessage,
    backToList() {
      setState("route", "mailbox");
    },
    cycleSort() {
      setState("sort", state.sort === "newest" ? "oldest" : "newest");
      setState("page", 0);
      reload({ preserveSelection: false });
    },
    setGroupMode(mode: MailboxGroupMode | string) {
      setState("groupMode", normalizeMailboxGroupMode(mode));
    },
    groupModeLabel(mode?: MailboxGroupMode) {
      return mailboxGroupModeLabel(mode ?? state.groupMode);
    },
    async loadDigest(period?: EmailDigestPeriod, options?: { fresh?: boolean; local?: boolean }) {
      return loadDigestSnapshot(period ?? state.digestPeriod, options);
    },
    async generateDigest(period?: EmailDigestPeriod) {
      return loadDigestSnapshot(period ?? state.digestPeriod, { fresh: true });
    },
    page(delta: number) {
      const next = Math.max(0, state.page + delta);
      if (next === state.page) return;
      if (delta > 0 && !state.hasMore) return;
      setState("page", next);
      reload({ preserveSelection: false });
    },
	    setAddress(id: string) {
	      setState({ selectedAddressId: id, page: 0, selectedMessageId: null });
	      const address = state.addresses.find((item) => item.id === id);
	      persistSetting("defaultAddress", address?.address ?? null);
	      setState("settings", "defaultAddress", address?.address ?? null);
	      reload({ preserveSelection: false });
	    },
	    setSource(id: string) {
	      setState({ selectedSourceId: id || "all", page: 0, selectedMessageId: null });
	      reload({ preserveSelection: false });
	    },
    search(value: string) {
      setState({ search: value, searchDraft: value, page: 0, selectedMessageId: null });
      reload({ preserveSelection: false });
    },
    clearFilters() {
      setState({
        mailbox: "inbox",
        activeLabel: null,
	        search: "",
	        searchDraft: "",
	        selectedSourceId: "all",
	        page: 0,
        route: "mailbox",
        selectedMessageId: null,
      });
      reload({ preserveSelection: false });
    },
    setSearchDraft(value: string) {
      setState("searchDraft", value);
    },
    setCommandSearch(value: string) {
      setState("commandSearch", value);
    },
	    setAddressSearch(value: string) {
	      setState("addressSearch", value);
      // Keep typing responsive: the dialog filters the already-loaded list client-side
      // instantly; debounce the DB re-query (a recipient scan that can take >300ms on a
      // large mailbox) so it runs once after the user pauses.
      if (addressSearchTimer) clearTimeout(addressSearchTimer);
      addressSearchTimer = setTimeout(() => {
        addressSearchTimer = undefined;
        setState("addresses", loadAddresses(value));
	      }, 160);
	    },
	    setSourceSearch(value: string) {
	      setState("sourceSearch", value);
	      const q = value.trim().toLowerCase();
	      const sources = listSources()
	        .filter((source) => !q || `${source.label} ${source.id}`.toLowerCase().includes(q))
	        .slice(0, 80);
	      setState("sources", sources.length ? sources : [{ id: "all", label: "All sources" }]);
	    },
    setLabelSearch(value: string) {
      setState("labelSearch", value);
      if (labelSearchTimer) clearTimeout(labelSearchTimer);
      labelSearchTimer = setTimeout(() => {
        labelSearchTimer = undefined;
        void ds.listLabelSummaries({ limit: 80, search: value || undefined }).then((labels) => setState("labels", labels));
      }, 160);
    },
    setLinkIndex(index: number) {
      setState("linkIndex", Math.max(0, Math.min(currentLinks().length - 1, index)));
    },
    async toggleStar() {
      const message = currentMessage();
      if (!message) return;
      const isStarred = !message.is_starred;
      await ds.setStarred(message.id, isStarred);
      setState("messages", (item) => item.id === message.id, "is_starred", isStarred);
      void reload({ preserveSelection: true });
    },
    async toggleRead() {
      const message = currentMessage();
      if (!message) return;
      const isRead = !message.is_read;
      await ds.setRead(message.id, isRead);
      setState("messages", (item) => item.id === message.id, "is_read", isRead);
      void reload({ preserveSelection: true });
    },
    async archive() {
      const message = currentMessage();
      if (!message) return;
      await ds.setArchived(message.id, true);
      void reload({ preserveSelection: false });
    },
    toggleSelectedLabel,
    startCompose,
    patchCompose(patch: Partial<ComposeState>) {
      if (!state.compose) return;
      setState("compose", { ...state.compose, ...patch });
    },
    cycleComposeField(delta: number) {
      if (!state.compose) return;
      const fields: ComposeField[] = ["from", "to", "subject", "body"];
      const idx = fields.indexOf(state.compose.field);
      setState("compose", "field", fields[(idx + delta + fields.length) % fields.length] ?? "body");
    },
    closeCompose() {
      setState("compose", null);
    },
    sendCompose,
    setSetting<K extends keyof TuiSettings>(key: K, value: TuiSettings[K]) {
      persistSetting(key, value);
      setState("settings", key, value);
      if (key === "defaultMailbox") setState("mailbox", value as Mailbox);
    },
    workspacePage(delta: number) {
      if (delta > 0 && !state.domainsHasMore) return;
      setState("domainsPage", Math.max(0, state.domainsPage + delta));
      reloadWorkspace();
    },
    async pullNow() {
      // Auto-pull is LOCAL S3 ingestion; self_hosted reads the API through the seam, so
      // pulling is a no-op there (mirrors the CLI/MCP mode gating).
      if (ds.mode !== "local") return { pulled: 0, ok: true, configured: false, reason: "self_hosted mode" };
      if (state.busyPull) return { pulled: 0, ok: false, configured: false, reason: "Pull already running" };
	      setState("busyPull", true);
	      try {
	        const result = await autoPull({ limit: 1000, forwarding: true });
	        await reload({ preserveSelection: true });
	        if (!result.ok) setState("lastError", result.reason ?? "Pull failed");
	        else setState("lastError", null);
	        return result;
	      } catch (error) {
	        const reason = error instanceof Error ? error.message : String(error);
	        setState("lastError", reason);
	        return { pulled: 0, ok: false, configured: false, reason };
	      } finally {
	        setState("busyPull", false);
	      }
    },
  };

  onMount(() => {
    reload({ preserveSelection: false });
    reloadWorkspace();
    const clock = setInterval(() => setState("now", Date.now()), CLOCK_MS);
    const refresh = setInterval(() => {
      if (!state.busyPull) reload({ preserveSelection: true });
    }, REFRESH_MS);
    const pull = setInterval(() => {
      if (state.settings.autoPull && !state.busyPull) void actions.pullNow();
    }, PULL_MS);
    onCleanup(() => {
      clearInterval(clock);
      clearInterval(refresh);
      clearInterval(pull);
      if (sidebarMetaTimer) clearTimeout(sidebarMetaTimer);
      if (addressSearchTimer) clearTimeout(addressSearchTimer);
      if (labelSearchTimer) clearTimeout(labelSearchTimer);
    });
  });

  return {
    state,
    actions,
    // Resolved data-source mode ("local" | "self_hosted"). Same signal pullNow() gates on
    // (ds.mode), so UI affordances stay in lockstep with the seam: self_hosted ingestion is
    // the server's job, so the manual Pull affordance is local-only.
	    mode: ds.mode,
	    selectedAddress: currentAddress,
	    selectedSource: currentSource,
	    selectedMessage: currentMessage,
    selectedBody: currentBody,
    conversation: currentConversation,
    links: currentLinks,
    groupedMessages,
  };
}

type EmailsContextValue = ReturnType<typeof createEmailsStore>;
const EmailsContext = createContext<EmailsContextValue>();

export function EmailsProvider(props: ParentProps<{ initialMailbox?: Mailbox }>) {
  const store = createEmailsStore(props.initialMailbox);
  return <EmailsContext.Provider value={store}>{props.children}</EmailsContext.Provider>;
}

export function useEmails(): EmailsContextValue {
  const store = useContext(EmailsContext);
  if (!store) throw new Error("useEmails must be used within EmailsProvider");
  return store;
}

export { MAILBOXES, COMMON_LABELS };
