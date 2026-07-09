# S3 Bucket Setup — Phase 2 Survey Upload / Phase 3 Video

**Update:** the credential in `.env` (`AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`) *is* usable programmatically from this environment
via `@aws-sdk/client-s3` — this was verified and used directly to diagnose
and fix the CORS gap documented in "Bucket CORS configuration" below. The
"no AWS access" framing in the rest of this document (written earlier) is
stale for anything the app's own admin-scoped credential can already do
(read/write bucket config, objects). It's still accurate for anything
requiring the AWS *console* or a *different* credential (creating a new IAM
user, enabling account-level settings) — those remain manual steps for a
human, per the sections below.

Known current state: the bucket `elle-project` (region `us-east-1`) already
exists and is in active use by the app — confirmed directly (see the CORS
fix below), not just reported secondhand. `.env`'s `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` currently hold the user's **personal admin-scoped**
AWS credential (`AdministratorAccess` + `AmazonS3FullAccess`), not a
dedicated least-privilege credential. This is a known, accepted, deferred
gap — not something fixed as part of this doc. The two policy files below
(`infra/s3-bucket-policy.json`, `infra/s3-iam-policy.json`) are drafted
against the real bucket name (`elle-project`) and are ready to paste in
as-is once the user gives the go-ahead, but **neither has been attached to
the live bucket/IAM**, and no new IAM user/access key has been created yet.

## What this bucket is for

Two code paths, both going through the single S3 client in
`src/services/s3.js` (the only file in the app that imports
`@aws-sdk/client-s3`):

- **Phase 2 survey upload/download.** The Express server uploads survey
  files directly with `s3:PutObject` (`putSurveyObject`) and serves
  downloads exclusively via a server-generated presigned `GetObject` URL with
  a 10-minute TTL (`getSurveyDownloadUrl`). There is no direct browser-to-S3
  upload for surveys — the file goes through the Express server.
- **Phase 3 video upload/playback.** The browser uploads video files
  *directly* to S3 via a presigned POST (`createVideoUploadPost`, action
  `s3:PutObject`) that the server signs — this is the one direct
  browser-to-S3 path, constrained by a `content-length-range` condition and a
  pinned `Content-Type`. After the client reports the upload succeeded, the
  server confirms the object actually landed via `HeadObjectCommand`
  (`headVideoObject` — IAM-wise this uses the same `s3:GetObject` permission
  as `GetObject`, per AWS's own action mapping, so no extra action is
  needed). Playback happens via a server-generated presigned `GetObject` URL
  (`getVideoPlaybackUrl`).

Across both paths, the app's code only ever calls `PutObject`, `GetObject`,
and `HeadObject` (which is authorized by the `s3:GetObject` permission) on
individual object keys. It never sets an ACL, never deletes an object, never
lists bucket contents, and never uses multipart upload. No object in this
bucket should ever be publicly readable.

## Bucket CORS configuration

The Phase 3 direct browser-to-S3 video upload (`uploadFileToS3` in
`client/src/api/client.js`, posting straight to the presigned-POST URL from
`createVideoUploadPost`) is a genuine cross-origin request from the app's own
origin to `elle-project`'s S3 endpoint. S3 buckets have **no CORS rules by
default** — without one, the browser blocks the app's JS from reading the
upload response (even though the object still lands in S3), which surfaces
in the app as a generic `TypeError: Failed to fetch` with no further detail.
Survey upload/download and video playback don't need this: survey files go
through the Express server (not a direct browser-to-S3 call), and playback
uses a plain `<video src={presignedUrl}>` element, which doesn't invoke CORS.

This was hit as a real bug (video upload failing with "Failed to fetch"),
diagnosed by querying the live bucket directly (`GetBucketCorsCommand`
returned `NoSuchCORSConfiguration`), and fixed by applying
`infra/s3-cors-config.json` to the bucket via `PutBucketCorsCommand`, using
the same admin-scoped credential already in `.env`:

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["http://localhost:5173"],
      "AllowedMethods": ["POST"],
      "AllowedHeaders": ["*"],
      "MaxAgeSeconds": 3000
    }
  ]
}
```

`AllowedMethods` is `POST`-only (least privilege: that's the only
cross-origin S3 call this app's frontend makes). `AllowedOrigins` mirrors
`.env`'s `CORS_ORIGIN` exactly (currently the single local dev origin,
`http://localhost:5173`) — **when a production client origin is set for
`CORS_ORIGIN`, this file must be updated to include it too, and
`PutBucketCorsCommand` re-run against the live bucket**, the same way the
Express `cors()` middleware's origin config would need to change. These two
origin lists are conceptually the same "who's allowed to call us" list,
just enforced by two different systems (Express for the API, S3 CORS for the
one direct browser-to-S3 path) — keep them in sync.

## Manual steps (require real AWS access)

1. **Bucket already exists — nothing to create.**
   This project's actual bucket name is:
   ```
   elle-project
   ```
   in region `us-east-1`, matching `AWS_REGION`/`AWS_S3_BUCKET` currently set
   in `.env`. Per the CEO/other agents, this bucket already exists and
   is in active use by the running app (uploads/downloads work today via the
   personal admin credential currently in `.env`). This step is listed
   for completeness/history only — do not attempt to create it again.
   (Earlier drafts of this doc used a placeholder naming convention,
   `student-crm-surveys-<environment>` — that was never this project's real
   bucket name and should be disregarded; `elle-project` is the one and only
   bucket for this project, not an environment-suffixed family of buckets.)

2. **Verify (or enable) default bucket-wide encryption — SSE-S3 (AES-256).**
   This environment has no AWS CLI/console access, so whether this is already
   enabled on the live `elle-project` bucket could not be confirmed as part
   of this task. Check the bucket's *Properties* tab → *Default encryption*;
   if not already set, enable **Amazon S3-managed keys (SSE-S3)**. This must
   be bucket-wide default encryption, not something left to per-object opt-in
   at upload time.

3. **Verify (or enable) Block Public Access — all four settings.**
   Same caveat as step 2 — current status not verifiable from this
   environment. Check the bucket's *Permissions* tab → *Block public access
   (bucket settings)*; if not already all enabled, edit and enable all four:
   - Block public access to buckets and objects granted through *new* ACLs
   - Block public access to buckets and objects granted through *any* ACLs
   - Block public access to buckets and objects granted through *new* public
     bucket policies
   - Block public and cross-account access to buckets and objects through
     *any* public bucket policies

   **This Block Public Access setting is the primary control against public
   exposure.** The bucket policy in step 4 is defense-in-depth on top of it,
   not a substitute for it — don't skip this step because the policy also
   has public-access denies in it.

4. **Attach the bucket policy (not yet done — requires the user's go-ahead).**
   `infra/s3-bucket-policy.json` already has the real bucket name
   (`elle-project`) filled in — no placeholder substitution needed, paste it
   as-is into the bucket's *Permissions* tab → *Bucket policy*. This policy
   denies any non-HTTPS request (`aws:SecureTransport: false`) and denies
   anyone attempting to set a public-read/public-read-write/authenticated-read
   ACL on an object or the bucket itself. It intentionally has no `Allow`
   statement — access for the app is granted entirely by the IAM policy in
   step 6, not by this resource-based policy. Reviewed as of this doc's last
   update: consistent with a private-bucket + presigned-URL-only access
   model, no public-read/write `Allow` statements present, ready to attach
   as-is once the user confirms.

5. **Decide on object key layout (informational, no action required here).**
   Per `migrations/0002_create_surveys.sql`, the app stores the S3 key
   for each survey in `surveys.s3_key` (`VARCHAR(512)`, expected to be a UUID
   + sanitized original filename). The app looks up objects by the key stored
   in MySQL — it does not need to list bucket contents. This is why the IAM
   policy below omits `s3:ListBucket` (least privilege: only grant what's
   used).

6. **Create a single dedicated IAM user (or role) scoped to only this
   bucket, and attach the least-privilege policy (not yet done).**
   - Create a *new* IAM user (e.g. `elle-project-app`) distinct from the
     user's personal admin account — do not reuse or repurpose the personal
     admin user. Or, if the VPS ever runs on EC2/ECS with an instance/task
     role available, prefer an IAM role over a long-lived IAM user key — but
     since the Express server is a plain process on a Hostinger VPS (this
     project's current deploy approach), an IAM user with an access key is
     the applicable option today.
   - Attach `infra/s3-iam-policy.json` as an inline or customer-managed
     policy on that user/role — it already has the real bucket name filled
     in (`arn:aws:s3:::elle-project/*`), no substitution needed. It grants
     only `s3:PutObject` and `s3:GetObject` — nothing bucket-wide, nothing on
     any other bucket, no `s3:*`, no `ListBucket` (see step 5), no
     `PutObjectAcl`/`DeleteObject`/list/multipart actions, because the app's
     code (`src/services/s3.js`) never calls those.
   - Do not attach any AWS-managed broad policy (e.g. `AmazonS3FullAccess`,
     `AdministratorAccess`) to this user/role alongside the scoped policy —
     that would defeat the least-privilege scoping.

7. **Generate an access key for that IAM user** (if using an IAM user rather
   than a role) via IAM → the user → *Security credentials* → *Create access
   key*. Store the resulting key ID and secret somewhere safe (a secrets
   manager or the VPS's `.env`, gitignored) — never in this repo,
   never in a commit, never in this doc.

8. **Populate `.env`.**
   Fill in the four AWS variables already documented (names only, no values)
   in the repo root's `.env.example`:
   - `AWS_REGION` — the region the bucket was created in (step 1).
   - `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — from step 7. Real
     secrets — never commit them; `.env` is gitignored.
   - `AWS_S3_BUCKET` — the real bucket name from step 1.

   If the parallel backend task that wires up the S3 client ends up reading a
   differently-named env var, treat `.env.example` (updated by that task) as
   the source of truth over this doc, and use whatever bucket-name variable
   is documented there — don't let this doc's variable name silently drift
   from the actual code.

## Credential rotation plan: personal admin credential → dedicated least-privilege credential

**Not executed. Every step below requires the user's own AWS console/CLI
access and explicit go-ahead before being carried out — nothing in this
section has been run.** This is the ordered plan for retiring the personal
admin credential currently used for this app's S3 access, in favor of the
dedicated user + policy described in steps 6-7 above.

  a. **Create the new, dedicated IAM user** (step 6 above) — a new IAM user
     (e.g. `elle-project-app`), *not* the user's existing personal admin
     account, with `infra/s3-iam-policy.json` attached and no other
     policy attached.

  b. **Generate a new access key** for that dedicated user (step 7 above).
     Store the key ID/secret outside this repo (secrets manager, or directly
     into the VPS's `.env`, gitignored) — never commit it, never
     paste it into this doc or any chat/log.

  c. **Update `.env`'s `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`**
     to the new dedicated-user credential from step (b). `AWS_REGION` and
     `AWS_S3_BUCKET` stay the same (`us-east-1` / `elle-project`) — only the
     credential pair changes.

  d. **Verify the app still works end-to-end with the new credential before
     removing the old one from use.** At minimum, manually re-test:
     - Survey upload (Phase 2): upload a survey file, confirm it lands in
       `elle-project` and the DB row's `s3_key` is set.
     - Survey download: fetch the presigned download URL and confirm the
       file downloads correctly within the 10-minute TTL.
     - Video upload (Phase 3): request a presigned POST, upload a test video
       directly from the browser, confirm the server's `HeadObjectCommand`
       check reports the object present.
     - Video playback: fetch the presigned playback URL and confirm the
       video plays back correctly within its TTL.
     Do not proceed to step (e) until all four checks pass with the new
     credential.

  e. **Only after (d) is confirmed working, stop using the old admin
     credential for this app** — remove/replace it in `.env` (already
     done by step c once (d) passes) and deactivate that access key via IAM
     → the personal admin user → *Security credentials* (or delete it, per
     the user's preference). To be explicit: this deactivates/deletes only
     the *access key* that was being used for this app's `.env` — it does
     **not** delete or modify the user's actual personal AWS admin IAM user
     itself, which may still be used for other purposes.

None of steps (a)-(e) have been performed. They remain manual, user-executed
follow-up actions.

## Presigned URL / TTL note (backend responsibility, documented here for
## context only — not something this doc configures)

Downloads happen exclusively via presigned `GetObject` URLs generated
server-side (10-minute TTL per the current backend implementation). No IAM
or bucket-policy change is needed to support this — a presigned URL is just
a time-limited signature computed from the IAM user's own credentials
against actions that user is already allowed to perform
(`s3:GetObject`, per `infra/s3-iam-policy.json`). If that TTL ever changes,
it's a backend code change, not an infra change.

## Verification checklist (to be run by whoever provisions/rotates this — not run here)

- [x] Bucket exists, correct region (`elle-project`, `us-east-1`) — confirmed
      directly via the SDK while diagnosing the CORS gap below.
- [x] Bucket CORS configuration (`infra/s3-cors-config.json`) applied and
      verified live on the bucket — see "Bucket CORS configuration" above.
      Re-apply whenever `CORS_ORIGIN` gains a production origin.
- [ ] Default encryption (SSE-S3/AES-256) enabled at the bucket level.
- [ ] Block Public Access: all four settings enabled.
- [ ] Bucket policy from `infra/s3-bucket-policy.json` attached (real bucket
      name already filled in — nothing to substitute).
- [ ] New dedicated IAM user/role created (distinct from the personal admin
      user), with the policy from `infra/s3-iam-policy.json` attached (real
      bucket name already filled in) and no broader AWS-managed policy
      attached alongside it.
- [ ] New access key generated for that dedicated user and stored outside
      this repo.
- [ ] `.env`'s `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` updated to
      the new dedicated-user credential (rotation plan steps a-c above).
- [ ] End-to-end re-test performed with the new credential: survey upload,
      survey download, video upload, video playback (rotation plan step d
      above) — all four pass.
- [ ] Old personal admin access key deactivated/deleted from use for this app
      only after the above re-test passes (rotation plan step e above) — the
      personal admin IAM user itself is not touched, only its access key's
      use in this app's `.env`.

None of the above boxes have been checked from this environment. This
checklist exists for the human doing the actual provisioning/rotation.
