// Paneli headless Chromium'da, manifest'teki CEF ayarlarıyla açar ve GERÇEK fetch yolunu dener.
// "www.myinstants.com" adı yerel sahte siteye (tests/fake-site.js) yönlendirilir; bu site
// Cloudflare benzeri doğrulama / engel sayfaları döndürebilir.
// Denenenler: listeler, önizleme, bölge/sekme/arama, doğrulama sayfasını tanıma, Doğrula penceresi
// (window.open) + çerezin panelle paylaşılması + pencere kapanınca otomatik tekrar, engel mesajı,
// tarayıcı kapatılıp açılınca çerezin kalıp kalmadığı, CORS teşhisi, Türkçe hata mesajları.
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

  /* ---------- 5) Doğrulama sayfası tanınır, ayrıştırılmaz ---------- */
  site.state.mode = 'challenge';
  await page.locator('#refreshBtn').click();
  await page.waitForFunction(() => document.querySelector('#listEnd .challenge'));
  assert.equal(await rows().count(), 0);
  assert.match(await listEnd().textContent(), /Site doğrulama istiyor\./);
  await shot('e2e-1-challenge.png');
  step('Doğrulama sayfası tanındı: "Site doğrulama istiyor" + Doğrula, liste ayrıştırılmadı');

  /* ---------- 6) Doğrula → window.open penceresi → doğrula → kapat → otomatik tekrar ---------- */
  const popupP = ctx.waitForEvent('page');
  await page.locator('#listEnd button.primary').click();
  const popup = await popupP;
  await popup.waitForLoadState();
  assert.equal(popup.url(), SITE + '/en/trending/us/');
  assert.equal(await popup.title(), 'Just a moment...');
  await page.waitForFunction(() => /Doğrulama penceresi açık/.test(document.querySelector('#listEnd').textContent));
  await shot('e2e-2-window-open.png');
  await popup.locator('#cf-verify').click(); // kullanıcı doğrulamayı yapar
  await popup.waitForURL(SITE + '/en/trending/us/');
  assert.ok(site.state.tokens.size === 1);
  await popup.close(); // kullanıcı pencereyi kapatır
  await page.waitForFunction(() => document.querySelectorAll('#rows .row').length === 4);
  const retried = site.last(/^\/en\/trending\/us\/$/);
  assert.equal(retried.hasClearance, true); // pencerede alınan çerez panelin isteğine eklendi
  assert.equal(retried.secFetchMode, 'cors');
  assert.match(await page.locator('#statusText').textContent(), /Doğrulama tamam ✓/);
  assert.ok(Number(await page.evaluate(() => localStorage.getItem('mi.verifiedAt'))) > 0);
  step('Doğrula: window.open penceresi açıldı; kapanınca istek otomatik tekrarlandı, çerez panelle ortak');

  /* ---------- 7) Önizleme doğrulama sonrası çerezle çalar ---------- */
  await rows().nth(1).hover();
  await page.waitForFunction(() => {
    const r = document.querySelector('#rows .row.playing');
    return r && !r.classList.contains('buffering');
  });
  assert.equal(site.last(/^\/media\/sounds\/telefonum-calcaksa\.mp3$/).hasClearance, true);
  await page.mouse.move(5, 5);
  step('Önizleme doğrulama çereziyle çaldı');

  /* ---------- 8) Önizleme doğrulamaya takılırsa üstte uyarı + Doğrula ---------- */
  site.state.tokens.clear(); // çerez geçersiz oldu
  await rows().nth(2).hover();
  await page.waitForFunction(() => !document.querySelector('#notice').hidden);
  assert.match(await page.locator('#notice').textContent(), /Ses çalınamadı: site doğrulama istiyor\./);
  await page.mouse.move(5, 5);
  await shot('e2e-3-audio-challenge.png');
  const popup2P = ctx.waitForEvent('page');
  await page.locator('#notice button.primary').click();
  const popup2 = await popup2P;
  await popup2.locator('#cf-verify').click();
  await popup2.waitForLoadState();
  await popup2.close();
  await page.waitForFunction(() => document.querySelector('#notice').hidden);
  await rows().nth(2).hover();
  await page.waitForFunction(() => {
    const r = document.querySelector('#rows .row.playing');
    return r && !r.classList.contains('buffering');
  });
  await page.mouse.move(5, 5);
  step('Önizleme doğrulamaya takıldı → üstte uyarı + Doğrula → pencere kapanınca uyarı kalktı, ses çaldı');

  /* ---------- 9) "Doğrulamayı bitirdim" (pencere kapanışı fark edilmezse) + başarısız doğrulama ---------- */
  site.state.tokens.clear();
  await page.locator('#refreshBtn').click();
  await page.waitForFunction(() => document.querySelector('#listEnd .challenge'));
  const popup3P = ctx.waitForEvent('page');
  await page.locator('#listEnd button.primary').click();
  const popup3 = await popup3P;
  await page.locator('#listEnd button', { hasText: 'Doğrulamayı bitirdim' }).click(); // doğrulamadan
  await page.waitForFunction(() => /hâlâ doğrulama istiyor/.test(document.querySelector('#listEnd').textContent));
  assert.equal(popup3.isClosed(), true);
  step('"Doğrulamayı bitirdim" pencereyi kapatıp tekrar denedi; doğrulanmadığı için uyarı gösterildi');

  /* ---------- 10) Kesin engel: doğrulama işe yaramazsa açıkça söylenir ---------- */
  site.state.mode = 'block';
  await page.locator('#refreshBtn').click();
  await page.waitForFunction(() => /Site doğrulama istiyor/.test(document.querySelector('#listEnd').textContent));
  const popup4P = ctx.waitForEvent('page');
  await page.locator('#listEnd button.primary').click();
  const popup4 = await popup4P;
  await popup4.waitForLoadState();
  assert.equal(await popup4.title(), 'Attention Required! | Cloudflare');
  await popup4.close();
  await page.waitForFunction(() => /hâlâ engelliyor/.test(document.querySelector('#listEnd').textContent));
  await shot('e2e-4-hard-block.png');
  step('Kesin engel ("Sorry, you have been blocked"): doğrulamadan sonra "hâlâ engelliyor" mesajı');

  /* ---------- 11) window.open açılmazsa ---------- */
  site.state.mode = 'challenge';
  await page.evaluate(() => {
    window.__realOpen = window.open;
    window.open = () => null;
  });
  await page.locator('#refreshBtn').click();
  await page.waitForFunction(() => document.querySelector('#listEnd .challenge'));
  await page.locator('#listEnd button.primary').click();
  await page.waitForFunction(() => /Doğrulama penceresi açılamadı/.test(document.querySelector('#listEnd').textContent));
  await page.evaluate(() => {
    window.open = window.__realOpen;
  });
  step('window.open açılmazsa "Doğrulama penceresi açılamadı" deniyor');

  /* ---------- 12) Ağ hataları: çevrimdışı, zaman aşımı ---------- */
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

  /* ---------- 13) Kalıcı çerez: tarayıcı kapatılıp açılınca doğrulama korunuyor mu? ---------- */
  site.state.mode = 'challenge';
  site.state.cookieMode = 'persistent';
  site.state.tokens.clear();
  await verifyViaPanel();
  await ctx.close(); // "Premiere kapandı"
  ctx = await launch(cef);
  page = await openPanel(ctx);
  await page.locator('#rows .row').first().waitFor();
  assert.equal(site.last(/^\/en\/trending\/us\/$/).hasClearance, true);
  await page.waitForFunction(() => /Doğrulama istenmedi/.test(document.querySelector('#statusText').textContent));
  await shot('e2e-5-restart-kept.png');
  step('Kalıcı çerez: yeniden açılışta doğrulama istenmedi, durum çubuğu bunu bildirdi');

  /* ---------- 14) Oturum çerezi kaybolursa panel bunu açıkça söylüyor ---------- */
  // (Chrome oturum çerezlerini kapanışta siler; CEP'te --persist-session-cookies bunu önlemeli.
  //  Burada amaç, çerez kaybolduğunda panelin teşhis mesajını doğrulamak.)
  site.state.cookieMode = 'session';
  site.state.tokens.clear();
  await page.locator('#refreshBtn').click();
  await page.waitForFunction(() => document.querySelector('#listEnd .challenge'));
  await verifyViaPanel();
  await ctx.close();
  ctx = await launch(cef);
  page = await openPanel(ctx);
  await page.waitForFunction(() => document.querySelector('#listEnd .challenge'));
  assert.match(await page.locator('#listEnd').textContent(), /yeniden açılınca doğrulama korunmamış/);
  await shot('e2e-6-restart-lost.png');
  step('Çerez kaybolunca: "Panel/Premiere yeniden açılınca doğrulama korunmamış" notu gösterildi');
  await ctx.close();

  /* ---------- 15) --disable-web-security olmadan: CORS teşhisi ---------- */
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

  // Panelde Doğrula → pencerede doğrula → pencereyi kapat → liste gelsin
  async function verifyViaPanel() {
    await page.locator('#refreshBtn').click();
    await page.waitForFunction(() => document.querySelector('#listEnd .challenge'));
    const pp = ctx.waitForEvent('page');
    await page.locator('#listEnd button.primary').click();
    const w = await pp;
    await w.locator('#cf-verify').click();
    await w.waitForLoadState();
    await w.close();
    await page.waitForFunction(() => document.querySelectorAll('#rows .row').length === 4);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
