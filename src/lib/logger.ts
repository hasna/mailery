import { ansi } from "./ansi.js";

let _quiet = false;
let _verbose = false;

export function setLogLevel(quiet: boolean, verbose: boolean): void {
  _quiet = quiet;
  _verbose = verbose;
}

export const log = {
  info: (...args: unknown[]) => { if (!_quiet) console.log(...args); },
  debug: (...args: unknown[]) => { if (_verbose) console.log(ansi.gray("[debug]"), ...args); },
  error: (...args: unknown[]) => { console.error(ansi.red(args.map(String).join(" "))); },
  success: (...args: unknown[]) => { if (!_quiet) console.log(ansi.green(args.map(String).join(" "))); },
  warn: (...args: unknown[]) => { if (!_quiet) console.log(ansi.yellow(args.map(String).join(" "))); },
};
