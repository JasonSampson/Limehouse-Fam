import type { NextFunction, Request, RequestHandler, Response } from "express";

// Express 4 does not catch errors thrown (or promises rejected) inside an
// `async (req, res) => {...}` route handler — the framework only ever
// awaits synchronous exceptions via try/catch internally, not promises.
// An unhandled rejection there doesn't become a clean 500 response; it
// becomes a genuine unhandled promise rejection at the Node process level,
// which (since Node 15) TERMINATES THE ENTIRE PROCESS — taking the whole
// site down for every user over one bad request, not just failing that one
// request. This is the same failure shape that crashed late-rent-notices'
// live server on 2026-08-04 (a database write rejected by a row-security
// rule, inside a route with no error handling).
//
// Wrapping every route handler in this — `router.get(path, asyncHandler(fn))`
// — forwards any thrown/rejected error to Express's own error-handling
// middleware (see server.ts's final app.use((err, req, res, next) => ...))
// instead, which turns it into a normal error response for that one
// request and leaves the server running for everyone else.
export function asyncHandler<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => unknown
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req as Req, res, next)).catch(next);
  };
}
