import type { Mailbox } from "./data.js";

export async function runOpenTuiApp(initialMailbox?: Mailbox): Promise<void> {
  const previousAlternateScreen = process.env["OTUI_USE_ALTERNATE_SCREEN"];
  process.env["OTUI_USE_ALTERNATE_SCREEN"] = "true";
  let renderer: Awaited<ReturnType<(typeof import("@opentui/core"))["createCliRenderer"]>> | null = null;
  const signalExitCodes: Partial<Record<NodeJS.Signals, number>> = {
    SIGINT: 130,
    SIGTERM: 143,
  };
  const signalHandlers: Array<[NodeJS.Signals, () => void]> = [];
  const restoreAlternateScreenEnv = () => {
    if (previousAlternateScreen === undefined) {
      delete process.env["OTUI_USE_ALTERNATE_SCREEN"];
    } else {
      process.env["OTUI_USE_ALTERNATE_SCREEN"] = previousAlternateScreen;
    }
  };

  const [{ createCliRenderer }, { createRoot }, React, { App }] = await Promise.all([
    import("@opentui/core"),
    import("@opentui/react"),
    import("react"),
    import("./App.js"),
  ]);
  try {
    renderer = await createCliRenderer({
      exitOnCtrlC: false,
      screenMode: "alternate-screen",
      clearOnShutdown: true,
      targetFps: 60,
      consoleMode: "disabled",
      openConsoleOnError: false,
      useKittyKeyboard: {},
      useMouse: true,
      enableMouseMovement: true,
      backgroundColor: "#101418",
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = () => {
        process.exitCode = signalExitCodes[signal] ?? 1;
        renderer?.destroy();
      };
      signalHandlers.push([signal, handler]);
      process.once(signal, handler);
    }
    renderer.setTerminalTitle("emails ui");
    const destroyed = new Promise<void>((resolve) => {
      renderer!.on("destroy", () => resolve());
    });
    createRoot(renderer).render(React.createElement(App, { initialMailbox }));
    await destroyed;
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
    renderer?.destroy();
    restoreAlternateScreenEnv();
  }
}
