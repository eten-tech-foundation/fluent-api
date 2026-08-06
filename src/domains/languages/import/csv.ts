export function detectDelimiter(headerLine: string): string {
  return headerLine.includes('\t') ? '\t' : ',';
}

export function parseLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

export function parseCsv(content: string): ParsedCsv {
  const cleaned = content.startsWith('\uFEFF') ? content.slice(1) : content;
  const lines = cleaned
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((line) => line.trim().length > 0);

  if (lines.length < 2) {
    return { headers: [], rows: [] };
  }

  const delimiter = detectDelimiter(lines[0]);
  const headers = parseLine(lines[0], delimiter).map((header) => header.trim().toLowerCase());
  const rows = lines.slice(1).map((line) => parseLine(line, delimiter));

  return { headers, rows };
}
