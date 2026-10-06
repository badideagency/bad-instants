// updater.js testleri — gerçek geçici klasörlerle (kopya / bağlantı kurulumu, yedek, geri dönüş).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const fflate = require('../extension/js/vendor/fflate.js');
const U = require('../extension/js/updater.js');
const { build } = require('../tools/build-release.js');

const REPO_EXT = path.join(__dirname, '..', 'extension');
const API = 'https://api.github.com/repos/badideagency/bad-instants/releases/latest';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mi-upd-'));
}

// Depodaki extension/ klasörünün sürümü değiştirilmiş kopyası
function makeExt(dir, version, tweak) {
  fs.cpSync(REPO_EXT, dir, { recursive: true });
  const mf = path.join(dir, 'CSXS', 'manifest.xml');
  let xml = fs.readFileSync(mf, 'utf8')
    .replace(/ExtensionBundleVersion="[^"]+"/, `ExtensionBundleVersion="${version}"`)
    .replace(/(<Extension Id="com\.badidea\.myinstants\.panel" Version=")[^"]+/, `$1${version}`);
  fs.writeFileSync(mf, xml);
  if (tweak) tweak(dir);
  return dir;
}

function snapshot(dir) {
  const out = {};
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out[r] = crypto.createHash('sha1').update(fs.readFileSync(path.join(d, e.name))).digest('hex');
    }
  })(dir, '');
  return out;
}

// Sahte GitHub: releases/latest + ZIP + release.json
function fakeGitHub(pkg, { version, zipName, sha256, size, redirectZipTo } = {}) {
  const tag = 'v' + (version || pkg.info.version);
  const zipUrl = `https://github.com/badideagency/bad-instants/releases/download/${tag}/${zipName || pkg.info.zip}`;
  const infoUrl = `https://github.com/badideagency/bad-instants/releases/download/${tag}/release.json`;
  const zipBytes = fs.readFileSync(pkg.zipPath);
  const info = Object.assign({}, pkg.info, sha256 ? { sha256 } : {}, size ? { size } : {});
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const resp = (status, body, type, finalUrl) => ({
      status,
      ok: status >= 200 && status < 300,
      url: finalUrl || url,
      headers: { get: (h) => (h.toLowerCase() === 'content-length' ? String(body.length) : type) },
      json: async () => JSON.parse(Buffer.from(body).toString('utf8')),
      arrayBuffer: async () => new Uint8Array(body).buffer,
    });
    if (url === API) {
      return resp(
        200,
        Buffer.from(
          JSON.stringify({
            tag_name: tag,
            name: 'MyInstants ' + tag,
            body: '## Yenilikler\n- **Güncelleme** paneli',
            html_url: 'https://github.com/badideagency/bad-instants/releases/tag/' + tag,
            assets: [
              { name: zipName || pkg.info.zip, size: zipBytes.length, browser_download_url: zipUrl },
              { name: 'release.json', size: 200, browser_download_url: infoUrl },
            ],
          })
        ),
        'application/json'
      );
    }
    if (url === infoUrl) return resp(200, Buffer.from(JSON.stringify(info)), 'application/json');
    if (url === zipUrl) return resp(200, zipBytes, 'application/zip', redirectZipTo || 'https://objects.githubusercontent.com/x');
    return resp(404, Buffer.from('yok'), 'text/plain');
  };
  return { fetch, calls, tag };
}

function zipOf(entries) {
  const o = {};
  for (const [k, v] of Object.entries(entries)) o[k] = typeof v === 'string' ? new TextEncoder().encode(v) : v;
  return fflate.zipSync(o);
}

const MANIFEST = (id, v) =>
  `<ExtensionManifest ExtensionBundleId="${id}" ExtensionBundleVersion="${v}" Version="12.0"></ExtensionManifest>`;

/* ------------------------------------------------------------------ */

test('sürüm karşılaştırma', () => {
  assert.equal(U.compareVersions('0.3.1', '0.3.0'), 1);
  assert.equal(U.compareVersions('v0.10.0', '0.9.9'), 1);
  assert.equal(U.compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(U.compareVersions('0.2.9', '0.3.0'), -1);
  assert.ok(Number.isNaN(U.compareVersions('x', '1.0.0')));
});

test('paket: build → ZIP → açma (üst klasörlü)', () => {
  const out = tmp();
  const ext = makeExt(path.join(out, 'src'), '9.9.9');
  const pkg = build('v9.9.9', { extDir: ext, outDir: path.join(out, 'dist') });
  assert.equal(pkg.info.bundleId, 'com.badidea.myinstants');
  const files = U.extractPackage(fs.readFileSync(pkg.zipPath), '9.9.9', REPO_EXT);
  assert.equal(files.size, pkg.info.files);
  assert.ok(files.has('CSXS/manifest.xml') && files.has('js/updater.js') && files.has('js/vendor/fflate.js'));
  assert.ok(fs.existsSync(path.join(ext, '.debug')) && !files.has('.debug')); // geliştirici portu pakete girmez
  // aynı içerik → aynı ZIP (sabit tarih)
  const again = build('v9.9.9', { extDir: ext, outDir: path.join(out, 'dist2') });
  assert.equal(again.info.sha256, pkg.info.sha256);
  assert.throws(() => build('v1.0.0', { extDir: ext, outDir: path.join(out, 'x') }), /manifest.xml sürümü 9.9.9/);
});

test('paket: güvensiz yol, yanlış eklenti, yanlış sürüm, eksik dosya reddedilir', () => {
  const ok = { 'p/CSXS/manifest.xml': MANIFEST('com.badidea.myinstants', '1.2.3'), 'p/index.html': 'x', 'p/jsx/host.jsx': 'x' };
  assert.equal(U.extractPackage(zipOf(ok), '1.2.3', REPO_EXT).size, 3);
  // klasörsüz ZIP de olur
  const flat = { 'CSXS/manifest.xml': MANIFEST('com.badidea.myinstants', '1.2.3'), 'index.html': 'x', 'jsx/host.jsx': 'x' };
  assert.equal(U.extractPackage(zipOf(flat), '1.2.3', REPO_EXT).size, 3);
  const kind = (entries, v = '1.2.3') => {
    try {
      U.extractPackage(zipOf(entries), v, REPO_EXT);
      return 'ok';
    } catch (e) {
      return e.kind;
    }
  };
  assert.equal(kind({ ...ok, 'p/../../evil.js': 'x' }), 'badzip');
  assert.equal(kind({ ...ok, '/abs.js': 'x' }), 'badzip');
  assert.equal(kind({ ...ok, 'C:/Windows/evil.js': 'x' }), 'badzip');
  assert.equal(kind({ ...ok, 'p/a\\b.js': 'x' }), 'badzip');
  assert.equal(kind({ ...ok, 'başka/dosya.js': 'x' }), 'badpackage'); // paket kökü dışında
  assert.equal(kind({ ...ok, 'p/CSXS/manifest.xml': MANIFEST('com.baska.eklenti', '1.2.3') }), 'badpackage');
  assert.equal(kind(ok, '1.2.4'), 'badpackage');
  const noIndex = { ...ok };
  delete noIndex['p/index.html'];
  assert.equal(kind(noIndex), 'badpackage');
  assert.equal(U.extractPackage.length, 3);
  assert.throws(() => U.extractPackage(new Uint8Array([1, 2, 3]), '1.2.3', REPO_EXT), (e) => e.kind === 'badzip');
});

test('denetim ve indirme: yeni sürüm, boyut / özet / adres kontrolleri', async (t) => {
  const out = tmp();
  const pkg = build('v0.4.0', { extDir: makeExt(path.join(out, 'src'), '0.4.0'), outDir: path.join(out, 'dist') });
  t.after(() => U.configure({ fetch: null }));

  let gh = fakeGitHub(pkg);
  U.configure({ fetch: gh.fetch });
  const l = await U.checkLatest('0.3.0');
  assert.deepEqual([l.version, l.newer, l.zip.name], ['0.4.0', true, 'MyInstants-v0.4.0.zip']);
  assert.equal((await U.checkLatest('0.4.0')).newer, false);
  const bytes = await U.downloadPackage(l);
  assert.equal(bytes.byteLength, pkg.info.size);

  const kindOf = (p) => p.then(() => 'ok', (e) => e.kind);
  gh = fakeGitHub(pkg, { sha256: 'deadbeef'.repeat(8) });
  U.configure({ fetch: gh.fetch });
  assert.equal(await kindOf(U.checkLatest('0.3.0').then(U.downloadPackage)), 'checksum');
  gh = fakeGitHub(pkg, { size: pkg.info.size + 1 });
  U.configure({ fetch: gh.fetch });
  assert.equal(await kindOf(U.checkLatest('0.3.0').then(U.downloadPackage)), 'size');
  gh = fakeGitHub(pkg, { redirectZipTo: 'https://kotu-site.example/x.zip' });
  U.configure({ fetch: gh.fetch });
  assert.equal(await kindOf(U.checkLatest('0.3.0').then(U.downloadPackage)), 'badhost');
  U.configure({ fetch: async () => ({ status: 404, ok: false, url: API, headers: { get: () => '' } }) });
  assert.equal(await kindOf(U.checkLatest('0.3.0')), 'notfound');
  U.configure({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
  assert.equal(await kindOf(U.checkLatest('0.3.0')), 'network');
});

test('kurulum (kopya): yedek alınır, dosyalar değişir, manifest sadece sürümde farklıysa yeniden başlatma yok', async (t) => {
  const out = tmp();
  U.configure({ appData: path.join(out, 'AppData') });
  t.after(() => U.configure({ appData: null }));
  const ext = makeExt(path.join(out, 'extensions', 'com.badidea.myinstants'), '0.3.0', (d) => {
    fs.writeFileSync(path.join(d, 'eski-dosya.txt'), 'kaldırılacak');
  });
  const before = snapshot(ext);
  const newExt = makeExt(path.join(out, 'src'), '0.3.1', (d) => fs.writeFileSync(path.join(d, 'yeni.txt'), 'merhaba'));
  const pkg = build('v0.3.1', { extDir: newExt, outDir: path.join(out, 'dist') });
  const files = U.extractPackage(fs.readFileSync(pkg.zipPath), '0.3.1', REPO_EXT);

  const inst = await U.resolveInstall(ext);
  assert.deepEqual([inst.linked, inst.gitCheckout], [false, false]);
  assert.ok(fs.existsSync(path.join(ext, '.debug')));
  const r = await U.install(inst.realDir, files, '0.3.1');
  assert.deepEqual([r.from, r.to, r.manifestChanged], ['0.3.0', '0.3.1', false]);
  const expected = snapshot(newExt);
  delete expected['.debug'];
  assert.deepEqual(snapshot(ext), expected);
  assert.ok(!fs.existsSync(path.join(ext, 'eski-dosya.txt')));
  assert.ok(!fs.existsSync(path.join(ext, '.debug'))); // güncelleme eski geliştirici portu dosyasını da kaldırır
  // yedek CEP klasörünün DIŞINDA ve eski hâlin aynısı
  assert.ok(r.backupDir.startsWith(path.join(out, 'AppData', 'BadIdea', 'MyInstants', 'backup')));
  assert.deepEqual(snapshot(path.join(r.backupDir, 'files')), before);
  assert.deepEqual(fs.readdirSync(path.join(out, 'extensions')), ['com.badidea.myinstants']);
  // geçici dosya kalmadı
  assert.ok(!Object.keys(snapshot(ext)).some((f) => f.includes('.mi-tmp-')));
});

test('kurulum: manifest ayarı değişirse yeniden başlatma istenir', async (t) => {
  const out = tmp();
  U.configure({ appData: path.join(out, 'AppData') });
  t.after(() => U.configure({ appData: null }));
  const ext = makeExt(path.join(out, 'ext'), '0.3.0');
  const newExt = makeExt(path.join(out, 'src'), '0.3.1', (d) => {
    const mf = path.join(d, 'CSXS', 'manifest.xml');
    fs.writeFileSync(mf, fs.readFileSync(mf, 'utf8').replace('<Parameter>--mixed-context</Parameter>', '<Parameter>--mixed-context</Parameter>\n<Parameter>--yeni-ayar</Parameter>'));
  });
  const pkg = build('v0.3.1', { extDir: newExt, outDir: path.join(out, 'dist') });
  const r = await U.install(ext, U.extractPackage(fs.readFileSync(pkg.zipPath), '0.3.1', REPO_EXT), '0.3.1');
  assert.equal(r.manifestChanged, true);
});

test('kurulum (junction / bağlantı): gerçek klasör bulunur ve orası güncellenir; git klasörü tanınır', async (t) => {
  const out = tmp();
  U.configure({ appData: path.join(out, 'AppData') });
  t.after(() => U.configure({ appData: null }));
  const real = makeExt(path.join(out, 'Proje', 'extension'), '0.3.0');
  fs.mkdirSync(path.join(out, 'extensions'));
  const link = path.join(out, 'extensions', 'com.badidea.myinstants');
  fs.symlinkSync(real, link, 'junction');
  const inst = await U.resolveInstall(link);
  assert.deepEqual([inst.realDir, inst.linked, inst.gitCheckout], [fs.realpathSync(real), true, false]);

  const pkg = build('v0.3.1', { extDir: makeExt(path.join(out, 'src'), '0.3.1'), outDir: path.join(out, 'dist') });
  await U.install(inst.realDir, U.extractPackage(fs.readFileSync(pkg.zipPath), '0.3.1', REPO_EXT), '0.3.1');
  assert.equal(await U.installedVersion(real), '0.3.1');
  assert.ok(fs.lstatSync(link).isSymbolicLink()); // bağlantı yerinde duruyor

  fs.mkdirSync(path.join(out, 'Proje', '.git'));
  assert.equal((await U.resolveInstall(link)).gitCheckout, true);
});

// Belirli bir yazmadan sonra hata veren fs
function flakyFs(failWhen) {
  let n = 0;
  return Object.assign({}, fsp, {
    writeFile: async (p, data) => {
      if (failWhen(String(p), ++n)) throw Object.assign(new Error('Disk hatası (test)'), { code: 'EIO' });
      return fsp.writeFile(p, data);
    },
  });
}

test('kurulum yarıda hata verirse yedek otomatik geri yüklenir', async (t) => {
  const out = tmp();
  const ext = makeExt(path.join(out, 'ext'), '0.3.0');
  const before = snapshot(ext);
  const newExt = makeExt(path.join(out, 'src'), '0.3.1', (d) => fs.writeFileSync(path.join(d, 'zz-yeni.txt'), 'x'));
  const pkg = build('v0.3.1', { extDir: newExt, outDir: path.join(out, 'dist') });
  const files = U.extractPackage(fs.readFileSync(pkg.zipPath), '0.3.1', REPO_EXT);
  let appliedWrites = 0;
  U.configure({
    appData: path.join(out, 'AppData'),
    fs: flakyFs((p) => p.startsWith(ext) && ++appliedWrites === 6), // uygulama sırasında 6. yazma bozulur
  });
  t.after(() => U.configure({ appData: null, fs: null }));
  await assert.rejects(U.install(ext, files, '0.3.1'), (e) => e.kind === 'rolledback');
  assert.deepEqual(snapshot(ext), before); // birebir eski hâli
});

test('yedek de geri yüklenemezse "rollbackfailed" ve yedeğin yeri söylenir', async (t) => {
  const out = tmp();
  const ext = makeExt(path.join(out, 'ext'), '0.3.0');
  const pkg = build('v0.3.1', { extDir: makeExt(path.join(out, 'src'), '0.3.1'), outDir: path.join(out, 'dist') });
  const files = U.extractPackage(fs.readFileSync(pkg.zipPath), '0.3.1', REPO_EXT);
  let started = false;
  U.configure({
    appData: path.join(out, 'AppData'),
    fs: flakyFs((p, n) => {
      if (p.startsWith(ext)) {
        if (started) return true;
        started = true;
        return false;
      }
      return false;
    }),
  });
  t.after(() => U.configure({ appData: null, fs: null }));
  await assert.rejects(U.install(ext, files, '0.3.1'), (e) => e.kind === 'rollbackfailed' && !!e.backupDir);
});

test('önceki sürüme dön: geri alınabilir; yedekler sınırlı tutulur; yedek yoksa uyarı', async (t) => {
  const out = tmp();
  U.configure({ appData: path.join(out, 'AppData') });
  t.after(() => U.configure({ appData: null }));
  const ext = makeExt(path.join(out, 'ext'), '0.3.0');
  const v030 = snapshot(ext);
  await assert.rejects(U.rollback(ext), (e) => e.kind === 'nobackup');

  const install = async (v) => {
    const pkg = build('v' + v, { extDir: makeExt(path.join(out, 'src-' + v), v), outDir: path.join(out, 'dist-' + v) });
    return U.install(ext, U.extractPackage(fs.readFileSync(pkg.zipPath), v, REPO_EXT), v);
  };
  await install('0.3.1');
  const v031 = snapshot(ext);
  let r = await U.rollback(ext);
  assert.deepEqual([r.from, r.to], ['0.3.1', '0.3.0']);
  assert.deepEqual(snapshot(ext), v030);
  r = await U.rollback(ext); // tekrar: 0.3.1'e döner (geri dönüş de yedeklendi)
  assert.deepEqual([r.from, r.to], ['0.3.0', '0.3.1']);
  assert.deepEqual(snapshot(ext), v031);

  for (const v of ['0.3.2', '0.3.3', '0.3.4', '0.3.5']) await install(v);
  const backups = await U.listBackups();
  assert.equal(backups.length, 3);
  assert.deepEqual(backups.map((b) => b.version), ['0.3.4', '0.3.3', '0.3.2']);
});
