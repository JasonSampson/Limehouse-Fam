// Thrown by route handlers and middleware to signal a known HTTP error.
// The global error handler in server.ts catches these and sends the right
// status code. Everything else becomes a 500.
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
