# Deployment

The full, step-by-step guide for the Hostinger VPS (crm.piwebtechnology.com) is in
[`HOSTINGER_VPS.md`](./HOSTINGER_VPS.md). Config templates in this folder:
`ecosystem.config.cjs` (PM2), `nginx-crm.conf.example` (Nginx), `backup-db.sh` (nightly backup).

**Updating a live site:** follow [`UPDATE_PRODUCTION.md`](./UPDATE_PRODUCTION.md) — backup, rehearsal on a copy of production data, cut-over, verification and rollback.
