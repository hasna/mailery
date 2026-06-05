/** @jsxImportSource @opentui/react */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { TextAttributes, type KeyEvent, type ThemeMode as OpenTuiThemeMode } from "@opentui/core";
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
} from "./data.js";
import { autoPull } from "./autopull.js";
import { truncate, senderName, relativeTime, formatDate, wrapText } from "./format.js";
import { nextThemeMode, resolveTheme, type ResolvedTuiThemeName, type TuiTheme } from "./theme.js";
import { startEventLoopWatchdog } from "./watchdog.js";
import { getEmailSystemStatus, type EmailSystemStatus } from "../../lib/agent-context.js";

type View = "home" | "list" | "addressPicker" | "reader" | "compose" | "profiles" | "settings" | "commands";
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
  commandIdx: number;
  commandSearch: string;
  commandReturnTo: View;
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
const HOME_ITEMS = ["Inbox", "Compose", "Profiles", "Settings"] as const;
const COMPOSE_FIELDS: ComposeField[] = ["from", "to", "subject", "body"];
type PaletteAction = "inbox" | "compose" | "profiles" | "settings" | "address" | "refresh" | "pull" | "search" | "unread" | "sent" | "archived";
const COMMAND_ITEMS: Array<{ title: string; detail: string; action: PaletteAction }> = [
  { title: "Open Inbox", detail: "Show received mail", action: "inbox" },
  { title: "Compose", detail: "Start a new message", action: "compose" },
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
    case "setMailbox":
      return { ...state, mailbox: action.mailbox, page: 0, selectedId: null, view: "list", readerScroll: 0 };
    case "cycleMailbox": {
      const i = MAILBOXES.indexOf(state.mailbox);
      const mailbox = MAILBOXES[(i + action.delta + MAILBOXES.length) % MAILBOXES.length]!;
      return { ...state, mailbox, page: 0, selectedId: null, view: "list", readerScroll: 0 };
    }
    case "setAddress":
      return { ...state, addressIdx: action.index, page: 0, selectedId: null, view: "list", readerScroll: 0 };
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
      return { ...state, view: "commands", commandReturnTo: action.returnTo, commandIdx: 0, commandSearch: "" };
    case "closeCommandPalette":
      return { ...state, view: state.commandReturnTo };
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
      return { ...state, addressPickerIdx: state.addressIdx, view: "addressPicker" };
    case "selectOffset":
      return { ...state, selectedId: selectWithin(state.messages, state.selectedId, action.delta) };
    case "view":
      return { ...state, view: action.view, searchActive: action.view === "list" ? state.searchActive : false };
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
      return { ...state, view: "compose", compose: action.compose };
    case "composeCancel":
      return { ...state, view: state.compose?.returnTo ?? "home", compose: null };
    case "composePatch":
      return state.compose ? { ...state, compose: { ...state.compose, ...action.patch } } : state;
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
      commandIdx: 0,
      commandSearch: "",
      commandReturnTo: initialMailbox ? "list" : "home",
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

  const openHomeSelection = useCallback(() => {
    const item = HOME_ITEMS[state.homeIdx];
    if (item === "Inbox") {
      dispatch({ type: "view", view: "list" });
    } else if (item === "Compose") {
      startCompose();
    } else if (item === "Profiles") {
      dispatch({ type: "view", view: "profiles" });
    } else {
      dispatch({ type: "view", view: "settings" });
    }
  }, [startCompose, state.homeIdx]);

  const executePaletteAction = useCallback((action: PaletteAction) => {
    if (action === "inbox") dispatch({ type: "view", view: "list" });
    else if (action === "compose") startCompose();
    else if (action === "profiles") dispatch({ type: "view", view: "profiles" });
    else if (action === "settings") dispatch({ type: "view", view: "settings" });
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

    if (state.view === "compose" && state.compose) {
      handleComposeInput(input, key, dispatch, sendDraft, flash);
      return;
    }

    if (state.searchActive) {
      handleSearchInput(input, key, dispatch);
      return;
    }

    if (state.view === "commands") {
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

    if ((event.ctrl && input === "k") || input === ":") {
      dispatch({ type: "openCommandPalette", returnTo: state.view });
      return;
    }

    if (state.view === "home") {
      if (input === "q") { renderer.destroy(); return; }
      if (key.upArrow || input === "k") dispatch({ type: "selectHomeOffset", delta: -1 });
      else if (key.downArrow || input === "j") dispatch({ type: "selectHomeOffset", delta: 1 });
      else if (key.return || key.rightArrow || input === "l") openHomeSelection();
      else if (input === "1") dispatch({ type: "view", view: "list" });
      else if (input === "2") startCompose();
      else if (input === "3") dispatch({ type: "view", view: "profiles" });
      else if (input === "4") dispatch({ type: "view", view: "settings" });
      return;
    }

    if (state.view === "settings") {
      if (input === "q" || input === "b" || input === "," || key.escape) dispatch({ type: "view", view: "home" });
      else if (input === "1") toggleSetting("autoPull");
      else if (input === "2") toggleSetting("gmailAutoPull");
      else if (input === "3") toggleSetting("dimRead");
      else if (input === "4") {
        const i = MAILBOXES.indexOf(state.settings.defaultMailbox);
        setDefaultMailbox(MAILBOXES[(i + 1) % MAILBOXES.length]!);
      }
      else if (input === "5") cycleDefaultAddress();
      else if (input === "6") cycleDefaultFrom();
      else if (input === "7") cycleTheme();
      return;
    }

    if (state.view === "profiles") {
      if (input === "q" || input === "b" || input === "p" || key.escape) dispatch({ type: "view", view: "home" });
      return;
    }

    if (state.view === "addressPicker") {
      if (input === "q" || input === "b" || key.escape) { dispatch({ type: "view", view: "list" }); return; }
      if (key.upArrow || input === "k") dispatch({ type: "selectAddressPickerOffset", delta: -1, count: addresses.length });
      else if (key.downArrow || input === "j") dispatch({ type: "selectAddressPickerOffset", delta: 1, count: addresses.length });
      else if (key.return || key.rightArrow || input === "l") {
        dispatch({ type: "setAddress", index: state.addressPickerIdx });
        const next = addresses[state.addressPickerIdx] ?? ALL_ADDRESSES;
        flash(`inbox: ${next.label}`, "ok");
      }
      return;
    }

    if (input === "q" || input === "b" || key.escape) {
      if (state.view === "reader") dispatch({ type: "view", view: "list" });
      else dispatch({ type: "view", view: "home" });
      return;
    }
    if (input === "c") { startCompose(); return; }
    if (input === "p") { dispatch({ type: "view", view: "profiles" }); return; }
    if (input === ",") { dispatch({ type: "view", view: "settings" }); return; }
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
    else if (input >= "1" && input <= "5") dispatch({ type: "setMailbox", mailbox: MAILBOXES[Number(input) - 1]! });
    else if (input === "s") mutateSelected("star");
    else if (input === "e") mutateSelected("archive");
    else if (input === "u") mutateSelected("read");
    else if (input === "r" && selectedMsg) startCompose(selectedMsg);
    else if (input === "/") dispatch({ type: "searchStart" });
  });

  const isDashboard = cols >= 104 && rows >= 20;
  const topBar = renderTopBar({ state, address, cols, theme });
  const footer = footerLine(state.view, state.searchActive, theme);
  const bodyH = Math.max(6, rows - 2);
  const sidebarW = isDashboard ? Math.min(34, Math.max(28, Math.floor(cols * 0.24))) : 0;
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
  const sidebarLines = renderSidebar({ state, address, width: sidebarW - 2, height: contentH, theme });
  const compactLines = [
    compactNavLine({ state, address, width: workspaceW, theme }),
    ...contentLines,
  ];

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
            title=" navigation "
          >
            {sidebarLines.slice(0, contentH).map((line, i) => <FrameText key={`sidebar-${i}`} line={line} width={sidebarW - 2} />)}
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
          >
            {contentLines.slice(0, contentH).map((line, i) => <FrameText key={`content-${i}`} line={line} width={workspaceW} />)}
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
        >
          {compactLines.slice(0, contentH).map((line, i) => <FrameText key={`content-${i}`} line={line} width={workspaceW} />)}
        </box>
      )}
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

function renderTopBar({ state, address, cols, theme }: {
  state: Model;
  address: InboxAddressChoice;
  cols: number;
  theme: TuiTheme;
}): FrameLine {
  const statusColor = state.status.tone === "ok" ? theme.ok : state.status.tone === "err" ? theme.error : theme.warning;
  const left = ` emails ui  ${workspaceTitle(state, address)}`;
  const right = state.status.text || `${state.counts.unread} unread  ${state.settings.theme}/${theme.name}`;
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
  if (state.view === "settings") return renderSettings({ settings: state.settings, addresses: args.addresses, width: args.width, theme: args.theme });
  if (state.view === "profiles") return renderProfiles({ width: args.width, height: args.height, theme: args.theme });
  if (state.view === "commands") return renderCommandPalette({ state, width: args.width, height: args.height, theme: args.theme });
  if (state.view === "addressPicker") return renderAddressPicker(args);
  if (state.view === "reader") return renderReader({ body: args.readerBody, conversation: args.conversation, scroll: state.readerScroll, width: args.width, height: args.height, theme: args.theme });
  return renderList(args);
}

function workspacePanelTitle(state: Model): string {
  return ` ${state.view === "home" ? "dashboard" : state.view === "list" ? mailboxLabel(state.mailbox).toLowerCase() : state.view} `;
}

function workspaceTitle(state: Model, address: InboxAddressChoice): string {
  if (state.view === "home") return "Dashboard";
  if (state.view === "list") return `${mailboxLabel(state.mailbox)}: ${address.label}`;
  if (state.view === "addressPicker") return "Choose inbox address";
  if (state.view === "reader") return "Message reader";
  if (state.view === "compose") return state.compose?.replyTo ? "Reply" : "Compose";
  if (state.view === "profiles") return "Profiles";
  if (state.view === "commands") return "Command palette";
  return "Settings";
}

function workspaceSubtitle({ state, address, width }: RenderContentArgs): string {
  if (state.view === "home") return truncate("Home · Inbox · Compose · Profiles · Settings", width);
  if (state.view === "list") {
    const shown = `${state.messages.length} shown`;
    const page = `page ${state.page + 1}${state.hasMore ? "+" : ""}`;
    const sort = state.sort === "newest" ? "newest first" : "oldest first";
    const counts = `${state.counts.inbox} inbox · ${state.counts.unread} unread · ${state.counts.sent} sent`;
    const action = address.address ? "a changes address" : "a chooses address";
    return truncate(`${shown} · ${page} · ${sort} · ${counts} · ${action}`, width);
  }
  if (state.view === "compose") return truncate("Editable From, To, Subject, and markdown Body · Ctrl-S sends", width);
  if (state.view === "settings") return truncate("Theme, defaults, and background pull controls", width);
  if (state.view === "profiles") return truncate("Configured accounts with their domains and addresses", width);
  if (state.view === "commands") return truncate("Type to filter actions · Enter runs · Esc closes", width);
  if (state.view === "addressPicker") return truncate("Choose All addresses or one exact inbox address", width);
  return truncate("b returns to Inbox · r replies · s stars · e archives", width);
}

function compactNavLine({ state, address, width, theme }: {
  state: Model;
  address: InboxAddressChoice;
  width: number;
  theme: TuiTheme;
}): FrameLine {
  const nav = `1 Inbox  2 Compose  3 Profiles  4 Settings  ·  ${workspaceTitle(state, address)}`;
  return line(truncate(nav, width), theme, { fg: theme.sourceFg, bg: theme.sourceBg, bold: true });
}

function renderSidebar({ state, address, width, height, theme }: {
  state: Model;
  address: InboxAddressChoice;
  width: number;
  height: number;
  theme: TuiTheme;
}): FrameLine[] {
  const rows: FrameLine[] = [];
  const section = (labelText: string) => rows.push(line(labelText.toUpperCase(), theme, { fg: theme.sidebarMuted, bg: theme.sidebarBg, bold: true }));
  const nav = (labelText: string, active: boolean, keyChar: string) => rows.push(line(`${keyChar}  ${truncate(labelText, width - 4)}`, theme, {
    fg: active ? theme.selectedFg : theme.sidebarFg,
    bg: active ? theme.selectedBg : theme.sidebarBg,
    bold: active,
  }));
  rows.push(line("Mailbox", theme, { fg: theme.sidebarFg, bg: theme.sidebarBg, bold: true }));
  rows.push(line(truncate(address.label, width), theme, { fg: theme.sidebarMuted, bg: theme.sidebarBg }));
  rows.push(line(" ", theme, { bg: theme.sidebarBg }));
  section("Navigation");
  nav("Inbox", state.view === "list" || state.view === "reader" || state.view === "addressPicker", "1");
  nav("Compose", state.view === "compose", "2");
  nav("Profiles", state.view === "profiles", "3");
  nav("Settings", state.view === "settings", "4");
  nav("Commands", state.view === "commands", ":");
  rows.push(line(" ", theme, { bg: theme.sidebarBg }));
  section("Folders");
  for (const [i, mailbox] of MAILBOXES.entries()) {
    const active = state.mailbox === mailbox && state.view !== "home" && state.view !== "compose" && state.view !== "profiles" && state.view !== "settings";
    const countText = String(state.counts[mailbox]);
    const labelText = `${i + 1}  ${mailboxLabel(mailbox)}`;
    rows.push(line(fitLine(labelText, countText, width), theme, {
      fg: active ? theme.selectedFg : theme.sidebarFg,
      bg: active ? theme.selectedBg : theme.sidebarBg,
      bold: active || state.counts[mailbox] > 0,
    }));
  }
  rows.push(line(" ", theme, { bg: theme.sidebarBg }));
  section("Actions");
  rows.push(line("a  choose address", theme, { fg: theme.sidebarFg, bg: theme.sidebarBg }));
  rows.push(line(":  commands", theme, { fg: theme.sidebarFg, bg: theme.sidebarBg }));
  rows.push(line("o  sort order", theme, { fg: theme.sidebarFg, bg: theme.sidebarBg }));
  rows.push(line("n/N page", theme, { fg: theme.sidebarFg, bg: theme.sidebarBg }));
  rows.push(line("c  compose", theme, { fg: theme.sidebarFg, bg: theme.sidebarBg }));
  rows.push(line("g  refresh", theme, { fg: theme.sidebarFg, bg: theme.sidebarBg }));
  rows.push(line("G  pull now", theme, { fg: theme.sidebarFg, bg: theme.sidebarBg }));
  rows.push(line(" ", theme, { bg: theme.sidebarBg }));
  section("Status");
  rows.push(line(`Theme ${state.settings.theme}/${theme.name}`, theme, { fg: theme.sidebarFg, bg: theme.sidebarBg }));
  rows.push(line(`Auto-pull ${state.settings.autoPull ? "on" : "off"}`, theme, {
    fg: state.settings.autoPull ? theme.ok : theme.sidebarMuted,
    bg: theme.sidebarBg,
    bold: state.settings.autoPull,
  }));
  while (rows.length < height) rows.push(line(" ", theme, { bg: theme.sidebarBg }));
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
  const value = String(count).padStart(4);
  return truncate(`${labelText.padEnd(9)} ${value}  ${detail}`, width);
}

function renderCommandPalette({ state, width, height, theme }: {
  state: Model;
  width: number;
  height: number;
  theme: TuiTheme;
}): FrameLine[] {
  const commands = filteredCommands(state.commandSearch);
  const rows: FrameLine[] = [
    line(`> ${state.commandSearch}|`, theme, { fg: theme.warning, bold: true }),
    line(" ", theme),
  ];
  if (commands.length === 0) {
    rows.push(line("No matching actions.", theme, { fg: theme.muted }));
    return rows;
  }
  const rowH = Math.max(1, height - rows.length);
  const activeIdx = Math.min(state.commandIdx, commands.length - 1);
  const start = Math.max(0, Math.min(activeIdx - Math.floor(rowH / 2), Math.max(0, commands.length - rowH)));
  const titleW = Math.min(24, Math.max(12, Math.floor(width * 0.32)));
  for (const [offset, command] of commands.slice(start, start + rowH).entries()) {
    const index = start + offset;
    const active = index === activeIdx;
    const text = `${active ? ">" : " "} ${truncate(command.title, titleW).padEnd(titleW)} ${truncate(command.detail, Math.max(8, width - titleW - 4))}`;
    rows.push(line(text, theme, {
      fg: active ? theme.selectedFg : theme.primary,
      bg: active ? theme.selectedBg : undefined,
      bold: active,
    }));
  }
  return rows;
}

function renderAddressPicker({ addresses, state, width, height, theme }: {
  addresses: InboxAddressChoice[];
  state: Model;
  width: number;
  height: number;
  theme: TuiTheme;
}): FrameLine[] {
  const rows = [
    line("Choose Address", theme, { fg: theme.accentStrong, bold: true }),
    line(" ", theme),
  ];
  const rowH = Math.max(1, height - rows.length);
  const start = Math.max(0, Math.min(state.addressPickerIdx - Math.floor(rowH / 2), Math.max(0, addresses.length - rowH)));
  for (const [offset, choice] of addresses.slice(start, start + rowH).entries()) {
    const index = start + offset;
    const active = index === state.addressPickerIdx;
    rows.push(line(`${active ? ">" : " "} ${truncate(choice.label, width - 4)}`, theme, {
      fg: active ? theme.selectedFg : theme.primary,
      bg: active ? theme.selectedBg : undefined,
      bold: active,
    }));
  }
  return rows;
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

function renderSettings({ settings, addresses, width, theme }: {
  settings: TuiSettings;
  addresses: InboxAddressChoice[];
  width: number;
  theme: TuiTheme;
}): FrameLine[] {
  const defaultInbox = addressChoiceByAddress(settings.defaultAddress);
  const defaultFrom = settings.defaultFrom ?? "auto";
  const inboxLabel = addresses.find((choice) => choice.id === defaultInbox.id)?.label ?? defaultInbox.label;
  const row = (keyChar: string, labelText: string, value: string, on: boolean) => {
    const prefix = `[${keyChar}] ${labelText.padEnd(22)} `;
    return line(`${prefix}${truncate(value, Math.max(10, width - prefix.length))}`, theme, {
      fg: on ? theme.ok : theme.muted,
      bg: theme.panelAlt,
      bold: on,
    });
  };
  return [
    line("Settings", theme, { fg: theme.accentStrong, bold: true }),
    line(" ", theme),
    row("1", "Auto-pull inbound", settings.autoPull ? "ON" : "OFF", settings.autoPull),
    row("2", "Gmail auto-pull", settings.gmailAutoPull ? "ON" : "OFF", settings.gmailAutoPull),
    row("3", "Dim read messages", settings.dimRead ? "ON" : "OFF", settings.dimRead),
    row("4", "Default folder", mailboxLabel(settings.defaultMailbox), true),
    row("5", "Default inbox", inboxLabel, true),
    row("6", "Default From", defaultFrom, true),
    row("7", "Theme", `${settings.theme} -> ${theme.name}`, true),
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

function footerLine(view: View, searching: boolean, theme: TuiTheme): FrameLine {
  const hint = searching ? "type to filter - Enter apply - Esc clear"
    : view === "home" ? "up/down choose - Enter open - q quit"
    : view === "addressPicker" ? "up/down choose address - Enter apply - b back"
    : view === "commands" ? "type filter - up/down choose - Enter run - Esc close"
    : view === "compose" ? "Tab field - edit From/To/Subject/Body - Ctrl-S send - Esc cancel"
    : view === "profiles" ? "profiles - b back"
    : view === "settings" ? "1-7 change setting - b back"
    : view === "reader" ? "j/k scroll - J/K next/prev - r reply - s star - e archive - b back"
    : "up/down move - Enter open - o sort - n/N page - : commands - ]/[ folders - a address - c compose - / search - g refresh - G pull - b home";
  return line(` ${hint}`, theme, { fg: theme.muted, bg: theme.background });
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
