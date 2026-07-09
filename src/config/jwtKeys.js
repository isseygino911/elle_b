// Loads the RS256 keypair used to sign/verify JWTs, from the paths declared
// in JWT_PRIVATE_KEY_PATH / JWT_PUBLIC_KEY_PATH (see src/config/env.js).
// Paths are resolved relative to the server project root (server/), matching
// the ./keys/... convention documented in .env.example.

const fs = require('fs');
const path = require('path');
const config = require('./env');

const SERVER_ROOT = path.join(__dirname, '..', '..');

function readKey(relativeOrAbsolutePath, label) {
  const resolvedPath = path.resolve(SERVER_ROOT, relativeOrAbsolutePath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(
      `JWT ${label} key not found at ${resolvedPath}. Generate a local dev ` +
        'keypair per .env.example instructions before starting the server.'
    );
  }

  return fs.readFileSync(resolvedPath, 'utf8');
}

module.exports = {
  privateKey: readKey(config.jwt.privateKeyPath, 'private'),
  publicKey: readKey(config.jwt.publicKeyPath, 'public')
};
