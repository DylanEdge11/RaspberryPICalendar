import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUpdateControl } from '../phone-updates.mjs';

test('phone updates require installation, queue only a fixed marker, and prevent repeated requests', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-updater-test-'));
  try {
    const control = createUpdateControl({ dataDir: directory, stateDir: directory, platform: 'linux', mode: 'production', now: () => 200000 });
    assert.equal(control.status().enabled, false);
    assert.throws(() => control.request(), /one-time setup/);
    fs.writeFileSync(path.join(directory, 'enabled'), '');
    assert.equal(control.request().state, 'queued');
    assert.equal(fs.readFileSync(path.join(directory, 'update-request'), 'utf8'), 'update\n');
    assert.throws(() => control.request(), /in progress/);
    fs.unlinkSync(path.join(directory, 'update-request'));
    fs.writeFileSync(path.join(directory, 'status.json'), JSON.stringify({ state: 'running' }));
    assert.equal(control.busy(), true);
    assert.throws(() => control.request(), /in progress/);
    fs.writeFileSync(path.join(directory, 'status.json'), JSON.stringify({ state: 'complete', updated_at: 190 }));
    assert.throws(() => control.request(), /one minute/);
    assert.equal(createUpdateControl({ dataDir: directory, stateDir: directory, platform: 'win32', mode: 'production' }).status().enabled, false);
    assert.equal(createUpdateControl({ dataDir: directory, stateDir: directory, platform: 'linux', mode: 'demo' }).status().enabled, false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
