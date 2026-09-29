// Creates a self-signed localhost certificate in certs/ for local HTTPS play. Needs `openssl` on PATH.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'certs');
const key = path.join(dir, 'key.pem');
const cert = path.join(dir, 'cert.pem');

if (existsSync(key) && existsSync(cert)) {
  console.log(`Certificate already exists in ${dir}`);
  process.exit(0);
}
mkdirSync(dir, { recursive: true });
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '365',
  '-keyout', key, '-out', cert,
  '-subj', '/CN=localhost',
  '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
], { stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
console.log(`Wrote ${key} and ${cert}`);
