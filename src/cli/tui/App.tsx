/** @jsxImportSource @opentui/react */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { MouseButton, RGBA, TextAttributes, type KeyEvent, type MouseEvent, type ThemeMode as OpenTuiThemeMode } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import {
  listMailbox,
  mailboxCounts,
  getMessageBody,
  getConversation,
  toggleStar,
  toggleRead,
  markRead,
  archiveMessage,
  replyDefaults,
  sendComposed,
  listProfiles,
  listDomainSummaries,
  listInboxAddresses,
  getSettings,
  setSetting,
  defaultFromAddress,
  addressChoiceByAddress,
  ALL_ADDRESSES,
  MAILBOXES,
  mailboxLabel,
  type Mailbox,
  type MailboxCounts,
  type TuiMessage,
  type InboxAddressChoice,
  type TuiSettings,
  type DomainSummary,
} from "./data.js";
import { autoPull } from "./autopull.js";
import { truncate, senderName, relativeTime, formatDate, wrapText } from "./format.js";
import { nextThemeMode, resolveTheme, type ResolvedTuiThemeName, type TuiTheme } from "./theme.js";
import { startEventLoopWatchdog } from "./watchdog.js";
import { getEmailSystemStatus, type EmailSystemStatus } from "../../lib/agent-context.js";

type View = "home" | "list" | "reader" | "compose" | "profiles" | "domains";
type DialogKind = "addressPicker" | "commands" | "settings" | null;
type ComposeField = "from" | "to" | "subject" | "body";

interface ComposeState {
  from: string;
  to: string;
  subject: string;
  body: string;
  field: ComposeField;
  returnTo: View;
  replyTo?: TuiMessage;
}

interface Status {
  text: string;
  tone: "info" | "ok" | "err";
}

interface LoadedMailbox {
  messages: TuiMessage[];
  counts: MailboxCounts;
  hasAnyMail: boolean;
  hasMore: boolean;
}

interface Model extends LoadedMailbox {
  mailbox: Mailbox;
  addressIdx: number;
  homeIdx: number;
  addressPickerIdx: number;
  addressSearch: string;
  commandIdx: number;
  settingsIdx: number;
  commandSearch: string;
  commandReturnTo: View;
  dialog: DialogKind;
  page: number;
  sort: "newest" | "oldest";
  selectedId: string | null;
  view: View;
  searchActive: boolean;
  search: string;
  readerScroll: number;
  compose: ComposeState | null;
  settings: TuiSettings;
  status: Status;
  now: number;
}

type Action =
  | { type: "hydrate"; loaded: LoadedMailbox; preserveSelection: boolean }
  | { type: "tick"; now: number }
  | { type: "flash"; status: Status }
  | { type: "clearStatus"; text: string }
  | { type: "openInbox" }
  | { type: "setMailbox"; mailbox: Mailbox }
  | { type: "cycleMailbox"; delta: number }
  | { type: "setAddress"; index: number }
  | { type: "cycleSort" }
  | { type: "pageOffset"; delta: number }
  | { type: "syncAddressIndex"; index: number }
  | { type: "clampAddresses"; count: number }
  | { type: "selectHomeOffset"; delta: number }
  | { type: "selectAddressPickerOffset"; delta: number; count: number }
  | { type: "openCommandPalette"; returnTo: View }
  | { type: "closeCommandPalette" }
  | { type: "selectCommandOffset"; delta: number; count: number }
  | { type: "commandAppend"; text: string }
  | { type: "commandBackspace" }
  | { type: "commandClear" }
  | { type: "openAddressPicker" }
  | { type: "addressSearchAppend"; text: string }
  | { type: "addressSearchBackspace" }
  | { type: "addressSearchClear" }
  | { type: "openSettingsDialog" }
  | { type: "selectSettingsOffset"; delta: number; count: number }
  | { type: "closeDialog" }
  | { type: "selectId"; id: string | null }
  | { type: "selectOffset"; delta: number }
  | { type: "view"; view: View }
  | { type: "reader"; scroll?: number }
  | { type: "scroll"; delta: number }
  | { type: "searchStart" }
  | { type: "searchStop" }
  | { type: "searchClear" }
  | { type: "searchAppend"; text: string }
  | { type: "searchBackspace" }
  | { type: "composeStart"; compose: ComposeState }
  | { type: "composeCancel" }
  | { type: "composePatch"; patch: Partial<ComposeState> }
  | { type: "composeFocusField"; field: ComposeField }
  | { type: "composeCycleField"; delta: number }
  | { type: "composeEnter" }
  | { type: "composeBackspace" }
  | { type: "composeText"; text: string }
  | { type: "settingsPatch"; patch: Partial<TuiSettings> };

interface FrameLine {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
}

interface ActionLine {
  line: FrameLine;
  onPress?: () => void;
}

interface RenderContentArgs {
  state: Model;
  addresses: InboxAddressChoice[];
  address: InboxAddressChoice;
  selectedIndex: number;
  selectedMsg: TuiMessage | null;
  readerBody: ReturnType<typeof getMessageBody>;
  conversation: ReturnType<typeof getConversation>;
  systemStatus: EmailSystemStatus;
  width: number;
  height: number;
  theme: TuiTheme;
}

const CLOCK_TICK_MS = 4000;
const LOCAL_RELOAD_MS = 30000;
const PULL_MS = 45000;
const GMAIL_PULL_MS = 120000;
const AUTOPULL_START_DELAY_MS = 15000;
const USER_IDLE_MS = 1500;
const STATUS_MS = 5000;
const MAILBOX_PAGE_SIZE = 50;
const HOME_ITEMS = ["Inbox", "Compose", "Domains", "Profiles", "Settings"] as const;
const COMPOSE_FIELDS: ComposeField[] = ["from", "to", "subject", "body"];
const SETTINGS_ROW_COUNT = 7;
type PaletteAction = "inbox" | "compose" | "domains" | "profiles" | "settings" | "address" | "refresh" | "pull" | "search" | "unread" | "sent" | "archived";
const COMMAND_ITEMS: Array<{ title: string; detail: string; action: PaletteAction }> = [
  { title: "Open Inbox", detail: "Show received mail", action: "inbox" },
  { title: "Compose", detail: "Start a new message", action: "compose" },
  { title: "Domains", detail: "Domain readiness, addresses, and mail counts", action: "domains" },
  { title: "Profiles", detail: "Provider, domain, owner, alias, and key details", action: "profiles" },
  { title: "Settings", detail: "Theme, defaults, and pull controls", action: "settings" },
  { title: "Choose Address", detail: "Switch the inbox to a specific email address", action: "address" },
  { title: "Refresh", detail: "Reload local mail and address choices", action: "refresh" },
  { title: "Pull Now", detail: "Run configured inbox pull once", action: "pull" },
  { title: "Search Mail", detail: "Filter the current mailbox", action: "search" },
  { title: "Unread", detail: "Open unread messages", action: "unread" },
  { title: "Sent", detail: "Open sent mail", action: "sent" },
  { title: "Archived", detail: "Open archived mail", action: "archived" },
];

function filteredCommands(search: string): typeof COMMAND_ITEMS {
  const q = search.trim().toLowerCase();
  if (!q) return COMMAND_ITEMS;
  return COMMAND_ITEMS.filter((item) => `${item.title} ${item.detail} ${item.action}`.toLowerCase().includes(q));
}

function filteredAddressChoices(choices: InboxAddressChoice[], search: string): InboxAddressChoice[] {
  const q = search.trim().toLowerCase();
  if (!q) return choices;
  return choices.filter((choice) =>
    `${choice.label} ${choice.address ?? ""} ${choice.configured ? "configured" : ""} ${choice.observed ? "observed" : ""}`
      .toLowerCase()
      .includes(q));
}

function choiceToFilter(choice: InboxAddressChoice | undefined): { address?: string } | undefined {
  return choice?.address ? { address: choice.address } : undefined;
}

function loadMailbox(
  mailbox: Mailbox,
  search: string,
  choice: InboxAddressChoice | undefined,
  page = 0,
  sort: Model["sort"] = "newest",
): LoadedMailbox {
  const filter = choiceToFilter(choice);
  const offset = Math.max(0, page) * MAILBOX_PAGE_SIZE;
  const fetched = listMailbox(mailbox, {
    limit: MAILBOX_PAGE_SIZE + 1,
    offset,
    search: search || undefined,
    source: filter,
    sort,
  });
  const messages = fetched.slice(0, MAILBOX_PAGE_SIZE);
  const counts = mailboxCounts(filter ? { source: filter } : undefined);
  const allCounts = filter ? mailboxCounts() : counts;
  const hasAnyMail = Object.values(allCounts).some((n) => n > 0);
  return { messages, counts, hasAnyMail, hasMore: fetched.length > MAILBOX_PAGE_SIZE };
}

function selectedIndex(messages: TuiMessage[], selectedId: string | null): number {
  const i = messages.findIndex((m) => m.id === selectedId);
  return i < 0 ? 0 : i;
}

function selectWithin(messages: TuiMessage[], selectedId: string | null, delta: number): string | null {
  if (messages.length === 0) return null;
  const i = selectedIndex(messages, selectedId);
  const next = Math.min(messages.length - 1, Math.max(0, i + delta));
  return messages[next]?.id ?? null;
}

function firstAddress(value: string | undefined): string {
  return value?.split(",")[0]?.trim() ?? "";
}

function reducer(state: Model, action: Action): Model {
  switch (action.type) {
    case "hydrate": {
      const keep = action.preserveSelection && state.selectedId && action.loaded.messages.some((m) => m.id === state.selectedId);
      return {
        ...state,
        ...action.loaded,
        selectedId: keep ? state.selectedId : action.loaded.messages[0]?.id ?? null,
        now: Date.now(),
      };
    }
    case "tick":
      return { ...state, now: action.now };
    case "flash":
      return { ...state, status: action.status };
    case "clearStatus":
      return state.status.text === action.text ? { ...state, status: { text: "", tone: "info" } } : state;
    case "openInbox":
      return {
        ...state,
        mailbox: "inbox",
        addressIdx: 0,
        addressPickerIdx: 0,
        page: 0,
        sort: "newest",
        selectedId: null,
        view: "list",
        searchActive: false,
        search: "",
        readerScroll: 0,
        dialog: null,
      };
    case "setMailbox":
      return { ...state, mailbox: action.mailbox, page: 0, selectedId: null, view: "list", readerScroll: 0, dialog: null };
    case "cycleMailbox": {
      const i = MAILBOXES.indexOf(state.mailbox);
      const mailbox = MAILBOXES[(i + action.delta + MAILBOXES.length) % MAILBOXES.length]!;
      return { ...state, mailbox, page: 0, selectedId: null, view: "list", readerScroll: 0, dialog: null };
    }
    case "setAddress":
      return { ...state, addressIdx: action.index, page: 0, selectedId: null, view: "list", readerScroll: 0, dialog: null };
    case "cycleSort":
      return { ...state, sort: state.sort === "newest" ? "oldest" : "newest", page: 0, selectedId: null, view: "list", readerScroll: 0 };
    case "pageOffset": {
      if (action.delta > 0 && !state.hasMore) return state;
      if (action.delta < 0 && state.page === 0) return state;
      return { ...state, page: Math.max(0, state.page + action.delta), selectedId: null, view: "list", readerScroll: 0 };
    }
    case "syncAddressIndex":
      return { ...state, addressIdx: action.index, addressPickerIdx: Math.min(state.addressPickerIdx, action.index) };
    case "clampAddresses": {
      if (action.count <= 0) return { ...state, addressIdx: 0, addressPickerIdx: 0 };
      return {
        ...state,
        addressIdx: Math.min(state.addressIdx, action.count - 1),
        addressPickerIdx: Math.min(state.addressPickerIdx, action.count - 1),
      };
    }
    case "selectHomeOffset": {
      const next = Math.min(HOME_ITEMS.length - 1, Math.max(0, state.homeIdx + action.delta));
      return { ...state, homeIdx: next };
    }
    case "selectAddressPickerOffset": {
      const next = Math.min(Math.max(0, action.count - 1), Math.max(0, state.addressPickerIdx + action.delta));
      return { ...state, addressPickerIdx: next };
    }
    case "openCommandPalette":
      return { ...state, dialog: "commands", commandReturnTo: action.returnTo, commandIdx: 0, commandSearch: "" };
    case "closeCommandPalette":
      return { ...state, dialog: null, commandSearch: "", commandIdx: 0 };
    case "selectCommandOffset": {
      const next = Math.min(Math.max(0, action.count - 1), Math.max(0, state.commandIdx + action.delta));
      return { ...state, commandIdx: next };
    }
    case "commandAppend":
      return { ...state, commandSearch: state.commandSearch + action.text, commandIdx: 0 };
    case "commandBackspace":
      return { ...state, commandSearch: state.commandSearch.slice(0, -1), commandIdx: 0 };
    case "commandClear":
      return { ...state, commandSearch: "", commandIdx: 0 };
    case "openAddressPicker":
      return { ...state, addressPickerIdx: state.addressIdx, addressSearch: "", dialog: "addressPicker" };
    case "addressSearchAppend":
      return { ...state, addressSearch: state.addressSearch + action.text, addressPickerIdx: 0 };
    case "addressSearchBackspace":
      return { ...state, addressSearch: state.addressSearch.slice(0, -1), addressPickerIdx: 0 };
    case "addressSearchClear":
      return { ...state, addressSearch: "", addressPickerIdx: 0 };
    case "openSettingsDialog":
      return { ...state, settingsIdx: 0, dialog: "settings" };
    case "selectSettingsOffset": {
      const next = Math.min(Math.max(0, action.count - 1), Math.max(0, state.settingsIdx + action.delta));
      return { ...state, settingsIdx: next };
    }
    case "closeDialog":
      return { ...state, dialog: null, commandSearch: "", commandIdx: 0 };
    case "selectId":
      return { ...state, selectedId: action.id };
    case "selectOffset":
      return { ...state, selectedId: selectWithin(state.messages, state.selectedId, action.delta) };
    case "view":
      return { ...state, view: action.view, searchActive: action.view === "list" ? state.searchActive : false, dialog: null };
    case "reader":
      return { ...state, view: "reader", readerScroll: action.scroll ?? 0 };
    case "scroll":
      return { ...state, readerScroll: Math.max(0, state.readerScroll + action.delta) };
    case "searchStart":
      return { ...state, searchActive: true };
    case "searchStop":
      return { ...state, searchActive: false };
    case "searchClear":
      return { ...state, search: "", page: 0, searchActive: false, selectedId: null };
    case "searchAppend":
      return { ...state, search: state.search + action.text, page: 0, selectedId: null };
    case "searchBackspace":
      return { ...state, search: state.search.slice(0, -1), page: 0, selectedId: null };
    case "composeStart":
      return { ...state, view: "compose", compose: action.compose, dialog: null };
    case "composeCancel":
      return { ...state, view: state.compose?.returnTo ?? "home", compose: null };
    case "composePatch":
      return state.compose ? { ...state, compose: { ...state.compose, ...action.patch } } : state;
    case "composeFocusField":
      return state.compose ? { ...state, compose: { ...state.compose, field: action.field } } : state;
    case "composeCycleField": {
      if (!state.compose) return state;
      const i = COMPOSE_FIELDS.indexOf(state.compose.field);
      return { ...state, compose: { ...state.compose, field: COMPOSE_FIELDS[(i + action.delta + COMPOSE_FIELDS.length) % COMPOSE_FIELDS.length]! } };
    }
    case "composeEnter": {
      if (!state.compose) return state;
      if (state.compose.field === "body") return { ...state, compose: { ...state.compose, body: `${state.compose.body}\n` } };
      const i = COMPOSE_FIELDS.indexOf(state.compose.field);
      return { ...state, compose: { ...state.compose, field: COMPOSE_FIELDS[Math.min(COMPOSE_FIELDS.length - 1, i + 1)]! } };
    }
    case "composeBackspace": {
      if (!state.compose) return state;
      const field = state.compose.field;
      return { ...state, compose: { ...state.compose, [field]: state.compose[field].slice(0, -1) } };
    }
    case "composeText": {
      if (!state.compose) return state;
      const field = state.compose.field;
      return { ...state, compose: { ...state.compose, [field]: state.compose[field] + action.text } };
    }
    case "settingsPatch":
      return { ...state, settings: { ...state.settings, ...action.patch } };
  }
}

function sameAddressChoices(a: InboxAddressChoice[], b: InboxAddressChoice[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return y && x.id === y.id && x.label === y.label && x.address === y.address && x.configured === y.configured && x.observed === y.observed;
  });
}

function normalizeOpenTuiTheme(mode: OpenTuiThemeMode | null | undefined): ResolvedTuiThemeName | null {
  return mode === "dark" || mode === "light" ? mode : null;
}

function useOpenTuiThemeMode(): ResolvedTuiThemeName | null {
  const renderer = useRenderer();
  const [mode, setMode] = useState<ResolvedTuiThemeName | null>(() => normalizeOpenTuiTheme(renderer.themeMode));
  useEffect(() => {
    if (process.env["EMAILS_TUI_DISABLE_THEME_PROBE"] === "1") return;
    let alive = true;
    void renderer.waitForThemeMode(250).then((next) => {
      const normalized = normalizeOpenTuiTheme(next);
      if (alive) setMode((prev) => prev === normalized ? prev : normalized);
    });
    const onTheme = (next: OpenTuiThemeMode) => {
      const normalized = normalizeOpenTuiTheme(next);
      setMode((prev) => prev === normalized ? prev : normalized);
    };
    renderer.on("theme_mode", onTheme);
    return () => {
      alive = false;
      renderer.off("theme_mode", onTheme);
    };
  }, [renderer]);
  return mode;
}

export interface AppProps {
  initialMailbox?: Mailbox;
}

export function App({ initialMailbox }: AppProps) {
  const renderer = useRenderer();
  const dims = useTerminalDimensions();
  const cols = Math.max(40, dims.width);
  const rows = Math.max(16, dims.height);
  const lastInputAt = useRef(0);
  const backgroundBusy = useRef(false);
  const initialChoices = useMemo(() => listInboxAddresses(), []);
  const [addresses, setAddresses] = useState<InboxAddressChoice[]>(initialChoices.length ? initialChoices : [ALL_ADDRESSES]);
  const initialModel = useMemo<Model>(() => {
    const settings = getSettings();
    const mailbox = initialMailbox ?? settings.defaultMailbox;
    const configuredChoice = addressChoiceByAddress(settings.defaultAddress);
    const choices = initialChoices.length ? initialChoices : [ALL_ADDRESSES];
    const configuredIndex = choices.findIndex((choice) => choice.id === configuredChoice.id);
    const addressIdx = Math.max(0, configuredIndex);
    const choice = choices[addressIdx] ?? ALL_ADDRESSES;
    const loaded = loadMailbox(mailbox, "", choice);
    return {
      mailbox,
      addressIdx,
      homeIdx: 0,
      addressPickerIdx: addressIdx,
      addressSearch: "",
      commandIdx: 0,
      settingsIdx: 0,
      commandSearch: "",
      commandReturnTo: initialMailbox ? "list" : "home",
      dialog: null,
      page: 0,
      sort: "newest",
      selectedId: loaded.messages[0]?.id ?? null,
      view: initialMailbox ? "list" : "home",
      searchActive: false,
      search: "",
      readerScroll: 0,
      compose: null,
      settings,
      status: { text: "", tone: "info" },
      now: Date.now(),
      ...loaded,
    };
  }, [initialChoices, initialMailbox]);
  const [state, dispatch] = useReducer(reducer, initialModel);

  const address = addresses[state.addressIdx] ?? addresses[0] ?? ALL_ADDRESSES;
  const addressKey = `${address.id}:${address.address ?? ""}`;
  const detectedTheme = useOpenTuiThemeMode();
  const theme = useMemo(() => resolveTheme(state.settings.theme, process.env, detectedTheme), [detectedTheme, state.settings.theme]);
  const sel = selectedIndex(state.messages, state.selectedId);
  const selectedMsg = state.messages[sel] ?? null;
  const systemStatus = useMemo(
    () => getEmailSystemStatus(),
    [addresses.length, state.counts.inbox, state.counts.unread, state.messages.length, state.now],
  );

  useEffect(() => {
    renderer.setBackgroundColor(theme.background);
  }, [renderer, theme.background]);

  const flash = useCallback((text: string, tone: Status["tone"] = "info") => {
    dispatch({ type: "flash", status: { text, tone } });
  }, []);

  const reload = useCallback((preserveSelection = true, opts?: { refreshAddresses?: boolean }) => {
    const nextAddresses = opts?.refreshAddresses ? listInboxAddresses() : addresses;
    const normalized = nextAddresses.length ? nextAddresses : [ALL_ADDRESSES];
    if (opts?.refreshAddresses) setAddresses((prev) => (sameAddressChoices(prev, normalized) ? prev : normalized));

    const nextAddress =
      normalized.find((a) => a.id === address.id) ??
      normalized[state.addressIdx] ??
      normalized[0] ??
      ALL_ADDRESSES;
    const nextIndex = Math.max(0, normalized.findIndex((a) => a.id === nextAddress.id));
    if (nextIndex !== state.addressIdx) dispatch({ type: "syncAddressIndex", index: nextIndex });
    dispatch({ type: "hydrate", loaded: loadMailbox(state.mailbox, state.search, nextAddress, state.page, state.sort), preserveSelection });
  }, [address.id, addresses, state.addressIdx, state.mailbox, state.page, state.search, state.sort]);

  useEffect(() => {
    dispatch({ type: "clampAddresses", count: addresses.length });
  }, [addresses.length]);

  useEffect(() => {
    reload(false);
  }, [state.mailbox, state.page, state.search, state.sort, addressKey, reload]);

  useEffect(() => {
    const t = setInterval(() => {
      dispatch({ type: "tick", now: Date.now() });
    }, CLOCK_TICK_MS);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const threshold = Number.parseInt(process.env["EMAILS_TUI_WATCHDOG_THRESHOLD_MS"] ?? "5000", 10);
    return startEventLoopWatchdog({ thresholdMs: Number.isFinite(threshold) ? threshold : 5000 });
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      if (Date.now() - lastInputAt.current < USER_IDLE_MS) return;
      reload(true, { refreshAddresses: true });
    }, LOCAL_RELOAD_MS);
    return () => clearInterval(t);
  }, [reload]);

  useEffect(() => {
    if (!state.status.text) return;
    const t = setTimeout(() => dispatch({ type: "clearStatus", text: state.status.text }), STATUS_MS);
    return () => clearTimeout(t);
  }, [state.status.text]);

  useEffect(() => {
    if (!state.settings.autoPull) return;
    let alive = true;

    const pull = async (gmail: boolean) => {
      if (backgroundBusy.current) return;
      if (Date.now() - lastInputAt.current < USER_IDLE_MS) return;
      backgroundBusy.current = true;
      try {
        const result = await autoPull(gmail ? { s3: false, gmail: true } : undefined).catch((e) => ({
          ok: false,
          pulled: 0,
          configured: false,
          reason: e instanceof Error ? e.message : String(e),
        }));
        if (!alive) return;
        if (result.pulled > 0) {
          flash(`pulled ${result.pulled} new`, "ok");
          reload(true, { refreshAddresses: true });
        } else if (!result.ok && result.reason && !/credential|profile|not configured|region|access key|connector|auth/i.test(result.reason)) {
          flash(`pull: ${result.reason.slice(0, 42)}`, "err");
        }
      } finally {
        backgroundBusy.current = false;
      }
    };

    const firstPull = setTimeout(() => { void pull(false); }, AUTOPULL_START_DELAY_MS);
    const s3 = setInterval(() => { void pull(false); }, PULL_MS);
    const gmail = state.settings.gmailAutoPull ? setInterval(() => { void pull(true); }, GMAIL_PULL_MS) : null;
    return () => {
      alive = false;
      clearTimeout(firstPull);
      clearInterval(s3);
      if (gmail) clearInterval(gmail);
    };
  }, [flash, reload, state.settings.autoPull, state.settings.gmailAutoPull]);

  const runPullNow = useCallback(() => {
    if (backgroundBusy.current) {
      flash("pull already running");
      return;
    }
    backgroundBusy.current = true;
    flash("pulling");
    void autoPull({ limit: 1000 })
      .then((r) => {
        reload(true, { refreshAddresses: true });
        flash(r.pulled ? `pulled ${r.pulled} new` : `up to date: ${address.label}`, "ok");
      })
      .catch((e) => {
        reload(true);
        flash(e instanceof Error ? e.message.slice(0, 64) : String(e).slice(0, 64), "err");
      })
      .finally(() => {
        backgroundBusy.current = false;
      });
  }, [address.label, flash, reload]);

  const readerBody = useMemo(
    () => (state.view === "reader" && selectedMsg ? getMessageBody(selectedMsg) : null),
    [selectedMsg, state.view],
  );
  const conversation = useMemo(
    () => (state.view === "reader" && selectedMsg ? getConversation(selectedMsg) : []),
    [selectedMsg, state.view],
  );

  const startCompose = useCallback((replyTo?: TuiMessage) => {
    const compose: ComposeState = replyTo
      ? { ...replyDefaults(replyTo), body: "", field: "body", returnTo: state.view, replyTo }
      : {
        from: state.settings.defaultFrom ?? (address.configured ? address.address : undefined) ?? defaultFromAddress({ fallback: firstAddress(selectedMsg?.to) }),
        to: "",
        subject: "",
        body: "",
        field: "to",
        returnTo: state.view,
      };
    dispatch({ type: "composeStart", compose });
  }, [address.address, address.configured, selectedMsg?.to, state.settings.defaultFrom, state.view]);

  const openSelected = useCallback(() => {
    if (!selectedMsg) return;
    markRead(selectedMsg);
    dispatch({ type: "reader", scroll: 0 });
    reload(true);
  }, [reload, selectedMsg]);

  const openMessage = useCallback((message: TuiMessage) => {
    markRead(message);
    dispatch({ type: "selectId", id: message.id });
    dispatch({ type: "reader", scroll: 0 });
    reload(true);
  }, [reload]);

  const mutateSelected = useCallback((kind: "star" | "read" | "archive") => {
    if (!selectedMsg || selectedMsg.kind !== "inbound") return;
    if (kind === "star") {
      flash(toggleStar(selectedMsg) ? "starred" : "unstarred", "ok");
    } else if (kind === "read") {
      flash(toggleRead(selectedMsg) ? "read" : "unread", "ok");
    } else {
      const archived = state.mailbox !== "archived";
      archiveMessage(selectedMsg, archived);
      flash(archived ? "archived" : "unarchived", "ok");
      dispatch({ type: "view", view: "list" });
    }
    reload(true);
  }, [flash, reload, selectedMsg, state.mailbox]);

  const sendDraft = useCallback(async () => {
    const draft = state.compose;
    if (!draft) return;
    flash("sending");
    try {
      await sendComposed({
        from: draft.from,
        to: draft.to,
        subject: draft.subject,
        body: draft.body,
      });
      dispatch({ type: "composeCancel" });
      flash("sent", "ok");
      reload(false, { refreshAddresses: true });
    } catch (e) {
      flash((e instanceof Error ? e.message : String(e)).slice(0, 64), "err");
    }
  }, [flash, reload, state.compose]);

  const toggleSetting = useCallback((key: "autoPull" | "gmailAutoPull" | "dimRead") => {
    const next = !state.settings[key];
    setSetting(key, next);
    dispatch({ type: "settingsPatch", patch: { [key]: next } });
    flash(`${key}: ${next ? "on" : "off"}`, "ok");
  }, [flash, state.settings]);

  const setDefaultMailbox = useCallback((mailbox: Mailbox) => {
    setSetting("defaultMailbox", mailbox);
    dispatch({ type: "settingsPatch", patch: { defaultMailbox: mailbox } });
    flash(`default folder: ${mailboxLabel(mailbox)}`, "ok");
  }, [flash]);

  const cycleDefaultAddress = useCallback(() => {
    const current = addressChoiceByAddress(state.settings.defaultAddress);
    const i = addresses.findIndex((choice) => choice.id === current.id);
    const next = addresses[(i + 1 + addresses.length) % addresses.length] ?? ALL_ADDRESSES;
    const value = next.address ?? null;
    setSetting("defaultAddress", value);
    dispatch({ type: "settingsPatch", patch: { defaultAddress: value } });
    flash(`default inbox: ${next.label}`, "ok");
  }, [addresses, flash, state.settings.defaultAddress]);

  const cycleDefaultFrom = useCallback(() => {
    const senders = addresses.filter((choice) => choice.address && choice.configured);
    if (senders.length === 0) {
      setSetting("defaultFrom", null);
      dispatch({ type: "settingsPatch", patch: { defaultFrom: null } });
      flash("default from: auto", "ok");
      return;
    }
    const currentIdx = state.settings.defaultFrom
      ? senders.findIndex((choice) => choice.address === state.settings.defaultFrom)
      : -1;
    const next = currentIdx < 0 ? senders[0] : senders[currentIdx + 1];
    const value = next?.address ?? null;
    setSetting("defaultFrom", value);
    dispatch({ type: "settingsPatch", patch: { defaultFrom: value } });
    flash(`default from: ${value ?? "auto"}`, "ok");
  }, [addresses, flash, state.settings.defaultFrom]);

  const cycleTheme = useCallback(() => {
    const next = nextThemeMode(state.settings.theme);
    setSetting("theme", next);
    dispatch({ type: "settingsPatch", patch: { theme: next } });
    flash(`theme: ${next}`, "ok");
  }, [flash, state.settings.theme]);

  const editSetting = useCallback((index: number) => {
    if (index === 0) toggleSetting("autoPull");
    else if (index === 1) toggleSetting("gmailAutoPull");
    else if (index === 2) toggleSetting("dimRead");
    else if (index === 3) {
      const i = MAILBOXES.indexOf(state.settings.defaultMailbox);
      setDefaultMailbox(MAILBOXES[(i + 1) % MAILBOXES.length]!);
    } else if (index === 4) cycleDefaultAddress();
    else if (index === 5) cycleDefaultFrom();
    else if (index === 6) cycleTheme();
  }, [cycleDefaultAddress, cycleDefaultFrom, cycleTheme, setDefaultMailbox, state.settings.defaultMailbox, toggleSetting]);

  const openHomeSelection = useCallback(() => {
    const item = HOME_ITEMS[state.homeIdx];
    if (item === "Inbox") {
      dispatch({ type: "openInbox" });
    } else if (item === "Compose") {
      startCompose();
    } else if (item === "Domains") {
      dispatch({ type: "view", view: "domains" });
    } else if (item === "Profiles") {
      dispatch({ type: "view", view: "profiles" });
    } else {
      dispatch({ type: "openSettingsDialog" });
    }
  }, [startCompose, state.homeIdx]);

  const executePaletteAction = useCallback((action: PaletteAction) => {
    dispatch({ type: "closeCommandPalette" });
    if (action === "inbox") dispatch({ type: "openInbox" });
    else if (action === "compose") startCompose();
    else if (action === "domains") dispatch({ type: "view", view: "domains" });
    else if (action === "profiles") dispatch({ type: "view", view: "profiles" });
    else if (action === "settings") dispatch({ type: "openSettingsDialog" });
    else if (action === "address") dispatch({ type: "openAddressPicker" });
    else if (action === "refresh") {
      reload(true, { refreshAddresses: true });
      flash(`refreshed ${address.label}`, "ok");
    } else if (action === "pull") {
      runPullNow();
    } else if (action === "search") {
      dispatch({ type: "view", view: "list" });
      dispatch({ type: "searchStart" });
    } else if (action === "unread") {
      dispatch({ type: "setMailbox", mailbox: "unread" });
    } else if (action === "sent") {
      dispatch({ type: "setMailbox", mailbox: "sent" });
    } else if (action === "archived") {
      dispatch({ type: "setMailbox", mailbox: "archived" });
    }
  }, [address.label, flash, reload, runPullNow, startCompose]);

  useKeyboard((event) => {
    const input = printableInput(event);
    const key = keyFlags(event);
    lastInputAt.current = Date.now();
    if (event.ctrl && input === "c") {
      renderer.destroy();
      return;
    }

    if (state.dialog === "commands") {
      const commands = filteredCommands(state.commandSearch);
      if (key.escape || (!state.commandSearch && (input === "q" || input === "b"))) { dispatch({ type: "closeCommandPalette" }); return; }
      if (key.upArrow || input === "k") dispatch({ type: "selectCommandOffset", delta: -1, count: commands.length });
      else if (key.downArrow || input === "j") dispatch({ type: "selectCommandOffset", delta: 1, count: commands.length });
      else if (key.return) {
        const command = commands[Math.min(state.commandIdx, Math.max(0, commands.length - 1))];
        if (command) executePaletteAction(command.action);
      } else if (key.backspace || key.delete) {
        dispatch({ type: "commandBackspace" });
      } else if (input && !key.ctrl) {
        dispatch({ type: "commandAppend", text: input });
      }
      return;
    }

    if (state.dialog === "addressPicker") {
      const choices = filteredAddressChoices(addresses, state.addressSearch);
      if (key.escape) { dispatch({ type: "closeDialog" }); return; }
      if (!state.addressSearch && (input === "q" || input === "b")) { dispatch({ type: "closeDialog" }); return; }
      if (key.backspace || key.delete) dispatch({ type: "addressSearchBackspace" });
      else if (key.upArrow || input === "k") dispatch({ type: "selectAddressPickerOffset", delta: -1, count: choices.length });
      else if (key.downArrow || input === "j") dispatch({ type: "selectAddressPickerOffset", delta: 1, count: choices.length });
      else if (key.return || key.rightArrow) {
        const choice = choices[Math.min(state.addressPickerIdx, Math.max(0, choices.length - 1))];
        if (!choice) return;
        const index = Math.max(0, addresses.findIndex((candidate) => candidate.id === choice.id));
        dispatch({ type: "setAddress", index });
        const next = addresses[index] ?? ALL_ADDRESSES;
        flash(`inbox: ${next.label}`, "ok");
      } else if (input && !key.ctrl) {
        dispatch({ type: "addressSearchAppend", text: input });
      }
      return;
    }

    if (state.dialog === "settings") {
      if (input === "q" || input === "b" || input === "," || key.escape) { dispatch({ type: "closeDialog" }); return; }
      if (key.upArrow || input === "k") dispatch({ type: "selectSettingsOffset", delta: -1, count: SETTINGS_ROW_COUNT });
      else if (key.downArrow || input === "j") dispatch({ type: "selectSettingsOffset", delta: 1, count: SETTINGS_ROW_COUNT });
      else if (input >= "1" && input <= "7") {
        const index = Number(input) - 1;
        dispatch({ type: "selectSettingsOffset", delta: index - state.settingsIdx, count: SETTINGS_ROW_COUNT });
        editSetting(index);
      } else if (key.return || key.rightArrow || input === "l") {
        editSetting(state.settingsIdx);
      }
      return;
    }

    if (state.view === "compose" && state.compose) {
      handleComposeInput(input, key, dispatch, sendDraft, flash);
      return;
    }

    if (state.searchActive) {
      handleSearchInput(input, key, dispatch);
      return;
    }

    if ((event.ctrl && input === "k") || input === ":") {
      dispatch({ type: "openCommandPalette", returnTo: state.view });
      return;
    }

    if (state.view === "home") {
      if (input === "q") { renderer.destroy(); return; }
      if (key.upArrow || input === "k") dispatch({ type: "selectHomeOffset", delta: -1 });
      else if (key.downArrow || input === "j") dispatch({ type: "selectHomeOffset", delta: 1 });
      else if (key.return || key.rightArrow || input === "l") openHomeSelection();
      else if (input === "1") dispatch({ type: "openInbox" });
      else if (input === "2") startCompose();
      else if (input === "3") dispatch({ type: "view", view: "domains" });
      else if (input === "4") dispatch({ type: "view", view: "profiles" });
      else if (input === "5") dispatch({ type: "openSettingsDialog" });
      return;
    }

    if (state.view === "profiles") {
      if (input === "q" || input === "b" || input === "p" || key.escape) dispatch({ type: "view", view: "home" });
      return;
    }

    if (state.view === "domains") {
      if (input === "q" || input === "b" || input === "d" || key.escape) dispatch({ type: "view", view: "home" });
      return;
    }

    if (input === "q" || input === "b" || key.escape) {
      if (state.view === "reader") dispatch({ type: "view", view: "list" });
      else dispatch({ type: "view", view: "home" });
      return;
    }
    if (input === "c") { startCompose(); return; }
    if (input === "d") { dispatch({ type: "view", view: "domains" }); return; }
    if (input === "p") { dispatch({ type: "view", view: "profiles" }); return; }
    if (input === ",") { dispatch({ type: "openSettingsDialog" }); return; }
    if (input === "a") { dispatch({ type: "openAddressPicker" }); return; }
    if (input === "g") {
      flash("refreshing");
      reload(true, { refreshAddresses: true });
      flash(`refreshed ${address.label}`, "ok");
      return;
    }
    if (input === "G") {
      runPullNow();
      return;
    }

    if (state.view === "reader") {
      if (key.upArrow || input === "k") dispatch({ type: "scroll", delta: -1 });
      else if (key.downArrow || input === "j") dispatch({ type: "scroll", delta: 1 });
      else if (key.leftArrow || input === "h") dispatch({ type: "view", view: "list" });
      else if (input === "J") { dispatch({ type: "selectOffset", delta: 1 }); dispatch({ type: "reader", scroll: 0 }); }
      else if (input === "K") { dispatch({ type: "selectOffset", delta: -1 }); dispatch({ type: "reader", scroll: 0 }); }
      else if (input === "r" && selectedMsg) startCompose(selectedMsg);
      else if (input === "s") mutateSelected("star");
      else if (input === "e") mutateSelected("archive");
      else if (input === "u") mutateSelected("read");
      return;
    }

    if (key.upArrow || input === "k") dispatch({ type: "selectOffset", delta: -1 });
    else if (key.downArrow || input === "j") dispatch({ type: "selectOffset", delta: 1 });
    else if (key.return || key.rightArrow || input === "l") openSelected();
    else if (key.tab || input === "]") dispatch({ type: "cycleMailbox", delta: 1 });
    else if (input === "[") dispatch({ type: "cycleMailbox", delta: -1 });
    else if (input === "o") dispatch({ type: "cycleSort" });
    else if (input === "n" || input === ">") dispatch({ type: "pageOffset", delta: 1 });
    else if (input === "N" || input === "<") dispatch({ type: "pageOffset", delta: -1 });
    else if (input === "1") dispatch({ type: "openInbox" });
    else if (input >= "2" && input <= "5") dispatch({ type: "setMailbox", mailbox: MAILBOXES[Number(input) - 1]! });
    else if (input === "s") mutateSelected("star");
    else if (input === "e") mutateSelected("archive");
    else if (input === "u") mutateSelected("read");
    else if (input === "r" && selectedMsg) startCompose(selectedMsg);
    else if (input === "/") dispatch({ type: "searchStart" });
  });

  const isDashboard = cols >= 104 && rows >= 20;
  const topBar = renderTopBar({ state, address, cols, theme });
  const footer = footerLine(state.view, state.dialog, state.searchActive, theme);
  const bodyH = Math.max(6, rows - 2);
  const sidebarW = isDashboard ? Math.min(34, Math.max(28, Math.floor(cols * 0.24))) : 0;
  const sidebarContentW = Math.max(1, sidebarW - 4);
  const workspaceW = isDashboard ? Math.max(36, cols - sidebarW - 5) : Math.max(24, cols - 4);
  const contentH = Math.max(4, bodyH - 2);
  const contentArgs: RenderContentArgs = {
    state,
    addresses,
    address,
    selectedIndex: sel,
    selectedMsg,
    readerBody,
    conversation,
    systemStatus,
    width: workspaceW,
    height: contentH,
    theme,
  };
  const contentLines = renderWorkspace(contentArgs);
  const openHomeItem = (index: number) => {
    const item = HOME_ITEMS[index];
    if (item === "Inbox") dispatch({ type: "openInbox" });
    else if (item === "Compose") startCompose();
    else if (item === "Domains") dispatch({ type: "view", view: "domains" });
    else if (item === "Profiles") dispatch({ type: "view", view: "profiles" });
    else if (item === "Settings") dispatch({ type: "openSettingsDialog" });
  };
  const applyAddressChoice = (choice: InboxAddressChoice) => {
    const index = Math.max(0, addresses.findIndex((candidate) => candidate.id === choice.id));
    dispatch({ type: "setAddress", index });
    const next = addresses[index] ?? ALL_ADDRESSES;
    flash(`inbox: ${next.label}`, "ok");
  };
  const refreshNow = () => {
    flash("refreshing");
    reload(true, { refreshAddresses: true });
    flash(`refreshed ${address.label}`, "ok");
  };
  const sidebarItems = renderSidebarItems({
    state,
    address,
    width: sidebarContentW,
    height: contentH,
    theme,
    onCompose: () => startCompose(),
    onDomains: () => dispatch({ type: "view", view: "domains" }),
    onProfiles: () => dispatch({ type: "view", view: "profiles" }),
    onSettings: () => dispatch({ type: "openSettingsDialog" }),
    onCommands: () => dispatch({ type: "openCommandPalette", returnTo: state.view }),
    onMailbox: (mailbox) => dispatch(mailbox === "inbox" ? { type: "openInbox" } : { type: "setMailbox", mailbox }),
    onAddress: () => dispatch({ type: "openAddressPicker" }),
    onSort: () => dispatch({ type: "cycleSort" }),
    onNextPage: () => dispatch({ type: "pageOffset", delta: 1 }),
    onPrevPage: () => dispatch({ type: "pageOffset", delta: -1 }),
    onRefresh: refreshNow,
    onPull: runPullNow,
  });
  const addressDialogChoices = filteredAddressChoices(addresses, state.addressSearch);
  const contentActions = workspaceLineActions({
    state,
    width: workspaceW,
    height: contentH,
    selectedIndex: sel,
    onHomeItem: openHomeItem,
    onMessage: openMessage,
    onComposeField: (field) => dispatch({ type: "composeFocusField", field }),
  });
  const compactLines = [
    compactNavLine({ state, address, width: workspaceW, theme }),
    ...contentLines,
  ];
  const compactActions = [undefined, ...contentActions];

  const onWorkspaceScroll = (event: MouseEvent) => {
    if (event.button === MouseButton.WHEEL_UP) {
      if (state.view === "reader") dispatch({ type: "scroll", delta: -2 });
      else if (state.view === "list") dispatch({ type: "selectOffset", delta: -2 });
      event.stopPropagation();
    } else if (event.button === MouseButton.WHEEL_DOWN) {
      if (state.view === "reader") dispatch({ type: "scroll", delta: 2 });
      else if (state.view === "list") dispatch({ type: "selectOffset", delta: 2 });
      event.stopPropagation();
    }
  };

  return (
    <box width={cols} height={rows} flexDirection="column" backgroundColor={theme.background}>
      <FrameText line={topBar} width={cols} />
      {isDashboard ? (
        <box width="100%" flexGrow={1} flexDirection="row" columnGap={1} paddingX={1} backgroundColor={theme.background}>
          <box
            width={sidebarW}
            height="100%"
            flexDirection="column"
            border
            borderStyle="rounded"
            borderColor={theme.border}
            paddingX={1}
            backgroundColor={theme.sidebarBg}
            title=" emails "
          >
            {sidebarItems.slice(0, contentH).map((item, i) => (
              <ActionFrameText key={`sidebar-${i}`} item={item} width={sidebarContentW} />
            ))}
          </box>
          <box
            flexGrow={1}
            height="100%"
            flexDirection="column"
            border
            borderStyle="rounded"
            borderColor={theme.border}
            paddingX={1}
            backgroundColor={theme.panel}
            title={workspacePanelTitle(state)}
            onMouseScroll={onWorkspaceScroll}
          >
            {contentLines.slice(0, contentH).map((line, i) => (
              <ActionFrameText key={`content-${i}`} item={{ line, onPress: contentActions[i] }} width={workspaceW} />
            ))}
          </box>
        </box>
      ) : (
        <box
          width="100%"
          flexGrow={1}
          flexDirection="column"
          border
          borderStyle="rounded"
          borderColor={theme.border}
          paddingX={1}
          backgroundColor={theme.panel}
          title={workspacePanelTitle(state)}
          onMouseScroll={onWorkspaceScroll}
        >
          {compactLines.slice(0, contentH).map((line, i) => (
            <ActionFrameText key={`content-${i}`} item={{ line, onPress: compactActions[i] }} width={workspaceW} />
          ))}
        </box>
      )}
      <DialogLayer
        state={state}
        addresses={addresses}
        addressChoices={addressDialogChoices}
        cols={cols}
        rows={rows}
        theme={theme}
        onClose={() => dispatch({ type: "closeDialog" })}
        onCommandMove={(delta, count) => dispatch({ type: "selectCommandOffset", delta, count })}
        onCommandSelect={executePaletteAction}
        onAddressMove={(delta, count) => dispatch({ type: "selectAddressPickerOffset", delta, count })}
        onAddressSelect={applyAddressChoice}
        onSettingsMove={(delta) => dispatch({ type: "selectSettingsOffset", delta, count: SETTINGS_ROW_COUNT })}
        onSettingsSelect={editSetting}
      />
      <FrameText line={footer} width={cols} />
    </box>
  );
}

interface KeyFlags {
  return?: boolean;
  escape?: boolean;
  tab?: boolean;
  shift?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
}

function printableInput(key: KeyEvent): string {
  if (key.ctrl) return key.name.length === 1 ? key.name.toLowerCase() : "";
  if (key.sequence && key.sequence.length === 1 && key.sequence >= " " && key.sequence !== "\x7f") return key.sequence;
  if (key.raw && key.raw.length === 1 && key.raw >= " " && key.raw !== "\x7f") return key.raw;
  if (key.name.length === 1) return key.shift ? key.name.toUpperCase() : key.name;
  return "";
}

function keyFlags(key: KeyEvent): KeyFlags {
  const name = key.name.toLowerCase();
  const sequence = key.sequence || key.raw;
  return {
    return: name === "enter" || name === "return" || sequence === "\r" || sequence === "\n",
    escape: name === "escape" || name === "esc" || /^\u001B+$/.test(sequence),
    tab: name === "tab" || sequence === "\t",
    shift: key.shift,
    backspace: name === "backspace" || sequence === "\b" || sequence === "\x7f",
    delete: name === "delete" || sequence === "\u001B[3~",
    ctrl: key.ctrl,
    upArrow: name === "up" || name === "arrowup" || sequence === "\u001B[A",
    downArrow: name === "down" || name === "arrowdown" || sequence === "\u001B[B",
    leftArrow: name === "left" || name === "arrowleft" || sequence === "\u001B[D",
    rightArrow: name === "right" || name === "arrowright" || sequence === "\u001B[C",
  };
}

function handleSearchInput(
  input: string,
  key: KeyFlags,
  dispatch: (action: Action) => void,
) {
  if (key.escape) { dispatch({ type: "searchClear" }); return; }
  if (key.return) { dispatch({ type: "searchStop" }); return; }
  if (key.backspace || key.delete) { dispatch({ type: "searchBackspace" }); return; }
  if (input) dispatch({ type: "searchAppend", text: input });
}

function handleComposeInput(
  input: string,
  key: KeyFlags,
  dispatch: (action: Action) => void,
  sendDraft: () => Promise<void>,
  flash: (text: string, tone?: Status["tone"]) => void,
) {
  if (key.escape) {
    dispatch({ type: "composeCancel" });
    flash("compose cancelled");
    return;
  }
  if ((key.ctrl && input === "s") || input === "\u0013") {
    void sendDraft();
    return;
  }

  if (key.tab) {
    dispatch({ type: "composeCycleField", delta: key.shift ? -1 : 1 });
    return;
  }
  if (key.backspace || key.delete) {
    dispatch({ type: "composeBackspace" });
    return;
  }
  if (key.return) {
    dispatch({ type: "composeEnter" });
    return;
  }
  if (input && !key.ctrl) {
    dispatch({ type: "composeText", text: input });
  }
}

function line(text: string, theme: TuiTheme, opts?: Partial<FrameLine>): FrameLine {
  return { text: text || " ", fg: theme.primary, ...opts };
}

function fitLine(left: string, right: string, width: number): string {
  if (!right) return truncate(left, width);
  const gap = Math.max(1, width - left.length - right.length);
  return truncate(`${left}${" ".repeat(gap)}${right}`, width);
}

function formatCount(count: number): string {
  const rounded = Math.max(0, Math.trunc(count));
  return rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fitSidebarCount(left: string, count: number, width: number): string {
  const right = formatCount(count);
  const countW = Math.min(right.length, Math.max(3, Math.floor(width * 0.36)));
  const leftW = Math.max(1, width - countW - 2);
  return `${truncate(left, leftW).padEnd(leftW)}  ${truncate(right, countW).padStart(countW)}`;
}

function renderTopBar({ state, address, cols, theme }: {
  state: Model;
  address: InboxAddressChoice;
  cols: number;
  theme: TuiTheme;
}): FrameLine {
  const statusColor = state.status.tone === "ok" ? theme.ok : state.status.tone === "err" ? theme.error : theme.warning;
  const left = ` emails ui  ${workspaceTitle(state, address)}`;
  const right = state.status.text || `${formatCount(state.counts.unread)} unread  ${state.settings.theme}/${theme.name}`;
  return line(fitLine(left, right, cols), theme, {
    fg: state.status.text ? statusColor : theme.activeFg,
    bg: theme.headerBg,
    bold: true,
  });
}

function renderWorkspace(args: RenderContentArgs): FrameLine[] {
  const { state, address, theme } = args;
  const rows = [
    line(workspaceTitle(state, address), theme, { fg: theme.accentStrong, bold: true }),
    line(workspaceSubtitle(args), theme, { fg: theme.muted }),
    line(" ", theme),
  ];
  return [...rows, ...renderContent(args)];
}

function renderContent(args: RenderContentArgs): FrameLine[] {
  const { state } = args;
  if (state.view === "home") return renderHome(args);
  if (state.view === "compose" && state.compose) return renderCompose({ compose: state.compose, width: args.width, height: args.height, theme: args.theme });
  if (state.view === "domains") return renderDomains({ width: args.width, height: args.height, theme: args.theme });
  if (state.view === "profiles") return renderProfiles({ width: args.width, height: args.height, theme: args.theme });
  if (state.view === "reader") return renderReader({ body: args.readerBody, conversation: args.conversation, scroll: state.readerScroll, width: args.width, height: args.height, theme: args.theme });
  return renderList(args);
}

function workspaceLineActions({ state, width, height, selectedIndex: sel, onHomeItem, onMessage, onComposeField }: {
  state: Model;
  width: number;
  height: number;
  selectedIndex: number;
  onHomeItem: (index: number) => void;
  onMessage: (message: TuiMessage) => void;
  onComposeField: (field: ComposeField) => void;
}): Array<(() => void) | undefined> {
  const actions: Array<(() => void) | undefined> = [];
  const workspacePrefix = 3;

  if (state.view === "home") {
    const metricRows = width >= 72 ? 2 : 4;
    const firstHomeItem = workspacePrefix + metricRows + 2;
    HOME_ITEMS.forEach((_, index) => {
      actions[firstHomeItem + index] = () => onHomeItem(index);
    });
    return actions;
  }

  if (state.view === "compose" && state.compose) {
    const firstField = workspacePrefix + 1;
    actions[firstField] = () => onComposeField("from");
    actions[firstField + 1] = () => onComposeField("to");
    actions[firstField + 2] = () => onComposeField("subject");
    for (let i = firstField + 4; i < height; i++) actions[i] = () => onComposeField("body");
    return actions;
  }

  if (state.view !== "list" || state.messages.length === 0) return actions;

  const prefixRows = state.searchActive ? 1 : 0;
  const rowH = Math.max(1, height - prefixRows);
  const start = Math.max(0, Math.min(sel - Math.floor(rowH / 2), Math.max(0, state.messages.length - rowH)));
  const firstMessageRow = workspacePrefix + prefixRows;
  const visible = Math.min(rowH, state.messages.length - start);
  for (let offset = 0; offset < visible; offset++) {
    const message = state.messages[start + offset];
    if (!message) continue;
    actions[firstMessageRow + offset] = () => onMessage(message);
  }
  return actions;
}

function workspacePanelTitle(state: Model): string {
  return ` ${state.view === "home" ? "dashboard" : state.view === "list" ? mailboxLabel(state.mailbox).toLowerCase() : state.view} `;
}

function workspaceTitle(state: Model, address: InboxAddressChoice): string {
  if (state.view === "home") return "Dashboard";
  if (state.view === "list") return `${mailboxLabel(state.mailbox)}: ${address.label}`;
  if (state.view === "reader") return "Message reader";
  if (state.view === "compose") return state.compose?.replyTo ? "Reply" : "Compose";
  if (state.view === "domains") return "Domains";
  return "Profiles";
}

function workspaceSubtitle({ state, address, width }: RenderContentArgs): string {
  if (state.view === "home") return truncate("Home · Inbox · Compose · Domains · Profiles · Settings", width);
  if (state.view === "list") {
    const shown = `${formatCount(state.messages.length)} shown`;
    const page = `page ${state.page + 1}${state.hasMore ? "+" : ""}`;
    const sort = state.sort === "newest" ? "newest first" : "oldest first";
    const counts = `${formatCount(state.counts.inbox)} inbox · ${formatCount(state.counts.unread)} unread · ${formatCount(state.counts.sent)} sent`;
    const action = address.address ? "a changes address" : "a chooses address";
    return truncate(`${shown} · ${page} · ${sort} · ${counts} · ${action}`, width);
  }
  if (state.view === "compose") return truncate("Editable From, To, Subject, and markdown Body · Ctrl-S sends", width);
  if (state.view === "domains") return truncate("Configured domains with address, inbox, unread, sent, and total email counts", width);
  if (state.view === "profiles") return truncate("Configured accounts with their domains and addresses", width);
  return truncate("b returns to Inbox · r replies · s stars · e archives", width);
}

function compactNavLine({ state, address, width, theme }: {
  state: Model;
  address: InboxAddressChoice;
  width: number;
  theme: TuiTheme;
}): FrameLine {
  const nav = `1 Inbox  2 Compose  3 Domains  4 Profiles  5 Settings  ·  ${workspaceTitle(state, address)}`;
  return line(truncate(nav, width), theme, { fg: theme.sourceFg, bg: theme.sourceBg, bold: true });
}

function renderSidebarItems({ state, address, width, height, theme, onCompose, onDomains, onProfiles, onSettings, onCommands, onMailbox, onAddress, onSort, onNextPage, onPrevPage, onRefresh, onPull }: {
  state: Model;
  address: InboxAddressChoice;
  width: number;
  height: number;
  theme: TuiTheme;
  onCompose: () => void;
  onDomains: () => void;
  onProfiles: () => void;
  onSettings: () => void;
  onCommands: () => void;
  onMailbox: (mailbox: Mailbox) => void;
  onAddress: () => void;
  onSort: () => void;
  onNextPage: () => void;
  onPrevPage: () => void;
  onRefresh: () => void;
  onPull: () => void;
}): ActionLine[] {
  const rows: ActionLine[] = [];
  const push = (frameLine: FrameLine, onPress?: () => void) => rows.push({ line: frameLine, onPress });
  const section = (labelText: string) => push(line(labelText.toUpperCase(), theme, { fg: theme.sidebarMuted, bg: theme.sidebarBg, bold: true }));
  const nav = (labelText: string, active: boolean, keyChar: string, onPress: () => void) => push(line(`${keyChar}  ${truncate(labelText, width - 4)}`, theme, {
    fg: active ? theme.selectedFg : theme.sidebarFg,
    bg: active ? theme.selectedBg : theme.sidebarBg,
    bold: active,
  }), onPress);
  push(line("Mailbox", theme, { fg: theme.sidebarFg, bg: theme.sidebarBg, bold: true }));
  push(line(truncate(address.label, width), theme, { fg: theme.sidebarMuted, bg: theme.sidebarBg }), onAddress);
  push(line(" ", theme, { bg: theme.sidebarBg }));
  section("Mail");
  for (const [i, mailbox] of MAILBOXES.entries()) {
    const active = state.mailbox === mailbox && state.view !== "home" && state.view !== "compose" && state.view !== "domains" && state.view !== "profiles";
    const labelText = `${i + 1}  ${mailboxLabel(mailbox)}`;
    push(line(fitSidebarCount(labelText, state.counts[mailbox], width), theme, {
      fg: active ? theme.selectedFg : theme.sidebarFg,
      bg: active ? theme.selectedBg : theme.sidebarBg,
      bold: active || state.counts[mailbox] > 0,
    }), () => onMailbox(mailbox));
  }
  push(line(" ", theme, { bg: theme.sidebarBg }));
  section("Workspace");
  nav("Compose", state.view === "compose", "c", onCompose);
  nav("Domains", state.view === "domains", "d", onDomains);
  nav("Profiles", state.view === "profiles", "p", onProfiles);
  nav("Settings", state.dialog === "settings", ",", onSettings);
  nav("Commands", state.dialog === "commands", ":", onCommands);
  push(line(" ", theme, { bg: theme.sidebarBg }));
  section("Actions");
  push(line("a  choose address", theme, { fg: theme.sidebarFg, bg: theme.sidebarBg }), onAddress);
  push(line(":  commands", theme, { fg: theme.sidebarFg, bg: theme.sidebarBg }), onCommands);
  push(line("o  sort order", theme, { fg: theme.sidebarFg, bg: theme.sidebarBg }), onSort);
  push(line("n  next page", theme, { fg: theme.sidebarFg, bg: theme.sidebarBg }), onNextPage);
  push(line("N  prev page", theme, { fg: theme.sidebarFg, bg: theme.sidebarBg }), onPrevPage);
  push(line("c  compose", theme, { fg: theme.sidebarFg, bg: theme.sidebarBg }), onCompose);
  push(line("g  refresh", theme, { fg: theme.sidebarFg, bg: theme.sidebarBg }), onRefresh);
  push(line("G  pull now", theme, { fg: theme.sidebarFg, bg: theme.sidebarBg }), onPull);
  push(line(" ", theme, { bg: theme.sidebarBg }));
  section("Status");
  push(line(`Theme ${state.settings.theme}/${theme.name}`, theme, { fg: theme.sidebarFg, bg: theme.sidebarBg }));
  push(line(`Auto-pull ${state.settings.autoPull ? "on" : "off"}`, theme, {
    fg: state.settings.autoPull ? theme.ok : theme.sidebarMuted,
    bg: theme.sidebarBg,
    bold: state.settings.autoPull,
  }));
  while (rows.length < height) push(line(" ", theme, { bg: theme.sidebarBg }));
  return rows;
}

function renderHome({ state, width, theme, systemStatus }: {
  state: Model;
  width: number;
  theme: TuiTheme;
  systemStatus: EmailSystemStatus;
}): FrameLine[] {
  const rows = [
    line("Mailbox overview", theme, { fg: theme.accentStrong, bold: true }),
    ...renderMetricGrid([
      ["Inbox", state.counts.inbox, "received"],
      ["Unread", state.counts.unread, "needs review"],
      ["Starred", state.counts.starred, "follow-up"],
      ["Sent", state.counts.sent, "outbound"],
    ], width, theme),
    line(" ", theme),
    line("Choose", theme, { fg: theme.accentStrong, bold: true }),
    line(" ", theme),
  ];
  HOME_ITEMS.forEach((item, i) => {
    const active = i === state.homeIdx;
    rows.push(line(`${String(i + 1).padStart(2)}  ${item}`, theme, {
      fg: active ? theme.selectedFg : theme.primary,
      bg: active ? theme.selectedBg : undefined,
      bold: active,
    }));
  });
  rows.push(line(" ", theme));
  rows.push(line("Operations", theme, { fg: theme.accentStrong, bold: true }));
  rows.push(line(`  Sources   ${systemStatus.inbox.inbound_buckets.length} S3 bucket(s)  ${systemStatus.providers.gmail.length} Gmail  realtime ${systemStatus.inbox.realtime.queue_configured ? "on" : "off"}`, theme, {
    fg: systemStatus.inbox.inbound_buckets.length || systemStatus.providers.gmail.length ? theme.ok : theme.warning,
  }));
  rows.push(line(`  Pulling   auto ${state.settings.autoPull ? "on" : "off"}  Gmail ${state.settings.gmailAutoPull ? "on" : "off"}  latest ${systemStatus.inbox.latest_received_at ?? "never"}`, theme, { fg: theme.secondary }));
  if (systemStatus.inbox.realtime.last_error) rows.push(line(`  Error     ${truncate(systemStatus.inbox.realtime.last_error, width - 12)}`, theme, { fg: theme.error }));
  rows.push(line(" ", theme));
  rows.push(line(truncate("Inbox opens all mail first; use a inside Inbox to choose an address.", width), theme, { fg: theme.muted }));
  return rows;
}

function renderMetricGrid(items: Array<[string, number, string]>, width: number, theme: TuiTheme): FrameLine[] {
  const rows: FrameLine[] = [];
  if (width >= 72) {
    const colW = Math.max(26, Math.floor((width - 2) / 2));
    for (let i = 0; i < items.length; i += 2) {
      const left = metricCell(items[i]!, colW);
      const right = items[i + 1] ? metricCell(items[i + 1]!, colW) : "";
      rows.push(line(`${left.padEnd(colW)}  ${right.padEnd(colW)}`, theme, {
        fg: theme.primary,
        bg: theme.metricBg,
        bold: true,
      }));
    }
    return rows;
  }
  for (const item of items) {
    rows.push(line(metricCell(item, width), theme, {
      fg: theme.primary,
      bg: theme.metricBg,
      bold: true,
    }));
  }
  return rows;
}

function metricCell([labelText, count, detail]: [string, number, string], width: number): string {
  const value = formatCount(count).padStart(6);
  return truncate(`${labelText.padEnd(9)} ${value}  ${detail}`, width);
}

function domainReadinessLabel(summary: DomainSummary): string {
  if (summary.readiness === "ready_to_send_and_receive") return "send+receive";
  if (summary.readiness === "ready_to_send") return "send only";
  if (summary.readiness === "ready_to_receive") return "receive only";
  if (summary.readiness === "needs_dns") return "needs dns";
  return summary.readiness.replace(/_/g, " ");
}

function renderDomains({ width, height, theme }: { width: number; height: number; theme: TuiTheme }): FrameLine[] {
  const domains = listDomainSummaries();
  const rows: FrameLine[] = [
    line("Domain overview", theme, { fg: theme.accentStrong, bold: true }),
    line(" ", theme),
  ];

  if (domains.length === 0) {
    rows.push(line("No domains configured on this machine.", theme, { fg: theme.warning, bold: true }));
    rows.push(line(" ", theme));
    rows.push(line("Add a domain, verify DNS, then refresh this UI.", theme));
    rows.push(line("  emails domain add <provider-id> <domain>", theme, { fg: theme.accentStrong }));
    rows.push(line("  emails domain dns <domain>", theme, { fg: theme.accentStrong }));
    rows.push(line("  emails domain verify <domain>", theme, { fg: theme.accentStrong }));
    return rows.slice(0, height);
  }

  const totalAddresses = domains.reduce((sum, item) => sum + item.addresses, 0);
  const totalEmails = domains.reduce((sum, item) => sum + item.total, 0);
  const totalUnread = domains.reduce((sum, item) => sum + item.unread, 0);
  rows.push(line(`${formatCount(domains.length)} domain${domains.length === 1 ? "" : "s"} · ${formatCount(totalAddresses)} address${totalAddresses === 1 ? "" : "es"} · ${formatCount(totalEmails)} emails · ${formatCount(totalUnread)} unread`, theme, { fg: theme.secondary }));
  rows.push(line(" ", theme));

  if (width < 72) {
    for (const domain of domains) {
      const state = domainReadinessLabel(domain);
      rows.push(line(truncate(domain.domain, width), theme, { fg: theme.primary, bold: true }));
      rows.push(line(truncate(`  ${domain.provider} · ${formatCount(domain.addresses)} addr · ${formatCount(domain.inbox)} inbox · ${formatCount(domain.unread)} unread · ${formatCount(domain.sent)} sent`, width), theme, { fg: theme.secondary }));
      rows.push(line(truncate(`  ${formatCount(domain.total)} emails · ${state}`, width), theme, { fg: state === "needs dns" ? theme.warning : theme.ok }));
    }
    return rows.slice(0, height);
  }

  const domainW = Math.min(32, Math.max(18, Math.floor(width * 0.3)));
  const providerW = Math.min(16, Math.max(10, Math.floor(width * 0.16)));
  const metricW = Math.max(18, width - domainW - providerW - 4);
  rows.push(line(`${"Domain".padEnd(domainW)}  ${"Provider".padEnd(providerW)}  ${truncate("Addresses / inbox / unread / sent / total / state", metricW)}`, theme, {
    fg: theme.muted,
    bg: theme.panelAlt,
    bold: true,
  }));

  for (const domain of domains) {
    const state = domainReadinessLabel(domain);
    const metrics = `${formatCount(domain.addresses)} addr  ${formatCount(domain.inbox)} inbox  ${formatCount(domain.unread)} unread  ${formatCount(domain.sent)} sent  ${formatCount(domain.total)} emails  ${state}`;
    const ok = state === "send+receive" || state === "send only" || state === "receive only";
    rows.push(line(`${truncate(domain.domain, domainW).padEnd(domainW)}  ${truncate(domain.provider, providerW).padEnd(providerW)}  ${truncate(metrics, metricW)}`, theme, {
      fg: ok ? theme.primary : theme.warning,
      bg: ok ? undefined : theme.panelAlt,
      bold: !ok,
    }));
  }

  return rows.slice(0, height);
}

function renderList({ state, selectedIndex: sel, selectedMsg, width, height, theme }: {
  state: Model;
  selectedIndex: number;
  selectedMsg: TuiMessage | null;
  width: number;
  height: number;
  theme: TuiTheme;
}): FrameLine[] {
  const rows: FrameLine[] = [];
  if (state.searchActive) rows.push(line(`/ ${state.search}|`, theme, { fg: theme.warning, bold: true }));
  const rowH = Math.max(1, height - rows.length);
  const messages = state.messages;
  if (messages.length === 0) {
    if (state.hasAnyMail) return [...rows, line("No messages in this folder/address.", theme)];
    return [
      ...rows,
      line("No mail synced on this machine yet.", theme, { fg: theme.warning, bold: true }),
      line(" ", theme),
      line("Pull mail into the local store, then press g here to refresh.", theme),
      line("  emails inbox sync --all-profiles --all      Gmail", theme, { fg: theme.accentStrong }),
      line("  emails inbox sync-s3 --bucket <bucket>       SES/S3 inbound", theme, { fg: theme.accentStrong }),
      line("  emails cloud pull                            RDS cloud sync", theme, { fg: theme.accentStrong }),
    ];
  }

  if (width >= 92 && selectedMsg) {
    return renderSplitList({ state, selectedIndex: sel, selectedMsg, width, height, theme, prefixRows: rows });
  }

  const start = Math.max(0, Math.min(sel - Math.floor(rowH / 2), Math.max(0, messages.length - rowH)));
  const whoW = Math.min(24, Math.max(12, Math.floor(width * 0.24)));
  const timeW = 6;
  const subjW = Math.max(8, width - whoW - timeW - 7);
  for (const [offset, m] of messages.slice(start, start + rowH).entries()) {
    const selected = start + offset === sel;
    const who = (m.sentByMe ? "-> " : "") + senderName(m.sentByMe ? m.to : m.from);
    const subjCell = m.attachments > 0 ? `[${m.attachments}] ${m.subject}` : m.subject;
    const faded = state.settings.dimRead && m.is_read && !selected;
    const marker = `${m.is_starred ? "*" : " "}${m.is_read ? " " : "!"}`;
    rows.push(line(`${marker} ${truncate(who, whoW).padEnd(whoW)} ${truncate(subjCell, subjW).padEnd(subjW)} ${relativeTime(m.date, state.now).padStart(timeW)}`, theme, {
      fg: selected ? theme.selectedFg : faded ? theme.dimRead : m.is_read ? theme.primary : theme.unread,
      bg: selected ? theme.selectedBg : undefined,
      bold: selected || !m.is_read,
    }));
  }
  return rows;
}

function renderSplitList({ state, selectedIndex: sel, selectedMsg, width, height, theme, prefixRows }: {
  state: Model;
  selectedIndex: number;
  selectedMsg: TuiMessage;
  width: number;
  height: number;
  theme: TuiTheme;
  prefixRows: FrameLine[];
}): FrameLine[] {
  const leftW = Math.min(48, Math.max(36, Math.floor(width * 0.46)));
  const rightW = Math.max(28, width - leftW - 3);
  const rowH = Math.max(1, height - prefixRows.length);
  const start = Math.max(0, Math.min(sel - Math.floor(rowH / 2), Math.max(0, state.messages.length - rowH)));
  const whoW = Math.min(16, Math.max(10, Math.floor(leftW * 0.34)));
  const timeW = 6;
  const subjW = Math.max(8, leftW - whoW - timeW - 8);
  const left: string[] = [];
  for (const [offset, m] of state.messages.slice(start, start + rowH).entries()) {
    const selected = start + offset === sel;
    const marker = selected ? ">" : " ";
    const who = senderName(m.sentByMe ? m.to : m.from);
    const stateMark = `${m.is_starred ? "*" : " "}${m.is_read ? " " : "!"}`;
    left.push(truncate(`${marker}${stateMark} ${truncate(who, whoW).padEnd(whoW)} ${truncate(m.subject, subjW).padEnd(subjW)} ${relativeTime(m.date, state.now).padStart(timeW)}`, leftW));
  }

  const body = getMessageBody(selectedMsg);
  const text = body?.text ?? (body?.html ? body.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "(no text content)");
  const right = [
    truncate("Preview", rightW),
    truncate(body?.subject ?? selectedMsg.subject, rightW),
    truncate(`from ${senderName(body?.from ?? selectedMsg.from)}`, rightW),
    truncate(formatDate(body?.date ?? selectedMsg.date), rightW),
    "",
    ...wrapText(text, Math.max(20, rightW), 1200),
  ].slice(0, rowH);

  const out = [...prefixRows];
  for (let i = 0; i < rowH; i++) {
    const l = (left[i] ?? "").padEnd(leftW);
    const r = right[i] ?? "";
    out.push(line(`${l} ${theme.name === "dark" ? "|" : "|"} ${truncate(r, rightW)}`, theme, {
      fg: i === 0 ? theme.accentStrong : theme.primary,
      bg: i === sel - start ? theme.panelAlt : undefined,
      bold: i === sel - start || i === 0,
    }));
  }
  return out.slice(0, height);
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function renderReader({ body, conversation, scroll, width, height, theme }: {
  body: ReturnType<typeof getMessageBody>;
  conversation: ReturnType<typeof getConversation>;
  scroll: number;
  width: number;
  height: number;
  theme: TuiTheme;
}): FrameLine[] {
  if (!body) return [line("No message selected.", theme, { fg: theme.muted })];
  const text = body.text ?? (body.html ? body.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "(no text content)");
  const atts = body.attachments ?? [];
  const rows: FrameLine[] = [
    line(truncate(body.subject, width), theme, { fg: theme.accentStrong, bold: true }),
    line(`from ${truncate(senderName(body.from), width - 5)}`, theme),
    line(`to   ${truncate(body.to, width - 5)}`, theme),
    line(`${formatDate(body.date)} - ${body.flags.join(", ")}`, theme, { fg: theme.muted }),
  ];
  if (conversation.length > 1) rows.push(line(`${conversation.length} in thread`, theme, { fg: theme.accent }));
  if (atts.length > 0) {
    rows.push(line(`${atts.length} attachment${atts.length > 1 ? "s" : ""}:`, theme, { fg: theme.warning, bold: true }));
    for (const a of atts.slice(0, 6)) {
      rows.push(line(` - ${truncate(a.filename, width - 28)} ${bytes(a.size)} ${a.content_type.split("/").pop()}${a.location ? " saved" : ""}`, theme, { fg: theme.secondary }));
    }
  }
  rows.push(line(" ", theme));
  const avail = Math.max(2, height - rows.length - 1);
  const lines = wrapText(text, Math.max(20, width), 5000);
  const safeScroll = Math.min(scroll, Math.max(0, lines.length - avail));
  for (const l of lines.slice(safeScroll, safeScroll + avail)) rows.push(line(l || " ", theme));
  if (safeScroll + avail < lines.length) rows.push(line(`${lines.length - safeScroll - avail} more - j/k to scroll`, theme, { fg: theme.muted }));
  return rows;
}

function renderProfiles({ width, height, theme }: { width: number; height: number; theme: TuiTheme }): FrameLine[] {
  const profiles = listProfiles();
  const byProvider = new Map<string, ReturnType<typeof listProfiles>>();
  for (const p of profiles) {
    const list = byProvider.get(p.provider) ?? [];
    list.push(p);
    byProvider.set(p.provider, list);
  }

  const rows: FrameLine[] = [
    line("Profiles", theme, { fg: theme.accentStrong, bold: true }),
    line(" ", theme),
  ];
  for (const [provider, list] of byProvider) {
    rows.push(line(provider.toUpperCase(), theme, { fg: theme.accent, bold: true }));
    for (const p of list) {
      rows.push(line(`  ${p.name}${p.active ? "" : " (inactive)"}`, theme, { fg: theme.primary, bold: p.active }));
      if (p.domain_details.length) {
        const summary = p.domain_details.map((domain) => {
          const state = domain.readiness.state.replace(/^ready_to_/, "").replace(/_/g, " ");
          return `${domain.domain} ${state}`;
        }).join(", ");
        rows.push(line(`    domains:   ${truncate(summary, width - 14)}`, theme, { fg: theme.secondary }));
      }
      for (const address of p.address_details.slice(0, Math.max(1, Math.min(6, height - rows.length - 2)))) {
        const owner = address.owner ? ` owner:${address.owner}` : " owner:none";
        const admin = address.administrator && address.administrator !== address.owner ? ` admin:${address.administrator}` : "";
        const receive = ` recv:${address.receive_status}`;
        const verified = address.verified ? " verified" : " unverified";
        const quota = address.daily_quota !== null ? ` quota:${address.sent_today}/${address.daily_quota}` : "";
        rows.push(line(`    ${truncate(address.email, Math.max(12, width - 56))}${verified}${receive}${owner}${admin}${quota}`, theme, { fg: theme.secondary }));
        const extras: string[] = [];
        if (address.aliases.length) extras.push(`aliases ${address.aliases.slice(0, 3).join(", ")}`);
        if (address.send_keys.length) extras.push(`keys ${address.send_keys.filter((key) => key.active).length}/${address.send_keys.length}`);
        if (extras.length) rows.push(line(`      ${truncate(extras.join(" · "), width - 8)}`, theme, { fg: theme.muted }));
      }
      if (p.address_details.length > 6) rows.push(line(`    ${p.address_details.length - 6} more address${p.address_details.length - 6 === 1 ? "" : "es"}`, theme, { fg: theme.muted }));
      if (!p.domains.length && !p.addresses.length) rows.push(line("    (no domains/addresses)", theme, { fg: theme.muted }));
    }
  }
  return rows.slice(0, height);
}

interface SettingsDialogItem {
  key: string;
  label: string;
  value: string;
  edit: string;
  on: boolean;
}

function settingsDialogItems(settings: TuiSettings, addresses: InboxAddressChoice[], theme: TuiTheme): SettingsDialogItem[] {
  const defaultInbox = addressChoiceByAddress(settings.defaultAddress);
  const defaultFrom = settings.defaultFrom ?? "auto";
  const inboxLabel = addresses.find((choice) => choice.id === defaultInbox.id)?.label ?? defaultInbox.label;
  return [
    { key: "1", label: "Auto-pull inbound", value: settings.autoPull ? "ON" : "OFF", edit: "toggle", on: settings.autoPull },
    { key: "2", label: "Gmail auto-pull", value: settings.gmailAutoPull ? "ON" : "OFF", edit: "toggle", on: settings.gmailAutoPull },
    { key: "3", label: "Dim read messages", value: settings.dimRead ? "ON" : "OFF", edit: "toggle", on: settings.dimRead },
    { key: "4", label: "Default folder", value: mailboxLabel(settings.defaultMailbox), edit: "cycle", on: true },
    { key: "5", label: "Default inbox", value: inboxLabel, edit: "cycle", on: true },
    { key: "6", label: "Default From", value: defaultFrom, edit: "cycle", on: true },
    { key: "7", label: "Theme", value: `${settings.theme} -> ${theme.name}`, edit: "cycle", on: true },
  ];
}

function renderCompose({ compose, width, height, theme }: {
  compose: ComposeState;
  width: number;
  height: number;
  theme: TuiTheme;
}): FrameLine[] {
  const field = (f: ComposeField, v: string) => {
    const active = compose.field === f;
    return line(`${f.padEnd(8)} ${truncate(v, Math.max(8, width - 11))}${active ? "|" : ""}`, theme, {
      fg: active ? theme.accentStrong : theme.primary,
      bg: active ? theme.panelAlt : undefined,
      bold: active,
    });
  };
  const bodyLines = (compose.body || "").split("\n");
  const bodyH = Math.max(1, height - 6);
  const start = Math.max(0, bodyLines.length - bodyH);
  const rows = [
    line(`${compose.replyTo ? "Reply" : "New message"}   markdown body, Ctrl-S sends`, theme, { fg: theme.accent, bold: true }),
    field("from", compose.from),
    field("to", compose.to),
    field("subject", compose.subject),
    line("-".repeat(Math.min(width, 60)), theme, { fg: theme.muted }),
  ];
  for (const [offset, bodyLine] of bodyLines.slice(start, start + bodyH).entries()) {
    const absolute = start + offset;
    const isLast = absolute === bodyLines.length - 1;
    rows.push(line(`${truncate(bodyLine || " ", width)}${compose.field === "body" && isLast ? "|" : ""}`, theme));
  }
  return rows;
}

function footerLine(view: View, dialog: DialogKind, searching: boolean, theme: TuiTheme): FrameLine {
  const hint = dialog === "addressPicker" ? "address dialog - type search - up/down choose - Enter apply - Esc close"
    : dialog === "commands" ? "command dialog - type filter - up/down choose - Enter run - Esc close"
    : dialog === "settings" ? "settings dialog - up/down choose - Enter edit - 1-7 edit - Esc close"
    : searching ? "type to filter - Enter apply - Esc clear"
    : view === "home" ? "up/down choose - Enter open - q quit"
    : view === "compose" ? "Tab field - edit From/To/Subject/Body - Ctrl-S send - Esc cancel"
    : view === "domains" ? "domains - b back"
    : view === "profiles" ? "profiles - b back"
    : view === "reader" ? "j/k scroll - J/K next/prev - r reply - s star - e archive - b back"
    : "up/down move - Enter open - o sort - n/N page - : commands - ]/[ folders - a address - d domains - c compose - , settings - / search - g refresh - G pull - b home";
  return line(` ${hint}`, theme, { fg: theme.muted, bg: theme.background });
}

function ActionFrameText({ item, width }: { item: ActionLine; width: number }) {
  if (!item.onPress) return <FrameText line={item.line} width={width} />;
  return (
    <box
      width={width}
      height={1}
      onMouseUp={(event: MouseEvent) => {
        event.stopPropagation();
        item.onPress?.();
      }}
      onMouseOver={(event: MouseEvent) => {
        event.stopPropagation();
      }}
    >
      <FrameText line={item.line} width={width} />
    </box>
  );
}

function DialogLayer({ state, addresses, addressChoices, cols, rows, theme, onClose, onCommandMove, onCommandSelect, onAddressMove, onAddressSelect, onSettingsMove, onSettingsSelect }: {
  state: Model;
  addresses: InboxAddressChoice[];
  addressChoices: InboxAddressChoice[];
  cols: number;
  rows: number;
  theme: TuiTheme;
  onClose: () => void;
  onCommandMove: (delta: number, count: number) => void;
  onCommandSelect: (action: PaletteAction) => void;
  onAddressMove: (delta: number, count: number) => void;
  onAddressSelect: (choice: InboxAddressChoice) => void;
  onSettingsMove: (delta: number) => void;
  onSettingsSelect: (index: number) => void;
}) {
  if (!state.dialog) return null;

  if (state.dialog === "commands") {
    const commands = filteredCommands(state.commandSearch);
    const width = Math.min(76, Math.max(42, cols - 6));
    const height = Math.min(Math.max(10, rows - 6), 18);
    const activeIdx = Math.min(state.commandIdx, Math.max(0, commands.length - 1));
    const rowsAvailable = Math.max(3, height - 5);
    const start = Math.max(0, Math.min(activeIdx - Math.floor(rowsAvailable / 2), Math.max(0, commands.length - rowsAvailable)));
    const titleW = Math.min(28, Math.max(14, Math.floor(width * 0.36)));
    return (
      <DialogFrame title="Command palette" width={width} height={height} cols={cols} rows={rows} theme={theme} onClose={onClose}>
        <FrameText line={line(`> ${state.commandSearch}|`, theme, { fg: theme.warning, bold: true })} width={width - 4} />
        <FrameText line={line(" ", theme)} width={width - 4} />
        {commands.length === 0 ? (
          <FrameText line={line("No matching actions.", theme, { fg: theme.muted })} width={width - 4} />
        ) : commands.slice(start, start + rowsAvailable).map((command, offset) => {
          const index = start + offset;
          const active = index === activeIdx;
          const text = `${active ? ">" : " "} ${truncate(command.title, titleW).padEnd(titleW)} ${truncate(command.detail, Math.max(8, width - titleW - 8))}`;
          return (
            <box
              key={command.action}
              width={width - 4}
              height={1}
              onMouseOver={(event: MouseEvent) => {
                event.stopPropagation();
                onCommandMove(index - state.commandIdx, commands.length);
              }}
              onMouseUp={(event: MouseEvent) => {
                event.stopPropagation();
                onCommandSelect(command.action);
              }}
            >
              <FrameText
                width={width - 4}
                line={line(text, theme, {
                  fg: active ? theme.selectedFg : theme.primary,
                  bg: active ? theme.selectedBg : undefined,
                  bold: active,
                })}
              />
            </box>
          );
        })}
      </DialogFrame>
    );
  }

  if (state.dialog === "settings") {
    const items = settingsDialogItems(state.settings, addresses, theme);
    const width = Math.min(82, Math.max(54, cols - 6));
    const height = Math.min(Math.max(13, rows - 6), 16);
    const activeIdx = Math.min(state.settingsIdx, Math.max(0, items.length - 1));
    const labelW = Math.min(24, Math.max(16, Math.floor(width * 0.32)));
    return (
      <DialogFrame title="Settings" width={width} height={height} cols={cols} rows={rows} theme={theme} onClose={onClose}>
        <FrameText line={line("Enter or click edits the selected value.", theme, { fg: theme.muted })} width={width - 4} />
        <FrameText line={line(" ", theme)} width={width - 4} />
        {items.map((item, index) => {
          const active = index === activeIdx;
          const left = `${active ? ">" : " "} ${item.key}  ${truncate(item.label, labelW).padEnd(labelW)}`;
          const right = `${truncate(item.value, Math.max(8, width - labelW - 23))}  ${item.edit}`;
          return (
            <box
              key={item.key}
              width={width - 4}
              height={1}
              onMouseOver={(event: MouseEvent) => {
                event.stopPropagation();
                onSettingsMove(index - state.settingsIdx);
              }}
              onMouseUp={(event: MouseEvent) => {
                event.stopPropagation();
                onSettingsSelect(index);
              }}
            >
              <FrameText
                width={width - 4}
                line={line(fitLine(left, right, width - 4), theme, {
                  fg: active ? theme.selectedFg : item.on ? theme.primary : theme.muted,
                  bg: active ? theme.selectedBg : item.on ? theme.panelAlt : undefined,
                  bold: active || item.on,
                })}
              />
            </box>
          );
        })}
      </DialogFrame>
    );
  }

  const width = Math.min(72, Math.max(42, cols - 6));
  const height = Math.min(Math.max(12, rows - 6), 18);
  const rowH = Math.max(2, height - 6);
  const activeIdx = Math.min(state.addressPickerIdx, Math.max(0, addressChoices.length - 1));
  const start = Math.max(0, Math.min(activeIdx - Math.floor(rowH / 2), Math.max(0, addressChoices.length - rowH)));
  return (
    <DialogFrame title="Choose Address" width={width} height={height} cols={cols} rows={rows} theme={theme} onClose={onClose}>
      <FrameText line={line("All mail stays in one inbox; this only filters the view.", theme, { fg: theme.muted })} width={width - 4} />
      <FrameText line={line(`Search ${state.addressSearch}|`, theme, { fg: state.addressSearch ? theme.primary : theme.muted, bg: theme.panelAlt, bold: true })} width={width - 4} />
      <FrameText line={line(" ", theme)} width={width - 4} />
      {addressChoices.length === 0 ? (
        <FrameText line={line("No matching addresses.", theme, { fg: theme.muted })} width={width - 4} />
      ) : addressChoices.slice(start, start + rowH).map((choice, offset) => {
        const index = start + offset;
        const active = index === activeIdx;
        return (
          <box
            key={choice.id}
            width={width - 4}
            height={1}
            onMouseOver={(event: MouseEvent) => {
              event.stopPropagation();
              onAddressMove(index - state.addressPickerIdx, addressChoices.length);
            }}
            onMouseUp={(event: MouseEvent) => {
              event.stopPropagation();
              onAddressSelect(choice);
            }}
          >
            <FrameText
              width={width - 4}
              line={line(`${active ? ">" : " "} ${truncate(choice.label, width - 7)}`, theme, {
                fg: active ? theme.selectedFg : theme.primary,
                bg: active ? theme.selectedBg : undefined,
                bold: active,
              })}
            />
          </box>
        );
      })}
    </DialogFrame>
  );
}

function DialogFrame({ title, width, height, cols, rows, theme, onClose, children }: {
  title: string;
  width: number;
  height: number;
  cols: number;
  rows: number;
  theme: TuiTheme;
  onClose: () => void;
  children: ReactNode;
}) {
  const top = Math.max(1, Math.min(Math.max(1, rows - height - 1), Math.floor(rows / 4)));
  const left = Math.max(1, Math.floor((cols - width) / 2));
  return (
    <box
      position="absolute"
      zIndex={3000}
      left={0}
      top={0}
      width={cols}
      height={rows}
      backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
      onMouseUp={(event: MouseEvent) => {
        event.stopPropagation();
        onClose();
      }}
    >
      <box
        position="absolute"
        left={left}
        top={top}
        width={width}
        height={height}
        border
        borderStyle="rounded"
        borderColor={theme.border}
        backgroundColor={theme.panel}
        paddingX={1}
        paddingY={1}
        title={` ${title} `}
        onMouseUp={(event: MouseEvent) => {
          event.stopPropagation();
        }}
      >
        <box flexDirection="column" width={width - 2} height={height - 2}>
          <box flexDirection="row" justifyContent="space-between" width={width - 4} height={1}>
            <FrameText line={line(title, theme, { fg: theme.accentStrong, bold: true })} width={Math.max(1, width - 12)} />
            <box
              width={5}
              height={1}
              onMouseUp={(event: MouseEvent) => {
                event.stopPropagation();
                onClose();
              }}
            >
              <FrameText line={line("esc", theme, { fg: theme.muted })} width={5} />
            </box>
          </box>
          {children}
        </box>
      </box>
    </box>
  );
}

function FrameText({ line: frameLine, width }: { line: FrameLine; width: number }) {
  return (
    <text
      width={width}
      height={1}
      content={frameLine.text || " "}
      fg={frameLine.fg}
      bg={frameLine.bg}
      attributes={frameLine.bold ? TextAttributes.BOLD : TextAttributes.NONE}
      truncate
    />
  );
}
