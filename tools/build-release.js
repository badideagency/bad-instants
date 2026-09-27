#!/usr/bin/env node
// Sürüm paketini hazırlar: dist/MyInstants-vX.Y.Z.zip + dist/release.json (boyut + SHA-256).
// ZIP içinde tek klasör vardır: com.badidea.myinstants/ (extension/ klasörünün içeriği).
// Kullanım: node tools/build-release.js v0.3.0     (etiket manifest.xml'deki sürümle aynı olmalı)
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fflate = require('../extension/js/vendor/fflate.js');

const ROOT = path.join(__dirname, '..');
const BUNDLE = 'com.badidea.myinstants';
const SKIP = /^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i;
const FIXED_TIME = new Date('2020-01-01T00:00:00Z'); // aynı içerik → aynı ZIP

function build(tag, { extDir = path.join(ROOT, 'extension'), outDir = path.join(ROOT, 'dist') } = {}) {
  const version = String(tag || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Geçersiz sürüm etiketi: ' + tag);
  const manifest = fs.readFileSync(path.join(extDir, 'CSXS', 'manifest.xml'), 'utf8');
  const mv = (/ExtensionBundleVersion="([^"]+)"/.exec(manifest) || [])[1];
  if (mv !== version) throw new Error(`manifest.xml sürümü ${mv}, etiket ${version} — önce sürümü yükseltin`);

  const files = {};
  let count = 0;
  (function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.test(e.name)) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else {
        files[BUNDLE + '/' + r] = [new Uint8Array(fs.readFileSync(path.join(dir, e.name))), { mtime: FIXED_TIME }];
        count++;
      }
    }
  })(extDir, '');

  const zip = fflate.zipSync(files, { level: 9, mtime: FIXED_TIME });
  fs.mkdirSync(outDir, { recursive: true });
  const zipName = `MyInstants-v${version}.zip`;
  const zipPath = path.join(outDir, zipName);
  fs.writeFileSync(zipPath, zip);
  const info = {
    bundleId: BUNDLE,
    version,
    tag: 'v' + version,
    zip: zipName,
    size: zip.length,
    sha256: crypto.createHash('sha256').update(zip).digest('hex'),
    files: count,
  };
  const infoPath = path.join(outDir, 'release.json');
  fs.writeFileSync(infoPath, JSON.stringify(info, null, 2) + '\n');
  return { zipPath, infoPath, info };
}

if (require.main === module) {
  try {
    const r = build(process.argv[2]);
    console.log(`Paket hazır: ${path.relative(ROOT, r.zipPath)} (${r.info.size} bayt, ${r.info.files} dosya)`);
    console.log(`SHA-256: ${r.info.sha256}`);
  } catch (e) {
    console.error('HATA: ' + e.message);
    process.exit(1);
  }
}

module.exports = { build };
