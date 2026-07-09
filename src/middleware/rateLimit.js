// Rate limiter applied specifically to the auth endpoints most prone to
// brute-forcing (/auth/login, /auth/register) — not mounted globally.

const rateLimit = require("express-rate-limit");

// Returns a fresh limiter instance (own store/counter) each call, so routes
// sharing the same limits don't end up sharing the same request budget.
function createAuthRateLimit() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      status: "error",
      message: "Too many attempts, please try again later",
    },
  });
}

module.exports = { createAuthRateLimit };
