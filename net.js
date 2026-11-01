// Standalone multiplayer for «Ветер в поле».
// The game was written against the Claude artifact runtime (window.claude.use("room" | "db" | "user")).
// Outside Claude this file stands in for that runtime with peer-to-peer connections through PeerJS:
// one player hosts a room under a short code, everyone else connects to the host, and the host
// relays presence and chat and keeps the shared list of placed objects.
(function () {
  'use strict';
  const PREFIX = 'polevetra-room-';
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const COLORS = ['#e0672b', '#3f8fd9', '#d94f8c', '#3fae6a', '#8e63d9', '#d9b23f'];
  const KINDS = ['swing', 'cube', 'bench'];
  const MAX_OBJECTS = 60;

  const store = {
    get(k, d) { try { const v = localStorage.getItem('field.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('field.' + k, JSON.stringify(v)); } catch (e) { /* storage off: fine */ } }
  };
  const rid = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => ALPHABET[b % ALPHABET.length]).join('');
  const str = (v, n) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁠-⁩﻿]/g, '').trim().slice(0, n) : '';
  const color = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : '#8899aa';
  const num = v => typeof v === 'number' && isFinite(v) && Math.abs(v) < 1e5;

  // one id per running game, so two windows on the same device are still two players
  const myId = 'u_' + rid(16);
  const me = { name: store.get('name', ''), color: color(store.get('color', COLORS[0])) };

  window.FIELD_SOLO_HINT = 'Одиночная игра. Чтобы играть вместе, перезапустите игру и создайте комнату или войдите по коду.';

  // ---------- shared state ----------
  let peer = null, isHost = false, hostConn = null, connected = false, code = null;
  let myLabel = 'me';
  let myPresence = {};
  const conns = new Map();     // host only: peer label -> DataConnection
  const players = new Map();   // label -> { label, id, name, color, presence, updatedAt }
  const objects = new Map();   // object id -> { kind, x, z, yaw, by, t }
  const peersHandlers = new Set(), peersErrors = new Set(), topicHandlers = new Map(), objHandlers = new Set();

  function senderOf(label) {
    const p = players.get(label);
    return { peer: label, by: p ? p.id : null, isMe: label === myLabel, sameTab: label === myLabel, kind: 'viewer', guest: false };
  }
  function peerObj(label) {
    const p = players.get(label);
    return Object.assign(senderOf(label), { presence: (p && p.presence) || {}, updatedAt: p ? p.updatedAt : Date.now() });
  }
  const allPeers = () => [...players.keys()].map(peerObj);
  function firePeers(joined, left, updated) {
    const ch = { peers: allPeers(), joined: (joined || []).map(peerObj), left: left || [], updated: (updated || []).map(peerObj) };
    peersHandlers.forEach(fn => { try { fn(ch); } catch (e) { console.error(e); } });
  }
  function applyPres(label, p) {
    const pl = players.get(label);
    if (!pl || !p || typeof p !== 'object' || Array.isArray(p)) return false;
    let s; try { s = JSON.stringify(p); } catch (e) { return false; }
    if (s.length > 2000) return false;
    pl.presence = p; pl.updatedAt = Date.now();
    return true;
  }
  function deliverChat(label, text) {
    const msg = Object.assign(senderOf(label), { topic: 'chat', data: { text } });
    (topicHandlers.get('chat') || []).forEach(fn => { try { fn(msg); } catch (e) { console.error(e); } });
  }
  function cleanObj(d) {
    if (!d || typeof d !== 'object' || !KINDS.includes(d.kind) || !num(d.x) || !num(d.z) || !num(d.yaw)) return null;
    return { kind: d.kind, x: d.x, z: d.z, yaw: d.yaw, by: str(d.by, 40) || null, t: num(d.t) ? d.t : 0 };
  }
  function snapshot(changes) {
    return {
      metadata: { fromCache: false, hasPendingWrites: false },
      docChanges: () => changes.map(c => ({ type: c.type, doc: { id: c.id, exists: c.type !== 'removed', data: () => c.data } }))
    };
  }
  function fireObj(changes) {
    if (!changes.length) return;
    const s = snapshot(changes);
    objHandlers.forEach(fn => { try { fn(s); } catch (e) { console.error(e); } });
  }
  // apply one object write locally and report it; returns false when the write is invalid
  function applyObj(id, data) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(id))) return false;
    if (data === null) {
      const old = objects.get(id); if (!old) return false;
      objects.delete(id); fireObj([{ type: 'removed', id, data: old }]);
      return true;
    }
    const d = cleanObj(data); if (!d) return false;
    const had = objects.has(id);
    if (!had && objects.size >= MAX_OBJECTS) return false;
    objects.set(id, d); fireObj([{ type: had ? 'modified' : 'added', id, data: d }]);
    return true;
  }

  // ---------- host ----------
  function broadcast(m, except) {
    conns.forEach((c, l) => { if (l !== except && c.open) { try { c.send(m); } catch (e) { /* dropped peer */ } } });
  }
  function hostApplyObj(id, data) {
    if (!applyObj(id, data)) return;
    store.set('objects', Object.fromEntries(objects));
    broadcast({ t: 'obj', id, data: data === null ? null : objects.get(id) });
  }
  function hostOnData(c, m) {
    if (!m || typeof m !== 'object') return;
    const label = c.peer;
    if (m.t === 'hello') {
      players.set(label, { label, id: str(m.id, 40) || null, name: str(m.name, 24) || 'Игрок', color: color(m.color), presence: {}, updatedAt: Date.now() });
      c.send({ t: 'welcome', you: label, players: [...players.values()], objects: Object.fromEntries(objects) });
      broadcast({ t: 'join', player: players.get(label) }, label);
      firePeers([label]); updateBadge();
      return;
    }
    if (!players.has(label)) return;
    if (m.t === 'pres') { if (applyPres(label, m.p)) { broadcast({ t: 'pres', label, p: m.p }, label); firePeers(null, null, [label]); } }
    else if (m.t === 'chat') { const text = str(m.text, 160); if (text) { deliverChat(label, text); broadcast({ t: 'chat', label, text }, label); } }
    else if (m.t === 'obj') hostApplyObj(m.id, m.data === null ? null : m.data);
  }
  function hostDrop(label) {
    conns.delete(label);
    if (!players.has(label)) return;
    const po = peerObj(label);
    players.delete(label);
    broadcast({ t: 'leave', label });
    firePeers(null, [po]); updateBadge();
  }
  function createRoom() {
    status('Создаю комнату…');
    code = rid(5);
    peer = new Peer(PREFIX + code, { debug: 0 });
    peer.on('open', id => {
      if (connected) return;
      isHost = true; connected = true; myLabel = id;
      players.set(myLabel, { label: myLabel, id: myId, name: me.name || 'Игрок', color: me.color, presence: {}, updatedAt: Date.now() });
      const saved = store.get('objects', {});
      if (saved && typeof saved === 'object') Object.keys(saved).forEach(k => { const d = cleanObj(saved[k]); if (d && objects.size < MAX_OBJECTS) objects.set(k, d); });
      finish('room');
    });
    peer.on('connection', c => {
      c.on('open', () => conns.set(c.peer, c));
      c.on('data', m => hostOnData(c, m));
      c.on('close', () => hostDrop(c.peer));
      c.on('error', () => hostDrop(c.peer));
    });
    peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) { /* signalling only; open games keep running */ } });
    peer.on('error', e => {
      if (e.type === 'unavailable-id' && !connected) { peer.destroy(); createRoom(); return; }
      if (!connected) { status(errText(e)); cleanup(); }
    });
  }

  // ---------- client ----------
  function clientOnData(m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'welcome') {
      myLabel = str(m.you, 80) || myLabel;
      players.clear();
      (Array.isArray(m.players) ? m.players : []).forEach(p => {
        const label = str(p && p.label, 80); if (!label) return;
        players.set(label, { label, id: str(p.id, 40) || null, name: str(p.name, 24) || 'Игрок', color: color(p.color), presence: {}, updatedAt: Date.now() });
        applyPres(label, p.presence);
      });
      const objs = m.objects && typeof m.objects === 'object' ? m.objects : {};
      Object.keys(objs).forEach(k => applyObj(k, objs[k]));
      firePeers([...players.keys()]);
    } else if (m.t === 'join') {
      const p = m.player || {}, label = str(p.label, 80); if (!label) return;
      players.set(label, { label, id: str(p.id, 40) || null, name: str(p.name, 24) || 'Игрок', color: color(p.color), presence: {}, updatedAt: Date.now() });
      firePeers([label]);
    } else if (m.t === 'leave') {
      const label = str(m.label, 80); if (!players.has(label)) return;
      const po = peerObj(label); players.delete(label); firePeers(null, [po]);
    } else if (m.t === 'pres') {
      const label = str(m.label, 80); if (applyPres(label, m.p)) firePeers(null, null, [label]);
    } else if (m.t === 'chat') {
      const label = str(m.label, 80), text = str(m.text, 160); if (players.has(label) && text) deliverChat(label, text);
    } else if (m.t === 'obj') applyObj(m.id, m.data === null ? null : m.data);
    updateBadge();
  }
  function hostLost() {
    if (!connected) return;
    connected = false;
    const left = [...players.keys()].filter(l => l !== myLabel).map(peerObj);
    players.clear();
    firePeers(null, left);
    peersErrors.forEach(fn => { try { fn({ code: 'revoked', message: 'host left' }); } catch (e) { /* game handles */ } });
    badgeNote = 'Хозяин комнаты вышел. Вы гуляете одни.';
    updateBadge();
  }
  function joinRoom(c) {
    code = c;
    status('Подключаюсь к комнате ' + code + '…');
    peer = new Peer(undefined, { debug: 0 });
    let timer = null;
    peer.on('open', () => {
      hostConn = peer.connect(PREFIX + code, { reliable: true });
      timer = setTimeout(() => { if (!connected) { status('Не удалось подключиться. Проверьте код и что хозяин комнаты в игре.'); cleanup(); } }, 15000);
      hostConn.on('open', () => hostConn.send({ t: 'hello', id: myId, name: me.name || 'Игрок', color: me.color }));
      hostConn.on('data', m => {
        if (m && m.t === 'welcome' && !connected) { clearTimeout(timer); connected = true; clientOnData(m); finish('room'); }
        else if (connected) clientOnData(m);
      });
      hostConn.on('close', hostLost);
      hostConn.on('error', hostLost);
    });
    peer.on('error', e => {
      if (connected) return;
      clearTimeout(timer);
      status(e.type === 'peer-unavailable' ? 'Комната ' + code + ' не найдена. Проверьте код.' : errText(e));
      cleanup();
    });
  }
  function cleanup() {
    try { if (peer) peer.destroy(); } catch (e) { /* already gone */ }
    peer = null; hostConn = null; isHost = false; connected = false;
    setBusy(false);
  }
  function errText(e) {
    if (e && (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error')) return 'Нет связи с сервером комнат. Проверьте интернет и попробуйте ещё раз.';
    if (e && e.type === 'browser-incompatible') return 'Это устройство не поддерживает игру по сети.';
    return 'Не получилось: ' + ((e && e.type) || 'неизвестная ошибка') + '. Попробуйте ещё раз.';
  }

  // ---------- the runtime the game expects ----------
  function sendPresence() {
    if (!connected) return;
    if (isHost) {
      if (applyPres(myLabel, myPresence)) broadcast({ t: 'pres', label: myLabel, p: myPresence });
    } else if (hostConn && hostConn.open) {
      try { hostConn.send({ t: 'pres', p: myPresence }); } catch (e) { /* host gone */ }
    }
  }
  const room = {
    presence(patch) {
      if (patch && typeof patch === 'object') {
        Object.keys(patch).forEach(k => { if (patch[k] === null) delete myPresence[k]; else myPresence[k] = patch[k]; });
        myPresence = Object.assign({}, myPresence);
        sendPresence();
      }
      return Promise.resolve();
    },
    emit(topic, data) {
      if (topic !== 'chat' || !connected) return Promise.resolve();
      const text = str(data && data.text, 160);
      if (!text) return Promise.resolve();
      if (isHost) broadcast({ t: 'chat', label: myLabel, text });
      else if (hostConn && hostConn.open) hostConn.send({ t: 'chat', text });
      return Promise.resolve();
    },
    on(topic, fn) {
      if (!topicHandlers.has(topic)) topicHandlers.set(topic, new Set());
      topicHandlers.get(topic).add(fn);
      return () => topicHandlers.get(topic).delete(fn);
    },
    onPeers(fn, onError) {
      peersHandlers.add(fn); if (onError) peersErrors.add(onError);
      setTimeout(() => { if (peersHandlers.has(fn)) fn({ peers: allPeers(), joined: allPeers(), left: [], updated: [] }); }, 0);
      return () => { peersHandlers.delete(fn); peersErrors.delete(onError); };
    },
    peers: allPeers,
    connected: () => connected,
    onConnection(fn) { setTimeout(() => fn(connected), 0); return () => {}; }
  };
  function docRef(id) {
    const write = data => {
      if (!connected) return Promise.reject({ code: 'unavailable', message: 'not connected' });
      if (isHost) hostApplyObj(id, data);
      else hostConn.send({ t: 'obj', id, data });
      return Promise.resolve();
    };
    return { id, path: 'objects/' + id, set: data => write(data), delete: () => write(null) };
  }
  const db = {
    collection(path) {
      if (path !== 'objects') throw new TypeError('Only the objects collection exists here');
      return {
        path,
        doc: id => docRef(id || rid(14)),
        onSnapshot(next) {
          objHandlers.add(next);
          setTimeout(() => next(snapshot([...objects].map(([id, data]) => ({ type: 'added', id, data })))), 0);
          return () => objHandlers.delete(next);
        }
      };
    },
    doc(path) {
      const m = /^objects\/([A-Za-z0-9_-]{1,40})$/.exec(path);
      if (!m) throw new TypeError('Unknown document ' + path);
      return docRef(m[1]);
    }
  };
  function profileOf(id) {
    const p = [...players.values()].find(x => x.id === id);
    return { id, name: p ? p.name : '', color: p ? p.color : '#8899aa', avatarUrl: '', email: null, isMe: id === myId, guest: false };
  }
  const user = {
    id: async () => myId,
    me: async () => ({ id: myId, name: me.name, color: me.color, avatarUrl: '', email: null, isOwner: false, canEdit: false }),
    name: async () => me.name,
    isOwner: async () => false,
    canEdit: async () => false,
    can: async () => null,
    profiles: async ids => Object.fromEntries([].concat(ids).map(i => [i, profileOf(i)])),
    search: async () => []
  };

  let resolveMode;
  const modeReady = new Promise(r => { resolveMode = r; });
  window.claude = {
    use: name => modeReady.then(mode => {
      if (name === 'user') return user;
      if (mode !== 'room') return null;
      return name === 'room' ? room : name === 'db' ? db : null;
    })
  };

  // ---------- lobby ----------
  let lobby, statusEl, badge, badgeNote = '';
  const css = `
    #lobby { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; overflow-y: auto;
      padding: max(16px, env(safe-area-inset-top, 0px)) max(16px, env(safe-area-inset-right, 0px)) max(16px, env(safe-area-inset-bottom, 0px)) max(16px, env(safe-area-inset-left, 0px));
      background: linear-gradient(180deg, rgba(10,16,14,0.15), rgba(10,16,14,0.6)); }
    #lobby .lc { width: 100%; max-width: 26rem; display: grid; gap: 14px; padding: 24px; border-radius: 6px;
      background: rgba(18,26,20,0.62); border: 1px solid rgba(238,242,230,0.18); color: #eef2e6;
      backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); font-family: "Manrope", "Segoe UI", system-ui, sans-serif; }
    #lobby h2 { margin: 0; font: 300 clamp(1.9rem, 6vw, 2.6rem)/1.05 "Fraunces", Georgia, serif; }
    #lobby h2 em { font-style: italic; font-weight: 600; color: #d9c46a; }
    #lobby .ey { font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: rgba(238,242,230,0.72); }
    #lobby label { display: grid; gap: 6px; font-size: 12px; color: rgba(238,242,230,0.75); }
    #lobby input[type=text] { font: 16px "Manrope", system-ui, sans-serif; color: #eef2e6; background: rgba(238,242,230,0.08);
      border: 1px solid rgba(238,242,230,0.22); border-radius: 4px; padding: 10px 12px; min-width: 0; }
    #lobby input[type=text]:focus-visible, #lobby button:focus-visible { outline: 2px solid #d9c46a; outline-offset: 2px; }
    #lobby .sw { display: flex; gap: 10px; flex-wrap: wrap; }
    #lobby .sw button { width: 34px; height: 34px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; }
    #lobby .sw button[aria-pressed="true"] { border-color: #eef2e6; box-shadow: 0 0 0 2px rgba(0,0,0,0.35); }
    #lobby .row { display: flex; gap: 8px; }
    #lobby .row input { flex: 1; text-transform: uppercase; letter-spacing: 0.2em; }
    #lobby .pri { font: 600 15px "Manrope", system-ui, sans-serif; color: #1a1f12; background: #d9c46a; border: 0; border-radius: 4px; padding: 12px 16px; cursor: pointer; }
    #lobby .sec { font: 600 14px "Manrope", system-ui, sans-serif; color: #eef2e6; background: rgba(238,242,230,0.1); border: 1px solid rgba(238,242,230,0.25); border-radius: 4px; padding: 10px 14px; cursor: pointer; }
    #lobby .lnk { font: 14px "Manrope", system-ui, sans-serif; color: rgba(238,242,230,0.8); background: none; border: 0; text-decoration: underline; cursor: pointer; justify-self: start; padding: 4px 0; }
    #lobby button:disabled { opacity: 0.5; cursor: default; }
    #lobby .st { min-height: 1.3em; font-size: 13px; color: #f0d79a; }
    #lobby .or { font-size: 12px; color: rgba(238,242,230,0.55); text-align: center; }
    #roomBadge { position: fixed; z-index: 20; top: calc(56px + env(safe-area-inset-top, 0px)); right: max(16px, env(safe-area-inset-right, 0px));
      display: flex; gap: 8px; align-items: center; font: 12px "Manrope", system-ui, sans-serif; color: #eef2e6;
      background: rgba(18,26,20,0.55); border: 1px solid rgba(238,242,230,0.18); border-radius: 5px; padding: 6px 6px 6px 10px; max-width: calc(100vw - 32px); flex-wrap: wrap; }
    #roomBadge b { letter-spacing: 0.15em; }
    #roomBadge button { font: 600 12px "Manrope", system-ui, sans-serif; color: #eef2e6; background: rgba(238,242,230,0.12); border: 1px solid rgba(238,242,230,0.25); border-radius: 3px; padding: 4px 8px; cursor: pointer; }
    body.in-lobby #start, body.in-lobby .ui, body.in-lobby #ghost { visibility: hidden; }
    body.stealth #roomBadge { display: none; }
    body.touch #roomBadge { top: calc(104px + env(safe-area-inset-top, 0px)); }
  `;
  function status(t) { if (statusEl) statusEl.textContent = t; if (/^(Создаю|Подключаюсь)/.test(t)) setBusy(true); else setBusy(false); }
  function setBusy(b) { if (lobby) lobby.querySelectorAll('button').forEach(x => { x.disabled = b || (!window.Peer && x.dataset.net === '1'); }); }
  function finish(mode) {
    if (lobby) lobby.remove();
    document.body.classList.remove('in-lobby');
    resolveMode(mode);
    if (mode === 'room') updateBadge();
  }
  function shareLink() { return location.origin + location.pathname + '?room=' + code; }
  function updateBadge() {
    if (!code || !document.body) return;
    if (!badge) {
      badge = document.createElement('div'); badge.id = 'roomBadge';
      document.body.append(badge);
    }
    badge.textContent = '';
    const t = document.createElement('span');
    if (badgeNote) { t.textContent = badgeNote; badge.append(t); return; }
    t.append('Комната ');
    const b = document.createElement('b'); b.textContent = code; t.append(b);
    t.append(isHost ? ' · вы хозяин' : '');
    const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'Скопировать ссылку';
    btn.addEventListener('click', () => {
      const done = () => { btn.textContent = 'Скопировано'; setTimeout(() => { btn.textContent = 'Скопировать ссылку'; }, 1600); };
      if (navigator.clipboard) navigator.clipboard.writeText(shareLink()).then(done, () => window.prompt('Ссылка на комнату', shareLink()));
      else window.prompt('Ссылка на комнату', shareLink());
    });
    badge.append(t, btn);
  }
  function buildLobby() {
    const style = document.createElement('style'); style.textContent = css; document.head.append(style);
    lobby = document.createElement('div'); lobby.id = 'lobby';
    lobby.innerHTML = `
      <div class="lc" role="dialog" aria-labelledby="lobbyTitle">
        <div class="ey">Прогулка от первого лица</div>
        <h2 id="lobbyTitle">Ветер <em>в поле</em></h2>
        <label for="lobbyName">Ваше имя<input id="lobbyName" type="text" maxlength="24" autocomplete="nickname" placeholder="Например, Жанара"></label>
        <div><div class="ey" style="margin-bottom:8px">Цвет персонажа</div><div class="sw" id="lobbySw"></div></div>
        <button class="pri" type="button" id="lobbyCreate" data-net="1">Создать комнату</button>
        <div class="or">или войдите в комнату друга</div>
        <div class="row"><input id="lobbyCode" type="text" maxlength="5" autocomplete="off" placeholder="КОД" aria-label="Код комнаты"><button class="sec" type="button" id="lobbyJoin" data-net="1">Войти</button></div>
        <div class="st" id="lobbyStatus" role="status"></div>
        <button class="lnk" type="button" id="lobbySolo">Играть одному</button>
      </div>`;
    document.body.append(lobby);
    document.body.classList.add('in-lobby');
    statusEl = lobby.querySelector('#lobbyStatus');
    const nameIn = lobby.querySelector('#lobbyName'), codeIn = lobby.querySelector('#lobbyCode'), sw = lobby.querySelector('#lobbySw');
    nameIn.value = me.name;
    COLORS.forEach(c => {
      const b = document.createElement('button'); b.type = 'button'; b.style.background = c; b.setAttribute('aria-label', 'Цвет ' + c);
      b.setAttribute('aria-pressed', String(c === me.color));
      b.addEventListener('click', () => { me.color = c; store.set('color', c); sw.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); });
      sw.append(b);
    });
    const saveName = () => { me.name = str(nameIn.value, 24); store.set('name', me.name); };
    const params = new URLSearchParams(location.search);
    const pre = str(params.get('room') || '', 5).toUpperCase();
    if (pre) codeIn.value = pre;
    lobby.querySelector('#lobbyCreate').addEventListener('click', () => { saveName(); createRoom(); });
    const join = () => {
      saveName();
      const c = codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (c.length !== 5) { status('Код комнаты — 5 знаков, например K7QPM.'); codeIn.focus(); return; }
      joinRoom(c);
    };
    lobby.querySelector('#lobbyJoin').addEventListener('click', join);
    codeIn.addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
    lobby.querySelector('#lobbySolo').addEventListener('click', () => { saveName(); finish('solo'); });
    if (!window.Peer) status('Нет интернета, поэтому доступна только одиночная игра.');
    setBusy(false);
    (pre ? codeIn : nameIn).focus();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildLobby); else buildLobby();
})();
