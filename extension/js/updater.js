/*
 * updater.js — panel içi güncelleme (GitHub Releases, token yok; depo public).
 *
 *  1) releases/latest'e bakar (panelin tarayıcısıyla).
 *  2) ZIP'i ve release.json'ı indirir; ZIP'in boyutunu ve SHA-256 özetini release.json ile karşılaştırır.
 *     Yalnızca github.com / *.githubusercontent.com adreslerinden indirir.
 *  3) ZIP'i paketle gelen saf JS kütüphanesiyle (fflate) açar; güvensiz yolları reddeder;
 *     paketin bu panele ait olduğunu ve sürümünün tuttuğunu denetler.
 *  4) Gerçek eklenti klasörünü bulur (junction ise hedefi), mevcut sürümü CEP klasörünün DIŞINA yedekler
 *     (%APPDATA%\BadIdea\MyInstants\backup\<sürüm>), dosyaları değiştirir. Hata olursa yedeği geri yükler.
 *  5) manifest.xml değişti mi bilgisini döndürür (değiştiyse Premiere yeniden başlatılmalı).
 *
 * Node yalnızca dosya işlemleri için kullanılır (fs). İnternet istekleri tarayıcının fetch'iyle yapılır.
 */
(function (root, factory) {
  var api = factory(root);
  if (root) root.Updater = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  const REPO = 'badideagency/bad-instants';
  const BUNDLE_ID = 'com.badidea.myinstants';
  const MAX_ZIP_BYTES = 20 * 1024 * 1024;
  const KEEP_BACKUPS = 3;
  const TIMEOUT_MS = 60000;
  const ALLOWED_HOST = /^(github\.com|api\.github\.com|([a-z0-9-]+\.)*githubusercontent\.com)$/i;

  const deps = {
    apiUrl: `https://api.github.com/repos/${REPO}/releases/latest`,
    fetch: null, // testler için
    fs: null, // testler için (fs.promises uyumlu)
    appData: null, // testler için
  };

  function configure(d) {
    Object.assign(deps, d);
  }

  function updError(kind, message, extra) {
    const e = new Error(message || kind);
    e.kind = kind;
    if (extra) Object.assign(e, extra);
    return e;
  }

  function nodeRequire(name) {
    const req = typeof root.require === 'function' ? root.require : typeof require === 'function' ? require : null;
    if (!req) throw updError('nonode', 'Node.js kullanılamıyor');
    return req(name);
  }

  function fsp() {
    return deps.fs || nodeRequire('fs').promises;
  }

  function doFetch(url, opts) {
    const f = deps.fetch || root.fetch;
    return f(url, opts);
  }

  /* ------------------------------------------------------------------ yollar */

  // Aynı ayırıcıyla birleştirir: Windows yolu (\) ise \, değilse /
  function pj(base, ...parts) {
    const sep = /\\/.test(base) ? '\\' : '/';
    let out = String(base).replace(/[\\/]+$/, '');
    for (const p of parts) {
      const clean = String(p).replace(/[\\/]+/g, sep).replace(/^[\\/]+|[\\/]+$/g, '');
      if (clean) out += sep + clean;
    }
    return out;
  }

  function parentOf(p) {
    return String(p).replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '');
  }

  function sameDir(a, b) {
    const n = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return n(a) === n(b);
  }

  function appData() {
    if (deps.appData) return deps.appData;
    const proc = root.process || (typeof process !== 'undefined' ? process : null);
    if (proc && proc.env && proc.env.APPDATA) return proc.env.APPDATA;
    return pj(nodeRequire('os').homedir(), 'AppData', 'Roaming');
  }

  function backupRoot() {
    return pj(appData(), 'BadIdea', 'MyInstants', 'backup');
  }

  /* ------------------------------------------------------------------ sürümler */

  function parseVersion(v) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
    return m ? m.slice(1).map(Number) : null;
  }

  // a > b → 1, a < b → -1, eşit → 0, okunamıyorsa NaN
  function compareVersions(a, b) {
    const x = parseVersion(a);
    const y = parseVersion(b);
    if (!x || !y) return NaN;
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
    return 0;
  }

  function manifestInfo(text) {
    const s = String(text || '');
    return {
      id: (/ExtensionBundleId="([^"]+)"/.exec(s) || [])[1] || '',
      version: (/ExtensionBundleVersion="([^"]+)"/.exec(s) || [])[1] || '',
    };
  }

  const decode = (bytes) => new TextDecoder('utf-8').decode(bytes);
  const encode = (text) => new TextEncoder().encode(text);

  async function installedVersion(dir) {
    return manifestInfo(decode(await fsp().readFile(pj(dir, 'CSXS', 'manifest.xml')))).version;
  }

  /* ------------------------------------------------------------------ internet */

  function checkHost(url) {
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch (e) {
      /* geçersiz */
    }
    if (!ALLOWED_HOST.test(host)) throw updError('badhost', 'İzin verilmeyen adres: ' + url);
  }

  async function request(url, accept) {
    checkHost(url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await doFetch(url, { headers: { Accept: accept }, cache: 'no-store', redirect: 'follow', signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timer);
      throw updError('network', (e && e.message) || 'Bağlantı hatası');
    }
    try {
      if (res.url) checkHost(res.url); // yönlendirme sonrası da GitHub olmalı
      if (res.status === 404) throw updError('notfound', 'HTTP 404');
      if (!res.ok) throw updError('network', 'HTTP ' + res.status);
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
    return { res, done: () => clearTimeout(timer) };
  }

  async function getJson(url) {
    const { res, done } = await request(url, 'application/vnd.github+json, application/json');
    try {
      return await res.json();
    } catch (e) {
      throw updError('badrelease', 'JSON okunamadı');
    } finally {
      done();
    }
  }

  async function getBytes(url, maxBytes) {
    const { res, done } = await request(url, 'application/octet-stream');
    try {
      const len = Number(res.headers.get('content-length') || 0);
      if (len > maxBytes) throw updError('toolarge', len + ' bayt');
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > maxBytes) throw updError('toolarge', buf.byteLength + ' bayt');
      return buf;
    } catch (e) {
      if (e.kind) throw e;
      throw updError('network', (e && e.message) || 'İndirme yarıda kaldı');
    } finally {
      done();
    }
  }

  async function sha256Hex(bytes) {
    const subtle = root.crypto && root.crypto.subtle;
    if (subtle) {
      const h = new Uint8Array(await subtle.digest('SHA-256', bytes));
      return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
    }
    return nodeRequire('crypto').createHash('sha256').update(bytes).digest('hex');
  }

  // Son sürüm bilgisi → { current, version, tag, notes, newer, zip: {url, size, name}, infoUrl, htmlUrl, publishedAt }
  async function checkLatest(currentVersion) {
    const r = await getJson(deps.apiUrl);
    const tag = String(r.tag_name || '');
    const version = tag.replace(/^v/, '');
    if (!parseVersion(version)) throw updError('badrelease', 'Sürüm etiketi okunamadı: ' + tag);
    const assets = Array.isArray(r.assets) ? r.assets : [];
    const zip = assets.find((a) => /\.zip$/i.test(a.name));
    const info = assets.find((a) => a.name === 'release.json');
    if (!zip || !info) throw updError('badrelease', 'ZIP ya da release.json yok');
    return {
      current: currentVersion,
      version,
      tag,
      name: r.name || tag,
      notes: String(r.body || '').trim(),
      htmlUrl: r.html_url || '',
      publishedAt: r.published_at || '',
      zip: { url: zip.browser_download_url, size: zip.size, name: zip.name },
      infoUrl: info.browser_download_url,
      newer: compareVersions(version, currentVersion) > 0,
    };
  }

  // ZIP'i indirir; boyut ve SHA-256 özetini release.json ile karşılaştırır → Uint8Array
  async function downloadPackage(latest) {
    const info = await getJson(latest.infoUrl);
    if (info.version !== latest.version || info.zip !== latest.zip.name || info.bundleId !== BUNDLE_ID) {
      throw updError('badrelease', 'release.json bu sürümle uyuşmuyor');
    }
    if (!(info.size > 0) || info.size > MAX_ZIP_BYTES) throw updError('toolarge', info.size + ' bayt');
    if (latest.zip.size && latest.zip.size !== info.size) throw updError('size', 'GitHub boyutu ≠ release.json');
    const bytes = await getBytes(latest.zip.url, MAX_ZIP_BYTES);
    if (bytes.byteLength !== info.size) throw updError('size', `${bytes.byteLength} ≠ ${info.size} bayt`);
    const sum = await sha256Hex(bytes);
    if (sum !== String(info.sha256 || '').toLowerCase()) throw updError('checksum', sum);
    return bytes;
  }

  /* ------------------------------------------------------------------ ZIP'i açma ve denetleme */

  function getFflate(extDir) {
    if (root.fflate && root.fflate.unzipSync) return root.fflate;
    // CEP'in Node'lu sayfasında UMD paketi kendini window yerine module.exports'a bağlar; dosyadan yükle.
    return nodeRequire(pj(extDir, 'js', 'vendor', 'fflate.js'));
  }

  function safeRelPath(name) {
    if (!name || name.length > 240) return false;
    if (/[\\:*?"<>|\x00-\x1f]/.test(name)) return false; // ters bölü, sürücü harfi, Windows'ta geçersiz karakter
    if (name.startsWith('/')) return false;
    return name.split('/').every((seg) => seg && seg !== '.' && seg !== '..' && !/[. ]$/.test(seg));
  }

  // → Map(göreli yol → Uint8Array). Kök: CSXS/manifest.xml'i içeren klasör (üst klasörlü ya da klasörsüz ZIP).
  function extractPackage(zipBytes, expectedVersion, extDir) {
    let entries;
    try {
      entries = getFflate(extDir).unzipSync(zipBytes);
    } catch (e) {
      throw updError('badzip', (e && e.message) || 'ZIP açılamadı');
    }
    const names = Object.keys(entries).filter((n) => !n.endsWith('/'));
    const bad = names.find((n) => !safeRelPath(n));
    if (bad !== undefined) throw updError('badzip', 'Güvensiz dosya yolu: ' + bad);

    const manifests = names.filter((n) => /^([^/]+\/)?CSXS\/manifest\.xml$/.test(n));
    if (manifests.length !== 1) throw updError('badpackage', 'manifest.xml bulunamadı');
    const prefix = manifests[0].slice(0, -'CSXS/manifest.xml'.length);

    const files = new Map();
    for (const n of names) {
      if (!n.startsWith(prefix)) throw updError('badpackage', 'Paket kökü dışında dosya: ' + n);
      files.set(n.slice(prefix.length), entries[n]);
    }
    const m = manifestInfo(decode(files.get('CSXS/manifest.xml')));
    if (m.id !== BUNDLE_ID) throw updError('badpackage', 'Başka bir eklentinin paketi: ' + m.id);
    if (m.version !== expectedVersion) throw updError('badpackage', `Paket sürümü ${m.version}, beklenen ${expectedVersion}`);
    for (const req of ['index.html', 'jsx/host.jsx']) {
      if (!files.has(req)) throw updError('badpackage', 'Eksik dosya: ' + req);
    }
    return files;
  }

  /* ------------------------------------------------------------------ dosya işlemleri */

  async function exists(p) {
    try {
      await fsp().stat(p);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Klasördeki bütün dosyalar (göreli, "/" ile)
  async function listFiles(dir, rel = '') {
    const out = [];
    const items = await fsp().readdir(rel ? pj(dir, rel) : dir, { withFileTypes: true });
    for (const it of items) {
      const r = rel ? rel + '/' + it.name : it.name;
      if (it.isDirectory()) out.push(...(await listFiles(dir, r)));
      else out.push(r);
    }
    return out.sort();
  }

  async function writeFileAtomic(full, bytes) {
    const fs = fsp();
    await fs.mkdir(parentOf(full), { recursive: true });
    const tmp = full + '.mi-tmp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    try {
      await fs.writeFile(tmp, bytes);
      await fs.rename(tmp, full);
    } catch (e) {
      try {
        await fs.unlink(tmp);
      } catch (e2) {
        /* yok */
      }
      throw updError('write', (e && e.message) || 'Yazılamadı', { code: e && e.code, where: full });
    }
  }

  async function removeDir(dir) {
    try {
      await fsp().rm(dir, { recursive: true, force: true });
    } catch (e) {
      /* yok */
    }
  }

  // Göreli yollardaki dosyaları yazar; listede olmayan eski dosyaları siler.
  async function writeTree(dir, files, previous) {
    for (const [rel, bytes] of files) await writeFileAtomic(pj(dir, rel), bytes);
    for (const rel of previous) {
      if (!files.has(rel)) {
        try {
          await fsp().unlink(pj(dir, rel));
        } catch (e) {
          if (e && e.code !== 'ENOENT') throw updError('write', e.message, { code: e.code, where: rel });
        }
      }
    }
  }

  async function readTree(dir, list) {
    const files = new Map();
    for (const rel of list) files.set(rel, new Uint8Array(await fsp().readFile(pj(dir, rel))));
    return files;
  }

  /* ------------------------------------------------------------------ kurulum yeri */

  // Panelin yüklendiği klasörün gerçek yeri (junction/bağlantı ise hedefi) ve git çalışma kopyası mı
  async function resolveInstall(extPath) {
    const realDir = await fsp().realpath(extPath);
    const gitCheckout = (await exists(pj(realDir, '.git'))) || (await exists(pj(parentOf(realDir), '.git')));
    return { extPath, realDir, linked: !sameDir(realDir, extPath), gitCheckout };
  }

  /* ------------------------------------------------------------------ yedekler */

  async function listBackups() {
    const rootDir = backupRoot();
    let names = [];
    try {
      names = (await fsp().readdir(rootDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (e) {
      return [];
    }
    const out = [];
    for (const n of names) {
      try {
        const meta = JSON.parse(decode(await fsp().readFile(pj(rootDir, n, 'backup.json'))));
        if (meta && meta.version && Array.isArray(meta.files)) out.push(Object.assign(meta, { dir: pj(rootDir, n) }));
      } catch (e) {
        /* bozuk yedek: yok say */
      }
    }
    return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  }

  async function pruneBackups() {
    const all = await listBackups();
    for (const b of all.slice(KEEP_BACKUPS)) await removeDir(b.dir);
  }

  /* ------------------------------------------------------------------ kurulum / geri dönüş */

  // manifest.xml karşılaştırması: satır sonları ve sürüm numaraları yok sayılır (her sürümde değişirler;
  // Premiere'in yeniden başlatılmasını gerektiren şey diğer ayarlardır).
  const normalizeManifest = (bytes) =>
    bytes
      ? decode(bytes)
          .replace(/\r\n/g, '\n')
          .replace(/(ExtensionBundleVersion|Version)="\d+\.\d+\.\d+"/g, '$1="*"')
          .trim()
      : '';

  // Yeni dosyaları gerçek eklenti klasörüne kurar. Önce yedekler; hata olursa yedeği geri yükler.
  // → { from, to, manifestChanged, backupDir }
  async function install(realDir, files, expectedVersion, hooks = {}) {
    const fs = fsp();
    const oldFiles = await listFiles(realDir);
    const oldManifest = new Uint8Array(await fs.readFile(pj(realDir, 'CSXS', 'manifest.xml')));
    const from = manifestInfo(decode(oldManifest)).version || '0.0.0';

    // 1) Yedek (CEP klasörünün dışında; içeride olursa Premiere onu ikinci panel sanar)
    const backupDir = pj(backupRoot(), from);
    await removeDir(backupDir);
    try {
      await writeTree(pj(backupDir, 'files'), await readTree(realDir, oldFiles), []);
      await writeFileAtomic(
        pj(backupDir, 'backup.json'),
        encode(JSON.stringify({ version: from, date: new Date().toISOString(), files: oldFiles }, null, 2))
      );
    } catch (e) {
      throw updError('backupfailed', e.message, { where: backupDir }); // hiçbir şey değişmedi
    }

    // 2) Uygula; 3) hata olursa geri yükle
    try {
      if (hooks.beforeApply) await hooks.beforeApply();
      await writeTree(realDir, files, oldFiles);
      const now = await installedVersion(realDir);
      if (now !== expectedVersion) throw updError('verify', `Kurulan sürüm ${now}, beklenen ${expectedVersion}`);
    } catch (e) {
      try {
        const saved = await readTree(pj(backupDir, 'files'), oldFiles);
        await writeTree(realDir, saved, [...new Set([...oldFiles, ...files.keys()])]);
      } catch (e2) {
        throw updError('rollbackfailed', e2.message, { cause: e, backupDir });
      }
      throw updError('rolledback', e.message, { cause: e });
    }

    await pruneBackups();
    return {
      from,
      to: expectedVersion,
      manifestChanged: normalizeManifest(oldManifest) !== normalizeManifest(files.get('CSXS/manifest.xml')),
      backupDir,
    };
  }

  // En son yedeğe (şu anki sürümden farklı olana) döner. Şu anki sürüm de yedeklenir; işlem geri alınabilir.
  async function rollback(realDir) {
    const current = await installedVersion(realDir);
    const b = (await listBackups()).find((x) => x.version !== current);
    if (!b) throw updError('nobackup', 'Yedek yok');
    const files = await readTree(pj(b.dir, 'files'), b.files);
    return install(realDir, files, b.version);
  }

  async function previousBackup(currentVersion) {
    return (await listBackups()).find((x) => x.version !== currentVersion) || null;
  }

  return {
    REPO,
    BUNDLE_ID,
    configure,
    error: updError,
    parseVersion,
    compareVersions,
    manifestInfo,
    installedVersion,
    checkLatest,
    downloadPackage,
    extractPackage,
    sha256Hex,
    resolveInstall,
    install,
    rollback,
    listBackups,
    previousBackup,
    listFiles,
    backupRoot,
  };
});
