/** Minimal levelled logger. Structured enough to grep, small enough to have no deps. */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

let threshold: number = LEVELS.info;

export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS[level];
}

function fmt(v: unknown): string {
  if (typeof v === "string") {
    return /\s/.test(v) ? JSON.stringify(v) : v;
  }
  if (v instanceof Error) return JSON.stringify(v.message);
  return JSON.stringify(v) ?? String(v);
}

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  let tail = "";
  if (fields) {
    const parts: string[] = [];
    for (const key of Object.keys(fields)) {
      parts.push(key + "=" + fmt(fields[key]));
    }
    if (parts.length > 0) tail = " " + parts.join(" ");
  }
  const line = ts + " " + level.toUpperCase().padEnd(5) + " " + msg + tail;
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
};
