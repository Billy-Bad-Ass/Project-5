type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Structured single-line JSON logging. Workers Logs indexes the fields, so
 * keep values flat and greppable (run_id, agent, channel).
 */
export class Logger {
  private readonly min: number;
  private readonly level: Level;

  constructor(
    level: string = 'info',
    private readonly base: Record<string, unknown> = {},
  ) {
    this.level = (level as Level) in ORDER ? (level as Level) : 'info';
    this.min = ORDER[this.level];
  }

  /** A logger that carries extra fields on every line, at the same level. */
  child(fields: Record<string, unknown>): Logger {
    return new Logger(this.level, { ...this.base, ...fields });
  }

  debug(msg: string, fields?: Record<string, unknown>) {
    this.write('debug', msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>) {
    this.write('info', msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>) {
    this.write('warn', msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>) {
    this.write('error', msg, fields);
  }

  private write(level: Level, msg: string, fields?: Record<string, unknown>) {
    if (ORDER[level] < this.min) return;
    const line = JSON.stringify({
      level,
      msg,
      ts: new Date().toISOString(),
      ...this.base,
      ...fields,
    });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
}

/** Errors are not JSON-serialisable by default. */
export function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { error: err.message, error_name: err.name, stack: err.stack?.slice(0, 2000) };
  }
  return { error: String(err) };
}
