// Panel içi güncelleme uçtan uca testi (headless Chromium, manifest ayarlarıyla).
// Sahteler: GitHub (api.github.com, github.com, objects.githubusercontent.com → yerel HTTPS sunucu),
// CEP köprüsü (getSystemPath, evalScript, panel menüsü), Node fs (gerçek geçici klasöre köprü).
// Kurulu panel: geçici bir "extensions/com.badidea.myinstants" klasörü (kopya kurulum).
// Çalıştırma: npm run test:update
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFakeSite } = require('./fake-site');
const { createPremiere } = require('./fake-premiere');
const { build } = require('../tools/build-release.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test-output');
const PANEL = 'file://' + path.join(ROOT, 'extension', 'index.html');
const step = (name) => console.log('✓ ' + name);

function manifestArgs() {
  const xml = fs.readFileSync(path.join(ROOT, 'extension', 'CSXS', 'manifest.xml'), 'utf8');
  return [...xml.matchAll(/<Parameter>([^<]+)<\/Parameter>/g)].map((m) => m[1].trim());
}

function makeExt(dir, version, tweak) {
  fs.cpSync(path.join(ROOT, 'extension'), dir, { recursive: true });
  const mf = path.join(dir, 'CSXS', 'manifest.xml');
  fs.writeFileSync(
    mf,
    fs.readFileSync(mf, 'utf8')
      .replace(/ExtensionBundleVersion="[^"]+"/, `ExtensionBundleVersion="${version}"`)
      .replace(/(<Extension Id="com\.badidea\.myinstants\.panel" Version=")[^"]+/, `$1${version}`)
  );
  if (tweak) tweak(dir);
  return dir;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const site = await startFakeSite({ certDir: path.join(OUT, 'cert') }); // liste için + sertifika
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-upd-e2e-'));
  const extDir = makeExt(path.join(work, 'extensions', 'com.badidea.myinstants'), '0.3.0');
  const appData = path.join(work, 'AppData');
  const version = async () => /ExtensionBundleVersion="([^"]+)"/.exec(await fsp.readFile(path.join(extDir, 'CSXS', 'manifest.xml'), 'utf8'))[1];

  // Yayınlanacak sürümler
  const pkg = (v, tweak) => build('v' + v, { extDir: makeExt(path.join(work, 'src-' + v), v, tweak), outDir: path.join(work, 'dist-' + v) });
  const releases = {
    '0.3.1': pkg('0.3.1', (d) => fs.writeFileSync(path.join(d, 'yeni.txt'), 'v0.3.1 ile geldi')),
    '0.3.2': pkg('0.3.2', (d) => {
      const mf = path.join(d, 'CSXS', 'manifest.xml');
      fs.writeFileSync(mf, fs.readFileSync(mf, 'utf8').replace('<Parameter>--mixed-context</Parameter>', '<Parameter>--mixed-context</Parameter>\n                        <Parameter>--yeni-ayar</Parameter>'));
    }),
    '0.3.3': pkg('0.3.3'),
  };
  const gh = { version: '0.3.1', badSha: false, requests: [] };

  // Sahte GitHub
  const tls = { key: fs.readFileSync(path.join(OUT, 'cert', 'key.pem')), cert: fs.readFileSync(path.join(OUT, 'cert', 'cert.pem')) };
  const ghServer = https.createServer(tls, (req, res) => {
    const u = new URL(req.url, 'https://' + req.headers.host);
    gh.requests.push(req.headers.host + u.pathname);
    const r = releases[gh.version];
    const tag = 'v' + gh.version;
    if (u.pathname === '/repos/badideagency/bad-instants/releases/latest') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          tag_name: tag,
          name: 'MyInstants ' + tag,
          body: `## MyInstants ${tag}\n\n- **Panel içi güncelleme** eklendi\n- Küçük düzeltmeler (ç ğ ı ö ş ü)`,
          html_url: 'https://github.com/badideagency/bad-instants/releases/tag/' + tag,
          published_at: '2026-09-27T10:00:00Z',
          assets: [
            { name: r.info.zip, size: r.info.size, browser_download_url: `https://github.com/badideagency/bad-instants/releases/download/${tag}/${r.info.zip}` },
            { name: 'release.json', size: 250, browser_download_url: `https://github.com/badideagency/bad-instants/releases/download/${tag}/release.json` },
          ],
        })
      );
    }
    let m = /^\/badideagency\/bad-instants\/releases\/download\/(v[\d.]+)\/(.+)$/.exec(u.pathname);
    if (m) {
      res.writeHead(302, { Location: `https://objects.githubusercontent.com/assets/${m[1]}/${m[2]}` });
      return res.end();
    }
    m = /^\/assets\/v([\d.]+)\/(.+)$/.exec(u.pathname);
    if (m && releases[m[1]]) {
      const rr = releases[m[1]];
      if (m[2] === 'release.json') {
        const info = Object.assign({}, rr.info, gh.badSha ? { sha256: 'ab'.repeat(32) } : {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(info));
      }
      const bytes = fs.readFileSync(rr.zipPath);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': bytes.length });
      return res.end(bytes);
    }
    res.writeHead(404);
    res.end('yok');
  });
  await new Promise((r) => ghServer.listen(0, '127.0.0.1', r));
  const ghPort = ghServer.address().port;

  // Sahte Premiere + $.evalFile
  const premiere = createPremiere();
  const evalFiles = [];
  premiere.context.$ = { evalFile: (f) => evalFiles.push(f.fsName) };

  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_proxy$/i.test(k)));
  const map = [
    `MAP www.myinstants.com 127.0.0.1:${site.port}`,
    `MAP api.github.com 127.0.0.1:${ghPort}`,
    `MAP github.com 127.0.0.1:${ghPort}`,
    `MAP objects.githubusercontent.com 127.0.0.1:${ghPort}`,
  ].join(',');
  const browser = await chromium.launch({ headless: true, env, args: [...manifestArgs(), `--host-resolver-rules=${map}`, '--no-proxy-server'] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 340, height: 560 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.exposeFunction('__miHost', (script) => premiere.call(script));
  await page.exposeFunction('__nodeFs', async (method, args) => {
    try {
      switch (method) {
        case 'readFile':
          return { b64: (await fsp.readFile(args[0])).toString('base64') };
        case 'writeFile':
          await fsp.writeFile(args[0], Buffer.from(args[1], 'base64'));
          return {};
        case 'readdir':
          return { list: (await fsp.readdir(args[0], { withFileTypes: true })).map((d) => ({ name: d.name, dir: d.isDirectory() })) };
        case 'stat': {
          const s = await fsp.stat(args[0]);
          return { size: s.size, file: s.isFile(), dir: s.isDirectory() };
        }
        case 'realpath':
          return { value: await fsp.realpath(args[0]) };
        default:
          await fsp[method](...args);
          return {};
      }
    } catch (e) {
      return { error: e.code || 'EIO', message: e.message };
    }
  });
  await page.addInitScript(
    ({ extDir, appData }) => {
      window.__cepListeners = {};
      window.__adobe_cep__ = {
        getHostEnvironment: () => JSON.stringify({ appSkinInfo: { panelBackgroundColor: { color: { red: 35, green: 35, blue: 35 } } } }),
        getSystemPath: (type) => (type === 'extension' ? extDir : ''),
        evalScript: (script, cb) => window.__miHost(script).then(cb, () => cb('EvalScript error.')),
        invokeSync: (name, arg) => {
          if (name === 'setPanelFlyoutMenu') window.__flyoutXml = arg;
          return '';
        },
        addEventListener: (type, fn) => (window.__cepListeners[type] = window.__cepListeners[type] || []).push(fn),
        removeEventListener() {},
        dispatchEvent() {},
      };
      window.process = { env: { APPDATA: appData } };
      const b64 = (u8) => {
        let s = '';
        for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
        return btoa(s);
      };
      const call = async (method, ...args) => {
        const r = await window.__nodeFs(method, args);
        if (r.error) throw Object.assign(new Error(r.message), { code: r.error });
        return r;
      };
      const promises = {
        readFile: async (p) => Uint8Array.from(atob((await call('readFile', p)).b64), (c) => c.charCodeAt(0)),
        writeFile: (p, data) => call('writeFile', p, b64(data instanceof Uint8Array ? data : new Uint8Array(data))),
        readdir: async (p) => (await call('readdir', p)).list.map((d) => ({ name: d.name, isDirectory: () => d.dir })),
        stat: async (p) => {
          const s = await call('stat', p);
          return { size: s.size, isFile: () => s.file, isDirectory: () => s.dir };
        },
        realpath: async (p) => (await call('realpath', p)).value,
        mkdir: (p, o) => call('mkdir', p, o),
        rename: (a, b) => call('rename', a, b),
        unlink: (p) => call('unlink', p),
        rm: (p, o) => call('rm', p, o),
      };
      window.require = (name) => (name === 'fs' ? { promises } : undefined);
    },
    { extDir, appData }
  );

  const notice = page.locator('#notice');
  const chip = page.locator('#updateChip');
  const flyout = (menuId, asString) =>
    page.evaluate(
      ([id, asStr]) => {
        const data = { menuId: id, menuName: id };
        (window.__cepListeners['com.adobe.csxs.events.flyoutMenuClicked'] || []).forEach((fn) =>
          fn({ type: 'com.adobe.csxs.events.flyoutMenuClicked', data: asStr ? JSON.stringify(data) : data })
        );
      },
      [menuId, asString]
    );

  /* 1) Açılışta denetim → alt çubukta "v0.3.1 hazır — Güncelle" */
  await page.goto(PANEL);
  await chip.waitFor({ state: 'visible', timeout: 15000 });
  assert.equal(await chip.textContent(), 'v0.3.1 hazır — Güncelle');
  assert.ok(gh.requests.includes('api.github.com/repos/badideagency/bad-instants/releases/latest'));
  const xml = await page.evaluate(() => window.__flyoutXml);
  for (const label of ['Paneli yeniden yükle', 'Güncellemeleri denetle', 'Önceki sürüme dön', 'Teşhis']) assert.ok(xml.includes(label), label);
  assert.ok(await page.locator('#refreshBtn').isVisible()); // ↻ yerinde
  await page.screenshot({ path: path.join(OUT, 'u-1-chip.png') });
  step('Açılışta denetim: alt çubukta "v0.3.1 hazır — Güncelle"; panel menüsünde 4 madde; ↻ yerinde');

  /* 2) Güncelle → indir, doğrula, yedekle, kur → manifest aynı → host.jsx + panel yenilenir */
  await chip.click();
  await page.waitForFunction(() => /MyInstants v0\.3\.1 hazır \(şu an v0\.3\.0\)/.test(document.querySelector('#notice').textContent));
  assert.match(await notice.locator('.notes').innerText(), /• Panel içi güncelleme eklendi\n• Küçük düzeltmeler \(ç ğ ı ö ş ü\)/);
  await page.screenshot({ path: path.join(OUT, 'u-2-offer.png') });
  const reload1 = page.waitForEvent('load', { timeout: 30000 });
  await notice.locator('button', { hasText: 'Güncelle' }).click();
  await reload1;
  assert.equal(await version(), '0.3.1');
  assert.equal(await fsp.readFile(path.join(extDir, 'yeni.txt'), 'utf8'), 'v0.3.1 ile geldi');
  assert.deepEqual(evalFiles, [extDir + '/jsx/host.jsx']);
  assert.ok(fs.existsSync(path.join(appData, 'BadIdea', 'MyInstants', 'backup', '0.3.0', 'backup.json')));
  assert.ok(gh.requests.some((r) => r.startsWith('objects.githubusercontent.com/assets/v0.3.1/')));
  await page.waitForTimeout(4000); // yeniden açılışta denetim: artık güncel
  assert.equal(await chip.isHidden(), true);
  step('Güncelle: indirildi, özet doğrulandı, yedeklendi, kuruldu; manifest aynı → $.evalFile(host.jsx) + panel yenilendi');

  /* 3) Panel menüsü → Önceki sürüme dön */
  await flyout('rollback');
  await page.waitForFunction(() => /Dönülecek sürüm: v0\.3\.0/.test(document.querySelector('#notice').textContent));
  const reload2 = page.waitForEvent('load', { timeout: 30000 });
  await notice.locator('button', { hasText: 'v0.3.0 sürümüne dön' }).click();
  await reload2;
  assert.equal(await version(), '0.3.0');
  assert.ok(!fs.existsSync(path.join(extDir, 'yeni.txt')));
  step('Menü → Önceki sürüme dön: v0.3.0 geri geldi (v0.3.1\'de eklenen dosya kaldırıldı)');

  /* 4) manifest ayarı değişen sürüm → "Premiere'i yeniden başlatın", yenileme yok */
  gh.version = '0.3.2';
  await chip.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  await flyout('checkUpdates', true); // olay verisi metin olarak da gelebilir
  await page.waitForFunction(() => /v0\.3\.2 hazır/.test(document.querySelector('#notice').textContent));
  const evalBefore = evalFiles.length;
  await notice.locator('button', { hasText: 'Güncelle' }).click();
  await page.waitForFunction(() => /Premiere’i yeniden başlatın/.test(document.querySelector('#notice').textContent), null, { timeout: 30000 });
  assert.equal(await version(), '0.3.2');
  assert.equal(evalFiles.length, evalBefore);
  await page.screenshot({ path: path.join(OUT, 'u-3-restart.png') });
  step('manifest ayarı değişen sürüm: kuruldu, "Premiere’i yeniden başlatın" denildi, panel yenilenmedi');

  /* 5) Özet tutmazsa kurulmaz */
  gh.version = '0.3.3';
  gh.badSha = true;
  await flyout('checkUpdates');
  await page.waitForFunction(() => /v0\.3\.3 hazır/.test(document.querySelector('#notice').textContent));
  await notice.locator('button', { hasText: 'Güncelle' }).click();
  await page.waitForFunction(() => /SHA-256\) tutmuyor/.test(document.querySelector('#notice').textContent), null, { timeout: 30000 });
  assert.equal(await version(), '0.3.2');
  step('Özet (SHA-256) tutmayan paket kurulmadı; panel olduğu gibi kaldı');

  /* 6) Teşhis ve Paneli yeniden yükle */
  gh.badSha = false;
  await flyout('diag');
  await page.waitForFunction(() => /Panel sürümü/.test(document.querySelector('#notice').textContent));
  const diag = await notice.locator('pre').textContent();
  assert.match(diag, /Panel sürümü: v0\.3\.2/);
  assert.match(diag, /Kurulum: kopya → /);
  assert.match(diag, /Önceki sürüm yedeği: v0\.3\.0/);
  assert.match(diag, /Güncelleme \(\d\d:\d\d\): v0\.3\.3 hazır/);
  await page.screenshot({ path: path.join(OUT, 'u-4-diag.png') });
  const reload3 = page.waitForEvent('load', { timeout: 30000 });
  await flyout('reload');
  await reload3;
  assert.equal(evalFiles.length, evalBefore + 1);
  step('Menü → Teşhis (sürüm, kurulum türü, yedek, son denetim) ve Paneli yeniden yükle ($.evalFile + yenileme)');

  assert.deepEqual(errors, []);
  await browser.close();
  ghServer.close();
  await site.stop();
  fs.rmSync(work, { recursive: true, force: true });
  console.log('\nGüncelleme uçtan uca testleri geçti. Ekran görüntüleri: ' + OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
