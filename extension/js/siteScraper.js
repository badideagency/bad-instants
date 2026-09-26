/*
 * siteScraper.js
 *
 * myinstants.com ile ilgili HER ŞEY bu dosyada: adresler, sayfa/ses indirme, Cloudflare
 * doğrulama sayfasını tanıma, HTML'i okuma, önbellek. Site değişirse yalnızca bu dosya düzeltilir.
 *
 * Bütün istekler panelin kendi Chromium'uyla yapılır (window.fetch, credentials: 'include').
 * Böylece "Doğrula" penceresinde alınan Cloudflare çerezi bu isteklerde de kullanılır.
 * CORS'u aşmak için manifest'te --disable-web-security açıktır. Node siteye istek ATMAZ.
 * HTML, Chromium'un DOMParser'ı ile okunur. Testlerde Node (fetch + jsdom) ile çalışır.
 *
 * Sitenin beklenen yapısı (her ses için):
 *   <div class="instant">
 *     <button class="small-button" onclick="play('/media/sounds/xxx.mp3', 'loader-123', 'ses-adi-123')"></button>
 *     <a class="instant-link" href="/en/instant/ses-adi-123/">Ses Adı</a>
 *   </div>
 */
(function (root, factory) {
  var api = factory(root);
  // Mixed-context'te hem "window" hem Node'un "module" nesnesi vardır; ikisine de koyuyoruz.
  if (root) root.SiteScraper = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  const BASE = 'https://www.myinstants.com';
  const MAX_CACHED_PAGES = 60;
  let timeoutMs = 15000;

  // Bölge kodu adrese HER ZAMAN açıkça yazılır; bölgesiz adres kullanılmaz
  // (site bölgesiz adreste IP'ye göre ülke seçebilir).
  const REGIONS = [
    { code: 'tr', label: 'TR' },
    { code: 'us', label: 'Global (US)' },
  ];
  const DEFAULT_REGION = 'tr';

  // Listeler. regional: true → adrese bölge kodu yazılır ve paneldeki bölge seçici bu sekmede aktiftir.
  const LISTS = {
    trending: { regional: true, path: (o) => `/en/trending/${o.region}/` },
    best: { regional: true, path: (o) => `/en/best_of_all_time/${o.region}/` },
    recent: { regional: false, path: () => '/en/recent/' },
    category: { regional: true, path: (o) => `/en/categories/${encodeURIComponent(o.category)}/${o.region}/` },
    search: { regional: false, path: (o) => `/en/search/?name=${encodeURIComponent(o.query)}` },
  };

  const CATEGORIES_PATH = '/en/categories/';

  // Kategori sayfası okunamazsa kullanılacak yedek liste.
  const FALLBACK_CATEGORIES = [
    'anime & manga', 'games', 'memes', 'movies', 'music', 'politics', 'pranks',
    'reactions', 'sound effects', 'sports', 'television', 'tiktok trends', 'viral', 'whatsapp audios',
  ].map((id) => ({ id, label: titleCase(id) }));

  /* ------------------------------------------------------------------ adresler */

  function normalizeRegion(region) {
    const code = String(region || '').toLowerCase();
    return REGIONS.some((r) => r.code === code) ? code : DEFAULT_REGION;
  }

  function isRegional(listKey) {
    return !!(LISTS[listKey] && LISTS[listKey].regional);
  }

  function buildUrl(listKey, opts, page) {
    const def = LISTS[listKey];
    if (!def) throw new Error('Bilinmeyen liste: ' + listKey);
    const o = Object.assign({}, opts, { region: normalizeRegion(opts && opts.region) });
    let url = BASE + def.path(o);
    if (page > 1) url += (url.includes('?') ? '&' : '?') + 'page=' + page;
    return url;
  }

  /* ------------------------------------------------------------------ hatalar */

  // kind: offline | timeout | server | cors | challenge | notfound | busy | parse | notaudio | nofetch
  function scraperError(kind, message, extra) {
    const e = new Error(message || kind);
    e.kind = kind;
    if (extra) Object.assign(e, extra);
    return e;
  }

  function httpStatusError(status, url) {
    if (status === 404) return scraperError('notfound', 'HTTP 404', { status, url });
    if (status === 429) return scraperError('busy', 'HTTP 429 (çok fazla istek)', { status, url });
    return scraperError('server', `HTTP ${status}`, { status, url });
  }

  /* ------------------------------------------------------------------ Cloudflare ara sayfası */

  // Cloudflare'in kendi sayfa başlıkları. Başlığın TAMAMI eşleşmeli: "Just a moment" adlı bir sesin
  // arama sayfası ("Just a moment Soundboard - ... | Myinstants") yanlışlıkla doğrulama sanılmasın.
  const CF_TITLES = [
    /^Just a moment(?:\.{3}|…)?$/i,
    /^Attention Required! \| Cloudflare$/i,
    /^Checking your browser/i,
    /^Please Wait\.{3} \| Cloudflare$/i,
    /^Access denied \| .+ used Cloudflare/i,
  ];
  // Doğrulama sayfasının gövdesindeki "cf-" izleri. Cloudflare normal sayfalara da
  // /cdn-cgi/challenge-platform/scripts/... betiği ekleyebildiği için bu izler yalnızca
  // hata kodlu (200 olmayan) cevaplarda dikkate alınır.
  const CF_MARKS = /cf_chl_opt|cf-chl-|id="cf-error-details"|id="challenge-form"|cf-browser-verification|\/cdn-cgi\/challenge-platform\/h\/|cf-turnstile/i;
  // Doğrulamayla aşılamayan kesin engel ("Sorry, you have been blocked", hata 1020)
  const CF_HARD_BLOCK = /you have been blocked|data-translate="block_headline"|error code:?\s*1020/i;

  function headerValue(headers, name) {
    if (!headers) return '';
    if (typeof headers.get === 'function') return headers.get(name) || '';
    return headers[name] || headers[name.toLowerCase()] || '';
  }

  // Cevap bir Cloudflare ara sayfasıysa { hardBlock } döner, değilse null.
  function detectCloudflare(status, headers, body) {
    const text = String(body || '');
    const title = cleanText((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(text) || [])[1] || '');
    const mitigated = /challenge/i.test(headerValue(headers, 'cf-mitigated'));
    const byTitle = CF_TITLES.some((re) => re.test(title));
    const byMarks = status !== 200 && CF_MARKS.test(text);
    if (!mitigated && !byTitle && !byMarks) return null;
    return { hardBlock: CF_HARD_BLOCK.test(text), title };
  }

  function challengeError(url, status, cf) {
    return scraperError('challenge', cf.hardBlock ? 'Cloudflare engeli' : 'Cloudflare doğrulaması', {
      url,
      status,
      hardBlock: cf.hardBlock,
    });
  }

  /* ------------------------------------------------------------------ tarayıcı istekleri */

  function doFetch(url, signal, extra) {
    if (typeof root.fetch !== 'function') throw scraperError('nofetch', 'Tarayıcı fetch() yok');
    return root.fetch(
      url,
      Object.assign({ credentials: 'include', cache: 'no-store', redirect: 'follow', signal }, extra)
    );
  }

  // fetch() yalnızca "Failed to fetch" der; sebebi ayırmaya çalışır.
  async function classifyFetchFailure(url, err) {
    const nav = root.navigator;
    if (nav && nav.onLine === false) return scraperError('offline', 'Ağ bağlantısı yok', { url });
    // Aynı adrese "no-cors" ile ulaşılabiliyorsa sunucu ayakta; asıl engel tarayıcının
    // güvenlik kuralıdır (CORS) → manifest'teki --disable-web-security çalışmıyor demektir.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      await doFetch(url, ctrl.signal, { mode: 'no-cors' });
      return scraperError('cors', 'Tarayıcı güvenlik kuralı isteği engelledi (CORS)', { url });
    } catch (e) {
      return scraperError('server', (err && err.message) || 'Bağlantı kurulamadı', { url });
    } finally {
      clearTimeout(timer);
    }
  }

  // İsteği (gövdesi dahil) zaman aşımıyla çalıştırır, hataları sınıflandırır.
  async function withTimeout(url, ms, work) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await work(ctrl.signal);
    } catch (e) {
      if (e && e.kind) throw e;
      if (ctrl.signal.aborted || (e && e.name === 'AbortError')) {
        throw scraperError('timeout', `${Math.round(ms / 1000)} sn içinde cevap gelmedi`, { url });
      }
      throw await classifyFetchFailure(url, e);
    } finally {
      clearTimeout(timer);
    }
  }

  // Bir HTML sayfasını indirir. Cloudflare ara sayfasıysa ayrıştırmaya geçmeden 'challenge' hatası verir.
  function browserGet(url) {
    return withTimeout(url, timeoutMs, async (signal) => {
      const res = await doFetch(url, signal);
      const body = await res.text();
      const cf = detectCloudflare(res.status, res.headers, body);
      if (cf) throw challengeError(url, res.status, cf);
      if (!res.ok) throw httpStatusError(res.status, url);
      return body;
    });
  }

  // Bir ses dosyasını indirir → { buffer: ArrayBuffer, type, size, url }. (Diske yazma Node'un işi.)
  function fetchAudio(url) {
    return withTimeout(url, timeoutMs * 2, async (signal) => {
      const res = await doFetch(url, signal);
      const type = String(res.headers.get('content-type') || '').toLowerCase();
      if (!res.ok || type.includes('text/html')) {
        const body = await res.text().catch(() => '');
        const cf = detectCloudflare(res.status, res.headers, body);
        if (cf) throw challengeError(url, res.status, cf);
        if (!res.ok) throw httpStatusError(res.status, url);
        throw scraperError('notaudio', 'Gelen dosya ses değil (' + type + ')', { url });
      }
      const blob = await res.blob();
      const buffer = await blob.arrayBuffer();
      if (!buffer.byteLength) throw scraperError('notaudio', 'Boş dosya', { url });
      return { buffer, type: blob.type || type, size: buffer.byteLength, url: res.url || url };
    });
  }

  /* ------------------------------------------------------------------ önbellek */

  // Adres → indirme sözü (Promise). Aynı sayfa ikinci kez indirilmez; aynı anda gelen
  // iki istek de tek indirmeyi paylaşır. Hatalı sonuçlar (doğrulama sayfası dahil) saklanmaz.
  const pageCache = new Map();
  let transport = null; // testlerde sahte indirici takmak için

  function fetchPage(url) {
    if (pageCache.has(url)) {
      const hit = pageCache.get(url);
      pageCache.delete(url); // en sona taşı (en son kullanılan)
      pageCache.set(url, hit);
      return hit;
    }
    const get = transport || browserGet;
    const p = Promise.resolve().then(() => get(url));
    pageCache.set(url, p);
    p.catch(() => {
      if (pageCache.get(url) === p) pageCache.delete(url);
    });
    while (pageCache.size > MAX_CACHED_PAGES) pageCache.delete(pageCache.keys().next().value);
    return p;
  }

  function clearCache() {
    pageCache.clear();
  }

  /* ------------------------------------------------------------------ HTML okuma */

  function makeDoc(html) {
    const Parser = root && root.DOMParser;
    if (!Parser) throw new Error('DOMParser bulunamadı');
    return new Parser().parseFromString(html, 'text/html');
  }

  function cleanText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function safeDecode(s) {
    try {
      return decodeURIComponent(s);
    } catch (e) {
      return s;
    }
  }

  function titleCase(s) {
    return String(s).replace(/(^|[\s&-])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());
  }

  // onclick="play('/media/sounds/x.mp3', 'loader-1', 'slug-1')" → ['/media/sounds/x.mp3', 'loader-1', 'slug-1']
  function parsePlayArgs(onclick) {
    const s = String(onclick || '');
    const start = s.search(/play\s*\(/);
    if (start < 0) return null;
    const args = [];
    const re = /'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"/g;
    re.lastIndex = start;
    let m;
    while (args.length < 3 && (m = re.exec(s))) {
      args.push((m[1] != null ? m[1] : m[2]).replace(/\\(.)/g, '$1'));
    }
    return args;
  }

  function isAudioPath(p) {
    return !!p && (/\/media\//.test(p) || /\.(mp3|ogg|wav|m4a|aac|opus|webm)(\?|#|$)/i.test(p));
  }

  function absUrl(path) {
    try {
      return new URL(path, BASE).href;
    } catch (e) {
      return '';
    }
  }

  function slugFromHref(href) {
    const m = /\/instant\/([^/?#]+)/.exec(href || '');
    return m ? safeDecode(m[1]) : '';
  }

  function nameFromSlug(slug) {
    return cleanText(String(slug || '').replace(/-\d+$/, '').replace(/[-_]+/g, ' '));
  }

  function nameFromPath(p) {
    const file = safeDecode(String(p || '').split(/[?#]/)[0].split('/').pop() || '');
    return cleanText(file.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' '));
  }

  function soundFromButton(btn, scope) {
    const args = parsePlayArgs(btn.getAttribute('onclick')) || [];
    let mp3Path = isAudioPath(args[0]) ? args[0] : '';
    if (!mp3Path && isAudioPath(btn.getAttribute('data-url'))) mp3Path = btn.getAttribute('data-url');
    if (!mp3Path) return null;
    const link = scope && (scope.querySelector('a.instant-link') || scope.querySelector('a[href*="/instant/"]'));
    const href = (link && link.getAttribute('href')) || '';
    const slug = slugFromHref(href) || args[2] || '';
    const mp3 = absUrl(mp3Path);
    if (!mp3) return null;
    return {
      id: slug || mp3,
      name: cleanText(link && link.textContent) || nameFromSlug(slug) || nameFromPath(mp3Path),
      mp3,
      page: href ? absUrl(href) : '',
    };
  }

  // onclick'inde play(...) olan öğeler
  function playButtons(scope) {
    return Array.from(scope.querySelectorAll('[onclick]')).filter((n) => /play\s*\(/.test(n.getAttribute('onclick')));
  }

  function soundsFromDoc(doc) {
    const items = [];
    const seen = new Set();
    const add = (item) => {
      if (!item || seen.has(item.mp3)) return;
      seen.add(item.mp3);
      items.push(item);
    };

    // 1) Normal yol: her ses bir div.instant kutusu
    doc.querySelectorAll('.instant').forEach((box) => {
      const btn = box.querySelector('button.small-button') || playButtons(box)[0] || box.querySelector('[data-url]');
      if (btn) add(soundFromButton(btn, box));
    });

    // 2) Yedek yol: kutu sınıfı değiştiyse sayfadaki bütün play('...') tuşlarını tara
    if (!items.length) {
      playButtons(doc).forEach((btn) => add(soundFromButton(btn, btn.parentElement)));
    }
    return items;
  }

  function parseSounds(html) {
    return soundsFromDoc(makeDoc(html));
  }

  // true: sonraki sayfa var, false: yok, null: sayfadan anlaşılamadı
  function nextPageFromDoc(doc, page) {
    const re = new RegExp('[?&](?:amp;)?page=' + (page + 1) + '(?:[&#]|$)');
    for (const a of doc.querySelectorAll('a[href*="page="]')) {
      if (re.test(a.getAttribute('href') || '')) return true;
    }
    const t = /Page\s+(\d+)\s+of\s+(\d+)/i.exec(doc.title || '');
    if (t) return Number(t[1]) < Number(t[2]);
    return null;
  }

  function hasNextPage(html, page) {
    return nextPageFromDoc(makeDoc(html), page || 1);
  }

  // /en/categories/memes/ , /en/categories/memes/tr/ , /categories/music/?page=2 → "memes" / "music"
  const CATEGORY_HREF_RE =
    /^(?:https?:\/\/[^/]+)?(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/categories\/([^/?#]+)\/?(?:[a-z]{2}\/?)?(?:[?#].*)?$/i;

  function parseCategories(html) {
    const doc = makeDoc(html);
    const list = [];
    const seen = new Set();
    doc.querySelectorAll('a[href*="categories/"]').forEach((a) => {
      const m = CATEGORY_HREF_RE.exec(a.getAttribute('href') || '');
      if (!m) return;
      const id = cleanText(safeDecode(m[1]));
      const key = id.toLowerCase();
      if (!id || seen.has(key)) return;
      seen.add(key);
      list.push({ id, label: cleanText(a.textContent) || titleCase(id) });
    });
    return list;
  }

  /* ------------------------------------------------------------------ panelin kullandığı işlevler */

  // Bir listenin bir sayfasını getirir → { url, items: [{id, name, mp3, page}], hasMore }
  async function getList(listKey, opts, page = 1) {
    const url = buildUrl(listKey, opts, page);
    let html;
    try {
      html = await fetchPage(url);
    } catch (e) {
      if (e.kind === 'notfound' && page > 1) return { url, items: [], hasMore: false };
      throw e;
    }
    const doc = makeDoc(html);
    const items = soundsFromDoc(doc);
    // Trending / Hall of Fame / Just Added hiçbir zaman boş olmaz; boşsa sayfa yapısı değişmiştir.
    if (!items.length && page === 1 && listKey !== 'search' && listKey !== 'category') {
      throw scraperError('parse', 'Sayfada ses bulunamadı', { url });
    }
    const next = nextPageFromDoc(doc, page);
    return { url, items, hasMore: next === null ? items.length > 0 : next };
  }

  // Sitedeki kategori listesi → { categories: [{id, label}], fallback }
  async function getCategories() {
    try {
      const cats = parseCategories(await fetchPage(BASE + CATEGORIES_PATH));
      if (cats.length) return { categories: cats, fallback: false };
    } catch (e) {
      // Doğrulama / tarayıcı ayarı sorunlarında yedek listeye düşme; panel sorunu göstersin.
      if (['challenge', 'cors', 'nofetch'].includes(e.kind)) throw e;
    }
    return { categories: FALLBACK_CATEGORIES.slice(), fallback: true };
  }

  return {
    BASE,
    REGIONS,
    DEFAULT_REGION,
    FALLBACK_CATEGORIES,
    normalizeRegion,
    isRegional,
    buildUrl,
    getList,
    getCategories,
    fetchPage,
    fetchAudio,
    clearCache,
    browserGet,
    detectCloudflare,
    parseSounds,
    parseCategories,
    parsePlayArgs,
    hasNextPage,
    // yalnızca testler için
    _setTransport(fn) {
      transport = fn;
    },
    _setTimeout(ms) {
      timeoutMs = ms;
    },
  };
});
