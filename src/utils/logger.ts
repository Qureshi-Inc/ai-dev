import { pino } from "pino";
import { config } from "../config.js";

export const logger = pino({
  level: config.logLevel,
  ...(config.logPretty
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname" },
        },
      }
    : {}),
});

/** Create a child logger bound to a specific issue job for traceable, structured logs. */
export function jobLogger(fields: Record<string, unknown>) {
  return logger.child(fields);
}
