// Request-body validation middleware.
//
// Mounted per route with a zod schema from schemas.js. Two jobs:
//   1. Reject a body of the wrong shape with a readable 400 before it reaches a controller or a
//      Mongoose query. This is what stops `{"email": {"$ne": null}}` from becoming a query
//      operator: an object is simply not a string.
//   2. Replace `req.body` with the parsed result. zod strips unknown keys by default, so a handler
//      only ever sees the fields the schema names — no mass assignment from a spread body.
//
// The error envelope is the one every other failure in this API uses ({ success, message }); the
// Android client reads `message` off any non-2xx body.

const formatIssue = (issue) => {
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
};

/**
 * @param {import('zod').ZodType} schema
 * @returns {import('express').RequestHandler}
 */
export const validateBody = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body ?? {});

  if (!result.success) {
    return res.status(400).json({
      success: false,
      message: formatIssue(result.error.issues[0]),
    });
  }

  req.body = result.data;
  return next();
};

export default validateBody;
