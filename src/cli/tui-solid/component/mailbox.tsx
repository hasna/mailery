import { For, Show } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { useMailery } from "../context/mailery-state.js";
import { labelColor, selectedForeground, useTheme } from "../context/theme.js";
import { Button, EmptyState, Row } from "../ui/primitives.js";
import { bareAddress, listDateTime, truncate } from "../../tui/format.js";
import { isImportantMessage, labelDisplayName, mailboxGroupModeLabel } from "../../tui/data.js";
import { sidebarWidth } from "./sidebar.js";
import { useToast } from "../context/toast.js";

interface MailboxColumns {
  from: number;
  to: number;
  subject: number;
  date: number;
}

function MessageRow(props: { message: ReturnType<typeof useMailery>["state"]["messages"][number]; selected: boolean; showTo: boolean; columns: MailboxColumns }) {
  const theme = useTheme();
  const mailery = useMailery();
  const message = () => props.message;
  const unread = () => !message().is_read;
  const rowBg = () => props.selected ? theme.primary : undefined;
  const rowFg = () => props.selected ? selectedForeground(theme, rowBg()) : theme.text;
  const dateText = () => listDateTime(message().date, mailery.state.now).padStart(props.columns.date);

  return (
    <Row active={props.selected} onPress={() => mailery.actions.selectMessage(message().id)}>
      <box flexDirection="row" width="100%" columnGap={1} backgroundColor={rowBg()}>
        <box width={2} flexShrink={0}>
          <Show when={isImportantMessage(message())}>
            <text fg={props.selected ? rowFg() : theme.warning}>■</text>
          </Show>
        </box>
        <box width={props.columns.from} flexShrink={0}>
          <text fg={rowFg()} attributes={unread() ? TextAttributes.BOLD : 0}>
            {truncate(bareAddress(message().from), props.columns.from)}
          </text>
        </box>
        <Show when={props.showTo}>
          <box width={props.columns.to} flexShrink={0}>
            <text fg={props.selected ? rowFg() : theme.textMuted}>{truncate(bareAddress(message().to), props.columns.to)}</text>
          </box>
        </Show>
        <box width={props.columns.subject} flexShrink={0}>
          <text fg={rowFg()} attributes={unread() ? TextAttributes.BOLD : 0}>
            {truncate(message().subject || "(no subject)", props.columns.subject)}
          </text>
        </box>
        <box width={props.columns.date} flexShrink={0}>
          <text fg={props.selected ? rowFg() : theme.textMuted}>{truncate(dateText(), props.columns.date)}</text>
        </box>
      </box>
    </Row>
  );
}

export function MailboxRoute() {
  const theme = useTheme();
  const mailery = useMailery();
  const toast = useToast();
  const dimensions = useTerminalDimensions();
  const showTo = () => !mailery.selectedAddress().address && dimensions().width >= 108;
  const contentWidth = () => Math.max(48, dimensions().width - sidebarWidth(dimensions().width) - 6);
  const emptyDetail = () => {
    if (mailery.state.search && mailery.state.activeLabel) return "No messages match this search and label.";
    if (mailery.state.search) return "No messages match this search.";
    if (mailery.state.activeLabel) return `No messages match ${labelDisplayName(mailery.state.activeLabel)}.`;
    return "Pull mail or choose another inbox.";
  };
  const columns = (): MailboxColumns => {
    const width = contentWidth();
    const date = 10;
    if (!showTo()) {
      const targetFrom = width < 64 ? 20 : width < 82 ? 32 : width < 110 ? 40 : 48;
      const from = Math.max(16, Math.min(targetFrom, width - date - 17));
      return {
        from,
        to: 0,
        subject: Math.max(14, width - from - date - 5),
        date,
      };
    }
    const minSubject = 14;
    const availableForAddresses = Math.max(34, width - date - minSubject - 6);
    const targetFrom = width < 76 ? 24 : width < 96 ? 28 : 36;
    const targetTo = width < 76 ? 24 : width < 96 ? 28 : 34;
    const from = Math.max(18, Math.min(targetFrom, Math.floor(availableForAddresses * 0.52)));
    const to = Math.max(16, Math.min(targetTo, availableForAddresses - from));
    return {
      from,
      to,
      subject: Math.max(14, width - from - to - date - 6),
      date,
    };
  };
  const pullNow = async () => {
    toast.show({ title: "Pulling mail", message: "Syncing configured inboxes.", tone: "info" });
    const result = await mailery.actions.pullNow();
    toast.show({
      title: result.ok ? "Pull complete" : "Pull failed",
      message: result.ok ? `${result.pulled} message${result.pulled === 1 ? "" : "s"} pulled.` : result.reason ?? "Pull could not run.",
      tone: result.ok ? "success" : "error",
    });
  };

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.background} paddingTop={1} paddingLeft={2} paddingRight={2}>
      <box height={2} flexDirection="row" justifyContent="space-between">
        <box flexDirection="row" columnGap={1}>
          <Button label={mailery.state.sort === "newest" ? "Newest first" : "Oldest first"} onPress={() => mailery.actions.cycleSort()} />
          <Button
            label="Filter"
            active={!!mailery.state.search || !!mailery.state.activeLabel || mailery.state.mailbox !== "inbox"}
            onPress={() => mailery.actions.openDialog("filter")}
          />
          <Button
            label="Group"
            active={mailery.state.groupMode !== "none"}
            onPress={() => mailery.actions.openDialog("group")}
          />
          <Button label="Search" onPress={() => mailery.actions.openDialog("search")} />
          <Button label="Digest" onPress={() => mailery.actions.openDialog("digest")} />
          <Button label="Pull" onPress={() => void pullNow()} />
        </box>
        <text fg={theme.textMuted}>Page {mailery.state.page + 1}</text>
      </box>

      <box height={1} />

      <box height={1} flexDirection="row" columnGap={1} paddingLeft={1}>
        <box width={2} flexShrink={0} />
        <box width={columns().from} flexShrink={0}>
          <text fg={theme.textMuted}>From</text>
        </box>
        <Show when={showTo()}>
          <box width={columns().to} flexShrink={0}>
            <text fg={theme.textMuted}>To</text>
          </box>
        </Show>
        <box width={columns().subject} flexShrink={0}>
          <text fg={theme.textMuted}>Subject</text>
        </box>
        <box width={columns().date} flexShrink={0}>
          <text fg={theme.textMuted}>{"Date".padStart(columns().date)}</text>
        </box>
      </box>

      <Show
        when={mailery.state.messages.length > 0}
        fallback={<EmptyState title="No messages" detail={emptyDetail()} />}
      >
        <scrollbox flexGrow={1} width="100%">
          <For each={mailery.groupedMessages()}>
            {(group) => (
              <>
                <Show when={mailery.state.groupMode !== "none"}>
                  <box height={1} paddingLeft={1}>
                    <text fg={theme.textMuted}>{group.title}</text>
                  </box>
                </Show>
                <For each={group.messages}>
                  {(message) => <MessageRow message={message} selected={mailery.state.selectedMessageId === message.id} showTo={showTo()} columns={columns()} />}
                </For>
              </>
            )}
          </For>
        </scrollbox>
      </Show>

      <box height={1} />
      <box height={2} flexDirection="row" columnGap={1}>
        <Button label="Previous page" onPress={() => mailery.actions.page(-1)} />
        <Button label="Next page" active={mailery.state.hasMore} onPress={() => mailery.actions.page(1)} />
        <Button label="Open" onPress={() => mailery.actions.openMessage()} />
        <Button label="Label" onPress={() => mailery.actions.openDialog("labels")} />
        <Show when={mailery.state.search}>
          <text fg={theme.textMuted}>Search: {mailery.state.search}</text>
        </Show>
        <Show when={mailery.state.activeLabel}>
          <text fg={theme.textMuted}>Label: {labelDisplayName(mailery.state.activeLabel!)}</text>
        </Show>
        <Show when={mailery.state.groupMode !== "none"}>
          <text fg={theme.textMuted}>Group: {mailboxGroupModeLabel(mailery.state.groupMode)}</text>
        </Show>
      </box>

      <box height={1} flexDirection="row" columnGap={1}>
        <For each={(mailery.selectedMessage()?.labels ?? []).slice(0, 8)}>
          {(label) => (
            <box flexDirection="row" columnGap={1}>
              <text fg={labelColor(theme, label)}>■</text>
              <text fg={theme.textMuted}>{labelDisplayName(label)}</text>
            </box>
          )}
        </For>
      </box>
    </box>
  );
}
