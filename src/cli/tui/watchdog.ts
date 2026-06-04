export interface EventLoopWatchdogOptions {
  intervalMs?: number;
  thresholdMs?: number;
  onLag?: (lagMs: number) => void;
}

export function startEventLoopWatchdog(options: EventLoopWatchdogOptions = {}): () => void {
  const intervalMs = Math.max(100, options.intervalMs ?? 2000);
  const thresholdMs = Math.max(intervalMs, options.thresholdMs ?? 5000);
  const onLag = options.onLag ?? ((lagMs) => {
    process.stderr.write(`[emails interactive] event loop lag ${Math.round(lagMs)}ms\n`);
  });

  let expected = Date.now() + intervalMs;
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - expected;
    if (lag > thresholdMs) onLag(lag);
    expected = now + intervalMs;
  }, intervalMs);
  timer.unref?.();

  return () => clearInterval(timer);
}

