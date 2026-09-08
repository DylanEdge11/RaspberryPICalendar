import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createMealStore, cleanMeal, aggregate, mealWarnings } from '../meals.mjs';

const recipe = (patch = {}) => ({ revision: 0, name: 'Mild pasta', servings: 3, minutes: 20, toddler: 'Serve a mild portion.', ingredientsComplete: true, ingredients: [{ name: 'Tomatoes', quantity: 500, unit: 'g' }, { name: 'Basil', quantity: null, unit: '' }], ...patch });
function setup(filename = ':memory:') {
  const db = new DatabaseSync(filename);
  db.exec("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT OR IGNORE INTO settings VALUES('schema_version','1'); INSERT OR IGNORE INTO settings VALUES('display_title','Keep this title');");
  return { db, store: createMealStore(db) };
}
const week = '2026-09-07';
function planned(store) {
  const meal = store.saveMeal(recipe());
  const plan = store.savePlan({ week, revision: 0, approve: true, entries: [{ id: 'cook', date: week, type: 'meal', mealId: meal.id, servings: 6 }, { id: 'left', date: '2026-09-09', type: 'leftovers', sourceId: 'cook' }] });
  return { meal, plan };
}

test('meal migration and snapshots persist without changing display settings', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'meals-persist-'));
  let db;
  try {
    let setupResult = setup(path.join(dir, 'db.sqlite')); db = setupResult.db; let store = setupResult.store;
    const { meal, plan } = planned(store);
    store.saveMeal({ ...meal, name: 'Renamed favourite', ingredients: [] });
    assert.equal(store.plan(week).entries[0].meal.name, 'Mild pasta');
    assert.equal(store.summary(week).entries[0].name, 'Mild pasta');
    store.review({ week, revision: 0, planRevision: plan.revision, selected: ['cook'], items: [] }, 'phone-a');
    let g = store.transfer({ week, revision: 1, action: 'begin' }, 'phone-a');
    store.transfer({ week, revision: g.revision, action: 'confirm' }, 'phone-a');
    db.close(); db = null;
    setupResult = setup(path.join(dir, 'db.sqlite')); db = setupResult.db; store = setupResult.store;
    assert.ok(store.groceries(week).confirmed.at);
    assert.equal(store.plan(week).entries[0].servings, 6);
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='display_title'").get().value, 'Keep this title');
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='schema_version'").get().value, '2');
  } finally { db?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('aggregation scales cooking once, matches names, converts only supported units and flags unknown amounts', () => {
  const a = cleanMeal(recipe());
  const b = cleanMeal(recipe({ ingredients: [{ name: ' tomatoes ', quantity: 1, unit: 'kg' }, { name: 'Tomatoes', quantity: 1, unit: 'can' }, { name: 'Basil' }, { name: 'Milk', quantity: 1, unit: 'l' }, { name: 'Milk', quantity: 250, unit: 'ml' }] }));
  const rows = aggregate([{ id: 'a', type: 'meal', meal: a, servings: 6 }, { id: 'b', type: 'meal', meal: b, servings: 3 }, { id: 'l', type: 'leftovers', sourceId: 'a' }], ['a', 'b', 'l']);
  assert.equal(rows.find(i => i.name === 'Tomatoes' && i.unit === 'g').quantity, 2000);
  assert.equal(rows.find(i => i.unit === 'can').quantity, 1);
  assert.equal(rows.find(i => i.name === 'Milk').quantity, 1250);
  assert.equal(rows.find(i => i.name === 'Basil').unknown, true);
  assert.deepEqual(rows.find(i => i.name === 'Basil').sources, ['a', 'b']);
});

test('concurrent edits reject stale revisions; drafts do not change approved dinner display', () => {
  const { db, store } = setup();
  try {
    const { meal, plan } = planned(store);
    const changed = clone(plan.entries); changed[0].servings = 9;
    store.savePlan({ week, revision: plan.revision, entries: changed });
    assert.throws(() => store.savePlan({ week, revision: plan.revision, entries: [] }), { status: 409 });
    assert.equal(store.plan(week).approved.entries[0].servings, 6);
    assert.equal(store.plan(week).entries[0].servings, 9);
    store.saveMeal({ ...meal, name: 'New name' });
    assert.throws(() => store.saveMeal({ ...meal, name: 'Lost update' }), { status: 409 });
  } finally { db.close(); }
});
const clone = v => JSON.parse(JSON.stringify(v));

test('invalid leftovers and locked dinner moves leave the entire plan unchanged', () => {
  const { db, store } = setup();
  try {
    let { plan } = planned(store);
    const moved = clone(plan.entries); moved[0].date = '2026-09-10';
    assert.throws(() => store.savePlan({ week, revision: plan.revision, entries: moved }), { status: 400 });
    assert.equal(store.plan(week).revision, plan.revision);
    const locked = clone(plan.entries); locked[0].locked = true;
    plan = store.savePlan({ week, revision: plan.revision, entries: locked });
    const changed = clone(plan.entries); changed[0].servings = 12;
    assert.throws(() => store.savePlan({ week, revision: plan.revision, entries: changed }), { status: 409 });
    assert.equal(store.plan(week).entries[0].servings, 6);
  } finally { db.close(); }
});

test('transfer needs approval, a current review, and the same phone reservation; history survives rebuilding', () => {
  const { db, store } = setup();
  try {
    const { plan } = planned(store);
    let g = store.review({ week, revision: 0, planRevision: plan.revision, selected: ['cook'], items: [] }, 'a');
    assert.throws(() => store.transfer({ week, revision: g.revision, action: 'confirm' }, 'a'), { status: 409 });
    g = store.transfer({ week, revision: g.revision, action: 'begin' }, 'a');
    assert.throws(() => store.transfer({ week, revision: g.revision, action: 'begin' }, 'b'), { status: 409 });
    assert.throws(() => store.review({ week, revision: g.revision, planRevision: plan.revision, selected: ['cook'] }, 'b'), { status: 409 });
    g = store.transfer({ week, revision: g.revision, action: 'confirm' }, 'a');
    const at = g.confirmed.at;
    assert.throws(() => store.transfer({ week, revision: g.revision - 1, action: 'confirm' }, 'a'), { status: 409 });
    const entries = clone(plan.entries); entries[0].servings = 9;
    const next = store.savePlan({ week, revision: plan.revision, entries });
    assert.throws(() => store.transfer({ week, revision: g.revision, action: 'begin' }, 'a'), { status: 409 });
    g = store.review({ week, revision: g.revision, planRevision: next.revision, selected: ['cook'], items: [] }, 'a');
    assert.equal(g.confirmed.at, at);
    assert.equal(g.items.find(i => i.unit === 'g').quantity, 1500);
    assert.equal(g.confirmed.items.find(i => i.unit === 'g').quantity, 1000);
    assert.throws(() => store.transfer({ week, revision: g.revision, action: 'begin' }, 'a'), { status: 400 });
  } finally { db.close(); }
});

test('mushrooms and missing toddler adaptation cannot enter plans; unsafe links and numbers are rejected', () => {
  const { db, store } = setup();
  try {
    for (const patch of [{ name: 'Mushroom soup' }, { toddler: '' }]) {
      const m = store.saveMeal(recipe(patch));
      assert.ok(mealWarnings(m).length);
      assert.throws(() => store.savePlan({ week, revision: 0, entries: [{ id: 'x', date: week, type: 'meal', mealId: m.id, servings: 3 }] }), { status: 400 });
    }
    assert.throws(() => cleanMeal(recipe({ url: 'javascript:alert(1)' })), { status: 400 });
    assert.throws(() => cleanMeal(recipe({ servings: -1 })), { status: 400 });
  } finally { db.close(); }
});

test('HTTP meal APIs require pairing, reject foreign origins, and expose only an approved display summary', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'meals-http-'));
  const port = 22000 + process.pid % 2000, base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, APP_MODE: 'demo', APP_HOST: '127.0.0.1', APP_PORT: String(port), APP_DATA_DIR: dir, MEALS_ENABLED: '1' }, stdio: 'ignore' });
  try {
    for (let n = 0; n < 100; n++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
    const request = (url, body, cookie, origin) => fetch(base + url, { method: body ? 'POST' : 'GET', headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal((await request('/api/meals/state?week=' + week)).status, 401);
    assert.equal((await request('/api/meals/favourite', recipe())).status, 401);
    const login = await request('/api/auth/login', { pin: '1234' }); const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await request('/api/meals/favourite', recipe(), cookie, 'http://elsewhere.invalid')).status, 403);
    const response = await request('/api/meals/favourite', recipe(), cookie); assert.equal(response.status, 200);
    const meal = await response.json();
    const input = { week, revision: 0, entries: [{ id: 'cook', date: week, type: 'meal', mealId: meal.id, servings: 3 }] };
    assert.equal((await request('/api/meals/plan', input, cookie)).status, 200);
    assert.equal((await request('/api/meals/plan', input, cookie)).status, 409);
    const summary = await (await request('/api/meals/display')).json();
    assert.deepEqual(summary.entries, []);
    assert.ok(!JSON.stringify(summary).includes('ingredients'));
  } finally { child.kill(); await new Promise(r => child.exitCode !== null ? r() : child.once('exit', r)); await rm(dir, { recursive: true, force: true }); }
});
