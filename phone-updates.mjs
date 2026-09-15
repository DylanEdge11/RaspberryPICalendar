import fs from 'node:fs';
import path from 'node:path';

const fail = (status, message) => Object.assign(new Error(message), { status });

export function createUpdateControl({ dataDir, mode, platform = process.platform,
  stateDir = '/var/lib/family-calendar-updater', now = Date.now }) {
  const requestPath = path.join(dataDir, 'update-request');
  const enabled = () => platform === 'linux' && mode === 'production' && fs.existsSync(path.join(stateDir, 'enabled'));

  function status() {
    if (!enabled()) return { enabled: false, state: 'unavailable', message: 'Phone updates need one-time setup on the Pi. See README.' };
    let saved = { state: 'idle', message: 'Ready to check GitHub and install an update.' };
    try {
      const file = path.join(stateDir, 'status.json');
      if (fs.statSync(file).size <= 16384) saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* No update has run yet. */ }
    if (fs.existsSync(requestPath)) return { enabled: true, ...saved, state: 'queued', message: 'Update requested. Waiting for the Pi updater.' };
    return { ...saved, enabled: true };
  }

  function request() {
    const current = status();
    if (!current.enabled) throw fail(409, current.message);
    if (['queued', 'running'].includes(current.state)) throw fail(409, 'An update is already in progress.');
    if (current.updated_at && now() - current.updated_at * 1000 < 60000) throw fail(429, 'Wait one minute before requesting another update.');
    try { fs.writeFileSync(requestPath, 'update\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code === 'EEXIST') throw fail(409, 'An update is already queued.');
      throw fail(503, 'The Pi could not queue this update. Check the updater setup.');
    }
    return status();
  }

  return { status, request, busy: () => ['queued', 'running'].includes(status().state) };
}
