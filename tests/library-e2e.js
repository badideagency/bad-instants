// Aşama 3 uçtan uca testi: Favoriler + Son kullanılanlar + favorilerin yerel arşivi.
// Panel headless Chromium'da manifest ayarlarıyla açılır. Sahteler:
//   - www.myinstants.com → tests/fake-site.js (mediaGone: site sesleri 404 döndürür)
//   - Premiere → tests/fake-premiere.js (host.jsx'in gerçek kodu)
//   - Disk → tests/fake-disk.js (%APPDATA% = C:\Users\Test\AppData\Roaming)
// Denenenler: library.json bozukken açılış · yıldızlama, kayıt ve yerel kopya · Favoriler sekmesinde soluk satır ·
// site 404 dönerken favorinin yerelden çalması ve İndir'in yerel kopyayla çalışması · Son kullanılanlar ·
// panel yeniden kurulunca (yeni tarayıcı profili, boş localStorage) favorilerin kalması · Node yokken uyarı.
// Çalıştırma: npm run test:library
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFakeSite } = require('./fake-site');
const { createPremiere } = require('./fake-premiere');
const { createDisk, attachDisk } = require('./fake-disk');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test-output', 'library');
const PANEL = 'file://' + path.join(ROOT, 'extension', 'index.html');
const APPDATA = 'C:\\Users\\Test\\AppData\\Roaming';
const LIB_DIR = APPDATA + '\\BadIdea\\MyInstants';
const LIB_FILE = LIB_DIR + '\\library.json';
const AUDIO_DIR = LIB_DIR + '\\library';
const step = (name) => console.log('✓ ' + name);

function manifestArgs() {
  const xml = fs.readFileSync(path.join(ROOT, 'extension', 'CSXS', 'manifest.xml'), 'utf8');
  return [...xml.matchAll(/<Parameter>([^<]+)<\/Parameter>/g)].map((m) => m[1].trim());
}

async function until(fn, what, ms = 10000) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try {
      v = await fn();
    } catch (e) {
      v = false;
    }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('Zaman aşımı: ' + what);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const site = await startFakeSite({ certDir: path.join(ROOT, 'test-output', 'cert') });
  const disk = createDisk();
  const premiere = createPremiere({ onDisk: (p) => disk.has(p) });
  premiere.addClip(0, 0, 5, 'Röportaj');

  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_proxy$/i.test(k)));
  const browser = await chromium.launch({
    headless: true,
    env,
    args: [...manifestArgs(), `--host-resolver-rules=MAP www.myinstants.com 127.0.0.1:${site.port}`, '--no-proxy-server'],
  });

  // Her çağrı yeni bir tarayıcı profili: localStorage ve önbellek boş (= panel yeniden kurulmuş gibi)
  async function openPanel({ withDisk = true } = {}) {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 340, height: 560 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.exposeFunction('__miHost', (script) => premiere.call(script));
    if (withDisk) await attachDisk(page, disk, { appData: APPDATA });
    await page.addInitScript(() => {
      window.__adobe_cep__ = {
        getHostEnvironment: () =>
          JSON.stringify({ appSkinInfo: { panelBackgroundColor: { color: { red: 35, green: 35, blue: 35, alpha: 255 } } } }),
        evalScript: (script, cb) => window.__miHost(script).then(cb, () => cb('EvalScript error.')),
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {},
      };
    });
    await page.goto(PANEL);
    await page.locator('#rows .row').first().waitFor();
    await page.waitForFunction(() => /Premiere 26\.5\.1$/.test(document.querySelector('#hostText').textContent));
    // Çalmaya başlayan her sesin adresi (yerel kopya → blob:)
    await page.evaluate(() => {
      window.__played = [];
      const a = window.MyInstantsPanel.preview.audio;
      a.addEventListener('playing', () => window.__played.push(a.src));
    });
    return { ctx, page, errors };
  }

  const items = (page) => page.evaluate(() => [...document.querySelectorAll('#rows .row')].map((r) => r._miItem));
  const names = async (page) => (await items(page)).map((i) => i.name);
  const row = (page, i) => page.locator('#rows .row').nth(i);
  const tab = async (page, t) => {
    await page.locator(`#tabs button[data-tab="${t}"]`).click();
    await page.waitForFunction(() => !window.MyInstantsPanel.state.loading);
  };
  const lib = () => JSON.parse(disk.text(LIB_FILE));
  const favIds = () => lib().favorites.map((f) => f.id);
  const localFile = (id) => {
    const f = lib().favorites.find((x) => x.id === id);
    return f && f.file ? AUDIO_DIR + '\\' + f.file : null;
  };
  const hasCopy = (id) => !!localFile(id) && disk.has(localFile(id));
  const mediaHits = (it, since = 0) => site.state.requests.slice(since).filter((q) => q.path === new URL(it.mp3).pathname).length;
  const waitDl = (page, i, re) =>
    page.waitForFunction(
      ([i, src]) => {
        const b = document.querySelectorAll('#rows .row button.dl')[i];
        const label = b.classList.contains('busy') ? '…' : (b.classList.contains('done') ? '✓ ' : '') + b.textContent.trim();
        return new RegExp(src).test(label);
      },
      [i, re.source]
    );
  const playedLocal = (page, n) => page.waitForFunction((n) => window.__played.filter((s) => s.startsWith('blob:')).length >= n, n);

  /* 1) library.json bozukken açılış */
  const broken = '{"favorites": [ {"id": "yarım yazıl';
  disk.set(LIB_FILE, broken);
  let { ctx, page, errors } = await openPanel();
  await page.waitForFunction(() => !document.querySelector('#libChip').hidden);
  assert.match(await page.locator('#libChip').textContent(), /Favoriler dosyası bozuktu/);
  assert.equal(disk.text(LIB_FILE + '.bak'), broken); // içerik korunarak kenara alındı
  assert.equal(disk.has(LIB_FILE), false);
  assert.ok((await items(page)).length > 0); // liste normal geldi
  await page.screenshot({ path: path.join(OUT, 'lib-1-bozuk-uyari.png') });
  await page.locator('#libChip').click();
  await page.waitForTimeout(260); // açılma animasyonu
  const warn = await page.locator('#notice').innerText();
  const box = await page.evaluate(() => [document.querySelector('#notice').scrollWidth, document.querySelector('#notice').clientWidth]);
  assert.ok(box[0] <= box[1], 'uzun yol uyarı kutusunu taşırıyor');
  assert.match(warn, /kenara alındı: C:\\Users\\Test\\AppData\\Roaming\\BadIdea\\MyInstants\\library\.json\.bak/);
  await page.screenshot({ path: path.join(OUT, 'lib-2-bozuk-ayrinti.png') });
  await page.locator('#notice button', { hasText: 'Tamam' }).click();
  assert.equal(await page.locator('#libChip').isHidden(), true);
  assert.equal(await page.locator('#notice').isHidden(), true);
  // Favoriler ve Son kullanılanlar en solda sabit (ikon + ipucu); yalnız site sekmeleri kayar
  const pinned = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.tabs-pinned button')].map((b) => {
        const r = b.getBoundingClientRect();
        return { tab: b.dataset.tab, title: b.title, label: b.getAttribute('aria-label'), left: r.left, inView: r.left >= 0 && r.right <= innerWidth };
      })
    );
  const before = await pinned();
  assert.deepEqual(
    before.map((p) => [p.tab, p.title, p.label, p.inView]),
    [['favorites', 'Favoriler', 'Favoriler', true], ['used', 'Son kullanılanlar', 'Son kullanılanlar', true]]
  );
  assert.equal(await page.locator('#siteTabs').evaluate((t) => t.classList.contains('more-right')), true);
  await page.locator('#tabs button[data-tab="best"]').hover();
  await page.mouse.wheel(0, 400);
  await page.waitForFunction(() => document.querySelector('#siteTabs').scrollLeft > 0);
  assert.equal(await page.locator('#siteTabs').evaluate((t) => t.classList.contains('more-left')), true);
  assert.deepEqual((await pinned()).map((p) => p.left), before.map((p) => p.left)); // ikonlar kaymadı
  await tab(page, 'favorites');
  assert.equal(await page.locator('#tabs button[data-tab="favorites"]').getAttribute('aria-selected'), 'true');
  assert.match(await page.locator('#listEnd').textContent(), /Henüz favori yok\. Bir sesin yanındaki yıldıza tıklayın\./);
  await tab(page, 'used');
  assert.match(await page.locator('#listEnd').textContent(), /Henüz kullanılan ses yok/);
  step('Bozuk library.json: panel çökmedi, dosya .bak olarak kenara alındı, boş listeyle açıldı, alt çubukta uyarı çıktı');

  /* 2) Yıldızlama: kayıt diske, sesin kopyası arşive (arka planda) */
  await tab(page, 'trending');
  const trending = await items(page);
  const [A, B] = [trending[0], trending[2]];
  await row(page, 0).locator('.fav').click();
  await row(page, 2).locator('.fav').click();
  assert.equal(await row(page, 0).locator('.fav').getAttribute('aria-pressed'), 'true');
  assert.equal(await row(page, 1).locator('.fav').getAttribute('aria-pressed'), 'false');
  await until(() => favIds().length === 2 && hasCopy(A.id) && hasCopy(B.id), 'yerel kopyalar');
  assert.deepEqual(favIds(), [B.id, A.id]); // son eklenen üstte
  assert.equal(lib().favorites[0].name, B.name);
  assert.equal(disk.get(localFile(A.id)).slice(0, 4).toString(), 'RIFF');
  assert.ok(localFile(A.id).startsWith(AUDIO_DIR + '\\'));
  assert.ok(!disk.files().some((f) => /\.tmp-/.test(f)));
  await page.screenshot({ path: path.join(OUT, 'lib-3-yildizlar.png') });
  step('Yıldız: kayıt %APPDATA%\\BadIdea\\MyInstants\\library.json\'a yazıldı, sesler library\\ altına kopyalandı');

  /* 3) Favoriler sekmesi */
  await tab(page, 'favorites');
  assert.deepEqual(await names(page), [B.name, A.name]);
  assert.equal(await page.locator('#region').getAttribute('class'), 'seg disabled');
  assert.equal(await page.locator('.more-btn').count(), 0);
  assert.equal(await page.locator('#rows .fav.on').count(), 2);
  assert.match(await page.locator('#statusText').textContent(), /^Favoriler · 2 ses$/);
  await page.screenshot({ path: path.join(OUT, 'lib-4-favoriler.png') });
  step('Favoriler sekmesi: son eklenen üstte, bölge seçici pasif, "Daha fazla" yok');

  /* 4) Favoriler sekmesinde yıldızı kaldırmak: satır soluklaşır, kopya silinir; geri yıldızlanabilir */
  const copyA = localFile(A.id);
  await row(page, 1).locator('.fav').click();
  await until(() => favIds().length === 1 && !disk.has(copyA), 'yıldız kaldırma');
  assert.equal(await page.locator('#rows .row').count(), 2);
  const removed = (i) => row(page, i).evaluate((r) => r.classList.contains('removed'));
  assert.equal(await removed(1), true);
  assert.equal(await removed(0), false);
  await page.screenshot({ path: path.join(OUT, 'lib-5-soluk-satir.png') });
  site.state.mediaGone = true; // geri yıldızlanınca kopya siteden değil, bellekten geri gelmeli
  await row(page, 1).locator('.fav').click();
  await until(() => favIds().length === 2 && hasCopy(A.id), 'geri yıldızlama');
  assert.deepEqual(favIds(), [A.id, B.id]);
  assert.equal(await removed(1), false);
  await row(page, 1).locator('.fav').click(); // tekrar kaldır, sonra sekmeden çık
  await until(() => favIds().length === 1, 'ikinci kaldırma');
  await tab(page, 'trending');
  await tab(page, 'favorites');
  assert.deepEqual(await names(page), [B.name]);
  assert.ok(!disk.files().some((f) => f.startsWith(AUDIO_DIR) && f.includes(A.id)));
  step('Yıldızı kaldırılan satır soluklaştı ve yerel kopyası silindi; geri yıldızlanınca (site 404 iken) kopya geri geldi; sekmeden çıkınca satır kayboldu');

  /* 5) Site sesi silmiş (404): favori yerel kopyadan çalar, İndir yerel kopyayı kullanır */
  const since = site.state.requests.length;
  await row(page, 0).click();
  await playedLocal(page, 1);
  assert.equal(await page.evaluate(() => window.MyInstantsPanel.preview.local), true);
  assert.equal(await row(page, 0).evaluate((r) => r.classList.contains('error')), false);
  await row(page, 0).locator('.dl').click();
  await waitDl(page, 0, /^✓ A\d$/);
  assert.equal(mediaHits(B, since), 0); // siteye hiç gidilmedi
  const placed = disk.files().filter((f) => f.startsWith('C:\\Projeler\\Test\\MyInstants\\') && !f.endsWith('.json'));
  assert.equal(placed.length, 1);
  assert.equal(disk.get(placed[0]).slice(0, 4).toString(), 'RIFF');
  await until(() => lib().recent.length === 1, 'son kullanılanlara yazma');
  assert.deepEqual(lib().recent.map((r) => r.id), [B.id]);
  await tab(page, 'trending');
  const other = (await items(page))[1];
  await row(page, 1).click();
  await page.waitForFunction(() => document.querySelectorAll('#rows .row')[1].classList.contains('error'));
  assert.ok(mediaHits(other, since) > 0);
  step('Site 404 dönerken: favori yerel kopyadan çaldı (siteye istek yok), İndir yerel kopyayla timeline\'a koydu; favori olmayan ses çalamadı');

  /* 6) Son kullanılanlar: yalnız timeline'a konanlar, en yeni üstte; önizleme sayılmaz */
  site.state.mediaGone = false;
  await row(page, 1).locator('.dl').click();
  await waitDl(page, 1, /^✓ A\d$/);
  await until(() => lib().recent.length === 2, 'son kullanılanlar');
  await row(page, 3).click();
  await page.waitForFunction(() => window.__played.some((s) => !s.startsWith('blob:')));
  await page.waitForTimeout(300);
  assert.deepEqual(lib().recent.map((r) => r.id), [other.id, B.id]);
  assert.ok(lib().recent.every((r) => !r.file)); // son kullanılanlar için kopya yok
  await tab(page, 'used');
  assert.deepEqual(await names(page), [other.name, B.name]);
  assert.equal(await page.locator('#region').getAttribute('class'), 'seg disabled');
  assert.equal(await page.locator('.more-btn').count(), 0);
  await page.screenshot({ path: path.join(OUT, 'lib-6-son-kullanilanlar.png') });
  await page.locator('#hostText').click();
  await page.waitForFunction(() => /Teşhis/.test(document.querySelector('#notice').textContent));
  const diag = await page.locator('#notice pre').textContent();
  assert.match(diag, /Favoriler dosyası: C:\\Users\\Test\\AppData\\Roaming\\BadIdea\\MyInstants\\library\.json/);
  assert.match(diag, /Favoriler: 1 \(yerel kopya: 1\)/);
  assert.match(diag, /Son kullanılanlar: 2/);
  assert.deepEqual(errors, []);
  await ctx.close();
  step('Son kullanılanlar: yalnız timeline\'a konanlar, en yeni üstte; önizleme sayılmadı; teşhiste yol ve sayılar');

  /* 7) Panel yeniden kuruldu (yeni profil, localStorage boş): favoriler ve son kullanılanlar yerinde */
  disk.delete(localFile(B.id)); // bu arada kopya da silinmiş olsun → açılışta yeniden alınmalı
  disk.ctl.readDelay = { path: LIB_FILE, ms: 1500 }; // kayıt listeden SONRA gelsin: yıldızlar yine doğru çizilmeli
  ({ ctx, page, errors } = await openPanel());
  disk.ctl.readDelay = null;
  assert.equal(await page.evaluate(() => localStorage.getItem('mi.tab')), null);
  assert.equal(await page.locator('#libChip').isHidden(), true);
  await page.waitForFunction(() => document.querySelectorAll('#rows .row .fav')[2].getAttribute('aria-pressed') === 'true');
  assert.equal(await page.locator('#rows .fav.on').count(), 1);
  await until(() => hasCopy(B.id), 'açılışta eksik kopyanın yeniden alınması');
  site.state.mediaGone = true;
  await tab(page, 'favorites');
  assert.deepEqual(await names(page), [B.name]);
  await row(page, 0).click();
  await playedLocal(page, 1);
  await tab(page, 'used');
  assert.deepEqual(await names(page), [other.name, B.name]);
  assert.deepEqual(errors, []);
  await ctx.close();
  site.state.mediaGone = false;
  step('Yeniden kurulumdan sonra: favoriler ve son kullanılanlar duruyor, eksik kopya açılışta alındı, site 404 iken favori yerelden çaldı');

  /* 8) Node yoksa: yıldız geri alınır, Türkçe uyarı */
  ({ ctx, page, errors } = await openPanel({ withDisk: false }));
  await row(page, 0).locator('.fav').click();
  await page.waitForFunction(() => /Favori kaydedilemedi/.test(document.querySelector('#notice').textContent));
  assert.match(await page.locator('#notice').textContent(), /Node\.js kapalı/);
  assert.equal(await page.locator('#rows .fav.on').count(), 0);
  await tab(page, 'favorites');
  assert.match(await page.locator('#listEnd').textContent(), /Node\.js kapalı/);
  assert.deepEqual(errors, []);
  await ctx.close();
  step('Node.js yokken: yıldız geri alındı, "Favori kaydedilemedi" uyarısı; panel çökmedi');

  await browser.close();
  await site.stop();
  console.log('\nAşama 3 uçtan uca testleri geçti. Ekran görüntüleri: ' + OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
