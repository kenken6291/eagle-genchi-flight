/* ==============================================================
 * 現地集合フライト  app.js
 * 認証 / 地図 / 行き先選定（ダーツ・気分・ミステリー）/ フライト / 現地広場 / 管理
 * ============================================================== */
(() => {
  'use strict';

  const C = window.APP_CONFIG;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const validCoord = s => Number.isFinite(s.lat) && Number.isFinite(s.lng);

  const S = {
    token: null, user: null,
    spots: [], map: null, markers: new Map(), selected: null,
    busy: false, flight: null, plaza: null,
    sound: true, audio: null, audioUrl: null,
    importItems: [],
    mapsKey: ''   // GOOGLE_MAPS_API_KEY（ログイン後にGASから受け取る。ファイルには書かない）
  };

  /* =============================================================
   * セッション
   * ============================================================= */
  function saveSession(remember) {
    const v = JSON.stringify({ token: S.token, user: S.user });
    (remember ? localStorage : sessionStorage).setItem(C.SESSION_KEY, v);
    (remember ? sessionStorage : localStorage).removeItem(C.SESSION_KEY);
  }
  function loadSession() {
    try {
      const raw = sessionStorage.getItem(C.SESSION_KEY) || localStorage.getItem(C.SESSION_KEY);
      if (!raw) return false;
      const o = JSON.parse(raw);
      S.token = o.token; S.user = o.user;
      return !!S.token;
    } catch { return false; }
  }
  function updateStoredUser() {
    for (const st of [sessionStorage, localStorage]) {
      const raw = st.getItem(C.SESSION_KEY);
      if (raw) { const o = JSON.parse(raw); o.user = S.user; st.setItem(C.SESSION_KEY, JSON.stringify(o)); }
    }
  }
  function clearSession() {
    sessionStorage.removeItem(C.SESSION_KEY);
    localStorage.removeItem(C.SESSION_KEY);
    S.token = null; S.user = null; S.mapsKey = '';
  }

  /* =============================================================
   * API
   * ============================================================= */
  class ApiError extends Error { constructor(m, c) { super(m); this.code = c; } }

  async function api(action, data = {}) {
    if (!isGasConfigured()) {
      openSettings('gas');
      throw new ApiError('サーバー（GAS URL）が未設定です。設定画面で入力してください', 'no_gas_url');
    }
    let j;
    try {
      const r = await fetch(gasUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, token: S.token, ...data })
      });
      j = await r.json();
    } catch {
      throw new ApiError('サーバーに接続できません。通信状況を確認してください', 'network');
    }
    if (!j.ok) {
      if (j.error === 'auth_required') handleExpired(j.message);
      else if (j.error === 'must_change') openPwModal(true);
      throw new ApiError(j.message || 'エラーが発生しました', j.error);
    }
    return j;
  }

  function handleExpired(msg) {
    leavePlaza(true);
    closeFlight();
    clearSession();
    showView('auth');
    toast(msg || 'もう一度ログインしてください', true);
  }

  /* =============================================================
   * 共通UI
   * ============================================================= */
  function showView(name) {
    $('#authView').hidden = name !== 'auth';
    $('#appView').hidden = name !== 'app';
    $('#plazaView').hidden = name !== 'plaza';
    if (name === 'app' && S.map) setTimeout(() => S.map.invalidateSize(), 50);
  }

  function toast(msg, isError = false) {
    const el = document.createElement('div');
    el.className = 'toast' + (isError ? ' is-error' : '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), isError ? 6000 : 3500);
  }

  function loading(text) {
    const el = $('#loading');
    if (text === false) { el.hidden = true; return; }
    $('#loadingText').textContent = text || '読み込み中…';
    el.hidden = false;
  }

  async function busyButton(btn, fn) {
    if (btn.disabled) return;
    btn.disabled = true;
    try { return await fn(); }
    finally { btn.disabled = false; }
  }

  function openModal(id, forced = false) {
    const m = $(id);
    m.hidden = false;
    m.classList.toggle('is-forced', forced);
    const f = $('input, select, textarea, button', m);
    if (f) setTimeout(() => f.focus(), 30);
  }
  function closeModal(id) { $(id).hidden = true; }

  document.addEventListener('click', e => {
    const tg = e.target.closest('.pw-toggle');
    if (tg) {
      const input = tg.parentElement.querySelector('input');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      tg.classList.toggle('is-on', show);
      tg.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示');
      return;
    }
    const cl = e.target.closest('[data-close]');
    if (cl) { const m = cl.closest('.modal'); if (!m.classList.contains('is-forced')) m.hidden = true; }
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    $$('.modal').forEach(m => { if (!m.hidden && !m.classList.contains('is-forced')) m.hidden = true; });
  });

  /* ---------- 音声 ---------- */
  function b64ToUrl(b64, mime) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: mime || 'audio/wav' }));
  }
  function playVoice(audio) {
    stopVoice();
    if (!audio || !audio.base64 || !S.sound) return null;
    S.audioUrl = b64ToUrl(audio.base64, audio.mime);
    S.audio = new Audio(S.audioUrl);
    S.audio.play().catch(() => {});
    return S.audio;
  }
  function stopVoice() {
    if (S.audio) { S.audio.pause(); S.audio = null; }
    if (S.audioUrl) { URL.revokeObjectURL(S.audioUrl); S.audioUrl = null; }
  }

  /* ---------- 効果音・歌（Web Audio） ---------- */
  const Music = {
    ctx: null, bgmTimer: null,
    ensure() {
      if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    },
    tone(midi, start, dur, type = 'triangle', gain = 0.08) {
      const c = this.ensure();
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(gain, start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      o.connect(g).connect(c.destination);
      o.start(start); o.stop(start + dur + 0.05);
    },
    // オリジナルの短いメロディ（ペンタトニック）
    SONGS: [
      [[67,1],[69,1],[72,2],[74,1],[72,1],[69,2],[67,1],[64,1],[67,2],[69,1],[72,1],[74,4]],
      [[72,1],[74,1],[76,2],[79,2],[76,1],[74,1],[72,2],[69,2],[72,1],[74,1],[72,4]],
      [[64,1],[67,1],[69,1],[72,1],[69,2],[67,2],[64,1],[62,1],[64,2],[67,4]]
    ],
    song(idx) {
      if (!S.sound) return;
      const c = this.ensure();
      const mel = this.SONGS[Math.abs(idx) % this.SONGS.length];
      let t = c.currentTime + 0.05;
      const beat = 0.22;
      mel.forEach(([n, d]) => { this.tone(n, t, d * beat * 0.95, 'triangle', 0.09); this.tone(n - 12, t, d * beat * 0.95, 'sine', 0.04); t += d * beat; });
    },
    sizzle() {
      if (!S.sound) return;
      const c = this.ensure();
      const len = c.sampleRate * 1.2;
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) * 0.25;
      const src = c.createBufferSource(); src.buffer = buf;
      const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 2500;
      src.connect(f).connect(c.destination); src.start();
    },
    chime() {
      if (!S.sound) return;
      const c = this.ensure(); const t = c.currentTime;
      this.tone(84, t, 0.3, 'sine', 0.06); this.tone(88, t + 0.08, 0.4, 'sine', 0.05);
    },
    bgmStart() {
      this.bgmStop();
      const chords = [[60, 64, 67], [57, 60, 64], [65, 69, 72], [67, 71, 74]];
      let i = 0;
      const play = () => {
        const c = this.ensure();
        const t = c.currentTime + 0.05;
        chords[i % chords.length].forEach(n => this.tone(n, t, 1.8, 'sine', 0.025));
        this.tone(chords[i % chords.length][0] - 12, t, 1.8, 'sine', 0.03);
        i++;
      };
      play();
      this.bgmTimer = setInterval(play, 2000);
    },
    bgmStop() { clearInterval(this.bgmTimer); this.bgmTimer = null; }
  };

  /* =============================================================
   * 認証
   * ============================================================= */
  function authMsg(html, isError = false) {
    const el = $('#authMsg');
    el.innerHTML = html;
    el.classList.toggle('is-error', isError);
    el.hidden = !html;
  }

  function switchAuthTab(tab) {
    $$('.auth-tab').forEach(b => b.classList.toggle('is-active', b.dataset.tab === tab));
    $$('.auth-form').forEach(f => { f.hidden = f.dataset.form !== tab; });
    authMsg('');
  }

  function initAuth() {
    $$('.auth-tab').forEach(b => b.addEventListener('click', () => switchAuthTab(b.dataset.tab)));

    $('#loginForm').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      await busyButton($('button[type=submit]', f), async () => {
        try {
          authMsg('');
          const r = await api('login', { email: f.email.value, password: f.password.value });
          S.token = r.token; S.user = r.user;
          saveSession(f.remember.checked);
          f.password.value = '';
          await enterApp();
        } catch (err) { authMsg(esc(err.message), true); }
      });
    });

    $('#registerForm').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      await busyButton($('button[type=submit]', f), async () => {
        try {
          const email = f.email.value;
          const r = await api('register', { email, nickname: f.nickname.value });
          f.reset();
          switchAuthTab('login');
          $('#loginForm').email.value = email;
          let html = esc(r.message);
          if (r.tempPassword) {
            html += `<div class="temp-pw"><code>${esc(r.tempPassword)}</code><button type="button" class="btn btn-ghost btn-sm" id="btnCopyTemp">コピー</button></div>`;
          }
          authMsg(html);
          const cp = $('#btnCopyTemp');
          if (cp) cp.addEventListener('click', () => {
            navigator.clipboard?.writeText(r.tempPassword);
            $('#loginForm').password.value = r.tempPassword;
            toast('仮パスワードを入力欄に入れました');
          });
        } catch (err) { authMsg(esc(err.message), true); }
      });
    });

    $('#resetForm').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      await busyButton($('button[type=submit]', f), async () => {
        try {
          const email = f.email.value;
          const r = await api('resetPassword', { email });
          switchAuthTab('login');
          $('#loginForm').email.value = email;
          authMsg(esc(r.message));
        } catch (err) { authMsg(esc(err.message), true); }
      });
    });

    $('#btnLogout').addEventListener('click', async () => {
      api('logout').catch(() => {});
      clearSession();
      showView('auth');
      toast('ログアウトしました');
    });
  }

  /* ---------- パスワード変更 ---------- */
  function openPwModal(forced) {
    $('#pwLead').hidden = !forced;
    $('#pwTitle').textContent = forced ? '新しいパスワードを設定' : 'パスワード変更';
    $('#pwForm').reset();
    openModal('#pwModal', forced);
  }

  function initPwModal() {
    $('#pwForm').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      if (f.next.value !== f.confirm.value) { toast('確認用のパスワードが一致しません', true); return; }
      await busyButton($('button[type=submit]', f), async () => {
        try {
          const wasForced = $('#pwModal').classList.contains('is-forced');
          const r = await api('changePassword', { current: f.current.value, newPassword: f.next.value });
          S.user = r.user; updateStoredUser();
          closeModal('#pwModal');
          $('#pwModal').classList.remove('is-forced');
          toast(r.message);
          if (wasForced) await loadSpots();
        } catch (err) { toast(err.message, true); }
      });
    });
  }

  /* ---------- プロフィール ---------- */
  function initProfile() {
    $('#btnProfile').addEventListener('click', () => {
      const f = $('#profileForm');
      f.nickname.value = S.user.nickname;
      const box = $('#avatarChoices');
      box.innerHTML = C.AVATARS.map(a => `<button type="button" data-av="${a}" class="${a === S.user.avatar ? 'is-on' : ''}" aria-label="${a}">${a}</button>`).join('');
      openModal('#profileModal');
    });
    $('#avatarChoices').addEventListener('click', e => {
      const b = e.target.closest('[data-av]');
      if (!b) return;
      $$('#avatarChoices button').forEach(x => x.classList.toggle('is-on', x === b));
    });
    $('#btnOpenPw').addEventListener('click', () => { closeModal('#profileModal'); openPwModal(false); });
    $('#profileForm').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      const av = $('#avatarChoices .is-on')?.dataset.av || S.user.avatar;
      await busyButton($('button[type=submit]', f), async () => {
        try {
          const r = await api('updateProfile', { nickname: f.nickname.value, avatar: av });
          S.user = r.user; updateStoredUser(); renderUserChip();
          closeModal('#profileModal');
          toast(r.message);
        } catch (err) { toast(err.message, true); }
      });
    });
  }

  function renderUserChip() {
    $('#userAvatar').textContent = S.user?.avatar || '🙂';
    $('#userName').textContent = S.user?.nickname || '';
    $('#btnAdmin').hidden = S.user?.role !== 'admin';
  }

  async function enterApp() {
    showView('app');
    renderUserChip();
    initMap();
    if (S.user?.mustChange) { openPwModal(true); return; }
    await Promise.all([loadClientConfig(), loadSpots()]);
  }

  /* ---------- スクリプトプロパティ由来の設定（Google Maps APIキー等） ---------- */
  async function loadClientConfig() {
    try {
      const r = await api('clientConfig');
      S.mapsKey = r.mapsApiKey || '';
    } catch { S.mapsKey = ''; }
    if (S.selected && !$('#spotCard').hidden) selectSpot(S.selected.spot_id, { fly: false });
  }

  // Maps Embed API の URL（mode: view=上空 / streetview=現地の景色）
  function mapsEmbedUrl(spot, mode) {
    if (!S.mapsKey || !validCoord(spot)) return '';
    const k = encodeURIComponent(S.mapsKey);
    const ll = `${spot.lat},${spot.lng}`;
    return mode === 'streetview'
      ? `https://www.google.com/maps/embed/v1/streetview?key=${k}&location=${ll}&heading=${Math.floor(Math.random() * 360)}&pitch=5&fov=90&language=ja`
      : `https://www.google.com/maps/embed/v1/view?key=${k}&center=${ll}&zoom=16&maptype=satellite&language=ja`;
  }

  /* =============================================================
   * 地図・スポット
   * ============================================================= */
  const catOf = c => C.CATEGORIES[c] || C.CATEGORIES['その他'];

  function initMap() {
    if (S.map) { setTimeout(() => S.map.invalidateSize(), 50); return; }
    S.map = L.map('map', { worldCopyJump: true }).setView(C.MAP.center, C.MAP.zoom);
    L.tileLayer(C.MAP.tile, { attribution: C.MAP.attribution, maxZoom: 18 }).addTo(S.map);
  }

  async function loadSpots() {
    loading('スポットを読み込み中…');
    try {
      const r = await api('getSpots');
      S.spots = r.spots || [];
      renderMarkers();
      renderSpotList();
      fillCategorySelects();
      if (S.spots.length) fitAll();
      else captainSay('まだ行き先が登録されておらんぞ。管理者に取り込みを頼むのじゃ！');
    } catch (err) {
      if (err.code !== 'must_change' && err.code !== 'auth_required') toast(err.message, true);
    } finally { loading(false); }
  }

  function renderMarkers() {
    S.markers.forEach(m => m.remove());
    S.markers.clear();
    S.spots.filter(validCoord).forEach(sp => {
      const icon = L.divIcon({
        className: 'pin',
        html: `<span class="pin-body"><span>${catOf(sp.category).emoji}</span></span>`,
        iconSize: [40, 48], iconAnchor: [20, 46]
      });
      const m = L.marker([sp.lat, sp.lng], { icon, title: sp.name, keyboard: true })
        .addTo(S.map)
        .on('click', () => selectSpot(sp.spot_id));
      S.markers.set(sp.spot_id, m);
    });
  }

  function fitAll() {
    const pts = S.spots.filter(validCoord).map(s => [s.lat, s.lng]);
    if (pts.length === 1) S.map.setView(pts[0], 9);
    else if (pts.length) S.map.fitBounds(pts, { padding: [50, 50] });
  }

  function fillCategorySelects() {
    const cats = Object.keys(C.CATEGORIES);
    $('#catFilter').innerHTML = '<option value="">すべて</option>' + cats.map(c => `<option>${esc(c)}</option>`).join('');
    $('#addSpotForm').category.innerHTML = cats.map(c => `<option>${esc(c)}</option>`).join('');
  }

  function renderSpotList() {
    const q = $('#spotSearch').value.trim();
    const cat = $('#catFilter').value;
    const list = S.spots.filter(s => (!q || s.name.includes(q)) && (!cat || s.category === cat));
    $('#spotList').innerHTML = list.length
      ? list.map(s => `<li><button data-id="${esc(s.spot_id)}" class="${S.selected?.spot_id === s.spot_id ? 'is-selected' : ''}">
          <span>${catOf(s.category).emoji}</span><span>${esc(s.name)}</span><span class="cat">${esc(s.category)}</span></button></li>`).join('')
      : '<li class="empty">該当するスポットがありません</li>';
  }

  function selectSpot(id, { fly = true } = {}) {
    const sp = S.spots.find(s => s.spot_id === id);
    if (!sp) return;
    S.selected = sp;
    S.markers.forEach((m, k) => m.getElement()?.classList.toggle('is-selected', k === id));
    if (fly && validCoord(sp)) S.map.flyTo([sp.lat, sp.lng], Math.max(S.map.getZoom(), 9), { duration: reducedMotion ? 0 : 1.2 });
    renderSpotList();
    const card = $('#spotCard');
    card.innerHTML = `
      <h3>${catOf(sp.category).emoji} ${esc(sp.name)}</h3>
      <div class="meta">${esc(sp.category)}</div>
      <p>${esc(sp.description || '説明はまだありません')}</p>
      <div class="tags">${sp.activity_tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      ${S.mapsKey ? `<div class="filter-row">
        <button type="button" class="btn btn-ghost btn-sm" data-peek="view">上空から見る</button>
        <button type="button" class="btn btn-ghost btn-sm" data-peek="streetview">現地の景色</button></div>
        <div class="peek" hidden></div>` : ''}
      <button class="btn btn-primary btn-big" data-fly="${esc(sp.spot_id)}">ここへ飛ぶ</button>`;
    card.hidden = false;
  }

  function captainSay(text, ms = 7000) {
    const dock = $('#captainDock');
    $('#captainText').textContent = text;
    dock.hidden = false;
    clearTimeout(captainSay.t);
    captainSay.t = setTimeout(() => { dock.hidden = true; }, ms);
  }

  function initPanel() {
    $$('.panel-tab').forEach(b => b.addEventListener('click', () => {
      $$('.panel-tab').forEach(x => x.classList.toggle('is-active', x === b));
      $$('.tab-body').forEach(x => { x.hidden = x.dataset.body !== b.dataset.tab; });
    }));
    $('#spotCard').addEventListener('click', e => {
      const b = e.target.closest('[data-peek]');
      if (!b || !S.selected) return;
      const box = $('.peek', e.currentTarget);
      const mode = b.dataset.peek;
      if (!box.hidden && box.dataset.mode === mode) { box.hidden = true; box.innerHTML = ''; return; }
      box.dataset.mode = mode;
      box.innerHTML = `<iframe src="${esc(mapsEmbedUrl(S.selected, mode))}" loading="lazy" allowfullscreen
        referrerpolicy="no-referrer-when-downgrade" title="${mode === 'view' ? '上空からの眺め' : '現地の景色'}"></iframe>`;
      box.hidden = false;
    });
    $('#spotSearch').addEventListener('input', renderSpotList);
    $('#catFilter').addEventListener('change', renderSpotList);
    $('#spotList').addEventListener('click', e => {
      const b = e.target.closest('[data-id]');
      if (b) selectSpot(b.dataset.id);
    });
    document.addEventListener('click', e => {
      const b = e.target.closest('[data-fly]');
      if (b) startFlight(S.spots.find(s => s.spot_id === b.dataset.fly));
    });

    $('#btnDart').addEventListener('click', throwDart);

    $('#moodChips').innerHTML = C.MOODS.map(m => `<button type="button" class="chip">${esc(m)}</button>`).join('');
    $('#moodChips').addEventListener('click', e => {
      const b = e.target.closest('.chip');
      if (!b) return;
      b.classList.toggle('is-on');
      $('#moodText').value = $$('#moodChips .chip.is-on').map(x => x.textContent).join('、');
    });
    $('#btnMood').addEventListener('click', e => busyButton(e.currentTarget, askMood));

    $('#btnMystery').addEventListener('click', () => {
      const pool = S.spots.filter(validCoord);
      if (!pool.length) { toast('スポットがまだありません', true); return; }
      startFlight(pick(pool), { mystery: true });
    });
  }

  /* ---------- 風まかせダーツ ---------- */
  async function throwDart() {
    const pool = S.spots.filter(validCoord);
    if (S.busy || !pool.length) { if (!pool.length) toast('スポットがまだありません', true); return; }
    S.busy = true;
    $('#btnDart').disabled = true;
    const dart = $('#dart');
    dart.hidden = true;
    try {
      fitAll();
      await sleep(reducedMotion ? 100 : 800);
      const target = pick(pool);
      const order = shuffle(pool);
      const steps = reducedMotion ? 1 : Math.max(16, Math.min(28, pool.length * 3));
      let delay = 55;
      for (let i = 0; i < steps; i++) {
        const sp = i === steps - 1 ? target : order[i % order.length];
        S.markers.forEach((m, k) => m.getElement()?.classList.toggle('is-hot', k === sp.spot_id));
        if (S.sound) Music.tone(72 + (i % 5) * 2, Music.ensure().currentTime, 0.05, 'square', 0.02);
        await sleep(delay);
        delay *= 1.11;
      }
      const el = S.markers.get(target.spot_id)?.getElement();
      if (el) {
        const r = el.getBoundingClientRect();
        const tx = r.left + r.width / 2, ty = r.top + 8;
        const sx = innerWidth / 2, sy = innerHeight + 40;
        const angle = Math.atan2(ty - sy, tx - sx) * 180 / Math.PI + 90;
        dart.hidden = false;
        dart.classList.remove('stuck');
        if (!reducedMotion) {
          const anim = dart.animate([
            { transform: `translate(${sx}px,${sy}px) rotate(${angle}deg) scale(1.7)` },
            { transform: `translate(${(sx + tx) / 2}px,${Math.min(sy, ty) - 140}px) rotate(${angle + 360}deg) scale(1.3)`, offset: 0.55 },
            { transform: `translate(${tx}px,${ty}px) rotate(${angle + 720}deg) scale(1)` }
          ], { duration: 1100, easing: 'cubic-bezier(.3,.05,.35,1)', fill: 'forwards' });
          await anim.finished;
        } else {
          dart.style.transform = `translate(${tx}px,${ty}px) rotate(${angle}deg)`;
        }
        dart.classList.add('stuck');
        Music.chime();
      }
      S.markers.forEach(m => m.getElement()?.classList.remove('is-hot'));
      captainSay(`風が決めたぞ！ 今日の行き先は「${target.name}」じゃ！`);
      await sleep(1200);
      dart.hidden = true;
      selectSpot(target.spot_id);
    } finally {
      S.busy = false;
      $('#btnDart').disabled = false;
    }
  }

  /* ---------- 今日の気分 ---------- */
  async function askMood() {
    const mood = $('#moodText').value.trim();
    if (!mood) { toast('気分を選ぶか入力してください', true); return; }
    loading('隊長が風を読んでおる…');
    try {
      const r = await api('recommend', { mood });
      const sp = S.spots.find(s => s.spot_id === r.spot_id);
      const box = $('#moodResult');
      box.innerHTML = `<p><strong>🦅 ${esc(r.message)}</strong></p>
        <p>おすすめ：${esc(sp?.name || '')}</p>
        <div class="filter-row">
          <button type="button" class="btn btn-ghost btn-sm" id="btnMoodVoice">隊長の声で聞く</button>
          <button type="button" class="btn btn-primary btn-sm" data-fly="${esc(r.spot_id)}">ここへ飛ぶ</button>
        </div>`;
      box.hidden = false;
      $('#btnMoodVoice').addEventListener('click', ev => busyButton(ev.currentTarget, async () => {
        try { const v = await api('speak', { text: r.message }); playVoice(v.audio); }
        catch (err) { toast(err.message, true); }
      }));
      if (sp) selectSpot(sp.spot_id);
      captainSay(r.message);
    } catch (err) { toast(err.message, true); }
    finally { loading(false); }
  }

  /* =============================================================
   * フライト
   * ============================================================= */
  function mediaFor(url) {
    url = String(url || '').trim();
    if (!url) return null;
    const m = url.match(/\/d\/([\w-]{20,})/) || url.match(/[?&]id=([\w-]{20,})/);
    const id = m ? m[1] : (/^[\w-]{20,}$/.test(url) ? url : null);
    if (id) return { type: 'iframe', src: C.DRIVE.VIDEO_PREVIEW.replace('{id}', id) };
    if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) return { type: 'video', src: url };
    if (/^https?:\/\//.test(url)) return { type: 'iframe', src: url };
    return null;
  }

  function renderFlightMedia(spot) {
    const box = $('#flightMedia');
    const md = mediaFor(spot.flight_video_url);
    if (md?.type === 'video') {
      box.innerHTML = `<video src="${esc(md.src)}" playsinline preload="auto"></video>`;
      $('video', box).addEventListener('ended', enableArrive);
    } else if (md?.type === 'iframe') {
      box.innerHTML = `<iframe src="${esc(md.src)}" allow="autoplay; fullscreen" allowfullscreen title="フライト映像"></iframe>`;
    } else {
      const clouds = Array.from({ length: 5 }, (_, i) =>
        `<span class="cloud" style="top:${10 + i * 16}%;animation-duration:${9 + i * 3}s;animation-delay:-${i * 2.5}s">☁️</span>`).join('');
      box.innerHTML = `<div class="flight-fallback">${clouds}<span class="glider">🦅</span></div>`;
    }
  }

  async function startFlight(spot, { mystery = false } = {}) {
    if (!spot) return;
    stopVoice();
    S.flight = { spot, mystery, script: '', audioData: null, guess: null, subTimer: null };
    const v = $('#flightView');
    v.hidden = false;
    v.classList.toggle('is-mystery', mystery);
    $('#revealBox').hidden = true;
    $('#flightDest').textContent = mystery ? '行き先：？？？（ミステリーフライト）' : `行き先：${spot.name}`;
    $('#flightSub').textContent = '';
    $('#btnTakeoff').hidden = true;
    $('#btnArrive').disabled = true;
    $('#mysteryBox').hidden = true;
    renderFlightMedia(spot);
    setFlightStatus('イーグル隊長が飛行計画を立てておる…');

    const f = S.flight;
    try {
      const r = await api('narration', { spot_id: spot.spot_id, mode: mystery ? 'mystery' : 'flight' });
      if (S.flight !== f) return;
      f.script = r.script || '';
      f.audioData = r.audio || null;
      if (r.audioError) toast('音声を作れなかったので、字幕だけで案内します', true);
      setFlightStatus('準備完了！「出発！」で飛び立つぞ');
    } catch (err) {
      if (S.flight !== f) return;
      setFlightStatus('案内の準備に失敗しました。音声なしで飛べます');
    }
    if (mystery) renderGuess(spot);
    $('#btnTakeoff').hidden = false;
    $('#btnTakeoff').focus();
  }

  function setFlightStatus(t) { $('#flightStatus').textContent = t; }

  function renderGuess(spot) {
    const others = shuffle(S.spots.filter(s => s.spot_id !== spot.spot_id)).slice(0, 3);
    const opts = shuffle([spot, ...others]);
    $('#guessChoices').innerHTML = opts.map(o => `<button type="button" class="chip" data-guess="${esc(o.spot_id)}">${esc(o.name)}</button>`).join('');
    $('#mysteryBox').hidden = false;
  }

  function takeoff() {
    const f = S.flight;
    if (!f) return;
    Music.ensure();
    $('#btnTakeoff').hidden = true;
    setFlightStatus('飛行中… しっかりつかまっておれ！');
    const vid = $('#flightMedia video');
    if (vid) vid.play().catch(() => {});
    const audio = playVoice(f.audioData);
    const sentences = (f.script.match(/[^。！？!?]+[。！？!?]?/g) || []).map(s => s.trim()).filter(Boolean);
    const total = sentences.reduce((a, s) => a + s.length, 0) || 1;
    const sub = $('#flightSub');

    if (audio) {
      const onTime = () => {
        if (!audio.duration || !isFinite(audio.duration)) return;
        const pos = audio.currentTime / audio.duration * total;
        let acc = 0;
        for (const s of sentences) { acc += s.length; if (pos <= acc) { sub.textContent = s; break; } }
      };
      audio.addEventListener('timeupdate', onTime);
      audio.addEventListener('ended', () => { sub.textContent = ''; enableArrive(); });
    } else if (sentences.length) {
      let i = 0;
      const next = () => {
        if (!S.flight || i >= sentences.length) { sub.textContent = ''; enableArrive(); return; }
        sub.textContent = sentences[i];
        f.subTimer = setTimeout(next, Math.max(2200, sentences[i].length * 160));
        i++;
      };
      next();
    }
    setTimeout(enableArrive, C.ARRIVE_FALLBACK_MS);
  }

  function enableArrive() {
    if (!S.flight) return;
    $('#btnArrive').disabled = false;
    setFlightStatus(S.flight.mystery ? 'まもなく着陸じゃ！ 答えは決まったかの？' : 'まもなく到着じゃ！ 着陸準備！');
  }

  async function arrive() {
    const f = S.flight;
    if (!f) return;
    stopVoice();
    clearTimeout(f.subTimer);
    $('#flightMedia').innerHTML = '';
    if (f.mystery) {
      const ok = f.guess === f.spot.spot_id;
      const box = $('#revealBox');
      box.innerHTML = `<div><p>行き先は…</p><h2>${esc(f.spot.name)}</h2>
        <p>${f.guess ? (ok ? '🎯 大正解じゃ！さすが隊員諸君！' : 'おしい！ でも楽しい旅じゃったろう？') : 'さあ、着陸じゃ！'}</p></div>`;
      box.hidden = false;
      Music.chime();
      await sleep(reducedMotion ? 600 : 2600);
    }
    closeFlight();
    enterPlaza(f.spot);
  }

  function closeFlight() {
    if (S.flight) clearTimeout(S.flight.subTimer);
    S.flight = null;
    stopVoice();
    $('#flightMedia').innerHTML = '';
    $('#flightView').hidden = true;
  }

  function initFlight() {
    $('#btnTakeoff').addEventListener('click', takeoff);
    $('#btnArrive').addEventListener('click', arrive);
    $('#btnAbort').addEventListener('click', () => { closeFlight(); toast('引き返しました'); });
    $('#guessChoices').addEventListener('click', e => {
      const b = e.target.closest('[data-guess]');
      if (!b || !S.flight) return;
      S.flight.guess = b.dataset.guess;
      $$('#guessChoices .chip').forEach(x => x.classList.toggle('is-on', x === b));
      setFlightStatus('答えは着陸してからのお楽しみじゃ！');
    });
  }

  /* =============================================================
   * 現地合流広場
   * ============================================================= */
  async function enterPlaza(spot) {
    showView('plaza');
    const P = S.plaza = {
      spot, me: null, since: 0, seen: new Set(), timers: [],
      members: new Map(), polling: false, moveTimer: null
    };
    $('#plazaName').textContent = `${catOf(spot.category).emoji} ${spot.name}`;
    $('#plazaCount').textContent = '合流中…';
    const stage = $('#stage');
    stage.className = 'stage scene-' + catOf(spot.category).scene;
    const img = imageUrl(spot.image_url);
    stage.style.backgroundImage = img ? `url("${img}")` : '';
    stage.classList.toggle('has-image', !!img);
    $('#stageSv').innerHTML = '';
    stage.classList.remove('has-sv');
    $('#btnStreetView').hidden = !S.mapsKey || !validCoord(spot);
    $('#btnStreetView').setAttribute('aria-pressed', 'false');
    $('#stageProp').textContent = catOf(spot.category).prop;
    $('#avatars').innerHTML = '';
    $('#chatLog').innerHTML = '';
    $('#plazaCaptainText').textContent = '';
    C.NPCS.forEach(n => upsertAvatar({ id: 'npc:' + n.id, nickname: n.name, avatar: n.emoji, x: n.x, y: n.y }, 'npc'));

    const pos = { x: 20 + Math.random() * 60, y: 62 + Math.random() * 26 };
    try {
      const r = await api('plazaJoin', { spot_id: spot.spot_id, ...pos });
      if (S.plaza !== P) return;
      P.me = r.me;
      applyPlaza(r);
    } catch (err) { toast(err.message, true); }

    P.timers.push(setInterval(pollPlaza, C.POLL_MS));
    P.timers.push(setInterval(npcTick, C.NPC_MS));
    P.timers.push(setTimeout(npcTick, 8000));
    arrivalTalk(spot, P);
  }

  function imageUrl(v) {
    v = String(v || '').trim();
    if (!v) return '';
    const m = v.match(/\/d\/([\w-]{20,})/) || v.match(/[?&]id=([\w-]{20,})/);
    const id = m ? m[1] : (/^[\w-]{20,}$/.test(v) ? v : null);
    return id ? C.DRIVE.IMAGE.replace('{id}', id) : v;
  }

  async function arrivalTalk(spot, P) {
    try {
      const r = await api('narration', { spot_id: spot.spot_id, mode: 'arrival', withAudio: S.sound });
      if (S.plaza !== P) return;
      $('#plazaCaptainText').textContent = r.script;
      playVoice(r.audio);
      setTimeout(() => { if (S.plaza === P) $('#plazaCaptainText').textContent = ''; }, 16000);
    } catch { /* 実況なしでも続行 */ }
  }

  function applyPlaza(r) {
    const P = S.plaza;
    if (!P) return;
    renderMembers(r.members || []);
    (r.logs || []).forEach(handleLog);
  }

  async function pollPlaza() {
    const P = S.plaza;
    if (!P || P.polling || document.hidden) return;
    P.polling = true;
    try {
      const r = await api('plazaPoll', { spot_id: P.spot.spot_id, since: P.since });
      if (S.plaza === P) applyPlaza(r);
    } catch { /* 次回に再試行 */ }
    finally { P.polling = false; }
  }

  async function npcTick() {
    const P = S.plaza;
    if (!P || document.hidden) return;
    try {
      const r = await api('npcTick', { spot_id: P.spot.spot_id });
      if (r.log && S.plaza === P) handleLog(r.log);
    } catch { /* 無視 */ }
  }

  function renderMembers(list) {
    const P = S.plaza;
    const ids = new Set(list.map(m => m.id));
    list.forEach(m => upsertAvatar(m, m.id === P.me ? 'me' : 'member'));
    $$('#avatars .avatar[data-kind="member"]').forEach(el => { if (!ids.has(el.dataset.id)) el.remove(); });
    $('#plazaCount').textContent = `いま${list.length}人が合流中（NPC ${C.NPCS.length}人）`;
  }

  function upsertAvatar(m, kind) {
    let el = $(`#avatars .avatar[data-id="${CSS.escape(m.id)}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'avatar' + (kind === 'me' ? ' is-me' : kind === 'npc' ? ' is-npc' : '');
      el.dataset.id = m.id;
      el.dataset.kind = kind === 'me' ? 'me' : kind;
      el.innerHTML = '<span class="face"></span><span class="name"></span>';
      $('#avatars').appendChild(el);
    }
    $('.face', el).textContent = m.avatar || '🙂';
    $('.name', el).textContent = m.nickname || '';
    // 自分の位置はローカル操作を優先
    if (kind !== 'me' || !el.dataset.placed) {
      el.style.left = (Number(m.x) || 50) + '%';
      el.style.top = (Number(m.y) || 70) + '%';
      if (kind === 'me') el.dataset.placed = '1';
    }
    return el;
  }

  function handleLog(log) {
    const P = S.plaza;
    if (!P || P.seen.has(log.id)) return;
    P.seen.add(log.id);
    P.since = Math.max(P.since, Number(log.ts) || 0);
    const mine = log.member === P.me;
    const p = log.payload || {};

    switch (log.type) {
      case 'join':
        if (!mine) { chatLine(null, `${log.nickname}さんが到着しました`); Music.chime(); }
        break;
      case 'leave':
        if (!mine) chatLine(null, `${log.nickname}さんが飛び立ちました`);
        break;
      case 'chat':
        if (!mine) { chatLine(log.nickname, p.text); bubble(log.member, p.text); }
        break;
      case 'action':
        if (!mine) { doAction(log.member, p.id, p.song); chatLine(null, `${log.nickname}さん：${actionLabel(p.id)}`); }
        break;
      case 'npc':
        chatLine(log.nickname, p.text, 'npc');
        bubble(log.member, p.text);
        if (p.action && p.action !== 'none') doAction(log.member, p.action, Math.floor(Math.random() * 3));
        break;
    }
  }

  const actionLabel = id => { const a = C.ACTIONS.find(x => x.id === id); return a ? `${a.emoji} ${a.label}` : id; };

  function chatLine(who, text, cls = '') {
    const li = document.createElement('li');
    if (who) {
      li.className = cls;
      li.innerHTML = `<span class="who">${esc(who)}</span>${esc(text)}`;
    } else {
      li.className = 'sys';
      li.textContent = text;
    }
    const log = $('#chatLog');
    log.appendChild(li);
    while (log.children.length > 120) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  }

  function bubble(memberId, text) {
    const el = $(`#avatars .avatar[data-id="${CSS.escape(memberId)}"]`);
    if (!el) return;
    $('.bubble', el)?.remove();
    const b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = text;
    el.prepend(b);
    setTimeout(() => b.remove(), 6000);
  }

  function doAction(memberId, actId, songIdx = 0) {
    const el = $(`#avatars .avatar[data-id="${CSS.escape(memberId)}"]`);
    const act = C.ACTIONS.find(a => a.id === actId);
    if (!el || !act) return;
    el.classList.remove(...C.ACTIONS.map(a => 'act-' + a.id));
    void el.offsetWidth;
    el.classList.add('act-' + actId);
    setTimeout(() => el.classList.remove('act-' + actId), 2600);
    for (let i = 0; i < 4; i++) {
      const fx = document.createElement('span');
      fx.className = 'fx';
      fx.textContent = act.fx;
      fx.style.left = (20 + Math.random() * 40) + 'px';
      fx.style.top = '-10px';
      fx.style.setProperty('--dx', (Math.random() * 60 - 30) + 'px');
      fx.style.animationDelay = (i * 0.25) + 's';
      el.appendChild(fx);
      setTimeout(() => fx.remove(), 2400);
    }
    if (actId === 'bbq') {
      const prop = $('#stageProp');
      prop.classList.remove('sizzle'); void prop.offsetWidth; prop.classList.add('sizzle');
      Music.sizzle();
    }
    if (actId === 'sing') Music.song(songIdx);
    if (actId === 'cheer') Music.chime();
  }

  async function postPlaza(type, payload) {
    const P = S.plaza;
    if (!P) return;
    try { await api('plazaPost', { spot_id: P.spot.spot_id, type, payload }); }
    catch (err) { if (type !== 'move') toast(err.message, true); }
  }

  function sendChat(text) {
    const P = S.plaza;
    text = String(text || '').trim().slice(0, 140);
    if (!P || !text) return;
    chatLine(S.user.nickname, text);
    bubble(P.me, text);
    postPlaza('chat', { text });
  }

  function leavePlaza(silent = false) {
    const P = S.plaza;
    if (!P) return;
    P.timers.forEach(t => { clearInterval(t); clearTimeout(t); });
    clearTimeout(P.moveTimer);
    $('#stageSv').innerHTML = '';
    Music.bgmStop();
    $('#btnBgm').setAttribute('aria-pressed', 'false');
    stopVoice();
    if (!silent) api('plazaLeave', { spot_id: P.spot.spot_id }).catch(() => {});
    S.plaza = null;
  }

  function initPlaza() {
    $('#actionBar').innerHTML = C.ACTIONS.map(a =>
      `<button type="button" class="action-btn" data-act="${a.id}"><span>${a.emoji}</span>${esc(a.label)}</button>`).join('');
    $('#phraseBar').innerHTML = C.PHRASES.map(p => `<button type="button" class="chip">${esc(p)}</button>`).join('');

    $('#actionBar').addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      const P = S.plaza;
      if (!b || !P) return;
      Music.ensure();
      const song = Math.floor(Math.random() * Music.SONGS.length);
      doAction(P.me, b.dataset.act, song);
      chatLine(null, `あなた：${actionLabel(b.dataset.act)}`);
      postPlaza('action', { id: b.dataset.act, song });
    });

    $('#phraseBar').addEventListener('click', e => {
      const b = e.target.closest('.chip');
      if (b) sendChat(b.textContent);
    });

    $('#chatForm').addEventListener('submit', e => {
      e.preventDefault();
      const input = $('#chatInput');
      sendChat(input.value);
      input.value = '';
    });

    $('#stage').addEventListener('click', e => {
      const P = S.plaza;
      if (!P || !P.me) return;
      const r = e.currentTarget.getBoundingClientRect();
      const x = Math.max(3, Math.min(97, (e.clientX - r.left) / r.width * 100));
      const y = Math.max(45, Math.min(95, (e.clientY - r.top) / r.height * 100));
      const el = $(`#avatars .avatar[data-id="${CSS.escape(P.me)}"]`);
      if (el) { el.style.left = x + '%'; el.style.top = y + '%'; }
      clearTimeout(P.moveTimer);
      P.moveTimer = setTimeout(() => postPlaza('move', { x, y }), 600);
    });

    // 現地の景色（ストリートビュー）を広場の背景に
    $('#btnStreetView').addEventListener('click', e => {
      const P = S.plaza;
      if (!P) return;
      const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
      e.currentTarget.setAttribute('aria-pressed', String(on));
      $('#stage').classList.toggle('has-sv', on);
      $('#stageSv').innerHTML = on
        ? `<iframe src="${esc(mapsEmbedUrl(P.spot, 'streetview'))}" title="現地の景色" referrerpolicy="no-referrer-when-downgrade"></iframe>`
        : '';
      if (on) toast('近くにストリートビューが無い場所では表示されないことがあります');
    });

    $('#btnLeave').addEventListener('click', () => {
      leavePlaza();
      showView('app');
    });

    $('#btnSound').addEventListener('click', e => {
      S.sound = !S.sound;
      e.currentTarget.setAttribute('aria-pressed', String(S.sound));
      e.currentTarget.textContent = S.sound ? '音あり' : '音なし';
      if (!S.sound) { stopVoice(); Music.bgmStop(); $('#btnBgm').setAttribute('aria-pressed', 'false'); }
    });

    $('#btnBgm').addEventListener('click', e => {
      const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
      if (on && !S.sound) { toast('「音なし」になっています'); return; }
      e.currentTarget.setAttribute('aria-pressed', String(on));
      on ? Music.bgmStart() : Music.bgmStop();
    });

    window.addEventListener('pagehide', () => {
      const P = S.plaza;
      if (!P) return;
      navigator.sendBeacon?.(gasUrl(), new Blob([JSON.stringify({ action: 'plazaLeave', token: S.token, spot_id: P.spot.spot_id })], { type: 'text/plain' }));
    });
  }

  /* =============================================================
   * 管理（スポット取り込み・編集）
   * ============================================================= */
  function initAdmin() {
    $('#btnAdmin').addEventListener('click', () => { renderAdminList(); openModal('#adminModal'); });
    $$('#adminModal .admin-tab').forEach(b => b.addEventListener('click', () => {
      $$('#adminModal .admin-tab').forEach(x => x.classList.toggle('is-active', x === b));
      $$('.admin-body').forEach(x => { x.hidden = x.dataset.body !== b.dataset.tab; });
      if (b.dataset.tab === 'list') renderAdminList();
    }));

    $('#impFile').addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      $('#impText').value = (await file.text()).slice(0, 30000);
      toast(`${file.name} を読み込みました`);
      e.target.value = '';
    });

    $('#btnImpPreview').addEventListener('click', e => busyButton(e.currentTarget, async () => {
      const text = $('#impText').value.trim();
      const url = $('#impUrl').value.trim();
      if (!text && !url) { toast('取り込む内容かURLを入力してください', true); return; }
      loading('Geminiがスポットを整形中…');
      try {
        const r = await api('importPreview', { text, url });
        S.importItems = r.items || [];
        $('#impRows').innerHTML = S.importItems.map((s, i) => `
          <tr><td><input type="checkbox" data-i="${i}" checked aria-label="登録する"></td>
          <td>${esc(s.name)}</td><td>${esc(s.category)}</td><td>${s.lat.toFixed(4)}</td><td>${s.lng.toFixed(4)}</td>
          <td>${esc(s.description)}</td><td>${s.flight_video_url ? 'あり' : '—'}</td></tr>`).join('');
        $('#impPreview').hidden = !S.importItems.length;
        toast(S.importItems.length ? `${S.importItems.length}件を読み取りました` : 'スポットを読み取れませんでした', !S.importItems.length);
      } catch (err) { toast(err.message, true); }
      finally { loading(false); }
    }));

    $('#btnImpCommit').addEventListener('click', e => busyButton(e.currentTarget, async () => {
      const items = $$('#impRows input[type=checkbox]:checked').map(c => S.importItems[Number(c.dataset.i)]);
      if (!items.length) { toast('登録するスポットにチェックを入れてください', true); return; }
      try {
        const r = await api('importCommit', { items, source: $('#impSource').value.trim() });
        toast(r.message);
        $('#impPreview').hidden = true;
        $('#impText').value = '';
        $('#impUrl').value = '';
        await loadSpots();
      } catch (err) { toast(err.message, true); }
    }));

    $('#adminRows').addEventListener('click', async e => {
      const save = e.target.closest('[data-save]');
      const del = e.target.closest('[data-del]');
      if (save) {
        const tr = save.closest('tr');
        const sp = S.spots.find(s => s.spot_id === save.dataset.save);
        const spot = {
          ...sp,
          name: $('[name=name]', tr).value,
          category: $('[name=category]', tr).value,
          flight_video_url: $('[name=video]', tr).value,
          image_url: $('[name=image]', tr).value
        };
        await busyButton(save, async () => {
          try { const r = await api('upsertSpot', { spot }); toast(r.message); await loadSpots(); renderAdminList(); }
          catch (err) { toast(err.message, true); }
        });
      }
      if (del) {
        const sp = S.spots.find(s => s.spot_id === del.dataset.del);
        if (!confirm(`「${sp?.name}」を削除しますか？`)) return;
        await busyButton(del, async () => {
          try { const r = await api('deleteSpot', { spot_id: del.dataset.del }); toast(r.message); await loadSpots(); renderAdminList(); }
          catch (err) { toast(err.message, true); }
        });
      }
    });

    $('#btnDelSource').addEventListener('click', e => busyButton(e.currentTarget, async () => {
      const source = $('#srcSelect').value;
      if (!source) { toast('取り込み名を選んでください', true); return; }
      const n = S.spots.filter(s => s.source === source).length;
      if (!confirm(`「${source}」で取り込んだ${n}件をすべて削除しますか？`)) return;
      try { const r = await api('deleteSpotsBySource', { source }); toast(r.message); await loadSpots(); renderAdminList(); }
      catch (err) { toast(err.message, true); }
    }));

    $('#addSpotForm').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      const spot = Object.fromEntries(new FormData(f).entries());
      spot.lat = Number(spot.lat); spot.lng = Number(spot.lng);
      await busyButton($('button[type=submit]', f), async () => {
        try { const r = await api('upsertSpot', { spot }); toast(r.message); f.reset(); await loadSpots(); }
        catch (err) { toast(err.message, true); }
      });
    });
  }

  function renderAdminList() {
    const cats = Object.keys(C.CATEGORIES);
    $('#adminRows').innerHTML = S.spots.length ? S.spots.map(s => `
      <tr>
        <td><input name="name" value="${esc(s.name)}"></td>
        <td><select name="category">${cats.map(c => `<option ${c === s.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></td>
        <td><input name="video" value="${esc(s.flight_video_url)}" placeholder="DriveのURLまたはID"></td>
        <td><input name="image" value="${esc(s.image_url)}" placeholder="任意"></td>
        <td class="actions"><button class="btn btn-primary btn-sm" data-save="${esc(s.spot_id)}">保存</button>
          <button class="btn btn-ghost btn-sm" data-del="${esc(s.spot_id)}">削除</button></td>
      </tr>`).join('') : '<tr><td colspan="5" class="empty">まだスポットがありません。「外部から取り込む」から登録してください</td></tr>';
    const sources = [...new Set(S.spots.map(s => s.source).filter(Boolean))];
    $('#srcSelect').innerHTML = '<option value="">取り込み名を選ぶ</option>' +
      sources.map(s => `<option>${esc(s)}</option>`).join('');
  }

  /* =============================================================
   * 設定（GAS URL）・バージョン情報
   * ============================================================= */
  function storedGasUrl() {
    if (!C.ALLOW_GAS_URL_OVERRIDE) return '';
    try { return localStorage.getItem(C.GAS_URL_STORAGE_KEY) || ''; } catch { return ''; }
  }
  function gasUrl() { return storedGasUrl() || C.GAS_URL || ''; }
  const isValidGasUrl = u => /^https:\/\/script\.google(usercontent)?\.com\/.+\/exec(\?.*)?$/.test(String(u || '').trim());
  const isGasConfigured = () => isValidGasUrl(gasUrl()) && !gasUrl().includes('XXXX');

  // サーバー情報（doGet）を取得
  async function fetchServerInfo(url = gasUrl()) {
    if (!isValidGasUrl(url) || url.includes('XXXX')) return { state: 'unset' };
    const t0 = performance.now();
    try {
      const r = await (await fetch(url, { cache: 'no-store' })).json();
      return { state: 'ok', ms: Math.round(performance.now() - t0), ...r };
    } catch {
      return { state: 'ng' };
    }
  }

  S.server = { state: 'checking' };

  async function renderVersion() {
    S.server = { state: 'checking' };
    paintVersionBar();
    S.server = await fetchServerInfo();
    paintVersionBar();
    if (!$('#settingsModal').hidden) paintVersionInfo();
  }

  function paintVersionBar() {
    const bar = $('#versionBar');
    const base = `${C.VERSION} (Build ${C.BUILD}) ${C.STATUS}`;
    const sv = S.server || {};
    const map = {
      checking: ['', '接続確認中'],
      unset: ['ng', 'サーバー未設定'],
      ng: ['ng', 'サーバーに接続できません'],
      ok: ['ok', `サーバー ${sv.version || ''}`]
    };
    const [cls, label] = map[sv.state] || map.checking;
    const warn = sv.state === 'ok' && sv.version && sv.version !== C.VERSION ? '（版が異なります）' : '';
    bar.innerHTML = `<span class="dot ${cls}"></span>${esc(base)}　${esc(label + warn)}`;
    bar.setAttribute('aria-label', `バージョン情報と設定を開く：${base}、${label}`);
  }

  function paintVersionInfo() {
    const sv = S.server || {};
    const src = storedGasUrl() ? 'この端末の設定' : 'config.js';
    const state = {
      checking: '確認中…', unset: '未設定', ng: '接続できません',
      ok: `接続OK（応答 ${sv.ms ?? '-'}ms）`
    }[sv.state] || '確認中…';
    const mismatch = sv.state === 'ok' && sv.version && sv.version !== C.VERSION;
    $('#versionInfo').innerHTML = `
      <table class="info-tbl">
        <tr><th>アプリ</th><td>${esc(C.APP_NAME)}</td></tr>
        <tr><th>画面のバージョン</th><td>${esc(C.VERSION)}（Build ${esc(C.BUILD)}）${esc(C.STATUS)}</td></tr>
        <tr><th>サーバーのバージョン</th><td>${sv.state === 'ok' ? `${esc(sv.version || '不明')}（Build ${esc(sv.build || '不明')}）` : '—'}</td></tr>
        <tr><th>サーバー状態</th><td><span class="dot ${sv.state === 'ok' ? 'ok' : sv.state === 'checking' ? '' : 'ng'}"></span>${esc(state)}</td></tr>
        <tr><th>GAS URLの参照元</th><td>${esc(src)}</td></tr>
        <tr><th>Google Maps APIキー</th><td>${S.user ? (S.mapsKey ? '設定済み（スクリプトプロパティ）' : '未設定') : 'ログイン後に確認'}</td></tr>
        <tr><th>ログイン中</th><td>${S.user ? esc(S.user.nickname) + (S.user.role === 'admin' ? '（管理者）' : '') : '—'}</td></tr>
      </table>
      ${mismatch ? '<p class="warn">画面とサーバーのバージョンが異なります。GASを新バージョンで再デプロイしたか、ブラウザのキャッシュが古くないか確認してください。</p>' : ''}
      <h3 class="sub-title">更新履歴</h3>
      <ol class="changelog">${(C.CHANGELOG || []).map(c =>
        `<li><strong>${esc(c.version)}</strong><span class="date">${esc(c.date)}</span><p>${esc(c.note)}</p></li>`).join('')}</ol>`;
  }

  function openSettings(tab = 'gas') {
    const input = $('#gasUrlInput');
    input.value = gasUrl().includes('XXXX') ? '' : gasUrl();
    $('#gasDefault').textContent = C.GAS_URL && !C.GAS_URL.includes('XXXX') ? C.GAS_URL : '（未設定）';
    $('#gasTestMsg').textContent = '';
    $('#gasTestMsg').className = 'gas-test-msg';
    $('#gasOverrideBox').hidden = !C.ALLOW_GAS_URL_OVERRIDE;
    switchSettingsTab(tab);
    paintVersionInfo();
    openModal('#settingsModal');
    renderVersion();
  }

  function switchSettingsTab(tab) {
    $$('.settings-tab').forEach(b => b.classList.toggle('is-active', b.dataset.tab === tab));
    $$('.settings-body').forEach(x => { x.hidden = x.dataset.body !== tab; });
  }

  function setGasMsg(text, kind) {
    const el = $('#gasTestMsg');
    el.textContent = text;
    el.className = 'gas-test-msg' + (kind ? ' is-' + kind : '');
  }

  function initSettings() {
    $('#versionBar').addEventListener('click', () => openSettings('version'));
    $$('[data-open-settings]').forEach(b => b.addEventListener('click', () => openSettings('gas')));
    $$('.settings-tab').forEach(b => b.addEventListener('click', () => switchSettingsTab(b.dataset.tab)));

    $('#btnGasTest').addEventListener('click', e => busyButton(e.currentTarget, async () => {
      const url = $('#gasUrlInput').value.trim();
      if (!isValidGasUrl(url)) { setGasMsg('GASウェブアプリのURL（https://script.google.com/macros/s/…/exec）を入力してください', 'error'); return; }
      setGasMsg('接続を確認しています…');
      const r = await fetchServerInfo(url);
      if (r.state === 'ok') {
        const mm = r.version && r.version !== C.VERSION ? `（画面は ${C.VERSION}。版が異なります）` : '';
        setGasMsg(`接続OK：${r.app || ''} ${r.version || ''}（Build ${r.build || '-'}）${r.ms}ms ${mm}`, mm ? 'warn' : 'ok');
      } else {
        setGasMsg('接続できませんでした。URL、デプロイのアクセス権（全員）、新バージョンでのデプロイを確認してください', 'error');
      }
    }));

    $('#gasForm').addEventListener('submit', async e => {
      e.preventDefault();
      const url = $('#gasUrlInput').value.trim();
      if (!isValidGasUrl(url)) { setGasMsg('GASウェブアプリのURL（…/exec）を入力してください', 'error'); return; }
      const before = gasUrl();
      localStorage.setItem(C.GAS_URL_STORAGE_KEY, url);
      await afterGasChange(before);
      toast('GAS URLを保存しました');
    });

    $('#btnGasReset').addEventListener('click', async () => {
      const before = gasUrl();
      localStorage.removeItem(C.GAS_URL_STORAGE_KEY);
      $('#gasUrlInput').value = C.GAS_URL.includes('XXXX') ? '' : C.GAS_URL;
      await afterGasChange(before);
      toast('config.js の設定に戻しました');
    });
  }

  // 接続先が変わったらセッションは無効なのでログアウト
  async function afterGasChange(before) {
    if (before !== gasUrl() && S.token) {
      leavePlaza(true);
      closeFlight();
      clearSession();
      S.mapsKey = '';
      showView('auth');
      toast('接続先が変わったため、もう一度ログインしてください');
    }
    await renderVersion();
    paintVersionInfo();
  }

  async function boot() {
    initAuth();
    initPwModal();
    initProfile();
    initPanel();
    initFlight();
    initPlaza();
    initAdmin();
    initSettings();
    renderVersion();

    if (!isGasConfigured()) {
      showView('auth');
      authMsg('サーバー（GAS URL）が未設定です。右上の「設定」から入力してください', true);
      return;
    }
    if (loadSession()) {
      try {
        const r = await api('me');
        S.user = r.user; updateStoredUser();
        await enterApp();
        return;
      } catch { /* 期限切れ等は handleExpired 済み */ }
    }
    showView('auth');
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
