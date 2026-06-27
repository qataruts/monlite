/** Base error for all monlite-originated failures. */
export class MonliteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "MonliteError";
    if (options?.cause !== undefined) (this as any).cause = options.cause;
  }
}

/** Thrown when a query/update payload is malformed. */
export class MonliteQueryError extends MonliteError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MonliteQueryError";
  }
}

/** Thrown when an encrypted database can't be opened (wrong key, not encrypted). */
export class MonliteEncryptionError extends MonliteError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MonliteEncryptionError";
  }
}

/** A database constraint was violated (base class for the specific kinds). */
export class MonliteConstraintError extends MonliteError {
  readonly collection?: string;
  constructor(
    message: string,
    options?: { cause?: unknown; collection?: string },
  ) {
    super(message, options);
    this.name = "MonliteConstraintError";
    this.collection = options?.collection;
  }
}

/** A UNIQUE (or primary-key) constraint was violated. */
export class MonliteUniqueConstraintError extends MonliteConstraintError {
  constructor(
    message: string,
    options?: { cause?: unknown; collection?: string },
  ) {
    super(message, options);
    this.name = "MonliteUniqueConstraintError";
  }
}

/** A NOT NULL constraint was violated. */
export class MonliteNotNullError extends MonliteConstraintError {
  constructor(
    message: string,
    options?: { cause?: unknown; collection?: string },
  ) {
    super(message, options);
    this.name = "MonliteNotNullError";
  }
}

/** A FOREIGN KEY constraint was violated. */
export class MonliteForeignKeyError extends MonliteConstraintError {
  constructor(
    message: string,
    options?: { cause?: unknown; collection?: string },
  ) {
    super(message, options);
    this.name = "MonliteForeignKeyError";
  }
}

/**
 * Normalize a raw driver error (better-sqlite3 `SqliteError` or node:sqlite
 * error) into a typed {@link MonliteError}. The two backends differ in error
 * shape, so we sniff both the `code` and the message text.
 */
export function normalizeDriverError(
  err: unknown,
  collection?: string,
): MonliteError {
  if (err instanceof MonliteError) return err;

  const code = (err as any)?.code ? String((err as any).code) : "";
  const message = err instanceof Error ? err.message : String(err);
  const blob = `${code} ${message}`;

  const opts = { cause: err, collection };

  if (/UNIQUE|PRIMARY KEY|constraint failed: .*\.(?:_id)\b/i.test(blob)) {
    return new MonliteUniqueConstraintError(message, opts);
  }
  if (/NOT ?NULL/i.test(blob)) {
    return new MonliteNotNullError(message, opts);
  }
  if (/FOREIGN ?KEY/i.test(blob)) {
    return new MonliteForeignKeyError(message, opts);
  }
  if (/CONSTRAINT/i.test(blob)) {
    return new MonliteConstraintError(message, opts);
  }
  return new MonliteError(message, { cause: err });
}
