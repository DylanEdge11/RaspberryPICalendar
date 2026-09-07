// Keep explicit precipitation/storm codes; supplement dry summary codes only.
export function currentConditionCode(current) {
  const code = current.weather_code;
  if (![0, 1, 2, 3, 45, 48].includes(code) && Number.isFinite(code)) return code;
  if (Number.isFinite(current.snowfall) && current.snowfall > 0) return 71;
  if ((Number.isFinite(current.rain) && current.rain > 0) ||
      (Number.isFinite(current.showers) && current.showers > 0)) return 61;
  return code;
}

const REGINA = { name: 'Regina, Saskatchewan, Canada', latitude: 50.4452, longitude: -104.6189 };

export function createWeatherService({ fetchImpl = fetch, now = Date.now } = {}) {
  const locations = new Map([['Regina', REGINA]]);
  const cache = new Map();
  const pending = new Map();
  async function json(url) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Weather provider is temporarily unavailable.');
    return response.json();
  }
  async function resolve(city) {
    if (locations.has(city)) return locations.get(city);
    const data = await json(`https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name: city, count: '1', language: 'en' })}`);
    const item = data.results?.[0];
    if (!item || !Number.isFinite(item.latitude) || !Number.isFinite(item.longitude)) throw new Error('Location not found. Try a city with its province or country.');
    const location = { name: [item.name, item.admin1, item.country].filter(Boolean).join(', '), latitude: item.latitude, longitude: item.longitude };
    if (locations.size > 100) locations.clear();
    locations.set(city, location);
    return location;
  }
  async function get(city) {
    const old = cache.get(city);
    if (old && now() - old.checked < 5 * 60 * 1000) return old.value;
    if (pending.has(city)) return pending.get(city);
    const work = (async () => {
      try {
        const location = await resolve(city);
        const params = new URLSearchParams({ latitude: location.latitude, longitude: location.longitude, timezone: 'auto', forecast_days: '7', current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,rain,showers,snowfall', hourly: 'temperature_2m,weather_code,precipitation_probability', daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' });
        const data = await json(`https://api.open-meteo.com/v1/forecast?${params}`);
        if (!data.current?.time || !data.hourly?.time?.length || !data.daily?.time?.length) throw new Error('Weather provider returned incomplete data.');
        const value = { location, timezone: data.timezone, current: { ...data.current, display_weather_code: currentConditionCode(data.current) }, hourly: data.hourly, daily: data.daily, updated_at: new Date(now()).toISOString(), stale: false };
        if (cache.size > 20) cache.clear();
        cache.set(city, { checked: now(), value });
        return value;
      } catch (error) {
        if (!old) throw error;
        const value = { ...old.value, stale: true };
        cache.set(city, { checked: now(), value });
        return value;
      } finally { pending.delete(city); }
    })();
    pending.set(city, work);
    return work;
  }
  return { resolve, get };
}
