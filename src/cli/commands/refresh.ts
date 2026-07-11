import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { handleError, parseCliPositiveIntOption } from "../utils.js";

const MAX_REFRESH_SCAN_LIMIT = 10000;

async function runAutoPull(opts: { s3?: boolean; forwarding?: boolean; limit?: number }) {
  const { autoPull } = await import("../tui/autopull.js");
  return autoPull(opts);
}

/**
 * `emails refresh` - one-shot "pull everything now". Syncs every configured
 * inbound S3 bucket (each with its own provider creds / AWS account) using the
 * same pull engine emails ui runs in the background, exposed as a single
 * instant command so you never have to type
 * `inbox sync-s3 --bucket … --prefix … --profile … --provider …` by hand.
 */
export function registerRefreshCommand(program: Command, output: (data: unknown, formatted: string) => void): void {
  program
	    .command("refresh")
	    .description("Pull all new inbound mail now - syncs every configured S3 inbound bucket")
	    .option("--no-forwarding", "Skip processing enabled forwarding rules after refresh")
	    .option("--limit <n>", "Max objects to scan per bucket", "1000")
	    .action(async (opts: { forwarding?: boolean; limit?: string }) => {
	      try {
	        const limit = parseCliPositiveIntOption(opts.limit, 1000, MAX_REFRESH_SCAN_LIMIT);
	        const r = await runAutoPull({ s3: true, forwarding: opts.forwarding !== false, limit });

        if (!r.configured) {
          console.log(chalk.yellow("No inbound sources configured."));
          console.log(chalk.dim("Adopt a domain (`emails domain adopt <domain>`) or add a bucket, then refresh."));
          return;
        }
        if (!r.ok && r.reason) {
          console.log(chalk.red(`Refresh hit an error: ${r.reason}`));
          if (r.pulled > 0) console.log(chalk.green(`(still pulled ${r.pulled} before failing)`));
          if ((r.forwarded?.sent ?? 0) > 0) console.log(chalk.green(`(still forwarded ${r.forwarded!.sent} before failing)`));
          return;
	        }
	        const forwarded = r.forwarded?.sent ?? 0;
	        const msg = refreshMessage(r.pulled, forwarded);
	        output({ pulled: r.pulled, forwarded: r.forwarded, ok: r.ok }, r.pulled > 0 || forwarded > 0 ? chalk.green(msg) : chalk.dim(msg));
      } catch (e) {
        handleError(e);
      }
    });
}

function refreshMessage(pulled: number, forwarded: number): string {
  const pulledText = pulled > 0 ? `Pulled ${pulled} new email${pulled === 1 ? "" : "s"}` : "";
  const forwardedText = forwarded > 0 ? `forwarded ${forwarded}` : "";
  const parts = [pulledText, forwardedText].filter(Boolean);
  if (parts.length > 0) return `✓ ${parts.join("; ")}`;
  return "✓ Up to date — no new mail";
}
