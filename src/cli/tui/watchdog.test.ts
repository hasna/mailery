import { describe, expect, it } from "bun:test";
import { startEventLoopWatchdog } from "./watchdog.js";

describe("startEventLoopWatchdog", () => {
  it("returns a cleanup function", () => {
    const stop = startEventLoopWatchdog({ intervalMs: 100, thresholdMs: 1000, onLag: () => {} });
    expect(typeof stop).toBe("function");
    stop();
  });
});

