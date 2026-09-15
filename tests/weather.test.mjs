import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeatherService, currentConditionCode } from '../weather.mjs';

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


test('current precipitation supplements dry codes without hiding severe weather', () => {
  assert.equal(currentConditionCode({ weather_code: 3, rain: 1.2 }), 61);
  assert.equal(currentConditionCode({ weather_code: 3, showers: 0.3 }), 61);
  assert.equal(currentConditionCode({ weather_code: 3, snowfall: 0.2 }), 71);
  assert.equal(currentConditionCode({ weather_code: 95, rain: 2 }), 95);
  assert.equal(currentConditionCode({ weather_code: 66, rain: 2 }), 66);
  assert.equal(currentConditionCode({ weather_code: 3, rain: 0, showers: null }), 3);
  assert.equal(currentConditionCode({ weather_code: 3, rain: '1' }), 3);
  assert.equal(currentConditionCode({ weather_code: 3, precipitation_probability: 100 }), 3);
});

test('refreshes after five minutes and returns a rain display code alongside the source code', async () => {
  let clock = 100000000;
  let calls = 0;
  const service = createWeatherService({ now: () => clock, fetchImpl: async url => {
    calls++;
    const fields = new URL(url).searchParams.get('current').split(',');
    for (const field of ['rain', 'showers', 'snowfall']) assert.ok(fields.includes(field));
    return { ok: true, json: async () => ({ ...forecast, current: { ...forecast.current, weather_code: 3, rain: calls === 1 ? 0 : 1.2 } }) };
  } });
  assert.equal((await service.get('Regina')).current.display_weather_code, 3);
  clock += 4 * 60 * 1000;
  await service.get('Regina');
  assert.equal(calls, 1);
  clock += 60 * 1000;
  const wet = await service.get('Regina');
  assert.equal(calls, 2);
  assert.equal(wet.current.weather_code, 3);
  assert.equal(wet.current.display_weather_code, 61);
});
