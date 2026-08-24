import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Book metadata authoring and USFM export generation are unrelated features. They happen to need
// the same project-unit read check today, but borrowing another domain's middleware couples them
// for no reason beyond that resemblance (review on #264). Each domain owns its own until we
// deliberately move the check into shared infrastructure.

const DOMAIN = join(import.meta.dirname, '.');

function sourceFiles(): string[] {
  return readdirSync(DOMAIN)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => join(DOMAIN, name));
}

describe('book-details domain boundaries', () => {
  it('imports nothing from another feature domain', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/^\s*import[^;]*?from\s+'([^']+)'/gm)) {
        const specifier = match[1];
        const isFeatureDomain = specifier.startsWith('../') || specifier.startsWith('@/domains/');
        if (!isFeatureDomain) continue;

        // Shared building blocks are fair game; a sibling feature's internals are not.
        const shared = ['@/domains/projects/'];
        if (shared.some((prefix) => specifier.startsWith(prefix))) continue;

        offenders.push(`${file.split('/').pop()} -> ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("has its own auth middleware rather than another domain's", () => {
    const route = readFileSync(join(DOMAIN, 'book-details.route.ts'), 'utf8');

    expect(route).toContain("from './book-details-auth.middleware'");
    expect(route).not.toContain('usfm-auth.middleware');
  });
});
