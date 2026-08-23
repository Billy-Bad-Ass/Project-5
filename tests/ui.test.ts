import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderConsole } from '../src/ui/console';

/**
 * The console is a hand-written page rather than a build artifact, so check it
 * renders, escapes what it interpolates, and that its script actually parses.
 */
describe('operator console', () => {
  const html = renderConsole({ BBA_BUSINESS_NAME: 'BBA Network', BBA_ENV: 'test' } as never);

  it('renders the business name and environment', () => {
    expect(html).toContain('BBA Network Growth OS');
    expect(html).toContain('>test<');
  });

  it('leaves no unreplaced placeholders', () => {
    expect(html).not.toMatch(/__[A-Z_]+__/);
  });

  it('escapes what it interpolates', () => {
    const injected = renderConsole({
      BBA_BUSINESS_NAME: '<script>alert(1)</script>',
      BBA_ENV: 'test',
    } as never);
    expect(injected).not.toContain('<script>alert(1)</script>');
    expect(injected).toContain('&lt;script&gt;');
  });

  it('has a script block that parses as JavaScript', () => {
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    const path = `${process.env.TMPDIR ?? '/tmp'}/bba-console-check.mjs`;
    writeFileSync(path, script!);
    expect(() => execFileSync(process.execPath, ['--check', path])).not.toThrow();
  });
});
