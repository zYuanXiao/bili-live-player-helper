(function (root) {
  'use strict';
  const PLAYER_ORIGIN = 'https://www.bilibili.com';
  const PLAYER_PATH = '/blackboard/live/live-activity-player.html';
  const DEFAULT_SETTINGS = Object.freeze({ autoSwitch: true });
  function normalizeId(value) {
    const id = String(value ?? '').trim();
    if (!/^\d{1,20}$/.test(id)) return null;
    return id.replace(/^0+/, '') || null;
  }
  function roomIdFromUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'live.bilibili.com') return null;
      const match = /^\/(?:blanc\/)?(\d{1,20})\/?$/.exec(url.pathname);
      return match ? normalizeId(match[1]) : null;
    } catch { return null; }
  }
  function activityRoomId(value) {
    try {
      const url = new URL(value);
      return url.origin === PLAYER_ORIGIN && url.pathname === PLAYER_PATH
        ? normalizeId(url.searchParams.get('cid')) : null;
    } catch { return null; }
  }
  function playerUrl(roomId) {
    const id = normalizeId(roomId);
    if (!id) throw new Error('无效的直播间号');
    const url = new URL(PLAYER_PATH, PLAYER_ORIGIN);
    const params = { cid: id, quality: '1', enableCtrlUI: '1', reload: '1', danmaku: '1', fullscreen: '1', entrance: '0', sendpanel: '0' };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.href;
  }
  function classifyRestriction(value) {
    const text = String(value ?? '').replace(/\s+/g, '').slice(0, 800);
    if (!text || /未开播|已下播|直播已结束|主播不在|休息中/.test(text)) return null;
    if (/直播间(?:暂时)?(?:无法|不能|不可)(?:显示|展示|访问)/.test(text)) return 'unavailable';
    if (/(?:您|你)?所在(?:的)?地区(?:暂时)?(?:无法|不能|不可|不支持)观看|仅(?:限|支持)中国大陆(?:地区)?观看|根据版权方要求.*地区.*观看/i.test(text)) return 'region';
    if (/notavailableinyourcountry|notavailableinyourregion|copyrightrestrictions/i.test(text)) return 'region';
    return null;
  }
  function canAutoSwitch({ enabled, suppressed, mode, restriction, room }) {
    return Boolean(enabled && !suppressed && mode === 'original' && restriction && room &&
      room.liveStatus === 1 && !room.hidden && !room.locked && !room.encrypted);
  }
  function normalizeSession(value, roomId) {
    const id = normalizeId(roomId);
    if (!value || value.roomId !== id) return { roomId: id, mode: 'original', suppressAuto: false };
    return { roomId: id, mode: value.mode === 'fallback' ? 'fallback' : 'original', suppressAuto: value.suppressAuto === true };
  }
  function mediaStatus(room) {
    if (room.locked || room.hidden) return '直播间当前被隐藏或锁定';
    if (room.encrypted) return '直播间需要密码验证';
    if (room.liveStatus === 0) return '主播已下播，未自动切换';
    if (room.liveStatus === 2) return '当前是轮播，未自动切换';
    return '';
  }
  function normalizePlaybackDiagnostics(value) {
    const input = value || {};
    const number = (key, max) => Number.isFinite(input[key]) && input[key] >= 0 && input[key] <= max ? input[key] : null;
    return {
      reason: ['playing', 'paused', 'buffering', 'decode'].includes(input.reason) ? input.reason : 'unknown',
      bufferSeconds: number('bufferSeconds', 3600), readyState: number('readyState', 4),
      droppedFrames: number('droppedFrames', Number.MAX_SAFE_INTEGER), totalFrames: number('totalFrames', Number.MAX_SAFE_INTEGER),
      dropPercent: number('dropPercent', 100)
    };
  }
  function formatPlaybackDiagnostics(value) {
    if (!value) return '尚未取得视频数据。请先开始播放，再重新打开插件查看。';
    const data = normalizePlaybackDiagnostics(value);
    const names = { playing: '播放中', paused: '已暂停', buffering: '正在缓冲', decode: '画面掉帧较多', unknown: '待确认' };
    const known = value => value === null ? '暂不可用' : String(value);
    return [
      `播放状态：${names[data.reason]}`,
      `前方缓冲：${data.bufferSeconds === null ? '暂不可用' : data.bufferSeconds.toFixed(1) + ' 秒'}`,
      `视频就绪级别：${known(data.readyState)} / 4`,
      `累计掉帧 / 总帧：${known(data.droppedFrames)} / ${known(data.totalFrames)}`,
      `最近掉帧比例：${data.dropPercent === null ? '采样中' : data.dropPercent.toFixed(1) + '%'}`,
      data.reason === 'buffering' ? '建议：尝试视频菜单中的其他线路；有低清档位时可降低画质。' :
        data.reason === 'decode' ? '建议：降低可用画质，并检查浏览器或其他程序的处理负载。' :
          '若仍卡顿，请在卡顿后重新打开插件查看这份诊断。'
    ].join('\n');
  }
  const api = Object.freeze({ PLAYER_ORIGIN, PLAYER_PATH, DEFAULT_SETTINGS, normalizeId, roomIdFromUrl, activityRoomId, playerUrl, classifyRestriction, canAutoSwitch, normalizeSession, mediaStatus, normalizePlaybackDiagnostics, formatPlaybackDiagnostics });
  root.BiliLiveHelperCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
