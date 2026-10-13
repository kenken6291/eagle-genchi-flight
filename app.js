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
    sound: true, audio: null, audioUrl: null, voiceVol: 1, seVol: 0.6,
    startPoint: null, maps3dFailed: false,
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
      if (j.error === 'unknown_action') {
        renderVersion();
        throw new ApiError(`サーバー（GAS）が古い版のままです（画面は ${C.VERSION}）。Code.gs を最新に貼り替え、「デプロイを管理」から新バージョンで再デプロイしてください`, j.error);
      }
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

  // すべてのモーダルに、スクロールしても常に見える×ボタンを付ける
  $$('.modal-card').forEach(card => {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'modal-x';
    x.setAttribute('data-close', '');
    x.setAttribute('aria-label', '閉じる');
    x.textContent = '×';
    card.prepend(x);
  });
  // 背景（カードの外側）をクリックしても閉じる
  $$('.modal').forEach(m => m.addEventListener('mousedown', e => {
    if (e.target === m && !m.classList.contains('is-forced')) m.hidden = true;
  }));

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
    S.audio.volume = S.voiceVol;
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

    const doLogout = () => {
      if (!confirm('ログアウトしますか？')) return;
      api('logout').catch(() => {});
      leavePlaza(true);
      closeFlight();
      $$('.modal').forEach(m => { m.hidden = true; m.classList.remove('is-forced'); });
      clearSession();
      showView('auth');
      toast('ログアウトしました');
    };
    $('#btnLogout').addEventListener('click', doLogout);
    $('#btnProfileLogout').addEventListener('click', doLogout);
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
      FaceEdit.pending = {};
      renderFaceSlots();
      openModal('#profileModal');
      ensureOwnFaces().then(renderFaceSlots);
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
    const myFace = ownFaces().normal;
    $('#userAvatar').innerHTML = myFace ? `<img class="chip-face" src="${myFace}" alt="">` : esc(S.user?.avatar || '🙂');
    $('#userName').textContent = S.user?.nickname || '';
    $('#btnAdmin').hidden = S.user?.role !== 'admin';
  }

  async function enterApp() {
    showView('app');
    renderUserChip();
    initMap();
    if (S.user?.mustChange) { openPwModal(true); return; }
    await Promise.all([loadClientConfig(), loadSpots(), ensureOwnFaces()]);
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
      ${sp.address ? `<div class="meta">📍 ${esc(sp.address)}</div>` : ''}
      ${sp.maps_url ? `<a class="maps-open" href="${esc(sp.maps_url)}" target="_blank" rel="noopener">Googleマップで開く</a>` : ''}
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
   *   1) Google Maps 3D（フォトリアル3D・Earth Studio風のカメラ飛行）
   *   2) スポットに登録したフライト動画（Earth Studio書き出し等）
   *   3) どちらも無いときは雲のアニメーション
   * ============================================================= */
  const FL = C.FLIGHT || {};

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

  /* ---------- Google Maps JavaScript API（3D）の読み込み ---------- */
  function loadMapsJs() {
    if (window.google?.maps?.importLibrary) return Promise.resolve();
    if (loadMapsJs.p) return loadMapsJs.p;
    loadMapsJs.p = new Promise((resolve, reject) => {
      window.__egfMapsReady = () => resolve();
      window.gm_authFailure = () => { S.maps3dFailed = true; toast('Google Maps のキーが使えません（APIの有効化・リファラー制限を確認）', true); };
      const s = document.createElement('script');
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(S.mapsKey)}&v=beta&language=ja&region=JP&loading=async&callback=__egfMapsReady`;
      s.async = true;
      s.onerror = () => { loadMapsJs.p = null; reject(new Error('Google Maps を読み込めませんでした')); };
      document.head.appendChild(s);
    });
    return loadMapsJs.p;
  }

  async function create3dMap(center, cam) {
    await loadMapsJs();
    const { Map3DElement } = await google.maps.importLibrary('maps3d');
    const map = new Map3DElement({
      center: { lat: center.lat, lng: center.lng, altitude: 0 },
      range: cam.range, tilt: cam.tilt, heading: cam.heading,
      mode: cam.labels ? 'HYBRID' : 'SATELLITE'
    });
    map.defaultUIHidden = true;
    map.defaultUIDisabled = true;
    return map;
  }

  /* ---------- 出発地（現在地 → だめなら設定の既定地点） ---------- */
  function getStartPoint() {
    const fallback = FL.START || { lat: 35.6812, lng: 139.7671, name: '東京駅' };
    if (S.startPoint) return Promise.resolve(S.startPoint);
    if (!FL.USE_GEOLOCATION || !navigator.geolocation) return Promise.resolve(fallback);
    return new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(
        p => { S.startPoint = { lat: p.coords.latitude, lng: p.coords.longitude, name: '現在地' }; resolve(S.startPoint); },
        () => resolve(fallback),
        { timeout: 5000, maximumAge: 600000 }
      );
    });
  }

  const rad = d => d * Math.PI / 180;
  function distKm(a, b) {
    const R = 6371, dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function bearing(a, b) {
    const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
    const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmtTime = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  /* ---------- 風の効果音 ---------- */
  const Wind = {
    src: null, gain: null,
    start() {
      this.stop();
      const c = Music.ensure();
      const len = c.sampleRate * 2;
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
      this.src = c.createBufferSource(); this.src.buffer = buf; this.src.loop = true;
      const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900;
      this.gain = c.createGain(); this.set(S.seVol);
      this.src.connect(f).connect(this.gain).connect(c.destination);
      this.src.start();
    },
    set(v) { if (this.gain) this.gain.gain.value = S.sound ? v * 0.5 : 0; },
    stop() { try { this.src?.stop(); } catch { /* 停止済み */ } this.src = null; this.gain = null; },
    whoosh() {
      if (!S.sound || !S.seVol) return;
      const c = Music.ensure(), t = c.currentTime;
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'sawtooth'; o.frequency.setValueAtTime(180, t); o.frequency.exponentialRampToValueAtTime(60, t + 0.6);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.06 * S.seVol, t + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.8);
    }
  };

  /* ---------- 隊長の吹き出し・字幕 ---------- */
  function eagleSay(text) {
    const b = $('#eagleBubble');
    b.textContent = text || '';
    b.hidden = !text;
    $('#flightSub').textContent = text || '';
  }

  /* ---------- フライト開始（準備） ---------- */
  async function startFlight(spot, { mystery = false } = {}) {
    if (!spot) return;
    stopVoice();
    const F = S.flight = {
      spot, mystery, script: '', audioData: null, guess: null,
      kind: 'fallback', map: null, phases: [], idx: -1, runId: 0, phaseStart: 0,
      paused: false, remaining: 0, landReady: false, tick: null, subTimer: null, sentences: [], sentIdx: -1
    };
    const v = $('#flightView');
    v.hidden = false;
    v.classList.toggle('is-mystery', mystery);
    $('#revealBox').hidden = true;
    $('#flightDest').textContent = mystery ? '行き先：？？？（ミステリーフライト）' : `行き先：${spot.name}`;
    eagleSay('');
    $('#btnTakeoff').hidden = true;
    $('#flightCtrl').hidden = true;
    $('#mysteryBox').hidden = true;
    $('#btnPause').textContent = '一時停止';
    setLandPill('準備中', false);
    setFlightStatus('イーグル隊長が飛行計画を立てておる…');

    const narr = api('narration', { spot_id: spot.spot_id, mode: mystery ? 'mystery' : 'flight' })
      .catch(() => ({ script: '', audioError: true }));
    const media = prepareFlightMedia(F);
    const [r] = await Promise.all([narr, media]);
    if (S.flight !== F) return;
    F.script = r.script || '';
    F.audioData = r.audio || null;
    F.sentences = (F.script.match(/[^。！？!?]+[。！？!?]?/g) || []).map(s => s.trim()).filter(Boolean);
    if (r.audioError) toast('音声を作れなかったので、字幕だけで案内します', true);
    if (mystery) renderGuess(spot);
    eagleSay(mystery ? 'さあ、行き先は秘密じゃ。ヒントをよく聞いておれ！' : `よし、翼の調子は上々じゃ。「${spot.name}」へ出発するぞ！`);
    setFlightStatus('');
    $('#btnTakeoff').hidden = false;
    $('#btnTakeoff').focus();
  }

  async function prepareFlightMedia(F) {
    const box = $('#flightMedia');
    box.innerHTML = '';
    const spot = F.spot;
    const prefer3d = (FL.PREFER || 'map3d') === 'map3d';
    const video = mediaFor(spot.flight_video_url);

    if (S.mapsKey && validCoord(spot) && !S.maps3dFailed && (prefer3d || !video)) {
      try {
        F.from = await getStartPoint();
        F.to = { lat: spot.lat, lng: spot.lng };
        F.dist = distKm(F.from, F.to);
        F.heading = F.dist > 0.3 ? bearing(F.from, F.to) : 0;
        F.map = await create3dMap(F.from, { range: 1500, tilt: 65, heading: F.heading, labels: !F.mystery });
        if (S.flight !== F) return;
        box.appendChild(F.map);
        F.kind = 'map3d';
        F.phases = buildPhases(F);
        F.map.addEventListener('gmp-animationend', () => {
          if (performance.now() - F.phaseStart > 400) advancePhase(F, F.runId);
        });
        return;
      } catch (e) {
        console.warn(e);
        toast('3Dマップを表示できないため、通常の映像で飛びます', true);
      }
    }
    if (video?.type === 'video') {
      box.innerHTML = `<video src="${esc(video.src)}" playsinline preload="auto"></video>`;
      $('video', box).addEventListener('ended', () => readyToLand(F));
      F.kind = 'video';
    } else if (video?.type === 'iframe') {
      box.innerHTML = `<iframe src="${esc(video.src)}" allow="autoplay; fullscreen" allowfullscreen title="フライト映像"></iframe>`;
      F.kind = 'iframe';
    } else {
      const clouds = Array.from({ length: 5 }, (_, i) =>
        `<span class="cloud" style="top:${10 + i * 16}%;animation-duration:${9 + i * 3}s;animation-delay:-${i * 2.5}s">☁️</span>`).join('');
      box.innerHTML = `<div class="flight-fallback">${clouds}</div>`;
      F.kind = 'fallback';
    }
  }

  /* ---------- 3Dカメラの飛行計画 ---------- */
  function buildPhases(F) {
    const { from, to, dist, heading, map } = F;
    const fly = (center, range, tilt, hd, ms) => map.flyCameraTo({
      endCamera: { center: { lat: center.lat, lng: center.lng, altitude: 0 }, range, tilt, heading: hd },
      durationMillis: ms
    });
    const ph = [];
    ph.push({ dur: 5000, line: 'しっかりつかまっておれ！ 離陸じゃ！', run: ms => { if (ms === 5000) Wind.whoosh(); fly(from, 5000, 55, heading, ms); } });
    if (dist > 2) {
      const mid = { lat: (from.lat + to.lat) / 2, lng: (from.lng + to.lng) / 2 };
      const cruiseRange = clamp(dist * 1000 * 1.1, 15000, 900000);
      const cruiseMs = clamp(8000 + dist * 25, 9000, 24000);
      ph.push({ dur: cruiseMs, line: '高度を上げるぞ。下の景色を見てみるのじゃ！', run: ms => fly(mid, cruiseRange, 35, heading, ms) });
    }
    ph.push({ dur: 9000, line: F.mystery ? 'そろそろ高度を下げるぞ。どこか分かったかの？' : `見えてきたぞ、「${F.spot.name}」じゃ！`, run: ms => fly(to, 1400, 65, heading, ms) });
    ph.push({
      dur: 0, final: true, line: F.mystery ? 'さあ、着陸じゃ！ 答えは決まったかの？' : '到着じゃ！ 上空をひと回りしてから着陸するぞ',
      run: () => map.flyCameraAround({
        camera: { center: { lat: to.lat, lng: to.lng, altitude: 0 }, range: 1400, tilt: 65, heading },
        durationMillis: 40000, repeatCount: 1, rounds: 1
      })
    });
    return ph;
  }

  function runPhase(F, i, resume = false) {
    if (S.flight !== F) return;
    const ph = F.phases[i];
    if (!ph) return;
    // 再開時は区間の残り時間だけで飛ぶ
    const ms = resume ? Math.max(1500, ph.dur - (F.phaseElapsed || 0)) : ph.dur;
    F.idx = i;
    F.runId++;
    F.phaseStart = performance.now() - (resume ? ph.dur - ms : 0);
    const id = F.runId;
    ph.run(ms);
    if (!resume) {
      // 音声が無いときは区切りのセリフを吹き出しに
      if (!F.audio) eagleSay(ph.line);
      F.remaining = F.phases.slice(i).filter(p => !p.final).reduce((a, p) => a + p.dur, 0);
    }
    if (ph.final) readyToLand(F);
    else setTimeout(() => advancePhase(F, id), ms + 1500); // イベントが来なかったときの保険
  }

  function advancePhase(F, id) {
    if (S.flight !== F || F.paused || id !== F.runId) return;
    if (F.phases[F.idx]?.final) return;
    runPhase(F, F.idx + 1);
  }

  /* ---------- 離陸 ---------- */
  function takeoff() {
    const F = S.flight;
    if (!F) return;
    Music.ensure();
    $('#btnTakeoff').hidden = true;
    $('#flightCtrl').hidden = false;
    $('#eagleRig').classList.add('is-flying');
    Wind.start();

    const vid = $('#flightMedia video');
    if (vid) vid.play().catch(() => {});

    F.audio = playVoice(F.audioData);
    if (F.audio) {
      F.audio.addEventListener('timeupdate', () => syncSentence(F));
      F.audio.addEventListener('ended', () => { if (F.kind !== 'map3d') readyToLand(F); });
    } else if (F.kind !== 'map3d') {
      timedSentences(F);
    }

    if (F.kind === 'map3d') {
      runPhase(F, 0);
    } else {
      F.remaining = C.ARRIVE_FALLBACK_MS;
    }

    let last = performance.now();
    F.tick = setInterval(() => {
      const now = performance.now();
      if (!F.paused && !F.landReady) {
        F.remaining -= now - last;
        if (F.kind !== 'map3d' && F.remaining <= 0) readyToLand(F);
        setLandPill(`着陸まで ${fmtTime(F.remaining)}`, false);
      }
      last = now;
    }, 250);
  }

  function syncSentence(F) {
    const a = F.audio;
    if (!a || !a.duration || !isFinite(a.duration) || !F.sentences.length) return;
    const total = F.sentences.reduce((n, s) => n + s.length, 0);
    const pos = a.currentTime / a.duration * total;
    let acc = 0;
    for (let i = 0; i < F.sentences.length; i++) {
      acc += F.sentences[i].length;
      if (pos <= acc) { if (F.sentIdx !== i) { F.sentIdx = i; eagleSay(F.sentences[i]); } break; }
    }
  }

  function timedSentences(F) {
    let i = 0;
    const next = () => {
      if (S.flight !== F) return;
      if (F.paused) { F.subTimer = setTimeout(next, 500); return; }
      if (i >= F.sentences.length) return;
      eagleSay(F.sentences[i]);
      F.subTimer = setTimeout(next, Math.max(2400, F.sentences[i].length * 170));
      i++;
    };
    next();
  }

  function readyToLand(F) {
    if (S.flight !== F || F.landReady) return;
    F.landReady = true;
    setLandPill('着陸する', true);
    setFlightStatus(F.mystery ? '答えを選んだら「着陸する」を押すのじゃ' : '「着陸する」で現地広場へ降りるぞ');
  }

  function setLandPill(text, enabled) {
    const b = $('#btnArrive');
    b.textContent = text;
    b.disabled = !enabled;
    b.classList.toggle('is-ready', enabled);
  }

  function setFlightStatus(t) { $('#flightStatus').textContent = t; }

  /* ---------- 一時停止・次へ ---------- */
  function togglePause() {
    const F = S.flight;
    if (!F) return;
    F.paused = !F.paused;
    $('#btnPause').textContent = F.paused ? '再開' : '一時停止';
    $('#eagleRig').classList.toggle('is-paused', F.paused);
    const vid = $('#flightMedia video');
    if (F.paused) {
      F.audio?.pause();
      vid?.pause();
      Wind.set(0);
      if (F.map) { F.phaseElapsed = performance.now() - F.phaseStart; F.map.stopCameraAnimation?.(); }
    } else {
      F.audio?.play().catch(() => {});
      vid?.play().catch(() => {});
      Wind.set(S.seVol);
      if (F.map && F.idx >= 0) runPhase(F, F.idx, true); // 今の区間の続きを現在の視点から
    }
  }

  function nextStep() {
    const F = S.flight;
    if (!F) return;
    if (F.paused) togglePause();
    if (F.kind === 'map3d') {
      if (F.phases[F.idx]?.final) return;
      F.map.stopCameraAnimation?.();
      runPhase(F, F.idx + 1);
    } else {
      readyToLand(F);
    }
    // 案内の音声も次の文へ
    if (F.audio && F.audio.duration && F.sentences.length) {
      const total = F.sentences.reduce((n, s) => n + s.length, 0);
      const upto = F.sentences.slice(0, Math.min(F.sentIdx + 1, F.sentences.length)).reduce((n, s) => n + s.length, 0);
      F.audio.currentTime = Math.min(F.audio.duration - 0.1, upto / total * F.audio.duration + 0.05);
    }
  }

  function renderGuess(spot) {
    const others = shuffle(S.spots.filter(s => s.spot_id !== spot.spot_id)).slice(0, 3);
    const opts = shuffle([spot, ...others]);
    $('#guessChoices').innerHTML = opts.map(o => `<button type="button" class="chip" data-guess="${esc(o.spot_id)}">${esc(o.name)}</button>`).join('');
    $('#mysteryBox').hidden = false;
  }

  /* ---------- 着陸・終了 ---------- */
  async function arrive() {
    const F = S.flight;
    if (!F || !F.landReady) return;
    stopVoice();
    Wind.stop();
    clearInterval(F.tick);
    clearTimeout(F.subTimer);
    F.map?.stopCameraAnimation?.();
    if (F.mystery) {
      const ok = F.guess === F.spot.spot_id;
      const box = $('#revealBox');
      box.innerHTML = `<div><p>行き先は…</p><h2>${esc(F.spot.name)}</h2>
        <p>${F.guess ? (ok ? '🎯 大正解じゃ！さすが隊員諸君！' : 'おしい！ でも楽しい旅じゃったろう？') : 'さあ、着陸じゃ！'}</p></div>`;
      box.hidden = false;
      Music.chime();
      await sleep(reducedMotion ? 600 : 2600);
    }
    closeFlight();
    enterPlaza(F.spot);
  }

  function closeFlight() {
    const F = S.flight;
    if (F) {
      clearInterval(F.tick);
      clearTimeout(F.subTimer);
      F.map?.stopCameraAnimation?.();
    }
    S.flight = null;
    stopVoice();
    Wind.stop();
    $('#eagleRig').classList.remove('is-flying', 'is-paused');
    $('#flightMedia').innerHTML = '';
    $('#flightView').hidden = true;
  }

  function initFlight() {
    $('#btnTakeoff').addEventListener('click', takeoff);
    $('#btnArrive').addEventListener('click', arrive);
    $('#btnAbort').addEventListener('click', () => { closeFlight(); toast('引き返しました'); });
    $('#btnPause').addEventListener('click', togglePause);
    $('#btnNext').addEventListener('click', nextStep);
    $('#volVoice').addEventListener('input', e => {
      S.voiceVol = Number(e.target.value);
      if (S.audio) S.audio.volume = S.voiceVol;
    });
    $('#volSe').addEventListener('input', e => {
      S.seVol = Number(e.target.value);
      Wind.set(S.flight?.paused ? 0 : S.seVol);
    });
    $('#guessChoices').addEventListener('click', e => {
      const b = e.target.closest('[data-guess]');
      if (!b || !S.flight) return;
      S.flight.guess = b.dataset.guess;
      $$('#guessChoices .chip').forEach(x => x.classList.toggle('is-on', x === b));
      setFlightStatus('答えは着陸してからのお楽しみじゃ！');
    });
  }

  /* =============================================================
   * 顔写真アイコン（普通・笑顔・困った顔・驚いた顔）
   * ============================================================= */
  const EXPRS = C.EXPRESSIONS || [];
  S.faceCache = new Map();          // memberId → { ver, imgs: { normal, smile, trouble, surprise } }
  const FaceEdit = { pending: {}, slot: null, stream: null };
  let faceFetching = false;

  // 広場のメンバーの顔写真を、まだ持っていない／更新された人の分だけ取り寄せる
  async function ensureFaces(members) {
    const need = members.filter(m => m.faceVer > 0 && (S.faceCache.get(m.id)?.ver || 0) < m.faceVer);
    if (!need.length || faceFetching) return;
    faceFetching = true;
    try {
      const r = await api('getFaces', { ids: need.map(m => m.id) });
      need.forEach(m => {
        const f = (r.faces || {})[m.id];
        const { ver, ...imgs } = f || {};
        S.faceCache.set(m.id, { ver: ver || m.faceVer, imgs: f ? imgs : {} });
        refreshFace(m.id);
      });
      if (need.some(m => m.id === S.user?.memberId)) { renderUserChip(); renderExprBar(); }
    } catch { /* 次の更新で再試行 */ }
    finally { faceFetching = false; }
  }

  async function ensureOwnFaces() {
    if (!S.user?.memberId) return;
    await ensureFaces([{ id: S.user.memberId, faceVer: S.user.faceVer || 0 }]);
  }

  const ownFaces = () => S.faceCache.get(S.user?.memberId)?.imgs || {};

  function refreshFace(id) {
    const el = $(`#avatars .avatar[data-id="${CSS.escape(id)}"]`);
    if (el) paintFace(el);
  }

  // アバターの顔を、いまの表情の写真で描く（写真が無ければ絵文字）
  function paintFace(el) {
    const face = $('.face', el);
    const imgs = S.faceCache.get(el.dataset.id)?.imgs;
    const expr = el.dataset.temp || el.dataset.base || 'normal';
    const src = imgs && (imgs[expr] || imgs.normal);
    if (src) {
      let img = $('img', face);
      if (!img) { face.textContent = ''; img = document.createElement('img'); img.alt = ''; face.appendChild(img); }
      face.classList.add('has-photo');
      if (img.getAttribute('src') !== src) {
        img.src = src;
        face.classList.remove('swap'); void face.offsetWidth; face.classList.add('swap');
      }
    } else {
      face.classList.remove('has-photo');
      face.textContent = el.dataset.emoji || '🙂';
    }
    el.dataset.expr = expr;
  }

  // 会話・動作による一時的な表情（数秒で元に戻る）
  function setTempExpr(id, expr) {
    const el = $(`#avatars .avatar[data-id="${CSS.escape(id)}"]`);
    if (!el || !expr) return;
    el.dataset.temp = expr;
    paintFace(el);
    clearTimeout(el._exprTimer);
    el._exprTimer = setTimeout(() => { delete el.dataset.temp; paintFace(el); }, C.EXPR_HOLD_MS || 8000);
  }

  function detectExpr(text) {
    const t = String(text || '');
    for (const k of ['surprise', 'trouble', 'smile']) {
      if ((C.EXPR_WORDS?.[k] || []).some(w => t.includes(w))) return k;
    }
    return null;
  }

  // 広場の「自分の表情」ボタン
  function renderExprBar() {
    const P = S.plaza;
    if (!P) return;
    const mine = ownFaces();
    const has = Object.keys(mine).length > 0;
    $('#exprBar').innerHTML = EXPRS.map(e => `
      <button type="button" class="expr-btn${(P.myExpr || 'normal') === e.id ? ' is-on' : ''}" data-expr="${e.id}" aria-pressed="${(P.myExpr || 'normal') === e.id}">
        ${mine[e.id] ? `<img src="${mine[e.id]}" alt="">` : `<span>${e.emoji}</span>`}${esc(e.label)}
      </button>`).join('') +
      (has ? '' : '<button type="button" class="expr-hint" data-open-profile>顔写真を登録すると自分の顔で表情が変わります</button>');
  }

  function setMyExpr(expr) {
    const P = S.plaza;
    if (!P) return;
    P.myExpr = expr;
    const el = $(`#avatars .avatar[data-id="${CSS.escape(P.me)}"]`);
    if (el) { el.dataset.base = expr; delete el.dataset.temp; paintFace(el); }
    renderExprBar();
    postPlaza('expr', { expr });
  }

  /* ---------- 登録画面（プロフィール内） ---------- */
  function renderFaceSlots() {
    const mine = ownFaces();
    $('#faceSlots').innerHTML = EXPRS.map(e => {
      const src = FaceEdit.pending[e.id] || mine[e.id];
      return `<div class="face-slot${FaceEdit.slot === e.id ? ' is-target' : ''}" data-expr="${e.id}">
        <div class="face-thumb">${src ? `<img src="${src}" alt="${esc(e.label)}の顔写真">` : `<span>${e.emoji}</span>`}</div>
        <strong>${esc(e.label)}</strong>
        <div class="face-slot-btns">
          <button type="button" class="btn btn-ghost btn-sm" data-face-cam="${e.id}">カメラ</button>
          <button type="button" class="btn btn-ghost btn-sm" data-face-file="${e.id}">写真</button>
        </div>
        ${FaceEdit.pending[e.id] ? '<span class="face-new">未保存</span>' : ''}
      </div>`;
    }).join('');
    $('#btnFaceSave').disabled = !Object.keys(FaceEdit.pending).length;
    $('#btnFaceDelete').hidden = !(S.user?.faceVer > 0);
  }

  // 中央を正方形に切り抜いて縮小
  function toSquare(src, sw, sh, mirror = false) {
    const N = C.FACE_SIZE || 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = N;
    const ctx = cv.getContext('2d');
    const side = Math.min(sw, sh);
    if (mirror) { ctx.translate(N, 0); ctx.scale(-1, 1); }
    ctx.drawImage(src, (sw - side) / 2, (sh - side) / 2, side, side, 0, 0, N, N);
    return cv.toDataURL('image/jpeg', 0.85);
  }

  async function startFaceCam(expr) {
    FaceEdit.slot = expr;
    try {
      if (!FaceEdit.stream) {
        FaceEdit.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 720 } }, audio: false });
        $('#faceVideo').srcObject = FaceEdit.stream;
        await $('#faceVideo').play();
      }
      $('#faceCam').hidden = false;
      updateCamLabel();
      renderFaceSlots();
    } catch {
      toast('カメラを使えませんでした。「写真」から選んでください', true);
      stopFaceCam();
    }
  }

  function updateCamLabel() {
    const e = EXPRS.find(x => x.id === FaceEdit.slot);
    $('#faceCamLabel').textContent = e ? `「${e.label}」で撮ります ${e.emoji}` : '';
  }

  function stopFaceCam() {
    FaceEdit.stream?.getTracks().forEach(t => t.stop());
    FaceEdit.stream = null;
    $('#faceCam').hidden = true;
    FaceEdit.slot = null;
    if ($('#faceSlots').children.length) renderFaceSlots();
  }

  function shutter() {
    const v = $('#faceVideo');
    if (!v.videoWidth || !FaceEdit.slot) return;
    FaceEdit.pending[FaceEdit.slot] = toSquare(v, v.videoWidth, v.videoHeight, true);
    Music.chime();
    // まだ撮っていない表情へ自動で進む
    const mine = ownFaces();
    const next = EXPRS.find(e => !FaceEdit.pending[e.id] && !mine[e.id] && e.id !== FaceEdit.slot);
    if (next) { FaceEdit.slot = next.id; updateCamLabel(); renderFaceSlots(); }
    else { stopFaceCam(); toast('撮影しました。「顔写真を保存」を押してください'); }
  }

  async function pickFaceFile(file) {
    const expr = FaceEdit.slot;
    if (!file || !expr) return;
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise((ok, ng) => { img.onload = ok; img.onerror = ng; img.src = url; });
      FaceEdit.pending[expr] = toSquare(img, img.naturalWidth, img.naturalHeight);
      renderFaceSlots();
    } catch { toast('画像を読み込めませんでした', true); }
    finally { URL.revokeObjectURL(url); }
  }

  function initFaces() {
    $('#faceSlots').addEventListener('click', e => {
      const cam = e.target.closest('[data-face-cam]');
      const file = e.target.closest('[data-face-file]');
      if (cam) startFaceCam(cam.dataset.faceCam);
      if (file) { FaceEdit.slot = file.dataset.faceFile; $('#faceFile').click(); }
    });
    $('#faceFile').addEventListener('change', e => { pickFaceFile(e.target.files[0]); e.target.value = ''; });
    $('#btnShutter').addEventListener('click', shutter);
    $('#btnCamClose').addEventListener('click', stopFaceCam);

    $('#btnFaceSave').addEventListener('click', e => busyButton(e.currentTarget, async () => {
      const faces = { ...FaceEdit.pending };
      if (!Object.keys(faces).length) return;
      loading('顔写真を保存中…');
      try {
        const r = await api('saveFaces', { faces });
        S.user = r.user; updateStoredUser();
        S.faceCache.set(S.user.memberId, { ver: S.user.faceVer, imgs: { ...ownFaces(), ...faces } });
        FaceEdit.pending = {};
        renderFaceSlots(); renderUserChip(); renderExprBar();
        refreshFace(S.user.memberId);
        toast(r.message);
      } catch (err) { toast(err.message, true); }
      finally { loading(false); }
    }));

    $('#btnFaceDelete').addEventListener('click', e => {
      if (!confirm('登録した顔写真をすべて削除しますか？')) return;
      busyButton(e.currentTarget, async () => {
        try {
          const r = await api('deleteFaces');
          S.faceCache.delete(S.user.memberId);
          S.user = r.user; updateStoredUser();
          FaceEdit.pending = {};
          renderFaceSlots(); renderUserChip(); renderExprBar();
          refreshFace(r.user.memberId);
          toast(r.message);
        } catch (err) { toast(err.message, true); }
      });
    });

    // プロフィールを閉じたらカメラも止める
    new MutationObserver(() => { if ($('#profileModal').hidden) { stopFaceCam(); FaceEdit.pending = {}; } })
      .observe($('#profileModal'), { attributes: true, attributeFilter: ['hidden'] });

    $('#exprBar').addEventListener('click', e => {
      const b = e.target.closest('[data-expr]');
      if (b) setMyExpr(b.dataset.expr);
    });
    document.addEventListener('click', e => {
      if (e.target.closest('[data-open-profile]')) $('#btnProfile').click();
    });
  }

  /* =============================================================
   * 現地合流広場
   * ============================================================= */
  async function enterPlaza(spot) {
    showView('plaza');
    const P = S.plaza = {
      spot, me: null, since: 0, seen: new Set(), timers: [],
      members: new Map(), polling: false, moveTimer: null,
      calls: [], bgCache: {}, bgImg: null, bgKind: null, myExpr: 'normal'
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
    renderCalls([]);
    renderExprBar();

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
    if (r.calls) renderCalls(r.calls);
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
    ensureFaces(list);
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
    el.dataset.emoji = m.avatar || '🙂';
    // 表情：自分は手元で選んだもの、他の人はサーバーの値
    if (kind === 'me') el.dataset.base = S.plaza?.myExpr || m.expr || 'normal';
    else if (kind !== 'npc') el.dataset.base = m.expr || 'normal';
    paintFace(el);
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
        if (!mine) { chatLine(log.nickname, p.text); bubble(log.member, p.text); setTempExpr(log.member, p.expr); }
        break;
      case 'action':
        if (!mine) { doAction(log.member, p.id, p.song); chatLine(null, `${log.nickname}さん：${actionLabel(p.id)}`); }
        break;
      case 'call':
        if (!mine) {
          chatLine(null, p.state === 'ended'
            ? `${log.nickname}さんの${p.name || svcOf(p.service).name}通話が終了しました`
            : `📹 ${log.nickname}さんが${p.name || svcOf(p.service).name}で通話を始めました（「参加」から入れます）`);
          if (p.state !== 'ended') { Music.chime(); bubble(log.member, '📹 通話しよう！'); }
        }
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
    if (!memberId.startsWith('npc:')) setTempExpr(memberId, 'smile');
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
    const expr = detectExpr(text);
    chatLine(S.user.nickname, text);
    bubble(P.me, text);
    setTempExpr(P.me, expr);
    postPlaza('chat', { text, expr });
  }

  function leavePlaza(silent = false) {
    const P = S.plaza;
    if (!P) return;
    P.timers.forEach(t => { clearInterval(t); clearTimeout(t); });
    clearTimeout(P.moveTimer);
    $('#stageSv').innerHTML = '';
    closeModal('#callModal');
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
   * 現地ビデオ通話（Meet / Zoom / LINE / Messenger）＋ 現地背景画像
   * ============================================================= */
  const svcOf = id => (C.CALL_SERVICES || {})[id] || { name: id, icon: '📹' };
  const timeAgo = ts => { const m = Math.floor((Date.now() - ts) / 60000); return m < 1 ? 'たった今' : m < 60 ? `${m}分前` : `${Math.floor(m / 60)}時間前`; };

  function renderCalls(list) {
    const P = S.plaza;
    if (!P) return;
    P.calls = list || [];
    // 広場の右上に常に見える通話バー
    const bar = $('#callBar');
    if (!P.calls.length) {
      bar.innerHTML = '<button type="button" class="call-start" data-call-open>📹 現地でビデオ通話を始める</button>';
    } else {
      bar.innerHTML = `<p class="call-live">📹 現地で${P.calls.length}件の通話中</p>` +
        P.calls.slice(0, 2).map(c => `
          <div class="call-item">
            <span class="call-svc">${svcOf(c.service).icon} ${esc(c.serviceName)}</span>
            <span class="call-title">${esc(c.title)}</span>
            <button type="button" class="btn btn-primary btn-sm" data-call-join="${esc(c.id)}">参加</button>
          </div>`).join('') +
        '<button type="button" class="call-more" data-call-open>背景をつくる・通話を始める</button>';
    }
    // モーダル内の一覧
    $('#callList').innerHTML = P.calls.length ? P.calls.map(c => `
      <li class="call-row">
        <span class="call-svc">${svcOf(c.service).icon} ${esc(c.serviceName)}</span>
        <span class="call-main"><strong>${esc(c.title)}</strong><small>${esc(c.nickname)}さん　${timeAgo(c.createdAt)}</small></span>
        <button type="button" class="btn btn-primary btn-sm" data-call-join="${esc(c.id)}">参加する</button>
        ${c.mine ? `<button type="button" class="btn btn-ghost btn-sm" data-call-end="${esc(c.id)}">終了</button>` : ''}
      </li>`).join('') : '<li class="empty">まだ通話はありません。下の手順で始めてみましょう</li>';
  }

  function joinCall(id) {
    const c = S.plaza?.calls?.find(x => x.id === id);
    if (!c) return;
    window.open(c.url, '_blank', 'noopener');
    toast(`${c.serviceName}を開きました。現地の背景を設定して入りましょう`);
  }

  function openCallModal() {
    const P = S.plaza;
    if (!P) return;
    $('#svcGrid').innerHTML = Object.entries(C.CALL_SERVICES || {}).map(([id, s]) => `
      <div class="svc-card">
        <a class="btn btn-outline btn-sm" href="${esc(s.open)}" target="_blank" rel="noopener">${s.icon} ${esc(s.name)}を開く</a>
        <small>${esc(s.how)}</small>
      </div>`).join('');
    const kinds = [
      { k: 'street', h: 0, label: 'ストリートビュー（北）' },
      { k: 'street', h: 90, label: '東' },
      { k: 'street', h: 180, label: '南' },
      { k: 'street', h: 270, label: '西' },
      { k: 'aerial', h: 0, label: '航空写真' },
      ...(P.spot.image_url ? [{ k: 'photo', h: 0, label: '登録写真' }] : []),
      { k: 'scene', h: 0, label: '現地のイラスト' }
    ];
    $('#bgKinds').innerHTML = kinds.map((o, i) =>
      `<button type="button" class="chip${i === 0 ? ' is-on' : ''}" data-bg="${o.k}" data-h="${o.h}">${esc(o.label)}</button>`).join('');
    renderCalls(P.calls);
    openModal('#callModal');
    loadBg('street', 0);
  }

  async function loadBg(kind, heading) {
    const P = S.plaza;
    if (!P) return;
    P.bgCache = P.bgCache || {};
    P.bgKind = { kind, heading };
    const key = kind + heading;
    const msg = $('#bgMsg');
    msg.hidden = true;
    if (kind === 'scene') { P.bgImg = null; drawBg(); return; }
    if (P.bgCache[key]) { P.bgImg = P.bgCache[key]; drawBg(); return; }
    msg.textContent = '現地の画像を取り寄せています…';
    msg.hidden = false;
    try {
      const r = await api('callBackground', { spot_id: P.spot.spot_id, kind, heading });
      const img = new Image();
      await new Promise((ok, ng) => { img.onload = ok; img.onerror = ng; img.src = `data:${r.mime};base64,${r.base64}`; });
      if (S.plaza !== P || P.bgKind.kind + P.bgKind.heading !== key) return;
      P.bgCache[key] = img;
      P.bgImg = img;
      msg.hidden = true;
      drawBg();
    } catch (err) {
      if (S.plaza !== P) return;
      msg.textContent = `${err.message || '画像を取得できませんでした'}（いまは現地のイラストを表示しています）`;
      P.bgImg = null;
      drawBg();
    }
  }

  const SCENE_COLORS = {
    bbq:    { sky: ['#7cc0f2', '#bfe1f7', '#f7e2b5'], ground: '#5f9f4f' },
    stage:  { sky: ['#2b1f55', '#7a3f7f', '#f08a5d'], ground: '#4b3a2c' },
    sight:  { sky: ['#6fb3ea', '#cde6f8', '#eef6fb'], ground: '#c9b48c' },
    nature: { sky: ['#8fd0f0', '#cfeee0', '#e2f3e0'], ground: '#4f8f45' },
    night:  { sky: ['#0b1d3a', '#1a3460', '#23406e'], ground: '#222d3d' }
  };

  function drawBg() {
    const P = S.plaza;
    if (!P) return;
    const cv = $('#bgCanvas');
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);

    if (P.bgImg) {
      // 画面いっぱいに切り抜いて配置（少しだけ彩度を上げる）
      const img = P.bgImg;
      const sc = Math.max(W / img.width, H / img.height);
      const w = img.width * sc, h = img.height * sc;
      ctx.filter = 'saturate(1.1)';
      ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
      ctx.filter = 'none';
    } else {
      const cat = catOf(P.spot.category);
      const sc = SCENE_COLORS[cat.scene] || SCENE_COLORS.sight;
      const g = ctx.createLinearGradient(0, 0, 0, H);
      sc.sky.forEach((c, i) => g.addColorStop(i / (sc.sky.length - 1), c));
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      if (cat.scene === 'night') {
        ctx.fillStyle = '#fff';
        for (let i = 0; i < 140; i++) { ctx.globalAlpha = Math.random() * .8 + .2; ctx.fillRect(Math.random() * W, Math.random() * H * .55, 2.5, 2.5); }
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = sc.ground;
      ctx.beginPath(); ctx.moveTo(0, H * .62);
      ctx.quadraticCurveTo(W / 2, H * .5, W, H * .62); ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.fill();
      ctx.font = '260px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(cat.prop, W * .78, H * .6);
    }

    if ($('#bgLabel').checked) {
      // 場所名の札（顔にかぶりにくい左下）
      const grd = ctx.createLinearGradient(0, H * .7, 0, H);
      grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(1, 'rgba(0,0,0,.45)');
      ctx.fillStyle = grd; ctx.fillRect(0, H * .7, W, H * .3);
      const name = P.spot.name;
      ctx.font = '800 64px "M PLUS Rounded 1c", sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      const tw = Math.min(ctx.measureText(`📍 ${name}`).width, W * .6);
      ctx.fillStyle = 'rgba(255,255,255,.92)';
      roundRect(ctx, 56, H - 196, tw + 80, 104, 52); ctx.fill();
      ctx.fillStyle = '#163A63';
      ctx.fillText(`📍 ${name}`, 96, H - 124, W * .6);
      ctx.font = '700 34px "M PLUS Rounded 1c", sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText('🦅 現地集合フライトで集合中', 72, H - 44);
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  async function saveBg() {
    const P = S.plaza;
    if (!P) return;
    const blob = await new Promise(r => $('#bgCanvas').toBlob(r, 'image/jpeg', 0.92));
    const name = `${P.spot.name}_通話背景.jpg`.replace(/[\\/:*?"<>|]/g, '');
    const file = new File([blob], name, { type: 'image/jpeg' });
    // スマホは共有シートから「画像を保存」
    if (navigator.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ files: [file], title: name }); return; } catch { /* キャンセル時はダウンロードへ */ }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    toast('背景画像を保存しました。通話アプリの背景に設定してください');
  }

  function initCall() {
    $('#btnCall').addEventListener('click', openCallModal);
    document.addEventListener('click', e => {
      if (e.target.closest('[data-call-open]')) { openCallModal(); return; }
      const j = e.target.closest('[data-call-join]');
      if (j) { joinCall(j.dataset.callJoin); return; }
      const en = e.target.closest('[data-call-end]');
      if (en) {
        if (!confirm('この通話の掲示を終了しますか？（通話アプリ側の通話は各アプリで終了してください）')) return;
        busyButton(en, async () => {
          try { const r = await api('callEnd', { id: en.dataset.callEnd }); renderCalls(r.calls); toast(r.message); }
          catch (err) { toast(err.message, true); }
        });
      }
    });
    $('#bgKinds').addEventListener('click', e => {
      const b = e.target.closest('[data-bg]');
      if (!b) return;
      $$('#bgKinds .chip').forEach(x => x.classList.toggle('is-on', x === b));
      loadBg(b.dataset.bg, Number(b.dataset.h));
    });
    $('#bgLabel').addEventListener('change', drawBg);
    $('#btnBgSave').addEventListener('click', e => busyButton(e.currentTarget, saveBg));
    $('#btnCallPost').addEventListener('click', e => busyButton(e.currentTarget, async () => {
      const P = S.plaza;
      const url = $('#callUrl').value.trim();
      if (!P || !url) { toast('通話のリンクを貼り付けてください', true); return; }
      try {
        const r = await api('callPost', { spot_id: P.spot.spot_id, url, title: $('#callName').value.trim() });
        renderCalls(r.calls);
        $('#callUrl').value = ''; $('#callName').value = '';
        chatLine(null, 'あなたが現地に通話を掲示しました');
        toast(r.message);
      } catch (err) { toast(err.message, true); }
    }));
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

    // Googleマップのリンクから行き先を読み取る
    $('#btnMapsPaste').addEventListener('click', async () => {
      try {
        const t = await navigator.clipboard.readText();
        $('#mapsLinkInput').value = t.trim();
        if (/https?:\/\//.test(t)) $('#btnMapsResolve').click();
      } catch { toast('貼り付けできませんでした。入力欄を長押しして貼り付けてください', true); }
    });
    $('#mapsLinkInput').addEventListener('paste', () => setTimeout(() => {
      if (/https?:\/\/\S*(goo\.gl|google\.)/.test($('#mapsLinkInput').value)) $('#btnMapsResolve').click();
    }, 50));
    $('#btnMapsResolve').addEventListener('click', e => busyButton(e.currentTarget, async () => {
      const text = $('#mapsLinkInput').value.trim();
      if (!text) { toast('Googleマップのリンクを貼り付けてください', true); return; }
      loading('リンクから場所を読み取り中…');
      try {
        const r = await api('resolveMapUrl', { text });
        fillAddForm(r.spot);
        const dup = S.spots.find(s => Math.abs(s.lat - r.spot.lat) < 0.002 && Math.abs(s.lng - r.spot.lng) < 0.002);
        const box = $('#mapsResolved');
        box.innerHTML = `<p><strong>${esc(r.spot.name)}</strong><br>📍 ${esc(r.spot.address || '')}（${r.spot.lat}, ${r.spot.lng}）</p>
          ${dup ? `<p class="warn">近くに登録済みの行き先「${esc(dup.name)}」があります。</p>` : ''}
          ${S.mapsKey ? `<div class="peek"><iframe src="${esc(mapsEmbedUrl(r.spot, 'view'))}" loading="lazy" title="読み取った場所"></iframe></div>` : ''}
          <p class="note">内容を確認・修正して「行き先に登録」を押してください。</p>`;
        box.hidden = false;
      } catch (err) { toast(err.message, true); }
      finally { loading(false); }
    }));

    $('#addSpotForm').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      const spot = Object.fromEntries(new FormData(f).entries());
      spot.lat = Number(spot.lat); spot.lng = Number(spot.lng);
      if (spot.maps_url) spot.source = 'googlemap';
      await busyButton($('button[type=submit]', f), async () => {
        try {
          const r = await api('upsertSpot', { spot });
          toast(r.message);
          f.reset();
          $('#mapsLinkInput').value = '';
          $('#mapsResolved').hidden = true;
          await loadSpots();
        } catch (err) { toast(err.message, true); }
      });
    });
  }

  function fillAddForm(sp) {
    const f = $('#addSpotForm');
    ['name', 'lat', 'lng', 'description', 'address', 'maps_url', 'flight_video_url', 'image_url'].forEach(k => {
      if (f[k]) f[k].value = sp[k] ?? '';
    });
    f.category.value = C.CATEGORIES[sp.category] ? sp.category : 'その他';
    f.activity_tags.value = Array.isArray(sp.activity_tags) ? sp.activity_tags.join(',') : (sp.activity_tags || '');
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
  // 画面だけの修正（v1.3.0→v1.3.1 など）では警告しないよう、メジャー・マイナーで比較
  const sameMinor = (a, b) => String(a || '').split('.').slice(0, 2).join('.') === String(b || '').split('.').slice(0, 2).join('.');
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
    const warn = sv.state === 'ok' && sv.version && !sameMinor(sv.version, C.VERSION) ? '（版が異なります）' : '';
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
    const mismatch = sv.state === 'ok' && sv.version && !sameMinor(sv.version, C.VERSION);
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
        const mm = r.version && !sameMinor(r.version, C.VERSION) ? `（画面は ${C.VERSION}。版が異なります）` : '';
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
    initCall();
    initFaces();
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
