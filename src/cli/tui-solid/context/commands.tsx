import { createContext, createMemo, onCleanup, onMount, useContext, type Accessor, type ParentProps } from "solid-js";
import { useRenderer } from "@opentui/solid";
import type { KeyEvent } from "@opentui/core";
import { mailboxLabel, type Mailbox } from "../../tui/data.js";
import { MAILBOXES, useEmails } from "./emails-state.js";
import { useToast } from "./toast.js";
import { useStaticBindings } from "./keymap.js";

export interface EmailsCommand {
  id: string;
  title: string;
  category: string;
  detail?: string;
  hidden?: boolean;
  enabled?: () => boolean;
  run: () => void | Promise<void>;
}

function createCommands(): Accessor<EmailsCommand[]> {
  const emails = useEmails();
  const toast = useToast();

  const pullNow = async () => {
    toast.show({ title: "Pulling mail", message: "Syncing configured inboxes.", tone: "info" });
    const result = await emails.actions.pullNow();
    toast.show({
      title: result.ok ? "Pull complete" : "Pull failed",
      message: result.ok ? `${result.pulled} message${result.pulled === 1 ? "" : "s"} pulled.` : result.reason ?? "Pull could not run.",
      tone: result.ok ? "success" : "error",
    });
  };

  return createMemo(() => [
    {
      id: "mailbox.open",
      title: "Open Inbox",
      category: "Mail",
      run: () => emails.actions.openRoute("mailbox"),
    },
    {
      id: "compose.new",
      title: "Compose",
      category: "Mail",
      run: () => emails.actions.startCompose("new"),
    },
    {
      id: "domains.open",
      title: "Domains",
      category: "Tools",
      run: () => emails.actions.openDialog("domains"),
    },
    {
      id: "settings.open",
      title: "Settings",
      category: "Tools",
      run: () => emails.actions.openDialog("settings"),
    },
    {
      id: "inboxes.open",
      title: "Inboxes",
      category: "Mail",
      run: () => emails.actions.openDialog("address"),
    },
    {
      id: "sources.open",
      title: "Sources",
      category: "Mail",
      run: () => emails.actions.openDialog("source"),
    },
    {
      id: "filter.open",
      title: "Filter Mail",
      category: "Mail",
      run: () => emails.actions.openDialog("filter"),
    },
    {
      id: "search.open",
      title: "Search Mail",
      category: "Mail",
      run: () => {
        emails.actions.setSearchDraft(emails.state.search);
        emails.actions.openDialog("search");
      },
    },
    {
      id: "labels.open",
      title: "Label Message",
      category: "Mail",
      enabled: () => !!emails.selectedMessage(),
      run: () => emails.actions.openDialog("labels"),
    },
    {
      id: "links.open",
      title: "Extract Links",
      category: "Mail",
      enabled: () => !!emails.selectedMessage(),
      run: () => emails.actions.openDialog("links"),
    },
    {
      id: "attachments.open",
      title: "Attachments",
      category: "Mail",
      enabled: () => (emails.selectedBody()?.attachments.length ?? 0) > 0,
      run: () => emails.actions.openDialog("attachments"),
    },
    {
      id: "raw.open",
      title: "Raw Message",
      category: "Mail",
      enabled: () => !!emails.selectedMessage(),
      run: () => emails.actions.openDialog("raw"),
    },
    {
      id: "refresh.local",
      title: "Refresh",
      category: "Mail",
      run: () => {
        emails.actions.reload({ preserveSelection: true });
        toast.show({ title: "Refreshed", message: "Local mailbox state reloaded.", tone: "success" });
      },
    },
    // Pull Now is LOCAL S3→SQLite ingestion. In self_hosted mode the server ingests and the
    // client syncs via the automatic changesSince delta, so there is no manual pull —
    // omit the command entirely so no self_hosted affordance (palette or shortcut) reaches it.
    ...(emails.mode === "local"
      ? [{
          id: "pull.now",
          title: "Pull Now",
          category: "Mail",
          run: pullNow,
        } satisfies EmailsCommand]
      : []),
    ...MAILBOXES.map((mailbox): EmailsCommand => ({
      id: `mailbox.${mailbox}`,
      title: mailboxLabel(mailbox as Mailbox),
      category: "Folders",
      run: () => emails.actions.setMailbox(mailbox as Mailbox),
    })),
  ]);
}

type CommandContextValue = {
  commands: Accessor<EmailsCommand[]>;
  visibleCommands: Accessor<EmailsCommand[]>;
  runCommand: (id: string) => Promise<boolean>;
};

const CommandContext = createContext<CommandContextValue>();

export function CommandProvider(props: ParentProps) {
  const commands = createCommands();
  const emails = useEmails();
  const renderer = useRenderer();
  const value: CommandContextValue = {
    commands,
    visibleCommands: createMemo(() => commands().filter((command) => !command.hidden && (command.enabled?.() ?? true))),
    async runCommand(id: string) {
      const command = commands().find((item) => item.id === id);
      if (!command || command.enabled?.() === false) return false;
      await command.run();
      return true;
    },
  };

  useStaticBindings(() => ({
    priority: 50,
    bindings: [
      { key: "ctrl+p", desc: "Open shortcuts", group: "Commands", cmd: () => emails.state.dialog === null && emails.actions.openDialog("commands") },
      { key: "ctrl+f", desc: "Search mail", group: "Commands", cmd: () => emails.state.dialog === null && emails.state.compose === null && value.runCommand("search.open") },
      { key: "ctrl+r", desc: "Refresh", group: "Commands", cmd: () => emails.state.dialog === null && emails.state.compose === null && value.runCommand("refresh.local") },
      { key: "escape", desc: "Back", group: "Navigation", cmd: () => {
        if (emails.state.dialog || emails.state.compose) return;
        emails.state.route === "reader" ? emails.actions.backToList() : renderer.destroy();
      } },
      { key: "up", desc: "Previous message", group: "Navigation", cmd: () => emails.state.dialog === null && emails.state.compose === null && emails.actions.selectOffset(-1) },
      { key: "down", desc: "Next message", group: "Navigation", cmd: () => emails.state.dialog === null && emails.state.compose === null && emails.actions.selectOffset(1) },
      { key: "right", desc: "Open message", group: "Navigation", cmd: () => emails.state.dialog === null && emails.state.compose === null && emails.actions.openMessage() },
      { key: "enter", desc: "Open message", group: "Navigation", cmd: () => emails.state.dialog === null && emails.state.compose === null && emails.actions.openMessage() },
      { key: "pageup", desc: "Previous page", group: "Navigation", cmd: () => emails.state.dialog === null && emails.state.compose === null && emails.actions.page(-1) },
      { key: "pagedown", desc: "Next page", group: "Navigation", cmd: () => emails.state.dialog === null && emails.state.compose === null && emails.actions.page(1) },
    ],
  }));

  const handleKey = (key: KeyEvent) => {
    if (emails.state.dialog || emails.state.compose) return;

    const consume = () => {
      key.preventDefault();
      key.stopPropagation();
    };

    if (key.ctrl && key.name === "p") {
      emails.actions.openDialog("commands");
      consume();
      return;
    }
    if (key.ctrl && key.name === "f") {
      void value.runCommand("search.open");
      consume();
      return;
    }
    if (key.ctrl && key.name === "r") {
      void value.runCommand("refresh.local");
      consume();
      return;
    }
    if (key.name === "escape") {
      emails.state.route === "reader" ? emails.actions.backToList() : renderer.destroy();
      consume();
      return;
    }
    if (key.name === "up") {
      emails.actions.selectOffset(-1);
      consume();
      return;
    }
    if (key.name === "down") {
      emails.actions.selectOffset(1);
      consume();
      return;
    }
    if (key.name === "right" || key.name === "enter" || key.name === "return") {
      emails.actions.openMessage();
      consume();
      return;
    }
    if (key.name === "pageup") {
      emails.actions.page(-1);
      consume();
    }
    if (key.name === "pagedown") {
      emails.actions.page(1);
      consume();
    }
  };

  const handleRawInput = (sequence: string) => {
    if (emails.state.dialog || emails.state.compose) return false;
    const rawCommands: Record<string, () => void> = {
      "\x10": () => emails.actions.openDialog("commands"),
      "\x1B[112;5u": () => emails.actions.openDialog("commands"),
      "\x06": () => void value.runCommand("search.open"),
      "\x1B[102;5u": () => void value.runCommand("search.open"),
      "\x12": () => void value.runCommand("refresh.local"),
      "\x1B[114;5u": () => void value.runCommand("refresh.local"),
    };
    const run = rawCommands[sequence];
    if (!run) return false;
    run();
    return true;
  };

  let registered = false;
  onMount(() => {
    queueMicrotask(() => {
      renderer.prependInputHandler(handleRawInput);
      renderer.keyInput.prependListener("keypress", handleKey);
      registered = true;
    });
  });
  onCleanup(() => {
    if (!registered) return;
    renderer.removeInputHandler(handleRawInput);
    renderer.keyInput.off("keypress", handleKey);
  });

  return <CommandContext.Provider value={value}>{props.children}</CommandContext.Provider>;
}

export function useCommands(): CommandContextValue {
  const commands = useContext(CommandContext);
  if (!commands) throw new Error("useCommands must be used within CommandProvider");
  return commands;
}
