/**
 * EVE Chat - 即時環境模組
 * 檔名：weather.js
 *
 * 功能：
 * 1. 讀取角色的「原型城市」或自訂城市
 * 2. 使用 Open-Meteo 取得真實天氣、時區、日出與日落
 * 3. 每 30 分鐘自動更新
 * 4. 將環境資料提供給聊天、動態與主動訊息模組
 *
 * 使用方式：
 * 在 index.html 的 </body> 前加入：
 * <script src="js/weather.js"></script>
 */

(function (window, document) {
    'use strict';

    const STORAGE_KEY = 'eve_weather_settings_v1';
    const CACHE_KEY = 'eve_weather_cache_v1';
    const DEFAULT_REFRESH_MINUTES = 30;

    const WEATHER_CODES = {
        0:  { text: '晴朗', icon: '☀️' },
        1:  { text: '大致晴朗', icon: '🌤️' },
        2:  { text: '局部多雲', icon: '⛅' },
        3:  { text: '陰天', icon: '☁️' },
        45: { text: '有霧', icon: '🌫️' },
        48: { text: '霧淞', icon: '🌫️' },
        51: { text: '毛毛雨', icon: '🌦️' },
        53: { text: '毛毛雨', icon: '🌦️' },
        55: { text: '較強毛毛雨', icon: '🌧️' },
        56: { text: '凍毛毛雨', icon: '🌧️' },
        57: { text: '較強凍毛毛雨', icon: '🌧️' },
        61: { text: '小雨', icon: '🌧️' },
        63: { text: '中雨', icon: '🌧️' },
        65: { text: '大雨', icon: '🌧️' },
        66: { text: '凍雨', icon: '🌧️' },
        67: { text: '強凍雨', icon: '🌧️' },
        71: { text: '小雪', icon: '🌨️' },
        73: { text: '中雪', icon: '🌨️' },
        75: { text: '大雪', icon: '❄️' },
        77: { text: '雪粒', icon: '❄️' },
        80: { text: '陣雨', icon: '🌦️' },
        81: { text: '中等陣雨', icon: '🌧️' },
        82: { text: '強陣雨', icon: '⛈️' },
        85: { text: '陣雪', icon: '🌨️' },
        86: { text: '強陣雪', icon: '❄️' },
        95: { text: '雷雨', icon: '⛈️' },
        96: { text: '雷雨伴冰雹', icon: '⛈️' },
        99: { text: '強雷雨伴冰雹', icon: '⛈️' }
    };

    const DEFAULT_SETTINGS = {
        enabled: true,
        city: '東京',
        prototypeCity: 'Tokyo',
        refreshMinutes: DEFAULT_REFRESH_MINUTES,
        includeInChat: true,
        includeInMoments: true
    };

    let refreshTimer = null;
    let currentEnvironment = null;

    function safeParse(value, fallback) {
        try {
            return value ? JSON.parse(value) : fallback;
        } catch (error) {
            console.warn('[EVEWeather] 無法解析儲存資料：', error);
            return fallback;
        }
    }

    function loadSettings() {
        const saved = safeParse(localStorage.getItem(STORAGE_KEY), {});
        const settings = Object.assign({}, DEFAULT_SETTINGS, saved);

        // 優先沿用 EVE Chat 現有的角色地點輸入欄位。
        const cityInput = document.getElementById('character-city-name');
        const prototypeInput = document.getElementById('character-city-prototype');

        if (cityInput && cityInput.value.trim()) {
            settings.city = cityInput.value.trim();
        }

        if (prototypeInput && prototypeInput.value.trim()) {
            settings.prototypeCity = prototypeInput.value.trim();
        }

        return settings;
    }

    function saveSettings(partialSettings) {
        const next = Object.assign({}, loadSettings(), partialSettings || {});
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        return next;
    }

    function loadCache() {
        return safeParse(localStorage.getItem(CACHE_KEY), null);
    }

    function saveCache(environment) {
        localStorage.setItem(CACHE_KEY, JSON.stringify(environment));
    }

    async function fetchJson(url) {
        const response = await fetch(url, {
            method: 'GET',
            headers: { Accept: 'application/json' }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        return response.json();
    }

    async function geocodeCity(cityName) {
        const query = encodeURIComponent(cityName);
        const url =
            `https://geocoding-api.open-meteo.com/v1/search` +
            `?name=${query}&count=1&language=zh&format=json`;

        const data = await fetchJson(url);

        if (!data.results || !data.results.length) {
            throw new Error(`找不到城市：${cityName}`);
        }

        const place = data.results[0];

        return {
            latitude: place.latitude,
            longitude: place.longitude,
            timezone: place.timezone || 'auto',
            resolvedName: place.name || cityName,
            country: place.country || '',
            admin1: place.admin1 || ''
        };
    }

    function weatherInfo(code) {
        return WEATHER_CODES[Number(code)] || {
            text: '未知天氣',
            icon: '🌡️'
        };
    }

    function toDateInTimezone(isoString) {
        // Open-Meteo 在 timezone=auto 時會回傳當地時間字串；
        // 保留字串供顯示，另外建立 Date 僅用於比較。
        return new Date(isoString);
    }

    function isNightTime(currentTime, sunrise, sunset) {
        if (!currentTime || !sunrise || !sunset) {
            const hour = new Date().getHours();
            return hour < 6 || hour >= 18;
        }

        const now = toDateInTimezone(currentTime);
        const rise = toDateInTimezone(sunrise);
        const set = toDateInTimezone(sunset);

        return now < rise || now >= set;
    }

    function formatLocalTime(isoString) {
        if (!isoString || !isoString.includes('T')) return '';
        return isoString.split('T')[1].slice(0, 5);
    }

    function formatLocalDate(isoString) {
        if (!isoString || !isoString.includes('T')) return '';
        return isoString.split('T')[0];
    }

    async function fetchWeather(place, settings) {
        const params = new URLSearchParams({
            latitude: String(place.latitude),
            longitude: String(place.longitude),
            current: [
                'temperature_2m',
                'apparent_temperature',
                'relative_humidity_2m',
                'precipitation',
                'weather_code',
                'cloud_cover',
                'wind_speed_10m',
                'is_day'
            ].join(','),
            daily: [
                'sunrise',
                'sunset',
                'temperature_2m_max',
                'temperature_2m_min',
                'precipitation_probability_max'
            ].join(','),
            timezone: 'auto',
            forecast_days: '1'
        });

        const data = await fetchJson(
            `https://api.open-meteo.com/v1/forecast?${params.toString()}`
        );

        if (!data.current) {
            throw new Error('天氣資料格式不完整');
        }

        const info = weatherInfo(data.current.weather_code);
        const sunrise = data.daily && data.daily.sunrise ? data.daily.sunrise[0] : '';
        const sunset = data.daily && data.daily.sunset ? data.daily.sunset[0] : '';
        const currentTime = data.current.time || new Date().toISOString();

        return {
            source: 'open-meteo',
            updatedAt: new Date().toISOString(),

            city: settings.city || place.resolvedName,
            prototypeCity: settings.prototypeCity,
            resolvedCity: place.resolvedName,
            country: place.country,
            region: place.admin1,

            latitude: place.latitude,
            longitude: place.longitude,
            timezone: data.timezone || place.timezone,

            localDate: formatLocalDate(currentTime),
            localTime: formatLocalTime(currentTime),
            currentTime,

            weatherCode: Number(data.current.weather_code),
            weather: info.text,
            weatherIcon: info.icon,

            temperature: data.current.temperature_2m,
            apparentTemperature: data.current.apparent_temperature,
            humidity: data.current.relative_humidity_2m,
            precipitation: data.current.precipitation,
            cloudCover: data.current.cloud_cover,
            windSpeed: data.current.wind_speed_10m,

            sunrise: formatLocalTime(sunrise),
            sunset: formatLocalTime(sunset),
            sunriseRaw: sunrise,
            sunsetRaw: sunset,

            temperatureMax:
                data.daily && data.daily.temperature_2m_max
                    ? data.daily.temperature_2m_max[0]
                    : null,
            temperatureMin:
                data.daily && data.daily.temperature_2m_min
                    ? data.daily.temperature_2m_min[0]
                    : null,
            precipitationProbability:
                data.daily && data.daily.precipitation_probability_max
                    ? data.daily.precipitation_probability_max[0]
                    : null,

            isNight:
                typeof data.current.is_day === 'number'
                    ? data.current.is_day === 0
                    : isNightTime(currentTime, sunrise, sunset)
        };
    }

    function buildPromptContext(environment) {
        if (!environment) return '';

        const dayState = environment.isNight ? '夜晚' : '白天';

        return [
            '【角色目前的即時環境】',
            `角色所在地：${environment.city}`,
            `參考真實城市：${environment.resolvedCity}`,
            `當地日期：${environment.localDate}`,
            `當地時間：${environment.localTime}`,
            `時段：${dayState}`,
            `天氣：${environment.weatherIcon} ${environment.weather}`,
            `氣溫：${environment.temperature}°C`,
            `體感溫度：${environment.apparentTemperature}°C`,
            `濕度：${environment.humidity}%`,
            `風速：${environment.windSpeed} km/h`,
            `日出：${environment.sunrise}`,
            `日落：${environment.sunset}`,
            '請自然參考以上資訊，不要每次都逐項複述，也不要宣稱自己正在查詢天氣。'
        ].join('\n');
    }

    function announceUpdate(environment) {
        currentEnvironment = environment;

        // 提供簡單、穩定的全域讀取位置。
        window.EVE = window.EVE || {};
        window.EVE.environment = environment;
        window.EVE.environmentPrompt = buildPromptContext(environment);

        // 其他模組可監聽此事件。
        window.dispatchEvent(
            new CustomEvent('eve:environment-updated', {
                detail: environment
            })
        );
    }

    async function refresh(options) {
        const opts = options || {};
        const settings = loadSettings();

        if (!settings.enabled) {
            return null;
        }

        try {
            const searchCity =
                settings.prototypeCity ||
                settings.city ||
                DEFAULT_SETTINGS.prototypeCity;

            const place = await geocodeCity(searchCity);
            const environment = await fetchWeather(place, settings);

            saveCache(environment);
            announceUpdate(environment);

            console.info(
                `[EVEWeather] ${environment.city} ${environment.localTime} ` +
                `${environment.weatherIcon} ${environment.weather} ` +
                `${environment.temperature}°C`
            );

            return environment;
        } catch (error) {
            console.error('[EVEWeather] 更新失敗：', error);

            const cached = loadCache();
            if (cached) {
                cached.isCached = true;
                cached.lastError = error.message;
                announceUpdate(cached);
                return cached;
            }

            if (!opts.silent && typeof window.showToast === 'function') {
                window.showToast(`天氣更新失敗：${error.message}`, 'error');
            }

            throw error;
        }
    }

    function stopAutoRefresh() {
        if (refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = null;
        }
    }

    function startAutoRefresh() {
        stopAutoRefresh();

        const settings = loadSettings();
        const minutes = Math.max(
            10,
            Number(settings.refreshMinutes) || DEFAULT_REFRESH_MINUTES
        );

        refreshTimer = setInterval(function () {
            refresh({ silent: true }).catch(function () {});
        }, minutes * 60 * 1000);
    }

    async function init() {
        const cached = loadCache();
        if (cached) {
            announceUpdate(cached);
        }

        try {
            await refresh({ silent: true });
        } catch (error) {
            // 已在 refresh 中記錄；不阻止 EVE Chat 啟動。
        }

        startAutoRefresh();
    }

    function getEnvironment() {
        return currentEnvironment || loadCache();
    }

    function getPromptContext() {
        return buildPromptContext(getEnvironment());
    }

    function configure(partialSettings) {
        const settings = saveSettings(partialSettings);
        startAutoRefresh();
        return refresh({ silent: false }).then(function () {
            return settings;
        });
    }

    window.EVEWeather = {
        init,
        refresh,
        configure,
        getSettings: loadSettings,
        getEnvironment,
        getPromptContext,
        startAutoRefresh,
        stopAutoRefresh
    };

    // 相容 EVE Chat 現有的地點設定儲存按鈕：
    // 儲存後呼叫 EVEWeather.syncFromLocationForm() 即可。
    window.EVEWeather.syncFromLocationForm = function () {
        const cityInput = document.getElementById('character-city-name');
        const prototypeInput = document.getElementById('character-city-prototype');

        return configure({
            city:
                cityInput && cityInput.value.trim()
                    ? cityInput.value.trim()
                    : loadSettings().city,
            prototypeCity:
                prototypeInput && prototypeInput.value.trim()
                    ? prototypeInput.value.trim()
                    : loadSettings().prototypeCity
        });
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})(window, document);
