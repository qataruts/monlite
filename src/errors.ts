/** Base error for all monlite-originated failures. */
export class MonliteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MonliteError";
  }
}

/** Thrown when a query/update payload is malformed. */
export class MonliteQueryError extends MonliteError {
  constructor(message: string) {
    super(message);
    this.name = "MonliteQueryError";
  }
}
