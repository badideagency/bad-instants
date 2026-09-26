/*
 * main.js — MyInstants paneli arayüzü.
 * Siteyle ilgili hiçbir ayrıntı burada yok; hepsi siteScraper.js'te.
 */
(function () {
  'use strict';

  const S = window.SiteScraper;
  const HOVER_DELAY_MS = 150;
  const PANEL_STARTED_AT = Date.now();
  const TABS = ['trending', 'best', 'recent', 'category'];
  const TAB_TITLES = {
    trending: 'Trending',
    best: 'Hall of Fame',
    recent: 'Just Added',
    category: 'Kategoriler',
    search: 'Arama',
  };
  const ERROR_TEXT = {
    offline: 'İnternet bağlantısı yok gibi görünüyor. Bağlantınızı kontrol edip tekrar deneyin.',
    timeout: 'myinstants.com cevap vermiyor (zaman aşımı). Biraz sonra tekrar deneyin.',
    server: 'myinstants.com şu an cevap vermiyor. Biraz sonra tekrar deneyin.',
    busy: 'Site çok fazla istek aldığını söylüyor. Bir dakika bekleyip tekrar deneyin.',
    cors: 'Panel siteye bağlanamıyor: tarayıcı güvenlik ayarı (--disable-web-security) etkin değil. Premiere’i tamamen kapatıp açın; sürerse bu durumu bildirin.',
    nofetch: 'Panelin tarayıcısı istek atamıyor. Bu durumu bildirin.',
    notfound: 'Bu sayfa sitede bulunamadı.',
    parse: 'Sayfa açıldı ama içinde ses bulunamadı. Sitenin yapısı değişmiş olabilir.',
    notaudio: 'Siteden gelen dosya ses değil.',
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    searchForm: $('searchForm'),
    searchInput: $('searchInput'),
    searchClear: $('searchClear'),
    refreshBtn: $('refreshBtn'),
    region: $('region'),
    volume: $('volume'),
    volumeLabel: $('volumeLabel'),
    tabs: $('tabs'),
    categoryBar: $('categoryBar'),
    categorySelect: $('categorySelect'),
    searchBar: $('searchBar'),
    searchLabel: $('searchLabel'),
    searchExit: $('searchExit'),
    notice: $('notice'),
    list: $('list'),
    rows: $('rows'),
    listEnd: $('listEnd'),
    statusText: $('statusText'),
    hostText: $('hostText'),
  };

  /* ------------------------------------------------------------------ ayarlar */

  const store = {
    get(key, def) {
      try {
        const v = localStorage.getItem('mi.' + key);
        return v === null ? def : v;
      } catch (e) {
        return def;
      }
    },
    set(key, val) {
      try {
        localStorage.setItem('mi.' + key, String(val));
      } catch (e) {
        /* yoksay */
      }
    },
  };

  const savedTab = store.get('tab', 'trending');
  const savedVolume = parseInt(store.get('volume', '60'), 10);

  const state = {
    tab: TABS.includes(savedTab) ? savedTab : 'trending',
    prevTab: 'trending',
    region: S.normalizeRegion(store.get('region', S.DEFAULT_REGION)),
    category: store.get('category', ''),
    categories: null,
    query: '',
    page: 0,
    count: 0,
    seen: new Set(),
    hasMore: false,
    loading: false,
    error: null, // { err, reset } — listenin sonunda gösterilen hata
    notice: null, // { err, title, retry } — listenin üstünde gösterilen uyarı (ör. önizleme doğrulaması)
    token: 0,
    flash: '', // durum çubuğunda kısa süre görünen bilgi
  };

  /* ------------------------------------------------------------------ Premiere bağlantısı */

  let cs = null;
  try {
    if (window.__adobe_cep__ && window.CSInterface) cs = new CSInterface();
  } catch (e) {
    cs = null;
  }

  function applyTheme() {
    if (!cs) return;
    try {
      const c = cs.getHostEnvironment().appSkinInfo.panelBackgroundColor.color;
      setThemeFromRgb(Math.round(c.red), Math.round(c.green), Math.round(c.blue));
    } catch (e) {
      /* varsayılan koyu tema kalır */
    }
  }

  function setThemeFromRgb(r, g, b) {
    const dark = (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
    const clamp = (v) => Math.max(0, Math.min(255, v));
    const shade = (d) => `rgb(${clamp(r + d)}, ${clamp(g + d)}, ${clamp(b + d)})`;
    const s = document.documentElement.style;
    s.setProperty('--bg', `rgb(${r}, ${g}, ${b})`);
    s.setProperty('--bg-raised', shade(dark ? 12 : -12));
    s.setProperty('--bg-hover', shade(dark ? 22 : -20));
    s.setProperty('--bg-sunken', shade(dark ? -8 : 10));
    s.setProperty('--border', shade(dark ? 30 : -34));
    s.setProperty('--line', dark ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.06)');
    s.setProperty('--text', dark ? '#d6d6d6' : '#1f1f1f');
    s.setProperty('--text-strong', dark ? '#ffffff' : '#000000');
    s.setProperty('--text-dim', dark ? '#8c8c8c' : '#5c5c5c');
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  }

  let hostVersion = ''; // Premiere sürümü (zaman birimi bu sürüme göre saklanır)

  function pingHost() {
    const setHost = (text, cls) => {
      el.hostText.textContent = text;
      el.hostText.className = cls || '';
    };
    if (!cs) {
      setHost('Premiere dışında');
      return;
    }
    cs.evalScript('typeof mi_ping === "function" ? mi_ping() : "noscript"', (res) => {
      const r = String(res || '');
      if (r.indexOf('ok|') === 0) {
        hostVersion = r.slice(3);
        setHost('Premiere ' + hostVersion + ' ✓', 'ok');
      }
      else setHost('Premiere bağlantısı yok', 'bad');
    });
  }

  /* ------------------------------------------------------------------ Cloudflare doğrulaması */

  // Doğrula tuşu myinstants.com'u window.open ile PANELİN KENDİ Chromium'unda açar; böylece orada
  // alınan Cloudflare çerezi paneldeki isteklerde de geçerli olur. (Sistem tarayıcısı KULLANILMAZ:
  // onun çerezleri ayrıdır.) Pencere kapanınca bekleyen istek otomatik tekrarlanır.
  const verify = {
    win: null,
    timer: null,
    retry: null,
    openFailed: false,
    justVerified: false, // son doğrulamadan sonraki ilk deneme sürüyor / başarısız oldu
  };

  function openVerifyWindow(url, retry) {
    verify.retry = retry;
    verify.justVerified = false;
    if (verify.win && !isClosed(verify.win)) {
      try {
        verify.win.focus();
      } catch (e) {
        /* yoksay */
      }
      return;
    }
    let w = null;
    try {
      w = window.open(url || S.BASE + '/', 'myinstants-verify', 'width=460,height=640,resizable=yes,scrollbars=yes');
    } catch (e) {
      w = null;
    }
    if (!w) {
      verify.openFailed = true;
      console.warn('[MyInstants] Doğrulama penceresi açılamadı (window.open null döndü)');
      rerenderMessages();
      return;
    }
    verify.openFailed = false;
    verify.win = w;
    clearInterval(verify.timer);
    verify.timer = setInterval(() => {
      if (isClosed(w)) finishVerify();
    }, 500);
    rerenderMessages();
  }

  function isClosed(w) {
    try {
      return w.closed;
    } catch (e) {
      return true;
    }
  }

  // Pencere kapandı (ya da kullanıcı "Doğrulamayı bitirdim" dedi) → bekleyen isteği tekrarla
  function finishVerify() {
    clearInterval(verify.timer);
    verify.timer = null;
    if (verify.win && !isClosed(verify.win)) {
      try {
        verify.win.close();
      } catch (e) {
        /* yoksay */
      }
    }
    verify.win = null;
    verify.justVerified = true;
    const retry = verify.retry;
    verify.retry = null;
    rerenderMessages();
    if (retry) retry();
  }

  // Bir istek doğrulama istemeden başarılı olunca çağrılır (çerez kalıcılığı teşhisi için).
  function noteSuccess() {
    if (verify.justVerified) {
      verify.justVerified = false;
      store.set('verifiedAt', Date.now());
      flash('Doğrulama tamam ✓');
      return;
    }
    const at = Number(store.get('verifiedAt', '0'));
    if (at && at < PANEL_STARTED_AT && !noteSuccess.reported) {
      noteSuccess.reported = true;
      flash(`Doğrulama istenmedi (son doğrulama ${ago(at)})`);
    }
  }

  function ago(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'az önce';
    if (m < 60) return m + ' dk önce';
    const h = Math.round(m / 60);
    if (h < 48) return h + ' sa önce';
    return Math.round(h / 24) + ' gün önce';
  }

  function flash(text) {
    state.flash = text;
    renderStatus();
    clearTimeout(flash.timer);
    flash.timer = setTimeout(() => {
      state.flash = '';
      renderStatus();
    }, 8000);
  }

  function button(text, cls, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  function line(text, cls) {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    d.textContent = text;
    return d;
  }

  // "Site doğrulama istiyor" kutusu. after: pencere kapanınca ne olacağı (liste yenilenir / ses denenir)
  function challengeBox(err, title, retry, after = 'liste kendiliğinden yenilenir') {
    const box = document.createElement('div');
    box.className = 'msg error challenge';
    box.append(line('⚠', 'icon'), line(title || 'Site doğrulama istiyor.', 'title'));

    if (verify.win && !isClosed(verify.win)) {
      box.append(
        line(`Doğrulama penceresi açık. Oradaki adımı tamamlayıp pencereyi kapatın; ${after}.`),
        button('Doğrulamayı bitirdim', 'retry', finishVerify)
      );
      return box;
    }

    if (verify.openFailed) {
      box.append(line('Doğrulama penceresi açılamadı: Premiere yeni pencereye izin vermedi. Bu durumu bildirin.'));
    } else if (verify.justVerified) {
      box.append(
        line(
          err.hardBlock
            ? 'Doğrulamadan sonra site hâlâ engelliyor (“Sorry, you have been blocked”). Doğrulama bu engeli kaldırmıyor; bu durumu bildirin.'
            : 'Doğrulamadan sonra site hâlâ doğrulama istiyor. Penceredeki adımı tamamladığınızdan emin olun; sürerse bu durumu bildirin.'
        )
      );
    } else {
      box.append(
        line(
          `Doğrula tuşu myinstants.com’u küçük bir pencerede açar. Oradaki “insan olduğunuzu doğrulayın” adımını tamamlayıp pencereyi kapatın; ${after}.`
        )
      );
      const at = Number(store.get('verifiedAt', '0'));
      if (at && at < PANEL_STARTED_AT) {
        box.append(
          line(
            `Not: En son ${ago(at)} doğrulamıştınız. Panel/Premiere yeniden açılınca doğrulama korunmamış (çerez silinmiş ya da süresi dolmuş).`,
            'detail'
          )
        );
        console.warn('[MyInstants] Önceki doğrulama bu oturumda geçerli değil. verifiedAt=' + new Date(at).toISOString());
      }
    }
    box.append(button('Doğrula', 'retry primary', () => openVerifyWindow(err.url, retry)));
    if (err.status) box.append(line('HTTP ' + err.status + (err.hardBlock ? ' · engel sayfası' : ' · doğrulama sayfası'), 'detail'));
    return box;
  }

  function errorBox(err, retry, title, onClose) {
    let kind = err.kind || 'server';
    if ((kind === 'server' || kind === 'timeout') && navigator.onLine === false) kind = 'offline';
    const box = document.createElement('div');
    box.className = 'msg error';
    box.append(line('⚠', 'icon'));
    if (title) box.append(line(title, 'title'));
    box.append(line(err.userMessage || ERROR_TEXT[kind] || ERROR_TEXT.server));
    const detail = err.detail || [err.status ? 'HTTP ' + err.status : '', err.kind ? '' : err.message].filter(Boolean).join(' · ');
    if (detail) box.append(line(detail, 'detail'));
    if (retry && !err.noRetry) box.append(button('Tekrar dene', 'retry', retry));
    if (onClose) box.append(button('Kapat', 'retry', onClose));
    return box;
  }

  function closeNotice() {
    state.notice = null;
    renderNotice();
  }

  function renderNotice() {
    el.notice.replaceChildren();
    el.notice.hidden = !state.notice;
    if (!state.notice) return;
    const n = state.notice;
    if (n.lines) {
      el.notice.append(infoBox(n.title, n.lines));
      return;
    }
    el.notice.append(
      n.err.kind === 'challenge'
        ? challengeBox(n.err, n.title, n.retry, n.after || 'ses yeniden denenir')
        : errorBox(n.err, n.retry, n.title, closeNotice)
    );
  }

  function rerenderMessages() {
    renderNotice();
    renderListEnd();
  }

  /* ------------------------------------------------------------------ önizleme */

  const preview = (function () {
    const audio = new Audio();
    audio.preload = 'auto';
    let timer = null;
    let row = null;
    let item = null;
    let onFail = null;

    function release() {
      if (row) row.classList.remove('playing', 'buffering');
      row = null;
      item = null;
    }

    function stop() {
      clearTimeout(timer);
      timer = null;
      release();
      if (!audio.paused) audio.pause();
      if (audio.getAttribute('src')) {
        audio.removeAttribute('src');
        audio.load();
      }
    }

    function fail(r, it) {
      r.classList.remove('playing', 'buffering');
      r.classList.add('error');
      if (onFail) onFail(it);
    }

    function play(r, it) {
      stop();
      row = r;
      item = it;
      r.classList.remove('error');
      r.classList.add('playing', 'buffering');
      audio.src = it.mp3; // doğrudan sitenin adresi
      const p = audio.play();
      if (p && p.catch) {
        p.catch((err) => {
          if (row === r && err && err.name !== 'AbortError' && err.name !== 'NotSupportedError') {
            release();
            fail(r, it);
          }
        });
      }
    }

    audio.addEventListener('playing', () => {
      if (row) row.classList.remove('buffering');
    });
    audio.addEventListener('ended', release);
    audio.addEventListener('error', () => {
      if (row && audio.getAttribute('src')) {
        const r = row;
        const it = item;
        release();
        fail(r, it);
      }
    });

    return {
      hoverStart(r, it) {
        clearTimeout(timer);
        timer = setTimeout(() => play(r, it), HOVER_DELAY_MS);
      },
      hoverEnd(r) {
        clearTimeout(timer);
        timer = null;
        if (row === r) stop();
      },
      stop,
      setVolume(v) {
        audio.volume = Math.max(0, Math.min(1, v));
      },
      onFail(fn) {
        onFail = fn;
      },
      get audio() {
        return audio;
      },
    };
  })();

  // Bir ses çalınamazsa aynı adresi tarayıcıyla kontrol et: sebep Cloudflare doğrulamasıysa söyle.
  preview.onFail(async (item) => {
    if (!item) return;
    try {
      await S.fetchAudio(item.mp3);
    } catch (err) {
      console.warn('[MyInstants] Önizleme çalınamadı:', item.mp3, err);
      if (err.kind === 'challenge') showAudioChallenge(item, err);
    }
  });

  function showAudioChallenge(item, err) {
    state.notice = {
      err,
      title: 'Ses çalınamadı: site doğrulama istiyor.',
      // Doğrulama penceresi kapanınca aynı sesi tekrar dene
      retry: async () => {
        try {
          await S.fetchAudio(item.mp3);
          state.notice = null;
          el.rows.querySelectorAll('.row.error').forEach((r) => r.classList.remove('error'));
          noteSuccess();
        } catch (e) {
          if (e.kind === 'challenge') showAudioChallenge(item, e);
          else state.notice = null;
        }
        renderNotice();
      },
    };
    renderNotice();
  }

  /* ------------------------------------------------------------------ İndir → import → timeline */

  const DL_IDLE = '⬇ İndir';
  const JOB_TEXT = {
    nohost: 'Premiere bağlantısı yok (panel Premiere dışında açık).',
    hostscript: 'Premiere komutu çalışmadı (host.jsx yüklenmemiş olabilir). Paneli kapatıp açın.',
    hosttimeout: 'Premiere 60 saniye içinde cevap vermedi.',
    noproject: 'Premiere’de açık bir proje yok.',
    nosequence: 'Açık bir sequence yok. Timeline’da bir sequence açıp tekrar deneyin.',
    nobin: 'Projede “MyInstants” bin’i oluşturulamadı.',
    importfailed: 'Premiere dosyayı içe aktaramadı.',
    noduration: 'Sesin süresi okunamadı.',
    noplayhead: 'Playhead konumu okunamadı.',
    notrack: 'Boş ses track’i yok ve yeni ses track’i eklenemedi. Timeline’a elle bir ses track’i ekleyip tekrar deneyin.',
    placefailed: 'Ses hiçbir ses track’ine yerleştirilemedi (track türleri sese uymuyor olabilir).',
    unitfailed: 'Ses playhead’e yerleştirilemedi: zaman birimi iki şekilde de tutmadı. Yanlış yere düşen klip silindi, timeline değişmedi. Bu durumu bildirin.',
    damaged: 'DİKKAT: Yerleştirme mevcut bir klibi değiştirdi. Hemen Ctrl+Z ile geri alın ve bu durumu bildirin.',
    cleanupfailed: 'DİKKAT: Yanlış yere düşen klip silinemedi. Ctrl+Z ile geri alın ve bu durumu bildirin.',
    exception: 'Premiere tarafında beklenmeyen bir hata oldu.',
    noperm: 'Dosya kaydedilemedi: klasöre yazma izni yok.',
    nospace: 'Dosya kaydedilemedi: diskte yer yok.',
    write: 'Dosya kaydedilemedi.',
    read: 'Daha önce indirilen dosya okunamadı.',
    nonode: 'Panel diske yazamıyor (Node.js kapalı). Kurulumu kontrol edin.',
    toomany: 'Bu adla çok fazla dosya var; klasörü temizleyip tekrar deneyin.',
  };
  const NO_RETRY = ['damaged', 'cleanupfailed', 'unitfailed'];

  function jobError(code, extra) {
    const e = new Error(code);
    e.kind = code;
    e.userMessage = JOB_TEXT[code] || '';
    e.noRetry = NO_RETRY.includes(code);
    if (extra) Object.assign(e, extra);
    return e;
  }

  // evalScript'i Promise'e çevirir; host fonksiyonları JSON döndürür.
  function callHost(script, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      if (!cs) {
        reject(jobError('nohost'));
        return;
      }
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          reject(jobError('hosttimeout'));
        }
      }, timeoutMs);
      cs.evalScript(script, (res) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          resolve(JSON.parse(res));
        } catch (e) {
          reject(jobError('hostscript', { detail: String(res).slice(0, 200) }));
        }
      });
    });
  }

  // Sesin süresini ölçer (Premiere süreyi okuyamazsa ya da daha kısa verirse kullanılır)
  async function measureSeconds(arrayBuffer) {
    try {
      const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const buf = await new Ctx(1, 1, 44100).decodeAudioData(arrayBuffer.slice(0));
      return buf.duration || 0;
    } catch (e) {
      return 0;
    }
  }

  function setDl(btn, mode, text) {
    clearTimeout(btn._miTimer);
    btn.classList.toggle('busy', mode === 'busy');
    btn.classList.toggle('done', mode === 'done');
    btn.textContent = mode === 'busy' ? '…' : mode === 'done' ? text : DL_IDLE;
    if (mode === 'done') btn._miTimer = setTimeout(() => setDl(btn, 'idle'), 1800);
  }

  // Tıklamalar sırayla işlenir: her yerleştirme bir öncekinin kapladığı yeri görür.
  let jobChain = Promise.resolve();

  function queueDownload(item, btn) {
    if (btn.classList.contains('busy')) return;
    setDl(btn, 'busy');
    jobChain = jobChain.then(() => runJob(item, btn));
  }

  async function runJob(item, btn) {
    try {
      const r = await downloadAndPlace(item);
      setDl(btn, 'done', '✓ A' + r.track);
      if (state.notice && state.notice.jobItem === item) closeNotice();
      flash(`“${item.name}” → A${r.track}` + (r.addedTrack ? ' (yeni track)' : ''));
    } catch (err) {
      console.error('[MyInstants] İndir/yerleştir:', err);
      setDl(btn, 'idle');
      state.notice = {
        err,
        jobItem: item,
        title: `“${item.name}” eklenemedi.`,
        after: 'indirme yeniden denenir',
        retry: () => queueDownload(item, btn),
      };
      if (err.kind === 'challenge') state.notice.title = 'İndirmek için site doğrulama istiyor.';
      renderNotice();
    }
  }

  async function downloadAndPlace(item) {
    // 1) Premiere: açık proje, aktif sequence ve indirme klasörü (sequence yoksa hiçbir şey indirilmez)
    const ctx = await callHost('mi_context()');
    if (!ctx.ok) throw jobError(ctx.code, { detail: ctx.message || '' });
    if (ctx.version) hostVersion = ctx.version;

    // 2) Dosya: varsa indirme; yoksa tarayıcıyla indir, Node ile diske yaz
    let target = null;
    let seconds = 0;
    try {
      target = await LocalFiles.chooseTarget(ctx.folder, item.name, item.mp3);
      if (target.exists) {
        seconds = await measureSeconds(await LocalFiles.readFile(target.path));
      } else {
        const audio = await S.fetchAudio(item.mp3);
        await LocalFiles.ensureDir(ctx.folder);
        await LocalFiles.writeFileAtomic(target.path, audio.buffer);
        seconds = await measureSeconds(audio.buffer);
      }
    } catch (e) {
      if (e.kind && JOB_TEXT[e.kind]) throw jobError(e.kind, { detail: e.where || e.message });
      if (!e.kind) throw jobError(target && target.exists ? 'read' : 'write', { detail: e.message });
      throw e; // site hataları (doğrulama, bağlantı…) olduğu gibi
    }
    await LocalFiles.remember(ctx.folder, target.index, target.name, item.mp3);

    // 3) Premiere: import (gerekirse) + boş track'e overwrite
    const unitKey = 'timeUnit.' + (hostVersion || 'bilinmiyor');
    const hint = store.get(unitKey, '');
    const r = await callHost(
      `mi_place(${JSON.stringify(target.path)}, ${Number(seconds) || 0}, ${JSON.stringify(hint)})`
    );
    if (r.ok) {
      if (r.unit) store.set(unitKey, r.unit); // çalışan zaman birimi bu sürüm için saklanır
      return r;
    }
    // Yerleştirme sorunlarında saklı birime güvenme: bir dahaki sefer yine önce tick denensin.
    if (['unitfailed', 'damaged', 'cleanupfailed'].includes(r.code)) store.set(unitKey, '');
    const detail = r.code === 'importfailed' ? target.path : r.message || (r.track ? 'A' + r.track : '');
    throw jobError(r.code || 'exception', { detail });
  }

  /* ------------------------------------------------------------------ teşhis */

  function infoBox(title, lines) {
    const box = document.createElement('div');
    box.className = 'msg info';
    box.append(line(title, 'title'));
    const pre = document.createElement('pre');
    pre.textContent = lines.join('\n');
    box.append(pre, button('Kapat', 'retry', closeNotice));
    return box;
  }

  async function runDiagnostics() {
    const yes = (v) => (v ? 'var' : 'YOK');
    const lines = [];
    try {
      const d = await callHost('mi_diag()', 20000);
      if (d.version) hostVersion = d.version;
      lines.push('Premiere: ' + (d.version || '?'));
      if (!d.hasSequence) lines.push('Aktif sequence: YOK');
      else {
        lines.push(`Aktif sequence: ${d.sequence} (${d.audioTracks} ses track'i, kare = ${d.timebase} tick)`);
        lines.push('Kilit bilgisi (DOM isLocked): ' + yes(d.domIsLocked));
        lines.push('Kilit bilgisi (QE isLocked): ' + yes(d.qeIsLocked));
        lines.push('Track ekleme (QE addTracks): ' + yes(d.qeAddTracks));
        lines.push('Projede dosya arama (findItemsMatchingMediaPath): ' + yes(d.findByPath));
      }
      if (d.error) lines.push('Hata: ' + d.error);
    } catch (e) {
      lines.push('Premiere: ' + (e.userMessage || e.message));
    }
    const unit = store.get('timeUnit.' + (hostVersion || 'bilinmiyor'), '');
    lines.push('Zaman birimi (bu sürüm): ' + (unit === 'ticks' ? 'tick (metin)' : unit === 'seconds' ? 'saniye' : 'henüz denenmedi'));
    lines.push('Panel: 0.2.0');
    state.notice = { title: 'Teşhis', lines };
    renderNotice();
    console.log('[MyInstants] Teşhis:\n' + lines.join('\n'));
  }

  el.hostText.title = 'Tıklayın: teşhis';
  el.hostText.addEventListener('click', runDiagnostics);

  /* ------------------------------------------------------------------ liste */

  function makeRow(item) {
    const row = document.createElement('div');
    row.className = 'row';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name;
    name.title = item.name;

    const dl = document.createElement('button');
    dl.type = 'button';
    dl.className = 'dl';
    dl.textContent = DL_IDLE;
    dl.title = 'İndir ve aktif sequence’te playhead’e koy';
    dl.addEventListener('click', (e) => {
      e.stopPropagation();
      queueDownload(item, dl);
    });

    row.append(name, dl);
    row.addEventListener('mouseenter', () => preview.hoverStart(row, item));
    row.addEventListener('mouseleave', () => preview.hoverEnd(row));
    return row;
  }

  function renderListEnd() {
    const end = el.listEnd;
    end.replaceChildren();

    if (state.loading) {
      const s = document.createElement('span');
      s.className = 'loading';
      s.textContent = 'Yükleniyor…';
      end.append(s);
      return;
    }

    if (state.error) {
      const { err, reset } = state.error;
      const retry = () => loadList(reset);
      end.append(err.kind === 'challenge' ? challengeBox(err, null, retry) : errorBox(err, retry));
      return;
    }

    if (state.count === 0) {
      end.append(
        line(state.tab === 'search' ? `“${state.query}” için sonuç bulunamadı.` : 'Bu listede ses yok.', 'msg')
      );
      return;
    }

    if (state.hasMore) {
      end.append(button('Daha fazla', 'more-btn', () => loadList(false)));
      return;
    }

    end.textContent = 'Liste sonu.';
  }

  function renderStatus() {
    if (state.flash) {
      el.statusText.textContent = state.flash;
      return;
    }
    const parts = [TAB_TITLES[state.tab]];
    if (state.tab === 'category' && state.categories) {
      const c = state.categories.find((x) => x.id === state.category);
      if (c) parts.push(c.label);
    }
    if (S.isRegional(state.tab)) {
      const r = S.REGIONS.find((x) => x.code === state.region);
      parts.push(r ? r.label : state.region);
    }
    if (state.count) parts.push(`${state.count} ses`);
    el.statusText.textContent = parts.join(' · ');
  }

  async function ensureCategories() {
    if (state.categories) return;
    const res = await S.getCategories();
    state.categories = res.categories;
    el.categorySelect.replaceChildren(
      ...res.categories.map((c) => {
        const o = document.createElement('option');
        o.value = c.id;
        o.textContent = c.label;
        return o;
      })
    );
    const ids = res.categories.map((c) => c.id);
    if (!ids.includes(state.category)) {
      state.category = ids.find((id) => id.toLowerCase() === 'memes') || ids[0] || '';
    }
    el.categorySelect.value = state.category;
  }

  // reset=true: listeyi baştan yükle; false: "Daha fazla" (sonraki sayfa)
  async function loadList(reset) {
    if (!reset && (state.loading || !state.hasMore)) return;
    const token = ++state.token;
    const page = reset ? 1 : state.page + 1;

    if (reset) {
      preview.stop();
      state.page = 0;
      state.count = 0;
      state.seen = new Set();
      state.hasMore = false;
      el.rows.replaceChildren();
      el.list.scrollTop = 0;
    }
    state.loading = true;
    state.error = null;
    renderListEnd();
    renderStatus();

    try {
      if (state.tab === 'category') await ensureCategories();
      if (token !== state.token) return;

      const res = await S.getList(
        state.tab,
        { region: state.region, category: state.category, query: state.query },
        page
      );
      if (token !== state.token) return;

      const fresh = res.items.filter((it) => !state.seen.has(it.id));
      fresh.forEach((it) => state.seen.add(it.id));
      el.rows.append(...fresh.map(makeRow));
      state.page = page;
      state.count += fresh.length;
      state.hasMore = res.hasMore && fresh.length > 0;
      noteSuccess();
    } catch (err) {
      if (token !== state.token) return;
      console.error('[MyInstants]', err);
      state.error = { err, reset };
    } finally {
      if (token === state.token) {
        state.loading = false;
        renderListEnd();
        renderStatus();
      }
    }
  }

  /* ------------------------------------------------------------------ üst kontroller */

  function updateChrome() {
    el.tabs.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === state.tab);
    });

    const regional = S.isRegional(state.tab);
    el.region.classList.toggle('disabled', !regional);
    el.region.title = regional ? 'Bölge' : 'Bu liste bölgeye göre ayrılmıyor';
    el.region.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.dataset.region === state.region);
      b.setAttribute('aria-disabled', regional ? 'false' : 'true');
    });

    el.categoryBar.hidden = state.tab !== 'category';
    el.searchBar.hidden = state.tab !== 'search';
    el.searchLabel.textContent = state.tab === 'search' ? `“${state.query}” için sonuçlar` : '';
    el.searchClear.hidden = !el.searchInput.value;
  }

  function setTab(tab) {
    if (tab === state.tab) return;
    state.tab = tab;
    state.query = '';
    el.searchInput.value = '';
    store.set('tab', tab);
    updateChrome();
    loadList(true);
  }

  function startSearch(q) {
    if (state.tab !== 'search') state.prevTab = state.tab;
    state.tab = 'search';
    state.query = q;
    updateChrome();
    loadList(true);
  }

  function exitSearch() {
    el.searchInput.value = '';
    if (state.tab === 'search') {
      state.tab = state.prevTab;
      state.query = '';
      updateChrome();
      loadList(true);
    } else {
      updateChrome();
    }
  }

  el.tabs.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) setTab(b.dataset.tab);
  });

  el.region.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-region]');
    if (!b || !S.isRegional(state.tab) || b.dataset.region === state.region) return;
    state.region = S.normalizeRegion(b.dataset.region);
    store.set('region', state.region);
    updateChrome();
    loadList(true);
  });

  el.categorySelect.addEventListener('change', () => {
    state.category = el.categorySelect.value;
    store.set('category', state.category);
    loadList(true);
  });

  el.searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = el.searchInput.value.trim();
    if (q) startSearch(q);
    else exitSearch();
  });
  el.searchInput.addEventListener('input', () => {
    el.searchClear.hidden = !el.searchInput.value;
  });
  el.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') exitSearch();
  });
  el.searchClear.addEventListener('click', () => {
    exitSearch();
    el.searchInput.focus();
  });
  el.searchExit.addEventListener('click', exitSearch);

  el.refreshBtn.addEventListener('click', () => {
    S.clearCache();
    if (state.tab === 'category') state.categories = null;
    state.notice = null;
    renderNotice();
    pingHost();
    loadList(true);
  });

  function setVolume(v) {
    const n = Math.max(0, Math.min(100, Number.isFinite(v) ? v : 60));
    el.volume.value = String(n);
    el.volumeLabel.textContent = '%' + n;
    preview.setVolume(n / 100);
    return n;
  }
  el.volume.addEventListener('input', () => {
    store.set('volume', setVolume(parseInt(el.volume.value, 10)));
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) preview.stop();
  });

  /* ------------------------------------------------------------------ başlangıç */

  applyTheme();
  if (cs) cs.addEventListener(CSInterface.THEME_COLOR_CHANGED_EVENT, applyTheme);
  setVolume(savedVolume);
  updateChrome();
  pingHost();
  loadList(true);

  // Hata ayıklama ve testler için
  window.MyInstantsPanel = { state, preview, loadList, verify, runDiagnostics };
})();
