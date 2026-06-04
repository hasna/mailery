import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
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
  listSources,
  getSettings,
  setSetting,
  defaultFromAddress,
  MAILBOXES,
  mailboxLabel,
  type Mailbox,
  type MailboxCounts,
  type MailboxSource,
  type TuiMessage,
  type ProfileInfo,
  type InboxSource,
  type TuiSettings,
} from "./data.js";
import { autoPull } from "./autopull.js";
import { truncate, senderName, relativeTime, formatDate, wrapText } from "./format.js";
import { nextThemeMode, resolveTheme, type TuiTheme } from "./theme.js";
import { startEventLoopWatchdog } from "./watchdog.js";

type View = "list" | "reader" | "compose" | "profiles" | "settings";
type ComposeField = "from" | "to" | "subject" | "body";

interface ComposeState {
  from: string;
  to: string;
  subject: string;
  body: string;
  field: ComposeField;
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
}

interface Model extends LoadedMailbox {
  mailbox: Mailbox;
  sourceIdx: number;
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
  | { type: "cycleSource"; delta: number; count: number }
  | { type: "clampSource"; count: number }
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
  | { type: "settingsPatch"; patch: Partial<TuiSettings> };

const CLOCK_TICK_MS = 4000;
const LOCAL_RELOAD_MS = 30000;
const PULL_MS = 45000;
const GMAIL_PULL_MS = 120000;
const AUTOPULL_START_DELAY_MS = 15000;
const USER_IDLE_MS = 1500;
const STATUS_MS = 5000;
const ALL_SOURCE: InboxSource = { id: "all", label: "All Mail" };

function useDimensions(): { cols: number; rows: number } {
  const { stdout } = useStdout();
  const [dims, setDims] = useState({ cols: stdout?.columns ?? 100, rows: stdout?.rows ?? 30 });

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setDims({ cols: stdout.columns ?? 100, rows: stdout.rows ?? 30 });
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);

  return dims;
}

function sourceToFilter(source: InboxSource | undefined): MailboxSource | undefined {
  if (!source?.providerId && !source?.domain) return undefined;
  return { providerId: source.providerId, domain: source.domain };
}

function loadMailbox(mailbox: Mailbox, search: string, source: InboxSource | undefined): LoadedMailbox {
  const filter = sourceToFilter(source);
  const messages = listMailbox(mailbox, { search: search || undefined, source: filter });
  const counts = mailboxCounts(filter ? { source: filter } : undefined);
  const allCounts = filter ? mailboxCounts() : counts;
  const hasAnyMail = Object.values(allCounts).some((n) => n > 0);
  return { messages, counts, hasAnyMail };
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
      return { ...state, mailbox: action.mailbox, selectedId: null, view: "list", readerScroll: 0 };
    case "cycleMailbox": {
      const i = MAILBOXES.indexOf(state.mailbox);
      const mailbox = MAILBOXES[(i + action.delta + MAILBOXES.length) % MAILBOXES.length]!;
      return { ...state, mailbox, selectedId: null, view: "list", readerScroll: 0 };
    }
    case "cycleSource": {
      if (action.count < 2) return state;
      const sourceIdx = (state.sourceIdx + action.delta + action.count) % action.count;
      return { ...state, sourceIdx, selectedId: null, view: "list", readerScroll: 0 };
    }
    case "clampSource": {
      if (action.count <= 0) return { ...state, sourceIdx: 0 };
      return state.sourceIdx >= action.count ? { ...state, sourceIdx: action.count - 1 } : state;
    }
    case "selectOffset":
      return { ...state, selectedId: selectWithin(state.messages, state.selectedId, action.delta) };
    case "view":
      return { ...state, view: action.view };
    case "reader":
      return { ...state, view: "reader", readerScroll: action.scroll ?? 0 };
    case "scroll":
      return { ...state, readerScroll: Math.max(0, state.readerScroll + action.delta) };
    case "searchStart":
      return { ...state, searchActive: true };
    case "searchStop":
      return { ...state, searchActive: false };
    case "searchClear":
      return { ...state, search: "", searchActive: false, selectedId: null };
    case "searchAppend":
      return { ...state, search: state.search + action.text, selectedId: null };
    case "searchBackspace":
      return { ...state, search: state.search.slice(0, -1), selectedId: null };
    case "composeStart":
      return { ...state, view: "compose", compose: action.compose };
    case "composeCancel":
      return { ...state, view: "list", compose: null };
    case "composePatch":
      return state.compose ? { ...state, compose: { ...state.compose, ...action.patch } } : state;
    case "settingsPatch":
      return { ...state, settings: { ...state.settings, ...action.patch } };
  }
}

function sameSources(a: InboxSource[], b: InboxSource[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return y && x.id === y.id && x.label === y.label && x.providerId === y.providerId && x.domain === y.domain;
  });
}

export interface AppProps {
  initialMailbox?: Mailbox;
}

export function App({ initialMailbox }: AppProps) {
  const { exit } = useApp();
  const { cols, rows } = useDimensions();
  const lastInputAt = useRef(0);
  const backgroundBusy = useRef(false);
  const initialSources = useMemo(() => listSources(), []);
  const [sources, setSources] = useState<InboxSource[]>(initialSources.length ? initialSources : [ALL_SOURCE]);
  const initialModel = useMemo<Model>(() => {
    const settings = getSettings();
    const mailbox = initialMailbox ?? settings.defaultMailbox;
    const source = initialSources[0] ?? ALL_SOURCE;
    const loaded = loadMailbox(mailbox, "", source);
    return {
      mailbox,
      sourceIdx: 0,
      selectedId: loaded.messages[0]?.id ?? null,
      view: "list",
      searchActive: false,
      search: "",
      readerScroll: 0,
      compose: null,
      settings,
      status: { text: "", tone: "info" },
      now: Date.now(),
      ...loaded,
    };
  }, []);
  const [state, dispatch] = useReducer(reducer, initialModel);

  const source = sources[state.sourceIdx] ?? sources[0] ?? ALL_SOURCE;
  const sourceKey = `${source.id}:${source.providerId ?? ""}:${source.domain ?? ""}`;
  const sourceFilter = useMemo(() => sourceToFilter(source), [sourceKey]);
  const theme = useMemo(() => resolveTheme(state.settings.theme), [state.settings.theme]);
  const sel = selectedIndex(state.messages, state.selectedId);
  const selectedMsg = state.messages[sel] ?? null;

  const flash = useCallback((text: string, tone: Status["tone"] = "info") => {
    dispatch({ type: "flash", status: { text, tone } });
  }, []);

  const reload = useCallback((preserveSelection = true, opts?: { refreshSources?: boolean }) => {
    const nextSources = opts?.refreshSources ? listSources() : sources;
    const normalizedSources = nextSources.length ? nextSources : [ALL_SOURCE];
    if (opts?.refreshSources) setSources((prev) => (sameSources(prev, normalizedSources) ? prev : normalizedSources));

    const nextSource =
      normalizedSources.find((s) => s.id === source.id) ??
      normalizedSources[state.sourceIdx] ??
      normalizedSources[0] ??
      ALL_SOURCE;
    dispatch({ type: "hydrate", loaded: loadMailbox(state.mailbox, state.search, nextSource), preserveSelection });
  }, [source.id, sources, state.mailbox, state.search, state.sourceIdx]);

  useEffect(() => {
    dispatch({ type: "clampSource", count: sources.length });
  }, [sources.length]);

  useEffect(() => {
    reload(false);
  }, [state.mailbox, state.search, sourceKey, reload]);

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
      reload(true);
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
          reload(true);
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

  const readerBody = useMemo(
    () => (state.view === "reader" && selectedMsg ? getMessageBody(selectedMsg) : null),
    [state.view, selectedMsg?.id],
  );
  const conversation = useMemo(
    () => (state.view === "reader" && selectedMsg ? getConversation(selectedMsg) : []),
    [state.view, selectedMsg?.id],
  );

  const startCompose = useCallback((replyTo?: TuiMessage) => {
    const compose: ComposeState = replyTo
      ? { ...replyDefaults(replyTo), body: "", field: "body", replyTo }
      : {
        from: defaultFromAddress({ source: sourceFilter, fallback: firstAddress(selectedMsg?.to) }),
        to: "",
        subject: "",
        body: "",
        field: "to",
      };
    dispatch({ type: "composeStart", compose });
  }, [selectedMsg?.to, sourceFilter]);

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
        providerId: source.providerId,
      });
      dispatch({ type: "composeCancel" });
      flash("sent", "ok");
      reload(false);
    } catch (e) {
      flash((e instanceof Error ? e.message : String(e)).slice(0, 64), "err");
    }
  }, [flash, reload, source.providerId, state.compose]);

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

  const cycleTheme = useCallback(() => {
    const next = nextThemeMode(state.settings.theme);
    setSetting("theme", next);
    dispatch({ type: "settingsPatch", patch: { theme: next } });
    flash(`theme: ${next}`, "ok");
  }, [flash, state.settings.theme]);

  useInput((input, key) => {
    lastInputAt.current = Date.now();
    if (key.ctrl && input === "c") {
      exit();
      return;
    }

    if (state.view === "compose" && state.compose) {
      handleComposeInput(input, key, state.compose, dispatch, sendDraft, flash);
      return;
    }

    if (state.searchActive) {
      handleSearchInput(input, key, dispatch);
      return;
    }

    if (state.view === "settings") {
      if (input === "q" || input === "," || key.escape) dispatch({ type: "view", view: "list" });
      else if (input === "1") toggleSetting("autoPull");
      else if (input === "2") toggleSetting("gmailAutoPull");
      else if (input === "3") toggleSetting("dimRead");
      else if (input === "4") {
        const i = MAILBOXES.indexOf(state.settings.defaultMailbox);
        setDefaultMailbox(MAILBOXES[(i + 1) % MAILBOXES.length]!);
      }
      else if (input === "5") cycleTheme();
      return;
    }

    if (state.view === "profiles") {
      if (input === "q" || input === "p" || key.escape) dispatch({ type: "view", view: "list" });
      return;
    }

    if (input === "q") {
      if (state.view === "reader") dispatch({ type: "view", view: "list" });
      else exit();
      return;
    }
    if (input === "c") { startCompose(); return; }
    if (input === "p") { dispatch({ type: "view", view: "profiles" }); return; }
    if (input === ",") { dispatch({ type: "view", view: "settings" }); return; }
    if (input === "a" || input === "A") { dispatch({ type: "cycleSource", delta: input === "a" ? 1 : -1, count: sources.length }); return; }
    if (input === "g") {
      flash("refreshing");
      reload(true, { refreshSources: true });
      flash("refreshed", "ok");
      return;
    }
    if (input === "G") {
      flash("pulling");
      void autoPull({ limit: 1000 })
        .then((r) => { reload(true, { refreshSources: true }); flash(r.pulled ? `pulled ${r.pulled} new` : "up to date", "ok"); })
        .catch((e) => { reload(true); flash(e instanceof Error ? e.message.slice(0, 64) : String(e).slice(0, 64), "err"); });
      return;
    }

    if (state.view === "reader") {
      if (key.upArrow || input === "k") dispatch({ type: "scroll", delta: -1 });
      else if (key.downArrow || input === "j") dispatch({ type: "scroll", delta: 1 });
      else if (key.escape || key.leftArrow || input === "h") dispatch({ type: "view", view: "list" });
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
    else if (input >= "1" && input <= "5") dispatch({ type: "setMailbox", mailbox: MAILBOXES[Number(input) - 1]! });
    else if (input === "s") mutateSelected("star");
    else if (input === "e") mutateSelected("archive");
    else if (input === "u") mutateSelected("read");
    else if (input === "r" && selectedMsg) startCompose(selectedMsg);
    else if (input === "/") dispatch({ type: "searchStart" });
  });

  const innerW = Math.max(24, cols - 4);
  const contentH = Math.max(4, rows - 6);
  const content =
    state.view === "compose" && state.compose ? <Compose compose={state.compose} width={innerW} height={contentH} theme={theme} /> :
    state.view === "settings" ? <Settings settings={state.settings} width={innerW} height={contentH} theme={theme} /> :
    state.view === "profiles" ? <Profiles width={innerW} height={contentH} theme={theme} /> :
    state.view === "reader" ? <Reader body={readerBody} conversation={conversation} scroll={state.readerScroll} width={innerW} height={contentH} theme={theme} /> :
    <List
      messages={state.messages}
      sel={sel}
      now={state.now}
      width={innerW}
      height={contentH}
      searching={state.searchActive}
      search={state.search}
      dimRead={state.settings.dimRead}
      emptyStore={!state.hasAnyMail}
      theme={theme}
    />;

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Tabs mailbox={state.mailbox} counts={state.counts} status={state.status} cols={cols} source={source} sourceCount={sources.length} theme={theme} />
      <Box borderStyle="round" borderColor={theme.border} paddingX={1} flexGrow={1}>{content}</Box>
      <Footer view={state.view} searching={state.searchActive} theme={theme} />
    </Box>
  );
}

function handleSearchInput(
  input: string,
  key: { return?: boolean; escape?: boolean; backspace?: boolean; delete?: boolean },
  dispatch: (action: Action) => void,
) {
  if (key.escape) { dispatch({ type: "searchClear" }); return; }
  if (key.return) { dispatch({ type: "searchStop" }); return; }
  if (key.backspace || key.delete) { dispatch({ type: "searchBackspace" }); return; }
  if (input) dispatch({ type: "searchAppend", text: input });
}

function handleComposeInput(
  input: string,
  key: { return?: boolean; escape?: boolean; tab?: boolean; shift?: boolean; backspace?: boolean; delete?: boolean; ctrl?: boolean },
  compose: ComposeState,
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

  const order: ComposeField[] = ["from", "to", "subject", "body"];
  const i = order.indexOf(compose.field);
  if (key.tab) {
    const next = key.shift ? (i + order.length - 1) % order.length : (i + 1) % order.length;
    dispatch({ type: "composePatch", patch: { field: order[next]! } });
    return;
  }
  if (key.backspace || key.delete) {
    const field = compose.field;
    dispatch({ type: "composePatch", patch: { [field]: compose[field].slice(0, -1) } });
    return;
  }
  if (key.return) {
    if (compose.field === "body") {
      dispatch({ type: "composePatch", patch: { body: `${compose.body}\n` } });
    } else {
      dispatch({ type: "composePatch", patch: { field: order[Math.min(order.length - 1, i + 1)]! } });
    }
    return;
  }
  if (input && !key.ctrl) {
    const field = compose.field;
    dispatch({ type: "composePatch", patch: { [field]: compose[field] + input } });
  }
}

function Tabs({
  mailbox,
  counts,
  status,
  cols,
  source,
  sourceCount,
  theme,
}: {
  mailbox: Mailbox;
  counts: MailboxCounts;
  status: Status;
  cols: number;
  source: InboxSource;
  sourceCount: number;
  theme: TuiTheme;
}) {
  const tone = status.tone === "ok" ? theme.ok : status.tone === "err" ? theme.error : theme.warning;
  return (
    <Box flexDirection="column" width={cols}>
      <Box width={cols} paddingX={1} justifyContent="space-between">
        <Box>
          {MAILBOXES.map((m, i) => {
            const active = m === mailbox;
            const n = counts[m];
            return (
              <Text key={m}>
                {i > 0 ? <Text> </Text> : null}
                <Text color={active ? theme.activeFg : theme.primary} backgroundColor={active ? theme.activeBg : undefined} bold={active}>
                  {" "}{mailboxLabel(m)}{n ? ` ${n}` : ""}{" "}
                </Text>
              </Text>
            );
          })}
        </Box>
        <Text color={tone} bold>{status.text}</Text>
      </Box>
      <Box width={cols} paddingX={1}>
        <Text color={theme.sourceFg} backgroundColor={theme.sourceBg} bold>{" "}{source.label}{" "}</Text>
        {sourceCount > 1 ? <Text color={theme.primary}> <Text color={theme.muted}>press</Text> a <Text color={theme.muted}>to switch inbox</Text></Text> : null}
      </Box>
    </Box>
  );
}

function List({
  messages,
  sel,
  now,
  width,
  height,
  searching,
  search,
  dimRead,
  emptyStore,
  theme,
}: {
  messages: TuiMessage[];
  sel: number;
  now: number;
  width: number;
  height: number;
  searching: boolean;
  search: string;
  dimRead: boolean;
  emptyStore: boolean;
  theme: TuiTheme;
}) {
  const rowH = Math.max(1, searching ? height - 1 : height);
  const start = Math.max(0, Math.min(sel - Math.floor(rowH / 2), Math.max(0, messages.length - rowH)));
  const win = messages.slice(start, start + rowH);
  const whoW = Math.min(24, Math.max(12, Math.floor(width * 0.24)));
  const timeW = 6;
  const subjW = Math.max(8, width - whoW - timeW - 7);

  return (
    <Box flexDirection="column" width={width}>
      {searching ? <Text color={theme.warning}>/ {search}<Text color={theme.accentStrong}>|</Text></Text> : null}
      {messages.length === 0 ? (
        emptyStore ? (
          <Box flexDirection="column">
            <Text color={theme.warning} bold>No mail synced on this machine yet.</Text>
            <Text> </Text>
            <Text color={theme.primary}>Pull mail into the local store, then press g here to refresh.</Text>
            <Text>  <Text color={theme.accentStrong}>emails inbox sync --all-profiles --all</Text><Text color={theme.muted}>   Gmail</Text></Text>
            <Text>  <Text color={theme.accentStrong}>emails inbox sync-s3 --bucket &lt;bucket&gt;</Text><Text color={theme.muted}>     SES/S3 inbound</Text></Text>
            <Text>  <Text color={theme.accentStrong}>emails cloud pull</Text><Text color={theme.muted}>                          RDS cloud sync</Text></Text>
          </Box>
        ) : <Text color={theme.primary}>No messages in this folder/source.</Text>
      ) : win.map((m, i) => {
        const selected = start + i === sel;
        const who = (m.sentByMe ? "-> " : "") + senderName(m.sentByMe ? m.to : m.from);
        const subjCell = m.attachments > 0 ? `[${m.attachments}] ${m.subject}` : m.subject;
        const faded = dimRead && m.is_read && !selected;
        const primary = selected ? theme.selectedFg : faded ? theme.dimRead : theme.primary;
        return (
          <Text key={m.id} wrap="truncate" backgroundColor={selected ? theme.selectedBg : undefined}>
            <Text color={m.is_starred ? theme.star : selected ? theme.selectedFg : theme.muted}>{m.is_starred ? "*" : " "}</Text>
            <Text color={m.is_read ? (selected ? theme.selectedFg : theme.muted) : theme.unread} bold={!m.is_read}>{m.is_read ? " " : "!"}</Text>{" "}
            <Text bold={!m.is_read} color={primary}>{truncate(who, whoW).padEnd(whoW)}</Text>{" "}
            <Text bold={!m.is_read} color={selected ? theme.selectedFg : faded ? theme.dimRead : theme.primary}>{truncate(subjCell, subjW).padEnd(subjW)}</Text>{" "}
            <Text color={selected ? theme.selectedFg : theme.muted}>{relativeTime(m.date, now).padStart(timeW)}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function Reader({
  body,
  conversation,
  scroll,
  width,
  height,
  theme,
}: {
  body: ReturnType<typeof getMessageBody>;
  conversation: ReturnType<typeof getConversation>;
  scroll: number;
  width: number;
  height: number;
  theme: TuiTheme;
}) {
  if (!body) return <Text dimColor>No message selected.</Text>;
  const text = body.text ?? (body.html ? body.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "(no text content)");
  const atts = body.attachments ?? [];
  const attH = atts.length ? Math.min(atts.length, 6) + 1 : 0;
  const headerH = 4 + (conversation.length > 1 ? 1 : 0) + attH;
  const lines = wrapText(text, Math.max(20, width), 5000);
  const avail = Math.max(2, height - headerH - 1);
  const safeScroll = Math.min(scroll, Math.max(0, lines.length - avail));
  const view = lines.slice(safeScroll, safeScroll + avail);
  const addr = body.from.replace(/.*</, "").replace(/>.*/, "");

  return (
    <Box flexDirection="column" width={width}>
      <Text bold color={theme.primary} wrap="truncate">{body.subject}</Text>
      <Text color={theme.primary} wrap="truncate"><Text color={theme.muted}>from </Text>{senderName(body.from)}{addr !== senderName(body.from) ? <Text color={theme.muted}> {addr}</Text> : null}</Text>
      <Text color={theme.primary} wrap="truncate"><Text color={theme.muted}>to   </Text>{truncate(body.to, width - 5)}</Text>
      <Text color={theme.muted}>{formatDate(body.date)} - {body.flags.join(", ")}</Text>
      {conversation.length > 1 ? <Text color={theme.sourceBg}>{conversation.length} in thread</Text> : null}
      {atts.length > 0 ? <Text color={theme.warning}>{atts.length} attachment{atts.length > 1 ? "s" : ""}:</Text> : null}
      {atts.slice(0, 6).map((a, i) => (
        <Text key={i} color={theme.primary} wrap="truncate"><Text color={theme.muted}> - </Text>{truncate(a.filename, width - 28)} <Text color={theme.muted}>{bytes(a.size)} - {a.content_type.split("/").pop()}{a.location ? " saved" : ""}</Text></Text>
      ))}
      <Text> </Text>
      {view.map((l, i) => <Text key={i} color={theme.primary} wrap="truncate">{l || " "}</Text>)}
      {safeScroll + avail < lines.length ? <Text color={theme.muted}>{lines.length - safeScroll - avail} more - j/k to scroll</Text> : null}
    </Box>
  );
}

function Profiles({ width, height, theme }: { width: number; height: number; theme: TuiTheme }) {
  const profiles = listProfiles();
  const byProvider = new Map<string, ProfileInfo[]>();
  for (const p of profiles) {
    const list = byProvider.get(p.provider) ?? [];
    list.push(p);
    byProvider.set(p.provider, list);
  }

  const rows: ReactNode[] = [];
  for (const [provider, list] of byProvider) {
    rows.push(<Text key={`h-${provider}`} bold color={theme.sourceBg}>{provider.toUpperCase()}</Text>);
    for (const p of list) {
      rows.push(<Text key={p.id} color={theme.primary} wrap="truncate">  <Text color={theme.accentStrong}>{p.name}</Text>{p.active ? "" : <Text color={theme.muted}> (inactive)</Text>}</Text>);
      if (p.domains.length) rows.push(<Text key={`${p.id}-domains`} color={theme.primary} wrap="truncate"><Text color={theme.muted}>    domains:   </Text>{truncate(p.domains.join(", "), width - 14)}</Text>);
      if (p.addresses.length) rows.push(<Text key={`${p.id}-addresses`} color={theme.primary} wrap="truncate"><Text color={theme.muted}>    addresses: </Text>{truncate(p.addresses.join(", "), width - 14)} <Text color={theme.muted}>({p.addresses.length})</Text></Text>);
      if (!p.domains.length && !p.addresses.length) rows.push(<Text key={`${p.id}-empty`} color={theme.muted}>    (no domains/addresses)</Text>);
    }
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text bold color={theme.primary}>Profiles <Text color={theme.muted}>accounts, domains, addresses</Text></Text>
      <Text> </Text>
      {rows.slice(0, height - 3)}
    </Box>
  );
}

function Settings({ settings, width, height, theme }: { settings: TuiSettings; width: number; height: number; theme: TuiTheme }) {
  const row = (keyChar: string, label: string, value: string, on: boolean) => (
    <Text wrap="truncate">
      <Text color={theme.activeFg} backgroundColor={theme.activeBg} bold>{" "}{keyChar}{" "}</Text>{"  "}
      <Text color={theme.primary}>{label.padEnd(22)}</Text>
      <Text color={on ? theme.ok : theme.muted} bold>{value}</Text>
    </Text>
  );

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text bold color={theme.primary}>Settings <Text color={theme.muted}>number keys change values, q/Esc goes back</Text></Text>
      <Text> </Text>
      {row("1", "Auto-pull inbound", settings.autoPull ? "ON" : "OFF", settings.autoPull)}
      {row("2", "Gmail auto-pull", settings.gmailAutoPull ? "ON" : "OFF", settings.gmailAutoPull)}
      {row("3", "Dim read messages", settings.dimRead ? "ON" : "OFF", settings.dimRead)}
      {row("4", "Default folder", mailboxLabel(settings.defaultMailbox), true)}
      {row("5", "Theme", `${settings.theme} -> ${theme.name}`, true)}
      <Text> </Text>
      <Text color={theme.muted}>Auto-pull checks SES/S3 every 12s and Gmail every 45s. Switch inbox source with a.</Text>
    </Box>
  );
}

function Compose({ compose, width, height, theme }: { compose: ComposeState; width: number; height: number; theme: TuiTheme }) {
  const cursor = (f: ComposeField) => (compose.field === f ? <Text color={theme.accentStrong}>|</Text> : null);
  const field = (f: ComposeField, v: string) => (
    <Text wrap="truncate">
      <Text color={compose.field === f ? theme.accentStrong : theme.muted} bold>{f.padEnd(8)}</Text>
      <Text color={theme.primary}>
      {truncate(v, Math.max(8, width - 10))}{cursor(f)}
      </Text>
    </Text>
  );
  const bodyLines = (compose.body || "").split("\n");
  const bodyH = Math.max(1, height - 6);
  const start = Math.max(0, bodyLines.length - bodyH);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text color={theme.sourceBg} bold>{compose.replyTo ? "Reply" : "New message"} <Text color={theme.muted}>markdown body, Ctrl-S sends</Text></Text>
      {field("from", compose.from)}
      {field("to", compose.to)}
      {field("subject", compose.subject)}
      <Text color={theme.muted}>{"-".repeat(Math.min(width, 60))}</Text>
      {bodyLines.slice(start, start + bodyH).map((line, i) => {
        const absolute = start + i;
        const isLast = absolute === bodyLines.length - 1;
        return (
          <Text key={absolute} color={theme.primary} wrap="truncate">
            {truncate(line || " ", width)}
            {compose.field === "body" && isLast ? <Text color={theme.accentStrong}>|</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}

function Footer({ view, searching, theme }: { view: View; searching: boolean; theme: TuiTheme }) {
  const hint = searching ? "type to filter - Enter apply - Esc clear"
    : view === "compose" ? "Tab field - edit From/To/Subject/Body - Ctrl-S send - Esc cancel"
    : view === "profiles" ? "profiles/accounts - p or Esc back"
    : view === "settings" ? "1-5 toggle a setting - q or Esc back"
    : view === "reader" ? "j/k scroll - J/K next/prev - r reply - s star - e archive - Esc back"
    : "up/down move - Enter open - ]/[ folders - a inbox - c compose - p profiles - , settings - / search - g refresh - G pull - q quit";
  return <Box paddingX={1}><Text color={theme.muted}>{hint}</Text></Box>;
}
