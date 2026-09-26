// Paneli ekranı olmayan (headless) Chromium'da açıp temel davranışları dener.
// Site yerine tests/fixtures içindeki örnek sayfalar kullanılır; Premiere olmadan çalışır.
// Çalıştırma: npm run test:ui   (ekran görüntüleri test-output/ klasörüne yazılır)
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test-output');
const fixture = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');

// 0.4 sn'lik sessiz WAV (önizleme için gerçek bir ses dosyası gerekiyor)
function silentWav(seconds = 0.4, rate = 8000) {
  const n = Math.floor(seconds * rate);
  const b = Buffer.alloc(44 + n);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write('data', 36);
  b.writeUInt32LE(n, 40);
  b.fill(128, 44);
  return b;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 340, height: 520 } });
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

  const wav = silentWav();
  await page.route('https://www.myinstants.com/media/**', (route) =>
    route.fulfill({ status: 200, contentType: 'audio/wav', body: wav })
  );

  await page.addInitScript(
    ({ list, cats }) => {
      window.__MI_FAIL = null;
      window.__MI_REQUESTS = [];
      window.__MI_TEST_TRANSPORT__ = async (url) => {
        window.__MI_REQUESTS.push(url);
        await new Promise((r) => setTimeout(r, 30));
        if (window.__MI_FAIL) {
          const e = new Error('test');
          e.kind = window.__MI_FAIL;
          throw e;
        }
        if (url.endsWith('/en/categories/')) return cats;
        if (/[?&]page=2/.test(url)) {
          return list
            .replace(/\/media\/sounds\//g, '/media/sounds/p2-')
            .replace(/\/en\/instant\//g, '/en/instant/p2-')
            .replace(/>([^<>]+)<\/a>/g, '>Sayfa2 $1</a>')
            .replace('Page 1 of 50', 'Page 2 of 2')
            .replace(/<div class="pagination">[\s\S]*?<\/div>/, '');
        }
        return list;
      };
    },
    { list: fixture('list-page.html'), cats: fixture('categories.html') }
  );

  await page.goto('file://' + path.join(ROOT, 'extension', 'index.html'));
  const rows = page.locator('#rows .row');
  await rows.first().waitFor();

  const step = (name) => console.log('✓ ' + name);
  const audioState = () =>
    page.evaluate(() => {
      const a = window.MyInstantsPanel.preview.audio;
      return { src: a.getAttribute('src'), paused: a.paused, volume: a.volume };
    });

  // 1) Açılış: Trending TR
  assert.equal(await rows.count(), 4);
  assert.match(await page.locator('#statusText').textContent(), /Trending · TR · 4 ses/);
  assert.equal(await page.locator('#region').getAttribute('class'), 'seg');
  assert.equal(await page.locator('#volumeLabel').textContent(), '%60');
  assert.equal((await page.evaluate(() => window.__MI_REQUESTS))[0], 'https://www.myinstants.com/en/trending/tr/');
  await page.screenshot({ path: path.join(OUT, '1-trending.png') });
  step('Trending TR listesi açıldı (4 ses, ses seviyesi %60)');

  // 2) Önizleme: 150 ms beklemeden çalmaz, bekleyince çalar, çıkınca durur
  const r0 = rows.nth(0);
  const r1 = rows.nth(1);
  await r0.hover();
  await page.waitForTimeout(60);
  assert.equal((await audioState()).src, null);
  await page.waitForTimeout(200);
  let a = await audioState();
  assert.equal(a.src, 'https://www.myinstants.com/media/sounds/vine-boom.mp3');
  assert.equal(a.volume, 0.6);
  await page.waitForFunction(() => document.querySelector('#rows .row.playing') !== null);
  await page.screenshot({ path: path.join(OUT, '2-preview.png') });
  await r1.hover();
  await page.waitForTimeout(250);
  a = await audioState();
  assert.equal(a.src, 'https://www.myinstants.com/media/sounds/telefonum-calcaksa.mp3');
  assert.equal(await page.locator('#rows .row.playing').count(), 1);
  await page.mouse.move(5, 5); // satırların dışına çık
  await page.waitForTimeout(50);
  a = await audioState();
  assert.equal(a.src, null);
  assert.equal(a.paused, true);
  assert.equal(await page.locator('#rows .row.playing').count(), 0);
  step('Önizleme: 150 ms gecikme, tek ses, fare çıkınca duruyor, ses %60');

  // 3) Ses seviyesi değişir ve hatırlanır
  await page.locator('#volume').fill('25');
  assert.equal(await page.locator('#volumeLabel').textContent(), '%25');
  assert.equal(await page.evaluate(() => localStorage.getItem('mi.volume')), '25');
  step('Ses seviyesi değişiyor ve hatırlanıyor');

  // 4) Daha fazla → 2. sayfa eklenir, sonra liste sonu
  await page.locator('.more-btn').click();
  await page.waitForFunction(() => document.querySelectorAll('#rows .row').length === 8);
  assert.match(await page.locator('#listEnd').textContent(), /Liste sonu/);
  step('"Daha fazla" 2. sayfayı ekledi, liste sonu gösterildi');

  // 5) Bölge: Global (US) → adres /us/, seçim hatırlanır
  await page.locator('#region button[data-region="us"]').click();
  await page.waitForFunction(() => /Global \(US\)/.test(document.querySelector('#statusText').textContent));
  assert.ok((await page.evaluate(() => window.__MI_REQUESTS)).includes('https://www.myinstants.com/en/trending/us/'));
  assert.equal(await page.evaluate(() => localStorage.getItem('mi.region')), 'us');
  step('Bölge Global (US) seçildi, adres /en/trending/us/');

  // 6) Just Added: bölge seçici pasif
  await page.locator('#tabs button[data-tab="recent"]').click();
  await page.waitForFunction(() => document.querySelector('#statusText').textContent.startsWith('Just Added'));
  assert.equal(await page.locator('#region').getAttribute('class'), 'seg disabled');
  await page.locator('#region button[data-region="tr"]').click({ force: true }); // pasifken tıklama bir şey yapmamalı
  assert.equal(await page.evaluate(() => localStorage.getItem('mi.region')), 'us');
  await page.screenshot({ path: path.join(OUT, '3-recent.png') });
  step('Just Added: bölge seçici pasif');

  // 7) Kategoriler: liste siteden okunur, seçilen kategori /us/ ile açılır
  await page.locator('#tabs button[data-tab="category"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#categorySelect option').length > 0);
  const opts = await page.locator('#categorySelect option').allTextContents();
  assert.deepEqual(opts.slice(0, 3), ['Memes', 'Anime & Manga', 'Games']);
  assert.equal(await page.locator('#categorySelect').inputValue(), 'memes');
  await page.locator('#categorySelect').selectOption('anime & manga');
  await page.waitForFunction(() => /Anime & Manga/.test(document.querySelector('#statusText').textContent));
  assert.ok(
    (await page.evaluate(() => window.__MI_REQUESTS)).includes(
      'https://www.myinstants.com/en/categories/anime%20%26%20manga/us/'
    )
  );
  await page.screenshot({ path: path.join(OUT, '4-category.png') });
  step('Kategoriler: liste okundu, "Anime & Manga" /us/ ile açıldı');

  // 8) Arama: Enter ile
  await page.locator('#searchInput').fill('vine boom');
  await page.locator('#searchInput').press('Enter');
  await page.waitForFunction(() => !document.querySelector('#searchBar').hidden);
  await page.waitForFunction(() => document.querySelectorAll('#rows .row').length === 4);
  assert.ok(
    (await page.evaluate(() => window.__MI_REQUESTS)).includes('https://www.myinstants.com/en/search/?name=vine%20boom')
  );
  assert.equal(await page.locator('#region').getAttribute('class'), 'seg disabled');
  await page.screenshot({ path: path.join(OUT, '5-search.png') });
  await page.locator('#searchExit').click();
  await page.waitForFunction(() => document.querySelector('#statusText').textContent.startsWith('Kategoriler'));
  step('Arama Enter ile çalıştı, aramadan çıkınca önceki sekmeye dönüldü');

  // 9) Hata mesajları (Türkçe)
  const expectError = async (kind, re, shot) => {
    await page.evaluate((k) => (window.__MI_FAIL = k), kind);
    await page.locator('#refreshBtn').click();
    await page.waitForFunction(() => document.querySelector('#listEnd .msg.error') !== null);
    assert.match(await page.locator('#listEnd').textContent(), re);
    if (shot) await page.screenshot({ path: path.join(OUT, shot) });
  };
  await page.locator('#tabs button[data-tab="trending"]').click();
  await expectError('offline', /İnternet bağlantısı yok/, '6-offline.png');
  await expectError('server', /şu an cevap vermiyor/);
  await expectError('timeout', /zaman aşımı/);
  await expectError('blocked', /güvenlik kontrolü/);
  await expectError('parse', /yapısı değişmiş olabilir/);
  await page.evaluate(() => (window.__MI_FAIL = null));
  await page.locator('#listEnd .retry').click();
  await page.waitForFunction(() => document.querySelectorAll('#rows .row').length === 4);
  step('Hata mesajları Türkçe; "Tekrar dene" çalışıyor');

  // 10) Ayarlar yeniden açılışta hatırlanıyor
  await page.reload();
  await rows.first().waitFor();
  assert.equal(await page.locator('#volumeLabel').textContent(), '%25');
  assert.equal(await page.locator('#region button.active').textContent(), 'Global (US)');
  assert.equal(await page.locator('#tabs button.active').textContent(), 'Trending');
  step('Yeniden açılınca bölge, ses seviyesi ve sekme hatırlandı');

  const errors = logs.filter((l) => l.startsWith('[pageerror]'));
  assert.deepEqual(errors, []);
  await browser.close();
  console.log('\nTüm arayüz testleri geçti. Ekran görüntüleri: ' + OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
