// Deletes the survey feature's leftover S3 objects -- everything under the
// "surveys/" key prefix, written by the since-removed survey XML import
// (surveys.route.js built keys as `surveys/<uuid>/<filename>`).
//
// This is the S3 half of the survey removal; migration 0037_drop_surveys.sql
// is the database half. It is deliberately NOT wired into package.json, the
// migration runner, or app startup: deleting object storage is irreversible
// and should be an explicit, deliberate act, not a side effect of a deploy.
//
// THE BUCKET IS SHARED. It also holds student practice videos, library files
// and organization logos. Everything here is therefore fenced to the
// "surveys/" prefix, and the script refuses to run if that prefix is empty or
// "/" -- a bare prefix would enumerate the entire bucket.
//
// Usage (from elle_b/):
//   node scripts/purge-survey-s3.js
//       -- DRY RUN. Lists every matching key and deletes nothing.
//
//   node scripts/purge-survey-s3.js --confirm-delete --bucket=<name>
//       -- Deletes. The bucket name must be typed out and must match the
//          configured AWS_S3_BUCKET, so a copy-pasted command cannot fire
//          against the wrong environment.
//
// Exits non-zero on any failure, including a partial delete, so a caller can
// tell "nothing left to do" from "something went wrong".

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const config = require('../src/config/env');
const {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand
} = require('@aws-sdk/client-s3');

const PREFIX = 'surveys/';

// S3 caps a single DeleteObjects request at 1000 keys.
const DELETE_BATCH_SIZE = 1000;

function parseArgs(argv) {
  const confirmDelete = argv.includes('--confirm-delete');
  const bucketArg = argv.find((arg) => arg.startsWith('--bucket='));
  return {
    confirmDelete,
    bucket: bucketArg ? bucketArg.slice('--bucket='.length) : null
  };
}

// Pages through every object under the prefix. ListObjectsV2 returns at most
// 1000 keys per call, so a bucket with more survey objects than that would be
// silently truncated without following ContinuationToken.
async function listAllKeys(client, bucket) {
  const keys = [];
  let continuationToken;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: PREFIX,
        ContinuationToken: continuationToken
      })
    );

    for (const object of response.Contents || []) {
      keys.push(object.Key);
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return keys;
}

async function deleteKeys(client, bucket, keys) {
  let deleted = 0;
  const errors = [];

  for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
    const batch = keys.slice(i, i + DELETE_BATCH_SIZE);
    const response = await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })) }
      })
    );

    deleted += (response.Deleted || []).length;

    for (const error of response.Errors || []) {
      errors.push(`${error.Key}: ${error.Code} ${error.Message}`);
    }

    console.log(`  deleted ${deleted}/${keys.length}`);
  }

  return { deleted, errors };
}

async function run() {
  const { confirmDelete, bucket: typedBucket } = parseArgs(process.argv.slice(2));
  const bucket = config.aws.bucket;

  // Guard the prefix before anything else. An empty or "/" prefix would list
  // -- and with --confirm-delete, delete -- every object in a bucket that also
  // holds videos, library files and logos.
  if (!PREFIX || PREFIX === '/') {
    console.error('Refusing to run: the survey key prefix is empty or "/".');
    process.exit(1);
  }

  if (!bucket) {
    console.error('Refusing to run: AWS_S3_BUCKET is not configured.');
    process.exit(1);
  }

  const client = new S3Client({ region: config.aws.region });

  console.log(`Bucket: ${bucket}`);
  console.log(`Region: ${config.aws.region}`);
  console.log(`Prefix: ${PREFIX}`);
  console.log('');

  const keys = await listAllKeys(client, bucket);

  if (keys.length === 0) {
    console.log('No objects found under the survey prefix. Nothing to do.');
    return;
  }

  console.log(`Found ${keys.length} object(s):`);
  for (const key of keys) {
    console.log(`  ${key}`);
  }
  console.log('');

  if (!confirmDelete) {
    console.log('DRY RUN -- nothing was deleted.');
    console.log('To delete these objects, re-run with:');
    console.log(`  node scripts/purge-survey-s3.js --confirm-delete --bucket=${bucket}`);
    return;
  }

  // The typed bucket is the confirmation. Requiring it to be spelled out, and
  // to match what this environment is actually pointed at, is what stops a
  // command copied from another terminal from firing against production.
  if (typedBucket !== bucket) {
    console.error(
      typedBucket
        ? `Refusing to delete: --bucket=${typedBucket} does not match the configured bucket (${bucket}).`
        : `Refusing to delete: --confirm-delete requires --bucket=${bucket}.`
    );
    process.exit(1);
  }

  console.log(`Deleting ${keys.length} object(s)...`);
  const { deleted, errors } = await deleteKeys(client, bucket, keys);

  console.log('');
  console.log(`Deleted ${deleted} of ${keys.length} object(s).`);

  if (errors.length > 0) {
    console.error(`${errors.length} object(s) failed to delete:`);
    for (const error of errors) {
      console.error(`  ${error}`);
    }
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Purge failed:', err);
  process.exit(1);
});
