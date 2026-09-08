(() => {
  'use strict';
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let enabled = false, bar, dialog, busy = false;
  async function refresh() {
    if (!enabled || document.hidden || busy) return;
    busy = true;
    try {
      const response = await fetch('/api/meals/display', { cache: 'no-store' });
      if (!response.ok) throw new Error('Dinner refresh failed');
      const data = await response.json();
      const tonight = data.entries.find(e => e.date === data.today);
      bar.innerHTML = `<button type="button" class="dinner-tonight"><span>Tonight's dinner</span><strong>${esc(tonight?.name || 'Unplanned')}</strong></button><div class="dinner-mini">${data.entries.map(e => `<span><b>${esc(new Date(e.date + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'short' }))}</b> ${esc(e.name)}</span>`).join('')}</div><button type="button" class="dinner-week">Week</button>`;
      dialog.querySelector('.dinner-details').innerHTML = `<p>${data.approvedAt ? 'Approved dinner plan' : 'Plan and approve your first week from Meals.'}</p>${data.entries.map(e => `<article><h3>${esc(new Date(e.date + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }))} · ${esc(e.name)}</h3>${e.minutes != null ? `<p>${e.minutes} minutes</p>` : ''}<p>${esc(e.toddler || '')}</p>${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">Open recipe ↗</a>` : ''}</article>`).join('')}`;
      bar.onclick = () => { if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', ''); };
    } catch { if (bar && !bar.querySelector('.dinner-stale')) bar.insertAdjacentHTML('beforeend', '<small class="dinner-stale">Dinners offline</small>'); }
    finally { busy = false; }
  }
  fetch('/api/state', { cache: 'no-store' }).then(r => r.json()).then(info => {
    if (!info.meals_enabled) return;
    const link = document.createElement('a'); link.href = '/meals'; link.textContent = 'Meals'; link.className = 'back-link';
    const controls = document.querySelector('.control-topbar');
    if (controls) { controls.append(link); return; }
    const header = document.querySelector('.display-topbar'); if (!header) return;
    link.className = 'icon-link controls-link'; header.querySelector('.topbar-status').append(link);
    bar = document.createElement('div'); bar.className = 'dinner-bar'; header.after(bar);
    dialog = document.createElement('dialog'); dialog.className = 'dinner-dialog'; dialog.innerHTML = '<div class="detail-heading"><h2>Family dinners</h2><button type="button">Close</button></div><div class="dinner-details"></div><a href="/meals">Edit meal plan →</a>';
    dialog.querySelector('button').onclick = () => { if (dialog.close) dialog.close(); else dialog.removeAttribute('open'); };
    document.body.append(dialog); enabled = true; refresh();
    if (window.EventSource) { const stream = new EventSource('/api/updates'); stream.addEventListener('state', refresh); }
    setInterval(refresh, 30000);
    document.addEventListener('visibilitychange', refresh); window.addEventListener('online', refresh);
  }).catch(() => {});
})();
