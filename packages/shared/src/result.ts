export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export async function tryCatch<T>(operation: () => Promise<T>): Promise<Result<T, Error>> {
  try {
    return ok(await operation());
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
