/*
 * theme.js — BadIdea tasarım değişkenlerini Premiere'in panel rengine uyarlar.
 *
 * BadIdea Panel'in değerleri OKLCH ile ölçülmüş; Premiere'in Chromium'u (CEP 12 = Chromium 99)
 * oklch() ve color-mix() tanımıyor. Bu yüzden renkler burada hesaplanıp rgb() olarak yazılır.
 *
 *  - Zemin (yüzey-0) = Premiere'in kendi panel rengi → panel Premiere'in içinde yabancı durmaz.
 *  - Kart / yükseltilmiş / kaplama = BadIdea'nın aydınlık merdiveni (+0.07 L adımları),
 *    Premiere renginin tonuyla. Derinlik gölgeyle değil aydınlıkla.
 *  - Yazı krem (#fff7e9, saf beyaz yok). Soluk yazı ve durum renkleri, üzerinde durdukları
 *    yüzeyde WCAG 4.5:1'i sağlayacak şekilde ölçülerek seçilir.
 *  - Premiere açık temadaysa merdiven tersine döner, yazı koyulaşır.
 */
(function (root, factory) {
  var api = factory();
  if (root) root.Theme = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  /* ------------------------------------------------------------------ renk uzayı */

  const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  const clamp01 = (x) => Math.min(1, Math.max(0, x));

  // [0-255] sRGB → OKLCH {l, c, h}
  function rgbToOklch([r8, g8, b8]) {
    const r = toLinear(r8 / 255);
    const g = toLinear(g8 / 255);
    const b = toLinear(b8 / 255);
    const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
    const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
    const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
    const h = (Math.atan2(B, A) * 180) / Math.PI;
    return { l: L, c: Math.sqrt(A * A + B * B), h: h < 0 ? h + 360 : h };
  }

  // OKLCH → [0-255] sRGB (gamut dışı değerler kırpılır)
  function oklchToRgb({ l, c, h }) {
    const hr = (h * Math.PI) / 180;
    const A = c * Math.cos(hr);
    const B = c * Math.sin(hr);
    const l_ = l + 0.3963377774 * A + 0.2158037573 * B;
    const m_ = l - 0.1055613458 * A - 0.0638541728 * B;
    const s_ = l - 0.0894841775 * A - 1.291485548 * B;
    const L3 = l_ * l_ * l_;
    const M3 = m_ * m_ * m_;
    const S3 = s_ * s_ * s_;
    const r = 4.0767416621 * L3 - 3.3077115913 * M3 + 0.2309699292 * S3;
    const g = -1.2684380046 * L3 + 2.6097574011 * M3 - 0.3413193965 * S3;
    const b = -0.0041960863 * L3 - 0.7034186147 * M3 + 1.707614701 * S3;
    return [r, g, b].map((v) => Math.round(clamp01(toGamma(v)) * 255));
  }

  function luminance([r, g, b]) {
    return 0.2126 * toLinear(r / 255) + 0.7152 * toLinear(g / 255) + 0.0722 * toLinear(b / 255);
  }

  function contrast(a, b) {
    const x = luminance(a);
    const y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }

  const css = ([r, g, b], alpha) => (alpha === undefined ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`);

  // Rengi, verilen zeminlerin hepsinde en az `target` kontrast sağlayana kadar yazıya doğru (açık temada koyuya) iter.
  // Çok açılan/koyulaşan doygun renk ekranın gösterebileceği aralıktan taşar; o zaman doygunluk da azaltılır.
  function ensureContrast(color, backgrounds, target, lighten) {
    const c = Object.assign({}, color);
    for (let i = 0; i < 120; i++) {
      const rgb = oklchToRgb(c);
      if (backgrounds.every((bg) => contrast(rgb, bg) >= target)) return rgb;
      c.l = lighten ? Math.min(1, c.l + 0.01) : Math.max(0, c.l - 0.01);
      if ((lighten && c.l > 0.8) || (!lighten && c.l < 0.35) || c.l === 0 || c.l === 1) c.c *= 0.9;
    }
    return oklchToRgb(c);
  }

  /* ------------------------------------------------------------------ BadIdea değerleri */

  const KREM = [255, 247, 233]; // #fff7e9
  const WARM_HUE = 84.6; // kremin ekseni
  const STEP = 0.07; // yüzey merdiveni adımı (BadIdea: 0.145 / 0.215 / 0.285 / 0.355)
  // Durum aileleri (BadIdea koyu tema): dolu = dolgu (üzerinde krem yazı), metin = yazı/ikon
  const DURUM = {
    notr: { dolu: [0.532, 0.012, 84.6], metin: [0.74, 0.012, 84.6] },
    bilgi: { dolu: [0.532, 0.13, 250], metin: [0.74, 0.13, 250] },
    surec: { dolu: [0.538, 0.11, 75], metin: [0.744, 0.11, 75] },
    basari: { dolu: [0.52, 0.12, 150], metin: [0.728, 0.12, 150] },
    tehlike: { dolu: [0.55, 0.15, 27], metin: [0.756, 0.14, 27] },
  };
  const DEFAULT_BG = [35, 35, 35]; // Premiere'in varsayılan koyu panel rengi (Premiere dışında)

  /* ------------------------------------------------------------------ tema */

  // Premiere'in panel rengi (0-255) → CSS değişkenleri
  function build(bg) {
    const base = Array.isArray(bg) && bg.length >= 3 ? bg.slice(0, 3).map((v) => Math.round(v)) : DEFAULT_BG;
    const o = rgbToOklch(base);

    // Yazı: zeminde hangisi daha okunaklıysa (koyu zeminde krem, açık zeminde koyu)
    const DARK_TEXT = oklchToRgb({ l: 0.18, c: 0.01, h: WARM_HUE });
    const dark = contrast(KREM, base) >= contrast(DARK_TEXT, base);
    const text = dark ? KREM : DARK_TEXT;

    // Yüzey merdiveni: BadIdea'daki gibi yazıya doğru (koyu temada aydınlanarak). Adım, yazının en açık
    // yüzeyde (yüzey-2) de 4.5:1 kalacağı kadar kısaltılır; hiç yer yoksa (orta gri zemin) ters yöne döner.
    const at = (step, dirn, n) => (n === 0 ? base : oklchToRgb({ l: o.l + dirn * step * n, c: o.c, h: o.h }));
    let dirn = dark ? 1 : -1;
    let step = dark ? STEP : 0.045;
    while (step > 0.02 && contrast(text, at(step, dirn, 2)) < 4.5) step -= 0.005;
    if (contrast(text, at(step, dirn, 2)) < 4.5) {
      dirn = -dirn;
      step = 0.05;
    }
    const y = [0, 1, 2, 3].map((n) => at(step, dirn, n));

    const fill = text; // birincil eylem dolgusu: krem (açık temada koyu)
    const onFill = dark ? oklchToRgb({ l: 0.215, c: 0.018, h: WARM_HUE }) : KREM;
    // Soluk yazı: kart ve yükseltilmiş yüzeyde de 4.5:1
    const sonuk = ensureContrast({ l: dark ? 0.66 : 0.5, c: 0.015, h: WARM_HUE }, [y[0], y[1], y[2]], 4.6, dark);

    const vars = {
      '--yuzey-0': css(y[0]),
      '--yuzey-1': css(y[1]),
      '--yuzey-2': css(y[2]),
      '--yuzey-3': css(y[3]),
      '--metin': css(text),
      '--metin-sonuk': css(sonuk),
      '--kenar-zayif': css(text, dark ? 0.1 : 0.12),
      '--kenar-guclu': css(text, dark ? 0.15 : 0.2),
      '--birincil': css(fill),
      '--birincil-metin': css(onFill),
      '--kaydirma': css(y[3]),
      '--kaydirma-hover': css(at(step, dirn, 4.5)),
    };
    const measured = { metin: Math.min(contrast(text, y[0]), contrast(text, y[2])), sonuk: contrast(sonuk, y[2]) };
    for (const [name, v] of Object.entries(DURUM)) {
      const [ml, mc, mh] = v.metin;
      const [dl, dc, dh] = v.dolu;
      const metin = ensureContrast({ l: dark ? ml : 0.45, c: mc, h: mh }, [y[0], y[1], y[2]], 4.5, dark);
      const dolu = oklchToRgb({ l: dl, c: dc, h: dh });
      vars[`--${name}-metin`] = css(metin);
      vars[`--${name}-dolu`] = css(dolu);
      vars[`--${name}-yuzey`] = css(metin, 0.14);
      vars[`--${name}-kenar`] = css(metin, 0.32);
      measured[name] = contrast(metin, y[2]);
    }
    vars['--odak'] = vars['--bilgi-metin']; // odak halkası: bilgi mavisi (≥3:1)
    return { vars, dark, surfaces: y, text, sonuk, measured };
  }

  function apply(bg, target) {
    const t = build(bg);
    const el = target || (typeof document !== 'undefined' ? document.documentElement : null);
    if (el) {
      for (const [k, v] of Object.entries(t.vars)) el.style.setProperty(k, v);
      el.style.colorScheme = t.dark ? 'dark' : 'light';
      el.dataset.theme = t.dark ? 'dark' : 'light';
    }
    return t;
  }

  return { build, apply, rgbToOklch, oklchToRgb, contrast, KREM, DEFAULT_BG };
});
