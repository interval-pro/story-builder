/** Converts snake_case Postgres rows into the camelCase domain entities. */
export function camelize<T>(row: Record<string, unknown>): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const camelKey = key.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase());
    result[camelKey] = value instanceof Date ? value.toISOString() : value;
  }
  return result as T;
}

export function camelizeAll<T>(rows: Record<string, unknown>[]): T[] {
  return rows.map((row) => camelize<T>(row));
}
