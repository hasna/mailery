import { createContext, createMemo, onCleanup, onMount, useContext, type Accessor, type ParentProps } from "solid-js";
import { useRenderer } from "@opentui/solid";
import type { KeyEvent } from "@opentui/core";
import { mailboxLabel, type Mailbox } from "../../tui/data.js";
import { MAILBOXES, useMailery } from "./mailery-state.js";
import { useToast } from "./toast.js";
import { useStaticBindings } from "./keymap.js";

export interface MaileryCommand {
  id: string;
  title: string;
  category: string;
  detail?: string;
  hidden?: boolean;
  enabled?: () => boolean;
  run: () => void | Promise<void>;
}

function createCommands(): Accessor<MaileryCommand[]> {
  const mailery = useMailery();
  const toast = useToast();

  const pullNow = async () => {
    toast.show({ title: "Pulling mail", message: "Syncing configured inboxes.", tone: "info" });
    const result = await mailery.actions.pullNow();
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
      run: () => mailery.actions.openRoute("mailbox"),
    },
    {
      id: "compose.new",
      title: "Compose",
      category: "Mail",
      run: () => mailery.actions.startCompose("new"),
    },
    {
      id: "domains.open",
      title: "Domains",
      category: "Tools",
      run: () => mailery.actions.openDialog("domains"),
    },
    {
      id: "settings.open",
      title: "Settings",
      category: "Tools",
      run: () => mailery.actions.openDialog("settings"),
    },
    {
      id: "inboxes.open",
      title: "Inboxes",
      category: "Mail",
      run: () => mailery.actions.openDialog("address"),
    },
    {
      id: "filter.open",
      title: "Filter Mail",
      category: "Mail",
      run: () => mailery.actions.openDialog("filter"),
    },
    {
      id: "search.open",
      title: "Search Mail",
      category: "Mail",
      run: () => {
        mailery.actions.setSearchDraft(mailery.state.search);
        mailery.actions.openDialog("search");
      },
    },
    {
      id: "labels.open",
      title: "Label Message",
      category: "Mail",
      enabled: () => !!mailery.selectedMessage(),
      run: () => mailery.actions.openDialog("labels"),
    },
    {
      id: "links.open",
      title: "Extract Links",
      category: "Mail",
      enabled: () => !!mailery.selectedMessage(),
      run: () => mailery.actions.openDialog("links"),
    },
    {
      id: "attachments.open",
      title: "Attachments",
      category: "Mail",
      enabled: () => (mailery.selectedBody()?.attachments.length ?? 0) > 0,
      run: () => mailery.actions.openDialog("attachments"),
    },
    {
      id: "raw.open",
      title: "Raw Message",
      category: "Mail",
      enabled: () => !!mailery.selectedMessage(),
      run: () => mailery.actions.openDialog("raw"),
    },
    {
      id: "refresh.local",
      title: "Refresh",
      category: "Mail",
      run: () => {
        mailery.actions.reload({ preserveSelection: true });
        toast.show({ title: "Refreshed", message: "Local mailbox state reloaded.", tone: "success" });
      },
    },
    // Pull Now is LOCAL S3→SQLite ingestion. In cloud mode the server ingests and the
    // client syncs via the automatic changesSince delta, so there is no manual pull —
    // omit the command entirely so no cloud affordance (palette or shortcut) reaches it.
    ...(mailery.mode === "local"
      ? [{
          id: "pull.now",
          title: "Pull Now",
          category: "Mail",
          run: pullNow,
        } satisfies MaileryCommand]
      : []),
    ...MAILBOXES.map((mailbox): MaileryCommand => ({
      id: `mailbox.${mailbox}`,
      title: mailboxLabel(mailbox as Mailbox),
      category: "Folders",
      run: () => mailery.actions.setMailbox(mailbox as Mailbox),
    })),
  ]);
}

type CommandContextValue = {
  commands: Accessor<MaileryCommand[]>;
  visibleCommands: Accessor<MaileryCommand[]>;
  runCommand: (id: string) => Promise<boolean>;
};

const CommandContext = createContext<CommandContextValue>();

export function CommandProvider(props: ParentProps) {
  const commands = createCommands();
  const mailery = useMailery();
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
      { key: "ctrl+p", desc: "Open shortcuts", group: "Commands", cmd: () => mailery.state.dialog === null && mailery.actions.openDialog("commands") },
      { key: "ctrl+f", desc: "Search mail", group: "Commands", cmd: () => mailery.state.dialog === null && mailery.state.compose === null && value.runCommand("search.open") },
      { key: "ctrl+r", desc: "Refresh", group: "Commands", cmd: () => mailery.state.dialog === null && mailery.state.compose === null && value.runCommand("refresh.local") },
      { key: "escape", desc: "Back", group: "Navigation", cmd: () => {
        if (mailery.state.dialog || mailery.state.compose) return;
        mailery.state.route === "reader" ? mailery.actions.backToList() : renderer.destroy();
      } },
      { key: "up", desc: "Previous message", group: "Navigation", cmd: () => mailery.state.dialog === null && mailery.state.compose === null && mailery.actions.selectOffset(-1) },
      { key: "down", desc: "Next message", group: "Navigation", cmd: () => mailery.state.dialog === null && mailery.state.compose === null && mailery.actions.selectOffset(1) },
      { key: "right", desc: "Open message", group: "Navigation", cmd: () => mailery.state.dialog === null && mailery.state.compose === null && mailery.actions.openMessage() },
      { key: "enter", desc: "Open message", group: "Navigation", cmd: () => mailery.state.dialog === null && mailery.state.compose === null && mailery.actions.openMessage() },
      { key: "pageup", desc: "Previous page", group: "Navigation", cmd: () => mailery.state.dialog === null && mailery.state.compose === null && mailery.actions.page(-1) },
      { key: "pagedown", desc: "Next page", group: "Navigation", cmd: () => mailery.state.dialog === null && mailery.state.compose === null && mailery.actions.page(1) },
    ],
  }));

  const handleKey = (key: KeyEvent) => {
    if (mailery.state.dialog || mailery.state.compose) return;

    const consume = () => {
      key.preventDefault();
      key.stopPropagation();
    };

    if (key.ctrl && key.name === "p") {
      mailery.actions.openDialog("commands");
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
      mailery.state.route === "reader" ? mailery.actions.backToList() : renderer.destroy();
      consume();
      return;
    }
    if (key.name === "up") {
      mailery.actions.selectOffset(-1);
      consume();
      return;
    }
    if (key.name === "down") {
      mailery.actions.selectOffset(1);
      consume();
      return;
    }
    if (key.name === "right" || key.name === "enter" || key.name === "return") {
      mailery.actions.openMessage();
      consume();
      return;
    }
    if (key.name === "pageup") {
      mailery.actions.page(-1);
      consume();
    }
    if (key.name === "pagedown") {
      mailery.actions.page(1);
      consume();
    }
  };

  const handleRawInput = (sequence: string) => {
    if (mailery.state.dialog || mailery.state.compose) return false;
    const rawCommands: Record<string, () => void> = {
      "\x10": () => mailery.actions.openDialog("commands"),
      "\x1B[112;5u": () => mailery.actions.openDialog("commands"),
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
