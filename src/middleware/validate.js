// Shared request-validation middleware factory built on zod. Keeps
// validation error-handling/shape consistent across routes instead of each
// route reimplementing its own try/catch around schema.parse().

function validateBody(schema) {
  return function (req, res, next) {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid request body',
        errors: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message
        }))
      });
    }

    req.body = result.data;
    next();
  };
}

function validateParams(schema) {
  return function (req, res, next) {
    const result = schema.safeParse(req.params);

    if (!result.success) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid request parameters',
        errors: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message
        }))
      });
    }

    req.params = result.data;
    next();
  };
}

function validateQuery(schema) {
  return function (req, res, next) {
    const result = schema.safeParse(req.query);

    if (!result.success) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid query parameters',
        errors: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message
        }))
      });
    }

    req.query = result.data;
    next();
  };
}

module.exports = { validateBody, validateParams, validateQuery };
