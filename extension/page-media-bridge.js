(function () {
  'use strict';
  if (window.__biliLiveHelperMediaBridge) return;
  window.__biliLiveHelperMediaBridge = true;
  const MEDIA = 'video,audio,bwp-video';
  const IGNORE = '[data-blh-player],[data-blh-dock],[class*="chat"],[id*="chat"],[class*="danmaku"],[class*="danmu"]';
  const PLAYER_ROOTS = ['.live-player-mounter', '#live-player', '#player-ctnr', '.bilibili-live-player', '.player-ctnr'];
  let suspended = false;
  let timer = null;
  const media = new Set();
  const saved = new Map();
  const observed = new Map();
  const frozenPlayers = new Map();

  function ownedVideo(player) {
    const accessor = player.getVideoEl;
    const element = typeof accessor === 'function' ? accessor.call(player) : accessor;
    if (!(element instanceof Element) || !element.matches(MEDIA) || !element.isConnected || element.closest(IGNORE)) return null;
    if (!media.has(element) && !element.closest(PLAYER_ROOTS.join(','))) return null;
    return element;
  }
  function freezeOriginalStream() {
    // pause() on a video does not stop an independent FLV/HLS loader. Use
    // Bilibili's reversible stream-stop API only for the verified room player.
    try {
      const player = window.livePlayer;
      if (!suspended || !player || frozenPlayers.has(player)) return;
      if (typeof player.freeze !== 'function' || typeof player.reload !== 'function') return;
      const element = ownedVideo(player);
      if (!element) return;
      const state = saved.get(element);
      if (!state) return;
      frozenPlayers.set(player, { ...state });
      try { player.freeze(); } catch { frozenPlayers.delete(player); }
    } catch { /* Unknown player versions keep the media-only fallback. */ }
  }

  function pauseKnown() {
    if (!suspended) return;
    for (const element of media) {
      if (!element.isConnected) { media.delete(element); saved.delete(element); continue; }
      if (typeof element.pause !== 'function') continue;
      const first = !saved.has(element);
      if (first) saved.set(element, { paused: element.paused !== false, muted: element.muted });
      try {
        if (first || element.paused === false) element.pause();
        if (element.muted !== true) element.muted = true;
      } catch { /* A disposed native player may reject a command. */ }
    }
    freezeOriginalStream();
  }
  function discover(node, shadows = false) {
    if (!node || ![Node.ELEMENT_NODE, Node.DOCUMENT_NODE, Node.DOCUMENT_FRAGMENT_NODE].includes(node.nodeType)) return;
    if (node.nodeType === Node.ELEMENT_NODE && node.closest(IGNORE)) return;
    if (node.matches?.(MEDIA)) media.add(node);
    for (const element of node.querySelectorAll(MEDIA)) if (!element.closest(IGNORE)) media.add(element);
    if (node.shadowRoot) { observe(node.shadowRoot); discover(node.shadowRoot, true); }
    if (!shadows) return;
    // Shadow-host discovery is bounded and scoped to the player, once when
    // attaching. Never enumerate all page elements on a playback timer.
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT, {
      acceptNode(element) { return element.matches(IGNORE) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; }
    });
    let element;
    let remaining = 512;
    while (remaining-- > 0 && (element = walker.nextNode())) {
      if (element.shadowRoot && !observed.has(element.shadowRoot)) {
        observe(element.shadowRoot);
        discover(element.shadowRoot, true);
      }
    }
  }
  function onPlay(event) {
    if (!suspended) return;
    if (event.target && typeof event.target.pause === 'function') media.add(event.target);
    pauseKnown();
  }
  function observe(root) {
    if (observed.has(root)) return;
    const observer = new MutationObserver(records => {
      if (!suspended) return;
      let changed = false;
      for (const record of records) {
        if (record.target.nodeType === Node.ELEMENT_NODE && record.target.closest(IGNORE)) continue;
        for (const node of record.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE || node.closest(IGNORE)) continue;
          discover(node, node.localName.includes('-') || node.matches(PLAYER_ROOTS.join(',')));
          changed = true;
        }
      }
      if (changed) pauseKnown();
    });
    observer.observe(root, { childList: true, subtree: true });
    root.addEventListener('play', onPlay, true);
    observed.set(root, observer);
  }
  function refreshRoots() {
    for (const [root, observer] of observed) {
      const connected = root.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? root.host?.isConnected : root.isConnected;
      if (!connected) { observer.disconnect(); root.removeEventListener('play', onPlay, true); observed.delete(root); }
    }
    if (observed.size) return;
    discover(document);
    let roots = [];
    for (const selector of PLAYER_ROOTS) {
      roots = [...document.querySelectorAll(selector)].filter(node => !node.closest(IGNORE));
      if (roots.length) break;
    }
    if (!roots.length && document.body) roots = [document.body];
    for (const root of roots) { observe(root); discover(root, true); }
  }
  function restore() {
    for (const [root, observer] of observed) { observer.disconnect(); root.removeEventListener('play', onPlay, true); }
    observed.clear();
    for (const [element, state] of saved) {
      if (!element.isConnected) continue;
      try {
        if (typeof state.muted === 'boolean' && element.muted !== state.muted) element.muted = state.muted;
        if (!state.paused && typeof element.play === 'function') Promise.resolve(element.play()).catch(() => {});
      } catch { /* The room can recreate its player on restore. */ }
    }
    saved.clear();
    media.clear();
    const players = [...frozenPlayers];
    frozenPlayers.clear();
    for (const [player, state] of players) {
      try {
        Promise.resolve(player.reload()).then(() => {
          if (suspended) {
            // A quick switch back can overlap a pending native reload.
            frozenPlayers.delete(player);
            refreshRoots(); pauseKnown();
            return;
          }
          const accessor = player.getVideoEl;
          const element = typeof accessor === 'function' ? accessor.call(player) : accessor;
          if (!element?.isConnected || element.closest(IGNORE)) return;
          if (typeof state.muted === 'boolean') element.muted = state.muted;
          if (state.paused) element.pause?.();
          else Promise.resolve(element.play?.()).catch(() => {});
        }).catch(() => {});
      } catch { /* Restoring remains available even if a player was disposed. */ }
    }
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.channel !== 'bili-live-helper-media' || typeof event.data.suspended !== 'boolean') return;
    const next = event.data.suspended;
    if (next === suspended) { if (next) { refreshRoots(); pauseKnown(); } return; }
    suspended = next;
    if (timer) clearInterval(timer);
    timer = null;
    if (suspended) {
      refreshRoots(); pauseKnown();
      timer = setInterval(() => { refreshRoots(); pauseKnown(); }, 5000);
    } else restore();
  });
  document.addEventListener('play', onPlay, true);
})();
