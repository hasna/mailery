import { For, Show, createSignal } from "solid-js";
import { TextAttributes, type MouseEvent } from "@opentui/core";
import {
  MAIL_CATEGORY_LABELS,
  isMailCategoryLabel,
  labelDisplayName,
  labelNameAliases,
  labelNameKey,
  mailboxLabel,
  type Mailbox,
} from "../../tui/data.js";
import { MAILBOXES, useEmails } from "../context/emails-state.js";
import { labelColor, selectedForeground, useTheme } from "../context/theme.js";
import { Row, SectionHeader } from "../ui/primitives.js";

const SIDEBAR_WIDE = 34;
const SYSTEM_LABEL_KEYS = new Set(["inbox", "sent", "spam", "trash", "unread", "starred", "archived", "draft", "drafts"]);

export function sidebarWidth(terminalWidth: number): number {
  return terminalWidth >= 92 ? SIDEBAR_WIDE : Math.min(34, Math.max(28, Math.floor(terminalWidth * 0.42)));
}

function CountText(props: { value: number; selected?: boolean }) {
  const theme = useTheme();
  return <text fg={props.selected ? selectedForeground(theme, theme.primary) : theme.textMuted}>{String(props.value)}</text>;
}

export function Sidebar() {
  const theme = useTheme();
  const emails = useEmails();
  const [open, setOpen] = createSignal({ mail: true, categories: true, labels: true, tools: true });
  const counts = () => emails.state.counts;
  const mailboxCount = (box: Mailbox) => counts()[box] ?? 0;
  const activeLabel = (label: string) => !!emails.state.activeLabel && labelNameKey(emails.state.activeLabel) === labelNameKey(label);
  const labelCount = (label: string) => {
    const aliases = new Set(labelNameAliases(label));
    return emails.state.labels.reduce((sum, item) => sum + (aliases.has(item.name) ? item.count : 0), 0);
  };
  const labelRows = () => emails.state.labels
    .filter((label) => !isMailCategoryLabel(label.name) && !SYSTEM_LABEL_KEYS.has(labelNameKey(label.name)))
    .slice(0, 4);

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.backgroundPanel} paddingTop={1} paddingLeft={1} paddingRight={1}>
      <box
        height={2}
        flexDirection="column"
        paddingLeft={1}
        onMouseUp={(event: MouseEvent) => {
          event.stopPropagation();
          emails.actions.openDialog("address");
        }}
      >
        <text fg={theme.text} attributes={TextAttributes.BOLD}>Emails</text>
        <text fg={theme.textMuted}>{emails.selectedAddress().label}</text>
      </box>

      <SectionHeader label={open().mail ? "Mail" : "Mail +"} onPress={() => setOpen((value) => ({ ...value, mail: !value.mail }))} />
      <Show when={open().mail}>
        <For each={MAILBOXES}>
          {(box) => {
            const active = () => emails.state.mailbox === box && emails.state.route === "mailbox";
            const fg = () => active() ? selectedForeground(theme, theme.primary) : theme.text;
            return (
            <Row active={active()} onPress={() => emails.actions.setMailbox(box)}>
              <box flexDirection="row" justifyContent="space-between" width="100%">
                <text fg={fg()} attributes={box === "unread" && mailboxCount(box) > 0 ? TextAttributes.BOLD : 0}>
                  {mailboxLabel(box)}
                </text>
                <CountText value={mailboxCount(box)} selected={active()} />
              </box>
            </Row>
          );
          }}
        </For>
      </Show>

      <SectionHeader label={open().categories ? "Categories" : "Categories +"} onPress={() => setOpen((value) => ({ ...value, categories: !value.categories }))} />
      <Show when={open().categories}>
        <For each={MAIL_CATEGORY_LABELS}>
          {(category) => {
            const active = () => activeLabel(category.name);
            const fg = () => active() ? selectedForeground(theme, theme.primary) : theme.text;
            return (
              <Row active={active()} onPress={() => emails.actions.filterLabel(category.name)}>
                <box flexDirection="row" width="100%" columnGap={1}>
                  <text fg={active() ? fg() : labelColor(theme, category.name)}>■</text>
                  <box flexGrow={1}>
                    <text fg={fg()}>{category.title}</text>
                  </box>
                  <CountText value={labelCount(category.name)} selected={active()} />
                </box>
              </Row>
            );
          }}
        </For>
      </Show>

      <SectionHeader label={open().labels ? "Labels" : "Labels +"} onPress={() => setOpen((value) => ({ ...value, labels: !value.labels }))} />
      <Show when={open().labels}>
        <For each={labelRows()}>
          {(label) => {
            const active = () => activeLabel(label.name);
            const fg = () => active() ? selectedForeground(theme, theme.primary) : theme.text;
            return (
              <Row active={active()} onPress={() => emails.actions.filterLabel(label.name)}>
                <box flexDirection="row" width="100%" columnGap={1}>
                  <text fg={active() ? fg() : labelColor(theme, label.name)}>■</text>
                  <box flexGrow={1}>
                    <text fg={fg()}>{labelDisplayName(label.name)}</text>
                  </box>
                  <CountText value={label.count} selected={active()} />
                </box>
              </Row>
            );
          }}
        </For>
      </Show>

      <SectionHeader label={open().tools ? "Actions" : "Actions +"} onPress={() => setOpen((value) => ({ ...value, tools: !value.tools }))} />
      <Show when={open().tools}>
        <Row active={emails.state.dialog === "commands"} onPress={() => emails.actions.openDialog("commands")}>
          <text fg={emails.state.dialog === "commands" ? selectedForeground(theme, theme.primary) : theme.text}>Shortcuts</text>
        </Row>
        <Row onPress={() => emails.actions.startCompose("new")}>
          <text fg={theme.text}>Compose</text>
        </Row>
        <Row active={emails.state.dialog === "address"} onPress={() => emails.actions.openDialog("address")}>
          <text fg={emails.state.dialog === "address" ? selectedForeground(theme, theme.primary) : theme.text}>All inboxes</text>
        </Row>
        <Row active={emails.state.dialog === "domains"} onPress={() => emails.actions.openDialog("domains")}>
          <text fg={emails.state.dialog === "domains" ? selectedForeground(theme, theme.primary) : theme.text}>Domains</text>
        </Row>
        <Row active={emails.state.dialog === "settings"} onPress={() => emails.actions.openDialog("settings")}>
          <text fg={emails.state.dialog === "settings" ? selectedForeground(theme, theme.primary) : theme.text}>Settings</text>
        </Row>
      </Show>

      <box flexGrow={1} />
      <box height={2} flexDirection="column" paddingLeft={1}>
        <text fg={theme.textMuted}>{emails.state.loading ? "Loading" : emails.state.busyPull ? "Pulling" : "Ready"}</text>
        <Show when={emails.state.lastError}>
          <text fg={theme.error}>{emails.state.lastError}</text>
        </Show>
      </box>

    </box>
  );
}
