# Updating the live CRM safely (no data loss)

Use this every time you push a new version to `crm.piwebtechnology.com`. Paths follow `HOSTINGER_VPS.md`
(`/var/www/piweb-crm`, PM2 app `piweb-crm-api`, DB `piweb_crm`) — change them if yours differ.

> Rehearsed locally before writing this: a database with 1,500 leads, 600 remarks, old-format notes, and old lead
> codes was migrated from both "production at migration 003" and "production at migration 002". Every row survived,
> every lead code stayed unique, and restoring the pre-migration backup brought the old schema and all data back.
> That rehearsal found and fixed a real bug (migration 003 would have failed on any lead with ID ≥ 1000), so
> **make sure you deploy this version of the code, not an older copy.**

---

## 0. What this release changes

| Change | Effect on existing data |
|---|---|
| Migrations 003–007 (only the ones production hasn't run yet; check in 1.1) | Adds tables/columns. **Nothing is deleted.** |
| 003 — lead codes `LD-000005` → `LD-005` | Rewrites `lead_code` for existing leads (IDs ≥ 1000 become `LD-1234`). Visible change; searching by the old code stops matching. |
| 004–006 — removed leads, allocation, remark tags, 2 new statuses, 7 default tags | New columns/tables. Defaults are added with `INSERT IGNORE`, so anything you already created is untouched. |
| 007 — note categories | Renames `notes.category` → `kind` and moves existing notes into new **WhatsApp** / **Email** categories. |
| 008 — quotations & invoices | Four **new** tables only (`billing_documents`, `billing_document_items`, `invoice_payments`, `document_emails`). Existing tables are untouched. |
| 009 — service presets | One **new** table, seeded with the three starter services (Website development & Testing 12000, Hosting Server + Domain (1 Year) 2400, Google Indexing & Basic SEO setup 1200). Manage them under Settings → Service presets. |
| 010 — WhatsApp sharing | Two small column additions (`share_token` on documents, `channel` on the send history). Creates **public, unguessable PDF links** only when someone clicks "Send on WhatsApp". |
| 011 — payment proofs & next-payment date | One **new** table (`payment_attachments`) and one nullable column (`next_payment_due`) on `billing_documents`. Nothing is rewritten. |
| 012 — preset discounts + standard services | Two new columns on `service_presets`; Website price 12,000 → 14,000 **only if still unedited**; Hosting set to 100% discount (if unedited); adds *Site Maintenance* and *Website Landing Page*. Existing invoices/quotations are untouched (they keep their own copies). |
| 013 — Telecaller role | Widens `users.role` to `admin / agent / telecaller`. No user is changed. |
| New design assets: `backend/assets/logo.png`, `signature.png`, fonts; `frontend/public/{logo,favicon,apple-touch-icon,signature}.png`, `fonts/` | Included by the normal rsync. **`signature.png` is a handwritten signature printed on invoices** — keep the folder private to your team. |
| New `UPLOAD_DIR` (payment screenshots) and Nginx `client_max_body_size 12m` | **Before restarting:** create the uploads folder (see `HOSTINGER_VPS.md`), set `UPLOAD_DIR` in `.env`, raise the size limit in Nginx (`sudo nginx -t && sudo systemctl reload nginx`) — otherwise uploads fail with "413". Add the uploads folder to your backups (step A2). |
| Company logo + new document design, bank details on invoices/quotations | Code and `frontend/public` assets only. Existing **issued** documents keep their frozen company details, but the PDF/preview now also print the bank details (taken from the current config when an old snapshot has none). |
 | Optional. Without them everything works except the **Email** button. Add them to `.env` before restarting. |
| New dependencies (`pdfkit`, `nodemailer`) and `backend/assets/fonts` | `npm ci --omit=dev` installs them; make sure the rsync includes `backend/assets/` (it does unless you excluded it). |
| Login now lasts 7 days | Optional `SESSION_DAYS` in `.env`. **Do not change `JWT_SECRET`** or everyone is logged out. |

**Why there is a short downtime window (~1–2 min):** migration 007 renames a column the old code uses, so old code
can't run on the new schema — and the new code deliberately refuses to start on the old schema. So the API is
stopped, migrated, and restarted in one go. The website stays up; only `/api/*` is briefly unavailable
(see "Landing-page leads during the window" below).

**Plan:** A) prepare with no downtime → B) rehearse on a copy of production data → C) cut over → D) verify. Rollback is
always "restore the pre-update backup + swap the old code back".

---

## A. Prepare (no downtime — the live site is not touched)

### A1. Record the current state
```bash
ssh <user>@<VPS-IP>
pm2 list
mysql --defaults-extra-file=/etc/piweb-crm/backup.cnf piweb_crm -N -e "SELECT name FROM schema_migrations ORDER BY name"
cat > /tmp/counts.sql <<'EOF'
SELECT 'leads' t, COUNT(*) n FROM leads UNION ALL SELECT 'remarks', COUNT(*) FROM lead_remarks
UNION ALL SELECT 'activities', COUNT(*) FROM lead_activities UNION ALL SELECT 'users', COUNT(*) FROM users
UNION ALL SELECT 'notifications', COUNT(*) FROM notifications UNION ALL SELECT 'status_values', COUNT(*) FROM selectable_values;
EOF
mysql --defaults-extra-file=/etc/piweb-crm/backup.cnf piweb_crm -N < /tmp/counts.sql | tee ~/counts-before.txt
```
Keep `~/counts-before.txt`. The migration list tells you exactly which migrations will run (any `00x_*.sql` in
`backend/migrations/` that is missing from that list).

### A2. Back up — three independent copies
```bash
sudo mkdir -p /var/backups/piweb-crm
# database (hot backup; the real one is taken again at cut-over)
DB_NAME=piweb_crm /var/www/piweb-crm/deploy/backup-db.sh
# code + .env (contains secrets — keep it private)
sudo tar czf /var/backups/piweb-crm/code-$(date +%F-%H%M).tgz -C /var/www piweb-crm --exclude=node_modules
# payment-proof screenshots (only exists once the first proof has been uploaded; adjust the path to your UPLOAD_DIR)
[ -d /var/lib/piweb-crm/uploads ] && sudo tar czf /var/backups/piweb-crm/uploads-$(date +%F-%H%M).tgz -C /var/lib/piweb-crm uploads
ls -la /var/backups/piweb-crm
```
Then copy `/var/backups/piweb-crm/*` **off the server** (e.g. `scp` / `rsync` to your computer) and take a Hostinger
snapshot (hPanel → VPS → Backups / Snapshots). A backup that lives only on the same disk is not a backup.

### A3. Put the new version next to the live one
From your computer:
```bash
rsync -av --exclude node_modules --exclude .env --exclude dist --exclude '*.log' \
  piweb-crm/ <user>@<VPS-IP>:/var/www/piweb-crm-next/
```
On the server:
```bash
cd /var/www/piweb-crm-next
cp /var/www/piweb-crm/backend/.env backend/.env          # same secrets as live (do not regenerate JWT_SECRET)
cd backend && npm ci --omit=dev
cd ../frontend && npm ci && npm run build                # or build locally and rsync frontend/dist/ here
```
The live site keeps serving from `/var/www/piweb-crm` the whole time.

---

## B. Rehearse on a copy of production data (10 minutes, strongly recommended)

This proves the migrations work on **your** data before they touch it.
```bash
sudo mysql -e "CREATE DATABASE piweb_crm_rehearsal CHARACTER SET utf8mb4; GRANT ALL ON piweb_crm_rehearsal.* TO 'piweb_crm'@'127.0.0.1';"
LATEST=$(ls -t /var/backups/piweb-crm/piweb_crm_*.sql.gz | head -1)
gunzip -c "$LATEST" | mysql --defaults-extra-file=/etc/piweb-crm/backup.cnf piweb_crm_rehearsal

cd /var/www/piweb-crm-next/backend
DB_NAME=piweb_crm_rehearsal npm run migrate              # env var wins over .env; live DB is not touched
mysql --defaults-extra-file=/etc/piweb-crm/backup.cnf piweb_crm_rehearsal -N < /tmp/counts.sql
```
**Pass criteria:** every count equals `~/counts-before.txt` (except `status_values`, which counts all configurable values and rises by up to 9: the 2 new statuses and 7 default tags), `npm run migrate` ended with `migrations up to date`, and:
```bash
DB_NAME=piweb_crm_rehearsal PORT=4100 node src/server.js &      # starts without errors
curl -s localhost:4100/api/health; kill %1
sudo mysql -e "DROP DATABASE piweb_crm_rehearsal"
```
If anything fails, **stop here** — production is untouched. Send me the error.

---

## C. Cut over (do it at a quiet hour; ~1–2 minutes)

```bash
# 1. stop writes — from here the database receives nothing new
pm2 stop piweb-crm-api

# 2. the real, consistent backup (nothing can change between this and the migration)
DB_NAME=piweb_crm /var/www/piweb-crm/deploy/backup-db.sh
BK=$(ls -t /var/backups/piweb-crm/piweb_crm_*.sql.gz | head -1); gzip -t "$BK" && ls -la "$BK"     # must be non-trivial in size, gzip -t silent
cp "$BK" ~/pre-update.sql.gz                                                                         # handy copy for rollback

# 3. swap code (the old version stays in piweb-crm-prev for instant rollback)
mv /var/www/piweb-crm /var/www/piweb-crm-prev && mv /var/www/piweb-crm-next /var/www/piweb-crm

# 4. migrate the real database
cd /var/www/piweb-crm/backend && npm run migrate
#    expect "applying 00x_….sql" lines and finally "migrations up to date".  ANY error => go to ROLLBACK now.

# 5. start
pm2 restart piweb-crm-api --update-env || pm2 start /var/www/piweb-crm/deploy/ecosystem.config.cjs
pm2 save
curl -s http://127.0.0.1:<PORT>/api/health        # {"status":"ok","db":"up"}
pm2 logs piweb-crm-api --lines 30 --nostream      # no errors
```
(If `deploy/ecosystem.config.cjs` points at `/var/www/piweb-crm/backend`, nothing else needs changing: the path is the same.)

### Landing-page leads during the window
While the API is stopped, `POST /api/leads` fails (502). Pick one:
1. **Choose a low-traffic hour** (night IST) — the window is ~1–2 minutes.
2. **Retry on the landing page's server:** if the call fails, wait 30 s and resend (the endpoint is safe to retry).
3. **Optional Nginx fallback** — add inside the `server { … }` block of `/etc/nginx/sites-available/crm.piwebtechnology.com`
   (then `sudo nginx -t && sudo systemctl reload nginx`) so callers get a clear, retryable answer instead of a bare 502:
   ```nginx
   error_page 502 503 504 = @updating;
   location @updating {
       default_type application/json;
       add_header Retry-After 60 always;
       return 503 '{"success":false,"error":{"code":"UPDATING","message":"The CRM is updating. Please retry in a minute."}}';
   }
   ```

---

## D. Verify (5 minutes) and watch

```bash
mysql --defaults-extra-file=/etc/piweb-crm/backup.cnf piweb_crm -N < /tmp/counts.sql      # compare with ~/counts-before.txt
mysql --defaults-extra-file=/etc/piweb-crm/backup.cnf piweb_crm -N -e "SELECT name FROM schema_migrations ORDER BY name"
curl -I https://crm.piwebtechnology.com ; curl -I https://www.piwebtechnology.com           # both 200
curl -X POST https://crm.piwebtechnology.com/api/leads -H 'Content-Type: application/json' -d '{"name":"Update test","phone":"9876543210"}'
```
In the browser (hard refresh: Ctrl/⌘+Shift+R): sign in → counts and lists look right → open a lead and a remark →
**Notes** shows your old notes inside WhatsApp / Email categories → the test lead above appears with a live popup
→ then use **Remove** on that test lead so it leaves your lists. Watch `pm2 logs piweb-crm-api` for ~10 minutes.

Keep `/var/www/piweb-crm-prev` and the backups for at least a week, then delete them.

---

## ROLLBACK (if migration or verification fails)

Rollback = old code + the pre-update database. Everything entered **after** the cut-over would be lost, so decide
quickly; if people have already worked in the new version for hours, ask for a forward fix instead.
```bash
pm2 stop piweb-crm-api
mv /var/www/piweb-crm /var/www/piweb-crm-failed && mv /var/www/piweb-crm-prev /var/www/piweb-crm

# recreate the database empty, then load the backup taken in step C2 (privileges on the DB name are kept)
sudo mysql -e "DROP DATABASE piweb_crm; CREATE DATABASE piweb_crm CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
gunzip -c ~/pre-update.sql.gz | mysql --defaults-extra-file=/etc/piweb-crm/backup.cnf piweb_crm

pm2 restart piweb-crm-api --update-env
curl -s http://127.0.0.1:<PORT>/api/health
mysql --defaults-extra-file=/etc/piweb-crm/backup.cnf piweb_crm -N < /tmp/counts.sql     # must equal ~/counts-before.txt
```
(Always drop-and-recreate before restoring: a half-applied migration can leave new tables behind that would make a
later `npm run migrate` fail.)

---

## Rules for every future update
1. Read the new files in `backend/migrations/` first. Prefer **additive** changes (new tables/columns); anything that renames, drops, or rewrites data needs the rehearsal in section B.
2. Never edit a migration that has already run in production — add a new numbered file.
3. Never change `JWT_SECRET`, and never overwrite `.env` (the rsync commands exclude it).
4. Always: backup → rehearse → cut over → verify. Never run `npm run migrate` on production without a fresh backup.
5. The server refuses to start in production if migrations are missing — that is the safety net, not a bug. Run `npm run migrate`, then restart.
