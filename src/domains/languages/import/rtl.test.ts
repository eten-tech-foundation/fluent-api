import { describe, expect, it } from 'vitest';

import { isRTL } from './rtl';

describe('isRTL', () => {
  it('matches by explicit RTL code even when the name has no RTL keyword', () => {
    expect(isRTL('urd', 'Urdu')).toBe(true);
  });

  it('matches by RTL keyword in the name', () => {
    expect(isRTL('arb', 'Arabic, Baharna')).toBe(true);
    expect(isRTL('heb', 'Hebrew')).toBe(true);
  });

  it('matches Dhivehi via its explicit code rather than a name keyword', () => {
    expect(isRTL('div', 'Dhivehi')).toBe(true);
  });

  it('matches RTL keywords case-insensitively', () => {
    expect(isRTL('xxx', 'arabic dialect')).toBe(true);
    expect(isRTL('xxx', 'HEBREW')).toBe(true);
  });

  it('returns false for languages with no RTL signal', () => {
    expect(isRTL('eng', 'English')).toBe(false);
    expect(isRTL('fra', 'French')).toBe(false);
  });
});
