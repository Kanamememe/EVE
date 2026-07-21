/** EVE Chat Health Check v0.1.0 */
(function (window, document) {
    'use strict';
    if (window.EVEHealth) return;

    const VERSION = '0.1.0';

    function test(name, pass, detail, severity) {
        return { name, pass: Boolean(pass), detail: detail || '', severity: severity || 'error' };
    }

    function run() {
        const adapter = window.EVEAdapter;
        const diagnostics = adapter && adapter.getDiagnostics ? adapter.getDiagnostics() : null;
        const results = [
            test('adapter-loaded', Boolean(adapter), 'EVEAdapter 必須存在'),
            test('fetch-hook', Boolean(diagnostics && diagnostics.fetchHookInstalled), 'Gemini Prompt 注入需要 fetch hook'),
            test('chat-input', Boolean(document.getElementById('api-chat-input')), '#api-chat-input'),
            test('smart-reply', Boolean(diagnostics && (diagnostics.smartReplyFunction || diagnostics.smartReplyButton)), '主動聊天需要 triggerSmartReply', 'warning'),
            test('weather-loaded', Boolean(window.EVEWeather), 'EVEWeather'),
            test('proactive-loaded', Boolean(window.EVEProactive), 'EVEProactive'),
            test('memory-loaded', Boolean(window.EVEMemory), 'EVEMemory'),
            test('timeline-loaded', Boolean(window.EVETimeline), 'EVETimeline'),
            test('relationship-loaded', Boolean(window.EVERelationship), 'EVERelationship'),
            test('context-providers', Boolean(diagnostics && diagnostics.contextProviders.length >= 2), diagnostics ? diagnostics.contextProviders.join(', ') : ''),
            test('gemini-endpoint', Boolean(diagnostics && diagnostics.geminiEndpointPresent), '頁面內需有 Gemini endpoint', 'warning')
        ];
        const errors = results.filter(item => !item.pass && item.severity === 'error');
        const warnings = results.filter(item => !item.pass && item.severity === 'warning');
        return {
            version: VERSION,
            ok: errors.length === 0,
            errors: errors.length,
            warnings: warnings.length,
            results,
            diagnostics,
            timestamp: new Date().toISOString()
        };
    }

    function print() {
        const report = run();
        const rows = report.results.map(item => ({
            status: item.pass ? 'PASS' : item.severity === 'warning' ? 'WARN' : 'FAIL',
            test: item.name,
            detail: item.detail
        }));
        if (console.table) console.table(rows);
        else console.log(rows);
        console.log('[EVEHealth]', report.ok ? '核心檢查通過' : '發現核心錯誤', report);
        return report;
    }

    window.EVEHealth = Object.freeze({ version: VERSION, run, print });
    window.addEventListener('eve:relationship-ready', () => {
        window.setTimeout(() => window.dispatchEvent(new CustomEvent('eve:health-ready', { detail: run() })), 0);
    }, { once: true });
})(window, document);
