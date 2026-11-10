// Paneli headless Chromium'da, manifest'teki CEF ayarlarıyla açar ve GERÇEK fetch yolunu dener.
// "www.myinstants.com" adı yerel sahte siteye (tests/fake-site.js) yönlendirilir; bu site
// Cloudflare benzeri doğrulama / engel sayfaları döndürebilir.
// Denenenler: listeler, önizleme, bölge/sekme/arama, doğrulama sayfasını tanıma (panel doğrulama sayfası
// AÇMAZ, pencere de açmaz; dürüst mesaj + Tekrar dene), site açılınca Tekrar dene ile dönüş, önizlemede
// doğrulama uyarısı, kesin engel mesajı, CORS teşhisi, Türkçe hata mesajları.
// Çalıştırma: npm run test:ui   (ekran görüntüleri test-output/ klasörüne yazılır)
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFakeSite } = require('./fake-site');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test-output');
const PANEL = 'file://' + path.join(ROOT, 'extension', 'index.html');
const SITE = 'https://www.myinstants.com';

// manifest.xml'deki CEFCommandLine parametreleri (Chrome bilmediklerini yok sayar)
function manifestArgs() {
  const xml = fs.readFileSync(path.join(ROOT, 'extension', 'CSXS', 'manifest.xml'), 'utf8');
  return [...xml.matchAll(/<Parameter>([^<]+)<\/Parameter>/g)].map((m) => m[1].trim());
}

const step = (name) => console.log('✓ ' + name);

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const site = await startFakeSite({ certDir: path.join(OUT, 'cert') });
  const profile = fs.mkdtempSync(path.join(OUT, 'profile-'));
  const cef = manifestArgs();
  assert.ok(cef.includes('--disable-web-security'));
  assert.ok(cef.includes('--disable-site-isolation-trials'));
  assert.ok(cef.includes('--persist-session-cookies'));

  // Test ortamının vekil sunucusu (proxy) kapatılır ki istekler sahte siteye gitsin.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_proxy$/i.test(k)));
  const launch = (args) =>
    chromium.launchPersistentContext(profile, {
      headless: true,
      env,
      ignoreHTTPSErrors: true,
      viewport: { width: 340, height: 520 },
      args: [...args, `--host-resolver-rules=MAP www.myinstants.com 127.0.0.1:${site.port}`, '--no-proxy-server'],
    });

  let ctx = await launch(cef);
  let page = await openPanel(ctx);
  const rows = () => page.locator('#rows .row');
  const listEnd = () => page.locator('#listEnd');
  const shot = (n) => page.screenshot({ path: path.join(OUT, n) });

  /* ---------- 1) Normal açılış: istek panelin kendi fetch'iyle gider ---------- */
  await rows().first().waitFor();
  assert.equal(await rows().count(), 4);
  assert.match(await rows().first().textContent(), /^\[TR\] Vine Boom Sound/);
  const first = site.last(/^\/en\/trending\/tr\/$/);
  assert.equal(first.secFetchMode, 'cors'); // tarayıcı fetch'i (Node değil)
  assert.match(await page.locator('#statusText').textContent(), /Trending · TR · 4 ses/);
  step('Trending TR panelin kendi fetch’iyle geldi (sec-fetch-mode: cors)');

  /* ---------- 2) Önizleme doğrudan site adresinden ---------- */
  await rows().nth(0).hover();
  await page.waitForFunction(() => {
    const r = document.querySelector('#rows .row.playing');
    return r && !r.classList.contains('buffering');
  });
  const media = site.last(/^\/media\/sounds\/vine-boom\.mp3$/);
  assert.equal(media.secFetchDest, 'audio');
  await page.mouse.move(5, 5);
  await page.waitForFunction(() => !document.querySelector('#rows .row.playing'));
  step('Önizleme <audio> ile doğrudan https://www.myinstants.com/media/... adresinden çaldı');

  /* ---------- 3) fetchAudio: blob → ArrayBuffer ---------- */
  const audio = await page.evaluate(async (u) => {
    const r = await SiteScraper.fetchAudio(u);
    return [r.buffer instanceof ArrayBuffer, r.size, r.type];
  }, SITE + '/media/sounds/vine-boom.mp3');
  assert.deepEqual(audio, [true, 3244, 'audio/wav']);
  step('İndirme (tarayıcı kısmı): fetch → blob → ArrayBuffer çalışıyor');

  /* ---------- 4) Diğer sekmeler / bölge / arama (kısa) ---------- */
  await page.locator('#region button[data-region="us"]').click();
  await page.waitForFunction(() => /Global \(US\) · 4 ses/.test(document.querySelector('#statusText').textContent));
  assert.match(await rows().first().textContent(), /^\[US\]/);
  await page.locator('.more-btn').click();
  await page.waitForFunction(() => document.querySelectorAll('#rows .row').length === 8);
  await page.locator('#tabs button[data-tab="recent"]').click();
  await page.waitForFunction(() => document.querySelector('#statusText').textContent.startsWith('Just Added · 4'));
  assert.equal(await page.locator('#region').getAttribute('class'), 'seg disabled');
  assert.ok(site.last(/^\/en\/recent\/$/));
  await page.locator('#tabs button[data-tab="category"]').click();
  await page.waitForFunction(() => /Memes · Global \(US\) · 4 ses/.test(document.querySelector('#statusText').textContent));
  assert.ok(site.last(/^\/en\/categories\/memes\/us\/$/));
  await page.locator('#searchInput').fill('vine boom');
  await page.locator('#searchInput').press('Enter');
  await page.waitForFunction(() => /Arama · 4 ses/.test(document.querySelector('#statusText').textContent));
  assert.ok(site.last(/^\/en\/search\/\?name=vine%20boom$/));
  await page.locator('#searchExit').click();
  await page.locator('#tabs button[data-tab="trending"]').click();
  await page.waitForFunction(() => /Trending · Global \(US\) · 4 ses/.test(document.querySelector('#statusText').textContent));
  step('Bölge (US), Daha fazla, Just Added (bölge pasif), Kategoriler, Arama gerçek adreslerle çalıştı');

  /* ---------- 5) Doğrulama sayfası tanınır, ayrıştırılmaz; panel pencere / doğrulama sayfası açmaz ---------- */
  await page.evaluate(() => {
    window.__opens = 0;
    window.open = () => {
      window.__opens += 1;
      return null;
    };
  });
  site.state.mode = 'challenge';
  await page.locator('#refreshBtn').click();
  await page.waitForFunction(() => document.querySelector('#listEnd .challenge'));
  assert.equal(await rows().count(), 0);
  const box = await listEnd().textContent();
  assert.match(box, /Site şu an doğrulama istiyor\./);
  assert.match(box, /panel bu doğrulamayı gösteremiyor/);
  assert.match(box, /HTTP 403 · doğrulama sayfası/);
  assert.deepEqual(await listEnd().locator('button').allTextContents(), ['Tekrar dene']); // Doğrula tuşu yok
  await shot('e2e-1-challenge.png');
  step('Doğrulama sayfası tanındı: dürüst mesaj + yalnız "Tekrar dene"; liste ayrıştırılmadı');

  /* ---------- 6) Doğrulama sürerken Tekrar dene → yine aynı mesaj; site açılınca liste geri gelir ---------- */
  await listEnd().locator('button.primary').click();
  await page.waitForFunction(() => document.querySelector('#listEnd .challenge'));
  site.state.mode = 'open';
  await listEnd().locator('button.primary').click();
  await page.waitForFunction(() => document.querySelectorAll('#rows .row').length === 4);
  assert.match(await page.locator('#statusText').textContent(), /Site yeniden açık/);
  assert.equal(page.url(), PANEL); // panel kendi sayfasında kaldı
  step('Site açılınca "Tekrar dene" listeyi getirdi; durum çubuğu "Site yeniden açık" dedi');

  /* ---------- 7) Önizleme doğrulamaya takılırsa üstte uyarı; site açılınca Tekrar dene ---------- */
  site.state.mode = 'challenge';
  await rows().nth(2).hover();
  await page.waitForFunction(() => !document.querySelector('#notice').hidden);
  assert.match(await page.locator('#notice').textContent(), /Ses çalınamadı: site doğrulama istiyor\./);
  assert.deepEqual(await page.locator('#notice button').allTextContents(), ['Kapat', 'Tekrar dene']);
  await page.mouse.move(5, 5);
  await shot('e2e-3-audio-challenge.png');
  site.state.mode = 'open';
  await page.locator('#notice button.primary').click();
  await page.waitForFunction(() => document.querySelector('#notice').hidden && !document.querySelector('#rows .row.error'));
  await rows().nth(2).hover();
  await page.waitForFunction(() => {
    const r = document.querySelector('#rows .row.playing');
    return r && !r.classList.contains('buffering');
  });
  await page.mouse.move(5, 5);
  step('Önizleme doğrulamaya takıldı → üstte uyarı (Kapat / Tekrar dene) → site açılınca uyarı kalktı, ses çaldı');

  /* ---------- 7b) Kırmızı satır: sebebi söylenir ---------- */
  const failedRow = (i, re) =>
    page.waitForFunction(
      ([i, src]) => {
        const r = document.querySelectorAll('#rows .row')[i];
        return r.classList.contains('error') && new RegExp(src).test(r.querySelector('.why').textContent);
      },
      [i, re.source]
    );
  const hoverOut = () => page.mouse.move(5, 5);
  const diagText = async () => {
    await page.locator('#hostText').click();
    await page.waitForFunction(() => /Teşhis/.test(document.querySelector('#notice').textContent));
    return page.locator('#notice pre').textContent();
  };

  // (a) Site ses dosyasını <audio> isteğine kapatmış, tarayıcı isteğine açık: kırmızı kalmaz, indirilen kopyadan çalar
  site.state.audioBlocked = true;
  await rows().nth(1).hover();
  await page.waitForFunction(() => window.MyInstantsPanel.preview.viaBlob);
  await page.waitForFunction(() => {
    const r = document.querySelectorAll('#rows .row')[1];
    return r.classList.contains('playing') && !r.classList.contains('buffering') && !r.classList.contains('error');
  });
  assert.match(await page.evaluate(() => window.MyInstantsPanel.preview.audio.src), /^blob:/);
  await hoverOut();
  site.state.audioBlocked = false;
  step('Ses dosyası yalnız <audio> isteğine kapalıyken: panel tarayıcı isteğiyle indirip oradan çaldı, satır kırmızı kalmadı');

  // (b) Ses sitede silinmiş (404): satırın sağında "sitede yok"; aynı oturumda tekrar istek atılmaz
  site.state.mediaGone = true;
  await rows().nth(3).hover();
  await failedRow(3, /^sitede yok$/);
  assert.match(await page.locator('#rows .row').nth(3).locator('.why').getAttribute('title'), /Bu ses sitede artık yok \(404\)/);
  assert.match(await page.locator('#statusText').textContent(), /Bu ses sitede artık yok/);
  await shot('e2e-8-gone.png');
  await hoverOut();
  const hits = () => site.state.requests.filter((q) => /don't-stop\.mp3$/.test(decodeURIComponent(q.path))).length;
  const before = hits();
  await rows().nth(3).hover();
  await failedRow(3, /^sitede yok$/);
  await page.waitForTimeout(400);
  assert.equal(hits(), before, 'sitede yok çıkan ses için yeniden istek atılmış');
  await hoverOut();
  site.state.mediaGone = false;
  step('Ses sitede yokken: satırda "sitede yok", alt çubukta açık cümle; aynı oturumda siteye yeniden istek atılmadı');

  // (c) Dosya var ama içerik çalınamaz: "biçim"
  site.state.badAudio = true;
  await rows().nth(2).hover();
  await failedRow(2, /^biçim$/);
  assert.match(await page.locator('#rows .row').nth(2).locator('.why').getAttribute('title'), /İndir’i deneyebilirsiniz/);
  await hoverOut();
  site.state.badAudio = false;
  step('Dosya çalınamaz biçimdeyse: satırda "biçim" ve "İndir’i deneyebilirsiniz"');

  // (d) Teşhis çalınamayan sesleri sebepleriyle listeler
  const diag = await diagText();
  assert.match(diag, /Çalınamayan sesler \(bu oturum\): 2/);
  assert.match(diag, /• .+ — Bu ses sitede artık yok \(404\)\./);
  assert.match(diag, /• .+ — Bu ses biçimi panelde çalınamıyor/);
  await page.locator('#notice button', { hasText: 'Kapat' }).click();
  step('Teşhis ekranı çalınamayan sesleri sebepleriyle listeledi');

  // (e) Yenile: bilinen kötüler sıfırlanır, site düzelince ses çalar
  await page.locator('#refreshBtn').click();
  await page.waitForFunction(() => document.querySelectorAll('#rows .row').length === 4 && !document.querySelector('#rows .row.error'));
  await rows().nth(3).hover();
  await page.waitForFunction(() => {
    const r = document.querySelectorAll('#rows .row')[3];
    return r.classList.contains('playing') && !r.classList.contains('buffering') && !r.classList.contains('error');
  });
  await hoverOut();
  step('Yenile sonrası önceden kırmızı olan ses yeniden denendi ve çaldı');

  /* ---------- 8) Kesin engel ---------- */
  site.state.mode = 'block';
  await page.locator('#refreshBtn').click();
  await page.waitForFunction(() => /bu bağlantıyı engelliyor/.test(document.querySelector('#listEnd').textContent));
  assert.match(await listEnd().textContent(), /HTTP 403 · engel sayfası/);
  await shot('e2e-4-hard-block.png');
  assert.equal(await page.evaluate(() => window.__opens), 0); // hiçbir adımda pencere açılmaya çalışılmadı
  step('Kesin engel ("Sorry, you have been blocked") ayrı mesajla söylendi; hiçbir adımda pencere açılmadı');

  /* ---------- 9) Ağ hataları: çevrimdışı, zaman aşımı ---------- */
  await ctx.setOffline(true);
  await page.locator('#refreshBtn').click();
  await page.waitForFunction(() => /İnternet bağlantısı yok/.test(document.querySelector('#listEnd').textContent));
  await ctx.setOffline(false);
  site.state.mode = 'slow';
  await page.evaluate(() => SiteScraper._setTimeout(800));
  await page.locator('#refreshBtn').click();
  await page.waitForFunction(() => /zaman aşımı/.test(document.querySelector('#listEnd').textContent));
  await page.evaluate(() => SiteScraper._setTimeout(15000));
  step('Çevrimdışı ve zaman aşımı mesajları Türkçe');

  await ctx.close();

  /* ---------- 10) --disable-web-security olmadan: CORS teşhisi ---------- */
  site.state.mode = 'open';
  ctx = await launch(cef.filter((a) => a !== '--disable-web-security'));
  page = await openPanel(ctx);
  await page.waitForFunction(() => /disable-web-security/.test(document.querySelector('#listEnd').textContent));
  await shot('e2e-7-cors.png');
  step('--disable-web-security çalışmazsa panel bunu açıkça söylüyor (CORS teşhisi)');
  await ctx.close();

  await site.stop();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log('\nTüm uçtan uca testler geçti. Ekran görüntüleri: ' + OUT);

  async function openPanel(c) {
    const p = c.pages()[0] || (await c.newPage());
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('close', () => assert.deepEqual(errors, [], 'sayfa hatası: ' + errors.join(' | ')));
    await p.goto(PANEL);
    return p;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
