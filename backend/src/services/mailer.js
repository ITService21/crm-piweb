import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';

let transport = null;

/** Tests inject a fake transport; production builds one from the SMTP_* environment variables. */
export function setTransport(t) { transport = t; }

function getTransport() {
  if (transport) return transport;
  // Safety net: automated tests must never open a real SMTP connection, whatever is in .env
  if (process.env.NODE_ENV === 'test') return null;
  const { host, port, secure, user, pass } = config.smtp;
  if (!host) return null;
  transport = nodemailer.createTransport({
    host, port, secure, auth: user ? { user, pass } : undefined,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 30000,
  });
  return transport;
}

export const emailConfigured = () => !!getTransport();

export async function sendMail({ to, cc, subject, text, html, attachments }) {
  const t = getTransport();
  if (!t) throw new HttpError(503, 'Email is not set up on the server yet. Ask the administrator to configure the SMTP settings. You can still download the PDF.', 'EMAIL_NOT_CONFIGURED');
  const { from, replyTo } = config.smtp;
  return t.sendMail({ from: from || undefined, replyTo: replyTo || undefined, to, cc: cc || undefined, subject, text, html, attachments });
}
