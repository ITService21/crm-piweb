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
| `GET/POST /leads/:id/remarks` · `GET /leads/:id/activities` | remarks, read-only history |
| `GET/POST/PATCH/DELETE /settings/values`, `POST /settings/values/:id/migrate`, `GET /settings/categories` | configurable values (writes admin-only) |
| `GET/POST/PATCH /users` | admin; agents get a name directory |
| `GET/POST /notes`, `PATCH/DELETE /notes/:id`, `POST /notes/:id/copy` | shared WhatsApp/email message scripts; list is most-copied first per category |
| `GET/PUT /preferences` · `GET /notifications`, `POST /notifications/read` | |
| `POST /leads` (no login) or `POST /public/leads` | anonymous landing-page / website form submission (rate limited, honeypot, fields whitelisted) |
