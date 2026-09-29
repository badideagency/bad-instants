// library.js testleri — gerçek geçici klasörle (%APPDATA% yerine).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('../extension/js/library.js');

function setup(t) {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-lib-'));
  L._reset();
  L.configure({ appData, fs: null });
  t.after(() => {
    L._reset();
    L.configure({ appData: null });
    fs.rmSync(appData, { recursive: true, force: true });
  });
  const p = L.paths();
  return { appData, p, json: () => JSON.parse(fs.readFileSync(p.file, 'utf8')) };
}

const item = (n) => ({
  id: 'ses-' + n,
  name: 'Ses ' + n + ' çğış',
  mp3: 'https://www.myinstants.com/media/sounds/ses-' + n + '.mp3',
  page: 'https://www.myinstants.com/en/instant/ses-' + n + '/',
});

test('ilk açılış: dosya yoksa boş liste; kayıt %APPDATA%\\BadIdea\\MyInstants\\library.json', async (t) => {
  const { appData, p } = setup(t);
  assert.equal(p.file, path.join(appData, 'BadIdea', 'MyInstants', 'library.json'));
  const r = await L.load();
  assert.deepEqual(r, { corrupt: false, backup: null, favorites: 0, recent: 0 });
  assert.deepEqual([L.favorites(), L.recent()], [[], []]);
});

test('favoriler: son eklenen üstte, diske yazılır, yeniden yüklenince kalır', async (t) => {
  const { json } = setup(t);
  await L.load();
  await L.addFavorite(item(1));
  await L.addFavorite(item(2));
  await L.addFavorite(item(1)); // tekrar eklemek çoğaltmaz
  assert.deepEqual(L.favorites().map((f) => f.id), ['ses-2', 'ses-1']);
  assert.deepEqual(json().favorites.map((f) => f.id), ['ses-2', 'ses-1']);
  assert.equal(json().favorites[1].name, 'Ses 1 çğış');
  L._reset(); // "panel yeniden açıldı"
  await L.load();
  assert.equal(L.isFavorite('ses-1'), true);
  assert.equal(L.favorites().length, 2);
});

test('son kullanılanlar: en yeni üstte, tekrar kullanılan başa geçer, en fazla 50', async (t) => {
  setup(t);
  await L.load();
  for (let i = 1; i <= 55; i++) await L.addRecent(item(i));
  await L.addRecent(item(10));
  const ids = L.recent().map((r) => r.id);
  assert.equal(ids.length, 50);
  assert.deepEqual(ids.slice(0, 3), ['ses-10', 'ses-55', 'ses-54']);
  assert.equal(ids.filter((x) => x === 'ses-10').length, 1);
});

test('bozuk library.json: panel çökmez, dosya .bak olarak kenara alınır, boş listeyle devam', async (t) => {
  const { p, json } = setup(t);
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.file, '{"favorites": [ {"id": "yarım yazıl');
  const r = await L.load();
  assert.equal(r.corrupt, true);
  assert.equal(r.backup, p.file + '.bak');
  assert.equal(fs.readFileSync(p.file + '.bak', 'utf8'), '{"favorites": [ {"id": "yarım yazıl'); // içerik korunur
  assert.ok(!fs.existsSync(p.file));
  assert.deepEqual(L.favorites(), []);
  await L.addFavorite(item(1)); // sonrası normal
  assert.deepEqual(json().favorites.map((f) => f.id), ['ses-1']);

  // ikinci kez bozulursa eski .bak ezilmez
  fs.writeFileSync(p.file, '[]');
  L._reset();
  const r2 = await L.load();
  assert.equal(r2.corrupt, true);
  assert.ok(r2.backup.endsWith('.bak') && r2.backup !== p.file + '.bak');
  assert.ok(fs.existsSync(p.file + '.bak'));
});

test('geçersiz yapı da bozuk sayılır', async (t) => {
  const { p } = setup(t);
  fs.mkdirSync(p.dir, { recursive: true });
  for (const bad of ['[]', '{"favorites":"x","recent":[]}', '{"favorites":[{"name":"kimliksiz"}],"recent":[]}', 'null']) {
    fs.writeFileSync(p.file, bad);
    L._reset();
    assert.equal((await L.load()).corrupt, true, bad);
  }
});

test('yazma: art arda kayıtlar sıraya girer, geçici dosya kalmaz, sonuç geçerli JSON', async (t) => {
  const { p, json } = setup(t);
  await L.load();
  await Promise.all([1, 2, 3, 4, 5, 6].map((n) => L.addFavorite(item(n))));
  assert.equal(json().favorites.length, 6);
  assert.deepEqual(fs.readdirSync(p.dir).filter((f) => f.includes('.tmp-')), []);
});

test('yerel arşiv: favorinin sesi saklanır, okunur; yıldız kaldırılınca silinir', async (t) => {
  const { p } = setup(t);
  await L.load();
  await L.addFavorite(item(1));
  assert.equal(L.localPath('ses-1'), null);
  assert.deepEqual((await L.missingLocal()).map((f) => f.id), ['ses-1']);
  const bytes = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);
  assert.equal(await L.storeLocal('ses-1', bytes), true);
  const lp = L.localPath('ses-1');
  assert.ok(lp.startsWith(p.audioDir) && fs.existsSync(lp));
  assert.deepEqual(new Uint8Array(await L.readLocal('ses-1')), bytes);
  assert.deepEqual(await L.missingLocal(), []);
  // kopya elle silinirse: okunamaz, yeniden arşivlenecekler listesine düşer
  fs.unlinkSync(lp);
  assert.equal(await L.readLocal('ses-1'), null);
  assert.deepEqual((await L.missingLocal()).map((f) => f.id), ['ses-1']);
  await L.storeLocal('ses-1', bytes);
  await L.removeFavorite('ses-1');
  assert.ok(!fs.existsSync(lp));
  assert.equal(L.localPath('ses-1'), null);
  // favori olmayanın sesi saklanmaz (son kullanılanlarda kopya yok)
  await L.addRecent(item(2));
  assert.equal(await L.storeLocal('ses-2', bytes), false);
  assert.deepEqual(fs.readdirSync(p.audioDir), []);
});

// Gerçek fs'nin üstüne hata enjekte edilebilen sarmalayıcı
function faultyFs(fail) {
  const real = fs.promises;
  return new Proxy(real, {
    get(target, op) {
      const fn = target[op];
      if (typeof fn !== 'function') return fn;
      return async (...args) => {
        const err = fail(op, args);
        if (err) throw Object.assign(new Error(err), { code: err });
        return fn.apply(target, args);
      };
    },
  });
}

test('kaydedilemezse bellekteki değişiklik de geri alınır', async (t) => {
  const { json } = setup(t);
  await L.load();
  await L.addFavorite(item(1));
  let failing = true;
  L.configure({ fs: faultyFs((op) => (failing && op === 'writeFile' ? 'EACCES' : null)) });
  await assert.rejects(L.addFavorite(item(2)), (e) => e.kind === 'write' && e.code === 'EACCES');
  assert.equal(L.isFavorite('ses-2'), false);
  await assert.rejects(L.removeFavorite('ses-1'));
  assert.equal(L.isFavorite('ses-1'), true);
  failing = false;
  await L.addFavorite(item(3));
  assert.deepEqual(json().favorites.map((f) => f.id), ['ses-3', 'ses-1']);
});

test('bozuk dosya taşınamazsa (kilitli) kopyası .bak olarak alınır', async (t) => {
  const { p } = setup(t);
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.file, 'bozuk{');
  L.configure({ fs: faultyFs((op, args) => (op === 'rename' && args[0] === p.file ? 'EBUSY' : null)) });
  const r = await L.load();
  assert.equal(r.corrupt, true);
  assert.equal(r.backup, p.file + '.bak');
  assert.equal(fs.readFileSync(p.file + '.bak', 'utf8'), 'bozuk{');
});
