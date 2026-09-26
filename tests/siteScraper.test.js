// siteScraper.js testleri: HTML okuma, adresler, indirme hataları, önbellek.
// Çalıştırma: npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { JSDOM } = require('jsdom');

globalThis.DOMParser = new JSDOM('').window.DOMParser;
const S = require('../extension/js/siteScraper.js');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('ses listesi: ad, mp3 adresi ve kimlik doğru okunur', () => {
  const items = S.parseSounds(fixture('list-page.html'));
  assert.deepEqual(
    items.map((i) => i.name),
    ['Vine Boom Sound', 'Telefonum çalcaksa böyle çalsın', 'Değirmenci Dayı BASS', "Don't <Stop> & Go"]
  );
  assert.equal(items[0].mp3, 'https://www.myinstants.com/media/sounds/vine-boom.mp3');
  assert.equal(items[0].id, 'vine-boom-sound-70972');
  assert.equal(items[0].page, 'https://www.myinstants.com/en/instant/vine-boom-sound-70972/');
  // Türkçe karakterli ve boşluklu dosya adı doğru kodlanır
  assert.equal(items[2].mp3, 'https://www.myinstants.com/media/sounds/de%C4%9Firmenci%20day%C4%B1.mp3');
  // onclick içindeki kaçışlı tırnak
  assert.equal(items[3].mp3, "https://www.myinstants.com/media/sounds/don't-stop.mp3");
});

test('yedek yol: div.instant sınıfı yoksa play() tuşlarından okunur', () => {
  const html = `<div class="sound-box">
      <button onclick="play('/media/sounds/a.mp3', 'loader-1', 'ses-a-1')"></button>
      <a href="/en/instant/ses-a-1/">Ses A</a></div>
    <div class="sound-box"><button onclick="play('/media/sounds/b.mp3', 'loader-2', 'ses-b-2')"></button></div>`;
  const items = S.parseSounds(html);
  assert.deepEqual(items.map((i) => [i.id, i.name]), [['ses-a-1', 'Ses A'], ['ses-b-2', 'ses b']]);
});

test('play() argümanları ayrıştırılır', () => {
  assert.deepEqual(S.parsePlayArgs("play('/media/sounds/x.mp3', 'loader-1', 'x-1')"), ['/media/sounds/x.mp3', 'loader-1', 'x-1']);
  assert.deepEqual(S.parsePlayArgs('play("/media/sounds/y (1).mp3")'), ['/media/sounds/y (1).mp3']);
  assert.equal(S.parsePlayArgs('foo()'), null);
});

test('sonraki sayfa linki bulunur', () => {
  const html = fixture('list-page.html');
  assert.equal(S.hasNextPage(html, 1), true);
  assert.equal(S.hasNextPage('<title>X | Page 50 of 50</title>', 50), false);
  assert.equal(S.hasNextPage('<title>X | Page 3 of 50</title>', 3), true);
  assert.equal(S.hasNextPage('<title>X</title>', 1), null);
});

test('kategori listesi okunur, tekrarlar ve kategori olmayan linkler atlanır', () => {
  const cats = S.parseCategories(fixture('categories.html'));
  assert.deepEqual(cats, [
    { id: 'memes', label: 'Memes' },
    { id: 'anime & manga', label: 'Anime & Manga' },
    { id: 'games', label: 'Games' },
    { id: 'sound effects', label: 'Sound Effects' },
    { id: 'tiktok trends', label: 'TikTok Trends' },
    { id: 'whatsapp audios', label: 'Whatsapp Audios' },
  ]);
});

test('adresler: bölge kodu her zaman açıkça yazılır', () => {
  assert.equal(S.buildUrl('trending', { region: 'tr' }, 1), 'https://www.myinstants.com/en/trending/tr/');
  assert.equal(S.buildUrl('trending', { region: 'us' }, 3), 'https://www.myinstants.com/en/trending/us/?page=3');
  assert.equal(S.buildUrl('trending', {}, 1), 'https://www.myinstants.com/en/trending/tr/'); // varsayılan TR
  assert.equal(S.buildUrl('trending', { region: 'xx' }, 1), 'https://www.myinstants.com/en/trending/tr/');
  assert.equal(S.buildUrl('best', { region: 'us' }, 2), 'https://www.myinstants.com/en/best_of_all_time/us/?page=2');
  assert.equal(
    S.buildUrl('category', { region: 'tr', category: 'anime & manga' }, 1),
    'https://www.myinstants.com/en/categories/anime%20%26%20manga/tr/'
  );
  assert.equal(S.buildUrl('recent', { region: 'us' }, 2), 'https://www.myinstants.com/en/recent/?page=2');
  assert.equal(
    S.buildUrl('search', { query: 'çılgın kahkaha' }, 2),
    'https://www.myinstants.com/en/search/?name=%C3%A7%C4%B1lg%C4%B1n%20kahkaha&page=2'
  );
  assert.equal(S.isRegional('trending'), true);
  assert.equal(S.isRegional('best'), true);
  assert.equal(S.isRegional('category'), true);
  assert.equal(S.isRegional('recent'), false);
  assert.equal(S.isRegional('search'), false);
});

test('getList: sonuç, sayfa sonu ve yapı değişikliği', async (t) => {
  const pages = {
    'https://www.myinstants.com/en/trending/tr/': fixture('list-page.html'),
    'https://www.myinstants.com/en/best_of_all_time/tr/': '<html><body>boş</body></html>',
    'https://www.myinstants.com/en/search/?name=yok': '<html><title>Search</title><body>No results</body></html>',
  };
  S._setTransport(async (url) => {
    if (url in pages) return pages[url];
    const e = new Error('HTTP 404');
    e.kind = 'notfound';
    throw e;
  });
  t.after(() => {
    S._setTransport(null);
    S.clearCache();
  });

  const r = await S.getList('trending', { region: 'tr' }, 1);
  assert.equal(r.items.length, 4);
  assert.equal(r.hasMore, true);

  // son sayfadan sonrası 404 → liste sonu, hata değil
  const end = await S.getList('trending', { region: 'tr' }, 99);
  assert.deepEqual([end.items.length, end.hasMore], [0, false]);

  // Hall of Fame boş gelirse site yapısı değişmiştir
  await assert.rejects(S.getList('best', { region: 'tr' }, 1), (e) => e.kind === 'parse');

  // aramada sonuç yoksa hata değil, boş liste
  const s = await S.getList('search', { query: 'yok' }, 1);
  assert.deepEqual([s.items.length, s.hasMore], [0, false]);
});

test('önbellek: aynı sayfa bir kez indirilir, hatalar saklanmaz', async (t) => {
  let calls = 0;
  let fail = true;
  S._setTransport(async () => {
    calls++;
    if (fail) {
      const e = new Error('x');
      e.kind = 'offline';
      throw e;
    }
    return 'ok';
  });
  t.after(() => {
    S._setTransport(null);
    S.clearCache();
  });

  await assert.rejects(S.fetchPage('https://a/1'));
  fail = false;
  assert.equal(await S.fetchPage('https://a/1'), 'ok');
  assert.equal(await S.fetchPage('https://a/1'), 'ok');
  await Promise.all([S.fetchPage('https://a/2'), S.fetchPage('https://a/2')]);
  assert.equal(calls, 3); // 1 hatalı + a/1 + a/2
  S.clearCache();
  await S.fetchPage('https://a/1');
  assert.equal(calls, 4);
});

test('getCategories: sayfa okunamazsa yedek liste', async (t) => {
  S._setTransport(async () => {
    const e = new Error('x');
    e.kind = 'offline';
    throw e;
  });
  t.after(() => {
    S._setTransport(null);
    S.clearCache();
  });
  const r = await S.getCategories();
  assert.equal(r.fallback, true);
  assert.ok(r.categories.some((c) => c.id === 'tiktok trends' && c.label === 'Tiktok Trends'));
});

/* ---------------- Cloudflare ara sayfasını tanıma ---------------- */

test('Cloudflare doğrulama / engel sayfaları tanınır, normal sayfalar karışmaz', () => {
  const D = S.detectCloudflare;
  const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
  assert.deepEqual(D(403, {}, challenge), { hardBlock: false, title: 'Just a moment...' });
  assert.equal(D(403, {}, fixture('cloudflare-block.html')).hardBlock, true);
  assert.ok(D(200, new Headers({ 'cf-mitigated': 'challenge' }), '<html></html>'));
  // 200 olmayan cevapta cf- izleri
  assert.ok(D(503, {}, '<html><title>x</title><div id="cf-error-details"></div></html>'));
  // normal sayfa: Cloudflare'in her sayfaya eklediği betik tek başına doğrulama sayılmaz
  const normal = fixture('list-page.html').replace('</body>', '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></body>');
  assert.equal(D(200, {}, normal), null);
  // "Just a moment" adlı bir sesin arama sayfası doğrulama sanılmaz
  assert.equal(D(200, {}, '<title>Just a moment Soundboard - Instant Sound Buttons | Myinstants</title>'), null);
  assert.equal(D(404, {}, '<title>Page not found</title>'), null);
});

/* ---------------- tarayıcı istekleri (Node'un fetch'i + yerel sahte sunucu) ---------------- */

test('browserGet / fetchAudio: sonuçlar ve hata türleri', async (t) => {
  const listHtml = fixture('list-page.html');
  const server = http.createServer((req, res) => {
    const u = req.url;
    if (u === '/gzip') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': 'gzip' });
      res.end(zlib.gzipSync(listHtml));
    } else if (u === '/redirect') {
      res.writeHead(301, { Location: '/gzip' });
      res.end();
    } else if (u === '/challenge') {
      res.writeHead(403, { 'Content-Type': 'text/html', 'cf-mitigated': 'challenge' });
      res.end('<html><head><title>Just a moment...</title></head><body></body></html>');
    } else if (u === '/block') {
      res.writeHead(403, { Server: 'cloudflare', 'Content-Type': 'text/html' });
      res.end(fixture('cloudflare-block.html'));
    } else if (u === '/404') {
      res.writeHead(404);
      res.end('not found');
    } else if (u === '/429') {
      res.writeHead(429);
      res.end('slow down');
    } else if (u === '/502') {
      res.writeHead(502);
      res.end('bad gateway');
    } else if (u === '/slow') {
      setTimeout(() => res.end('geç'), 2000);
    } else if (u === '/sound.mp3') {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.end(Buffer.from([0x49, 0x44, 0x33, 1, 2, 3]));
    } else if (u === '/html.mp3') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><title>Myinstants</title></html>');
    } else {
      res.end('?');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  S._setTimeout(300);
  t.after(() => {
    S._setTimeout(15000);
    server.closeAllConnections();
    server.close();
  });

  assert.equal(S.parseSounds(await S.browserGet(base + '/redirect')).length, 4);

  const kindOf = (p, fn = S.browserGet) => fn(p).then(() => 'ok', (e) => e.kind + (e.hardBlock ? '+hard' : ''));
  assert.equal(await kindOf(base + '/challenge'), 'challenge');
  assert.equal(await kindOf(base + '/block'), 'challenge+hard');
  assert.equal(await kindOf(base + '/404'), 'notfound');
  assert.equal(await kindOf(base + '/429'), 'busy');
  assert.equal(await kindOf(base + '/502'), 'server');
  assert.equal(await kindOf(base + '/slow'), 'timeout');
  assert.equal(await kindOf('http://127.0.0.1:1/'), 'server'); // bağlantı kurulamadı

  const a = await S.fetchAudio(base + '/sound.mp3');
  assert.ok(a.buffer instanceof ArrayBuffer);
  assert.deepEqual([a.size, a.type], [6, 'audio/mpeg']);
  assert.equal(await kindOf(base + '/challenge', S.fetchAudio), 'challenge');
  assert.equal(await kindOf(base + '/html.mp3', S.fetchAudio), 'notaudio');
  assert.equal(await kindOf(base + '/404', S.fetchAudio), 'notfound');
});

test('getCategories: doğrulama gerekiyorsa yedek listeye düşmez', async (t) => {
  S._setTransport(async () => {
    const e = new Error('x');
    e.kind = 'challenge';
    throw e;
  });
  t.after(() => {
    S._setTransport(null);
    S.clearCache();
  });
  await assert.rejects(S.getCategories(), (e) => e.kind === 'challenge');
});
