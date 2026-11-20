export interface IssueLike {
  path: PropertyKey[];
  message: string;
}

export interface SchemaLike<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: { issues: IssueLike[] } };
}

export class ValidationError extends Error {
  readonly statusCode = 400;
  constructor(readonly issues: IssueLike[]) {
    super('validation');
  }
}

/** Parses a request body with a Zod schema; throws a 400 `{ error: 'validation', issues }` on failure. */
export function parseBody<T>(schema: SchemaLike<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw new ValidationError(result.error.issues.map((i) => ({ path: i.path, message: i.message })));
  }
  return result.data;
}
