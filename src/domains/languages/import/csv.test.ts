import { describe, expect, it } from 'vitest';

import { detectDelimiter, parseCsv, parseLine } from './csv';

describe('detectDelimiter', () => {
  it('detects tab delimiter when header contains a tab', () => {
    expect(detectDelimiter('LangID\tName')).toBe('\t');
  });

  it('defaults to comma when header has no tab', () => {
    expect(detectDelimiter('LangID,Name')).toBe(',');
  });
});

describe('parseLine', () => {
  it('splits a simple comma-delimited line', () => {
    expect(parseLine('aaa,Test Language,US', ',')).toEqual(['aaa', 'Test Language', 'US']);
  });

  it('keeps commas inside quoted fields intact', () => {
    expect(parseLine('aaa,"Language, With Comma",US', ',')).toEqual([
      'aaa',
      'Language, With Comma',
      'US',
    ]);
  });

  it('unescapes doubled quotes inside a quoted field', () => {
    expect(parseLine('aaa,"Say ""Hi""",US', ',')).toEqual(['aaa', 'Say "Hi"', 'US']);
  });

  it('splits on tabs when given a tab delimiter', () => {
    expect(parseLine('aaa\tTest Language\tUS', '\t')).toEqual(['aaa', 'Test Language', 'US']);
  });
});

describe('parseCsv', () => {
  it('parses headers as lowercase and trimmed, and rows as string arrays', () => {
    const content = 'LangID,Name,Country\naaa,Test Language,US\nbbb,Other Language,FR\n';
    expect(parseCsv(content)).toEqual({
      headers: ['langid', 'name', 'country'],
      rows: [
        ['aaa', 'Test Language', 'US'],
        ['bbb', 'Other Language', 'FR'],
      ],
    });
  });

  it('auto-detects a tab-delimited file', () => {
    const content = 'ISO_639\tPrint_Name\naaa\tAutonym One\n';
    expect(parseCsv(content)).toEqual({
      headers: ['iso_639', 'print_name'],
      rows: [['aaa', 'Autonym One']],
    });
  });

  it('skips blank lines', () => {
    const content = 'LangID,Name\naaa,Test Language\n\nbbb,Other Language\n';
    expect(parseCsv(content).rows).toHaveLength(2);
  });

  it('returns empty headers and rows when the file has fewer than 2 lines', () => {
    expect(parseCsv('LangID,Name\n')).toEqual({ headers: [], rows: [] });
  });

  it('strips a UTF-8 BOM from the start of the file', () => {
    const content = '\uFEFFLangID,Name\naaa,Test Language\n';
    expect(parseCsv(content)).toEqual({
      headers: ['langid', 'name'],
      rows: [['aaa', 'Test Language']],
    });
  });

  it('handles Windows CRLF line endings', () => {
    const content = 'LangID,Name\r\naaa,Test Language\r\nbbb,Other Language\r\n';
    expect(parseCsv(content)).toEqual({
      headers: ['langid', 'name'],
      rows: [
        ['aaa', 'Test Language'],
        ['bbb', 'Other Language'],
      ],
    });
  });

  it('preserves spaces inside quoted fields when not trimming data lines', () => {
    const content = 'LangID,Name\naaa," Spaced Name "\n';
    expect(parseCsv(content)).toEqual({
      headers: ['langid', 'name'],
      rows: [['aaa', ' Spaced Name ']],
    });
  });

  it('preserves newlines inside quoted fields', () => {
    const content = 'LangID,Name\naaa,"Multi-line\nName"\n';
    expect(parseCsv(content)).toEqual({
      headers: ['langid', 'name'],
      rows: [['aaa', 'Multi-line\nName']],
    });
  });
});
