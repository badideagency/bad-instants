// host.jsx (Premiere tarafı) testleri — sahte Premiere içinde çalışır.
// Çalıştırma: npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const { createPremiere } = require('./fake-premiere');

const MP3 = 'C:\\Projeler\\Test\\MyInstants\\Vine Boom Sound.mp3';

test('host.jsx yalnızca ES3 kullanır (ExtendScript uyumu)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'jsx', 'host.jsx'), 'utf8');
  assert.doesNotThrow(() => acorn.parse(src, { ecmaVersion: 3 }));
  // ES5+ yardımcıları ExtendScript'te yok
  const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\.indexOf\(|\.trim\(|JSON\.|Date\.now|Object\.keys|Array\.isArray|\.forEach\(/);
});

test('proje / sequence yoksa uyarı kodu döner', () => {
  const p = createPremiere();
  p.project.activeSequence = null;
  assert.equal(p.place(MP3).code, 'nosequence');
  assert.equal(JSON.parse(p.call('mi_context()')).code, 'nosequence');
  p.context.app.project = null;
  assert.equal(p.place(MP3).code, 'noproject');
});

test('indirme klasörü: proje yanı, kaydedilmemişse Belgeler', () => {
  const saved = createPremiere();
  assert.equal(JSON.parse(saved.call('mi_context()')).folder, 'C:\\Projeler\\Test\\MyInstants');
  const unsaved = createPremiere({ projectPath: '', savedFiles: [] });
  const c = JSON.parse(unsaved.call('mi_context()'));
  assert.deepEqual([c.folder, c.projectSaved], ['C:\\Users\\Test\\Documents\\MyInstants', false]);
  const untitled = createPremiere({ projectPath: 'C:\\Temp\\Untitled.prproj', savedFiles: [] });
  assert.equal(JSON.parse(untitled.call('mi_context()')).folder, 'C:\\Users\\Test\\Documents\\MyInstants');
});

test('ilk kullanım: bin oluşur, import edilir, A1 playhead\'e (10 sn) tick ile konur', () => {
  const p = createPremiere();
  p.addClip(0, 0, 5, 'Röportaj'); // A1'de 0-5 sn arası klip; playhead 10 sn
  const r = p.place(MP3);
  assert.deepEqual([r.ok, r.track, r.unit, r.binCreated, r.imported], [true, 1, 'ticks', true, true]);
  assert.deepEqual(p.clips(0), [[0, 5, 'Röportaj'], [10, 11.5, 'Vine Boom Sound.mp3']]);
  assert.deepEqual(p.bins(), [['MyInstants', ['Vine Boom Sound.mp3']]]);
  assert.deepEqual(p.log, ['createBin', 'importFiles', 'overwriteClip']); // 3 geri alma adımı
});

test('aynı dosya tekrar: yeniden import yok, A1 dolu olduğu için A2', () => {
  const p = createPremiere();
  p.place(MP3);
  p.log.length = 0;
  const r = p.place(MP3);
  assert.deepEqual([r.ok, r.track, r.imported, r.binCreated], [true, 2, false, false]);
  assert.deepEqual(p.log, ['overwriteClip']); // 1 geri alma adımı
  assert.equal(p.bins()[0][1].length, 1);
});

test('dosya projede başka bir bin\'de, farklı büyük/küçük harfle: yine yeniden import yok', () => {
  const p = createPremiere();
  const other = p.project.rootItem.createBin('Sesler');
  p.project.importFiles([MP3.toLowerCase()], true, other, false);
  p.log.length = 0;
  const r = p.place(MP3);
  assert.deepEqual([r.ok, r.imported, r.binCreated], [true, false, false]);
  assert.deepEqual(p.log, ['overwriteClip']);
});

test('boş aralık kuralı: tam playhead\'de biten klip engel değil, kısmen örten klip engel', () => {
  const p = createPremiere();
  p.addClip(0, 0, 10, 'Tam sınırda biter'); // A1 [0,10] → playhead 10'da boş
  p.addClip(1, 11, 20, 'Aralığa girer'); // A2 [11,20] → [10, 11.5] ile çakışır
  assert.equal(p.place(MP3).track, 1);
  const q = createPremiere();
  q.addClip(0, 9, 10.2, 'Playhead\'i örter');
  q.addClip(1, 11, 20, 'Aralığa girer');
  assert.equal(q.place(MP3).track, 3);
  assert.deepEqual(q.clips(0), [[9, 10.2, 'Playhead\'i örter']]); // dokunulmadı
  assert.deepEqual(q.clips(1), [[11, 20, 'Aralığa girer']]);
});

test('süre kare süresine yukarı yuvarlanır ve panel süresi daha uzunsa o kullanılır', () => {
  // 25 fps → kare 0.04 sn. Premiere süresi 1.4 sn (tam 35 kare) → aralık [10, 11.4]
  const noPanel = createPremiere({ defaultDuration: 1.4 });
  noPanel.addClip(0, 11.45, 20, 'Hemen sonra');
  assert.equal(noPanel.place(MP3).track, 1); // 11.45'teki klip aralığın dışında
  // Panel 1.45 sn ölçtü → 1.48'e yuvarlanır → aralık [10, 11.48] → 11.45'teki klip çakışır
  const p = createPremiere({ defaultDuration: 1.4 });
  p.addClip(0, 11.45, 20, 'Hemen sonra');
  assert.equal(p.place(MP3, 1.45).track, 2);
  // 1.5 sn = 37.5 kare → 38 kareye (1.52 sn) yukarı yuvarlanır → 11.51'deki klip çakışır
  const f = createPremiere({ defaultDuration: 1.5 });
  f.addClip(0, 11.51, 20, 'Hemen sonra');
  assert.equal(f.place(MP3).track, 2);
  const q = createPremiere({ reportDuration: false }); // Premiere süreyi okuyamıyor
  assert.equal(q.place(MP3, 2).ok, true);
  const z = createPremiere({ reportDuration: false });
  assert.equal(z.place(MP3, 0).code, 'noduration');
});

test('kilitli track atlanır (DOM ya da QE ile okunur)', () => {
  for (const lockApi of ['dom', 'qe']) {
    const p = createPremiere({ lockApi });
    p.seq.audioTracks[0]._locked = true;
    const r = p.place(MP3);
    assert.deepEqual([r.ok, r.track, r.lockInfo], [true, 2, 'known'], lockApi);
    assert.equal(p.clips(0).length, 0);
  }
});

test('kilit bilgisi okunamazsa: kilitli track\'e konamayınca sıradakine geçilir', () => {
  const p = createPremiere({ lockApi: 'none', lockEnforced: true });
  p.seq.audioTracks[0]._locked = true;
  const r = p.place(MP3);
  assert.deepEqual([r.ok, r.track, r.lockInfo], [true, 2, 'unknown']);
});

test('sese uymayan track (ör. 5.1) atlanır', () => {
  const p = createPremiere();
  p.seq.audioTracks[0]._channel = '5.1';
  assert.equal(p.place(MP3).track, 2);
});

test('boş track yoksa QE ile yeni ses track\'i eklenir ve oraya konur', () => {
  const p = createPremiere({ audioTracks: 2 });
  p.addClip(0, 0, 60);
  p.addClip(1, 5, 15);
  p.log.length = 0;
  const r = p.place(MP3);
  assert.deepEqual([r.ok, r.track, r.addedTrack], [true, 3, true]);
  assert.deepEqual(p.clips(2), [[10, 11.5, 'Vine Boom Sound.mp3']]);
  assert.deepEqual(p.clips(0), [[0, 60, 'Mevcut klip']]);
  assert.ok(p.log.includes('addTracks'));
});

test('yeni track ortaya eklenirse bile doğru (boş) track bulunur', () => {
  const p = createPremiere({ audioTracks: 2 });
  p.addClip(0, 0, 60);
  p.addClip(1, 0, 60);
  // QE yeni track'i A1'in arkasına eklesin (sıra kayması)
  const realQe = p.context.app.enableQE;
  p.context.app.enableQE = function () {
    realQe();
    const get = p.context.qe.project.getActiveSequence;
    p.context.qe.project.getActiveSequence = () => {
      const q = get();
      const add = q.addTracks;
      q.addTracks = (nv, va, na, t) => add(nv, va, na, t, 1);
      return q;
    };
  };
  const r = p.place(MP3);
  assert.deepEqual([r.ok, r.track], [true, 2]);
  assert.deepEqual(p.clips(0), [[0, 60, 'Mevcut klip']]);
  assert.deepEqual(p.clips(2), [[0, 60, 'Mevcut klip']]);
});

test('track eklenemezse uyarı kodu', () => {
  const p = createPremiere({ audioTracks: 1, qeAddTracks: false });
  p.addClip(0, 0, 60);
  assert.equal(p.place(MP3).code, 'notrack');
  assert.deepEqual(p.clips(0), [[0, 60, 'Mevcut klip']]);
});

test('zaman birimi: Premiere metni saniye sayarsa → uzağa düşen kendi klibini siler, saniye ile koyar', () => {
  const p = createPremiere({ timeMode: 'seconds' });
  p.addClip(0, 0, 5, 'Röportaj');
  const r = p.place(MP3);
  assert.deepEqual([r.ok, r.track, r.unit], [true, 1, 'seconds']);
  assert.deepEqual(p.clips(0), [[0, 5, 'Röportaj'], [10, 11.5, 'Vine Boom Sound.mp3']]);
  assert.ok(p.log.includes('remove(false,false)')); // ripple yok
});

test('zaman birimi: her şey tick ise ilk deneme (tick) tutar', () => {
  const p = createPremiere({ timeMode: 'ticks' });
  p.addClip(0, 0, 5);
  const r = p.place(MP3);
  assert.deepEqual([r.ok, r.unit], [true, 'ticks']);
  assert.deepEqual(p.clips(0)[0], [0, 5, 'Mevcut klip']);
});

test('kaydedilen birim kullanılır; ikinci deneme yapılmaz', () => {
  const p = createPremiere({ timeMode: 'seconds' });
  p.place(MP3, 0, 'seconds');
  assert.equal(p.log.filter((x) => x === 'overwriteClip').length, 1);
});

test('mevcut klip değişirse (yanlış birim ~0. saniyeye yazdı) → "damaged": Ctrl+Z uyarısı, kendi klibine dokunmaz', () => {
  // Kayıtlı birim yanlış ("seconds") ama Premiere sayıyı tick sayıyor → 10 tick ≈ 0. sn, A1'deki klibin üstü
  const p = createPremiere({ timeMode: 'ticks' });
  p.addClip(0, 0, 5, 'Röportaj');
  const r = p.place(MP3, 0, 'seconds');
  assert.deepEqual([r.ok, r.code], [false, 'damaged']);
  assert.ok(!p.log.some((x) => x.startsWith('remove')));
});

test('yanlış yere düşen klip silinemezse → "cleanupfailed"', () => {
  const p = createPremiere({ timeMode: 'seconds', brokenRemove: true });
  assert.equal(p.place(MP3).code, 'cleanupfailed');
});

test('iki birim de tutmazsa → "unitfailed", timeline değişmemiş', () => {
  const p = createPremiere({ timeMode: 'seconds' });
  p.addClip(0, 0, 5, 'Röportaj');
  // Saniye denemesinde de yanlış yere düşsün: playhead'i sahte olarak kaydır
  const track = p.seq.audioTracks[0];
  const real = track.overwriteClip;
  track.overwriteClip = (item, time) => real(item, typeof time === 'number' ? time + 100 : time);
  const r = p.place(MP3);
  assert.equal(r.code, 'unitfailed');
  assert.deepEqual(p.clips(0), [[0, 5, 'Röportaj']]);
});

test('mi_diag hangi yolların çalıştığını raporlar', () => {
  const d = JSON.parse(createPremiere({ lockApi: 'qe' }).call('mi_diag()'));
  assert.deepEqual(
    [d.version, d.hasSequence, d.domIsLocked, d.qeIsLocked, d.qeAddTracks, d.findByPath],
    ['26.5.1', true, false, true, true, true]
  );
});

test('mi_json özel karakterleri ve Türkçeyi doğru kodlar', () => {
  const p = createPremiere();
  const s = p.call('mi_json({a: "Değirmenci \\"Dayı\\"\\n\\\\x", b: [1, true, null]})');
  assert.deepEqual(JSON.parse(s), { a: 'Değirmenci "Dayı"\n\\x', b: [1, true, null] });
});
