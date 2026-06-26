import { For, Show, createEffect, createMemo, createSignal, untrack } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import { useMailery, COMMON_LABELS, MAILBOXES } from "../context/mailery-state.js";
import { useCommands } from "../context/commands.js";
import { labelColor, useTheme } from "../context/theme.js";
import { useDialog } from "../context/dialog.js";
import { SelectDialog, type SelectDialogItem } from "../ui/select-dialog.js";
import { copyTextToClipboardAsync } from "../../tui/clipboard.js";
import { useToast } from "../context/toast.js";
import { Button, EmptyState, Row } from "../ui/primitives.js";
import { labelDisplayName, mailboxGroupModeLabel, mailboxLabel, MAILBOX_GROUP_MODES, type Mailbox, type MailboxGroupMode } from "../../tui/data.js";
import { formatDate, wrapText } from "../../tui/format.js";
import { formatAttachmentSize, mergeAttachmentDetails, type AttachmentDetail, type AttachmentPathLike } from "../../../lib/attachment-actions.js";
import { openLocalTarget } from "../../../lib/local-actions.js";
import { ensureEmailAgentSettings } from "../../../db/email-agents.js";
import { emailDigestPeriodLabel, type EmailDigestPeriod } from "../../../db/email-digests.js";
import { DEFAULT_GROQ_EMAIL_AGENT_MODEL } from "../../../lib/mailery-ai.js";

export function MaileryDialogs() {
  const mailery = useMailery();
  const commands = useCommands();
  const dialog = useDialog();
  const theme = useTheme();
  const toast = useToast();

  const close = () => {
    mailery.actions.closeDialog();
    dialog.clear();
  };

  const commandItems = createMemo<SelectDialogItem[]>(() => commands.visibleCommands().map((command) => ({
    id: command.id,
    title: command.title,
    detail: command.category,
    category: command.category,
  })));

  const addressItems = createMemo<SelectDialogItem[]>(() => mailery.state.addresses.map((address) => ({
    id: address.id,
    title: address.label,
    detail: inboxDetail(address),
    marker: mailery.state.selectedAddressId === address.id ? "●" : " ",
    markerColor: theme.primary,
  })));

  const labelItems = createMemo<SelectDialogItem[]>(() => {
    const selected = new Set(mailery.selectedMessage()?.labels.map((label) => label.toLowerCase()) ?? []);
    const summaries = mailery.state.labels.map((label) => ({
      id: label.name,
      title: labelDisplayName(label.name),
      detail: label.popular ? `${label.count} selected` : label.count ? String(label.count) : "",
      category: label.popular ? "Popular" : "Labels",
      marker: selected.has(label.name.toLowerCase()) ? "■" : "□",
      markerColor: labelColor(theme, label.name),
    }));
    const existing = new Set(summaries.map((item) => item.id));
    const common = COMMON_LABELS.filter((label) => !existing.has(label)).map((label) => ({
      id: label,
      title: labelDisplayName(label),
      detail: "",
      category: "Common",
      marker: selected.has(label.toLowerCase()) ? "■" : "□",
      markerColor: labelColor(theme, label),
    }));
    const q = mailery.state.labelSearch.trim();
    const custom = q && !existing.has(q.toLowerCase().replace(/\s+/g, "-")) ? [{
      id: q,
      title: `Create ${labelDisplayName(q)}`,
      detail: "new label",
      category: "Create",
      marker: "+",
      markerColor: theme.primary,
    }] : [];
    return [...summaries, ...common, ...custom];
  });

  const linkItems = createMemo<SelectDialogItem[]>(() => mailery.links().map((link, index) => ({
    id: String(index),
    title: link.text || link.url,
    detail: link.url,
    category: link.source,
    marker: "↗",
    markerColor: theme.secondary,
  })));

  const attachmentDetails = createMemo<AttachmentDetail[]>(() => {
    const attachments = mailery.selectedBody()?.attachments ?? [];
    return mergeAttachmentDetails(
      attachments.map((attachment) => ({
        filename: attachment.filename,
        content_type: attachment.content_type,
        size: attachment.size,
      })),
      attachments.flatMap((attachment): AttachmentPathLike[] => {
        if (!attachment.location) return [];
        if (attachment.location.startsWith("s3://")) {
          return [{ filename: attachment.filename, content_type: attachment.content_type, s3_url: attachment.location }];
        }
        return [{ filename: attachment.filename, content_type: attachment.content_type, local_path: attachment.location }];
      }),
    );
  });

  const attachmentItems = createMemo<SelectDialogItem[]>(() => attachmentDetails().map((attachment, index) => ({
    id: String(index),
    title: attachment.filename,
    detail: [attachment.file_url ?? attachment.location, attachment.content_type, formatAttachmentSize(attachment.size)].filter(Boolean).join(" · "),
    category: attachment.location_type === "local" ? "Local" : attachment.location_type === "s3" ? "S3" : "Attachment",
    marker: attachment.openable ? "↗" : "□",
    markerColor: attachment.openable ? theme.secondary : theme.textMuted,
  })));

  createEffect(() => {
    const kind = mailery.state.dialog;
    untrack(() => {
      if (kind === null) {
        dialog.clear();
        return;
      }

    if (kind === "commands") {
      dialog.replace(() => (
        <SelectDialog
          title="Shortcuts"
          placeholder="Search commands"
          items={commandItems()}
          query={mailery.state.commandSearch}
          onQuery={mailery.actions.setCommandSearch}
          onSelect={(item) => {
            close();
            void commands.runCommand(item.id);
          }}
          onClose={close}
          footer="Use buttons, command palette, and safe global bindings. Single-letter shortcuts are disabled."
        />
      ), { size: "large", onClose: mailery.actions.closeDialog });
      return;
    }

    if (kind === "address") {
      dialog.replace(() => (
        <SelectDialog
          title="Inboxes"
          placeholder="Search inboxes"
          items={addressItems()}
          query={mailery.state.addressSearch}
          onQuery={mailery.actions.setAddressSearch}
          onSelect={(item) => {
            mailery.actions.setAddress(item.id);
            close();
          }}
          onClose={close}
        />
      ), { size: "large", onClose: mailery.actions.closeDialog });
      return;
    }

    if (kind === "filter") {
      dialog.replace(() => <FilterDialog close={close} />, { size: "large", onClose: mailery.actions.closeDialog });
      return;
    }

    if (kind === "group") {
      dialog.replace(() => <GroupDialog close={close} />, { size: "large", onClose: mailery.actions.closeDialog });
      return;
    }

    if (kind === "digest") {
      dialog.replace(() => <DigestDialog close={close} />, { size: "large", onClose: mailery.actions.closeDialog });
      return;
    }

    if (kind === "search") {
      dialog.replace(() => (
        <box flexDirection="column" width="100%" rowGap={1}>
          <box height={1} flexDirection="row" justifyContent="space-between">
            <text fg={theme.text}>Search Mail</text>
            <Button label="Close" onPress={close} />
          </box>
          <input
            focused
            value={mailery.state.searchDraft}
            placeholder="Search subject, sender, recipient, body"
            width="100%"
            textColor={theme.text}
            backgroundColor={theme.backgroundElement}
            focusedTextColor={theme.text}
            focusedBackgroundColor={theme.backgroundActive}
            placeholderColor={theme.textMuted}
            cursorColor={theme.text}
            onInput={mailery.actions.setSearchDraft}
            onSubmit={(value) => {
              mailery.actions.search(String(value));
              close();
            }}
          />
          <box height={1} flexDirection="row" columnGap={1}>
            <Button label="Apply" active onPress={() => {
              mailery.actions.search(mailery.state.searchDraft);
              close();
            }} />
            <Button label="Clear" onPress={() => {
              mailery.actions.search("");
              close();
            }} />
          </box>
        </box>
      ), { size: "large", onClose: mailery.actions.closeDialog });
      return;
    }

    if (kind === "domains") {
      dialog.replace(() => <DomainsDialog close={close} />, { size: "large", onClose: mailery.actions.closeDialog });
      return;
    }

    if (kind === "settings") {
      dialog.replace(() => <SettingsDialog close={close} />, { size: "large", onClose: mailery.actions.closeDialog });
      return;
    }

    if (kind === "labels") {
      dialog.replace(() => (
        <SelectDialog
          title="Labels"
          placeholder="Search or create label"
          items={labelItems()}
          query={mailery.state.labelSearch}
          onQuery={mailery.actions.setLabelSearch}
          onSelect={(item) => {
            mailery.actions.toggleSelectedLabel(item.id);
            toast.show({ title: "Label updated", message: labelDisplayName(item.id), tone: "success" });
            close();
          }}
          onClose={close}
        />
      ), { size: "large", onClose: mailery.actions.closeDialog });
      return;
    }

    if (kind === "links") {
      dialog.replace(() => (
        <box flexDirection="column" width="100%" rowGap={1}>
          <SelectDialog
            title="Links"
            placeholder="Filter links"
            items={linkItems()}
            query=""
            onQuery={() => undefined}
            onSelect={(item) => {
              const link = mailery.links()[Number(item.id)];
              if (!link) return;
              void copyTextToClipboardAsync(link.url).then((result) => {
                toast.show({
                  title: result.ok ? "Link copied" : "Copy failed",
                  message: result.ok ? link.url : result.error ?? "Clipboard unavailable",
                  tone: result.ok ? "success" : "error",
                });
              });
              close();
            }}
            onClose={close}
          />
          <Show when={mailery.links().length > 0}>
            <Button
              label="Open first link"
              onPress={() => {
                const link = mailery.links()[0];
                if (!link) return;
                const result = openLocalTarget(link.url);
                toast.show({
                  title: result.ok ? "Link opened" : "Open failed",
                  message: result.ok ? link.url : result.error ?? "Could not open link.",
                  tone: result.ok ? "success" : "error",
                });
                close();
              }}
            />
          </Show>
          <Button
            label="Copy all links"
            onPress={() => {
              const links = mailery.links().map((link) => link.url).join("\n");
              void copyTextToClipboardAsync(links).then((result) => {
                toast.show({ title: result.ok ? "Links copied" : "Copy failed", message: `${mailery.links().length} link(s)`, tone: result.ok ? "success" : "error" });
              });
              close();
            }}
          />
          <For each={mailery.links().length === 0 ? ["No links detected."] : []}>
            {(message) => <text fg={theme.textMuted}>{message}</text>}
          </For>
        </box>
      ), { size: "large", onClose: mailery.actions.closeDialog });
      return;
    }

    if (kind === "attachments") {
      dialog.replace(() => <AttachmentsDialog close={close} attachments={attachmentDetails()} items={attachmentItems()} />, { size: "large", onClose: mailery.actions.closeDialog });
      return;
    }

    if (kind === "raw") {
      dialog.replace(() => <RawMessageDialog close={close} />, { size: "large", onClose: mailery.actions.closeDialog });
      return;
    }
    });
  });

  return null;
}

function GroupDialog(props: { close: () => void }) {
  const mailery = useMailery();
  const theme = useTheme();
  const items: SelectDialogItem[] = MAILBOX_GROUP_MODES.map((mode) => ({
    id: mode,
    title: mailboxGroupModeLabel(mode),
    detail: groupModeDetail(mode),
    marker: mailery.state.groupMode === mode ? "●" : " ",
    markerColor: theme.primary,
  }));

  useKeyboard((key) => {
    if (key.name === "escape") props.close();
  });

  return (
    <SelectDialog
      title="Group Mail"
      placeholder="Choose grouping"
      items={items}
      query=""
      onQuery={() => undefined}
      onSelect={(item) => {
        mailery.actions.setGroupMode(item.id as MailboxGroupMode);
        props.close();
      }}
      onClose={props.close}
    />
  );
}

function groupModeDetail(mode: MailboxGroupMode): string {
  switch (mode) {
    case "priority": return "Important and Unread, Starred, Everything Else";
    case "read-state": return "Unread, Read";
    case "category": return "Primary, Social, Promotions, Updates, Forums";
    default: return "Chronological list";
  }
}

const DIGEST_PERIODS: EmailDigestPeriod[] = ["today", "yesterday", "last7", "month"];

function DigestDialog(props: { close: () => void }) {
  const mailery = useMailery();
  const theme = useTheme();
  const toast = useToast();
  const lines = createMemo(() => {
    const digest = mailery.state.digest;
    if (mailery.state.digestLoading) return ["Loading digest..."];
    if (!digest) return ["No digest available."];
    const out = [`Summary: ${digest.summary ?? "(no summary)"}`, ""];
    if (digest.highlights.length) {
      out.push("Highlights:");
      for (const item of digest.highlights) out.push(`- ${item}`);
      out.push("");
    }
    if (digest.action_items.length) {
      out.push("Action Items:");
      for (const item of digest.action_items) out.push(`- ${item}`);
      out.push("");
    }
    if (digest.important_email_ids.length) {
      out.push(`Important: ${digest.important_email_ids.map((id) => id.slice(0, 8)).join(", ")}`);
      out.push("");
    }
    out.push(`${digest.message_count} message${digest.message_count === 1 ? "" : "s"} · ${digest.provider} ${digest.model}`);
    return out.flatMap((line) => wrapText(line, 96, 4));
  });

  useKeyboard((key) => {
    if (key.name === "escape") props.close();
  });

  return (
    <box flexDirection="column" width="100%" rowGap={1}>
      <box height={1} flexDirection="row" justifyContent="space-between">
        <text fg={theme.text}>Mail Digest</text>
        <Button label="Close" onPress={props.close} />
      </box>
      <box height={1} flexDirection="row" columnGap={1}>
        <For each={DIGEST_PERIODS}>
          {(period) => (
            <Button
              label={emailDigestPeriodLabel(period)}
              active={mailery.state.digestPeriod === period}
              onPress={() => void mailery.actions.loadDigest(period, { local: true })}
            />
          )}
        </For>
      </box>
      <scrollbox height={18} width="100%">
        <For each={lines()}>
          {(line) => <text fg={line.endsWith(":") ? theme.textMuted : theme.text} wrapMode="word" width="100%">{line || " "}</text>}
        </For>
      </scrollbox>
      <box height={1} flexDirection="row" columnGap={1}>
        <Button
          label="Refresh"
          tone="primary"
          active={!mailery.state.digestLoading}
          onPress={() => {
            void mailery.actions.generateDigest(mailery.state.digestPeriod).then((digest) => {
              toast.show({
                title: digest ? "Digest refreshed" : "Digest failed",
                message: digest ? `${emailDigestPeriodLabel(digest.period)} · ${digest.provider}` : mailery.state.lastError ?? "Could not generate digest.",
                tone: digest ? "success" : "error",
              });
            });
          }}
        />
      </box>
    </box>
  );
}


function FilterDialog(props: { close: () => void }) {
  const mailery = useMailery();
  const theme = useTheme();
  const applySearch = () => {
    mailery.actions.search(mailery.state.searchDraft);
    props.close();
  };
  const clearFilters = () => {
    mailery.actions.clearFilters();
    props.close();
  };

  useKeyboard((key) => {
    if (key.name === "escape") props.close();
  });

  return (
    <box flexDirection="column" width="100%" rowGap={1}>
      <box height={1} flexDirection="row" justifyContent="space-between">
        <text fg={theme.text}>Filter Mail</text>
        <Button label="Close" onPress={props.close} />
      </box>
      <input
        focused
        value={mailery.state.searchDraft}
        placeholder="Subject, sender, recipient, or body"
        width="100%"
        textColor={theme.text}
        backgroundColor={theme.backgroundElement}
        focusedTextColor={theme.text}
        focusedBackgroundColor={theme.backgroundActive}
        placeholderColor={theme.textMuted}
        cursorColor={theme.text}
        onInput={mailery.actions.setSearchDraft}
        onSubmit={applySearch}
      />
      <box height={1} flexDirection="row" columnGap={1}>
        <Button label="Apply" tone="primary" onPress={applySearch} />
        <Button label="Clear" onPress={clearFilters} />
        <Button label={mailery.state.sort === "newest" ? "Newest" : "Oldest"} onPress={() => mailery.actions.cycleSort()} />
      </box>
      <box height={1} flexDirection="row" columnGap={1}>
        <Button label="Inbox" active={mailery.state.mailbox === "inbox" && !mailery.state.activeLabel} onPress={() => mailery.actions.setMailbox("inbox")} />
        <Button label="Unread" active={mailery.state.mailbox === "unread"} onPress={() => mailery.actions.setMailbox("unread")} />
        <Button label="Starred" active={mailery.state.mailbox === "starred"} onPress={() => mailery.actions.setMailbox("starred")} />
        <Button label="Archived" active={mailery.state.mailbox === "archived"} onPress={() => mailery.actions.setMailbox("archived")} />
      </box>
      <Show when={mailery.state.search || mailery.state.activeLabel}>
        <text fg={theme.textMuted}>
          Active: {[mailery.state.search && `search "${mailery.state.search}"`, mailery.state.activeLabel && labelDisplayName(mailery.state.activeLabel)].filter(Boolean).join(" · ")}
        </text>
      </Show>
    </box>
  );
}

function attachmentCopyTarget(attachment: AttachmentDetail): string {
  return attachment.file_url ?? attachment.location ?? attachment.filename;
}

function AttachmentsDialog(props: { close: () => void; attachments: AttachmentDetail[]; items: SelectDialogItem[] }) {
  const theme = useTheme();
  const toast = useToast();
  const copyAttachment = (attachment: AttachmentDetail) => {
    const target = attachmentCopyTarget(attachment);
    void copyTextToClipboardAsync(target).then((result) => {
      toast.show({
        title: result.ok ? "Attachment link copied" : "Copy failed",
        message: result.ok ? target : result.error ?? "Clipboard unavailable",
        tone: result.ok ? "success" : "error",
      });
    });
    props.close();
  };
  const openable = () => props.attachments.find((attachment) => attachment.openable && attachment.location);

  return (
    <box flexDirection="column" width="100%" rowGap={1}>
      <SelectDialog
        title="Attachments"
        placeholder="Filter attachments"
        items={props.items}
        query=""
        onQuery={() => undefined}
        onSelect={(item) => {
          const attachment = props.attachments[Number(item.id)];
          if (attachment) copyAttachment(attachment);
        }}
        onClose={props.close}
        footer="Select an attachment to copy its local file link or storage location."
      />
      <For each={props.attachments.filter((attachment) => attachment.file_url || attachment.location)}>
        {(attachment) => (
          <text fg={theme.textMuted} wrapMode="word" width="100%">
            {attachment.filename}: {attachment.file_url ?? attachment.location}
          </text>
        )}
      </For>
      <Show when={openable()}>
        {(attachment) => (
          <Button
            label="Open first local"
            onPress={() => {
              const target = attachment().location;
              if (!target) return;
              const result = openLocalTarget(target);
              toast.show({
                title: result.ok ? "Attachment opened" : "Open failed",
                message: result.ok ? target : result.error ?? "Could not open attachment.",
                tone: result.ok ? "success" : "error",
              });
              props.close();
            }}
          />
        )}
      </Show>
      <Button
        label="Copy all attachment links"
        onPress={() => {
          const links = props.attachments.map(attachmentCopyTarget).join("\n");
          void copyTextToClipboardAsync(links).then((result) => {
            toast.show({ title: result.ok ? "Attachment links copied" : "Copy failed", message: `${props.attachments.length} attachment(s)`, tone: result.ok ? "success" : "error" });
          });
          props.close();
        }}
      />
      <Show when={props.attachments.length === 0}>
        <text fg={theme.textMuted}>No attachments on this message.</text>
      </Show>
    </box>
  );
}

function RawMessageDialog(props: { close: () => void }) {
  const mailery = useMailery();
  const theme = useTheme();
  const body = () => mailery.selectedBody();
  const rawLines = () => {
    const selected = body();
    if (!selected) return [];
    const parts = [
      selected.text ? `Text body\n${selected.text}` : "",
      selected.html ? `HTML body\n${selected.html}` : "",
    ].filter(Boolean).join("\n\n");
    return wrapText(parts || "(no body)", 110, 220);
  };

  useKeyboard((key) => {
    if (key.name === "escape") props.close();
  });

  return (
    <box flexDirection="column" width="100%" rowGap={1}>
      <box height={1} flexDirection="row" justifyContent="space-between">
        <text fg={theme.text}>Raw Email</text>
        <Button label="Close" onPress={props.close} />
      </box>
      <Show when={body()} fallback={<EmptyState title="No message selected" detail="Choose a message first." />}>
        {(selected) => (
          <box flexDirection="column" width="100%" rowGap={1}>
            <text fg={theme.textMuted}>Subject: {selected().subject}</text>
            <text fg={theme.textMuted}>From: {selected().from}</text>
            <text fg={theme.textMuted}>To: {selected().to}</text>
            <text fg={theme.textMuted}>Date: {formatDate(selected().date)}</text>
            <text fg={theme.textMuted}>Flags: {selected().flags.join(", ") || "none"}</text>
            <scrollbox height={16} width="100%">
              <For each={rawLines()}>
                {(line) => <text fg={theme.text} wrapMode="word" width="100%">{line || " "}</text>}
              </For>
            </scrollbox>
          </box>
        )}
      </Show>
    </box>
  );
}

function inboxDetail(address: { provider?: string; receiveStatus?: string; configured: boolean; observed: boolean }): string {
  // Keep the picker detail SHORT so it never steals row width from the email address
  // itself (long addresses were getting clipped/garbled by a long provider string).
  // The provider lives in the Domains view; here only the readiness status matters.
  if (!address.configured) return address.observed ? "observed" : "";
  return formatReceiveStatus(address.receiveStatus) ?? "configured";
}

function formatReceiveStatus(value: string | undefined): string | undefined {
  if (!value || value === "none") return "configured";
  if (value === "ready") return "ready";
  return value.replace(/_/g, " ");
}

function boolText(value: boolean): string {
  return value ? "On" : "Off";
}

function readinessLabel(value: string): string {
  switch (value) {
    case "ready_to_send_and_receive": return "Ready";
    case "ready_to_send": return "Send ready";
    case "ready_to_receive": return "Receive ready";
    case "needs_dns": return "Needs DNS";
    case "broken": return "Broken";
    default: return value.replace(/_/g, " ");
  }
}

function readinessColor(theme: ReturnType<typeof useTheme>, value: string) {
  if (value === "ready_to_send_and_receive") return theme.success;
  if (value === "ready_to_send" || value === "ready_to_receive") return theme.info;
  if (value === "broken") return theme.error;
  return theme.warning;
}

function DomainsDialog(props: { close: () => void }) {
  const mailery = useMailery();
  const theme = useTheme();
  useKeyboard((key) => {
    if (key.name === "escape") props.close();
  });
  return (
    <box flexDirection="column" width="100%" rowGap={1}>
      <box height={1} flexDirection="row" justifyContent="space-between">
        <text fg={theme.text}>Domains</text>
        <Button label="Close" onPress={props.close} />
      </box>

      <box height={1} flexDirection="row" columnGap={2} paddingLeft={1}>
        <box width={34}><text fg={theme.textMuted}>Domain</text></box>
        <box width={22}><text fg={theme.textMuted}>Provider</text></box>
        <box flexGrow={1}><text fg={theme.textMuted}>Readiness</text></box>
      </box>

      <Show when={mailery.state.domains.length > 0} fallback={<EmptyState title="No domains" detail="Configured domains will appear here." />}>
        <scrollbox height={14} width="100%">
          <For each={mailery.state.domains}>
            {(domain) => (
              <Row>
                <box flexDirection="row" width="100%" columnGap={2}>
                  <box width={34}><text fg={theme.text}>{domain.domain}</text></box>
                  <box width={22}><text fg={theme.textMuted}>{domain.provider}</text></box>
                  <box flexGrow={1}><text fg={readinessColor(theme, domain.readiness)}>{readinessLabel(domain.readiness)}</text></box>
                </box>
              </Row>
            )}
          </For>
        </scrollbox>
      </Show>

      <box height={1} />
      <box height={1} flexDirection="row" columnGap={1}>
        <Button label="Previous page" onPress={() => mailery.actions.workspacePage(-1)} />
        <Button label="Next page" active={mailery.state.domainsHasMore} onPress={() => mailery.actions.workspacePage(1)} />
      </box>
    </box>
  );
}

type SettingsSection = "main" | "sync" | "defaults" | "display" | "agents";

function settingsTitle(section: SettingsSection): string {
  switch (section) {
    case "sync": return "Settings / Sync";
    case "defaults": return "Settings / Defaults";
    case "display": return "Settings / Display";
    case "agents": return "Settings / Agents";
    default: return "Settings";
  }
}

function SettingsMenuRow(props: { title: string; detail: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Row height={2} onPress={props.onPress}>
      <box flexDirection="column" width="100%">
        <text fg={theme.text}>{props.title}</text>
        <text fg={theme.textMuted}>{props.detail}</text>
      </box>
    </Row>
  );
}

function SettingsActionRow(props: { title: string; value: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Row onPress={props.onPress}>
      <box flexDirection="row" width="100%" justifyContent="space-between">
        <text fg={theme.text}>{props.title}</text>
        <text fg={theme.textMuted}>{props.value}</text>
      </box>
    </Row>
  );
}

function SettingsDialog(props: { close: () => void }) {
  const mailery = useMailery();
  const [section, setSection] = createSignal<SettingsSection>("main");
  const settings = () => mailery.state.settings;
  const agentSettings = createMemo(() => ensureEmailAgentSettings());
  const enabledAgentCount = () => agentSettings().filter((setting) => setting.enabled).length;
  const alwaysOnAgentCount = () => agentSettings().filter((setting) => setting.enabled && setting.always_on).length;
  const goBack = () => {
    if (section() === "main") props.close();
    else setSection("main");
  };
  const cycleMailbox = () => {
    const index = MAILBOXES.indexOf(settings().defaultMailbox);
    mailery.actions.setSetting("defaultMailbox", MAILBOXES[(index + 1) % MAILBOXES.length] as Mailbox);
  };
  const openInboxes = () => {
    props.close();
    mailery.actions.openDialog("address");
  };
  const openCompose = () => {
    props.close();
    mailery.actions.startCompose("new");
  };

  useKeyboard((key) => {
    if (key.name !== "escape") return;
    goBack();
    key.preventDefault();
    key.stopPropagation();
  });

  const theme = useTheme();
  return (
    <box flexDirection="column" width="100%" rowGap={1}>
      <box height={1} flexDirection="row" justifyContent="space-between">
        <text fg={theme.text}>{settingsTitle(section())}</text>
        <Button label={section() === "main" ? "Close" : "Back"} onPress={goBack} />
      </box>

      <Show when={section() === "main"}>
        <box flexDirection="column" width="100%" rowGap={1}>
          <SettingsMenuRow title="Sync" detail="Auto-pull and Gmail refresh" onPress={() => setSection("sync")} />
          <SettingsMenuRow title="Agents" detail="Groq defaults and always-on" onPress={() => setSection("agents")} />
          <SettingsMenuRow title="Defaults" detail="Inbox, folder, and sender" onPress={() => setSection("defaults")} />
          <SettingsMenuRow title="Display" detail="Theme and read-state styling" onPress={() => setSection("display")} />
        </box>
      </Show>

      <Show when={section() === "sync"}>
        <box flexDirection="column" width="100%" rowGap={1}>
          <SettingsActionRow
            title="Auto-pull inbound"
            value={boolText(settings().autoPull)}
            onPress={() => mailery.actions.setSetting("autoPull", !settings().autoPull)}
          />
          <SettingsActionRow
            title="Gmail auto-pull"
            value={boolText(settings().gmailAutoPull)}
            onPress={() => mailery.actions.setSetting("gmailAutoPull", !settings().gmailAutoPull)}
          />
        </box>
      </Show>

      <Show when={section() === "agents"}>
        <box flexDirection="column" width="100%" rowGap={1}>
          <SettingsActionRow title="Enabled agents" value={`${enabledAgentCount()}/${agentSettings().length}`} onPress={() => undefined} />
          <SettingsActionRow title="Always-on agents" value={String(alwaysOnAgentCount())} onPress={() => undefined} />
          <SettingsActionRow title="Default provider" value="Groq" onPress={() => undefined} />
          <SettingsActionRow title="Groq email model" value={DEFAULT_GROQ_EMAIL_AGENT_MODEL} onPress={() => undefined} />
          <SettingsActionRow
            title="Auto-pull inbound"
            value={boolText(settings().autoPull)}
            onPress={() => mailery.actions.setSetting("autoPull", !settings().autoPull)}
          />
        </box>
      </Show>

      <Show when={section() === "defaults"}>
        <box flexDirection="column" width="100%" rowGap={1}>
          <SettingsActionRow title="Default folder" value={mailboxLabel(settings().defaultMailbox)} onPress={cycleMailbox} />
          <SettingsActionRow title="Default inbox" value={settings().defaultAddress ?? "All inboxes"} onPress={openInboxes} />
          <SettingsActionRow title="Default From" value={settings().defaultFrom ?? "Automatic"} onPress={openCompose} />
        </box>
      </Show>

      <Show when={section() === "display"}>
        <box flexDirection="column" width="100%" rowGap={1}>
          <SettingsActionRow
            title="Dim read messages"
            value={boolText(settings().dimRead)}
            onPress={() => mailery.actions.setSetting("dimRead", !settings().dimRead)}
          />
          <SettingsActionRow
            title="Theme"
            value={settings().theme}
            onPress={() => mailery.actions.setSetting("theme", settings().theme === "dark" ? "light" : "dark")}
          />
        </box>
      </Show>
    </box>
  );
}
