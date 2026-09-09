const ESC = String.fromCharCode(27);

const COLORS = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  blue: `${ESC}[34m`,
};

const useColor = Boolean(process.stdout.isTTY) && process.env['NO_COLOR'] === undefined;

function paint(color: keyof typeof COLORS, text: string): string {
  return useColor ? `${COLORS[color]}${text}${COLORS.reset}` : text;
}

export function heading(text: string): void {
  process.stdout.write(`\n${paint('bold', text)}\n`);
}

export function info(text: string): void {
  process.stdout.write(`${text}\n`);
}

export function step(text: string): void {
  process.stdout.write(`${paint('blue', '->')} ${text}\n`);
}

export function success(text: string): void {
  process.stdout.write(`${paint('green', 'ok')} ${text}\n`);
}

export function warn(text: string): void {
  process.stdout.write(`${paint('yellow', '!')} ${text}\n`);
}

export function failure(text: string): void {
  process.stderr.write(`${paint('red', 'x')} ${text}\n`);
}

export function table(rows: [string, string][]): void {
  const width = rows.reduce((max, [key]) => Math.max(max, key.length), 0);
  for (const [key, value] of rows) {
    process.stdout.write(`  ${paint('dim', key.padEnd(width))}  ${value}\n`);
  }
}
