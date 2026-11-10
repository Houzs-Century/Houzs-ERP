# Nightly database backup: setup and restore

**What this is.** Every night at 03:00 Malaysia time a GitHub job copies the
whole Houzs ERP database (every sales order, delivery, stock and money record),
locks it with a key only the owner holds, and puts the locked copy in a private
Cloudflare R2 storage bucket that is used for nothing else. Thirty nights are
kept. If the database is ever lost or damaged, last night's copy can be put
back.

**Why it is locked.** This GitHub repository is public. Anything the job
uploaded as a GitHub "artifact" would be downloadable by anyone, which is
exactly what went wrong in `docs/staging-dump-artifact-exposure-coe.md`. So the
copy never becomes an artifact, is never printed, and is encrypted on the
GitHub machine before it is sent anywhere. Someone who stole the R2 password
would get only scrambled bytes; opening a copy needs the owner's private key,
which never leaves the owner.

**Until setup is done, the job does nothing.** It logs one line,
`backup not configured: <names> missing`, and finishes green. Nothing is read.

The job: `.github/workflows/nightly-db-backup.yml`. The check that stops
anyone removing the lock: `scripts/check-workflow-dump-artifacts.mjs`.

---

## Part 1 — one-time setup (owner, about 15 minutes)

### Step 1. Make the key pair (on your own Mac)

Open Terminal and run:

```sh
mkdir -p ~/houzs-backup-key && cd ~/houzs-backup-key
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out houzs-backup-private.pem
openssl pkey -in houzs-backup-private.pem -pubout | base64 | tr -d '\n' > houzs-backup-public.b64
```

- `houzs-backup-private.pem` is the **only** thing that can open a backup.
  Keep it offline: one copy on a USB stick in a safe place, one in your
  password manager. Never upload it, never paste it into GitHub, chat or email.
  **If it is lost, every backup becomes unreadable.**
- `houzs-backup-public.b64` is the lock. It is safe to give to GitHub.

### Step 2. Create the bucket (Cloudflare dashboard)

1. Cloudflare dashboard -> **R2 Object Storage** -> **Create bucket**.
2. Name: `houzs-erp-db-backups` (any name works; you will type it into GitHub
   in step 4). Location: Automatic. Leave **Public access off** and add no
   custom domain.
3. Open the bucket -> **Settings** -> **Object lifecycle rules** -> **Add rule**:
   name `keep-30-days`, applies to all objects, **Delete objects after 30
   days**. This is what keeps 30 nights and no more. The job does not delete
   anything itself on purpose: a job that can delete backups is one more way to
   lose them. If this rule is missing the job prints a warning once a copy is
   older than 35 days.

Do NOT reuse the app's file bucket. Backups live in their own bucket so the
app's credentials can never touch them, and theirs can never touch the app.

### Step 3. Create the bucket password (R2 API token)

1. **R2 Object Storage** -> **Manage R2 API Tokens** (or **API** -> **Manage
   API tokens**) -> **Create API token**.
2. Permissions: **Object Read & Write**.
3. **Apply to specific buckets only** -> choose `houzs-erp-db-backups`.
   Nothing else.
4. TTL: Forever (or a date you will remember to renew).
5. Create, then copy the **Access Key ID** and the **Secret Access Key** — the
   secret is shown once.
6. Also note your **Account ID**: it is on the R2 overview page (and in the
   endpoint shown there, `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`).

Why "Read & Write" and not write-only: R2 offers no write-only permission, and
the job reads back each file's size to prove the upload landed. Reading is
harmless — what it can read is locked.

### Step 4. Give GitHub the five values

GitHub -> the Houzs-ERP repository -> **Settings** -> **Secrets and
variables** -> **Actions** -> **New repository secret**, once for each:

| secret name | value |
| --- | --- |
| `BACKUP_R2_ACCOUNT_ID` | Account ID from step 3.6 |
| `BACKUP_R2_ACCESS_KEY_ID` | Access Key ID from step 3.5 |
| `BACKUP_R2_SECRET_ACCESS_KEY` | Secret Access Key from step 3.5 |
| `BACKUP_R2_BUCKET` | `houzs-erp-db-backups` (the name from step 2) |
| `BACKUP_PUBKEY` | the whole one-line content of `houzs-backup-public.b64` |

From Terminal instead: `gh secret set BACKUP_PUBKEY < ~/houzs-backup-key/houzs-backup-public.b64`.

`DATABASE_URL` already exists and is reused; nothing to do for it.

### Step 5. Run it once by hand

GitHub -> **Actions** -> **Nightly database backup (encrypted, to private R2)**
-> **Run workflow**. A good run ends with the line
`backup stored: houzs-erp/<date>/ (2 encrypted files)`. From then on it runs by
itself every night.

---

## Part 2 — restoring a backup

> **UNTESTED end to end** as of 2026-11-10: no real backup exists yet, because
> setup (Part 1) is not done. The decrypt commands are the same ones
> `local-dev-snapshot.yml` uses, which has worked (run 38923168411). Do a
> practice restore into a scratch database soon after the first real backup,
> before you ever need one, and correct this page with what you saw.

### What is in the bucket

```
houzs-erp/2026-11-11/houzs-erp-2026-11-11T1900Z.tgz.enc   the locked database copy
houzs-erp/2026-11-11/houzs-erp-2026-11-11T1900Z.key.enc   the locked one-time key for it
```

Both files of the same night are needed. There are no "parts" to stitch
together: large files are uploaded in pieces but R2 joins them back into one
file, so what you download is whole.

### Step 1. Download one night

Easiest: Cloudflare dashboard -> R2 -> `houzs-erp-db-backups` -> open the
night's folder -> download both files.

Or from Terminal, using the R2 token from setup step 3:

```sh
export AWS_ACCESS_KEY_ID=<access key id> AWS_SECRET_ACCESS_KEY=<secret> AWS_DEFAULT_REGION=auto
aws s3 cp --recursive "s3://houzs-erp-db-backups/houzs-erp/2026-11-11/" ./restore/ \
  --endpoint-url "https://<ACCOUNT_ID>.r2.cloudflarestorage.com"
cd restore
```

### Step 2. Unlock it with the private key

```sh
N=houzs-erp-2026-11-11T1900Z
openssl pkeyutl -decrypt -inkey ~/houzs-backup-key/houzs-backup-private.pem \
  -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 \
  -in "$N.key.enc" -out data.key
openssl enc -d -aes-256-cbc -pbkdf2 -pass file:data.key -in "$N.tgz.enc" | tar xz
rm data.key
ls backup/     # houzs-erp-<stamp>.dump  and  extensions.txt
```

The unlocked `backup/` folder is the real database, customers and money
included. Keep it on your own machine only and delete it when finished.

### Step 3. Load it into a SCRATCH database first

Never restore straight over production. Load into an empty database, check it,
and only then decide what to do.

A scratch Postgres 17 on your Mac (needs Docker Desktop and the Postgres 17
client tools, `brew install postgresql@17`):

```sh
docker run -d --name houzs-restore -e POSTGRES_PASSWORD=local -p 55432:5432 postgres:17
L=postgresql://postgres:local@localhost:55432
psql "$L/postgres" -c "create database restore"
psql "$L/restore" <<'SQL'
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema extensions;
alter database restore set search_path = "$user", public, extensions;
SQL
while IFS='|' read -r name nsp; do
  [ -n "$name" ] || continue
  psql "$L/restore" -q -c "create schema if not exists \"$nsp\"; create extension if not exists \"$name\" schema \"$nsp\"" \
    || echo "extension $name not available on plain Postgres, skipped"
done < backup/extensions.txt
pg_restore --no-owner --no-privileges --dbname="$L/restore" backup/houzs-erp-*.dump 2> restore-errors.log
grep -c "error:" restore-errors.log
```

The three `create role` lines and the extension loop exist because production
runs on Supabase, which has those roles and extensions; plain Postgres does
not. A few errors about Supabase-only extensions are expected and harmless for
checking the data.

Check it, for example:

```sh
psql "$L/restore" -c "select count(*) from scm.mfg_sales_orders"
```

### Step 4. Putting it back into production

That is a decision, not a command: it replaces live data, and anything entered
after the backup was taken is lost. Talk to whoever runs the system before
doing it. Supabase also keeps its own daily backups (Supabase dashboard ->
Database -> Backups); this R2 copy is the one that survives even if the
Supabase account itself is lost.

---

## What this backup does and does not cover

- **Covers:** the two schemas the app owns, `public` and `scm` — all ERP data.
  Same scope as `local-dev-snapshot.yml`, whose dump was 209,540,992 bytes on
  2026-10-16 (run 38923168411).
- **Does not cover:** Supabase's own internal schemas (`auth`, `storage`),
  and uploaded FILES (photos, PDFs) — those live in the app's R2 file bucket,
  not in the database.
- **Does not cover:** anything between the last backup and the moment of loss.
  Worst case, up to one day of entries.
