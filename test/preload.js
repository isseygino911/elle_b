'use strict';

// Loaded via `node --import` before any test module is evaluated.
//
// WHY IT HAS TO BE THIS EARLY
// src/config/env.js validates its required variables at import time and throws
// if any are missing, and src/db/pool.js builds its connection pool from those
// values at import time too. Both run the moment anything requires them --
// including test/helpers/auth.js, which pulls in src/utils/jwt.js at module
// scope.
//
// So by the time a test file's before() hook runs, it is already too late: the
// app modules have been evaluated against whatever process.env held. Loading
// .env.test here, in a preload, is what makes "the app's own pool points at the
// test schema" true rather than aspirational.
//
// The guards in helpers/env.js run as part of this, so a misconfigured run dies
// here -- before a single test executes, and before any connection opens.

// loadTestEnv derives the per-process schema (elle_test_<pid>) and writes it
// back to process.env.DB_NAME itself, so this call is what fixes the scratch
// schema for the whole process: src/db/pool.js reads DB_NAME to build the pool
// the ROUTES use, and that has to be the same schema the fixtures write into.
//
// The assignment lives inside loadTestEnv rather than here because that
// function is called again later (db.js, on create and on drop) and re-reads
// .env.test with override:true each time -- which would otherwise reset
// DB_NAME to the base name and point any subsequently-rebuilt pool at the
// database "elle_test", which does not exist.
require('./helpers/env').loadTestEnv();
