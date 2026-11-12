import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.each(['ordinary', 'worktrees/checkout', '.claude/worktrees/checkout'])(
  'keeps script entrypoints in %s while ignoring root-local child checkouts',
  (location) => {
    const repository = fileURLToPath(new URL('../', import.meta.url));
    const temporary = mkdtempSync(path.join(tmpdir(), 'fluent-knip-discovery-'));
    const checkout = path.join(temporary, location);
    try {
      mkdirSync(path.join(checkout, '.git'), { recursive: true });
      copyFileSync(path.join(repository, '.gitignore'), path.join(checkout, '.gitignore'));
      const files = {
        'package.json': JSON.stringify({ scripts: { start: 'node src/entry.js' } }),
        'src/entry.js': 'export { value } from "./helper.js";\n',
        'src/helper.js': 'export const value = 1;\n',
        'worktrees/child/src/hidden.js': 'export const hidden = 1;\n',
        '.claude/worktrees/child/src/hidden.js': 'export const hidden = 1;\n',
      };
      for (const [relative, content] of Object.entries(files)) {
        const file = path.join(checkout, relative);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, content);
      }
      const report = JSON.parse(
        execFileSync(
          process.execPath,
          [
            path.join(repository, 'node_modules/knip/bin/knip.js'),
            '--reporter',
            'json',
            '--no-exit-code',
          ],
          { cwd: checkout, encoding: 'utf8', timeout: 10000 }
        )
      );
      expect(report.files).toEqual([]);
      expect(report.issues).toEqual([]);
      // Git's own root-relative semantics must still exclude both child checkout locations.
      execFileSync('git', ['init', '--quiet'], { cwd: checkout });
      const ignored = execFileSync(
        'git',
        ['check-ignore', 'worktrees/child/src/hidden.js', '.claude/worktrees/child/src/hidden.js'],
        { cwd: checkout, encoding: 'utf8' }
      );
      expect(ignored.trim().split(/\r?\n/)).toEqual([
        'worktrees/child/src/hidden.js',
        '.claude/worktrees/child/src/hidden.js',
      ]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
  15000
);
