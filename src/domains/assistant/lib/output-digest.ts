import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { Utf8Size } from './utf8-size';

export const OUTPUT_DIGEST_ALGORITHM = 'sha256-utf16le-v1' as const;
const createOutputHash = () => createHash('sha256').update('fluent-turn-v1:output:utf16le-v1\0');

/** Fixed-domain SHA-256 of exact UTF-16LE code units. Unlike UTF-8, lone surrogates remain
 * distinct. Append boundaries do not affect the digest; copying hash state costs O(1).
 * Replacement starts a fresh digest. No user-supplied digest is accepted for issuance.
 */
export class OutputDigest {
  private hash = createOutputHash();
  private readonly size = new Utf8Size();

  get bytes(): number {
    return this.size.bytes;
  }

  append(text: string): void {
    this.size.append(text);
    this.hash.update(Buffer.from(text, 'utf16le'));
  }

  replace(text: string): void {
    this.hash = createOutputHash();
    this.size.replace('');
    this.append(text);
  }

  snapshot(): string {
    return this.hash.copy().digest('hex');
  }
}
