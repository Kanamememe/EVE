/**
 * XiaoYi Daily Schedule Provider v1.2.0
 * 萧逸专属行程规则：R1五冠王、Glitter Bullet车队、LONGDAY任务与独立生活。
 */
(function (window) {
  'use strict';
  if (window.EVEXiaoYiSchedule?.version) return;

  const VERSION = '1.2.0';
  let registered = false;
  let retryTimer = null;

  function hash(text) {
    let value = 0;
    for (const character of String(text || '')) value = (value * 31 + character.charCodeAt(0)) >>> 0;
    return value;
  }
  function item(start, end, title, description, type = 'daily', extra = {}) {
    return Object.assign({ start, end, title, description, type, source: 'xiaoyi-provider' }, extra);
  }
  function toDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  function formatDate(date) {
    if (!date) return '';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function sourceDate(value) {
    const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : formatDate(toDate(value));
  }
  function sourceTime(value) {
    const match = String(value || '').match(/T(\d{2}:\d{2})/);
    if (match) return match[1];
    const date = toDate(value);
    return date ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` : '';
  }
  function addMinutes(time, minutes) {
    const match = String(time || '').match(/^(\d{1,2}):(\d{2})/);
    const current = match ? Number(match[1]) * 60 + Number(match[2]) : 0;
    const value = Math.max(0, Math.min(1439, current + minutes));
    return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  }
  function sessionTitle(name = '') {
    const text = String(name).toLowerCase();
    if (text.includes('practice')) return '自由练习';
    if (text.includes('qualifying')) return text.includes('sprint') ? '冲刺排位' : '排位赛';
    if (text.includes('sprint')) return '冲刺赛';
    if (text.includes('race')) return 'R1正赛';
    return name || '赛道活动';
  }
  function normalizedSessions(r1State) {
    const cache = r1State?.cache || {};
    if (Array.isArray(cache.sessions) && cache.sessions.length) {
      return cache.sessions.map(session => ({
        name: session.name || session.type || 'Session',
        dateStart: session.dateStart || session.date_start,
        dateEnd: session.dateEnd || session.date_end,
        country: session.country || '',
        location: session.location || ''
      }));
    }
    const race = cache.nextRace;
    return (race?.sessions || []).map(session => {
      const start = session.date ? `${session.date}T${session.time || '12:00:00Z'}` : null;
      const startDate = toDate(start);
      const duration = /race/i.test(session.name || '') ? 120 : /qualifying|sprint/i.test(session.name || '') ? 75 : 90;
      const endDate = startDate ? new Date(startDate.getTime() + duration * 60000) : null;
      return {
        name: session.name || 'Session',
        dateStart: startDate?.toISOString() || start,
        dateEnd: endDate?.toISOString() || null,
        country: race.country || '',
        location: race.locality || race.circuitName || ''
      };
    });
  }
  function raceSchedule(date, r1State) {
    const sessions = normalizedSessions(r1State)
      .filter(session => sourceDate(session.dateStart) === date)
      .sort((a, b) => Date.parse(a.dateStart) - Date.parse(b.dateStart));
    if (!sessions.length) return null;

    const output = [
      item('07:00', '07:35', '晨跑与反应训练', '在酒店或车队安排的训练区进行轻量晨练', 'training')
    ];
    for (const session of sessions) {
      const startDate = toDate(session.dateStart);
      const endDate = toDate(session.dateEnd) || (startDate ? new Date(startDate.getTime() + 90 * 60000) : null);
      const start = sourceTime(session.dateStart) || '14:00';
      const end = sourceTime(session.dateEnd) || (endDate ? sourceTime(endDate.toISOString()) : '') || addMinutes(start, 90);
      const title = sessionTitle(session.name);
      const meetingStart = addMinutes(start, -80);
      const focusStart = addMinutes(start, -8);

      output.push(item(
        meetingStart,
        focusStart,
        '车队会议与赛前准备',
        `确认车辆设定、赛道状态和本节目标，为${title}做准备`,
        'racing'
      ));
      output.push(item(
        focusStart,
        start,
        '独处五分钟',
        '进入比赛前的专注状态，听音乐，也可能听萧小五发来的语音',
        'racing',
        { private: true }
      ));
      output.push(item(
        start,
        end,
        title,
        `${session.country || ''}${session.location ? `・${session.location}` : ''}比赛周末赛道活动`,
        'racing',
        { locked: true }
      ));
      output.push(item(
        end,
        addMinutes(end, 65),
        '称重、采访与数据复盘',
        `完成${title}后的必要流程，与工程师复盘数据`,
        'racing'
      ));
    }
    const lastEnd = output.reduce((max, entry) => entry.end > max ? entry.end : max, '18:30');
    const dinnerStart = lastEnd > '20:00' ? addMinutes(lastEnd, 20) : '20:30';
    output.push(item(dinnerStart, addMinutes(dinnerStart, 50), '晚餐与恢复', '补充体力，完成拉伸和恢复', 'meal'));
    output.push(item(addMinutes(dinnerStart, 70), addMinutes(dinnerStart, 140), '个人时间', '整理情绪、听音乐，也可能和萧小五联系', 'rest'));
    return output;
  }

  function fallback({ date, r1State }) {
    const race = raceSchedule(date, r1State);
    if (race) return race;

    const seed = hash(date);
    const training = seed % 2 === 0 ? '模拟器训练' : '体能与反应训练';
    const afternoon = seed % 3 === 0 ? '赛车调校会议' : '长距离数据复盘';
    const hasTask = seed % 4 === 0;
    const items = [
      item('07:00', '07:45', '戴耳机晨跑', '起床后先跑步，整理状态', 'training'),
      item('08:10', '08:50', '早餐', '吃早餐，也顺手照看萧火龙和萧小一', 'meal'),
      item('09:30', '11:40', training, training === '模拟器训练' ? '进行赛道模拟和反应训练' : '完成体能、颈部与反应项目', 'training'),
      item('12:10', '13:10', '和车队吃午饭', '与车队成员吃饭，短暂放松', 'meal'),
      item('14:00', '16:40', afternoon, afternoon === '赛车调校会议' ? '与工程师确认设定和测试方向' : '检查遥测和近期训练数据', 'racing'),
      hasTask
        ? item('17:30', '19:20', 'LONGDAY任务', '处理一项赏金猎人工会任务，具体内容保持私密', 'task', { private: true })
        : item('17:30', '18:40', '机车与个人事务', '保养机车，或处理当天剩下的事情', 'daily'),
      item('19:30', '20:30', '晚餐', '回家做饭或在外面简单吃点东西', 'meal'),
      item('20:40', '21:20', '照顾宠物', '检查萧火龙、萧小一和其他小家伙', 'daily'),
      item('21:30', '23:10', '自己的时间', '听音乐、弹吉他、看比赛资料，也会自然联系萧小五', 'rest'),
      item('23:20', '23:55', '洗澡与准备休息', '用柠檬薄荷味沐浴露洗澡，整理第二天安排', 'rest')
    ];

    const phase = r1State?.phase?.phase;
    if (['travel-prep', 'race-week'].includes(phase)) {
      items[2] = item('09:30', '11:30', '赛前模拟器训练', '针对下一站赛道进行模拟器训练', 'racing');
      items[4] = item('14:00', '16:30', '车队赛前会议', '确认下一站的调校方向、天气和比赛计划', 'racing');
    }
    if (phase === 'post-race') {
      items[2] = item('09:30', '11:30', '赛后恢复训练', '完成轻量恢复和反应训练', 'training');
      items[4] = item('14:00', '16:30', '赛后数据复盘', '和工程师复盘比赛数据与下一步调整', 'racing');
    }
    return items;
  }

  const provider = {
    id: 'xiaoyi',
    match: meta => meta.roleId === 'xiaoyi' || /萧逸|osborn/i.test(meta.chat?.name || ''),
    getConstraints: ({ r1State }) => [
      '萧逸是Glitter Bullet车队现役R1五冠王，同时是LONGDAY赏金猎人',
      '日程必须保留训练、车队工作、恢复和独立生活，不要让他全天围着夕月转',
      '重要比赛前保留独处五分钟的习惯；比赛周末优先服从R1 Session时间',
      'LONGDAY任务可以出现，但不要凭空生成具体伤亡、事故或任务结果',
      '他会照顾萧火龙、萧小一等宠物，也会留出音乐、机车、朋友或做饭时间',
      r1State?.cache?.nextRace
        ? `下一站R1赛历原型：${r1State.cache.nextRace.country || ''} ${r1State.cache.nextRace.circuitName || r1State.cache.nextRace.raceName || ''}`
        : ''
    ].filter(Boolean).join('\n'),
    generateFallback: fallback
  };

  function register() {
    if (registered || !window.EVEDailySchedule?.registerProvider) return false;
    window.EVEDailySchedule.registerProvider('xiaoyi', provider);
    registered = true;
    window.dispatchEvent(new CustomEvent('eve:xiaoyi-schedule-ready', { detail: { version: VERSION, registered } }));
    return true;
  }
  function init() {
    if (!register()) {
      retryTimer = setInterval(() => {
        if (register()) { clearInterval(retryTimer); retryTimer = null; }
      }, 500);
      setTimeout(() => {
        if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
      }, 30000);
    }
    return diagnostics();
  }
  function diagnostics() {
    return { version: VERSION, registered, r1: Boolean(window.EVEXiaoYiR1), schedule: Boolean(window.EVEDailySchedule) };
  }

  window.EVEXiaoYiSchedule = Object.freeze({ version: VERSION, init, diagnostics, provider });
  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', init, { once: true })
    : init();
})(window);
