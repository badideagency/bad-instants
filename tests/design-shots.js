// Tasarım denetimi: panelin bütün durumlarının ekran görüntüleri + otomatik kontroller.
//  - Farklı Premiere panel renkleri (en koyu, varsayılan, orta gri, açık) → tema buna uyuyor mu
//  - Geist yazı tipi yerel dosyadan yüklendi mi, Türkçe harfler (ç ğ ı ö ş ü İ) Geist ile mi çiziliyor
//  - Metin kontrastı (WCAG) gerçek hesaplanmış renklerle
// Çıktı: test-output/design/*.png
// Çalıştırma: npm run test:design
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFakeSite } = require('./fake-site');
const { createPremiere } = require('./fake-premiere');
const Theme = require('../extension/js/theme.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test-output', 'design');
const PANEL = 'file://' + path.join(ROOT, 'extension', 'index.html');
const step = (name) => console.log('✓ ' + name);

function manifestArgs() {
  const xml = fs.readFileSync(path.join(ROOT, 'extension', 'CSXS', 'manifest.xml'), 'utf8');
  return [...xml.matchAll(/<Parameter>([^<]+)<\/Parameter>/g)].map((m) => m[1].trim());
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const site = await startFakeSite({ certDir: path.join(ROOT, 'test-output', 'cert') });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_proxy$/i.test(k)));
  const browser = await chromium.launch({
    headless: true,
    env,
    args: [...manifestArgs(), `--host-resolver-rules=MAP www.myinstants.com 127.0.0.1:${site.port}`, '--no-proxy-server'],
  });

  async function openPanel(bg, width = 340, height = 520) {
    const premiere = createPremiere();
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.exposeFunction('__miHost', (script) => premiere.call(script));
    await page.addInitScript((bg) => {
      window.__adobe_cep__ = {
        getHostEnvironment: () =>
          JSON.stringify({ appSkinInfo: { panelBackgroundColor: { color: { red: bg[0], green: bg[1], blue: bg[2] } } } }),
        getSystemPath: () => '',
        evalScript: (script, cb) => window.__miHost(script).then(cb, () => cb('EvalScript error.')),
        invokeSync: () => '',
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {},
      };
    }, bg);
    await page.goto(PANEL);
    await page.locator('#rows .row').first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    return { page, ctx, errors, premiere };
  }
  const settle = (page) => page.waitForTimeout(260); // açılma animasyonu (180 ms) bitsin
  const shot = async (page, name) => {
    await settle(page);
    await page.screenshot({ path: path.join(OUT, name + '.png') });
  };

  /* 1) Varsayılan koyu (#232323): liste, önizleme, İndir durumları, sekmeler */
  let { page, ctx, errors } = await openPanel([35, 35, 35]);
  const font = await page.evaluate(() => ({
    loaded: [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Geist' && f.status === 'loaded'),
    turkce: document.fonts.check('12px Geist', 'çğıöşüİÇĞÖŞÜ'),
    family: getComputedStyle(document.body).fontFamily,
    bg: getComputedStyle(document.body).backgroundColor,
    metin: getComputedStyle(document.body).color,
  }));
  assert.ok(font.loaded, 'Geist yüklenmedi');
  assert.ok(font.turkce, 'Türkçe harfler Geist ile çizilemiyor');
  assert.match(font.family, /^Geist/);
  assert.equal(font.bg, 'rgb(35, 35, 35)'); // zemin = Premiere'in rengi
  assert.equal(font.metin, 'rgb(255, 247, 233)'); // krem
  step('Geist yerel dosyadan yüklendi; Türkçe harfler Geist ile; zemin Premiere rengi, yazı krem');

  await page.locator('#rows .row').nth(1).hover();
  await page.waitForFunction(() => {
    const r = document.querySelector('#rows .row.playing');
    return r && !r.classList.contains('buffering');
  });
  await page.evaluate(() => {
    const b = document.querySelectorAll('#rows .dl');
    window.MyInstantsPanel.setDl(b[0], 'done', 'A1');
    window.MyInstantsPanel.setDl(b[2], 'busy');
  });
  await shot(page, '01-liste-onizleme-indir');
  // Klavye odağı görünür mü
  await page.mouse.move(5, 5);
  await page.locator('#searchInput').focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await shot(page, '02-odak-halkasi');
  await page.locator('#tabs button[data-tab="category"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#categorySelect option').length > 0);
  await page.waitForFunction(() => document.querySelectorAll('#rows .row').length > 0);
  await shot(page, '03-kategoriler');
  await page.locator('#searchInput').fill('çılgın şöför ğüı');
  await page.locator('#searchInput').press('Enter');
  await page.waitForFunction(() => !document.querySelector('#searchBar').hidden && document.querySelectorAll('#rows .row').length > 0);
  await shot(page, '04-arama');
  step('Liste / önizleme / İndir durumları / odak / kategoriler / arama çekildi');

  /* 2) Mesaj kutuları */
  await page.locator('#searchExit').click();
  site.state.mode = 'challenge';
  await page.locator('#refreshBtn').click();
  await page.waitForFunction(() => document.querySelector('#listEnd .challenge'));
  await shot(page, '05-dogrulama');
  site.state.mode = 'open';
  await ctx.setOffline(true);
  await page.locator('#refreshBtn').click();
  await page.waitForFunction(() => /İnternet bağlantısı yok/.test(document.querySelector('#listEnd').textContent));
  await shot(page, '06-hata-cevrimdisi');
  await ctx.setOffline(false);
  await page.locator('#listEnd .retry').click();
  await page.waitForFunction(() => document.querySelectorAll('#rows .row').length > 0);
  await page.evaluate(() => {
    const P = window.MyInstantsPanel;
    P.update.latest = {
      version: '0.4.0',
      notes: '## MyInstants v0.4.0\n\n- **Yeni tasarım:** BadIdea ailesi, Geist yazı tipi\n- Türkçe karakterler: ç ğ ı ö ş ü İ',
    };
    P.renderUpdateChip();
    P.showUpdateOffer();
  });
  await shot(page, '07-guncelleme-teklifi');
  const offer = await page.locator('#notice').innerText();
  assert.ok(!/şu an v\)/.test(offer), 'sürüm bilinmeden "(şu an v)" yazıyor');
  assert.ok(!/^MyInstants v0\.4\.0$/m.test(offer.split('\n').slice(1).join('\n')), 'not başlığı tekrar ediyor');
  await page.locator('#hostText').click();
  await page.waitForFunction(() => /Teşhis/.test(document.querySelector('#notice').textContent));
  await shot(page, '08-teshis');
  assert.deepEqual(errors, []);
  await ctx.close();
  step('Doğrulama, hata, güncelleme teklifi ve teşhis kutuları çekildi');

  /* 3) Premiere'in farklı parlaklıkları + dar panel */
  const variants = [
    ['09-premiere-en-koyu', [29, 29, 29]],
    ['10-premiere-orta-gri', [83, 83, 83]],
    ['11-premiere-acik', [214, 214, 214]],
  ];
  for (const [name, bg] of variants) {
    ({ page, ctx } = await openPanel(bg));
    const got = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(got, `rgb(${bg.join(', ')})`);
    const t = Theme.build(bg);
    for (const [k, c] of Object.entries(t.measured)) assert.ok(c >= 4.5, `${name}: ${k} kontrastı ${c.toFixed(2)}`);
    await page.locator('#rows .row').nth(0).hover();
    await shot(page, name);
    await ctx.close();
  }
  step('Premiere en koyu / orta gri / açık: zemin uyuyor, metin ve durum renkleri ≥ 4.5:1');

  ({ page, ctx } = await openPanel([35, 35, 35], 240, 420));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(overflow, false, '240 px\'te yatay taşma var');
  const clipped = await page.evaluate(() =>
    [...document.querySelectorAll('#tabs button')].filter((b) => b.scrollWidth > b.clientWidth).map((b) => b.textContent)
  );
  assert.deepEqual(clipped, [], 'dar panelde kesilen sekme var');
  await shot(page, '12-dar-240px');
  await ctx.close();
  step('240 px dar panel: yatay taşma yok, sekme adları kesilmiyor (gerekirse yatay kayıyor)');

  await browser.close();
  await site.stop();
  console.log('\nTasarım denetimi geçti. Ekran görüntüleri: ' + OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
