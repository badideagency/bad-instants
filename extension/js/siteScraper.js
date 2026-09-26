/*
 * siteScraper.js
 *
 * myinstants.com ile ilgili HER ŞEY bu dosyada: adresler, sayfa indirme, HTML'i okuma, önbellek.
 * Site değişirse yalnızca bu dosya düzeltilir.
 *
 * Panelde (CEP, --enable-nodejs --mixed-context) sayfaları Node'un https modülüyle indirir
 * (tarayıcı fetch'i CORS'a takılır), HTML'i Chromium'un DOMParser'ı ile okur.
 * Testlerde Node + jsdom ile çalışır.
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
  const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const MAX_REDIRECTS = 5;
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

  // kind: offline | timeout | server | blocked | tls | notfound | parse | nonode
  function scraperError(kind, message, extra) {
    const e = new Error(message || kind);
    e.kind = kind;
    if (extra) Object.assign(e, extra);
    return e;
  }

  const OFFLINE_CODES = ['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EHOSTDOWN'];

  function classifyNetError(err) {
    if (err && err.kind) return err;
    const code = (err && err.code) || '';
    const message = (err && err.message) || 'Bağlantı hatası';
    if (OFFLINE_CODES.includes(code)) return scraperError('offline', message, { code });
    if (code === 'ETIMEDOUT') return scraperError('timeout', message, { code });
    if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code + ' ' + message)) {
      return scraperError('tls', message, { code });
    }
    return scraperError('server', message, { code });
  }

  // Cloudflare'in "engellendiniz" / "bir dakika" sayfaları
  function looksLikeBlockPage(body) {
    return (
      /<title>\s*(Attention Required|Just a moment|Access denied)/i.test(body) ||
      /id="cf-error-details"|cf_chl_opt/i.test(body)
    );
  }

  function httpStatusError(status, body, headers) {
    const extra = { status };
    const cloudflare = /cloudflare/i.test((headers && headers.server) || '');
    if (looksLikeBlockPage(body) || (status === 403 && cloudflare)) {
      return scraperError('blocked', `HTTP ${status} (güvenlik kontrolü)`, extra);
    }
    if (status === 429) return scraperError('blocked', 'HTTP 429 (çok fazla istek)', extra);
    if (status === 404) return scraperError('notfound', 'HTTP 404', extra);
    return scraperError('server', `HTTP ${status}`, extra);
  }

  /* ------------------------------------------------------------------ indirme */

  function nodeModule(name) {
    if (typeof require !== 'function') {
      throw scraperError('nonode', 'Node.js kullanılamıyor (manifest: --enable-nodejs)');
    }
    return require(name);
  }

  // Tek bir sayfayı indirir, yönlendirmeleri izler, sıkıştırmayı açar, metni döndürür.
  function httpGet(url, redirectsLeft = MAX_REDIRECTS) {
    return new Promise((resolve, reject) => {
      let client, zlib;
      try {
        client = nodeModule(url.startsWith('http:') ? 'http' : 'https');
        zlib = nodeModule('zlib');
      } catch (e) {
        reject(e.kind ? e : scraperError('nonode', e.message));
        return;
      }

      const headers = {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      };

      let req;
      try {
        req = client.get(url, { headers }, (res) => {
          const status = res.statusCode;

          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            if (redirectsLeft <= 0) {
              reject(scraperError('server', 'Çok fazla yönlendirme', { status }));
              return;
            }
            let next;
            try {
              next = new URL(res.headers.location, url).href;
            } catch (e) {
              reject(scraperError('server', 'Geçersiz yönlendirme', { status }));
              return;
            }
            resolve(httpGet(next, redirectsLeft - 1));
            return;
          }

          let stream = res;
          const enc = String(res.headers['content-encoding'] || '').toLowerCase();
          if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
          else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
          else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());

          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('error', (e) => reject(scraperError('server', 'Cevap okunamadı: ' + e.message, { status })));
          stream.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            if (status === 200 && !looksLikeBlockPage(body)) resolve(body);
            else reject(httpStatusError(status, body, res.headers));
          });
        });
      } catch (e) {
        reject(classifyNetError(e));
        return;
      }

      req.setTimeout(timeoutMs, () => {
        req.destroy(scraperError('timeout', `${Math.round(timeoutMs / 1000)} sn içinde cevap gelmedi`));
      });
      req.on('error', (e) => reject(classifyNetError(e)));
    });
  }

  /* ------------------------------------------------------------------ önbellek */

  // Adres → indirme sözü (Promise). Aynı sayfa ikinci kez indirilmez; aynı anda gelen
  // iki istek de tek indirmeyi paylaşır. Hatalı sonuçlar saklanmaz.
  const pageCache = new Map();
  let transport = null; // testlerde sahte indirici takmak için

  function fetchPage(url) {
    if (pageCache.has(url)) {
      const hit = pageCache.get(url);
      pageCache.delete(url); // en sona taşı (en son kullanılan)
      pageCache.set(url, hit);
      return hit;
    }
    const get = transport || root.__MI_TEST_TRANSPORT__ || httpGet;
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
      if (e.kind === 'nonode') throw e;
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
    clearCache,
    httpGet,
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
