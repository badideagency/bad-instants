# MyInstants Paneli — Geliştirme Günlüğü

Premiere Pro 2026 (Windows) için CEP paneli. myinstants.com'daki sesleri listeler, arar,
fareyle üstüne gelince önizler; **İndir** sesi indirip aktif sequence'te playhead'e koyar.
Favoriler ve son kullanılanlar bilgisayarda saklanır, favorilerin sesi yerel olarak arşivlenir.

Depo: `badideagency/bad-instants` · Son sürüm: **v0.5.2** · Geliştirme dalı: `claude/dreamy-thompson-x6cly9`

---

## Bu dosya nedir

Projede bugüne kadar yapılan her işin özeti. Kod GitHub'da; bu dosya "neyin neden böyle olduğunu"
tek yerde toplar. Kaynağın tamamı depodadır, bu dosya onun yerine geçmez.

---

## Ne işe yarar

- **Listeler:** Trending, Hall of Fame, Just Added, Kategoriler + site araması + "Daha fazla" ile sayfalama.
- **Favoriler / Son kullanılanlar:** Sekme çubuğunun en solunda sabit ikonlar (yıldız + saat).
- **Önizleme:** ~150 ms hover sonrası, tek seferde tek ses, ses seviyesi çubuğu (varsayılan %60).
- **İndir:** Sesi indirir ve aktif sequence'te playhead'e `overwriteClip` ile koyar.

---

## Mimari — neden böyle

- **Siteye yalnız panelin kendi Chromium'u gider** (`window.fetch`, `credentials:'include'`).
  Node siteye istek ATMAZ; Node yalnızca diske yazar. Böylece çerezler ve CORS tek yerde çözülür.
- **CEP 12 / Chromium 99:** `oklch()`, `color-mix()`, `:has` yok; renkler `theme.js`'te OKLCH ile
  hesaplanıp `rgb()` olarak yazılır. Node 17.7.1, mixed-context.
- **Manifest CEF ayarları:** `--enable-nodejs`, `--mixed-context`, `--disable-web-security`,
  `--disable-site-isolation-trials`, `--persist-session-cookies`, `--autoplay-policy=no-user-gesture-required`.
- **ExtendScript (ES3):** `host.jsx` import + boş track bulma + `overwriteClip` (ASLA insert) + teşhis.
  Zaman birimi önce tick (metin), sonra saniye denenir; yanlış düşen kendi klibimiz
  `trackItem.remove(false,false)` ile silinir; çalışan birim Premiere sürümü başına saklanır.

---

## Aşamalar ve sürümler

### Aşama 1 — Listeler + önizleme
Siteyi panelin kendi tarayıcısıyla okuma, bölge seçici (TR / Global US), sekmeler, arama,
hover önizleme, ses seviyesi. Cloudflare doğrulama sayfasını tanıyıp ayrıştırmama.

### Aşama 2 — İndir → import → timeline
Açık proje/sequence kontrolü, proje yanındaki `MyInstants` klasörüne atomik yazma,
`MyInstants` bin'ine import, A1'den başlayıp boş track'e `overwriteClip`, boş track yoksa QE ile
yeni ses track'i. Güvenlik: koymadan önce/sonra snapshot; mevcut klip değiştiyse "Ctrl+Z" uyarısı.

### İŞ 0 — Public öncesi gizli anahtar taraması
Temiz çıktı; token/parola yok.

### v0.3.0 / v0.3.1 — Panel içi güncelleme
`updater.js`: GitHub `releases/latest` (token yok, depo public), ZIP + `release.json` (boyut + SHA-256),
fflate ile açma (zip-slip kontrolü), `%APPDATA%\BadIdea\MyInstants\backup\<sürüm>` altında yedek (3 adet),
atomik yazma + otomatik geri dönüş, junction farkındalığı, git çalışma kopyası güncellenmez.
Panel menüsü (≡): yeniden yükle · güncellemeleri denetle · önceki sürüme dön · teşhis.
Etiket/Release GitHub Actions ile oluşturulur (tag push 403 veriyordu).

### v0.4.0 — Tasarım (BadIdea ailesi)
Krem yazı (`#fff7e9`), Premiere'in panel rengine uyan yüzey merdiveni (OKLCH), 5 durum ailesi,
Geist değişken yazı tipi (gömülü, OFL), Lucide ikonlar (ISC). WCAG ≥4.5 ölçülerek. Gölge/gradyan yok.

### v0.5.0 — Favoriler, Son kullanılanlar, yerel arşiv
- Kayıt localStorage'da DEĞİL: `%APPDATA%\BadIdea\MyInstants\library.json` (Node, geçici dosya +
  yeniden adlandırma; yarım yazma olmaz). Bozuksa `.bak` olarak kenara alınır, panel boş listeyle açılır,
  alt çubukta uyarı.
- Favorinin sesi `%APPDATA%\BadIdea\MyInstants\library\` altına kopyalanır; önizleme ve İndir önce bu
  kopyayı kullanır (site sesi silse de çalışır). Yıldız kaldırılınca kopya silinir.
- Son kullanılanlar: timeline'a konan son 50 ses; kopya tutulmaz.

### v0.5.1 — Sabit ikon sekmeler
Favoriler (yıldız) ve Son kullanılanlar (saat) en solda sabit; ayraçtan sonra site sekmeleri;
sığmazsa yalnız onlar yatay kayar. Seçili ikon sekme yazılılarla aynı görünümde.

### v0.5.2 — Doğrulama mesajı + güvenlik
- Premiere panellerin yeni pencere açmasına izin vermediği için çalışmayan "Doğrula" tuşu kaldırıldı.
  Panel artık doğrulama sayfası AÇMAZ: "Site şu an doğrulama istiyor" der + "Tekrar dene"; site açılınca
  "Site yeniden açık". Kesin engel ("Sorry, you have been blocked") ayrı mesajla.
- `.debug` yayınlanan pakete girmez; güncelleme onu kurulumdan da kaldırır (geliştirici modu açıkken
  başka programların paneli dışarıdan yönetebileceği kapı).

---

## Değişmez kurallar (güvenlik + kapsam)

- **YASAK:** proxy, captcha çözücü, User-Agent/TLS taklit kütüphaneleri (curl-impersonate vb.),
  üçüncü parti scraping servisleri. Tarayıcı yolu da çalışmazsa durulur ve kullanıcıya söylenir.
- Node'un `https` modülüyle siteye istek ATILMAZ. Tüm site istekleri panelin Chromium `fetch`'inden.
- `cep.util.openURLInDefaultBrowser` KULLANILMAZ (sistem tarayıcısının çerezleri ayrı).
- Depo public; token kullanılmaz.
- Timeline: `overwriteClip`, ASLA insert. Ctrl+Z uyarısı yalnız mevcut bir klip gerçekten değiştiyse.

> Not: Cloudflare doğrulaması site tarafında; panel onu aşmaya çalışmaz. Doğrulamayı seyrekleştirmenin
> meşru yolu siteyi daha az yormak; kalıcı çözüm site sahibinden izin ya da resmi API'li bir kaynak.

---

## Klasör düzeni

```
extension/            Premiere'e bağlanan panel
  CSXS/manifest.xml   panel tanımı (PPRO [26.0,99.9], CEP 12, Node açık)
  index.html, css/    görünüm
  js/theme.js         BadIdea renklerini Premiere'e uyarlama (OKLCH)
  js/icons.js         Lucide ikonları
  fonts/              Geist (OFL)
  js/siteScraper.js   myinstants.com'u okuyan TEK dosya
  js/localFiles.js    diske yazma, dosya adı kuralları (Node)
  js/library.js       Favoriler / Son kullanılanlar + yerel ses arşivi (%APPDATA%)
  js/main.js          arayüz davranışı, İndir iş sırası, güncelleme / menü
  js/updater.js       panel içi güncelleme
  js/vendor/fflate.js saf JS ZIP (MIT)
  jsx/host.jsx        Premiere tarafı (ES3)
install.bat / uninstall.bat
tools/release.js, tools/build-release.js
release-notes/        her sürümün Türkçe notu
.github/workflows/    main'e sürüm gelince etiket + Release
tests/                geliştirme testleri
```

---

## Testler

- Birim (`node --test`): siteScraper, localFiles, library, updater, theme, host.jsx (sahte Premiere, ES3). 62 test.
- Uçtan uca (Playwright, headless Chromium): `test:ui`, `test:stage2`, `test:update`, `test:library`, `test:design`.
- Sahteler: `fake-site.js` (Cloudflare benzeri), `fake-premiere.js`, `fake-disk.js` (bellekte Windows yollu disk).

Çalıştırma:
```
npm install
npm test
npm run test:ui && npm run test:stage2 && npm run test:update && npm run test:library && npm run test:design
```

---

## Kurulum (Windows)

1. PlayerDebugMode açık olmalı: `reg add "HKCU\Software\Adobe\CSXS.12" /v PlayerDebugMode /t REG_SZ /d 1 /f`
2. Projeyi kalıcı bir klasöre koyun, `install.bat`'a çift tıklayın (junction kurar, yönetici gerekmez).
3. Premiere'i yeniden başlatın → Window > Extensions > MyInstants.

Güncelleme panel içinden yapılır (alt çubuktaki çip). Kaldırmak için `uninstall.bat`
(favorilere dokunmaz; onlar `%APPDATA%\BadIdea\MyInstants`'ta).

---

## Açık konu

- **Kırmızıda kalan sesler:** Önizleme çalınamayınca satır kırmızı kalıyor ama sebep hep yazmıyor.
  Önerilen v0.5.3: her kırmızı sesin sebebini göstermek (sitede yok / doğrulama / biçim çalınamıyor),
  dosya inebiliyorsa indirilen kopyadan çalmayı denemek, siteyi daha az yormak (çalınanı sakla,
  hızlı geçişte istek atma, doğrulama gelince bekle).
