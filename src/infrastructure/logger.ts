type LogLevel = "info" | "warn" | "error" | "debug";

function log(
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>,
): void {
  const entry = data ? { level, message, ...data } : { level, message };
  const line = JSON.stringify(entry);
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (message: string, data?: Record<string, unknown>) =>
    log("info", message, data),
  warn: (message: string, data?: Record<string, unknown>) =>
    log("warn", message, data),
  error: (message: string, data?: Record<string, unknown>) =>
    log("error", message, data),
  debug: (message: string, data?: Record<string, unknown>) =>
    log("debug", message, data),
};
