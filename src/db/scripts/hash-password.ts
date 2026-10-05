import { hashPassword } from 'better-auth/crypto';

async function printPasswordHash() {
  const args = process.argv.slice(2);

  if (args.length !== 1) {
    console.error('Usage: npm run db:hash-password <password>');
    process.exit(1);
  }

  try {
    const hashedPassword = await hashPassword(args[0]);
    // Bare hash on stdout — pasted verbatim into a demo spec's passwordHash.
    console.log(hashedPassword);
    process.exit(0);
  } catch (error) {
    console.error('Failed to hash password:', error);
    process.exit(1);
  }
}

printPasswordHash();
