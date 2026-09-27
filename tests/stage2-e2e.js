// Aşama 2 uçtan uca testi: İndir → diske yaz → Premiere'e import → timeline'a koy.
// Panel headless Chromium'da manifest ayarlarıyla açılır. Sahteler:
//   - www.myinstants.com → tests/fake-site.js (HTTPS, Cloudflare benzeri)
//   - Premiere → tests/fake-premiere.js (host.jsx'in GERÇEK kodu Node vm'de çalışır; CEP köprüsü taklit edilir)
//   - Disk → bellekte Windows yollu sahte dosya sistemi (panelin require('fs') çağrıları buraya gider)
// Çalıştırma: npm run test:stage2
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFakeSite } = require('./fake-site');
const { createPremiere } = require('./fake-premiere');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test-output');
const PANEL = 'file://' + path.join(ROOT, 'extension', 'index.html');
const step = (name) => console.log('✓ ' + name);

function manifestArgs() {
  const xml = fs.readFileSync(path.join(ROOT, 'extension', 'CSXS', 'manifest.xml'), 'utf8');
  return [...xml.matchAll(/<Parameter>([^<]+)<\/Parameter>/g)].map((m) => m[1].trim());
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const site = await startFakeSite({ certDir: path.join(OUT, 'cert') });

  // Bellekte sahte disk
  const disk = new Map(); // küçük harfli yol → { name, data: Buffer }
  const diskCtl = { failWrite: null };
  const key = (p) => p.toLowerCase();
  const diskFiles = () => [...disk.values()].map((f) => f.name).sort();

  let premiere = createPremiere({ onDisk: (p) => disk.has(key(p)) });
  premiere.addClip(0, 0, 5, 'Röportaj'); // A1: 0–5 sn; playhead 10 sn

  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_proxy$/i.test(k)));
  const browser = await chromium.launch({
    headless: true,
    env,
    args: [...manifestArgs(), `--host-resolver-rules=MAP www.myinstants.com 127.0.0.1:${site.port}`, '--no-proxy-server'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 340, height: 560 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // CEP köprüsü: evalScript → sahte Premiere
  await page.exposeFunction('__miHost', (script) => premiere.call(script));
  // Node fs → sahte disk
  await page.exposeFunction('__miFs', (op, p, b64, p2) => {
    const err = (code) => ({ error: code });
    switch (op) {
      case 'stat':
        return disk.has(key(p)) ? { size: disk.get(key(p)).data.length } : err('ENOENT');
      case 'mkdir':
        return {};
      case 'writeFile':
        if (diskCtl.failWrite) return err(diskCtl.failWrite);
        disk.set(key(p), { name: p, data: Buffer.from(b64, 'base64') });
        return {};
      case 'rename': {
        const f = disk.get(key(p));
        if (!f) return err('ENOENT');
        disk.delete(key(p));
        disk.set(key(p2), { name: p2, data: f.data });
        return {};
      }
      case 'unlink':
        disk.delete(key(p));
        return {};
      case 'readFile':
        return disk.has(key(p)) ? { b64: disk.get(key(p)).data.toString('base64') } : err('ENOENT');
    }
    return err('EINVAL');
  });
  await page.addInitScript(() => {
    window.__adobe_cep__ = {
      getHostEnvironment: () =>
        JSON.stringify({ appSkinInfo: { panelBackgroundColor: { color: { red: 35, green: 35, blue: 35, alpha: 255 } } } }),
      evalScript: (script, cb) => window.__miHost(script).then(cb, () => cb('EvalScript error.')),
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {},
    };
    const toB64 = (u8) => {
      let s = '';
      for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
      return btoa(s);
    };
    const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const call = async (...args) => {
      const r = await window.__miFs(...args);
      if (r && r.error) throw Object.assign(new Error(r.error), { code: r.error });
      return r;
    };
    const promises = {
      stat: async (p) => {
        const r = await call('stat', p);
        return { isFile: () => true, size: r.size };
      },
      mkdir: (p) => call('mkdir', p),
      writeFile: (p, bytes) => call('writeFile', p, toB64(bytes)),
      rename: (a, b) => call('rename', a, null, b),
      unlink: (p) => call('unlink', p),
      readFile: async (p) => {
        const u8 = fromB64((await call('readFile', p)).b64);
        return u8; // Buffer benzeri: buffer / byteOffset / byteLength
      },
    };
    window.require = (name) => (name === 'fs' ? { promises } : undefined);
  });

  await page.goto(PANEL);
  const rows = page.locator('#rows .row');
  await rows.first().waitFor();
  await page.waitForFunction(() => /Premiere 26\.5\.1$/.test(document.querySelector('#hostText').textContent));
  const dl = (i) => rows.nth(i).locator('button.dl');
  // Tuşun durumu: meşgul → "…", bitti → "✓ A1", boşta → "İndir" (ikonlar sınıfla gösteriliyor)
  const waitDl = (i, re) =>
    page.waitForFunction(
      ([i, src]) => {
        const b = document.querySelectorAll('#rows .row button.dl')[i];
        const label = b.classList.contains('busy') ? '…' : (b.classList.contains('done') ? '✓ ' : '') + b.textContent.trim();
        return new RegExp(src).test(label);
      },
      [i, re.source]
    );
  const mp3Requests = () => site.state.requests.filter((q) => q.path.startsWith('/media/sounds/') && q.secFetchDest !== 'audio').length;
  const notice = () => page.locator('#notice');
  const unit = () => page.evaluate(() => localStorage.getItem('mi.timeUnit.26.5.1'));
  step('Panel sahte Premiere\'e bağlandı (Premiere 26.5.1 ✓)');

  /* 1) İlk indirme: "…" → "✓ A1", dosya proje yanına, bin + import + A1 */
  site.state.mode = 'slow';
  await dl(0).click();
  await waitDl(0, /^…$/);
  await dl(0).click(); // meşgulken ikinci tıklama yok sayılır
  site.state.mode = 'open';
  await waitDl(0, /^✓ A1$/);
  const file0 = 'C:\\Projeler\\Test\\MyInstants\\[TR] Vine Boom Sound.mp3';
  assert.deepEqual(diskFiles(), ['C:\\Projeler\\Test\\MyInstants\\.myinstants.json', file0]);
  assert.equal(disk.get(key(file0)).data.slice(0, 4).toString(), 'RIFF');
  assert.deepEqual(premiere.bins(), [['MyInstants', ['[TR] Vine Boom Sound.mp3']]]);
  assert.deepEqual(premiere.clips(0), [[0, 5, 'Röportaj'], [10, 11.5, '[TR] Vine Boom Sound.mp3']]);
  assert.deepEqual(premiere.log, ['createBin', 'importFiles', 'overwriteClip']);
  assert.equal(mp3Requests(), 1);
  assert.equal(await unit(), 'ticks');
  await page.screenshot({ path: path.join(OUT, 's2-1-done.png') });
  await waitDl(0, /İndir/); // ✓ kısa süre sonra geri döner
  step('İlk İndir: "…" → "✓ A1"; dosya proje yanındaki MyInstants\'a, bin oluştu, import, A1 @10 sn; birim = tick');

  /* 2) Aynı ses tekrar: indirme yok, import yok, A1 dolu → A2 */
  premiere.log.length = 0;
  await dl(0).click();
  await waitDl(0, /^✓ A2$/);
  assert.equal(mp3Requests(), 1);
  assert.deepEqual(premiere.log, ['overwriteClip']);
  step('Aynı ses tekrar: yeniden indirme ve import yok, A1 dolu olduğu için A2 (1 geri alma adımı)');

  /* 3) Art arda iki tıklama: sıralı yerleştirme, gerekirse yeni track */
  await dl(1).click();
  await dl(2).click();
  await waitDl(1, /^✓ A3$/);
  await waitDl(2, /^✓ A4$/);
  assert.ok(premiere.log.includes('addTracks'));
  assert.equal(premiere.seq.audioTracks.length, 4);
  assert.deepEqual(premiere.clips(0)[0], [0, 5, 'Röportaj']);
  step('Art arda iki tıklama sırayla yerleşti: A3, sonra boş track kalmayınca yeni A4 eklendi');

  /* 4) Aktif sequence yok → uyarı, hiçbir şey indirilmez */
  const savedSeq = premiere.project.activeSequence;
  premiere.project.activeSequence = null;
  const before = mp3Requests();
  await dl(3).click();
  await page.waitForFunction(() => /Açık bir sequence yok/.test(document.querySelector('#notice').textContent));
  assert.equal(mp3Requests(), before);
  await page.screenshot({ path: path.join(OUT, 's2-2-nosequence.png') });
  premiere.project.activeSequence = savedSeq;
  step('Aktif sequence yokken: "Açık bir sequence yok" uyarısı, hiçbir şey indirilmedi');

  /* 5) İndirme sırasında site doğrulama isterse: Doğrula → pencere kapanınca indirme tekrarlanır */
  site.state.mode = 'challenge';
  site.state.tokens.clear();
  await notice().locator('button', { hasText: 'Tekrar dene' }).click();
  await page.waitForFunction(() => /İndirmek için site doğrulama istiyor/.test(document.querySelector('#notice').textContent));
  const popupP = ctx.waitForEvent('page');
  await notice().locator('button.primary').click();
  const popup = await popupP;
  await popup.locator('#cf-verify').click();
  await popup.waitForLoadState();
  await popup.close();
  await waitDl(3, /^✓ A\d$/);
  assert.equal(await notice().isHidden(), true);
  site.state.mode = 'open';
  step('İndirmede doğrulama: Doğrula → pencere kapanınca indirme kendiliğinden tekrarlandı ve yerleşti');

  // Yeni sesler için 2. sayfa
  await page.locator('.more-btn').click();
  await page.waitForFunction(() => document.querySelectorAll('#rows .row').length === 8);

  /* 6) Premiere metni saniye sayıyorsa: tick denemesi uzağa düşer → kendi klibi silinir → saniye tutar */
  await page.evaluate(() => localStorage.removeItem('mi.timeUnit.26.5.1'));
  premiere = resetPremiere({ timeMode: 'seconds' });
  premiere.addClip(0, 0, 5, 'Röportaj');
  await dl(4).click();
  await waitDl(4, /^✓ A1$/);
  assert.equal(await unit(), 'seconds');
  assert.ok(premiere.log.includes('remove(false,false)'));
  assert.deepEqual(premiere.clips(0).map((c) => c[0]), [0, 10]);
  premiere.log.length = 0;
  await dl(5).click();
  await waitDl(5, /^✓ A2$/);
  assert.equal(premiere.log.filter((x) => x === 'overwriteClip').length, 1); // kayıtlı birim: deneme yok
  step('Zaman birimi saniye çıktı: yanlış yere düşen kendi klibi silindi (Ctrl+Z gerekmedi), birim saklandı, sonra deneme yapılmadı');

  /* 7) Mevcut klip değişirse: Ctrl+Z uyarısı, "Tekrar dene" yok */
  premiere = resetPremiere({ timeMode: 'ticks' }); // kayıtlı birim "saniye" artık yanlış → ~0. saniyeye yazar
  premiere.addClip(0, 0, 5, 'Röportaj');
  await dl(6).click();
  await page.waitForFunction(() => /Ctrl\+Z/.test(document.querySelector('#notice').textContent));
  assert.equal(await notice().locator('button', { hasText: 'Tekrar dene' }).count(), 0);
  await page.screenshot({ path: path.join(OUT, 's2-3-damaged.png') });
  await notice().locator('button', { hasText: 'Kapat' }).click();
  assert.equal(await unit(), ''); // saklı birim silindi: bir dahaki sefer yine önce tick
  step('Mevcut klip değiştiğinde: "DİKKAT … Ctrl+Z ile geri alın" uyarısı (tekrar dene yok), saklı birim silindi');

  /* 8) Diske yazılamazsa */
  await page.evaluate(() => localStorage.removeItem('mi.timeUnit.26.5.1'));
  premiere = resetPremiere({});
  diskCtl.failWrite = 'EACCES';
  await dl(7).click();
  await page.waitForFunction(() => /yazma izni yok/.test(document.querySelector('#notice').textContent));
  diskCtl.failWrite = null;
  assert.ok(!diskFiles().some((f) => /\.part-/.test(f)));
  step('Yazma izni yoksa Türkçe uyarı; yarım dosya kalmadı');

  /* 9) Proje kaydedilmemişse Belgeler\MyInstants */
  premiere = resetPremiere({ projectPath: '', savedFiles: [] });
  await notice().locator('button', { hasText: 'Tekrar dene' }).click();
  await waitDl(7, /^✓ A1$/);
  assert.ok(diskFiles().some((f) => f.startsWith('C:\\Users\\Test\\Documents\\MyInstants\\')));
  step('Kaydedilmemiş projede dosya Belgeler\\MyInstants\'a yazıldı');

  /* 10) Teşhis */
  await page.locator('#hostText').click();
  await page.waitForFunction(() => /Teşhis/.test(document.querySelector('#notice').textContent));
  const diag = await notice().locator('pre').textContent();
  assert.match(diag, /Premiere: 26\.5\.1/);
  assert.match(diag, /Kilit bilgisi \(DOM isLocked\): var/);
  assert.match(diag, /Track ekleme \(QE addTracks\): var/);
  assert.match(diag, /Zaman birimi \(bu sürüm\): tick/);
  await page.screenshot({ path: path.join(OUT, 's2-4-diag.png') });
  step('Teşhis: sürüm, kilit/track ekleme yolları ve saklanan zaman birimi raporlandı');

  assert.deepEqual(errors, []);
  await browser.close();
  await site.stop();
  console.log('\nAşama 2 uçtan uca testleri geçti. Ekran görüntüleri: ' + OUT);

  function resetPremiere(opts) {
    const p = createPremiere(Object.assign({ onDisk: (x) => disk.has(key(x)) }, opts));
    return p;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
