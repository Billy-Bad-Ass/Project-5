export function nowIso(): string {
  return new Date().toISOString();
}

export function isoPlusMinutes(minutes: number, from: Date = new Date()): string {
  return new Date(from.getTime() + minutes * 60_000).toISOString();
}

export function isoPlusDays(days: number, from: Date = new Date()): string {
  return isoPlusMinutes(days * 24 * 60, from);
}

/** YYYY-MM-DD in UTC. */
export function utcDate(d: Date | string = new Date()): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toISOString().slice(0, 10);
}

/** YYYY-MM-DD in an IANA timezone, for per-account reporting days. */
export function localDate(timezone: string, d: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    return utcDate(d);
  }
}

export function daysAgoUtc(days: number, from: Date = new Date()): string {
  return utcDate(new Date(from.getTime() - days * 86_400_000));
}

export function isDue(iso: string | null, at: Date = new Date()): boolean {
  if (!iso) return true;
  return new Date(iso).getTime() <= at.getTime();
}
