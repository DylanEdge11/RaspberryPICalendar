import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeatherService } from '../weather.mjs';

const forecast = { timezone: 'America/Regina', current: { time: '2026-09-07T12:00', temperature_2m: 20 }, hourly: { time: ['2026-09-07T12:00'] }, daily: { time: ['2026-09-07'] } };
test('Regina forecast requests are coalesced, cached, and retained with a stale label on failure', async () => {
  let calls = 0;
  let clock = 100000000;
  const service = createWeatherService({ now: () => clock, fetchImpl: async url => {
    calls++;
    assert.equal(new URL(url).searchParams.get('latitude'), '50.4452');
    assert.equal(new URL(url).searchParams.get('forecast_days'), '7');
    if (calls > 1) throw new Error('offline');
    return { ok: true, json: async () => forecast };
  } });
  const [first, second] = await Promise.all([service.get('Regina'), service.get('Regina')]);
  assert.deepEqual(first, second);
  await service.get('Regina');
  assert.equal(calls, 1);
  clock += 16 * 60 * 1000;
  const stale = await service.get('Regina');
  assert.equal(stale.stale, true);
  assert.equal(stale.updated_at, first.updated_at);
  assert.deepEqual(stale.current, first.current);
});

test('city lookup uses resolved coordinates and rejects unknown locations', async () => {
  const service = createWeatherService({ fetchImpl: async url => {
    const parsed = new URL(url);
    if (parsed.hostname.startsWith('geocoding')) return { ok: true, json: async () => ({ results: parsed.searchParams.get('name') === 'Unknown' ? [] : [{ name: 'Toronto', admin1: 'Ontario', country: 'Canada', latitude: 43.7, longitude: -79.4 }] }) };
    assert.equal(parsed.searchParams.get('latitude'), '43.7');
    return { ok: true, json: async () => forecast };
  } });
  assert.equal((await service.get('Toronto')).location.name, 'Toronto, Ontario, Canada');
  await assert.rejects(service.get('Unknown'), /Location not found/);
});
