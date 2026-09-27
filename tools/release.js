#!/usr/bin/env node
// Tek komutla sürüm yayınlama.
//
//   npm run release -- 0.3.0            (önce release-notes/v0.3.0.md dosyasına kısa Türkçe notu yazın)
//   npm run release -- 0.3.0 --dry-run  (hiçbir şey göndermeden dener)
//
// Yaptıkları:
//   1. Not dosyası, temiz çalışma alanı ve sürümün mevcut sürümden büyük olduğu denetlenir.
//   2. Testler çalıştırılır (npm test).
//   3. manifest.xml, package.json ve package-lock.json'daki sürüm yükseltilir; paket denemesi yapılır.
//   4. Commit → main'e gönderilir (yalnızca ileri sarma).
//   5. GitHub Actions (.github/workflows/release.yml) main'deki yeni sürümü görünce testleri çalıştırır,
//      ZIP + release.json'ı hazırlar, vX.Y.Z etiketini atar ve Release'i not dosyasıyla yayınlar.
//      Kişisel token gerekmez; etiketi de GitHub oluşturur.
//
// RELEASE_COMMIT_TRAILERS ortam değişkeni varsa commit mesajının sonuna eklenir.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { build } = require('./build-release.js');

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'extension', 'CSXS', 'manifest.xml');

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, Object.assign({ cwd: ROOT, encoding: 'utf8' }, opts));
}
function git(...args) {
  return sh('git', args).trim();
}
function fail(msg) {
  console.error('\nHATA: ' + msg);
  process.exit(1);
}
function cmp(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const version = (args.find((a) => !a.startsWith('--')) || '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) fail('Sürüm verin: npm run release -- 0.3.0');
const tag = 'v' + version;

// 1) Denetimler
const notesFile = path.join(ROOT, 'release-notes', tag + '.md');
if (!fs.existsSync(notesFile) || !fs.readFileSync(notesFile, 'utf8').trim()) {
  fail(`Değişiklik notu yok: release-notes/${tag}.md dosyasına kısa Türkçe bir not yazın.`);
}
const dirty = git('status', '--porcelain');
if (dirty) fail('Çalışma alanında commit edilmemiş değişiklik var:\n' + dirty);
const manifest = fs.readFileSync(MANIFEST, 'utf8');
const current = (/ExtensionBundleVersion="([^"]+)"/.exec(manifest) || [])[1];
if (!current || cmp(version, current) <= 0) fail(`Yeni sürüm (${version}) mevcut sürümden (${current}) büyük olmalı.`);
if (git('tag', '--list', tag) || git('ls-remote', '--tags', 'origin', tag)) fail(`${tag} etiketi zaten var.`);
console.log(`Sürüm: ${current} → ${version}${dryRun ? '  (deneme, gönderilmeyecek)' : ''}`);

// 2) Testler
console.log('\n[1/3] Testler çalışıyor…');
try {
  sh('npm', ['test'], { stdio: 'inherit' });
} catch (e) {
  fail('Testler geçmedi; sürüm yayınlanmadı.');
}

// 3) Sürüm yükseltme + paket denemesi
console.log('\n[2/3] Sürüm yükseltiliyor ve paket deneniyor…');
fs.writeFileSync(
  MANIFEST,
  manifest
    .replace(/ExtensionBundleVersion="[^"]+"/, `ExtensionBundleVersion="${version}"`)
    .replace(/(<Extension Id="com\.badidea\.myinstants\.panel" Version=")[^"]+(")/, `$1${version}$2`)
);
for (const f of ['package.json', 'package-lock.json']) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  j.version = version;
  if (j.packages && j.packages['']) j.packages[''].version = version;
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
}
try {
  const r = build(tag, { outDir: path.join(ROOT, 'dist') });
  console.log(`Paket denemesi: ${r.info.zip} (${r.info.size} bayt, ${r.info.files} dosya)`);
} catch (e) {
  git('checkout', '--', '.');
  fail('Paket hazırlanamadı: ' + e.message);
}

if (dryRun) {
  git('checkout', '--', '.');
  console.log('\nDeneme bitti; değişiklikler geri alındı, hiçbir şey gönderilmedi.');
  process.exit(0);
}

// 4) Commit ve main (etiketi ve Release'i GitHub Actions oluşturur)
console.log('\n[3/3] Commit ve main…');
const trailers = (process.env.RELEASE_COMMIT_TRAILERS || '').trim();
git('add', '-A');
git('commit', '-q', '-m', `Sürüm ${tag}` + (trailers ? '\n\n' + trailers : ''));
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
try {
  sh('git', ['push', 'origin', 'HEAD:main'], { stdio: 'inherit' });
  if (branch !== 'main' && branch !== 'HEAD') sh('git', ['push', 'origin', 'HEAD:' + branch], { stdio: 'inherit' });
} catch (e) {
  fail('main\'e gönderilemedi (ileri sarma değil mi?).');
}

const remote = git('remote', 'get-url', 'origin').replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/');
console.log(`\nTamam. GitHub Actions ${tag} etiketini ve Release'i oluşturuyor (1-2 dk):\n  ${remote}/actions\n  ${remote}/releases/tag/${tag}`);
