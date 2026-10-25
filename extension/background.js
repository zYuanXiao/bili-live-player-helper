'use strict';
importScripts('core.js');
const Core = globalThis.BiliLiveHelperCore;
const sessions = new Map();
function isRoomSender(sender) {
  return sender.id === chrome.runtime.id && sender.tab && sender.frameId === 0 && Core.roomIdFromUrl(sender.url);
}
function isLiveFrame(sender) {
  try { return sender.id === chrome.runtime.id && sender.tab && new URL(sender.url).origin === 'https://live.bilibili.com'; }
  catch { return false; }
}
function withTabLock(tabId, callback) {
  const previous = sessions.get(tabId) || Promise.resolve();
  const next = previous.catch(() => {}).then(callback);
  sessions.set(tabId, next);
  next.finally(() => { if (sessions.get(tabId) === next) sessions.delete(tabId); }).catch(() => {});
  return next;
}
async function roomInfo(roomId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6500);
  try {
    const response = await fetch(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${encodeURIComponent(roomId)}`, {
      signal: controller.signal, credentials: 'omit', cache: 'no-store'
    });
    if (!response.ok) throw new Error(`房间状态接口 HTTP ${response.status}`);
    const body = await response.json();
    if (body.code !== 0 || !body.data) throw new Error(`房间状态查询失败（${body.code ?? '未知'}）`);
    const data = body.data;
    const realId = Core.normalizeId(data.room_id);
    if (!realId || ![0, 1, 2].includes(data.live_status)) throw new Error('房间状态响应格式异常');
    return { roomId: realId, liveStatus: data.live_status, hidden: data.is_hidden === true, locked: data.is_locked === true, encrypted: data.encrypted === true };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('房间状态查询超时，可尝试手动切换');
    throw error;
  } finally { clearTimeout(timer); }
}
async function handle(message, sender) {
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') throw new Error('无效请求');
  if (message.type === 'ROOM_INFO') {
    const id = isRoomSender(sender);
    if (!id || id !== Core.normalizeId(message.roomId)) throw new Error('直播间不匹配');
    return { ok: true, room: await roomInfo(id) };
  }
  if (message.type === 'LOAD_SESSION' || message.type === 'SAVE_SESSION') {
    const id = isRoomSender(sender);
    if (!id || id !== Core.normalizeId(message.roomId)) throw new Error('直播间不匹配');
    return withTabLock(sender.tab.id, async () => {
      const key = `room-tab-${sender.tab.id}`;
      const stored = (await chrome.storage.session.get(key))[key];
      const value = message.type === 'LOAD_SESSION' ? Core.normalizeSession(stored, id)
        : Core.normalizeSession({ roomId: id, mode: message.mode, suppressAuto: message.suppressAuto }, id);
      await chrome.storage.session.set({ [key]: value });
      return { ok: true, session: value };
    });
  }
  if (message.type === 'SET_SUSPENDED') {
    if (!isRoomSender(sender)) throw new Error('无效的播放器请求');
    chrome.tabs.sendMessage(sender.tab.id, { type: 'ORIGINAL_SUSPENDED', value: message.value === true }).catch(() => {});
    return { ok: true };
  }
  if (message.type === 'FRAME_READY' || message.type === 'FRAME_RESTRICTION' || message.type === 'FRAME_CLEAR') {
    if (!isLiveFrame(sender) || sender.frameId === 0 || !Core.roomIdFromUrl(sender.tab.url)) throw new Error('无效的子页面');
    const restriction = message.type === 'FRAME_RESTRICTION' ? Core.classifyRestriction(message.text) : null;
    if (message.type === 'FRAME_RESTRICTION' && !restriction) return { ok: false };
    chrome.tabs.sendMessage(sender.tab.id, { type: message.type, restriction }, { frameId: 0 }).catch(() => {});
    return { ok: true };
  }
  throw new Error('未知请求');
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  handle(message, sender).then(reply, error => reply({ ok: false, error: String(error.message || '请求失败').slice(0, 160) }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  withTabLock(tabId, () => chrome.storage.session.remove(`room-tab-${tabId}`)).catch(() => {});
});
chrome.runtime.onInstalled.addListener(async () => {
  const settings = await chrome.storage.local.get(Core.DEFAULT_SETTINGS);
  await chrome.storage.local.set({ autoSwitch: settings.autoSwitch !== false });
});
