import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { config } from '../config.js';

export const MAX_BYTES = 8 * 1024 * 1024;
export const MAX_FILES = 6;

/** Files are buffered in memory, checked, then written under a random name — the client never chooses a path. */
export const uploader = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: MAX_FILES } });

/** Identify by content (magic bytes), not by the filename or the browser-supplied type. */
export function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return { mime: 'image/png', ext: '.png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
  if (buf.toString('latin1', 0, 4) === 'GIF8') return { mime: 'image/gif', ext: '.gif' };
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
  if (buf.toString('latin1', 0, 5) === '%PDF-') return { mime: 'application/pdf', ext: '.pdf' };
  return null;
}

export const proofDir = () => path.join(config.uploadDir, 'payment-proofs');
export const proofPath = (stored) => path.join(proofDir(), path.basename(stored));

export function cleanName(name) {
  const base = String(name ?? 'proof').replace(/\\/g, '/').split('/').pop().replace(/[\u0000-\u001f<>:"|?*]/g, '').trim();
  return (base || 'proof').slice(0, 200);
}

/** Writes one verified file and returns the metadata row values. Throws if the content is not an accepted type. */
export async function storeProof(file) {
  const info = sniff(file.buffer);
  if (!info) return { error: `"${cleanName(file.originalname)}" is not a PNG, JPG, WebP, GIF or PDF file` };
  const stored = `${crypto.randomBytes(16).toString('hex')}${info.ext}`;
  await fs.promises.mkdir(proofDir(), { recursive: true });
  await fs.promises.writeFile(proofPath(stored), file.buffer, { flag: 'wx', mode: 0o640 });
  return { stored, mime: info.mime, size: file.buffer.length, name: cleanName(file.originalname) };
}
export const removeStored = (stored) => fs.promises.unlink(proofPath(stored)).catch(() => {});
