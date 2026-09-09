export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

class JsonLogger implements Logger {
  private readonly service: string;
  private readonly bound: Record<string, unknown>;
  private readonly minLevel: LogLevel;

  constructor(service: string, bound: Record<string, unknown>, minLevel: LogLevel) {
    this.service = service;
    this.bound = bound;
    this.minLevel = minLevel;
  }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.minLevel]) return;
    const payload: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      service: this.service,
      message,
      ...this.bound,
    };
    for (const [key, value] of Object.entries(fields ?? {})) {
      payload[key] = serialize(value);
    }
    const line = JSON.stringify(payload);
    if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  }

  debug(message: string, fields?: Record<string, unknown>): void { this.write('debug', message, fields); }
  info(message: string, fields?: Record<string, unknown>): void { this.write('info', message, fields); }
  warn(message: string, fields?: Record<string, unknown>): void { this.write('warn', message, fields); }
  error(message: string, fields?: Record<string, unknown>): void { this.write('error', message, fields); }

  child(fields: Record<string, unknown>): Logger {
    return new JsonLogger(this.service, { ...this.bound, ...fields }, this.minLevel);
  }
}

export function createLogger(service: string, minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info'): Logger {
  return new JsonLogger(service, {}, minLevel);
}
