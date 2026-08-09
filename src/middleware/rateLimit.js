// Rate limiter applied specifically to the auth endpoints most prone to
// brute-forcing (/auth/login, /auth/register) — not mounted globally.

const rateLimit = require("express-rate-limit");
const config = require("../config/env");

// Returns a fresh limiter instance (own store/counter) each call, so routes
// sharing the same limits don't end up sharing the same request budget.
function createAuthRateLimit() {
  // Disabled under NODE_ENV=test only.
  //
  // The limiter keys on IP, and every request in a test run originates from
  // 127.0.0.1 -- so the whole suite shares one 5-per-minute budget and the
  // sixth registration test fails with a 429 that says nothing about the code
  // under test. Worse, it fails positionally: adding an unrelated test earlier
  // in the file breaks a later one.
  //
  // Gated on the config value rather than a bespoke flag, so this can only ever
  // be true where NODE_ENV is literally 'test'. Nothing sets that in
  // production; the test harness sets it in .env.test and refuses to run
  // without it.
  if (config.nodeEnv === "test") {
    return (req, res, next) => next();
  }

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
