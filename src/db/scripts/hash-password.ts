import type { Buffer } from 'node:buffer';

import { hashPassword } from 'better-auth/crypto';
import { createInterface } from 'node:readline/promises';

// Never take the password from argv: it would land in shell history and be
// readable from the process list. TTY → hidden-echo prompt; piped → stdin
// (`printf "%s" "$PASSWORD" | npm run db:hash-password`).
async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    // First line of piped stdin — resolves on the first '\n' or on EOF. A
    // bare `for await…of process.stdin` would hang on interactive pipes
    // (e.g. Git Bash/mintty) that never send EOF.
    const rl = createInterface({ input: process.stdin });
    const { value, done } = await rl[Symbol.asyncIterator]().next();
    rl.close();
    return done ? '' : value;
  }

  process.stdout.write('Password: ');
  return new Promise((resolve) => {
    let password = '';
    let inEscape = false;
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.on('data', (chunk: Buffer | string) => {
      for (const char of chunk.toString()) {
        // Swallow ANSI escape sequences (arrow keys, Home/Delete, …).
        if (char === '\x1B') {
          inEscape = true;
          continue;
        }
        if (inEscape) {
          if (/[\x40-\x7E]/.test(char)) inEscape = false; // CSI final byte
          continue;
        }
        if (char === '\r' || char === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write('\n');
          resolve(password);
          return;
        }
        if (char === '\u0003') {
          process.stdout.write('\n');
          process.exit(1); // Ctrl-C
        }
        if (char === '\u007F' || char === '\b') {
          password = password.slice(0, -1);
          continue;
        }
        password += char;
      }
    });
  });
}

async function printPasswordHash() {
  if (process.argv.length > 2) {
    console.error(
      'Refusing to read the password from argv — it would end up in shell history\n' +
        'and the process list. Pass it via stdin instead:\n' +
        '  printf "%s" "$PASSWORD" | npm run db:hash-password\n' +
        'or run `npm run db:hash-password` and type it at the hidden prompt.'
    );
    process.exit(1);
  }

  const password = await readPassword();
  if (!password) {
    console.error(
      'Usage: npm run db:hash-password  (prompts for the password, or reads it from stdin)'
    );
    process.exit(1);
  }

  try {
    const hashedPassword = await hashPassword(password);
    // Bare hash on stdout — pasted verbatim into a demo spec's passwordHash.
    console.log(hashedPassword);
    process.exit(0);
  } catch (error) {
    console.error('Failed to hash password:', error);
    process.exit(1);
  }
}

printPasswordHash();
