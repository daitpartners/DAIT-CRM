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

/** Parses a query string object with a Zod schema; same 400 `{ error: 'validation', issues }` as parseBody. */
export function parseQuery<T>(schema: SchemaLike<T>, query: unknown): T {
  return parseBody(schema, query);
}

/** Thrown when a record is absent or hidden from the user; the app answers 404 `{ error: 'not_found' }`. */
export class NotFoundError extends Error {
  readonly statusCode = 404;
  constructor() {
    super('not_found');
  }
}
