'use strict';

// Starts the real Express app on an ephemeral port and returns a fetch-based
// client for it.
//
// LOAD ORDER IS LOAD-BEARING
// src/db/pool.js builds its pool from src/config/env.js at require time, and
// src/config/env.js reads process.env at require time. So the app's pool points
// wherever process.env pointed at the moment it was first required -- which
// means .env.test must already be loaded before anything pulls in src/app.js.
//
// startTestServer() therefore requires the app lazily, after asserting the env
// is loaded. Requiring src/app.js at the top of this file would defeat that:
// Node caches the module on first require, and by then the pool is already
// bound to whatever DB_NAME was set to -- which, if .env.test had not loaded,
// is production.
//
// No supertest: Node 22 has fetch and http.Server.listen(0) gives an ephemeral
// port, so the dependency would buy nothing.

const http = require('http');

let server = null;
let baseUrl = null;

// Node's global fetch keeps connections alive between requests. That is the
// right default for a client and wrong for a test process: the pooled sockets
// outlive the last assertion, server.close() then blocks waiting for them to
// go idle, and the run hangs after printing every passing result -- a CI
// timeout with no failing assertion to explain it.
//
// server.closeAllConnections() (Node 18.2+) severs them outright, which is
// what teardown wants. No new dependency; the alternative was a custom undici
// Agent.

async function startTestServer() {
  if (server) {
    return baseUrl;
  }

  // Fail loudly rather than silently binding to the wrong database. This is the
  // same class of check as test/helpers/env.js's, at the one other place where
  // a wrong value would be catastrophic and invisible.
  if (process.env.NODE_ENV !== 'test' || !String(process.env.DB_NAME || '').startsWith('elle_test')) {
    throw new Error(
      'startTestServer() called before .env.test was loaded ' +
        `(NODE_ENV=${process.env.NODE_ENV}, DB_NAME=${process.env.DB_NAME}). ` +
        'Call createTestSchema() first -- requiring the app now would bind its ' +
        'connection pool to the wrong database.'
    );
  }

  // eslint-disable-next-line global-require
  const app = require('../../src/app');

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
  return baseUrl;
}

async function stopTestServer() {
  if (server) {
    // Order matters: close() stops accepting and waits for existing
    // connections, so the keep-alive sockets must be severed or it never
    // resolves.
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    server = null;
    baseUrl = null;
  }

  // Close the APP's pool, not just the test harness's.
  //
  // src/db/pool.js creates a module-level pool at require time and nothing in
  // the app ever ends it -- correct for a long-lived server, fatal for a test
  // process. Its idle sockets keep the event loop alive, so `npm test` printed
  // every passing result and then hung instead of exiting. Two-minute CI
  // timeouts, no failing assertion to explain them.
  //
  // Guarded by require.cache: if no test in this file ever started the server,
  // the module was never loaded and requiring it here would create a pool
  // purely in order to close it.
  const poolPath = require.resolve('../../src/db/pool');
  if (require.cache[poolPath]) {
    await require.cache[poolPath].exports.end();
    delete require.cache[poolPath];
  }
}

// Thin wrapper over fetch. Returns { status, body } with the JSON already
// parsed, since every route in this app answers JSON; a non-JSON body (an
// unhandled 500 rendering HTML, say) comes back as raw text so the failure is
// legible rather than a parse error.
async function request(method, path, { headers = {}, body, token } = {}) {
  if (!baseUrl) {
    throw new Error('request() called before startTestServer()');
  }

  const finalHeaders = { ...headers };
  if (token) {
    finalHeaders.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) {
    finalHeaders['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: finalHeaders,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (err) {
    parsed = text;
  }

  return { status: response.status, body: parsed };
}

const get = (path, opts) => request('GET', path, opts);
const post = (path, opts) => request('POST', path, opts);
const patch = (path, opts) => request('PATCH', path, opts);
const del = (path, opts) => request('DELETE', path, opts);

module.exports = { startTestServer, stopTestServer, request, get, post, patch, del };
