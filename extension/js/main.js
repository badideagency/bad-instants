/*
 * main.js — MyInstants paneli arayüzü.
 * Siteyle ilgili hiçbir ayrıntı burada yok; hepsi siteScraper.js'te.
 */
(function () {
  'use strict';

  const S = window.SiteScraper;
  const HOVER_DELAY_MS = 150;
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
    blocked: 'myinstants.com isteği geri çevirdi (güvenlik kontrolü). Birkaç dakika sonra tekrar deneyin.',
    tls: 'Siteyle güvenli bağlantı kurulamadı. Antivirüs ya da ağ ayarları engelliyor olabilir.',
    notfound: 'Bu sayfa sitede bulunamadı.',
    parse: 'Sayfa açıldı ama içinde ses bulunamadı. Sitenin yapısı değişmiş olabilir.',
    nonode: 'Panel internete çıkamıyor (Node.js kapalı). Kurulumu kontrol edin.',
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
    error: null,
    token: 0,
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
      if (r.indexOf('ok|') === 0) setHost('Premiere ' + r.slice(3) + ' ✓', 'ok');
      else setHost('Premiere bağlantısı yok', 'bad');
    });
  }

  /* ------------------------------------------------------------------ önizleme */

  const preview = (function () {
    const audio = new Audio();
    audio.preload = 'auto';
    let timer = null;
    let row = null;

    function release() {
      if (row) row.classList.remove('playing', 'buffering');
      row = null;
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

    function fail(r) {
      r.classList.remove('playing', 'buffering');
      r.classList.add('error');
    }

    function play(r, item) {
      stop();
      row = r;
      r.classList.remove('error');
      r.classList.add('playing', 'buffering');
      audio.src = item.mp3;
      const p = audio.play();
      if (p && p.catch) {
        p.catch((err) => {
          if (row === r && err && err.name !== 'AbortError') {
            release();
            fail(r);
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
        release();
        fail(r);
      }
    });

    return {
      hoverStart(r, item) {
        clearTimeout(timer);
        timer = setTimeout(() => play(r, item), HOVER_DELAY_MS);
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
      get audio() {
        return audio;
      },
    };
  })();

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
    dl.textContent = '⬇ İndir';
    // "disabled" yerine aria-disabled: devre dışı düğmeler fare olaylarını yutup önizlemeyi bozabiliyor.
    dl.setAttribute('aria-disabled', 'true');
    dl.title = 'İndirme Aşama 2’de eklenecek';

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
      let kind = err.kind || 'server';
      if ((kind === 'server' || kind === 'timeout') && navigator.onLine === false) kind = 'offline';

      const box = document.createElement('div');
      box.className = 'msg error';
      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = '⚠';
      const text = document.createElement('div');
      text.textContent = ERROR_TEXT[kind] || ERROR_TEXT.server;
      const detail = document.createElement('div');
      detail.className = 'detail';
      detail.textContent = [err.status ? 'HTTP ' + err.status : '', err.code || '', err.kind ? '' : err.message]
        .filter(Boolean)
        .join(' · ');
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'retry';
      retry.textContent = 'Tekrar dene';
      retry.addEventListener('click', () => loadList(reset));
      box.append(icon, text, detail, retry);
      end.append(box);
      return;
    }

    if (state.count === 0) {
      const m = document.createElement('div');
      m.className = 'msg';
      m.textContent = state.tab === 'search' ? `“${state.query}” için sonuç bulunamadı.` : 'Bu listede ses yok.';
      end.append(m);
      return;
    }

    if (state.hasMore) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'more-btn';
      more.textContent = 'Daha fazla';
      more.addEventListener('click', () => loadList(false));
      end.append(more);
      return;
    }

    end.textContent = 'Liste sonu.';
  }

  function renderStatus() {
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
  window.MyInstantsPanel = { state, preview, loadList };
})();
