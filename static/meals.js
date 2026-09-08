(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = v => JSON.parse(JSON.stringify(v));
  const add = (v, n) => new Date(Date.parse(v + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const monday = v => add(v, -((new Date(v + 'T12:00:00Z').getUTCDay() + 6) % 7));
  const dayName = date => new Date(date + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const id = () => `d-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let state, entries = [], week, dirty = false, reviewDirty = false, saving = false, activeTransfer = false, recentIds = [];
  let mealDirty = false;
  function ask(question) {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog'); dialog.className = 'meal-confirm';
      dialog.innerHTML = `<h2>Review this step</h2><p>${esc(question)}</p><div class="toolbar"><button data-answer="yes">Continue</button><button class="secondary" data-answer="no">Go back</button></div>`;
      const finish = answer => { dialog.remove(); resolve(answer); };
      dialog.addEventListener('cancel', e => { e.preventDefault(); finish(false); });
      dialog.querySelector('[data-answer="yes"]').onclick = () => finish(true);
      dialog.querySelector('[data-answer="no"]').onclick = () => finish(false);
      document.body.append(dialog);
      if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
      dialog.querySelector('[data-answer="no"]').focus();
    });
  }
  function message(value, error = false) { $('status').textContent = value; $('status').className = error ? 'error' : ''; }
  async function api(path, body) {
    const response = await fetch('/api/' + path, { cache: 'no-store', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401) $('pair').hidden = false;
      throw new Error(data.error || 'Request failed. Your draft is still here.');
    }
    return data;
  }
  async function run(fn) {
    if (saving) return;
    saving = true;
    try { await fn(); } catch (e) { message(e.message, true); }
    finally { saving = false; }
  }
  function stash() {
    try { sessionStorage.setItem('meal-plan-draft', JSON.stringify({ week, revision: state.plan.revision, entries, dirty })); } catch { /* Editing still works without browser storage. */ }
  }
  function changed() { dirty = true; stash(); message('Unsaved dinner changes. Save a draft or approve for the display.'); }
  const eligible = m => !m.archived && m.toddler && !/mushroom|shiitake|portobell|cremini|porcini|chanterelle|enoki|morel/i.test([m.name, ...m.ingredients.map(i => i.name)].join(' '));
  function title(e) { return e.type === 'meal' ? e.meal?.name || state.meals.find(m => m.id === e.mealId)?.name || 'Choose a meal' : e.type === 'takeout' ? 'Takeout' : e.type === 'leftovers' ? 'Leftovers' : 'Unplanned'; }
  function ensureDays() {
    entries = Array.from({ length: 7 }, (_, n) => entries.find(e => e.date === add(week, n)) || { id: id(), date: add(week, n), type: 'unplanned', locked: false });
  }
  function renderDays() {
    ensureDays();
    $('days').innerHTML = entries.map(e => {
      const available = state.meals.filter(eligible);
      if (e.type === 'meal' && !available.some(m => m.id === e.mealId) && e.meal) available.push({ ...e.meal, id: e.mealId });
      const disabled = e.locked ? 'disabled' : '';
      return `<article class="day" data-id="${esc(e.id)}"><h3>${esc(dayName(e.date))}</h3><label>Dinner type<select data-field="type" ${disabled}>${['unplanned', 'meal', 'leftovers', 'takeout'].map(t => `<option value="${t}" ${e.type === t ? 'selected' : ''}>${{ unplanned: 'Unplanned / leave open', meal: 'Cook a favourite', leftovers: 'Leftovers', takeout: 'Takeout' }[t]}</option>`).join('')}</select></label>
      ${e.type === 'meal' ? `<label>Favourite<select data-field="mealId" ${disabled}><option value="">Choose a favourite</option>${available.map(m => `<option value="${esc(m.id)}" ${m.id === e.mealId ? 'selected' : ''}>${esc(m.name)} · ${m.minutes} min</option>`).join('')}</select></label><label>Cooked servings (including leftovers)<input type="number" data-field="servings" min="0.25" max="100" step="0.25" value="${esc(e.servings || state.settings.servings)}" ${disabled}></label><p>${esc(e.meal?.toddler || state.meals.find(m => m.id === e.mealId)?.toddler || 'Choose a toddler-friendly favourite.')}</p><button type="button" class="secondary" data-refresh-recipe ${disabled}>Use latest favourite recipe</button>` : ''}
      ${e.type === 'leftovers' ? `<label>Use leftovers from<select data-field="sourceId" ${disabled}><option value="">Choose an earlier cooking night</option>${entries.filter(s => s.type === 'meal' && s.date < e.date).map(s => `<option value="${esc(s.id)}" ${s.id === e.sourceId ? 'selected' : ''}>${esc(dayName(s.date))}: ${esc(title(s))}</option>`).join('')}</select></label><p>No extra groceries. Check that the source dinner makes enough portions.</p>` : ''}
      <label class="check"><input type="checkbox" data-field="locked" ${e.locked ? 'checked' : ''}> Lock this night</label><label>Move / swap with<select data-field="destination" ${disabled}><option value="">Choose another day</option>${entries.filter(s => s.id !== e.id && !s.locked).map(s => `<option value="${esc(s.id)}">${esc(dayName(s.date))} · ${esc(title(s))}</option>`).join('')}</select></label></article>`;
    }).join('');
    $('approval').textContent = state.plan.approved ? `Display uses the plan approved ${new Date(state.plan.approved.at).toLocaleString()}. Saving a draft leaves that approved display in place.` : 'Nothing published yet. Approve when you are ready to show dinners on the display.';
  }
  function renderFavourites() {
    $('favourites').innerHTML = state.meals.filter(m => !m.archived).map(m => `<button class="secondary" data-meal="${esc(m.id)}">${esc(m.name)} · ${m.minutes} min${eligible(m) ? '' : ' · needs review'}</button>`).join('') || '<p>Add a few favourites to begin. Name-only drafts are welcome; finish the toddler note before planning them.</p>';
    const names = [...new Set(state.meals.flatMap(m => m.ingredients.map(i => i.name)))];
    $('ingredientNames').innerHTML = names.map(n => `<option value="${esc(n)}"></option>`).join('');
  }
  function renderShopping() {
    $('shoppingNights').innerHTML = state.plan.entries.filter(e => e.type === 'meal').map(e => `<label class="check"><input type="checkbox" data-shop="${esc(e.id)}" ${!state.groceries.revision || state.groceries.selected.includes(e.id) ? 'checked' : ''}>${esc(dayName(e.date))} · ${esc(e.meal.name)}${e.meal.ingredientsComplete ? '' : ' — ingredients incomplete'}</label>`).join('') || '<p>Save a cooking night to build its groceries.</p>';
    renderGroceries();
  }
  function renderGroceries() {
    const g = state.groceries;
    $('groceries').innerHTML = g.items.map(i => `<div class="grocery" data-key="${esc(i.key)}"><div><strong>${esc(i.name)}</strong><small>${i.quantity ? esc(i.quantity + ' ' + i.unit) : ''}${i.unknown ? ' · amount needed' : ''} · ${esc(i.sources.map(id => state.plan.entries.find(e => e.id === id)?.meal?.name || 'Previous meal').join(', '))}</small></div><label>Reviewed amount<input data-amount maxlength="100" value="${esc(i.amount)}"></label><label>Action<select data-disposition>${[['buy', 'Buy'], ['have', 'Already have'], ['keep', 'Already on Keep']].map(([v, t]) => `<option value="${v}" ${i.disposition === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label></div>`).join('');
    $('groceryNotice').textContent = g.revision && g.planRevision !== state.plan.revision ? 'The saved plan changed. Rebuild and review before transferring. Previous review choices will need checking.' : 'Quantities are estimates. Match names explicitly; mass, volume and package sizes stay separate.';
    $('transferStatus').textContent = g.confirmed ? `Last manual merge confirmed ${new Date(g.confirmed.at).toLocaleString()}. Compare changes below; do not paste the whole list again.` : 'No manual transfer has been confirmed for this week.';
    if (g.lease?.until > Date.now() && !activeTransfer) $('transferStatus').textContent += ' A phone has reserved this batch for transfer (up to 10 minutes).';
  }
  async function load(force = false) {
    const latest = await api('meals/state?week=' + week);
    if (!force && state && (dirty || reviewDirty || mealDirty || activeTransfer)) {
      if (latest.plan.revision !== state.plan.revision || latest.groceries.revision !== state.groceries.revision || JSON.stringify(latest.meals) !== JSON.stringify(state.meals)) message('A saved version changed on another phone. Your draft is preserved; reload when ready.', true);
      return;
    }
    if (!force && state && JSON.stringify(latest) === JSON.stringify(state)) return;
    state = latest; entries = clone(state.plan.entries); dirty = false; reviewDirty = false;
    $('planner').hidden = false; $('pair').hidden = true;
    $('week').value = week; $('weekTitle').textContent = 'Week of ' + dayName(week);
    for (const field of ['adults', 'children', 'servings']) $(field).value = state.settings[field];
    $('quickDay').innerHTML = '<option value="">None</option>' + Array.from({ length: 7 }, (_, n) => `<option value="${add(week, n)}">${esc(dayName(add(week, n)))}</option>`).join('');
    renderDays(); renderFavourites(); renderShopping();
  }
  async function changeWeek(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) return;
    if ((dirty || reviewDirty || mealDirty || activeTransfer) && !await ask('Leave this week? Unsaved edits will be discarded. An active transfer reservation expires after 10 minutes.')) { $('week').value = week; return; }
    week = monday(value); activeTransfer = false; $('transferPanel').hidden = true; $('mealForm').hidden = true; mealDirty = false;
    await load(true); stash();
    const previous = await api('meals/state?week=' + add(week, -7)); recentIds = previous.plan.entries.map(e => e.mealId).filter(Boolean);
  }
  $('days').addEventListener('change', event => {
    const field = event.target.dataset.field, row = event.target.closest('[data-id]');
    if (!row || !field) return;
    const e = entries.find(e => e.id === row.dataset.id);
    if (field === 'destination') {
      const target = entries.find(e => e.id === event.target.value);
      if (!target) return;
      [e.date, target.date] = [target.date, e.date];
    } else if (field === 'locked') e.locked = event.target.checked;
    else if (field === 'type') { e.type = event.target.value; delete e.meal; delete e.mealId; delete e.sourceId; e.servings = state.settings.servings; }
    else if (field === 'mealId') { e.mealId = event.target.value; e.meal = clone(state.meals.find(m => m.id === e.mealId) || null); }
    else e[field] = event.target.value;
    changed(); renderDays();
  });
  $('days').addEventListener('input', event => {
    const row = event.target.closest('[data-id]');
    if (row && event.target.dataset.field === 'servings') {
      entries.find(e => e.id === row.dataset.id).servings = event.target.value;
      changed();
    }
  });
  $('days').addEventListener('click', async event => {
    if (!event.target.hasAttribute('data-refresh-recipe')) return;
    const entry = entries.find(e => e.id === event.target.closest('[data-id]').dataset.id);
    if (!await ask('Replace this dinner snapshot with the latest saved favourite? You will need to save the plan and review groceries again.')) return;
    const meal = state.meals.find(m => m.id === entry.mealId);
    if (!meal) return;
    entry.meal = clone(meal); entry.refreshRecipe = true; changed(); renderDays();
  });
  $('suggest').onclick = () => {
    const used = new Set(entries.map(e => e.mealId));
    const tags = new Set(entries.filter(e => e.meal).flatMap(e => e.meal.tags.split(',').map(t => t.trim().toLowerCase())));
    for (const e of entries.filter(e => !e.locked && e.type === 'unplanned')) {
      const choices = state.meals.filter(m => eligible(m) && !used.has(m.id) && (e.date !== $('quickDay').value || m.minutes <= Number($('quickMinutes').value)));
      choices.sort((a, b) => {
        const score = m => (recentIds.includes(m.id) ? 10 : 0) + m.tags.split(',').filter(t => t.trim() && tags.has(t.trim().toLowerCase())).length;
        return score(a) - score(b) || a.name.localeCompare(b.name);
      });
      if (!choices.length) continue;
      const meal = choices[0]; Object.assign(e, { type: 'meal', mealId: meal.id, meal: clone(meal), servings: state.settings.servings }); used.add(meal.id);
      meal.tags.split(',').forEach(t => tags.add(t.trim().toLowerCase()));
    }
    changed(); renderDays(); message('Suggestions are a draft. Leave open nights locked; replace any dinner before approving.');
  };
  async function savePlan(approve) {
    // Read number controls directly as well: some older WebViews defer change events.
    for (const input of $('days').querySelectorAll('[data-field="servings"]')) entries.find(e => e.id === input.closest('[data-id]').dataset.id).servings = input.value;
    if (reviewDirty && !await ask('Saving dinners will refresh the grocery section and discard its unsaved review. Continue?')) return;
    if (approve && !await ask('Publish these dinners to the household display? Groceries will still need a separate review and manual transfer.')) return;
    state.plan = await api('meals/plan', { week, revision: state.plan.revision, entries, approve });
    entries = clone(state.plan.entries); dirty = false; reviewDirty = false; stash(); renderDays(); renderShopping();
    activeTransfer = false; $('transferPanel').hidden = true;
    message(approve ? 'Approved dinners are now on the display.' : 'Dinner draft saved. The display keeps the last approved plan.');
  }
  $('savePlan').onclick = () => run(() => savePlan(false)); $('approve').onclick = () => run(() => savePlan(true));
  $('previous').onclick = () => run(() => changeWeek(add(week, -7))); $('next').onclick = () => run(() => changeWeek(add(week, 7))); $('week').onchange = () => run(() => changeWeek($('week').value));
  $('reload').onclick = () => run(async () => {
    if ((dirty || reviewDirty || mealDirty || activeTransfer) && !await ask('Discard local edits and reload the latest saved version?')) return;
    mealDirty = false; activeTransfer = false; $('mealForm').hidden = true; $('transferPanel').hidden = true; await load(true); stash(); message('Latest saved version loaded.');
  });
  function ingredientRow(i = {}) {
    const wrapper = document.createElement('div'); wrapper.className = 'ingredient';
    wrapper.innerHTML = `<label>Ingredient<input data-name list="ingredientNames" maxlength="200" value="${esc(i.name)}" required></label><label>Quantity<input data-quantity type="number" min="0.001" max="100000" step="any" value="${esc(i.quantity)}"></label><label>Unit<input data-unit maxlength="30" placeholder="g, ml, can…" value="${esc(i.unit)}"></label><button type="button" class="secondary" aria-label="Remove ingredient">Remove</button>`;
    wrapper.querySelector('button').onclick = () => { wrapper.remove(); mealDirty = true; };
    $('ingredients').append(wrapper);
  }
  async function editMeal(meal = {}) {
    if (mealDirty && !await ask('Discard the current favourite draft?')) return;
    $('mealForm').hidden = false; mealDirty = false;
    for (const [field, value] of Object.entries({ mealId: meal.id || '', mealRevision: meal.revision || 0, mealName: meal.name || '', mealServings: meal.servings || state.settings.servings, mealMinutes: meal.minutes ?? 30, mealUrl: meal.url || '', mealToddler: meal.toddler || '', mealTags: meal.tags || '' })) $(field).value = value;
    $('ingredientsComplete').checked = meal.ingredientsComplete || false; $('ingredients').innerHTML = ''; (meal.ingredients || []).forEach(ingredientRow);
    $('archiveMeal').hidden = !meal.id; $('mealFormTitle').textContent = meal.id ? 'Edit favourite' : 'Add favourite';
    $('mealWarning').textContent = 'No mushrooms. An adaptation note is required before this meal can be planned. Editing a favourite does not change dinners already saved in a plan.';
    $('mealName').focus();
  }
  $('newMeal').onclick = () => editMeal();
  $('favourites').onclick = e => { const button = e.target.closest('[data-meal]'); if (button) editMeal(state.meals.find(m => m.id === button.dataset.meal)); };
  $('addIngredient').onclick = () => { ingredientRow(); mealDirty = true; };
  $('mealForm').oninput = () => { mealDirty = true; };
  $('cancelMeal').onclick = async () => { if (!mealDirty || await ask('Discard this favourite draft?')) { $('mealForm').hidden = true; mealDirty = false; } };
  function mealInput() {
    return { id: $('mealId').value, revision: Number($('mealRevision').value), name: $('mealName').value, servings: $('mealServings').value, minutes: $('mealMinutes').value, url: $('mealUrl').value, toddler: $('mealToddler').value, tags: $('mealTags').value, ingredientsComplete: $('ingredientsComplete').checked, ingredients: [...$('ingredients').children].map(row => ({ name: row.querySelector('[data-name]').value, quantity: row.querySelector('[data-quantity]').value, unit: row.querySelector('[data-unit]').value })) };
  }
  async function saveFavourite(archived = false) {
    const meal = await api('meals/favourite', { ...mealInput(), archived });
    state.meals = state.meals.filter(m => m.id !== meal.id).concat(meal); $('mealForm').hidden = true; mealDirty = false; renderFavourites(); renderDays(); message(archived ? 'Favourite archived; saved dinner snapshots are retained.' : 'Favourite saved.');
  }
  $('mealForm').onsubmit = e => { e.preventDefault(); run(() => saveFavourite()); };
  $('archiveMeal').onclick = async () => { if (await ask('Archive this favourite? Existing planned meals are retained.')) run(() => saveFavourite(true)); };
  $('household').onsubmit = e => { e.preventDefault(); run(async () => { state.settings = await api('meals/settings', { revision: state.settings.revision, adults: $('adults').value, children: $('children').value, servings: $('servings').value }); message('Defaults saved. Existing portions are unchanged.'); }); };
  function reviewedItems() { return [...$('groceries').children].map(row => ({ key: row.dataset.key, amount: row.querySelector('[data-amount]').value, disposition: row.querySelector('[data-disposition]').value })); }
  $('groceries').oninput = () => { reviewDirty = true; activeTransfer = false; $('transferPanel').hidden = true; message('Unsaved grocery review.'); };
  $('shoppingNights').onchange = () => { reviewDirty = true; activeTransfer = false; $('transferPanel').hidden = true; };
  async function review(rebuild) {
    if (dirty) throw new Error('Save your dinner changes before reviewing groceries.');
    const selected = [...document.querySelectorAll('[data-shop]:checked')].map(e => e.dataset.shop);
    if (state.plan.entries.some(e => selected.includes(e.id) && !e.meal.ingredientsComplete) && !await ask('Some meals have incomplete ingredients. Continue with a partial grocery list and check the recipes manually?')) return;
    const stale = state.groceries.planRevision !== state.plan.revision;
    const selectedChanged = JSON.stringify([...selected].sort()) !== JSON.stringify([...state.groceries.selected].sort());
    if (rebuild && state.groceries.revision && (stale || selectedChanged) && !await ask('Recalculate quantities and reset review choices for this changed selection? The previous confirmed transfer remains available for comparison.')) return;
    if (!rebuild && (stale || selectedChanged)) throw new Error('Build / refresh ingredients first so quantities match the selected meals.');
    state.groceries = await api('meals/review', { week, revision: state.groceries.revision, planRevision: state.plan.revision, selected, items: rebuild && (stale || selectedChanged) ? [] : reviewedItems() });
    reviewDirty = false; activeTransfer = false; $('transferPanel').hidden = true; renderGroceries(); message('Grocery review saved.');
  }
  $('buildGroceries').onclick = () => run(() => review(true)); $('saveReview').onclick = () => run(() => review(false));
  function transferText() {
    const current = state.groceries.items.filter(i => i.disposition === 'buy');
    const previous = (state.groceries.confirmed?.items || []).filter(i => i.disposition === 'buy');
    const additions = current.filter(i => !previous.some(p => p.key === i.key));
    const updates = current.filter(i => previous.some(p => p.key === i.key && p.amount !== i.amount));
    const removed = previous.filter(p => !current.some(i => i.key === p.key));
    const line = i => `${i.name}${i.amount ? ' — ' + i.amount : ''}`;
    $('exportText').value = additions.map(line).join('\n');
    $('changes').innerHTML = [...updates.map(i => `<p><strong>Review quantity:</strong> ${esc(i.name)} · previously ${esc(previous.find(p => p.key === i.key).amount)} → now ${esc(i.amount)}. Edit the existing Keep row manually.</p>`), ...removed.map(i => `<p><strong>Review removal:</strong> ${esc(line(i))} is no longer requested by this batch. Keep it if needed elsewhere or already purchased.</p>`)].join('');
    $('transferInstructions').textContent = additions.length ? 'Only new ingredient rows appear in the copy box. Check for existing Keep items before adding them.' : 'No new ingredient rows since the last confirmed transfer. Review any quantity changes or removals below. To intentionally buy an unchanged item again, edit Keep manually.';
  }
  $('beginTransfer').onclick = () => run(async () => {
    if (dirty || reviewDirty) throw new Error('Save and review your changes first.');
    if (!state.groceries.revision) throw new Error('Build and save a grocery review first.');
    state.groceries = await api('meals/transfer', { week, revision: state.groceries.revision, action: 'begin' });
    activeTransfer = true; $('transferPanel').hidden = false; renderGroceries(); transferText(); message('Transfer reserved for this phone for 10 minutes. Nothing has been sent to Keep.');
  });
  async function endTransfer(action) {
    if (action === 'confirm' && !await ask('Confirm you manually merged additions and reviewed quantity changes/removals in Keep? The app cannot verify Keep.')) return;
    state.groceries = await api('meals/transfer', { week, revision: state.groceries.revision, action }); activeTransfer = false; $('transferPanel').hidden = true; renderGroceries(); message(action === 'confirm' ? 'Your manual transfer confirmation was saved.' : 'Transfer cancelled.');
  }
  $('confirmTransfer').onclick = () => run(() => endTransfer('confirm')); $('cancelTransfer').onclick = () => run(() => endTransfer('cancel'));
  $('copyText').onclick = async () => { $('exportText').focus(); $('exportText').select(); try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText($('exportText').value); message('Copied. Check your existing Keep list before pasting.'); return; } } catch { /* Native copy remains available. */ } message('Text selected. Long-press and choose Copy (or press Ctrl/Cmd+C).'); };
  $('pairForm').onsubmit = e => { e.preventDefault(); run(async () => { await api('auth/login', { pin: $('pin').value }); $('pin').value = ''; $('pair').hidden = true; if (!state) await load(true); message('Browser paired. Your draft is ready.'); }); };
  window.addEventListener('beforeunload', e => { if (dirty || reviewDirty || mealDirty || activeTransfer) { e.preventDefault(); e.returnValue = ''; } });
  async function refresh() { if (!saving && !document.hidden && state) { try { await load(); } catch (e) { message(e.message + ' Saved dinners remain on the Pi.', true); } } }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); }); window.addEventListener('online', refresh);
  setInterval(refresh, 10000);
  run(async () => {
    const info = await api('state'); week = monday(info.today); $('demoHint').textContent = info.mode === 'demo' ? 'Preview/demo PIN: 1234' : '';
    await load(true);
    try { const draft = JSON.parse(sessionStorage.getItem('meal-plan-draft')); if (draft?.dirty && await ask('Restore the unsaved dinner draft from this browser?')) { week = draft.week; await load(true); state.plan.revision = draft.revision; entries = draft.entries; dirty = true; renderDays(); message('Draft restored. If another phone saved meanwhile, saving will ask you to reload.', true); } } catch { /* Ignore unavailable or invalid local drafts. */ }
    const previous = await api('meals/state?week=' + add(week, -7)); recentIds = previous.plan.entries.map(e => e.mealId).filter(Boolean);
    if (window.EventSource) { const events = new EventSource('/api/updates'); events.addEventListener('state', refresh); }
  });
})();
