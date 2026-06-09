import { ansi } from "./ansi.js";

type ColorFn = ((...values: unknown[]) => string) & {
  bold: (...values: unknown[]) => string;
};

function text(values: unknown[]): string {
  return values.map(String).join(" ");
}

function color(fn: (value: string) => string): ColorFn {
  const wrapped = ((...values: unknown[]) => fn(text(values))) as ColorFn;
  wrapped.bold = (...values: unknown[]) => fn(ansi.bold(text(values)));
  return wrapped;
}

const chalk = {
  blue: color(ansi.blue),
  bold: color(ansi.bold),
  cyan: color(ansi.cyan),
  cyanBright: color(ansi.cyanBright),
  dim: color(ansi.dim),
  gray: color(ansi.gray),
  green: color(ansi.green),
  magenta: color(ansi.magenta),
  magentaBright: color(ansi.magentaBright),
  red: color(ansi.red),
  redBright: color(ansi.redBright),
  white: color(ansi.white),
  yellow: color(ansi.yellow),
};

export default chalk;
