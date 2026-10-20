import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.resolve(process.env.DB_PATH || path.join(root, 'data', 'daybyday.sqlite'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const args = process.argv.slice(2);
const newOrigin = args.includes('--new-origin');
const destination = path.resolve(args.find((arg) => arg !== '--new-origin') || path.join(root, 'backups', `rijin-${stamp}.sqlite`));
if (!fs.existsSync(source)) throw new Error('The source database does not exist.');
if (fs.existsSync(destination)) throw new Error('Refusing to overwrite an existing backup.');
fs.mkdirSync(path.dirname(destination), { recursive: true });
const db = new DatabaseSync(source, { readOnly: true });
try {
  await backup(db, destination);
  const check = new DatabaseSync(destination, { readOnly: !newOrigin });
  try {
    if (newOrigin) {
      // Browser permissions, service workers and subscriptions belong to the old origin.
      // Only reset the copy: goals, history, password hashes, timezones and VAPID keys survive.
      check.exec(`BEGIN;
        DELETE FROM sessions;
        DELETE FROM push_subscriptions;
        UPDATE users SET reminder_enabled = 0, last_reminded_date = NULL,
          last_reminder_attempt_at = NULL, last_reminder_status = NULL, last_reminder_error = NULL;
        COMMIT;`);
    }
    if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Backup integrity check failed.');
  } finally { check.close(); }
  console.log(`Verified database backup: ${destination}`);
  if (newOrigin) console.log('Migration copy prepared: sign in and enable notifications again on the new site.');
} finally { db.close(); }
