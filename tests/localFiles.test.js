// localFiles.js testleri: dosya adı kuralları, "Ad (2)", kayıt dosyası, yarım dosya bırakmayan yazma.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../extension/js/localFiles.js');

// Bellekte sahte disk (Windows yolları, büyük/küçük harf duyarsız)
function fakeFs() {
  const files = new Map();
  const key = (p) => p.toLowerCase();
  const err = (code) => Object.assign(new Error(code), { code });
  const api = {
    files,
    failWrite: null,
    async stat(p) {
      if (!files.has(key(p))) throw err('ENOENT');
      return { isFile: () => true, size: files.get(key(p)).data.length };
    },
    async mkdir() {},
    async writeFile(p, bytes) {
      if (api.failWrite) throw err(api.failWrite);
      files.set(key(p), { name: p, data: Buffer.from(bytes) });
    },
    async rename(a, b) {
      const f = files.get(key(a));
      if (!f) throw err('ENOENT');
      files.delete(key(a));
      files.set(key(b), { name: b, data: f.data });
    },
    async unlink(p) {
      files.delete(key(p));
    },
    async readFile(p) {
      if (!files.has(key(p))) throw err('ENOENT');
      return files.get(key(p)).data;
    },
  };
  return api;
}

test('dosya adı: Windows\'ta geçersiz karakterler temizlenir, Türkçe korunur', () => {
  const f = L.safeFileName;
  assert.equal(f('Değirmenci Dayı: "BASS" / Çılgın?*'), 'Değirmenci Dayı BASS Çılgın');
  assert.equal(f('ŞŞŞ ğüöıİç'), 'ŞŞŞ ğüöıİç');
  assert.equal(f('a<b>c|d\\e\tf'), 'a b c d e f');
  assert.equal(f('  ...son nokta... '), 'son nokta');
  assert.equal(f('CON'), 'CON_');
  assert.equal(f('nul.x'), 'nul.x_');
  assert.equal(f(''), 'ses');
  assert.equal(f('???'), 'ses');
  assert.equal(f('x'.repeat(150)).length, 100);
  assert.equal(f('😀'.repeat(120)), '😀'.repeat(100)); // emoji bölünmez
  assert.equal(f('Sound (1) [TR]'), 'Sound (1) [TR]');
});

test('uzantı ses adresinden alınır', () => {
  assert.equal(L.extFromUrl('https://www.myinstants.com/media/sounds/a.MP3'), '.mp3');
  assert.equal(L.extFromUrl('https://www.myinstants.com/media/sounds/a.wav'), '.wav');
  assert.equal(L.extFromUrl('https://www.myinstants.com/media/sounds/a'), '.mp3');
  assert.equal(L.extFromUrl('https://www.myinstants.com/media/sounds/a.exe'), '.mp3');
});

test('chooseTarget: var olan dosya tekrar indirilmez; aynı adda farklı ses "Ad (2)" olur', async (t) => {
  const fs = fakeFs();
  L._setFs(fs);
  t.after(() => L._setFs(null));
  const dir = 'C:\\Proje\\MyInstants';
  const A = 'https://www.myinstants.com/media/sounds/bruh.mp3';
  const B = 'https://www.myinstants.com/media/sounds/bruh-2.mp3';

  // ilk ses
  let tg = await L.chooseTarget(dir, 'Bruh', A);
  assert.deepEqual([tg.name, tg.path, tg.exists], ['Bruh.mp3', 'C:\\Proje\\MyInstants\\Bruh.mp3', false]);
  await L.writeFileAtomic(tg.path, new Uint8Array([1, 2, 3]));
  await L.remember(dir, tg.index, tg.name, A);

  // aynı ses tekrar → aynı dosya, var
  tg = await L.chooseTarget(dir, 'Bruh', A);
  assert.deepEqual([tg.name, tg.exists], ['Bruh.mp3', true]);

  // aynı adda farklı ses → Bruh (2).mp3
  tg = await L.chooseTarget(dir, 'bruh', B);
  assert.deepEqual([tg.name, tg.exists], ['bruh (2).mp3', false]);
  await L.writeFileAtomic(tg.path, new Uint8Array([4]));
  await L.remember(dir, tg.index, tg.name, B);
  tg = await L.chooseTarget(dir, 'Bruh', B);
  assert.deepEqual([tg.name, tg.exists], ['Bruh (2).mp3', true]);

  // kayıt dosyası okunabilir JSON
  const idx = JSON.parse(fs.files.get('c:\\proje\\myinstants\\.myinstants.json').data.toString('utf8'));
  assert.deepEqual(Object.keys(idx.files).sort(), ['bruh (2).mp3', 'bruh.mp3']);

  // geçici dosya kalmadı
  assert.ok(![...fs.files.keys()].some((k) => k.includes('.part-')));
});

test('chooseTarget: kaydı olmayan ama var olan dosya aynı ses sayılır (tekrar indirilmez)', async (t) => {
  const fs = fakeFs();
  L._setFs(fs);
  t.after(() => L._setFs(null));
  await fs.writeFile('C:\\P\\MyInstants\\Vine Boom.mp3', new Uint8Array([9]));
  const tg = await L.chooseTarget('C:\\P\\MyInstants', 'Vine Boom', 'https://x/vine.mp3');
  assert.deepEqual([tg.name, tg.exists], ['Vine Boom.mp3', true]);
});

test('yazma hatası: geçici dosya silinir, hata türü anlaşılır', async (t) => {
  const fs = fakeFs();
  L._setFs(fs);
  t.after(() => L._setFs(null));
  fs.failWrite = 'EACCES';
  await assert.rejects(L.writeFileAtomic('C:\\Kilitli\\a.mp3', new Uint8Array([1])), (e) => e.kind === 'noperm');
  fs.failWrite = 'ENOSPC';
  await assert.rejects(L.writeFileAtomic('C:\\Dolu\\a.mp3', new Uint8Array([1])), (e) => e.kind === 'nospace');
  assert.equal(fs.files.size, 0);
});
