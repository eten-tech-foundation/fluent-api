import { Buffer } from 'node:buffer';

/** UTF-8 size of exact concatenated JS text, including surrogate pairs split across appends. */
export class Utf8Size {
  bytes = 0;
  private trailingHighSurrogate = false;

  append(text: string): number {
    if (!text) return this.bytes;
    const first = text.charCodeAt(0);
    this.bytes +=
      Buffer.byteLength(text) -
      (this.trailingHighSurrogate && first >= 56320 && first <= 57343 ? 2 : 0);
    const last = text.charCodeAt(text.length - 1);
    this.trailingHighSurrogate = last >= 55296 && last <= 56319;
    return this.bytes;
  }

  replace(text: string): number {
    this.bytes = 0;
    this.trailingHighSurrogate = false;
    return this.append(text);
  }
}
