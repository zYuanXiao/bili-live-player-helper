(function () {
  'use strict';
  const Core = globalThis.BiliLiveHelperCore;
  if (!Core || !globalThis.chrome?.runtime?.id) return;
  const isTop = window === window.top;
  const isActivity = Boolean(Core.activityRoomId(location.href));
  const send = async message => {
    try { return await chrome.runtime.sendMessage(message); }
    catch { return { ok: false, error: '插件连接已更新，请刷新页面' }; }
  };

  function isVisible(element) {
    if (!element?.isConnected || !element.getClientRects().length || element.closest('[hidden],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    for (let parent = element; parent; parent = parent.parentElement) if (getComputedStyle(parent).opacity === '0') return false;
    return true;
  }
  function restrictionInDocument({ knownOnly = false, scope = null } = {}) {
    if (!document.body) return null;
    const excluded = '[data-blh-dock], [data-blh-player], [class*="chat"], [id*="chat"], [class*="danmaku"], [class*="danmu"], [class*="announcement"], [class*="room-introduction"]';
    // Bilibili mounts this modal beside the video, not inside its container.
    // Inspect it first so long chat histories cannot exhaust the text scan.
    for (const layer of document.querySelectorAll('#limit-boomman,.limit-boomman-box')) {
      const tip = layer.querySelector('.tip-content') || layer;
      if (layer.closest(excluded) || !isVisible(layer) || !isVisible(tip)) continue;
      const text = String(tip.textContent || '').trim().slice(0, 800);
      const kind = Core.classifyRestriction(text);
      if (kind) return { kind, text: text.slice(0, 180) };
    }
    if (knownOnly) return null;
    const root = scope || document.querySelector('.live-player-mounter,#live-player,#player-ctnr,.bilibili-live-player,.player-ctnr') || document.body;
    if (root.nodeType !== Node.ELEMENT_NODE || root.closest(excluded)) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) return node.matches(excluded + ',script,style,noscript,textarea,input') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    let count = 0;
    while ((node = walker.nextNode()) && count++ < 9000) {
      const raw = node.nodeValue || '';
      if (!/地区|直播间|版权方|country|region/i.test(raw)) continue;
      const parent = node.parentElement;
      if (!parent || parent.closest(excluded) || /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|INPUT)$/.test(parent.tagName)) continue;
      const text = parent.textContent.length < 800 ? parent.textContent : raw;
      const kind = Core.classifyRestriction(text);
      if (kind && isVisible(parent)) return { kind, text: String(text).trim().slice(0, 180) };
    }
    return null;
  }
  function postSuspended(value) {
    window.postMessage({ channel: 'bili-live-helper-media', suspended: value }, location.origin);
  }

  // Only suppress the original, identified room-limit modal while the
  // replacement is mounted. Never hide arbitrary dialogs or player errors.
  class RestrictionLayers {
    constructor() { this.active = false; this.saved = new Map(); }
    matches(layer) {
      if (layer.closest('[data-blh-player],[data-blh-dock],[class*="chat"],[id*="chat"]')) return false;
      if (layer.querySelector('video,audio,iframe,bwp-video,canvas,select,input,textarea,[contenteditable="true"]')) return false;
      const tip = layer.querySelector('.tip-content') || layer;
      return Boolean(Core.classifyRestriction(tip.textContent));
    }
    setActive(value) {
      this.active = value;
      if (value) this.suppress();
      else for (const [node, state] of [...this.saved]) this.restoreNode(node, state);
    }
    restoreNode(node, state) {
      state.observer.disconnect();
      for (const [property, old] of Object.entries(state.styles)) {
        if (old.value) node.style.setProperty(property, old.value, old.priority);
        else node.style.removeProperty(property);
      }
      if (state.aria === null) node.removeAttribute('aria-hidden'); else node.setAttribute('aria-hidden', state.aria);
      node.inert = state.inert;
      this.saved.delete(node);
    }
    suppress() {
      if (!this.active) return;
      for (const [node, state] of [...this.saved]) {
        if (!node.isConnected || !this.matches(node)) this.restoreNode(node, state);
      }
      for (const node of document.querySelectorAll('#limit-boomman,.limit-boomman-box')) {
        if (!this.matches(node)) continue;
        if (!this.saved.has(node)) {
          const styles = {};
          for (const property of ['display', 'visibility', 'pointer-events']) styles[property] = { value: node.style.getPropertyValue(property), priority: node.style.getPropertyPriority(property) };
          const observer = new MutationObserver(() => this.suppress());
          this.saved.set(node, { styles, aria: node.getAttribute('aria-hidden'), inert: node.inert, observer });
          observer.observe(node, { attributes: true, attributeFilter: ['style', 'class', 'aria-hidden', 'inert'] });
        }
        for (const [property, value] of Object.entries({ display: 'none', visibility: 'hidden', 'pointer-events': 'none' })) {
          if (node.style.getPropertyValue(property) !== value || node.style.getPropertyPriority(property) !== 'important') node.style.setProperty(property, value, 'important');
        }
        if (node.getAttribute('aria-hidden') !== 'true') node.setAttribute('aria-hidden', 'true');
        if (!node.inert) node.inert = true;
      }
    }
  }

  // This reporter runs only inside the official activity player. It does not
  // replace, intercept or synthesize any of the player's quality controls.
  if (isActivity) {
    if (isTop) return;
    let lastState = '';
    let lastSize = '';
    const report = (signal, value = {}) => {
      if (signal !== 'diagnostics') {
        const key = signal + JSON.stringify(value);
        if (signal === 'resolution') { if (key === lastSize) return; lastSize = key; }
        else { if (key === lastState) return; lastState = key; }
      }
      window.parent.postMessage({ source: 'bili-live-helper-activity', signal, ...value }, 'https://live.bilibili.com');
    };
    let lastError = '';
    const seen = new WeakSet();
    const previousSamples = new WeakMap();
    function reportDiagnostics(media, forcedReason = null) {
      let bufferSeconds = null;
      try {
        bufferSeconds = 0;
        for (let index = 0; index < media.buffered.length; index++) {
          if (media.currentTime >= media.buffered.start(index) - 0.1 && media.currentTime <= media.buffered.end(index) + 0.1) bufferSeconds = Math.max(0, media.buffered.end(index) - media.currentTime);
        }
      } catch { bufferSeconds = null; }
      let totalFrames = null;
      let droppedFrames = null;
      try { const quality = media.getVideoPlaybackQuality(); totalFrames = quality.totalVideoFrames; droppedFrames = quality.droppedVideoFrames; } catch { /* Browser may not expose these counters. */ }
      const previous = previousSamples.get(media);
      const delta = previous && totalFrames !== null ? totalFrames - previous.totalFrames : 0;
      const dropPercent = delta > 0 && droppedFrames !== null ? Math.max(0, Math.min(100, (droppedFrames - previous.droppedFrames) / delta * 100)) : null;
      if (totalFrames !== null && droppedFrames !== null) previousSamples.set(media, { totalFrames, droppedFrames });
      const reason = forcedReason || (media.paused ? 'paused' : media.readyState < 3 ? 'buffering' : delta >= 15 && dropPercent > 10 ? 'decode' : 'playing');
      report('diagnostics', Core.normalizePlaybackDiagnostics({ reason, bufferSeconds, readyState: media.readyState, droppedFrames, totalFrames, dropPercent }));
    }
    function reportSize(media) {
      const width = Number(media.videoWidth);
      const height = Number(media.videoHeight);
      if (width > 0 && height > 0) report('resolution', { width, height });
    }
    function scan() {
      for (const media of document.querySelectorAll('video')) {
        if (!seen.has(media)) {
          seen.add(media);
          media.addEventListener('playing', () => { lastError = ''; report('playing'); reportSize(media); reportDiagnostics(media); });
          media.addEventListener('resize', () => reportSize(media));
          media.addEventListener('loadedmetadata', () => reportSize(media));
          media.addEventListener('pause', () => report('paused'));
          media.addEventListener('ended', () => report('ended'));
          media.addEventListener('waiting', () => { if (!media.paused) { report('buffering'); reportDiagnostics(media, 'buffering'); } });
          media.addEventListener('stalled', () => { if (!media.paused && media.readyState < 3) { report('buffering'); reportDiagnostics(media, 'buffering'); } });
          media.addEventListener('error', () => report('error', { text: '备用播放器媒体加载失败，可重试或切换官方线路' }));
        }
        if (!media.paused && media.readyState >= 3) { report('playing'); reportSize(media); }
        reportDiagnostics(media);
      }
      const healthy = [...document.querySelectorAll('video')].some(media => !media.paused && media.readyState >= 3);
      const error = restrictionInDocument({ knownOnly: healthy });
      if (error && error.text !== lastError) { lastError = error.text; report('error', { text: error.text }); }
    }
    scan();
    setInterval(scan, 5000);
    return;
  }

  if (location.origin !== 'https://live.bilibili.com') return;
  if (!isTop) {
    const originalLayers = new RestrictionLayers();
    let originalSuspended = false;
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (sender.id === chrome.runtime.id && message.type === 'ORIGINAL_SUSPENDED') {
        postSuspended(message.value === true);
        originalSuspended = message.value === true;
        originalLayers.setActive(message.value === true);
      }
    });
    let last = '';
    function scan() {
      if (originalSuspended) return;
      originalLayers.suppress();
      const error = restrictionInDocument();
      if (error && last !== error.text) { last = error.text; send({ type: 'FRAME_RESTRICTION', text: error.text }); }
      if (!error && last) { last = ''; send({ type: 'FRAME_CLEAR' }); }
    }
    send({ type: 'FRAME_READY' });
    scan();
    setInterval(scan, 5000);
    return;
  }

  const DOCK_STYLE = `
    :host{all:initial;position:fixed!important;left:18px!important;bottom:18px!important;z-index:2147483646!important;display:block!important;color-scheme:dark;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif!important;color:#eef0f5!important}
    *{box-sizing:border-box}button,a,input{font:inherit}button,a{touch-action:manipulation}button{cursor:pointer}button:disabled{opacity:.55;cursor:wait}
    .dock{width:340px;max-width:calc(100vw - 36px);background:#161a23;border:1px solid #343b49;border-radius:13px;box-shadow:0 8px 30px #0005;overflow:hidden}
    .row{display:flex;align-items:center;gap:8px;padding:10px 12px}.dot{width:7px;height:7px;border-radius:50%;background:#8892a6;flex-shrink:0}.dot.active{background:#56d9a1}.name{font-weight:650;flex:1;font-size:12px;letter-spacing:.2px}
    button{border:1px solid #495366;background:#242c3a;color:#eff3fa;border-radius:7px;padding:5px 9px}button:hover{background:#303b4d;border-color:#6a7890}button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid #f7a1b9;outline-offset:3px}.primary{background:#ff86a6;border-color:#ff86a6;color:#26151e;font-weight:650}.primary:hover{background:#ffa7be;border-color:#ffa7be}.expand{padding:4px 7px;color:#bdc6d6}.detail{border-top:1px solid #303847;padding:11px 12px 13px}.detail[hidden]{display:none}.status{color:#d5dce9;overflow-wrap:anywhere;margin:0 0 10px}.meta{color:#98a7bf;font-size:11px;margin:0 0 10px}.actions{display:flex;align-items:center;gap:12px;margin:10px 0}a{color:#ffb0c6;text-decoration:none}a:hover{text-decoration:underline}.toggle{display:flex;align-items:center;gap:8px;color:#e3e8f1;cursor:pointer}input{accent-color:#ff86a6;width:15px;height:15px;margin:0}.tip{font-size:11px;color:#98a7bf;margin:9px 0 0}
    @media(max-width:600px){:host{left:8px!important;bottom:8px!important}.dock{max-width:calc(100vw - 16px)}}`;

  class RoomController {
    constructor() {
      this.roomId = null;
      this.canonicalId = null;
      this.mode = 'original';
      this.autoSwitch = true;
      this.suppressAuto = false;
      this.status = 'original';
      this.note = '原播放器正常使用；受限时自动尝试备用播放器';
      this.generation = 0;
      this.operation = 0;
      this.pending = false;
      this.hiddenNodes = new Map();
      this.target = null;
      this.overlay = null;
      this.iframe = null;
      this.dock = null;
      this.loadingTimer = null;
      this.autoFailures = 0;
      this.lastAutoAttempt = 0;
      this.frameRestriction = null;
      this.resolution = null;
      this.diagnostics = null;
      this.repairAttempts = 0;
      this.scanTimer = null;
      this.expanded = false;
      this.ready = false;
      this.errorLayers = new RestrictionLayers();
      this.lastHref = '';
      this.renderKey = null;
    }
    start() {
      this.checkRoute();
      this.routeTimer = setInterval(() => this.checkRoute(), 800);
      // Health checks use connected references only. Chat updates and scrolling
      // must not cause a document-wide query or repeated style writes.
      this.pollTimer = setInterval(() => {
        if (!this.roomId || !this.ready || this.pending) return;
        if (!this.dock?.isConnected || (this.mode === 'fallback' && !this.overlay?.isConnected)) this.scan();
        else if (this.mode === 'original' && this.autoSwitch && !this.suppressAuto) {
          if (restrictionInDocument({ knownOnly: true })) this.scan();
        }
      }, 5000);
      this.observer = new MutationObserver(records => {
        if (!this.hasRelevantMutation(records)) return;
        if (this.mode === 'fallback') this.errorLayers.suppress();
        if (this.scanTimer) return;
        this.scanTimer = setTimeout(() => { this.scanTimer = null; this.checkRoute(); this.scan(); }, 400);
      });
      this.observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
      window.addEventListener('message', event => this.onPlayerMessage(event));
      window.addEventListener('pagehide', () => this.clearLoadingTimer());
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.autoSwitch) return;
        this.autoSwitch = changes.autoSwitch.newValue !== false;
        if (this.autoSwitch) {
          this.suppressAuto = false;
          this.autoFailures = 0;
          this.lastAutoAttempt = 0;
          this.saveSession();
        }
        this.render();
        this.scan();
      });
      chrome.runtime.onMessage.addListener((message, sender, reply) => {
        if (sender.id !== chrome.runtime.id) return false;
        if (message.type === 'GET_STATE') { reply({ ok: true, state: this.snapshot() }); return false; }
        if (message.type === 'APPLY_ACTION') {
          this.action(message.action).then(() => reply({ ok: true, state: this.snapshot() }), error => reply({ ok: false, error: error.message }));
          return true;
        }
        if (message.type === 'FRAME_READY' && this.mode === 'fallback') this.suspendOriginal(true);
        if (message.type === 'FRAME_RESTRICTION') {
          this.frameRestriction = message.restriction;
          this.scan();
        }
        if (message.type === 'FRAME_CLEAR') this.frameRestriction = null;
        if (message.type === 'ORIGINAL_SUSPENDED') postSuspended(message.value === true);
        return false;
      });
    }
    snapshot() {
      return { roomId: this.roomId, canonicalId: this.canonicalId, mode: this.mode, status: this.status, note: this.note,
        autoSwitch: this.autoSwitch, suppressAuto: this.suppressAuto, pending: this.pending, resolution: this.resolution, diagnostics: this.diagnostics };
    }
    checkRoute() {
      if (location.href === this.lastHref) return;
      this.lastHref = location.href;
      const id = Core.roomIdFromUrl(location.href);
      if (id !== this.roomId) this.enterRoom(id);
    }
    hasRelevantMutation(records) {
      const ignored = '[data-blh-dock],[data-blh-player],[class*="chat"],[id*="chat"],[class*="danmaku"],[class*="danmu"],[class*="announcement"]';
      const tracked = '#limit-boomman,.limit-boomman-box,.live-player-mounter,#live-player,#player-ctnr,.bilibili-live-player,.player-ctnr';
      for (const record of records) {
        const element = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
        if (!element || element.closest(ignored)) continue;
        if (record.type === 'characterData') {
          if (this.mode === 'original' && Core.classifyRestriction(record.target.textContent)) return true;
          continue;
        }
        if (this.mode === 'fallback' && record.target === this.target) return true;
        for (const node of record.removedNodes) {
          if (node === this.target || node === this.overlay || node === this.dock || (node.nodeType === Node.ELEMENT_NODE && this.target && node.contains(this.target))) return true;
        }
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.TEXT_NODE) {
            if (this.mode === 'original' && Core.classifyRestriction(node.textContent)) return true;
            continue;
          }
          if (node.nodeType !== Node.ELEMENT_NODE || node.matches(ignored)) continue;
          if (node.matches(tracked) || node.querySelector(tracked)) return true;
          if (this.mode === 'original') {
            // Only inspect a small newly added subtree, not the full chat page.
            if (node.childElementCount < 12 && Core.classifyRestriction(node.textContent?.slice(0, 800))) return true;
          }
        }
      }
      return false;
    }
    async enterRoom(id) {
      const generation = ++this.generation;
      const operation = ++this.operation;
      this.clearPlayer();
      this.suspendOriginal(false);
      this.dock?.remove();
      this.dock = null;
      this.roomId = id;
      this.canonicalId = id;
      this.mode = 'original';
      this.suppressAuto = false;
      this.pending = false;
      this.status = 'original';
      this.note = '原播放器正常使用；受限时自动尝试备用播放器';
      this.autoFailures = 0;
      this.lastAutoAttempt = 0;
      this.frameRestriction = null;
      this.repairAttempts = 0;
      this.resolution = null;
      this.diagnostics = null;
      this.ready = false;
      if (!id) return;
      this.createDock();
      const [settings, result] = await Promise.all([
        chrome.storage.local.get(Core.DEFAULT_SETTINGS).catch(() => Core.DEFAULT_SETTINGS),
        send({ type: 'LOAD_SESSION', roomId: id })
      ]);
      if (this.generation !== generation) return;
      this.autoSwitch = settings.autoSwitch !== false;
      this.ready = true;
      if (this.operation !== operation) { this.render(); return; }
      const session = Core.normalizeSession(result.session, id);
      this.suppressAuto = session.suppressAuto;
      if (session.mode === 'fallback') await this.switchFallback({ manual: false, resume: true });
      else { this.render(); this.scan(); }
    }
    async saveSession() {
      if (!this.roomId) return;
      return send({ type: 'SAVE_SESSION', roomId: this.roomId, mode: this.mode, suppressAuto: this.suppressAuto });
    }
    createDock() {
      if (!this.roomId || this.dock?.isConnected) return;
      this.dock = document.createElement('div');
      this.renderKey = null;
      this.dock.dataset.blhDock = '';
      const shadow = this.dock.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<style>${DOCK_STYLE}</style><section class="dock" aria-label="B站直播播放器助手">
        <div class="row"><span class="dot" aria-hidden="true"></span><span class="name">直播助手 · 原播放器</span><button class="primary" data-action="switch">切换播放器</button><button class="expand" aria-label="展开播放器助手" aria-expanded="false">⌄</button></div>
        <div class="detail" hidden><p class="status" role="status" aria-live="polite"></p><p class="meta"></p><label class="toggle"><input type="checkbox">遇到受限提示时自动切换</label><div class="actions"><button data-action="reload">重新载入</button><a target="_blank" rel="noopener noreferrer">独立打开 ↗</a></div><p class="tip">画质和线路在视频右下角切换。可选档位由直播间提供。</p></div></section>`;
      this.ui = {
        title: shadow.querySelector('.name'), dot: shadow.querySelector('.dot'), switch: shadow.querySelector('[data-action="switch"]'),
        expand: shadow.querySelector('.expand'), detail: shadow.querySelector('.detail'), note: shadow.querySelector('.status'),
        meta: shadow.querySelector('.meta'), auto: shadow.querySelector('input'), reload: shadow.querySelector('[data-action="reload"]'),
        independent: shadow.querySelector('a')
      };
      this.ui.switch.addEventListener('click', () => this.action(this.mode === 'fallback' ? 'original' : 'fallback'));
      this.ui.reload.addEventListener('click', () => this.action('reload'));
      this.ui.expand.addEventListener('click', () => { this.expanded = !this.expanded; this.render(); });
      this.ui.auto.addEventListener('change', () => chrome.storage.local.set({ autoSwitch: this.ui.auto.checked }).catch(() => {}));
      shadow.addEventListener('keydown', event => event.stopPropagation());
      document.body.append(this.dock);
      this.render();
    }
    render() {
      if (!this.ui || !this.roomId) return;
      const key = JSON.stringify([this.roomId,this.canonicalId,this.mode,this.status,this.note,this.pending,this.autoSwitch,this.suppressAuto,this.expanded,this.resolution]);
      if (key === this.renderKey) return;
      this.renderKey = key;
      const fallback = this.mode === 'fallback';
      this.ui.title.textContent = fallback ? '直播助手 · 备用播放器' : '直播助手 · 原播放器';
      this.ui.dot.classList.toggle('active', fallback && this.status === 'playing');
      this.ui.switch.textContent = fallback ? '恢复原播放器' : '切换播放器';
      this.ui.switch.disabled = this.pending;
      this.ui.reload.disabled = this.pending || !fallback;
      this.ui.note.textContent = this.note;
      this.ui.meta.textContent = `房间 ${this.roomId}${this.resolution ? ` · 实际画面 ${this.resolution.width} × ${this.resolution.height}` : ''}${this.suppressAuto ? ' · 本房间已暂停自动切换' : ''}`;
      this.ui.auto.checked = this.autoSwitch;
      this.ui.independent.href = Core.playerUrl(this.canonicalId || this.roomId);
      this.ui.detail.hidden = !this.expanded;
      this.ui.expand.textContent = this.expanded ? '⌃' : '⌄';
      this.ui.expand.setAttribute('aria-expanded', String(this.expanded));
      this.ui.expand.setAttribute('aria-label', this.expanded ? '收起播放器助手' : '展开播放器助手');
    }
    async action(action) {
      if (!this.roomId) throw new Error('请先打开B站直播间');
      if (action === 'fallback') return this.switchFallback({ manual: true });
      if (action === 'original') return this.restoreOriginal();
      if (action === 'reload') {
        if (this.mode !== 'fallback') throw new Error('请先切换到备用播放器');
        ++this.operation;
        this.repairAttempts = 0;
        this.resolution = null;
        this.diagnostics = null;
        if (!this.mountPlayer()) { this.showMountFailure(); await this.saveSession(); }
        return;
      }
      throw new Error('未知的播放器操作');
    }
    async switchFallback({ manual = false, resume = false, room = null } = {}) {
      if (this.mode === 'fallback' && this.overlay?.isConnected) return;
      const generation = this.generation;
      const operation = ++this.operation;
      this.pending = true;
      this.note = manual ? '正在准备备用播放器…' : '检测到播放受限，正在切换备用播放器…';
      this.render();
      try {
        if (!room && !resume) {
          const result = await send({ type: 'ROOM_INFO', roomId: this.roomId });
          if (result.ok) room = result.room;
        }
        if (generation !== this.generation || operation !== this.operation) return;
        if (room) this.canonicalId = room.roomId;
        this.suppressAuto = false;
        this.resolution = null;
        this.diagnostics = null;
        if (!this.mountPlayer()) { this.showMountFailure(); await this.saveSession(); return; }
        this.mode = 'fallback';
        this.repairAttempts = 0;
        this.suspendOriginal(true);
        if (room && room.liveStatus === 0) { this.status = 'ended'; this.note = '主播当前已下播，备用播放器已打开'; this.clearLoadingTimer(); }
        await this.saveSession();
      } finally {
        if (generation === this.generation && operation === this.operation) { this.pending = false; this.render(); }
      }
    }
    findTarget() {
      const selectors = ['.live-player-mounter', '#live-player', '#player-ctnr', '.bilibili-live-player', '.player-ctnr'];
      for (const selector of selectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (element.closest('[data-blh-player]') || element === document.body || !isVisible(element)) continue;
          if (element.getBoundingClientRect().width >= 200) return element;
        }
      }
      return null;
    }
    hideOriginalChildren() {
      if (!this.target) return;
      for (const child of this.target.children) {
        if (child === this.overlay || child.hasAttribute('data-blh-player')) continue;
        if (!this.hiddenNodes.has(child)) this.hiddenNodes.set(child, {
          visibility: child.style.getPropertyValue('visibility'), visibilityPriority: child.style.getPropertyPriority('visibility'),
          pointer: child.style.getPropertyValue('pointer-events'), pointerPriority: child.style.getPropertyPriority('pointer-events'),
          aria: child.getAttribute('aria-hidden'), inert: child.inert
        });
        if (child.style.getPropertyValue('visibility') !== 'hidden' || child.style.getPropertyPriority('visibility') !== 'important') child.style.setProperty('visibility', 'hidden', 'important');
        if (child.style.getPropertyValue('pointer-events') !== 'none' || child.style.getPropertyPriority('pointer-events') !== 'important') child.style.setProperty('pointer-events', 'none', 'important');
        if (child.getAttribute('aria-hidden') !== 'true') child.setAttribute('aria-hidden', 'true');
        if (!child.inert) child.inert = true;
      }
    }
    mountPlayer() {
      this.clearPlayer();
      const target = this.findTarget();
      if (!target) return false;
      this.target = target;
      this.targetStyle = { position: target.style.getPropertyValue('position'), positionPriority: target.style.getPropertyPriority('position'), minHeight: target.style.getPropertyValue('min-height'), minHeightPriority: target.style.getPropertyPriority('min-height') };
      if (getComputedStyle(target).position === 'static') target.style.setProperty('position', 'relative', 'important');
      const rect = target.getBoundingClientRect();
      if (rect.height < 160) target.style.setProperty('min-height', `${Math.max(240, Math.min(rect.width * 9 / 16, innerHeight * 0.75))}px`, 'important');
      this.overlay = document.createElement('div');
      this.overlay.dataset.blhPlayer = '';
      this.overlay.style.cssText = 'position:absolute!important;inset:0!important;width:100%!important;height:100%!important;z-index:999!important;background:#000!important;visibility:visible!important;pointer-events:auto!important;';
      this.iframe = document.createElement('iframe');
      this.iframe.title = 'B站官方备用播放器（含画质和线路菜单）';
      this.iframe.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
      this.iframe.allowFullscreen = true;
      this.iframe.referrerPolicy = 'strict-origin-when-cross-origin';
      this.iframe.style.cssText = 'display:block!important;width:100%!important;height:100%!important;border:0!important;visibility:visible!important;';
      const url = new URL(Core.playerUrl(this.canonicalId || this.roomId));
      url.searchParams.set('_blh_reload', `${Date.now()}-${this.operation}`);
      this.iframe.src = url.href;
      this.overlay.append(this.iframe);
      this.hideOriginalChildren();
      target.append(this.overlay);
      this.errorLayers.setActive(true);
      this.status = 'loading';
      this.note = '备用播放器正在加载；若浏览器拦截自动播放，请点击视频中的播放按钮';
      this.loadingTimer = setTimeout(() => {
        if (this.mode === 'fallback' && this.status === 'loading') {
          this.status = 'timeout';
          this.note = '暂未确认播放成功。请点击视频播放，或使用重新载入 / 独立打开';
          this.expanded = true;
          this.render();
        }
      }, 20000);
      this.render();
      return true;
    }
    clearLoadingTimer() {
      if (this.loadingTimer) clearTimeout(this.loadingTimer);
      this.loadingTimer = null;
    }
    clearPlayer() {
      this.clearLoadingTimer();
      this.errorLayers.setActive(false);
      this.overlay?.remove();
      this.overlay = null;
      this.iframe = null;
      for (const [node, old] of this.hiddenNodes) {
        if (old.visibility) node.style.setProperty('visibility', old.visibility, old.visibilityPriority); else node.style.removeProperty('visibility');
        if (old.pointer) node.style.setProperty('pointer-events', old.pointer, old.pointerPriority); else node.style.removeProperty('pointer-events');
        if (old.aria === null) node.removeAttribute('aria-hidden'); else node.setAttribute('aria-hidden', old.aria);
        node.inert = old.inert;
      }
      this.hiddenNodes.clear();
      if (this.target && this.targetStyle) {
        const old = this.targetStyle;
        if (old.position) this.target.style.setProperty('position', old.position, old.positionPriority); else this.target.style.removeProperty('position');
        if (old.minHeight) this.target.style.setProperty('min-height', old.minHeight, old.minHeightPriority); else this.target.style.removeProperty('min-height');
      }
      this.target = null;
      this.targetStyle = null;
    }
    showMountFailure() {
      this.mode = 'original';
      this.status = 'error';
      this.note = '未找到可安全替换的视频区域，原页面已保留。请使用“独立打开”';
      this.expanded = true;
      this.autoFailures = 2;
      this.suspendOriginal(false);
      this.render();
    }
    suspendOriginal(value) {
      postSuspended(value);
      if (this.roomId) send({ type: 'SET_SUSPENDED', value });
    }
    async restoreOriginal() {
      ++this.operation;
      this.pending = false;
      this.mode = 'original';
      this.clearPlayer();
      this.suspendOriginal(false);
      this.suppressAuto = true;
      this.frameRestriction = null;
      this.resolution = null;
      this.diagnostics = null;
      this.status = 'original';
      this.note = '已恢复原播放器；本标签页的当前房间暂不再次自动切换';
      this.render();
      await this.saveSession();
    }
    scan() {
      if (!this.roomId || this.pending || !this.ready) return;
      if (!this.dock?.isConnected) this.createDock();
      if (this.mode === 'fallback') {
        if (!this.overlay?.isConnected) {
          if (++this.repairAttempts <= 3 && this.mountPlayer()) this.suspendOriginal(true);
          else { this.showMountFailure(); this.saveSession(); }
        } else this.hideOriginalChildren();
        return;
      }
      if (!this.autoSwitch || this.suppressAuto || this.autoFailures >= 2 || Date.now() - this.lastAutoAttempt < 30000) return;
      const error = restrictionInDocument();
      const kind = error?.kind || this.frameRestriction;
      if (kind) this.tryAuto(kind);
    }
    async tryAuto(restriction) {
      if (this.pending || this.mode !== 'original' || this.suppressAuto || !this.autoSwitch) return;
      const generation = this.generation;
      const operation = ++this.operation;
      this.pending = true;
      this.lastAutoAttempt = Date.now();
      this.note = '检测到受限提示，正在确认直播状态…';
      this.render();
      const result = await send({ type: 'ROOM_INFO', roomId: this.roomId });
      if (generation !== this.generation || operation !== this.operation) return;
      this.pending = false;
      if (!result.ok) {
        ++this.autoFailures;
        this.note = `${result.error || '无法确认直播状态'}。仍可手动切换。`;
        this.expanded = true;
        this.render();
        return;
      }
      const currentRestriction = restrictionInDocument()?.kind || this.frameRestriction;
      if (!currentRestriction) {
        this.note = '受限提示已消失，保留原播放器';
        this.render();
        return;
      }
      const allowed = Core.canAutoSwitch({ enabled: this.autoSwitch, suppressed: this.suppressAuto, mode: this.mode, restriction, room: result.room });
      if (allowed) await this.switchFallback({ room: result.room });
      else { this.note = Core.mediaStatus(result.room) || '自动切换已暂停，仍可手动操作'; this.render(); }
    }
    onPlayerMessage(event) {
      if (this.mode !== 'fallback' || !this.iframe || event.source !== this.iframe.contentWindow || event.origin !== Core.PLAYER_ORIGIN) return;
      let type;
      let value;
      if (typeof event.data === 'string' && event.data.startsWith('playerOperation-') && event.data.length < 16000) {
        try { const body = JSON.parse(event.data.slice('playerOperation-'.length)); type = body.type; value = body.value; } catch { return; }
      } else if (event.data?.source === 'bili-live-helper-activity') {
        type = event.data.signal;
        value = event.data;
      } else return;
      if (type === 'playing' || type === 'MutePlay') {
        this.status = 'playing';
        this.note = type === 'MutePlay' ? '正在播放；浏览器以静音方式启动，可在视频中开启声音' : '备用播放器正在播放；画质与线路在视频右下角切换';
        this.clearLoadingTimer();
      } else if (type === 'NotAutoPlay') {
        this.status = 'needs-click'; this.note = '浏览器阻止了自动播放，请点击视频中的播放按钮'; this.clearLoadingTimer();
      } else if (type === 'paused') {
        this.status = 'paused'; this.note = '播放已暂停，可在视频中继续'; this.clearLoadingTimer();
      } else if (type === 'buffering') {
        this.status = 'buffering'; this.note = '正在缓冲。可尝试视频菜单中的其他线路；有较低画质时也可切换'; this.clearLoadingTimer();
      } else if (type === 'ended' || (type === 'liveStateChange' && Number(value?.status) === 0)) {
        this.status = 'ended'; this.note = '主播已下播'; this.clearLoadingTimer();
      } else if (type === 'error') {
        this.status = 'error'; this.note = String(value?.text || '备用播放器加载失败').slice(0, 180); this.expanded = true; this.clearLoadingTimer();
      } else if (type === 'resolution' && Number.isFinite(value.width) && Number.isFinite(value.height) && value.width > 0 && value.height > 0) {
        this.resolution = { width: value.width, height: value.height };
      } else if (type === 'diagnostics') {
        this.diagnostics = Core.normalizePlaybackDiagnostics(value);
        return;
      }
      this.render();
    }
  }
  new RoomController().start();
})();
