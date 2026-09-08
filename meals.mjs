import { randomUUID } from 'node:crypto';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const text = (v, max = 200) => String(v ?? '').trim().slice(0, max);
export const ingredientKey = v => text(v).toLowerCase().replace(/\s+/g, ' ');
export const dateValid = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
export const addDate = (v, n) => new Date(Date.parse(v + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
export const weekOf = v => addDate(v, -((new Date(v + 'T12:00:00Z').getUTCDay() + 6) % 7));
const number = (v, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) fail(400, `Number must be between ${min} and ${max}.`);
  return n;
};
const mushroom = /mushroom|shiitake|portobell|cremini|porcini|chanterelle|enoki|morel/i;
export function cleanMeal(input) {
  const meal = {
    name: text(input.name), servings: number(input.servings ?? 3, 0.25, 100),
    minutes: number(input.minutes ?? 30, 0, 1440), url: text(input.url, 2000),
    toddler: text(input.toddler, 1000), tags: text(input.tags, 200),
    ingredientsComplete: input.ingredientsComplete === true, archived: input.archived === true,
    ingredients: (Array.isArray(input.ingredients) ? input.ingredients : []).map(i => ({
      name: text(i.name), key: ingredientKey(i.name),
      quantity: i.quantity === '' || i.quantity == null ? null : number(i.quantity, 0.001, 100000),
      unit: ingredientKey(i.unit).slice(0, 30)
    }))
  };
  if (!meal.name || meal.ingredients.length > 100 || meal.ingredients.some(i => !i.name)) fail(400, 'Enter a meal name and valid ingredients (maximum 100).');
  if (meal.url && !/^https?:\/\//i.test(meal.url)) fail(400, 'Recipe links must use http or https.');
  if (meal.url) { try { new URL(meal.url); } catch { fail(400, 'Enter a valid recipe link.'); } }
  return meal;
}
export function mealWarnings(meal) {
  const warnings = [];
  if (mushroom.test([meal.name, ...meal.ingredients.map(i => i.name)].join(' '))) warnings.push('Contains a mushroom ingredient or name: replace it before planning.');
  if (!meal.toddler) warnings.push('Add a toddler-friendly serving or adaptation note before planning.');
  if (!meal.ingredientsComplete) warnings.push('Ingredients have not been confirmed complete.');
  return warnings;
}
const units = { g: ['g', 1], gram: ['g', 1], grams: ['g', 1], kg: ['g', 1000], ml: ['ml', 1], l: ['ml', 1000], litre: ['ml', 1000], litres: ['ml', 1000] };
export function aggregate(entries, selected) {
  const result = new Map();
  for (const entry of entries.filter(e => selected.includes(e.id) && e.type === 'meal')) {
    const ratio = entry.servings / entry.meal.servings;
    for (const i of entry.meal.ingredients) {
      const [unit, multiplier] = units[i.unit] || [i.unit, 1];
      const key = JSON.stringify([i.key, unit]);
      const row = result.get(key) || { key, name: i.name, unit, quantity: 0, unknown: false, sources: [] };
      if (i.quantity == null) row.unknown = true;
      else row.quantity += i.quantity * multiplier * ratio;
      if (!row.sources.includes(entry.id)) row.sources.push(entry.id);
      result.set(key, row);
    }
  }
  return [...result.values()].map(i => ({ ...i, quantity: Math.round(i.quantity * 1000) / 1000 })).sort((a, b) => a.name.localeCompare(b.name));
}

export function createMealStore(db, changed = () => {}) {
  // Additive, opt-in migration. Existing integration tables are untouched.
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS family_meals (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS family_plans (week TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS family_groceries (week TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS family_meal_settings (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, body TEXT NOT NULL);`);
    db.prepare('INSERT OR IGNORE INTO family_meal_settings VALUES(1,1,?)').run(JSON.stringify({ adults: 2, children: 1, servings: 3 }));
    db.prepare("INSERT INTO settings(key,value) VALUES('schema_version','2') ON CONFLICT(key) DO UPDATE SET value=CASE WHEN CAST(value AS INTEGER)<2 THEN '2' ELSE value END").run();
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const read = (table, column, id) => {
    const row = db.prepare(`SELECT revision,body FROM ${table} WHERE ${column}=?`).get(id);
    return row ? { ...JSON.parse(row.body), revision: row.revision } : null;
  };
  const write = (table, column, id, expected, body) => {
    const current = read(table, column, id);
    if (!Number.isInteger(expected) || expected !== (current?.revision || 0)) fail(409, 'Someone saved a newer version. Your draft is still here; reload the latest version before trying again.');
    const revision = expected + 1;
    db.prepare(`INSERT INTO ${table}(${column},revision,body) VALUES(?,?,?) ON CONFLICT(${column}) DO UPDATE SET revision=excluded.revision,body=excluded.body`).run(id, revision, JSON.stringify(body));
    return { ...body, revision };
  };
  const atomic = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); changed(); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const validWeek = week => { if (!dateValid(week) || weekOf(week) !== week) fail(400, 'Choose a valid Monday week start.'); };
  const settings = () => read('family_meal_settings', 'id', 1);
  const plan = week => { validWeek(week); return read('family_plans', 'week', week) || { week, revision: 0, entries: [], approved: null }; };
  const groceries = week => { validWeek(week); return read('family_groceries', 'week', week) || { week, revision: 0, items: [], selected: [], confirmed: null, lease: null }; };
  const allMeals = () => db.prepare('SELECT id,revision,body FROM family_meals').all().map(r => ({ ...JSON.parse(r.body), id: r.id, revision: r.revision }));
  function validateEntries(entries, previous) {
    if (!Array.isArray(entries) || entries.length > 7) fail(400, 'A week contains at most seven dinners.');
    const ids = new Set(), dates = new Set();
    const result = entries.map(e => {
      if (!dateValid(e.date) || dates.has(e.date)) fail(400, 'Each dinner needs a unique valid date.');
      dates.add(e.date);
      const id = text(e.id, 80) || randomUUID();
      if (ids.has(id)) fail(400, 'Dinner IDs must be unique.');
      ids.add(id);
      if (!['meal', 'leftovers', 'takeout', 'unplanned'].includes(e.type)) fail(400, 'Invalid dinner type.');
      const old = previous.entries.find(p => p.id === id);
      const row = { id, date: e.date, type: e.type, locked: e.locked === true };
      if (e.type === 'meal') {
        const saved = read('family_meals', 'id', text(e.mealId, 80));
        // Reusing an entry keeps its recipe snapshot even after the favourite changes.
        row.mealId = text(e.mealId, 80);
        row.meal = old?.mealId === row.mealId && old.type === 'meal' && e.refreshRecipe !== true ? old.meal : saved;
        if (!row.meal || (!old && saved?.archived)) fail(400, 'Choose an available favourite.');
        if (mealWarnings(row.meal).some(w => !w.startsWith('Ingredients'))) fail(400, 'Meals must exclude mushrooms and include a toddler-friendly note.');
        row.servings = number(e.servings, 0.25, 100);
      }
      if (e.type === 'leftovers') row.sourceId = text(e.sourceId, 80);
      return row;
    });
    for (const row of result.filter(e => e.type === 'leftovers')) {
      const source = result.find(e => e.id === row.sourceId && e.type === 'meal');
      if (!source || source.date >= row.date) fail(400, 'Leftovers must refer to an earlier cooking night in this week. Check cooked servings too.');
    }
    for (const old of previous.entries.filter(e => e.locked)) {
      const next = result.find(e => e.id === old.id);
      if (!next || (next.locked && JSON.stringify(next) !== JSON.stringify(old))) fail(409, 'Unlock a dinner before changing or moving it.');
    }
    return result;
  }
  return {
    settings, plan, groceries, allMeals,
    state(week) { return { settings: settings(), meals: allMeals(), plan: plan(week), groceries: groceries(week) }; },
    saveSettings(input) { return atomic(() => write('family_meal_settings', 'id', 1, input.revision, { adults: number(input.adults, 1, 20), children: number(input.children, 0, 20), servings: number(input.servings, 0.25, 100) })); },
    saveMeal(input) { return atomic(() => {
      const id = text(input.id, 80) || randomUUID();
      return { ...write('family_meals', 'id', id, input.revision, cleanMeal(input)), id };
    }); },
    savePlan(input) { return atomic(() => {
      const previous = plan(input.week);
      const entries = validateEntries(input.entries, previous);
      if (entries.some(e => weekOf(e.date) !== input.week)) fail(400, 'All dinners must be in the selected week.');
      const approved = input.approve === true ? { entries, at: new Date().toISOString() } : previous.approved;
      return write('family_plans', 'week', input.week, input.revision, { week: input.week, entries, approved });
    }); },
    review(input, owner) { return atomic(() => {
      const p = plan(input.week), old = groceries(input.week);
      if (input.planRevision !== p.revision) fail(409, 'The plan changed. Reload and review ingredients again.');
      if (old.lease && old.lease.until > Date.now() && old.lease.owner !== owner) fail(409, 'Another phone is transferring this batch. Try again after they finish.');
      const selected = [...new Set(Array.isArray(input.selected) ? input.selected : [])];
      if (selected.some(id => !p.entries.some(e => e.id === id && e.type === 'meal'))) fail(400, 'Select valid cooking nights.');
      const items = aggregate(p.entries, selected).map(row => {
        const edit = input.items?.find(i => i.key === row.key);
        const disposition = edit?.disposition || 'buy';
        if (!['buy', 'have', 'keep'].includes(disposition)) fail(400, 'Invalid ingredient review choice.');
        return { ...row, amount: text(edit?.amount ?? `${row.quantity || ''}${row.unit ? ' ' + row.unit : ''}${row.unknown ? ' + amount needed' : ''}`, 100), disposition };
      });
      return write('family_groceries', 'week', input.week, input.revision, { ...old, planRevision: p.revision, selected, items, lease: null });
    }); },
    transfer(input, owner) { return atomic(() => {
      const old = groceries(input.week), p = plan(input.week);
      if (old.planRevision !== p.revision) fail(409, 'The plan changed; review groceries before transferring.');
      if (!p.approved || JSON.stringify(p.entries) !== JSON.stringify(p.approved.entries)) fail(400, 'Approve the current dinner plan before transferring groceries.');
      const leased = old.lease && old.lease.until > Date.now();
      if (leased && old.lease.owner !== owner) fail(409, 'Another phone is transferring this batch.');
      let body = { ...old };
      if (input.action === 'begin') body.lease = { owner, until: Date.now() + 10 * 60 * 1000 };
      else if (input.action === 'cancel') body.lease = null;
      else if (input.action === 'confirm') {
        if (!leased || old.lease.owner !== owner) fail(409, 'Start a transfer on this phone before confirming it.');
        body.confirmed = { at: new Date().toISOString(), items: old.items, planRevision: old.planRevision };
        body.lease = null;
      } else fail(400, 'Invalid transfer action.');
      return write('family_groceries', 'week', input.week, input.revision, body);
    }); },
    summary(today) {
      const p = plan(weekOf(today));
      const entries = p.approved?.entries || [];
      return { today, approvedAt: p.approved?.at || null, entries: entries.map(e => ({ date: e.date, type: e.type, name: e.type === 'meal' ? e.meal.name : e.type === 'leftovers' ? `Leftovers: ${entries.find(s => s.id === e.sourceId)?.meal?.name || 'earlier dinner'}` : e.type === 'takeout' ? 'Takeout' : 'Unplanned', minutes: e.meal?.minutes, toddler: e.meal?.toddler, url: e.meal?.url })) };
    }
  };
}
