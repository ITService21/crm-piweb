import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const isProd = env.NODE_ENV === 'production';

function required(name) {
  const v = env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

const jwtSecret = env.JWT_SECRET || (isProd ? required('JWT_SECRET') : 'dev-only-secret-change-me');
if (isProd && jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters in production');

export const config = {
  isProd,
  port: Number(env.PORT || 4000),
  db: {
    host: env.DB_HOST || '127.0.0.1',
    port: Number(env.DB_PORT || 3306),
    database: isProd ? required('DB_NAME') : env.DB_NAME || 'piweb_crm_dev',
    user: isProd ? required('DB_USER') : env.DB_USER || 'root',
    password: env.DB_PASSWORD || '',
    socketPath: env.DB_SOCKET || undefined,
  },
  jwtSecret,
  tz: env.BUSINESS_TZ || 'Asia/Kolkata',
  defaultCountryCode: env.DEFAULT_COUNTRY_CODE || '91',
  appOrigin: env.APP_ORIGIN || 'http://localhost:5173',
  publicApiKey: env.PUBLIC_API_KEY || '',
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProd,
  trustProxy: env.TRUST_PROXY ? Number(env.TRUST_PROXY) : 0,
  // Outgoing email (quotations/invoices). Leave SMTP_HOST empty to disable sending; PDFs can still be downloaded.
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE === 'true', // true for port 465 (implicit TLS); false for 587 (STARTTLS)
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.MAIL_FROM || env.SMTP_USER || '',
    replyTo: env.MAIL_REPLY_TO || '',
  },
  // How long a login lasts. Disabled users are still locked out immediately (checked on every request).
  // Where uploaded payment proofs are stored (outside any web root; served only through authenticated API calls). Back this folder up with the database.
  uploadDir: env.UPLOAD_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads'),
  sessionHours: Math.max(1, Number(env.SESSION_DAYS || 7)) * 24,
};
