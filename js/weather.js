/**
 * EVE Chat Weather Module v0.8.0
 * Real local time and weather for both the user and the current character.
 * Data source: Open-Meteo (no API key required).
 */
(function (window, document) {
  'use strict';
  if (window.EVEWeather?.version) return;

  const VERSION = '0.8.0';
  const SETTINGS_KEY = 'eve_weather_settings_v2';
  const CACHE_KEY = 'eve_weather_cache_v2';
  const DEFAULTS = Object.freeze({
    enabled: true,
    includeUser: true,
    includeCharacter: true,
    promptEnabled: true,
    refreshMinutes: 30,
    requestTimeoutMs: 15000,
    debug: false
  });
  const CODES = Object.freeze({
    0:['晴朗','☀️'],1:['大致晴朗','🌤️'],2:['局部多云','⛅'],3:['阴天','☁️'],
    45:['有雾','🌫️'],48:['雾凇','🌫️'],51:['小毛毛雨','🌦️'],53:['毛毛雨','🌦️'],55:['强毛毛雨','🌧️'],
    56:['冻毛毛雨','🌧️'],57:['强冻毛毛雨','🌧️'],61:['小雨','🌧️'],63:['中雨','🌧️'],65:['大雨','🌧️'],
    66:['冻雨','🌧️'],67:['强冻雨','🌧️'],71:['小雪','🌨️'],73:['中雪','🌨️'],75:['大雪','❄️'],77:['雪粒','❄️'],
    80:['阵雨','🌦️'],81:['中等阵雨','🌧️'],82:['强阵雨','⛈️'],85:['阵雪','🌨️'],86:['强阵雪','❄️'],
    95:['雷雨','⛈️'],96:['雷雨伴冰雹','⛈️'],99:['强雷雨伴冰雹','⛈️']
  });

  let settings = readJson(SETTINGS_KEY, DEFAULTS);
  let environment = null;
  let timer = null;
  let controller = null;
  let initialized = false;
  const disposers = [];

  function clone(value) {
    try { return window.structuredClone ? window.structuredClone(value) : JSON.parse(JSON.stringify(value)); }
    catch (_) { return value; }
  }
  function clean(value, max = 200) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max); }
  function readJson(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value && typeof value === 'object' ? Object.assign(clone(fallback), value) : clone(fallback);
    } catch (_) { return clone(fallback); }
  }
  function writeJson(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; } }
  function emit(name, detail = {}) { try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {} }
  function on(target, name, handler, options) { target.addEventListener(name, handler, options); disposers.push(() => target.removeEventListener(name, handler, options)); }
  function log(...args) { if (settings.debug) console.log('[EVEWeather]', ...args); }
  function currentCharacter() {
    try { if (typeof currentChatCharacter !== 'undefined' && currentChatCharacter) return currentChatCharacter; } catch (_) {}
    return window.currentChatCharacter || null;
  }
  function currentCharacterId() { return clean(currentCharacter()?.id, 120); }

  async function getNativeLocationSettings() {
    const id = currentCharacterId();
    if (!id || !window.db?.locationSettings?.get) return null;
    try { return await window.db.locationSettings.get(id); }
    catch (error) { log('读取原生地点设置失败，已忽略', error); return null; }
  }
  function inputValue(id) { return clean(document.getElementById(id)?.value, 160); }
  async function resolveLocations() {
    const native = await getNativeLocationSettings();
    return {
      user: {
        displayName: inputValue('user-city-name') || clean(native?.userCityName, 160),
        prototype: inputValue('user-city-prototype') || clean(native?.userCityPrototype, 160)
      },
      character: {
        displayName: inputValue('character-city-name') || clean(native?.characterCityName, 160),
        prototype: inputValue('character-city-prototype') || clean(native?.characterCityPrototype, 160)
      }
    };
  }

  async function fetchJson(url, signal) {
    const response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store', signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
  async function geocode(city, signal) {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`;
    const data = await fetchJson(url, signal);
    if (!data.results?.length) throw new Error(`找不到城市：${city}`);
    return data.results[0];
  }
  async function forecast(place, signal) {
    const params = new URLSearchParams({
      latitude: String(place.latitude), longitude: String(place.longitude),
      current: ['temperature_2m','apparent_temperature','relative_humidity_2m','precipitation','weather_code','cloud_cover','wind_speed_10m','is_day'].join(','),
      daily: ['sunrise','sunset','temperature_2m_max','temperature_2m_min','precipitation_probability_max'].join(','),
      timezone: 'auto', forecast_days: '1'
    });
    return fetchJson(`https://api.open-meteo.com/v1/forecast?${params}`, signal);
  }
  function localParts(iso) {
    const source = String(iso || '');
    if (!source.includes('T')) return { date: '', time: '' };
    const [date, time] = source.split('T');
    return { date, time: time.slice(0, 5) };
  }
  function buildPlace(label, input, place, data) {
    const current = data.current || {};
    const daily = data.daily || {};
    const [weather, weatherIcon] = CODES[Number(current.weather_code)] || ['未知天气','🌡️'];
    const parts = localParts(current.time);
    return {
      label,
      displayName: input.displayName || place.name || input.prototype,
      prototype: input.prototype || place.name,
      resolvedCity: place.name || input.prototype,
      region: place.admin1 || '', country: place.country || '',
      latitude: place.latitude, longitude: place.longitude,
      timezone: data.timezone || place.timezone || '',
      localDate: parts.date, localTime: parts.time,
      isNight: Number(current.is_day) === 0,
      weatherCode: Number(current.weather_code), weather, weatherIcon,
      temperature: current.temperature_2m,
      apparentTemperature: current.apparent_temperature,
      humidity: current.relative_humidity_2m,
      precipitation: current.precipitation,
      cloudCover: current.cloud_cover,
      windSpeed: current.wind_speed_10m,
      sunrise: localParts(daily.sunrise?.[0]).time,
      sunset: localParts(daily.sunset?.[0]).time,
      temperatureMax: daily.temperature_2m_max?.[0] ?? null,
      temperatureMin: daily.temperature_2m_min?.[0] ?? null,
      precipitationProbability: daily.precipitation_probability_max?.[0] ?? null
    };
  }

  function cacheStore() { return readJson(CACHE_KEY, { entries: {} }); }
  function cacheKey(city) { return clean(city, 160).toLowerCase(); }
  function getCached(city) { return cacheStore().entries?.[cacheKey(city)]?.data || null; }
  function setCached(city, data) {
    const cache = cacheStore(); cache.entries ||= {};
    cache.entries[cacheKey(city)] = { savedAt: Date.now(), data };
    writeJson(CACHE_KEY, cache);
  }
  async function resolveOne(label, input, signal) {
    const city = input.prototype || input.displayName;
    if (!city) return null;
    try {
      const place = await geocode(city, signal);
      const data = await forecast(place, signal);
      const result = buildPlace(label, input, place, data);
      setCached(city, result);
      return result;
    } catch (error) {
      const cached = getCached(city);
      if (cached) return Object.assign({}, cached, { cached: true, lastError: String(error.message || error) });
      throw error;
    }
  }

  function publish(next, error = null) {
    environment = next;
    const character = next?.character || null;
    // Flat compatibility fields for proactive.js and earlier add-ons.
    if (character) Object.assign(environment, {
      city: character.displayName, prototypeCity: character.prototype,
      resolvedCity: character.resolvedCity, timezone: character.timezone,
      localDate: character.localDate, localTime: character.localTime,
      weather: character.weather, weatherIcon: character.weatherIcon,
      temperature: character.temperature, apparentTemperature: character.apparentTemperature,
      humidity: character.humidity, precipitation: character.precipitation,
      windSpeed: character.windSpeed, sunrise: character.sunrise, sunset: character.sunset,
      isNight: character.isNight
    });
    window.EVE ||= {};
    window.EVE.environment = clone(environment);
    window.EVE.environmentPrompt = getPromptContext();
    emit('eve:environment-updated', { environment: getEnvironment(), error });
    emit('eve:weather-updated', { environment: getEnvironment(), error });
  }

  async function refresh(options = {}) {
    if (!settings.enabled) return getEnvironment();
    controller?.abort(); controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), Math.max(5000, Number(settings.requestTimeoutMs) || 15000));
    try {
      const locations = await resolveLocations();
      const [user, character] = await Promise.all([
        settings.includeUser ? resolveOne('使用者', locations.user, controller.signal) : null,
        settings.includeCharacter ? resolveOne('角色', locations.character, controller.signal) : null
      ]);
      const next = { version: VERSION, updatedAt: new Date().toISOString(), user, character };
      publish(next);
      log('更新成功', next);
      return getEnvironment();
    } catch (error) {
      console.warn('[EVEWeather] 更新失败', error);
      emit('eve:environment-error', { error });
      if (options.throwOnError) throw error;
      return getEnvironment();
    } finally {
      clearTimeout(timeout); controller = null; schedule();
    }
  }
  function schedule() {
    clearTimeout(timer); timer = null;
    if (!settings.enabled) return;
    timer = setTimeout(() => refresh(), Math.max(10, Number(settings.refreshMinutes) || 30) * 60000);
  }
  function configure(next = {}) {
    settings = Object.assign({}, DEFAULTS, settings, next || {});
    settings.enabled = Boolean(settings.enabled);
    settings.includeUser = Boolean(settings.includeUser);
    settings.includeCharacter = Boolean(settings.includeCharacter);
    settings.promptEnabled = Boolean(settings.promptEnabled);
    settings.refreshMinutes = Math.max(10, Math.min(360, Number(settings.refreshMinutes) || 30));
    writeJson(SETTINGS_KEY, settings); schedule();
    emit('eve:weather-settings-updated', { settings: getSettings() });
    if (settings.enabled && next.enabled !== false) setTimeout(() => refresh(), 0);
    return getSettings();
  }
  function formatPlace(place) {
    if (!place) return [];
    return [
      `${place.label}所在地：${place.displayName}${place.resolvedCity && place.resolvedCity !== place.displayName ? `（原型：${place.resolvedCity}）` : ''}`,
      `当地日期与时间：${place.localDate || '未知'} ${place.localTime || '未知'}（${place.timezone || '未知时区'}）`,
      `天气：${place.weatherIcon} ${place.weather}，${place.temperature}°C（体感 ${place.apparentTemperature}°C）`,
      `湿度：${place.humidity}%；风速：${place.windSpeed} km/h；降水：${place.precipitation} mm`,
      place.sunrise && place.sunset ? `日出：${place.sunrise}；日落：${place.sunset}` : ''
    ].filter(Boolean);
  }
  function getPromptContext() {
    if (!settings.enabled || !settings.promptEnabled || !environment) return '';
    const lines = ['【双方当前现实环境】'];
    if (settings.includeUser) lines.push(...formatPlace(environment.user));
    if (settings.includeCharacter) lines.push(...formatPlace(environment.character));
    if (lines.length === 1) return '';
    lines.push('仅在自然相关时参考这些信息，不要逐项朗读，也不要声称自己刚查询了天气。');
    return lines.join('\n');
  }
  function getEnvironment() { return clone(environment); }
  function getSettings() { return clone(settings); }
  function syncFromLocationForm() { return refresh({ force: true }); }
  function bind() {
    ['user-city-name','user-city-prototype','character-city-name','character-city-prototype'].forEach(id => {
      const el = document.getElementById(id);
      if (!el || el.dataset.eveWeatherBound) return;
      el.dataset.eveWeatherBound = '1';
      el.addEventListener('change', () => refresh());
    });
    const nativeToggle = document.getElementById('location-awareness-enabled');
    if (nativeToggle && !nativeToggle.dataset.eveWeatherBound) {
      nativeToggle.dataset.eveWeatherBound = '1';
      nativeToggle.addEventListener('change', () => configure({ enabled: nativeToggle.checked }));
    }
  }
  function init() {
    if (initialized) return Promise.resolve(getEnvironment());
    initialized = true; bind(); schedule();
    emit('eve:weather-ready', { version: VERSION, settings: getSettings() });
    if (settings.enabled) setTimeout(() => refresh(), 500);
    return Promise.resolve(getEnvironment());
  }
  function destroy() { clearTimeout(timer); controller?.abort(); disposers.splice(0).forEach(fn => { try { fn(); } catch (_) {} }); initialized = false; }

  window.EVEWeather = Object.freeze({ version: VERSION, init, destroy, refresh, configure, getSettings, getEnvironment, getPromptContext, syncFromLocationForm });
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init, { once: true }) : init();
})(window, document);
