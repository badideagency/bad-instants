/*
 * main.js — MyInstants paneli arayüzü.
 * Siteyle ilgili hiçbir ayrıntı burada yok; hepsi siteScraper.js'te.
 */
(function () {
  'use strict';

  const S = window.SiteScraper;
  const HOVER_DELAY_MS = 150;
  const TABS = ['trending', 'best', 'recent', 'category', 'favorites', 'used'];
  const LOCAL_TABS = ['favorites', 'used']; // siteden değil, kitaplıktan (library.json) gelen listeler
  const TAB_TITLES = {
    trending: 'Trending',
    best: 'Hall of Fame',
    recent: 'Just Added',
    category: 'Kategoriler',
    favorites: 'Favoriler',
    used: 'Son kullanılanlar',
    search: 'Arama',
  };
  const isLocalTab = (tab) => LOCAL_TABS.includes(tab);
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
    siteTabs: $('siteTabs'),
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
    libChip: $('libChip'),
    updateChip: $('updateChip'),
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

  // Premiere'in panel rengine uyan BadIdea teması (js/theme.js). Premiere dışında varsayılan koyu renk.
  function applyTheme() {
    let bg = null;
    if (cs) {
      try {
        const c = cs.getHostEnvironment().appSkinInfo.panelBackgroundColor.color;
        bg = [c.red, c.green, c.blue];
      } catch (e) {
        bg = null;
      }
    }
    Theme.apply(bg);
  }

  let hostVersion = ''; // Premiere sürümü (zaman birimi bu sürüme göre saklanır)

  function pingHost() {
    const setHost = (text, cls) => {
      el.hostText.textContent = text;
      el.hostText.className = 'host' + (cls ? ' ' + cls : '');
    };
    if (!cs) {
      setHost('Premiere dışında');
      return;
    }
    cs.evalScript('typeof mi_ping === "function" ? mi_ping() : "noscript"', (res) => {
      const r = String(res || '');
      if (r.indexOf('ok|') === 0) {
        hostVersion = r.slice(3);
        setHost('Premiere ' + hostVersion, 'ok');
      }
      else setHost('Premiere bağlantısı yok', 'bad');
    });
  }

  /* ------------------------------------------------------------------ Cloudflare doğrulaması */

  // Site Cloudflare doğrulaması isterse panel bunu açıkça söyler ama doğrulama sayfasını AÇMAZ: Premiere panellerin
  // yeni pencere açmasına izin vermiyor; sayfayı panelin içinde göstermek ise bir sitenin, dosya yazabilen panelin
  // içinde çalışması demek (güvenlik riski). Bu doğrulamalar genelde kısa sürede kendiliğinden kalkar.
  let challengeSeen = false; // bu oturumda doğrulama istendi mi (sonra bir istek geçince haber vermek için)

  // Bir istek doğrulamaya takılmadan başarılı olunca çağrılır
  function noteSuccess() {
    if (!challengeSeen) return;
    challengeSeen = false;
    flash('Site yeniden açık');
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
    d.className = cls || 'body';
    d.textContent = text;
    return d;
  }

  // İkon + başlık satırı
  function head(iconName, title) {
    const h = document.createElement('div');
    h.className = 'head';
    const ic = Icons.svg(iconName, 16);
    if (ic) h.append(ic);
    if (title) h.append(line(title, 'title'));
    return h;
  }

  // Tuş satırı: birincil eylem her zaman en sağda (krem dolgu)
  function actionsRow(buttons) {
    const bar = document.createElement('div');
    bar.className = 'actions';
    buttons
      .filter(Boolean)
      .sort((a, b) => a.classList.contains('primary') - b.classList.contains('primary'))
      .forEach((b) => bar.append(b));
    return bar;
  }

  function srOnly(text) {
    const s = document.createElement('span');
    s.className = 'sr-only';
    s.textContent = text;
    return s;
  }

  // "Site doğrulama istiyor" kutusu: ne olduğunu ve ne yapılacağını söyler (Doğrula tuşu yok; bkz. yukarı)
  function challengeBox(err, title, retry, onClose) {
    challengeSeen = true;
    const box = document.createElement('div');
    box.className = 'msg error challenge';
    box.append(head('shield-check', title || 'Site şu an doğrulama istiyor.'));
    box.append(
      line(
        err.hardBlock
          ? 'myinstants.com bu bağlantıyı engelliyor (“Sorry, you have been blocked”). Bir süre sonra tekrar deneyin.'
          : 'myinstants.com (Cloudflare) “insan mısınız” doğrulaması istiyor; panel bu doğrulamayı gösteremiyor. Genelde birkaç dakika içinde kendiliğinden kalkar: biraz bekleyip Tekrar dene’ye basın.'
      )
    );
    box.append(line('Favorilerdeki sesler bilgisayardaki kopyadan çalmaya devam eder.', 'detail'));
    if (err.status) box.append(line('HTTP ' + err.status + (err.hardBlock ? ' · engel sayfası' : ' · doğrulama sayfası'), 'detail'));
    box.append(
      actionsRow([onClose ? button('Kapat', 'retry', onClose) : null, retry ? button('Tekrar dene', 'retry primary', retry) : null])
    );
    return box;
  }

  function errorBox(err, retry, title, onClose) {
    let kind = err.kind || 'server';
    if ((kind === 'server' || kind === 'timeout') && navigator.onLine === false) kind = 'offline';
    const box = document.createElement('div');
    box.className = 'msg error';
    const text = err.userMessage || ERROR_TEXT[kind] || ERROR_TEXT.server;
    const h = head('triangle-alert', title);
    if (!title) h.append(line(text));
    box.append(h);
    if (title) box.append(line(text));
    const detail = err.detail || [err.status ? 'HTTP ' + err.status : '', err.kind ? '' : err.message].filter(Boolean).join(' · ');
    if (detail) box.append(line(detail, 'detail'));
    box.append(
      actionsRow([
        onClose ? button('Kapat', 'retry', onClose) : null,
        retry && !err.noRetry ? button('Tekrar dene', 'retry primary', retry) : null,
      ])
    );
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
      el.notice.append(infoBox(n.title, n.lines, n.actions, n.icon, n.prose, n.tone));
      return;
    }
    el.notice.append(
      n.err.kind === 'challenge'
        ? challengeBox(n.err, n.title, n.retry, closeNotice)
        : errorBox(n.err, n.retry, n.title, closeNotice)
    );
  }

  /* ------------------------------------------------------------------ önizleme */

  const preview = (function () {
    const audio = new Audio();
    audio.preload = 'auto';
    let timer = null;
    let row = null;
    let item = null;
    let onFail = null;
    let localSource = null; // favorinin yerel kopyası için adres veren fonksiyon (yoksa null döner)
    let local = false; // şu an yerel kopya mı çalıyor
    let seq = 0; // her yeni çalma/durdurma, bekleyen yerel dosya okumasını geçersiz kılar

    function release() {
      if (row) row.classList.remove('playing', 'buffering');
      row = null;
      item = null;
    }

    function stop() {
      seq++;
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
      // Favorinin yerel kopyası varsa önce o (site sesi silse de çalışır); yoksa doğrudan sitenin adresi
      const pending = localSource ? localSource(it) : null;
      if (!pending) {
        start(r, it, it.mp3, false);
        return;
      }
      const my = seq;
      Promise.resolve(pending)
        .catch(() => null)
        .then((src) => {
          if (my === seq && row === r) start(r, it, src || it.mp3, !!src);
        });
    }

    function start(r, it, src, isLocal) {
      local = isLocal;
      audio.src = src;
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
        if (local) {
          // Yerel kopya çalınamadı (bozuk olabilir) → sitedeki adres denenir
          console.warn('[MyInstants] Yerel kopya çalınamadı, siteden deneniyor:', item && item.mp3);
          start(row, item, item.mp3, false);
          return;
        }
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
      playNow(r, it) {
        clearTimeout(timer);
        timer = null;
        play(r, it);
      },
      stop,
      setVolume(v) {
        audio.volume = Math.max(0, Math.min(1, v));
      },
      onFail(fn) {
        onFail = fn;
      },
      setLocalSource(fn) {
        localSource = fn;
      },
      get local() {
        return local;
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
      // Tekrar dene: aynı sesi siteden yeniden iste; geçerse uyarı kalkar
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

  /* ------------------------------------------------------------------ favoriler + son kullanılanlar */

  // Kayıt localStorage'da DEĞİL, %APPDATA%\BadIdea\MyInstants\library.json'da (js/library.js): CEP'in
  // depolaması Premiere güncellemesi ya da Temp temizliğiyle silinebilir. Favorinin sesi de oraya kopyalanır.
  const L = window.Library;
  const lib = {
    ready: Promise.resolve(),
    error: null, // kitaplık yüklenemediyse (ör. Node yok)
    corrupt: null, // { backup, seen } — açılışta bozuk dosya bulunup kenara alındıysa
    undo: new Map(), // Favoriler sekmesinde yıldızı kaldırılanların sesi (sekmeden çıkana kadar; geri yıldızlanırsa)
  };

  function libError(kind, message) {
    return Object.assign(new Error(message || kind), { kind });
  }

  function libText(e) {
    if (e.kind === 'nonode') return 'Panel diske erişemiyor (Node.js kapalı); favoriler kaydedilemiyor.';
    if (e.code === 'EACCES' || e.code === 'EPERM') return 'Favoriler dosyası kaydedilemedi: klasöre yazma izni yok.';
    if (e.code === 'ENOSPC') return 'Favoriler dosyası kaydedilemedi: diskte yer yok.';
    return 'Favoriler dosyası kaydedilemedi.';
  }

  function startLibrary() {
    lib.error = null;
    lib.ready = (async () => {
      if (!L) throw libError('nonode', 'library.js yüklenmedi');
      const r = await L.load();
      // Liste kitaplıktan önce geldiyse yıldızlar boş çizilmiştir: şimdi düzelt
      el.rows.querySelectorAll('.row').forEach((row) => {
        if (row._miItem) renderFav(row.querySelector('.fav'), L.isFavorite(row._miItem.id));
      });
      if (r.corrupt) {
        lib.corrupt = { backup: r.backup, seen: false };
        console.warn('[MyInstants] library.json bozuktu; kenara alındı:', r.backup);
        renderLibChip();
      }
    })().catch((e) => {
      lib.error = e;
      console.warn('[MyInstants] Favoriler yüklenemedi:', e);
    });
    return lib.ready;
  }

  const libReady = () => !!L && !lib.error && L.isLoaded();
  const isFavorite = (item) => libReady() && L.isFavorite(item.id);

  // Alt çubuk uyarısı: açılışta library.json bozuk bulunduysa
  function renderLibChip() {
    const c = lib.corrupt;
    el.libChip.hidden = !c || c.seen;
    if (el.libChip.hidden) return;
    const text = document.createElement('span');
    text.textContent = 'Favoriler dosyası bozuktu';
    el.libChip.replaceChildren(Icons.svg('triangle-alert', 12), text);
    el.libChip.title = 'Ayrıntı için tıklayın';
  }

  function showLibCorrupt() {
    const c = lib.corrupt;
    if (!c) return;
    const ack = () => {
      c.seen = true;
      renderLibChip();
      closeNotice();
    };
    state.notice = {
      title: 'Favoriler dosyası bozuktu',
      icon: 'triangle-alert',
      tone: 'warn',
      prose: true,
      lines: [
        'Favoriler ve son kullanılanlar dosyası (library.json) açılışta okunamadı: bozuk ya da yarım yazılmış. Panel boş listeyle devam etti.',
        c.backup ? 'Bozuk dosya silinmedi, kenara alındı: ' + c.backup : 'Bozuk dosya kenara alınamadı.',
      ],
      actions: [{ text: 'Tamam', primary: true, onClick: ack }],
    };
    renderNotice();
  }
  el.libChip.addEventListener('click', showLibCorrupt);

  function showLibError(e, title) {
    const detail = [e.code, e.where || (e.kind === 'nonode' ? '' : e.message)].filter(Boolean).join(' · ');
    state.notice = { err: { kind: 'library', userMessage: libText(e), detail, noRetry: true }, title };
    renderNotice();
  }

  // Yıldız tuşu: boş = favori değil, dolu krem = favori
  function renderFav(btn, on) {
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    const label = on ? 'Favorilerden çıkar' : 'Favorilere ekle';
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }

  // Aynı sesin listedeki bütün satırları. Favoriler sekmesinde yıldızı kaldırılan satır silinmez, soluklaşır
  // (sekmeden çıkınca kaybolur; o zamana kadar yeniden yıldızlanabilir).
  function syncFav(id, on) {
    el.rows.querySelectorAll('.row').forEach((r) => {
      if (!r._miItem || r._miItem.id !== id) return;
      renderFav(r.querySelector('.fav'), on);
      if (state.tab === 'favorites') r.classList.toggle('removed', !on);
    });
  }

  const favBusy = new Set();

  async function toggleFavorite(item) {
    if (favBusy.has(item.id)) return;
    favBusy.add(item.id);
    const on = !isFavorite(item);
    syncFav(item.id, on); // hemen görünür; kaydedilemezse geri alınır
    try {
      await lib.ready;
      if (lib.error) throw lib.error;
      if (on) {
        await L.addFavorite(item);
        const bytes = lib.undo.get(item.id);
        lib.undo.delete(item.id);
        queueArchive(item, bytes);
      } else {
        if (state.tab === 'favorites') {
          const bytes = await L.readLocal(item.id);
          if (bytes) lib.undo.set(item.id, bytes); // geri yıldızlanırsa site sesi silmiş olsa da kopya geri gelir
        }
        await L.removeFavorite(item.id); // yerel kopya da silinir
        dropLocalUrl(item.id);
      }
    } catch (e) {
      console.error('[MyInstants] Favori:', e);
      syncFav(item.id, !on);
      showLibError(e, on ? 'Favori kaydedilemedi.' : 'Favori kaldırılamadı.');
    } finally {
      favBusy.delete(item.id);
    }
  }

  // Favorinin sesi arka planda, sırayla yerel arşive kopyalanır (önizlemede indirildiyse tarayıcı önbelleğinden).
  // Alınamazsa (bağlantı yok, doğrulama…) bir sonraki açılışta yeniden denenir.
  let archiveChain = Promise.resolve();
  const archiving = new Set();

  function queueArchive(item, bytes) {
    if (!libReady() || archiving.has(item.id)) return archiveChain;
    archiving.add(item.id);
    archiveChain = archiveChain.then(async () => {
      try {
        if (!L.isFavorite(item.id)) return;
        const buffer = bytes || (await S.fetchAudio(item.mp3, { cache: 'force-cache' })).buffer;
        await L.storeLocal(item.id, buffer);
      } catch (e) {
        console.warn('[MyInstants] Favorinin yerel kopyası alınamadı (yeniden denenecek):', item.mp3, e);
      } finally {
        archiving.delete(item.id);
      }
    });
    return archiveChain;
  }

  async function archiveMissing() {
    if (!libReady()) return;
    try {
      (await L.missingLocal()).forEach((f) => queueArchive(f));
    } catch (e) {
      console.warn('[MyInstants] Yerel kopyalar denetlenemedi:', e);
    }
  }

  // Favorinin yerel kopyası → blob: adresi (önizleme için; en fazla 40 tanesi bellekte tutulur)
  const AUDIO_MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm' };
  const localUrls = new Map();

  const hasLocal = (item) => libReady() && !!L.localPath(item.id);

  async function localAudioUrl(item) {
    const cached = localUrls.get(item.id);
    if (cached) {
      localUrls.delete(item.id); // en son kullanılan sona
      localUrls.set(item.id, cached);
      return cached;
    }
    const p = L.localPath(item.id);
    const bytes = p && (await L.readLocal(item.id));
    if (!bytes) return null; // kopya silinmiş: siteden çalınır
    const ext = ((/\.([a-z0-9]+)$/i.exec(p) || [])[1] || '').toLowerCase();
    const url = URL.createObjectURL(new Blob([bytes], { type: AUDIO_MIME[ext] || 'audio/mpeg' }));
    localUrls.set(item.id, url);
    while (localUrls.size > 40) {
      const [id, old] = localUrls.entries().next().value;
      localUrls.delete(id);
      URL.revokeObjectURL(old);
    }
    return url;
  }

  function dropLocalUrl(id) {
    const url = localUrls.get(id);
    if (!url) return;
    localUrls.delete(id);
    URL.revokeObjectURL(url);
  }

  preview.setLocalSource((item) => (hasLocal(item) ? localAudioUrl(item) : null));

  // Timeline'a başarıyla konan ses "Son kullanılanlar"a yazılır (önizleme sayılmaz; kopya tutulmaz)
  function rememberUsed(item) {
    if (!L) return;
    lib.ready
      .then(() => libReady() && L.addRecent(item))
      .catch((e) => console.warn('[MyInstants] Son kullanılanlara yazılamadı:', e));
  }

  async function libDiagLines() {
    if (!L) return ['Favoriler: library.js yüklenmedi'];
    await lib.ready;
    let file = '';
    try {
      file = L.paths().file;
    } catch (e) {
      file = '?';
    }
    if (lib.error) return ['Favoriler dosyası: okunamadı — ' + libText(lib.error)];
    const favs = L.favorites();
    const missing = await L.missingLocal().catch(() => favs);
    const lines = [
      'Favoriler dosyası: ' + file,
      `Favoriler: ${favs.length} (yerel kopya: ${favs.length - missing.length})`,
      `Son kullanılanlar: ${L.recent().length}`,
    ];
    if (lib.corrupt) lines.push('Açılışta bozuk dosya kenara alındı: ' + (lib.corrupt.backup || 'alınamadı'));
    return lines;
  }

  /* ------------------------------------------------------------------ İndir → import → timeline */

  const DL_IDLE = 'İndir';
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

  // İndir tuşunun üç hâli: [indir ikonu] İndir · [dönen gösterge] · [onay ikonu] A3
  function setDl(btn, mode, text) {
    clearTimeout(btn._miTimer);
    btn.classList.toggle('busy', mode === 'busy');
    btn.classList.toggle('done', mode === 'done');
    btn.replaceChildren();
    if (mode === 'busy') {
      btn.append(Icons.svg('loader-circle', 14), srOnly('İndiriliyor'));
      btn.setAttribute('aria-busy', 'true');
    } else {
      btn.removeAttribute('aria-busy');
      btn.append(Icons.svg(mode === 'done' ? 'check' : 'download', 14), document.createTextNode(mode === 'done' ? text : DL_IDLE));
    }
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
      setDl(btn, 'done', 'A' + r.track);
      rememberUsed(item);
      if (state.notice && state.notice.jobItem === item) closeNotice();
      flash(`“${item.name}” → A${r.track}` + (r.addedTrack ? ' (yeni track)' : ''));
    } catch (err) {
      console.error('[MyInstants] İndir/yerleştir:', err);
      setDl(btn, 'idle');
      state.notice = {
        err,
        jobItem: item,
        title: `“${item.name}” eklenemedi.`,
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
        // Favorinin yerel kopyası varsa siteye gidilmez (site sesi silse de çalışır)
        const local = hasLocal(item) ? await L.readLocal(item.id) : null;
        const buffer = local || (await S.fetchAudio(item.mp3)).buffer;
        await LocalFiles.ensureDir(ctx.folder);
        await LocalFiles.writeFileAtomic(target.path, buffer);
        seconds = await measureSeconds(buffer);
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

  // Bilgi kutusu. actions verilmezse yalnızca "Kapat"; [] ise hiç tuş yok (ör. işlem sürüyor).
  // prose: true → satırlar düz metin (ör. değişiklik notu); değilse eş aralıklı teşhis kutusu
  // tone: 'warn' → ikon tehlike renginde (ör. bozuk kitaplık dosyası)
  function infoBox(title, lines, actions, iconName, prose, tone) {
    const box = document.createElement('div');
    box.className = 'msg info' + (tone ? ' ' + tone : '');
    box.append(head(iconName || 'info', title));
    if (lines && lines.length && prose) {
      const notes = document.createElement('div');
      notes.className = 'notes';
      notes.append(...lines.map((l) => line(l)));
      box.append(notes);
    } else if (lines && lines.length) {
      const pre = document.createElement('pre');
      pre.textContent = lines.join('\n');
      box.append(pre);
    }
    const acts = actions || [{ text: 'Kapat', onClick: closeNotice }];
    if (acts.length) box.append(actionsRow(acts.map((a) => button(a.text, 'retry' + (a.primary ? ' primary' : ''), a.onClick))));
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
    lines.push(...(await libDiagLines()));
    lines.push(...(await updateDiagLines()));
    state.notice = { title: 'Teşhis', lines };
    renderNotice();
    console.log('[MyInstants] Teşhis:\n' + lines.join('\n'));
  }

  el.hostText.title = 'Tıklayın: teşhis';
  el.hostText.addEventListener('click', runDiagnostics);

  /* ------------------------------------------------------------------ sürüm, güncelleme, panel menüsü */

  const U = window.Updater;
  const UPDATE_FIRST_DELAY_MS = 3000;
  const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 saat
  const UPDATE_TEXT = {
    nonode: 'Panel diske erişemiyor (Node.js kapalı).',
    network: 'GitHub’a ulaşılamadı. İnternet bağlantısını kontrol edin.',
    notfound: 'Yayınlanmış bir sürüm bulunamadı (depo erişilemiyor olabilir).',
    badhost: 'Güncelleme GitHub dışı bir adrese yönlendirildi; kurulmadı.',
    badrelease: 'Sürüm bilgisi eksik ya da tutarsız (ZIP / release.json); kurulmadı.',
    toolarge: 'Güncelleme paketi beklenenden büyük; kurulmadı.',
    size: 'İndirilen paketin boyutu tutmuyor; kurulmadı.',
    checksum: 'İndirilen paketin özeti (SHA-256) tutmuyor; kurulmadı.',
    badzip: 'Güncelleme paketi açılamadı ya da güvensiz dosya yolu içeriyor; kurulmadı.',
    badpackage: 'Güncelleme paketi bu panele ait değil ya da sürümü tutmuyor; kurulmadı.',
    gitcheckout: 'Bu kurulum bir geliştirici (git) klasörüne bağlı. Güncellemeyi git pull ile yapın.',
    backupfailed: 'Mevcut sürüm yedeklenemedi; güncelleme yapılmadı, panel değişmedi.',
    rolledback: 'Güncelleme kurulurken hata oldu; önceki sürüm geri yüklendi. Panel değişmedi.',
    rollbackfailed: 'DİKKAT: Güncelleme yarıda kaldı ve yedek geri yüklenemedi. Bu durumu bildirin.',
    nobackup: 'Geri dönülecek önceki sürüm yedeği yok.',
    noext: 'Panelin kurulu olduğu klasör bulunamadı.',
  };

  const update = { latest: null, lastCheck: 0, lastError: null, busy: false };
  let extPath = ''; // panelin yüklendiği klasör (CEP'in verdiği yol; junction olabilir)
  let panelVersion = '';

  try {
    if (cs) extPath = cs.getSystemPath(SystemPath.EXTENSION);
  } catch (e) {
    extPath = '';
  }

  async function initVersion() {
    if (!extPath || !U) return;
    try {
      panelVersion = await U.installedVersion(extPath);
    } catch (e) {
      console.warn('[MyInstants] Panel sürümü okunamadı:', e);
    }
  }

  function renderUpdateChip() {
    const chip = el.updateChip;
    const l = update.latest;
    chip.hidden = !l;
    if (!l) return;
    chip.replaceChildren(Icons.svg('circle-arrow-up', 12), document.createTextNode(`v${l.version} hazır — Güncelle`));
    chip.title = (l.notes || '').slice(0, 400);
  }

  async function checkForUpdates(manual) {
    if (!U) return;
    if (!panelVersion) await initVersion();
    if (!panelVersion) {
      if (manual) showUpdateError(U.error('noext'));
      return;
    }
    try {
      const l = await U.checkLatest(panelVersion);
      update.latest = l.newer ? l : null;
      update.lastError = null;
      update.lastCheck = Date.now();
      renderUpdateChip();
      if (manual) {
        if (l.newer) showUpdateOffer();
        else {
          state.notice = { title: 'Güncelleme', lines: [`Panel güncel: v${panelVersion}`] };
          renderNotice();
        }
      }
    } catch (e) {
      update.lastError = e;
      update.lastCheck = Date.now();
      console.warn('[MyInstants] Güncelleme denetlenemedi:', e);
      if (manual) showUpdateError(e);
    }
  }

  // Release notundaki Markdown işaretlerini sade metne çevirir
  function plainNotes(md) {
    return String(md || '')
      .replace(/\r/g, '')
      .split('\n')
      .map((l) => l.replace(/^#+\s*/, '').replace(/^\s*[-*]\s+/, '• ').replace(/\*\*|__|`/g, ''))
      .filter((l) => !/^MyInstants v\d+\.\d+\.\d+\s*$/.test(l)) // başlığı tekrar eden satır
      .filter((l, i, a) => l.trim() || (i > 0 && a[i - 1].trim()));
  }

  function showUpdateOffer() {
    const l = update.latest;
    if (!l) return;
    state.notice = {
      title: `MyInstants v${l.version} hazır` + (panelVersion ? ` (şu an v${panelVersion})` : ''),
      icon: 'circle-arrow-up',
      prose: true,
      lines: plainNotes(l.notes).slice(0, 30),
      actions: [
        { text: 'Güncelle', primary: true, onClick: runUpdate },
        { text: 'Sonra', onClick: closeNotice },
      ],
    };
    renderNotice();
  }

  function showUpdateError(e, title) {
    const lines = [UPDATE_TEXT[e.kind] || 'Beklenmeyen hata.'];
    if (e.message && e.message !== e.kind) lines.push('Ayrıntı: ' + e.message);
    if (e.backupDir) lines.push('Yedek: ' + e.backupDir);
    state.notice = { title: title || 'Güncelleme yapılamadı', lines };
    renderNotice();
  }

  function progress(title, text) {
    state.notice = { title, lines: [text], actions: [], prose: true };
    renderNotice();
  }

  async function runUpdate() {
    const l = update.latest;
    if (!l || update.busy) return;
    update.busy = true;
    const title = `v${l.version} kuruluyor…`;
    try {
      progress(title, 'Kurulum klasörü kontrol ediliyor…');
      const inst = await U.resolveInstall(extPath);
      if (inst.gitCheckout) throw U.error('gitcheckout', inst.realDir);
      progress(title, 'İndiriliyor…');
      const bytes = await U.downloadPackage(l);
      progress(title, 'Paket açılıyor ve denetleniyor…');
      const files = U.extractPackage(bytes, l.version, extPath);
      progress(title, 'Yedekleniyor ve kuruluyor…');
      const r = await U.install(inst.realDir, files, l.version);
      update.latest = null;
      renderUpdateChip();
      afterInstall(r, `v${r.to} kuruldu (önceki: v${r.from}).`);
    } catch (e) {
      console.error('[MyInstants] Güncelleme:', e);
      showUpdateError(e);
    } finally {
      update.busy = false;
    }
  }

  async function confirmRollback() {
    if (!U) return;
    if (!panelVersion) await initVersion();
    const b = await U.previousBackup(panelVersion).catch(() => null);
    if (!b) {
      showUpdateError(U.error('nobackup'), 'Önceki sürüme dön');
      return;
    }
    state.notice = {
      title: 'Önceki sürüme dön',
      lines: [`Şu anki sürüm: v${panelVersion}`, `Dönülecek sürüm: v${b.version} (yedek: ${String(b.date).slice(0, 16).replace('T', ' ')})`],
      actions: [
        { text: `v${b.version} sürümüne dön`, primary: true, onClick: runRollback },
        { text: 'Vazgeç', onClick: closeNotice },
      ],
    };
    renderNotice();
  }

  async function runRollback() {
    if (update.busy) return;
    update.busy = true;
    try {
      progress('Önceki sürüme dönülüyor…', 'Yedekleniyor ve kuruluyor…');
      const inst = await U.resolveInstall(extPath);
      if (inst.gitCheckout) throw U.error('gitcheckout', inst.realDir);
      const r = await U.rollback(inst.realDir);
      afterInstall(r, `v${r.to} sürümüne dönüldü (önceki: v${r.from}).`);
    } catch (e) {
      console.error('[MyInstants] Geri dönüş:', e);
      showUpdateError(e, 'Önceki sürüme dönülemedi');
    } finally {
      update.busy = false;
    }
  }

  // Kurulumdan sonra: manifest değiştiyse Premiere yeniden başlatılmalı; değişmediyse host.jsx + panel yenilenir.
  function afterInstall(r, headline) {
    panelVersion = r.to;
    if (r.manifestChanged) {
      state.notice = {
        title: headline,
        lines: ['Panel ayarları (manifest.xml) değişti: değişikliklerin çalışması için Premiere’i yeniden başlatın.'],
      };
      renderNotice();
      return;
    }
    progress(headline, 'Panel yenileniyor…');
    setTimeout(reloadPanel, 600);
  }

  function callHostRaw(script) {
    return new Promise((resolve) => {
      if (!cs) return resolve('');
      cs.evalScript(script, (res) => resolve(String(res)));
    });
  }

  async function reloadPanel() {
    if (extPath) {
      const hostJsx = extPath.replace(/[\\/]+$/, '') + '/jsx/host.jsx';
      const res = await callHostRaw(`$.evalFile(new File(${JSON.stringify(hostJsx)})); "ok"`);
      if (res !== 'ok') console.warn('[MyInstants] host.jsx yeniden yüklenemedi:', res);
    }
    location.reload();
  }

  async function updateDiagLines() {
    const lines = ['Panel sürümü: ' + (panelVersion ? 'v' + panelVersion : 'okunamadı')];
    if (extPath && U) {
      try {
        const inst = await U.resolveInstall(extPath);
        lines.push('Kurulum: ' + (inst.linked ? 'bağlantı (junction) → ' + inst.realDir : 'kopya → ' + inst.realDir));
        if (inst.gitCheckout) lines.push('Kurulum bir git klasöründe: otomatik güncelleme kapalı');
      } catch (e) {
        lines.push('Kurulum klasörü okunamadı: ' + e.message);
      }
      const b = await U.previousBackup(panelVersion).catch(() => null);
      lines.push('Önceki sürüm yedeği: ' + (b ? 'v' + b.version : 'yok'));
    }
    const when = update.lastCheck ? ` (${new Date(update.lastCheck).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })})` : '';
    if (update.lastError) lines.push(`Güncelleme denetimi${when}: yapılamadı — ${UPDATE_TEXT[update.lastError.kind] || update.lastError.message}`);
    else if (update.latest) lines.push(`Güncelleme${when}: v${update.latest.version} hazır`);
    else if (update.lastCheck) lines.push(`Güncelleme${when}: güncel`);
    else lines.push('Güncelleme: henüz denetlenmedi');
    return lines;
  }

  // Premiere'in panel menüsü (≡)
  const FLYOUT = {
    reload: { label: 'Paneli yeniden yükle', run: () => reloadPanel() },
    checkUpdates: { label: 'Güncellemeleri denetle', run: () => checkForUpdates(true) },
    rollback: { label: 'Önceki sürüme dön', run: () => confirmRollback() },
    diag: { label: 'Teşhis', run: () => runDiagnostics() },
  };

  function menuIdOf(ev) {
    let d = ev && ev.data;
    if (typeof d === 'string') {
      try {
        d = JSON.parse(d);
      } catch (e) {
        const m = /menuId["']?\s*[:=]\s*["']?([\w-]+)/.exec(d);
        return m ? m[1] : d;
      }
    }
    return d && d.menuId;
  }

  function setupFlyoutMenu() {
    if (!cs) return;
    const item = (id) => `<MenuItem Id="${id}" Label="${FLYOUT[id].label}" Enabled="true" Checked="false"/>`;
    const xml = `<Menu>${item('reload')}${item('checkUpdates')}${item('rollback')}<MenuItem Label="---"/>${item('diag')}</Menu>`;
    try {
      cs.setPanelFlyoutMenu(xml);
      cs.addEventListener('com.adobe.csxs.events.flyoutMenuClicked', (ev) => {
        const entry = FLYOUT[menuIdOf(ev)];
        if (entry) entry.run();
      });
    } catch (e) {
      console.warn('[MyInstants] Panel menüsü kurulamadı:', e);
    }
  }

  el.updateChip.addEventListener('click', showUpdateOffer);

  /* ------------------------------------------------------------------ liste */

  function makeRow(item) {
    const row = document.createElement('div');
    row.className = 'row';
    row.tabIndex = 0;
    row.setAttribute('role', 'listitem');

    // Baştaki durum yuvası: çalıyor ▶ / yükleniyor / çalınamadı (yer hep ayrılı; kayma olmaz)
    const lead = document.createElement('span');
    lead.className = 'lead';
    lead.append(Icons.svg('play', 12), Icons.svg('loader-circle', 12), Icons.svg('circle-alert', 12));

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name;
    name.title = item.name;

    const fav = document.createElement('button');
    fav.type = 'button';
    fav.className = 'fav';
    fav.append(Icons.svg('star', 14));
    renderFav(fav, isFavorite(item));
    fav.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavorite(item);
    });

    const dl = document.createElement('button');
    dl.type = 'button';
    dl.className = 'dl';
    setDl(dl, 'idle');
    dl.title = 'İndir ve aktif sequence’te playhead’e koy';
    dl.addEventListener('click', (e) => {
      e.stopPropagation();
      queueDownload(item, dl);
    });

    row._miItem = item;
    row.append(lead, name, fav, dl);
    row.addEventListener('mouseenter', () => preview.hoverStart(row, item));
    row.addEventListener('mouseleave', () => preview.hoverEnd(row));
    // Önizleme yalnızca hover'a bağlı kalmasın: tıklama ve Enter/Boşluk baştan çalar, Esc durdurur.
    row.addEventListener('click', () => preview.playNow(row, item));
    row.addEventListener('keydown', (e) => {
      if (e.target !== row) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        preview.playNow(row, item);
      } else if (e.key === 'Escape') preview.stop();
    });
    return row;
  }

  function renderListEnd() {
    const end = el.listEnd;
    end.replaceChildren();

    if (state.loading) {
      const s = document.createElement('span');
      s.className = 'loading';
      s.append(Icons.svg('loader-circle', 14), document.createTextNode('Yükleniyor…'));
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
      const empty = {
        search: `“${state.query}” için sonuç bulunamadı.`,
        favorites: 'Henüz favori yok. Bir sesin yanındaki yıldıza tıklayın.',
        used: 'Henüz kullanılan ses yok. İndir ile timeline’a koyduğunuz sesler burada görünür.',
      };
      end.append(line(empty[state.tab] || 'Bu listede ses yok.', 'msg'));
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
      lib.undo.clear();
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
      // Favoriler / Son kullanılanlar: siteye gidilmez, hepsi birden (sayfalama yok)
      if (isLocalTab(state.tab)) {
        if (lib.error) startLibrary(); // önceki yükleme başarısızdı: bir kez daha dene
        await lib.ready;
        if (token !== state.token) return;
        if (lib.error) throw Object.assign(new Error(lib.error.message), { kind: 'library', userMessage: libText(lib.error) });
        const items = state.tab === 'favorites' ? L.favorites() : L.recent();
        el.rows.append(...items.map(makeRow));
        state.page = 1;
        state.count = items.length;
        state.hasMore = false;
        return;
      }

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

  // Favoriler ve Son kullanılanlar en solda sabit (ikon). Dar panelde yalnız site sekmeleri yatay kayar:
  // devamı olan kenar soluklaşır, fare tekerleği de yatay kaydırır.
  function updateTabEdges() {
    const t = el.siteTabs;
    t.classList.toggle('more-left', t.scrollLeft > 1);
    t.classList.toggle('more-right', t.scrollLeft + t.clientWidth < t.scrollWidth - 1);
  }
  el.siteTabs.addEventListener('scroll', updateTabEdges, { passive: true });
  window.addEventListener('resize', updateTabEdges);
  el.siteTabs.addEventListener(
    'wheel',
    (e) => {
      const t = el.siteTabs;
      if (t.scrollWidth <= t.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      t.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY; // bazı fareler satır cinsinden verir
    },
    { passive: false }
  );

  function updateChrome() {
    el.tabs.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === state.tab);
      b.setAttribute('aria-selected', b.dataset.tab === state.tab ? 'true' : 'false');
      if (b.dataset.tab === state.tab && el.siteTabs.contains(b)) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    updateTabEdges();

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
    if (state.tab === 'favorites') archiveMissing(); // yerel kopyası alınamamış favoriler yeniden denenir
  });

  function setVolume(v) {
    const n = Math.max(0, Math.min(100, Number.isFinite(v) ? v : 60));
    el.volume.value = String(n);
    el.volumeLabel.textContent = '%' + n;
    el.volume.style.setProperty('--fill', n + '%');
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

  Icons.hydrate();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(updateTabEdges); // Geist yüklenince sekme genişlikleri değişir
  applyTheme();
  if (cs) cs.addEventListener(CSInterface.THEME_COLOR_CHANGED_EVENT, applyTheme);
  setVolume(savedVolume);
  updateChrome();
  pingHost();
  startLibrary().then(() => setTimeout(archiveMissing, 1500)); // eksik yerel kopyalar arka planda
  loadList(true);
  setupFlyoutMenu();
  initVersion().then(() => {
    setTimeout(() => checkForUpdates(false), UPDATE_FIRST_DELAY_MS);
    setInterval(() => checkForUpdates(false), UPDATE_INTERVAL_MS);
  });

  // Hata ayıklama ve testler için
  window.MyInstantsPanel = {
    state,
    preview,
    loadList,
    runDiagnostics,
    checkForUpdates,
    update,
    setDl,
    showUpdateOffer,
    renderUpdateChip,
    lib,
    archiveIdle: () => archiveChain,
  };
})();
