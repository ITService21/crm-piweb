# Piweb CRM

React + TypeScript + Tailwind frontend, Node/Express + MySQL backend, Socket.IO realtime. See `deploy/HOSTINGER_VPS.md` to deploy.

```
backend/   Express API  (src/services = business logic, src/routes = HTTP, migrations/*.sql)
frontend/  Vite SPA
deploy/    PM2, Nginx, backup, deployment guide
```

## Local development
```bash
cd backend && cp .env.example .env     # set DB_* (non-production defaults: root@127.0.0.1/piweb_crm_dev)
npm i && SEED_ADMIN_EMAIL=a@b.com SEED_ADMIN_PASSWORD='long-password-1' npm run seed && npm run dev
cd ../frontend && npm i && npm run dev   # http://localhost:5173 (proxies /api and /socket.io to :4000)
```
Tests: `cd backend && npm test` (needs a MySQL/MariaDB `piweb_crm_test`; set `DB_SOCKET` or edit `test/helpers.js`; it **drops all tables in that DB**), `cd frontend && npm test`.

## Key design decisions
- **One creation path.** `createLead()` is used by the CRM form, `POST /api/public/leads` and any future integration. In one transaction it writes the lead, its activity, an `event_outbox` row and per-recipient `notifications` rows.
- **Transactional outbox.** A publisher polls committed outbox rows (1s) and emits `lead:new` to `user:<id>` rooms only for the recipients. Reconnecting clients send their last `seq` and receive missed events (24h) for themselves only; the client dedupes by `eventId`, so a repeat never re-chimes. Run a single PM2 instance.
- **Time.** All DATETIMEs are UTC. Day filters convert business-timezone dates (`BUSINESS_TZ`, default Asia/Kolkata) to UTC `[start, end)` ranges, so they're index-friendly and DST/midnight-safe.
- **Ordering.** One SQL `ORDER BY` with a single `CASE` group (new → today overdue → today upcoming → rest) so a lead is in exactly one group and pagination is stable. "New" is the status flagged `is_new_state` in Settings, not a hardcoded name.
- **Tabs.** A status's `status_category` (active / not_interested / converted) places leads in a tab. Active leads with follow-up on a future calendar day show under *Follow-up Scheduled*; today/overdue/none show under *Leads*. Moving a lead out of Active clears its follow-up (logged).
- **Access.** Admins see everything; agents see leads assigned to them, unassigned, or allocated to them; any user may assign a lead they can see to any other user (the lead then leaves the previous agent's list). Enforced in SQL (`accessClause`) on every lead endpoint.
- **Auth.** bcrypt (cost 12), JWT in an httpOnly SameSite=Lax cookie, `X-Requested-With` CSRF guard, login rate limit per IP+email, helmet CSP.
- **Billing.** Quotations and invoices share one engine (`services/billing.js`): numbers are allocated under a lead-row lock (+ unique constraints) and never reused, client and issuer details are snapshotted per document, all maths is exact integer arithmetic (`lib/money.js`), issued documents are immutable, and PDFs/emails are always built from the saved record.
- **Settings safety.** Used values can't be deleted: deactivate (history kept, can't be newly assigned) or migrate leads (activity logged per lead).

## API (all `/api`, JSON `{success,data,meta?}` / `{success:false,error}`; cookie auth + `X-Requested-With: piweb-crm`)
| | |
|---|---|
| `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` | session, user + permissions + preferences |
| `GET /leads?tab=leads\|not_interested\|converted\|scheduled&status&q&assigned&dateFilter&from&to&dateField&page&pageSize&sort&dir` | list |
| `GET /leads/ids` (same filters) | ids of every match across pages (cap 1000) for "Select all" |
| `GET /leads/counts` (same filters) · `GET /leads/summary` | status counts · sidebar badges |
| `POST /leads` · `GET/PATCH /leads/:id` · `POST /leads/:id/status` · `POST /leads/:id/followup` | create/read/update |
| `POST /leads/:id/remove` (`reason` required) · `POST /leads/:id/restore` · list with `tab=removed` | soft-remove: hidden from every other tab/count/badge, restorable |
| `POST /leads/assign` (`lead_ids[]`, `user_id` or `null` to unassign) | bulk **assignment** (changes the lead's owner; any user → any user) |
| `POST /leads/allocate` (`lead_ids[]`, `user_id` or `null` to clear) | bulk **allocation**: a temporary priority hand-off to another user (separate from `assigned_to`); allocatee sees them first in Leads and can act on them |
| `POST /settings/tags` (any user) · remarks accept `tag_ids[]` | remark tags (category `remark_tag`, manageable in Settings); a remark may be tags only |
| `GET/POST /leads/:id/remarks` · `GET /leads/:id/activities` | remarks, read-only history |
| `GET/POST/PATCH/DELETE /settings/values`, `POST /settings/values/:id/migrate`, `GET /settings/categories` | configurable values (writes admin-only) |
| `GET/POST/PATCH /users` | admin; agents get a name directory |
| `GET/POST /notes` (`?category_id=&q=`), `PATCH/DELETE /notes/:id`, `POST /notes/:id/copy` | shared message scripts; `kind` = `message` or `email` (subject); recently-copied first within a category |
| `GET/POST /notes/categories`, `PATCH/DELETE /notes/categories/:id` | user-managed note categories (a category can be deleted only when empty) |
| `GET/POST /invoices`, `GET/PUT /invoices/:id`, `POST /invoices/:id/issue\|cancel\|payments\|email`, `GET /invoices/:id/pdf`, `POST /invoices/calculate`, `GET /invoices/prefill/:leadId` | invoices: numbered `INV-GN-<lead no.>[-02…]`, draft → issued → partially paid/paid, cancel (never delete), PDF, email |
| `GET/POST /quotations` … (same shape) + `POST /quotations/:id/accept\|reject\|convert` | quotations (`QT-GN-<lead no.>[-02…]`); convert makes an invoice draft |
| `PATCH /invoices/:id/next-due` | set / change / clear the date the next payment is expected (flags the invoice for follow-up when it arrives) |
| `POST /invoices/:id/payments/:pid/attachments` · `GET\|DELETE …/attachments/:aid` | payment proof screenshots / PDFs (admin attaches; any user with access to the lead can view; content-sniffed, 8 MB, 6 files) |
| `POST /quotations/:id/status` | change an issued quotation between issued / accepted / rejected |
| `GET /invoices?period=today\|yesterday\|last7\|last_month\|custom&from&to&followup=due` | filter by generated date; `meta` carries status/period counts and a billed/received/pending summary |
\|whatsapp-opened` (and `/quotations/…`) | WhatsApp: prepared message + secure PDF link; records that WhatsApp was opened (nothing is sent automatically) |
| `GET /public/documents/:token/pdf` | public read-only PDF behind an unguessable link (issued documents only) |
| `GET /billing/by-lead/:leadId` | documents for a lead |
| `GET/POST /billing/presets`, `PATCH/DELETE /billing/presets/:id` | starter services (default ones pre-fill new documents; admin-managed) |
| `GET/PUT /preferences` · `GET /notifications`, `POST /notifications/read` | |
| `POST /leads` (no login) or `POST /public/leads` | anonymous landing-page / website form submission (rate limited, honeypot, fields whitelisted) |
