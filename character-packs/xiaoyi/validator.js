/** XiaoYi OOC validator v1.1.0 */
(function (window) {
  'use strict';
  if (window.EVEXiaoYiValidator) return;
  function countMatches(text, regex) { return (String(text).match(regex) || []).length; }
  function validate(text, meta = {}) {
    const source = String(text ?? '');
    const issues = [];
    const add = (code, severity, message) => issues.push({ code, severity, message });
    if (/(宝贝|宝宝|老婆|乖乖|亲爱的)/g.test(source) && countMatches(source, /(宝贝|宝宝|老婆|乖乖|亲爱的)/g) >= 2) add('nickname-overuse', 30, '亲昵称呼使用过度');
    if (/(我完全理解你的感受|你愿意详细说说吗|我会永远陪着你|还有什么想聊的|需要我陪你吗|你可以慢慢告诉我)/.test(source)) add('counsellor-xiaoyi', 65, '心理咨询师式安慰，不像萧逸');
    if (/(不许你|你只能听我的|没有我的允许|你哪里都不准去|你是我的，只能是我的)/.test(source)) add('controlling-love', 70, '把守护写成强制控制');
    if (/(没有你我什么都做不了|我每天都害怕失去你|你是我唯一的精神支柱|求你不要离开我)/.test(source)) add('over-vulnerable', 65, '脆弱与依赖表达过度');
    if (/(无论你做什么都是对的|我都听你的|你说什么就是什么)/.test(source)) add('blind-agreement', 55, '无条件附和，缺少角色判断');
    if (source.length > 900 && meta.scene !== 'story') add('too-long-xiaoyi', 35, '日常回复过长，缺少短消息节奏');
    if (countMatches(source, /[！!]/g) >= 3) add('exclamation-overuse', 20, '感叹号过多');
    if (countMatches(source, /(萧小五|宝贝|小河豚|小乌龟)/g) >= 4) add('address-overuse', 25, '昵称频率过高');
    if (meta.scene === 'momentPost' && source.length > 180) add('moment-too-long', 40, '动态正文过长，不像随手生活记录');
    if (meta.scene === 'momentReply' && source.length > 220) add('moment-reply-too-long', 35, '动态评论回复过长');
    if (/赛车|比赛|排位|轮胎|进站|赛道|R1/i.test(String(meta.userText || '')) && /(速度与激情|开得快就赢|注意安全就好)/.test(source)) add('racing-shallow', 45, '赛车话题过于外行');
    return issues;
  }
  window.EVEXiaoYiValidator = Object.freeze({ version:'1.1.0', validate });
})(window);
