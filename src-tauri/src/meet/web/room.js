// The meeting page: pre-join, lobby and room (docs/plans/meet.md). Plain JS, no build step.
// Everything a person typed is put on the page with textContent, never as HTML.
'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const code = location.pathname.split('/')[2] || '';
  const params = new URLSearchParams(location.search);
  let hostToken = params.get('host') || sessionStorage.getItem('zm-host-' + code) || '';
  if (params.get('host')) {
    sessionStorage.setItem('zm-host-' + code, hostToken);
    history.replaceState(null, '', location.pathname);
  }

  const REACTIONS = ['👍', '❤️', '😂', '🎉', '👏'];
  const MAX_PEOPLE = 16;

  // ---- small helpers
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const show = (id) => {
    for (const s of ['loading', 'prejoin', 'lobby', 'over', 'room']) $(s).hidden = s !== id;
  };
  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = (t) => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const duration = (s) => (s >= 3600 ? Math.floor(s / 3600) + ':' : '') + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60);
  const initial = (name) => (Array.from((name || '?').trim())[0] || '?');
  const toast = (text, ms = 3500) => {
    const t = el('div', 'toast', text);
    $('toasts').append(t);
    setTimeout(() => t.remove(), ms);
  };
  // Icons: the same stroke style as the app (src/ui/icons.ts).
  const ICONS = {
    mic: '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5M8.5 20.5h7"/>',
    micOff: '<path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 10.5V6.5a3 3 0 0 0-5.7-1.3M5.5 11.5a6.5 6.5 0 0 0 10.6 5M18.3 13a6.5 6.5 0 0 0 .2-1.5M12 18v2.5M8.5 20.5h7M4 4l16 16"/>',
    cam: '<rect x="3.5" y="6.5" width="12" height="11" rx="2"/><path d="M15.5 10.5l5-3v9l-5-3"/>',
    camOff: '<path d="M7 6.5h6.5a2 2 0 0 1 2 2v3.5M15.5 15.5v.5a1 1 0 0 1-1 1H5.5a2 2 0 0 1-2-2v-6a2 2 0 0 1 1.2-1.8M15.5 10.5l5-3v9l-4-2.4M4 4l16 16"/>',
    share: '<rect x="3" y="4.5" width="18" height="12" rx="1.8"/><path d="M9 20h6M12 16.5V20M12 13V8M9.5 10.3L12 7.8l2.5 2.5"/>',
    hand: '<path d="M8.5 12.5V6a1.5 1.5 0 0 1 3 0v5.5V4.8a1.5 1.5 0 0 1 3 0v6.7V6.3a1.5 1.5 0 0 1 3 0v7.2c0 4-2.5 7-6.3 7-2.6 0-4-1.2-5.4-3.2l-2.4-3.5a1.4 1.4 0 0 1 2.3-1.6l1.8 2.3z"/>',
    smile: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14.2a4.5 4.5 0 0 0 7 0"/><circle cx="9.2" cy="9.8" r=".9" fill="currentColor"/><circle cx="14.8" cy="9.8" r=".9" fill="currentColor"/>',
    chat: '<path d="M5 5h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 17h-8.5L6 20.5V17H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 5z"/><path d="M8 10h8M8 13h5"/>',
    users: '<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="16.5" cy="9.5" r="2.3"/><path d="M15.5 14.2a4.5 4.5 0 0 1 5 4.3"/>',
    hangup: '<g transform="rotate(135 12 12)"><path d="M6.6 4h2.6l1.4 4-1.9 1.3a10.5 10.5 0 0 0 5.9 5.9l1.3-1.9 4 1.4v2.6a2 2 0 0 1-2.2 2A16 16 0 0 1 4.6 6.2 2 2 0 0 1 6.6 4z"/></g>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
  };
  const svg = (name, cls) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', 'i ' + (cls || ''));
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = ICONS[name]; // our own constants, never user text
    return s;
  };
  document.querySelectorAll('[data-i]').forEach((n) => {
    n.append(svg(n.dataset.i, 'ion'));
    if (n.dataset.off) n.append(svg(n.dataset.off, 'ioff'));
  });
  const playAll = () => document.querySelectorAll('#main video, #strip video').forEach((v) => v.play().catch(() => {}));

  // ---- state
  let info = null;
  let isHost = false;
  let ws = null;
  let myId = '';
  let myName = '';
  let meeting = { title: '', kind: 'meeting', recording: false, autoRecord: false };
  let rtcConfig = { iceServers: [] };
  let joinedAt = 0;
  let recOn = false;
  let leaving = false;

  const local = {
    audio: null, video: null, screen: null, micOn: true, camOn: true, hand: false,
    micId: localStorage.getItem('zm-mic') || '', camId: localStorage.getItem('zm-cam') || '',
    cam: new MediaStream(), screenStream: null, note: '',
  };
  const peers = new Map();
  const lobby = new Map();
  let selfTile = null;
  let selfScreenTile = null;
  let unreadChat = 0;
  let panelTab = '';

  // ---- media
  const videoConstraint = () => ({ width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, ...(local.camId ? { deviceId: { exact: local.camId } } : { facingMode: 'user' }) });
  const audioConstraint = () => ({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(local.micId ? { deviceId: { exact: local.micId } } : {}) });

  async function getTrack(kind) {
    try {
      const s = await navigator.mediaDevices.getUserMedia(kind === 'audio' ? { audio: audioConstraint() } : { video: videoConstraint() });
      return s.getTracks()[0];
    } catch (e) {
      if (local[kind === 'audio' ? 'micId' : 'camId']) {
        // The remembered device is gone: use the default one.
        local[kind === 'audio' ? 'micId' : 'camId'] = '';
        try {
          const s = await navigator.mediaDevices.getUserMedia(kind === 'audio' ? { audio: audioConstraint() } : { video: videoConstraint() });
          return s.getTracks()[0];
        } catch (e2) { /* fall through */ }
      }
      return null;
    }
  }

  function setVideoTrack(track) {
    if (local.video) { local.video.stop(); local.cam.removeTrack(local.video); }
    local.video = track;
    if (track) local.cam.addTrack(track);
    track && track.addEventListener('ended', () => { if (local.video === track) { local.camOn = false; setVideoTrack(null); paintControls(); sendState(); } });
    for (const p of peers.values()) if (p.camSender) p.camSender.replaceTrack(track).catch(() => {});
    paintSelf();
  }

  function setAudioTrack(track) {
    if (local.audio) local.audio.stop();
    local.audio = track;
    if (track) track.enabled = local.micOn;
    for (const p of peers.values()) if (p.audioSender) p.audioSender.replaceTrack(track).catch(() => {});
    watchLevel('self', track ? new MediaStream([track]) : null);
    refreshRecAudio();
  }

  async function acquireInitial() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      local.note = 'This browser can’t use a camera or microphone here, so you will join without them.' + (location.protocol === 'http:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1' ? ' (The page must be opened over https.)' : '');
      return;
    }
    const wantCam = local.camOn;
    let a = null, v = null;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint(), video: wantCam ? videoConstraint() : false });
      a = s.getAudioTracks()[0] || null;
      v = s.getVideoTracks()[0] || null;
    } catch (e) {
      a = await getTrack('audio');
      v = wantCam ? await getTrack('video') : null;
    }
    const missing = [];
    if (!a) missing.push('microphone');
    if (!v && wantCam) missing.push('camera');
    local.note = missing.length ? 'No ' + missing.join(' or ') + ' found or allowed. You can still join and see and hear everyone.' : '';
    if (a) { local.audio = a; }
    if (v) { setVideoTrack(v); } else if (wantCam) { local.camOn = false; }
  }

  async function fillDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    let list = [];
    try { list = await navigator.mediaDevices.enumerateDevices(); } catch (e) { return; }
    const fill = (sel, kind, current, wrap) => {
      const devs = list.filter((d) => d.kind === kind);
      sel.replaceChildren();
      devs.forEach((d, i) => {
        const o = el('option', '', d.label || (kind === 'audioinput' ? 'Microphone ' : 'Camera ') + (i + 1));
        o.value = d.deviceId;
        sel.append(o);
      });
      const cur = current || (kind === 'audioinput' ? local.audio : local.video)?.getSettings().deviceId;
      if (cur) sel.value = cur;
      wrap.hidden = devs.length < 2;
    };
    fill($('micSel'), 'audioinput', local.micId, $('micPick'));
    fill($('camSel'), 'videoinput', local.camId, $('camPick'));
  }

  async function toggleMic() {
    if (!local.audio) {
      const t = await getTrack('audio');
      if (!t) { toast('No microphone found or allowed.'); return; }
      local.micOn = true;
      setAudioTrack(t);
    } else {
      local.micOn = !local.micOn;
      local.audio.enabled = local.micOn;
    }
    paintControls(); paintSelf(); sendState();
  }

  async function toggleCam() {
    if (local.video) {
      local.camOn = false;
      setVideoTrack(null);
    } else {
      const t = await getTrack('video');
      if (!t) { toast('No camera found or allowed.'); return; }
      local.camOn = true;
      setVideoTrack(t);
    }
    paintControls(); sendState();
  }

  // ---- pre-join
  function paintControls() {
    const mic = local.audio && local.micOn;
    const cam = !!local.video;
    for (const id of ['pvMic', 'bMic']) {
      const b = $(id);
      b.classList.toggle('off', !mic);
      b.title = !local.audio && !local.micOn ? 'Microphone off' : mic ? 'Mute' : 'Unmute';
    }
    for (const id of ['pvCam', 'bCam']) {
      const b = $(id);
      b.classList.toggle('off', !cam);
      b.title = cam ? 'Turn camera off' : 'Turn camera on';
    }
    $('bHand').classList.toggle('on', local.hand);
    $('bShare').classList.toggle('on', !!local.screen);
    $('bShare').title = local.screen ? 'Stop sharing' : 'Share your screen';
    $('pv').parentElement.classList.toggle('novideo', !cam);
    $('pvInitial').textContent = initial($('pjName').value);
    $('mediaNote').hidden = !local.note;
    $('mediaNote').textContent = local.note;
  }

  async function startPrejoin() {
    $('pjTitle').textContent = info.title;
    document.title = info.title + ' – Meeting';
    $('pjSub').textContent = info.kind === 'call' ? 'Voice call' : 'Video meeting';
    $('recBanner').hidden = !info.recorded;
    const lobbyOn = info.lobby && !info.host;
    $('joinBtn').textContent = lobbyOn ? 'Ask to join' : 'Join';
    $('pjName').value = (info.host && info.hostName) || localStorage.getItem('zm-name') || '';
    local.camOn = info.kind !== 'call';
    show('prejoin');
    $('pv').srcObject = local.cam;
    paintControls();
    await acquireInitial();
    paintControls();
    await fillDevices();
    paintControls();
  }

  async function changeDevice(kind, id) {
    if (kind === 'audio') {
      local.micId = id; localStorage.setItem('zm-mic', id);
      const t = await getTrack('audio');
      if (t) { local.micOn = true; setAudioTrack(t); }
    } else {
      local.camId = id; localStorage.setItem('zm-cam', id);
      const t = await getTrack('video');
      if (t) { local.camOn = true; setVideoTrack(t); }
    }
    paintControls(); sendState();
  }

  // ---- signalling
  const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const sendState = () => send({ t: 'state', audio: !!(local.audio && local.micOn), video: !!local.video, hand: local.hand, sharing: !!local.screen });

  function join() {
    myName = $('pjName').value.trim().slice(0, 40);
    if (!myName) { $('pjName').focus(); toast('Please enter your name.'); return; }
    localStorage.setItem('zm-name', myName);
    // An audio context needs a user gesture: this click is it.
    ensureAudio();
    show('loading');
    connect();
  }

  let pingTimer = 0;
  function connect() {
    leaving = false;
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/' + code);
    ws.onopen = () => {
      send({ t: 'hello', name: myName, host: hostToken || undefined, audio: !!(local.audio && local.micOn), video: !!local.video });
      clearInterval(pingTimer);
      pingTimer = setInterval(() => send({ t: 'ping' }), 20000);
    };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (_) { return; } onMessage(m); };
    ws.onclose = () => {
      clearInterval(pingTimer);
      if (leaving || $('over').hidden === false) return;
      teardown();
      over('Connection lost', 'The connection to the meeting dropped. Check your internet and join again.');
    };
  }

  function over(title, text) {
    show('over');
    $('overTitle').textContent = title;
    $('overText').textContent = text;
  }

  function onMessage(m) {
    switch (m.t) {
      case 'lobby': show('lobby'); break;
      case 'admitted': break;
      case 'welcome': onWelcome(m); break;
      case 'denied': finish('Not let in', m.reason === 'token' ? 'This host link isn’t valid any more. Open the meeting from Zazabor again.' : 'The host didn’t let you in.'); break;
      case 'removed': finish('Removed', 'The host removed you from the meeting.'); break;
      case 'ended': finish('Meeting ended', 'The host ended the meeting for everyone.'); break;
      case 'full': finish('Meeting full', 'This meeting already has ' + MAX_PEOPLE + ' people, the most it allows.'); break;
      case 'error': finish('Meeting not found', 'Check the link, or ask the host for a new one.'); break;
      case 'peer-joined': addPeer(m.peer, false); toast(m.peer.name + ' joined'); break;
      case 'peer-left': { const p = peers.get(m.id); if (p) { toast(p.info.name + ' left'); removePeer(m.id); } break; }
      case 'peer-state': onPeerState(m); break;
      case 'signal': { const p = peers.get(m.from); if (p) p.chain = p.chain.then(() => onSignal(p, m.data)); break; }
      case 'chat': onChat(m); break;
      case 'react': onReact(m); break;
      case 'mute-request': if (local.audio && local.micOn) { local.micOn = false; local.audio.enabled = false; paintControls(); paintSelf(); sendState(); toast('The host asked you to mute.'); } break;
      case 'rec': setRec(m.on); break;
      case 'knock': lobby.set(m.id, m.name); paintLobby(true, m); break;
      case 'knock-gone': lobby.delete(m.id); paintLobby(false, m); break;
      default: break;
    }
  }

  function finish(title, text) {
    leaving = true;
    teardown();
    try { ws && ws.close(); } catch (_) { /* closed */ }
    over(title, text);
  }

  function onWelcome(m) {
    myId = m.id;
    myName = m.name || myName;
    isHost = !!m.host;
    meeting = m.meeting;
    rtcConfig = { iceServers: m.ice || [] };
    joinedAt = Date.now();
    show('room');
    $('roomTitle').textContent = meeting.title;
    $('bEnd').hidden = !isHost;
    $('recToggle').hidden = !isHost;
    $('bShare').hidden = !(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
    selfTile = makeTile('self', true);
    selfTile.video.srcObject = local.cam;
    selfTile.video.muted = true;
    paintSelf();
    for (const p of m.peers) addPeer(p, true);
    setRec(!!meeting.recording, true);
    layout();
    paintControls();
    sendState();
    if (isHost && meeting.autoRecord && !meeting.recording) startRecording();
  }

  // ---- peers
  function makeTile(key, self) {
    const root = el('div', 'tile' + (self ? ' self' : ''));
    const video = document.createElement('video');
    video.autoplay = true; video.playsInline = true;
    const avatar = el('div', 'avatar'); const av = el('span'); avatar.append(av);
    const label = el('div', 'label'); const mic = el('span', 'mic'); mic.append(svg('micOff')); const name = el('span', 'name');
    label.append(mic, name);
    const hand = el('span', 'hand'); hand.append(svg('hand')); hand.hidden = true;
    const fail = el('div', 'fail');
    root.append(video, avatar, label, hand, fail);
    return { key, root, video, av, mic, name, hand, fail };
  }

  function paintTile(t, name, audio, video, hand) {
    t.name.textContent = name;
    t.av.textContent = initial(name);
    t.mic.hidden = !!audio;
    t.root.classList.toggle('novideo', !video);
    t.hand.hidden = !hand;
  }

  function paintSelf() {
    if (!selfTile) return;
    paintTile(selfTile, myName + ' (you)', local.audio && local.micOn, !!local.video, local.hand);
    selfTile.video.srcObject = local.cam;
  }

  function addPeer(info, initiator) {
    if (peers.has(info.id)) return;
    const pc = new RTCPeerConnection(rtcConfig);
    const p = {
      id: info.id, info, pc, polite: myId < info.id, making: false, ignore: false, chain: Promise.resolve(),
      cam: new MediaStream(), screen: null, tile: makeTile(info.id, false), screenTile: null,
      audioSender: null, camSender: null, screenSender: null, bound: false, failTimer: 0, recSource: null,
    };
    peers.set(info.id, p);
    p.tile.video.srcObject = p.cam;
    pc.onicecandidate = (e) => { if (e.candidate) send({ t: 'signal', to: p.id, data: { candidate: e.candidate } }); };
    pc.ontrack = (e) => onTrack(p, e);
    pc.onnegotiationneeded = async () => {
      try {
        p.making = true;
        await pc.setLocalDescription();
        send({ t: 'signal', to: p.id, data: { description: pc.localDescription } });
      } catch (err) { console.warn(err); } finally { p.making = false; }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') { try { pc.restartIce(); } catch (_) { /* old browser */ } }
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        clearTimeout(p.failTimer);
        p.tile.root.classList.remove('failed');
        applyBitrate();
      }
    };
    pc.onsignalingstatechange = () => { if (pc.signalingState === 'stable') applyBitrate(); };
    p.failTimer = setTimeout(() => {
      if (!['connected', 'completed'].includes(pc.iceConnectionState)) {
        p.tile.fail.textContent = 'Couldn’t connect to ' + p.info.name + '’s video';
        p.tile.root.classList.add('failed');
      }
    }, 15000);
    if (initiator) {
      // The newcomer offers: audio, camera and screen, in that order.
      const ta = pc.addTransceiver(local.audio || 'audio', { direction: 'sendrecv' });
      const tv = pc.addTransceiver(local.video || 'video', { direction: 'sendrecv' });
      const ts = pc.addTransceiver(local.screen || 'video', { direction: 'sendrecv' });
      p.audioSender = ta.sender; p.camSender = tv.sender; p.screenSender = ts.sender; p.bound = true;
    }
    paintPeer(p);
    layout();
    applyBitrate();
    refreshRecAudio();
    paintPeople();
  }

  // When an offer creates the transceivers, give them our tracks.
  function bindSenders(p) {
    if (p.bound) return;
    const ts = p.pc.getTransceivers().slice().sort((a, b) => (a.mid === null) - (b.mid === null) || Number(a.mid) - Number(b.mid));
    const audio = ts.find((t) => t.receiver.track.kind === 'audio');
    const videos = ts.filter((t) => t.receiver.track.kind === 'video');
    const set = (t, track) => { if (!t) return null; t.direction = 'sendrecv'; t.sender.replaceTrack(track).catch(() => {}); return t.sender; };
    p.audioSender = set(audio, local.audio);
    p.camSender = set(videos[0], local.video);
    p.screenSender = set(videos[1], local.screen);
    p.bound = true;
  }

  function videoIndex(p, transceiver) {
    const vs = p.pc.getTransceivers().filter((t) => t.receiver.track.kind === 'video').sort((a, b) => (a.mid === null) - (b.mid === null) || Number(a.mid) - Number(b.mid));
    return vs.indexOf(transceiver);
  }

  function onTrack(p, e) {
    const t = e.track;
    if (t.kind === 'audio') {
      p.cam.addTrack(t);
      watchLevel(p.id, p.cam);
      refreshRecAudio();
    } else if (videoIndex(p, e.transceiver) <= 0) {
      p.cam.addTrack(t);
    } else {
      p.screen = new MediaStream([t]);
      paintPeer(p);
      layout();
    }
    playAll();
  }

  function paintPeer(p) {
    const i = p.info;
    paintTile(p.tile, i.name, i.audio, i.video, i.hand);
    if (i.sharing && p.screen && !p.screenTile) {
      p.screenTile = makeTile('screen:' + p.id, false);
      p.screenTile.root.classList.add('screen');
      p.screenTile.video.srcObject = p.screen;
      p.screenTile.name.textContent = i.name + ' is presenting';
      p.screenTile.mic.hidden = true;
    } else if (!i.sharing && p.screenTile) {
      p.screenTile.root.remove();
      p.screenTile = null;
    }
  }

  function onPeerState(m) {
    const p = peers.get(m.id);
    if (!p) return;
    const raised = m.hand && !p.info.hand;
    Object.assign(p.info, { audio: m.audio, video: m.video, hand: m.hand, sharing: m.sharing });
    paintPeer(p);
    layout();
    paintPeople();
    if (raised) toast(p.info.name + ' raised a hand');
  }

  function removePeer(id) {
    const p = peers.get(id);
    if (!p) return;
    clearTimeout(p.failTimer);
    try { p.pc.close(); } catch (_) { /* closed */ }
    p.tile.root.remove();
    if (p.screenTile) p.screenTile.root.remove();
    stopWatch(id);
    peers.delete(id);
    layout();
    applyBitrate();
    refreshRecAudio();
    paintPeople();
  }

  async function onSignal(p, data) {
    const pc = p.pc;
    try {
      if (data.description) {
        const d = data.description;
        const collision = d.type === 'offer' && (p.making || pc.signalingState !== 'stable');
        p.ignore = !p.polite && collision;
        if (p.ignore) return;
        await pc.setRemoteDescription(d);
        if (d.type === 'offer') {
          bindSenders(p);
          await pc.setLocalDescription();
          send({ t: 'signal', to: p.id, data: { description: pc.localDescription } });
        }
      } else if (data.candidate) {
        try { await pc.addIceCandidate(data.candidate); } catch (err) { if (!p.ignore) throw err; }
      }
    } catch (err) { console.warn('signal', err); }
  }

  // The more people, the less each video sends.
  async function applyBitrate() {
    const n = peers.size + 1;
    const cam = n <= 4 ? 1200000 : n <= 8 ? 600000 : 300000;
    const screen = n <= 8 ? 1500000 : 800000;
    for (const p of peers.values()) {
      for (const [sender, cap] of [[p.camSender, cam], [p.screenSender, screen]]) {
        if (!sender || !sender.track) continue;
        try {
          const params = sender.getParameters();
          if (!params.encodings || !params.encodings.length) params.encodings = [{}];
          if (params.encodings[0].maxBitrate === cap) continue;
          params.encodings[0].maxBitrate = cap;
          await sender.setParameters(params);
        } catch (_) { /* not negotiated yet: tried again when it is */ }
      }
    }
  }

  // ---- layout
  function layout() {
    if (!selfTile) return;
    const share = [...peers.values()].find((p) => p.screenTile && p.info.sharing)?.screenTile || (selfScreenTile && local.screen ? selfScreenTile : null);
    const people = [selfTile, ...[...peers.values()].map((p) => p.tile)].map((t) => t.root);
    const main = $('main'), strip = $('strip');
    main.classList.toggle('sharing', !!share);
    if (share) {
      main.replaceChildren(share.root);
      strip.replaceChildren(...people);
      strip.hidden = false;
    } else {
      const n = people.length;
      const portrait = matchMedia('(max-aspect-ratio: 1/1)').matches;
      const cols = portrait ? (n <= 2 ? 1 : 2) : n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
      main.style.setProperty('--cols', String(cols));
      main.replaceChildren(...people);
      strip.replaceChildren();
      strip.hidden = true;
    }
    $('countN').textContent = String(peers.size + 1);
    fitBar();
    playAll();
  }
  // The phone's sheet sits on top of the bar, whatever height the bar has.
  const fitBar = () => document.documentElement.style.setProperty('--bar', $('bottombar').offsetHeight + 'px');
  window.addEventListener('resize', fitBar);
  matchMedia('(max-aspect-ratio: 1/1)').addEventListener('change', layout);

  // ---- speaking ring (WebAudio levels)
  let audioCtx = null;
  const watchers = new Map();
  function ensureAudio() {
    if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { audioCtx = null; } }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  }
  function watchLevel(key, stream) {
    stopWatch(key);
    if (!audioCtx || !stream || !stream.getAudioTracks().length) return;
    try {
      const src = audioCtx.createMediaStreamSource(stream);
      const an = audioCtx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      watchers.set(key, { src, an, data: new Uint8Array(an.fftSize) });
    } catch (_) { /* no audio on this stream */ }
  }
  function stopWatch(key) {
    const w = watchers.get(key);
    if (w) { try { w.src.disconnect(); } catch (_) { /* gone */ } watchers.delete(key); }
  }
  setInterval(() => {
    for (const [key, w] of watchers) {
      w.an.getByteTimeDomainData(w.data);
      let sum = 0;
      for (const v of w.data) { const d = (v - 128) / 128; sum += d * d; }
      const rms = Math.sqrt(sum / w.data.length);
      const tile = key === 'self' ? selfTile : peers.get(key)?.tile;
      if (!tile) continue;
      const on = key === 'self' ? local.micOn : peers.get(key).info.audio;
      tile.root.classList.toggle('speaking', !!on && rms > 0.02);
    }
  }, 120);

  // ---- bottom bar
  async function toggleShare() {
    if (local.screen) { stopShare(); return; }
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15 } }, audio: false });
      const track = s.getVideoTracks()[0];
      local.screen = track;
      local.screenStream = new MediaStream([track]);
      track.addEventListener('ended', stopShare);
      selfScreenTile = makeTile('screen:self', false);
      selfScreenTile.root.classList.add('screen');
      selfScreenTile.video.srcObject = local.screenStream;
      selfScreenTile.video.muted = true;
      selfScreenTile.name.textContent = 'You are presenting';
      selfScreenTile.mic.hidden = true;
      for (const p of peers.values()) if (p.screenSender) p.screenSender.replaceTrack(track).catch(() => {});
      layout(); paintControls(); sendState(); applyBitrate();
    } catch (_) { /* cancelled */ }
  }
  function stopShare() {
    if (!local.screen) return;
    local.screen.stop();
    local.screen = null;
    local.screenStream = null;
    for (const p of peers.values()) if (p.screenSender) p.screenSender.replaceTrack(null).catch(() => {});
    if (selfScreenTile) selfScreenTile.root.remove();
    selfScreenTile = null;
    layout(); paintControls(); sendState();
  }

  function toggleHand() { local.hand = !local.hand; paintControls(); paintSelf(); sendState(); }

  function onReact(m) {
    const tile = m.from === myId ? selfTile : peers.get(m.from)?.tile;
    if (!tile) return;
    const f = el('div', 'float', m.emoji);
    tile.root.append(f);
    setTimeout(() => f.remove(), 2500);
  }

  // ---- chat and people
  function openPanel(tab) {
    if (panelTab === tab) { closePanel(); return; }
    panelTab = tab;
    $('panel').hidden = false;
    $('chatPane').hidden = tab !== 'chat';
    $('peoplePane').hidden = tab !== 'people';
    $('tabChat').classList.toggle('active', tab === 'chat');
    $('tabPeople').classList.toggle('active', tab === 'people');
    if (tab === 'chat') { unreadChat = 0; paintBadges(); $('chatInput').focus(); $('chatLog').scrollTop = 1e9; }
    if (tab === 'people') paintPeople();
  }
  function closePanel() { panelTab = ''; $('panel').hidden = true; }

  function onChat(m) {
    const row = el('div', 'msg' + (m.from === myId ? ' mine' : ''));
    const who = el('span', 'who', m.from === myId ? 'You' : m.name);
    const when = el('span', 'when', hhmm(m.at));
    const text = el('span', 'text', m.text);
    row.append(who, when, text);
    const log = $('chatLog');
    const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    log.append(row);
    if (atEnd) log.scrollTop = 1e9;
    if (panelTab !== 'chat' && m.from !== myId) { unreadChat++; paintBadges(); }
  }

  function paintBadges() {
    $('chatBadge').hidden = unreadChat === 0;
    $('chatBadge').textContent = String(unreadChat);
    const w = isHost ? lobby.size : 0;
    $('peopleBadge').hidden = w === 0;
    $('peopleBadge').textContent = String(w);
  }

  function person(name, st, host) {
    const li = el('li');
    li.append(el('span', 'pname', name));
    if (st) {
      const tags = el('span', 'tags');
      if (!st.audio) tags.append(svg('micOff', 'muted'));
      if (st.hand) tags.append(svg('hand', 'raised'));
      if (tags.childNodes.length) li.append(tags);
    }
    if (host) li.append(el('span', 'tag', host));
    return li;
  }

  function paintPeople() {
    if (!isHost && !selfTile) return;
    const list = $('peopleList');
    list.replaceChildren();
    const me = person(myName + ' (you)', { audio: !!(local.audio && local.micOn), hand: local.hand }, isHost ? 'Host' : '');
    list.append(me);
    for (const p of peers.values()) {
      const li = person(p.info.name, { audio: p.info.audio, hand: p.info.hand }, p.info.host ? 'Host' : '');
      if (isHost && !p.info.host) {
        const mute = el('button', 'chip', 'Mute'); mute.type = 'button';
        mute.onclick = () => { send({ t: 'mute', id: p.id }); toast('Asked ' + p.info.name + ' to mute.'); };
        const rm = el('button', 'chip danger', 'Remove'); rm.type = 'button';
        rm.onclick = () => send({ t: 'remove', id: p.id });
        li.append(mute, rm);
      }
      list.append(li);
    }
    $('waitBox').hidden = !isHost || lobby.size === 0;
    const wl = $('waitList');
    wl.replaceChildren();
    for (const [id, name] of lobby) {
      const li = person(name);
      const ok = el('button', 'chip', 'Admit'); ok.type = 'button'; ok.onclick = () => send({ t: 'admit', id });
      const no = el('button', 'chip danger', 'Deny'); no.type = 'button'; no.onclick = () => send({ t: 'deny', id });
      li.append(ok, no);
      wl.append(li);
    }
    paintBadges();
  }

  function paintLobby(added, m) {
    const box = $('knocks');
    if (added) {
      const k = el('div', 'knock'); k.dataset.id = m.id;
      const t = el('span', '', m.name + ' wants to join');
      const ok = el('button', 'chip', 'Admit'); ok.type = 'button'; ok.onclick = () => send({ t: 'admit', id: m.id });
      const no = el('button', 'chip danger', 'Deny'); no.type = 'button'; no.onclick = () => send({ t: 'deny', id: m.id });
      k.append(t, ok, no);
      box.append(k);
    } else {
      box.querySelectorAll('.knock').forEach((k) => { if (k.dataset.id === m.id) k.remove(); });
    }
    paintPeople();
  }

  // ---- recording state (everyone sees it)
  let recTimer = 0;
  function setRec(on, quiet) {
    const was = recOn;
    recOn = on;
    $('recPill').hidden = !on;
    $('recToggle').textContent = on ? 'Pause recording' : 'Resume recording';
    if (on && !was && !quiet) toast('This meeting is being recorded.');
    if (on && !was && quiet) toast('This meeting is being recorded by the host.');
    if (!on && was && !quiet) toast('Recording stopped.');
    if (isHost && !on && rec.recorder && !rec.stopping) stopRecording();
  }

  // ---- clock
  setInterval(() => { if (joinedAt && !$('room').hidden) $('clock').textContent = duration(Math.floor((Date.now() - joinedAt) / 1000)); }, 1000);

  // ====================================================================
  // The host's recording: a canvas draws the grid, WebAudio mixes the voices, MediaRecorder
  // makes 2 s chunks that are uploaded in order.
  // ====================================================================
  const rec = { recorder: null, id: '', seq: 0, queue: [], sending: false, canvas: null, ctx: null, worker: null, timer: 0, audioCtx: null, dest: null, sources: new Map(), started: 0, stopping: false, failed: false };
  const RW = 1280, RH = 720;

  function recMime() {
    for (const m of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  }

  function refreshRecAudio() {
    if (!rec.audioCtx) return;
    const want = new Map();
    if (local.audio) want.set('self', new MediaStream([local.audio]));
    for (const p of peers.values()) if (p.cam.getAudioTracks().length) want.set(p.id, p.cam);
    for (const [k, s] of rec.sources) {
      const w = want.get(k);
      if (!w || s.stream !== w || s.track !== w.getAudioTracks()[0]) { try { s.node.disconnect(); } catch (_) { /* gone */ } rec.sources.delete(k); }
    }
    for (const [k, s] of want) {
      if (rec.sources.has(k)) continue;
      try {
        const node = rec.audioCtx.createMediaStreamSource(s);
        node.connect(rec.dest);
        rec.sources.set(k, { node, stream: s, track: s.getAudioTracks()[0] });
      } catch (_) { /* no audio */ }
    }
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function drawTile(c, item, x, y, w, h, contain) {
    c.save();
    roundRect(c, x, y, w, h, 14);
    c.clip();
    c.fillStyle = '#10131b';
    c.fillRect(x, y, w, h);
    const v = item.video;
    if (item.hasVideo && v && v.videoWidth > 0) {
      const s = contain ? Math.min(w / v.videoWidth, h / v.videoHeight) : Math.max(w / v.videoWidth, h / v.videoHeight);
      const dw = v.videoWidth * s, dh = v.videoHeight * s;
      if (item.mirror) { c.translate(x + w, y); c.scale(-1, 1); c.drawImage(v, (w - dw) / 2, (h - dh) / 2, dw, dh); c.setTransform(1, 0, 0, 1, 0, 0); }
      else c.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    } else {
      const r = Math.min(w, h) * 0.18;
      c.fillStyle = '#3d6fe0';
      c.beginPath(); c.arc(x + w / 2, y + h / 2, r, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#fff'; c.font = '600 ' + Math.round(r * 1.1) + 'px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(initial(item.name).toUpperCase(), x + w / 2, y + h / 2 + 2);
    }
    c.restore();
    const fs = Math.max(12, Math.min(20, Math.round(h * 0.06)));
    c.font = '600 ' + fs + 'px system-ui, sans-serif';
    c.textAlign = 'left'; c.textBaseline = 'middle';
    const label = item.name + (item.audio === false ? ' (muted)' : '') + (item.hand ? ' (hand raised)' : '');
    const tw = Math.min(w - 16, c.measureText(label).width + 20);
    c.fillStyle = 'rgba(10,12,17,0.6)';
    roundRect(c, x + 8, y + h - fs - 18, tw, fs + 10, (fs + 10) / 2); c.fill();
    c.fillStyle = '#fff';
    c.save(); c.beginPath(); c.rect(x + 8, y + h - fs - 18, tw, fs + 10); c.clip();
    c.fillText(label, x + 18, y + h - fs / 2 - 13);
    c.restore();
  }

  function recItems() {
    const items = [];
    if (selfTile) items.push({ video: selfTile.video, name: myName, audio: !!(local.audio && local.micOn), hasVideo: !!local.video, hand: local.hand, mirror: true });
    for (const p of peers.values()) items.push({ video: p.tile.video, name: p.info.name, audio: p.info.audio, hasVideo: !!p.info.video, hand: p.info.hand });
    return items;
  }

  function drawFrame() {
    const c = rec.ctx;
    if (!c) return;
    c.fillStyle = '#0a0c11';
    c.fillRect(0, 0, RW, RH);
    const people = recItems();
    let share = null;
    if (local.screen && selfScreenTile) share = { video: selfScreenTile.video, name: myName + ' is presenting', hasVideo: true };
    for (const p of peers.values()) if (!share && p.screenTile && p.info.sharing) share = { video: p.screenTile.video, name: p.info.name + ' is presenting', hasVideo: true };
    const gap = 8;
    if (share) {
      const stripH = 130;
      drawTile(c, share, gap, gap, RW - 2 * gap, RH - stripH - 3 * gap, true);
      const shown = people.slice(0, 6);
      const tw = Math.min(210, (RW - gap * (shown.length + 1)) / shown.length);
      shown.forEach((it, i) => drawTile(c, it, gap + i * (tw + gap), RH - stripH - gap, tw, stripH, false));
    } else {
      const n = people.length || 1;
      const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
      const rows = Math.ceil(n / cols);
      const tw = (RW - gap * (cols + 1)) / cols, th = (RH - gap * (rows + 1)) / rows;
      people.forEach((it, i) => {
        const col = i % cols, row = Math.floor(i / cols);
        const inRow = row === rows - 1 ? n - row * cols : cols;
        const off = (cols - inRow) * (tw + gap) / 2;
        drawTile(c, it, gap + off + col * (tw + gap), gap + row * (th + gap), tw, th, false);
      });
    }
    const secs = Math.floor((Date.now() - rec.started) / 1000);
    c.font = '700 20px system-ui, sans-serif'; c.textAlign = 'right'; c.textBaseline = 'top';
    c.fillStyle = 'rgba(10,12,17,0.6)'; roundRect(c, RW - 150, 14, 138, 34, 17); c.fill();
    c.fillStyle = '#ff4d5e'; c.beginPath(); c.arc(RW - 134, 31, 6, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#fff'; c.fillText('REC ' + duration(secs), RW - 22, 20);
  }

  async function startRecording() {
    if (rec.recorder) return;
    const mime = recMime();
    if (!mime || !HTMLCanvasElement.prototype.captureStream) { toast('This browser can’t record the meeting.'); return; }
    rec.stopping = false; rec.failed = false;
    rec.canvas = rec.canvas || Object.assign(document.createElement('canvas'), { width: RW, height: RH });
    rec.ctx = rec.canvas.getContext('2d');
    rec.audioCtx = rec.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (rec.audioCtx.state === 'suspended') rec.audioCtx.resume().catch(() => {});
    rec.dest = rec.audioCtx.createMediaStreamDestination();
    rec.sources.clear();
    refreshRecAudio();
    rec.started = Date.now();
    drawFrame();
    const stream = new MediaStream([...rec.canvas.captureStream(30).getVideoTracks(), ...rec.dest.stream.getAudioTracks()]);
    rec.id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    rec.seq = 0; rec.queue = [];
    let r;
    try { r = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2500000, audioBitsPerSecond: 128000 }); }
    catch (e) { toast('The recording couldn’t start.'); return; }
    rec.recorder = r;
    r.ondataavailable = (e) => { if (e.data && e.data.size) { rec.queue.push({ seq: rec.seq++, blob: e.data, id: rec.id }); pump(); } };
    r.onstop = () => { rec.recorder = null; stopTicker(); };
    startTicker();
    send({ t: 'rec', on: true });
    r.start(2000);
  }

  function startTicker() {
    stopTicker();
    try {
      rec.worker = new Worker('/assets/tick.js');
      rec.worker.onmessage = drawFrame;
      rec.worker.postMessage(33);
    } catch (_) { rec.timer = setInterval(drawFrame, 33); }
  }
  function stopTicker() {
    if (rec.worker) { rec.worker.postMessage(0); rec.worker.terminate(); rec.worker = null; }
    clearInterval(rec.timer);
  }

  async function pump() {
    if (rec.sending) return;
    rec.sending = true;
    let fails = 0;
    while (rec.queue.length) {
      const c = rec.queue[0];
      try {
        const res = await fetch('/rec/' + code + '?host=' + encodeURIComponent(hostToken) + '&rec=' + c.id + '&seq=' + c.seq, { method: 'POST', body: c.blob });
        if (res.ok) { rec.queue.shift(); fails = 0; continue; }
        if (res.status === 409 || res.status === 403 || res.status === 404) { rec.queue.shift(); if (!rec.failed) { rec.failed = true; toast('The recording lost a piece.'); } continue; }
        throw new Error(String(res.status));
      } catch (_) {
        fails++;
        if (fails > 20) { rec.queue.length = 0; toast('The recording couldn’t be saved.'); break; }
        await new Promise((r) => setTimeout(r, Math.min(1000 * fails, 5000)));
      }
    }
    rec.sending = false;
  }

  function stopRecording() {
    const r = rec.recorder;
    if (!r || rec.stopping) return;
    rec.stopping = true;
    try { r.stop(); } catch (_) { /* already stopped */ }
    rec.stopping = false;
  }

  async function toggleRecording() {
    if (recOn) { stopRecording(); send({ t: 'rec', on: false }); }
    else await startRecording();
  }

  // ---- leaving
  function teardown() {
    if (rec.recorder) stopRecording();
    stopShare();
    for (const id of [...peers.keys()]) removePeer(id);
    stopWatch('self');
    lobby.clear();
    $('knocks').replaceChildren();
    closePanel();
  }

  function leave() {
    leaving = true;
    teardown();
    try { ws && ws.close(); } catch (_) { /* closed */ }
    for (const t of [local.audio, local.video]) if (t) t.stop();
    local.audio = null; local.video = null;
    over('You left the meeting', isHost ? 'The meeting stays open for the others. Use End for everyone to close it for all.' : 'You can join again while the meeting is open.');
  }

  let endArmed = 0;
  function endForAll() {
    if (!endArmed) {
      $('bEnd').classList.add('confirm');
      $('bEnd').textContent = 'Click again to end';
      endArmed = setTimeout(() => { endArmed = 0; $('bEnd').classList.remove('confirm'); $('bEnd').textContent = 'End for everyone'; }, 4000);
      return;
    }
    clearTimeout(endArmed); endArmed = 0;
    send({ t: 'end' });
  }

  window.addEventListener('pagehide', () => { if (rec.recorder) stopRecording(); });

  // ---- wiring
  $('joinBtn').onclick = join;
  $('pjName').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  $('pjName').addEventListener('input', () => { $('pvInitial').textContent = initial($('pjName').value); });
  $('pvMic').onclick = toggleMic; $('bMic').onclick = toggleMic;
  $('pvCam').onclick = toggleCam; $('bCam').onclick = toggleCam;
  $('micSel').onchange = (e) => changeDevice('audio', e.target.value);
  $('camSel').onchange = (e) => changeDevice('video', e.target.value);
  $('bShare').onclick = toggleShare;
  $('bHand').onclick = toggleHand;
  $('bReact').onclick = () => { $('reactMenu').hidden = !$('reactMenu').hidden; };
  $('reactMenu').addEventListener('click', (e) => {
    const emoji = e.target.dataset && e.target.dataset.e;
    if (emoji && REACTIONS.includes(emoji)) { send({ t: 'react', emoji }); $('reactMenu').hidden = true; }
  });
  $('bChat').onclick = () => openPanel('chat');
  $('bPeople').onclick = () => openPanel('people');
  $('tabChat').onclick = () => { panelTab = ''; openPanel('chat'); };
  $('tabPeople').onclick = () => { panelTab = ''; openPanel('people'); };
  $('panelClose').onclick = closePanel;
  $('chatForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('chatInput').value.trim();
    if (text) send({ t: 'chat', text });
    $('chatInput').value = '';
  };
  $('admitAll').onclick = () => { for (const id of [...lobby.keys()]) send({ t: 'admit', id }); };
  $('recToggle').onclick = toggleRecording;
  $('bEnd').onclick = endForAll;
  $('bLeave').onclick = leave;
  $('lobbyLeave').onclick = () => { leaving = true; try { ws.close(); } catch (_) { /* closed */ } location.reload(); };
  $('rejoinBtn').onclick = () => location.reload();
  document.addEventListener('click', (e) => { if (!e.target.closest('.react-wrap')) $('reactMenu').hidden = true; });

  // ---- start
  (async () => {
    if (!/^[a-z2-9]{10}$/.test(code)) { over('Meeting not found', 'Check the link, or ask the host for a new one.'); $('rejoinBtn').hidden = true; return; }
    try {
      const res = await fetch('/api/info/' + code + (hostToken ? '?host=' + encodeURIComponent(hostToken) : ''), { cache: 'no-store' });
      if (!res.ok) throw new Error('not found');
      info = await res.json();
    } catch (_) { over('Meeting not found', 'Check the link, or ask the host for a new one.'); $('rejoinBtn').hidden = true; return; }
    if (!info.host) hostToken = '';
    startPrejoin();
  })();
})();
