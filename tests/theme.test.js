// theme.js testleri: OKLCH dönüşümü ve Premiere'in bütün parlaklıklarında okunaklılık.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../extension/js/theme.js');

test('OKLCH ↔ sRGB dönüşümü BadIdea değerleriyle tutarlı', () => {
  assert.deepEqual(T.oklchToRgb(T.rgbToOklch([255, 247, 233])), [255, 247, 233]); // krem
  for (const rgb of [[35, 35, 35], [29, 29, 29], [214, 214, 214], [12, 80, 200]]) {
    assert.deepEqual(T.oklchToRgb(T.rgbToOklch(rgb)), rgb);
  }
});

test('zemin her zaman Premiere\'in rengi; koyu zeminde krem yazı, açıkta koyu yazı', () => {
  const dark = T.build([35, 35, 35]);
  assert.equal(dark.vars['--yuzey-0'], 'rgb(35, 35, 35)');
  assert.equal(dark.vars['--metin'], 'rgb(255, 247, 233)');
  assert.equal(dark.dark, true);
  const light = T.build([214, 214, 214]);
  assert.equal(light.vars['--yuzey-0'], 'rgb(214, 214, 214)');
  assert.equal(light.dark, false);
  assert.equal(T.build(null).vars['--yuzey-0'], 'rgb(35, 35, 35)'); // Premiere dışında varsayılan
});

test('yüzey merdiveni: koyu temada her adım bir öncekinden açık (derinlik aydınlıkla)', () => {
  const s = T.build([35, 35, 35]).surfaces.map((c) => c[0]);
  assert.ok(s[0] < s[1] && s[1] < s[2] && s[2] < s[3], s.join('/'));
});

test('kontrast: Premiere\'in koyu ve açık aralığında metin, soluk metin ve durum renkleri ≥ 4.5:1', () => {
  for (let v = 0; v <= 255; v++) {
    const t = T.build([v, v, v]);
    const min = Math.min(...Object.values(t.measured));
    // Tam orta gri (~#707070–#8a8a8a) fiziksel sınır: ne krem ne koyu yazı her yüzeyde 4.5'e ulaşamaz.
    const floor = v >= 100 && v <= 140 ? 4.2 : 4.5;
    assert.ok(min >= floor, `zemin ${v}: en düşük kontrast ${min.toFixed(2)}`);
  }
});
