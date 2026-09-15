// Separate demo data, port and no Google credentials; never starts the updater.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.env.APP_MODE = 'demo';
process.env.APP_HOST = '127.0.0.1';
process.env.APP_PORT = '8081';
process.env.APP_DATA_DIR = path.join(root, '.meal-preview-data');
process.env.MEALS_ENABLED = '1';
delete process.env.GOOGLE_CLIENT_SECRETS;
delete process.env.GOOGLE_REDIRECT_URI;
// server.mjs intentionally only auto-starts when it is the executable entry.
const { spawn } = await import('node:child_process');
const child = spawn(process.execPath, [path.join(root, 'server.mjs')], { env: process.env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => { process.exitCode = code || 0; });
