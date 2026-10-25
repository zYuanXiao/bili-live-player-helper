(function () {
  'use strict';
  const Core = globalThis.BiliLiveHelperCore;
  const element = id => document.getElementById(id);
  element('version').textContent = chrome.runtime.getManifest().version;
  const ui = { mode: element('mode'), room: element('room'), note: element('note'), dot: element('dot'), auto: element('auto'), switch: element('switch'), reload: element('reload'), independent: element('independent'), refresh: element('refresh'), resolution: element('resolution'), suppressed: element('suppressed') };
  let tab = null;
  let state = null;
  let standalone = false;
  let busy = false;
  let errorNote = '';
  function render() {
    const roomId = state?.roomId || Core.roomIdFromUrl(tab?.url) || Core.activityRoomId(tab?.url);
    const fallback = state?.mode === 'fallback';
    ui.room.textContent = roomId ? `房间 ${roomId}` : '先打开一个直播间';
    ui.mode.textContent = standalone ? '官方独立播放器' : fallback ? '使用备用播放器' : '使用原播放器';
    ui.dot.className = `dot${state?.status === 'playing' ? ' active' : state?.status === 'error' || state?.status === 'timeout' ? ' error' : ''}`;
    ui.switch.textContent = standalone ? '返回原直播间' : fallback ? '恢复原播放器' : '切换到备用播放器';
    ui.switch.disabled = busy || (!standalone && !state?.roomId);
    ui.reload.disabled = busy || (!standalone && !fallback);
    ui.independent.disabled = busy || !roomId;
    ui.suppressed.textContent = state?.suppressAuto ? '本房间自动切换已暂停' : '';
    const size = state?.resolution;
    ui.resolution.hidden = !size;
    if (size) ui.resolution.textContent = `实际画面 ${size.width} × ${size.height}`;
    element('diagnostics-text').textContent = Core.formatPlaybackDiagnostics(state?.diagnostics);
    if (errorNote) ui.note.textContent = errorNote;
    else if (state?.note) ui.note.textContent = state.note;
  }
  async function load() {
    const settings = await chrome.storage.local.get(Core.DEFAULT_SETTINGS);
    ui.auto.checked = settings.autoSwitch !== false;
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    standalone = Boolean(Core.activityRoomId(tab?.url));
    if (standalone) { ui.note.textContent = '正在独立入口观看；画质和线路在视频右下角切换'; render(); return; }
    if (!Core.roomIdFromUrl(tab?.url)) { ui.note.textContent = '在B站打开直播间后，点击这里即可手动切换播放器'; render(); return; }
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATE' }, { frameId: 0 });
      if (!response?.ok || !response.state?.roomId) throw new Error('页面尚未连接');
      state = response.state;
      ui.refresh.hidden = true;
    } catch {
      ui.note.textContent = '当前页面尚未连接插件。安装或更新后，请先刷新这个直播间一次。';
      ui.refresh.hidden = false;
    }
    render();
  }
  async function action(action) {
    if (!tab || busy) return;
    busy = true;
    render();
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'APPLY_ACTION', action }, { frameId: 0 });
      if (!response?.ok) throw new Error(response?.error || '操作失败，请刷新直播间后重试');
      state = response.state;
      errorNote = '';
      ui.note.textContent = state.note;
    } catch (error) { errorNote = error.message || '无法连接页面，请刷新直播间后重试'; }
    finally { busy = false; render(); }
  }
  ui.auto.addEventListener('change', async () => {
    try { await chrome.storage.local.set({ autoSwitch: ui.auto.checked }); if (state) { state.autoSwitch = ui.auto.checked; if (ui.auto.checked) state.suppressAuto = false; render(); } }
    catch { ui.note.textContent = '设置保存失败，请重新打开插件重试'; }
  });
  ui.switch.addEventListener('click', async () => {
    if (standalone) {
      const id = Core.activityRoomId(tab.url);
      if (id) await chrome.tabs.update(tab.id, { url: `https://live.bilibili.com/${id}` });
      window.close();
      return;
    }
    action(state?.mode === 'fallback' ? 'original' : 'fallback');
  });
  ui.reload.addEventListener('click', async () => {
    if (standalone) { await chrome.tabs.reload(tab.id); window.close(); }
    else action('reload');
  });
  ui.independent.addEventListener('click', async () => {
    const id = state?.canonicalId || state?.roomId || Core.roomIdFromUrl(tab?.url) || Core.activityRoomId(tab?.url);
    if (id) await chrome.tabs.create({ url: Core.playerUrl(id) });
  });
  ui.refresh.addEventListener('click', async () => { if (tab) await chrome.tabs.reload(tab.id); window.close(); });
  load().catch(() => { ui.note.textContent = '无法读取当前页面，请关闭后重新打开插件'; });
})();
