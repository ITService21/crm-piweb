# Deploy Piweb CRM on a Hostinger VPS — `https://crm.piwebtechnology.com`

Your marketing site `www.piwebtechnology.com` is already live. This guide adds the CRM **beside** it on the
subdomain `crm.piwebtechnology.com` and never edits the existing site's files or config.

> I wrote this without access to your server. Anything shown as `<like-this>` is a value **you must look up
> in Step 2** — don't guess it. Run the "inspect" commands first and keep what they print.

**What you're installing**

| Piece | What it is | Where it runs |
|---|---|---|
| Frontend | React app, built into static files (`frontend/dist`) | served by Nginx |
| Backend API + Socket.IO | Node.js/Express | PM2 process on `127.0.0.1:<PORT>` (not public) |
| Database | MySQL or MariaDB, separate DB + user | `127.0.0.1:3306` (not public) |

Only Nginx (ports 80/443) faces the internet.

---

## 0. Before you start (checklist)
- [ ] Hostinger VPS login: IP address + SSH user (usually `root`) + password or SSH key (hPanel → VPS → Overview / SSH access).
- [ ] Access to the **DNS** for `piwebtechnology.com` (see Step 1).
- [ ] The CRM code folder `piweb-crm/` on your computer.
- [ ] A strong password for the database user and one for the first CRM admin.

## 1. DNS — point the subdomain at the VPS
Add one **A record** (do not change `www` or `@`):

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `crm` | `<VPS public IP>` | 300 |

Where to add it depends on where the domain's **nameservers** point (check with `dig NS piwebtechnology.com +short`):
- `ns1.dns-parking.com` / `ns2.dns-parking.com` → Hostinger DNS: hPanel → Domains → piwebtechnology.com → DNS / Nameservers → DNS Zone.
- Cloudflare or another provider → add the record there (if Cloudflare, set the record to "DNS only" (grey cloud) until HTTPS works).

Verify (can take a few minutes): `dig +short crm.piwebtechnology.com` → must print the VPS IP.

## 2. Log in and inspect the server (read-only — change nothing yet)
```bash
ssh <user>@<VPS-IP>
cat /etc/os-release | head -3            # OS (Ubuntu 22.04/24.04 expected)
node -v; npm -v; pm2 -v                  # may say "command not found" — fine
mysql --version || mariadb --version     # may be missing — fine
systemctl is-active nginx apache2 openlitespeed lshttpd 2>/dev/null   # which web server serves www.piwebtechnology.com?
sudo ss -ltnp                            # ports in use. Choose a free port for <PORT> (e.g. 4000 if absent)
pm2 list 2>/dev/null                     # existing Node apps
ls /etc/nginx/sites-enabled /var/www 2>/dev/null
sudo nginx -T 2>/dev/null | grep -E "server_name|listen|root|proxy_pass"   # how the live site is configured
```
Decide from the output:
- **Nginx is active** → follow this guide as written.
- **Apache, OpenLiteSpeed/CyberPanel, CloudPanel or Hestia is active** (Hostinger "panel" templates) → the app, database, PM2 and `.env` steps are identical, but the web-server step differs: create a new site/vhost for `crm.piwebtechnology.com` in that panel with a reverse proxy to `127.0.0.1:<PORT>` and **WebSocket proxying enabled** for `/socket.io/`. The panel can usually issue the HTTPS certificate itself. Tell me which panel and I'll write that variant.
- A port or Node version already used by the live site → keep it; choose a different `<PORT>`, and don't upgrade the system Node (see Step 4).

Take a safety backup of web-server config before any change:
```bash
sudo tar czf ~/web-config-backup-$(date +%F).tgz /etc/nginx 2>/dev/null
```

## 3. Firewall (only if one is enabled)
```bash
sudo ufw status
# if active: allow web + ssh. Do NOT open 3306 or the app port.
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp
```

## 4. Install Node.js 20, PM2 (skip what already exists)
The CRM needs **Node ≥ 18.18**. If `node -v` already prints 18.18+ or 20.x, skip to `npm i -g pm2`. If Node is missing, install via NodeSource:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm i -g pm2
```
If the live site depends on an **older** Node you must not upgrade, use `nvm` (installs per-user, leaves the system Node alone) and run PM2 with that Node.

## 5. Database
Install only if Step 2 showed no MySQL/MariaDB: `sudo apt-get install -y mariadb-server && sudo mysql_secure_installation`.
Then create a **dedicated** database and least-privilege user:
```bash
sudo mysql
```
```sql
CREATE DATABASE piweb_crm CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'piweb_crm'@'127.0.0.1' IDENTIFIED BY '<STRONG-DB-PASSWORD>';
GRANT SELECT,INSERT,UPDATE,DELETE,CREATE,ALTER,INDEX,REFERENCES ON piweb_crm.* TO 'piweb_crm'@'127.0.0.1';
FLUSH PRIVILEGES;
EXIT;
```
(`CREATE/ALTER/INDEX/REFERENCES` are needed so `npm run seed` / `npm run migrate` can create and update tables.) Confirm MySQL listens on localhost only: `sudo ss -ltnp | grep 3306` → should show `127.0.0.1:3306`.

## 6. Upload the code
On **your computer** (from the folder that contains `piweb-crm/`):
```bash
rsync -av --exclude node_modules --exclude .env --exclude dist --exclude '*.log' \
  piweb-crm/ <user>@<VPS-IP>:/var/www/piweb-crm/
```
(If `/var/www/piweb-crm` doesn't exist: `ssh <user>@<VPS-IP> "sudo mkdir -p /var/www/piweb-crm && sudo chown \$USER /var/www/piweb-crm"` first. No `rsync`? use `scp -r` or `git clone`.)

## 7. Backend: install, configure, migrate, seed
```bash
cd /var/www/piweb-crm/backend
npm ci --omit=dev
cp .env.example .env && chmod 600 .env
nano .env
```
### Environment variables (`backend/.env`)
| Variable | Value for production | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Enables strict checks (JWT secret length, DB vars required, 10-char passwords). |
| `PORT` | `<PORT>` from Step 2 (e.g. `4000`) | API listens on `127.0.0.1` only. Must match the Nginx `proxy_pass`. |
| `DB_HOST` | `127.0.0.1` | |
| `DB_PORT` | `3306` | |
| `DB_NAME` | `piweb_crm` | |
| `DB_USER` | `piweb_crm` | The user from Step 5 — **not** root. |
| `DB_PASSWORD` | `<STRONG-DB-PASSWORD>` | |
| `DB_SOCKET` | *(optional)* | Only if you connect via a unix socket, e.g. `/var/run/mysqld/mysqld.sock`. |
| `JWT_SECRET` | output of `openssl rand -hex 48` | Required, ≥ 32 chars. Changing it logs everyone out. |
| `SMTP_HOST` | `smtp.gmail.com` (Google Workspace/Gmail) or e.g. `smtp.hostinger.com` | Needed only to **email** quotations/invoices. Leave empty to disable emailing — PDFs still download. Use the SMTP details of a real mailbox (e.g. one on your domain). |
| `SMTP_PORT` / `SMTP_SECURE` | `465` / `true`, or `587` / `false` | 465 = implicit TLS, 587 = STARTTLS. |
| `SMTP_USER` / `SMTP_PASS` | the mailbox login | For Google: the address and a 16-letter **App password** (not the normal password). Keep in `.env` only (chmod 600). Never commit. The production `.env` is separate from your laptop's, so add these there too. |
| `MAIL_FROM` | `Piweb Tech <billing@yourdomain>` | Defaults to `SMTP_USER`. Use an address your mail host allows you to send from. |
| `MAIL_REPLY_TO` | optional | Where client replies go. |
| `SESSION_DAYS` | `7` | How long a login lasts. After this people must sign in again. |
| `COOKIE_SECURE` | `true` | Session cookie only over HTTPS. If login "works" but you're bounced back, check this and HTTPS. |
| `TRUST_PROXY` | `1` | **Important.** Lets the app see each visitor's real IP from Nginx; without it the login and lead-form rate limits apply to *everyone together*. |
| `BUSINESS_TZ` | `Asia/Kolkata` | Used for "today", overdue and date filters. |
| `DEFAULT_COUNTRY_CODE` | `91` | Added to 10-digit phone numbers. |
| `APP_ORIGIN` | `https://crm.piwebtechnology.com` | Socket.IO CORS. |
| `SERVE_FRONTEND` | leave unset | Nginx serves the frontend. Set `true` only if you skip Nginx static serving. |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | your admin login | Used **once** by the seed command; password ≥ 10 chars. Remove from `.env` afterwards. |

There is no API key to set: the website lead form endpoint is intentionally public (see Step 12).

Generate the secret: `openssl rand -hex 48`. Check the file has no placeholder text left: `grep -n "change-me\|<" .env`.

Create the tables and the first admin (migrations are safe to re-run):
```bash
npm run seed        # reads SEED_ADMIN_* from .env; prints "admin ... created"
```
Then delete the two `SEED_ADMIN_*` lines from `.env`. Add more users later in the CRM under **Settings → Users**, or with `npm run create-user -- email@example.com 'password' agent`.

> **Payment proofs (screenshots)** are saved on disk, not in the database. Create the folder once and keep it out of the web root:
> ```bash
> sudo mkdir -p /var/lib/piweb-crm/uploads && sudo chown <app-user>: /var/lib/piweb-crm/uploads && sudo chmod 750 /var/lib/piweb-crm/uploads
> # backend/.env →  UPLOAD_DIR=/var/lib/piweb-crm/uploads
> ```
> Nginx must allow the upload size: `client_max_body_size 12m;` (already in `deploy/nginx-crm.conf.example`; reload Nginx after changing it). **Back this folder up together with the database** — the database only stores the file names.
>
> **Quotations & invoices** need nothing else on the server except the optional SMTP settings above: the PDF engine is pure Node (no browser), and its font ships inside the project (`backend/assets/fonts`), so keep that folder when you upload.

## 8. Frontend: build
Either on the server:
```bash
cd /var/www/piweb-crm/frontend && npm ci && npm run build      # creates frontend/dist
```
or on your computer (`cd piweb-crm/frontend && npm ci && npm run build`) then upload only the output:
`rsync -av --delete piweb-crm/frontend/dist/ <user>@<VPS-IP>:/var/www/piweb-crm/frontend/dist/`
(Small VPS plans can run out of memory building; building locally avoids that.)

## 9. Run the API with PM2
```bash
cd /var/www/piweb-crm
pm2 start deploy/ecosystem.config.cjs      # edit `cwd` inside if you used another folder
pm2 save
pm2 startup                                # run the command it prints (sudo ...) so it restarts after reboot
curl -s http://127.0.0.1:<PORT>/api/health # → {"status":"ok","db":"up",...}
pm2 logs piweb-crm-api --lines 30
```
**Run exactly one instance** (the config already does): the real-time publisher and Socket.IO live inside the process.

## 10. Nginx + HTTPS (new file; the existing site is untouched)
```bash
sudo cp /var/www/piweb-crm/deploy/nginx-crm.conf.example /etc/nginx/sites-available/crm.piwebtechnology.com
sudo nano /etc/nginx/sites-available/crm.piwebtechnology.com     # replace both <PORT> with your port
```
Get the certificate **first** (the config references the certificate files). Use the simplest safe route:
```bash
sudo apt-get install -y certbot python3-certbot-nginx
# temporary HTTP-only site so certbot can validate the domain:
sudo bash -c 'cat > /etc/nginx/sites-available/crm-temp <<EOF
server { listen 80; server_name crm.piwebtechnology.com; root /var/www/html; }
EOF'
sudo ln -s /etc/nginx/sites-available/crm-temp /etc/nginx/sites-enabled/crm-temp
sudo nginx -t && sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/html -d crm.piwebtechnology.com -m <your-email> --agree-tos -n
sudo rm /etc/nginx/sites-enabled/crm-temp
```
Then enable the real config:
```bash
sudo ln -s /etc/nginx/sites-available/crm.piwebtechnology.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```
`nginx -t` must say "syntax is ok" **before** every reload. If it doesn't, don't reload — fix it, or remove the new symlink to roll back. Certbot renews automatically (`sudo certbot renew --dry-run` to test).

## 11. Verify
```bash
curl -I https://crm.piwebtechnology.com                 # 200
curl -s https://crm.piwebtechnology.com/api/health      # {"status":"ok"...}
curl -I https://www.piwebtechnology.com                 # your existing site still 200
pm2 list                                                # old apps unchanged, piweb-crm-api online
```
In the browser: open the CRM, sign in, and check the small dot at the top right is **green** (WebSocket through Nginx works). Add a test lead from a second browser/incognito (Step 12) and confirm the popup (and sound after one click) appears in the first.

## 12. Connect the landing page on www.piwebtechnology.com
`POST https://crm.piwebtechnology.com/api/leads` — **no login or key needed**. JSON body:
```json
{ "name": "Ridham", "phone": "9518046177", "email": "a@b.com", "business_name": "PR enterprises",
  "requirement": "E-commerce", "budget": "Less than ₹15,000", "message": "Interested in website development." }
```
`Name`, `Business Name` etc. (label-style keys) also work. A phone or email is required. Test:
```bash
curl -X POST https://crm.piwebtechnology.com/api/leads -H "Content-Type: application/json" \
  -d '{"name":"Test","phone":"9876543210","requirement":"E-commerce"}'
```
Browser example for the landing page form:
```js
fetch('https://crm.piwebtechnology.com/api/leads', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name, phone, email, business_name, requirement, budget, message }),
});
```
Because the endpoint is public: it accepts only lead fields (never status/assignment), limits each visitor to 20 submissions/minute, and ignores submissions that fill a hidden field named `website` — add `<input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px">` to the form and send it along (humans leave it empty; bots fill it).

## 13. Backups (do this the same day)
```bash
sudo mkdir -p /etc/piweb-crm && sudo nano /etc/piweb-crm/backup.cnf
```
```ini
[client]
user=piweb_crm
password=<STRONG-DB-PASSWORD>
```
```bash
sudo chmod 600 /etc/piweb-crm/backup.cnf
chmod +x /var/www/piweb-crm/deploy/backup-db.sh
DB_NAME=piweb_crm /var/www/piweb-crm/deploy/backup-db.sh      # test run → /var/backups/piweb-crm/*.sql.gz
sudo crontab -e     # add:   15 2 * * * DB_NAME=piweb_crm /var/www/piweb-crm/deploy/backup-db.sh
```
**Restore** (test into a scratch database first):
```bash
gunzip -c /var/backups/piweb-crm/piweb_crm_<date>.sql.gz | mysql --defaults-extra-file=/etc/piweb-crm/backup.cnf piweb_crm
```
Also copy backups off the server (Hostinger snapshots/backups in hPanel, or `rsync` to another machine).

## 14. Updating later
```bash
rsync ... (Step 6, new code)   # never overwrites .env because it's excluded
cd /var/www/piweb-crm/backend && npm ci --omit=dev && npm run migrate
# rebuild + upload frontend (Step 8)
pm2 restart piweb-crm-api
```

## 15. Rollback
- **New site misbehaving:** `sudo rm /etc/nginx/sites-enabled/crm.piwebtechnology.com && sudo nginx -t && sudo systemctl reload nginx` — `www.piwebtechnology.com` is unaffected.
- **Bad release:** restore the previous code folder, `pm2 restart piweb-crm-api`; restore the DB from a backup if a migration is the problem.
- **Remove entirely:** `pm2 delete piweb-crm-api && pm2 save`, remove the Nginx symlink, drop the `piweb_crm` database/user.

## 16. Troubleshooting
| Symptom | Likely cause / fix |
|---|---|
| `502 Bad Gateway` | API not running or wrong port: `pm2 list`, `pm2 logs piweb-crm-api`, `curl 127.0.0.1:<PORT>/api/health`; make sure Nginx `proxy_pass` port = `PORT` in `.env`. |
| API exits at start: "Missing required environment variable" | A required `.env` value is empty (`DB_NAME`, `DB_USER`, `JWT_SECRET` ≥ 32 chars). |
| `Access denied for user` / `Table ... doesn't exist` in logs | Wrong `DB_*` values, or `npm run seed` / `npm run migrate` not run. |
| Sign-in succeeds then returns to login | `COOKIE_SECURE=true` but you're on plain `http://`, or the site isn't served via HTTPS. |
| Green dot never turns on / no live popups | Nginx missing the `/socket.io/` block with the `Upgrade` headers (use the provided template), or Cloudflare proxying with WebSockets off. |
| "Too many requests" for all visitors | `TRUST_PROXY=1` missing in `.env`. |
| Landing-page form blocked in the browser | Check the browser console. The endpoint allows any origin, so look for a typo in the URL or an ad-blocker. Server-side calls are never CORS-limited. |
| New-lead sound doesn't play | Browsers need one click on the page first; use the **Enable sound** button in the header. Sound can't play after the browser is closed. |
| Certbot "Timeout during connect" | DNS not pointing at the VPS yet (Step 1), or port 80 blocked by the firewall. |
