# MyInstants — Premiere Pro paneli

Premiere Pro 2026 (Windows) için CEP paneli. myinstants.com'daki sesleri listeler, arar,
fareyle üstüne gelince önizleme çalar; **⬇ İndir** sesi indirip aktif sequence'te playhead'e koyar.

## İndir tuşu ne yapar

1. Açık proje ve aktif sequence yoksa uyarır, hiçbir şey indirmez.
2. Klasör: projenin (.prproj) yanındaki `MyInstants`; proje kaydedilmemişse `Belgeler\MyInstants`.
3. Dosya adı ses adından türetilir (Windows'ta geçersiz karakterler temizlenir, Türkçe korunur).
   Dosya zaten varsa tekrar indirilmez. Aynı adda farklı bir ses gelirse `Ad (2).mp3` olur
   (hangi dosyanın hangi sese ait olduğu klasördeki `.myinstants.json` dosyasında tutulur).
4. İndirme panelin tarayıcısıyla yapılır; Node yalnızca diske yazar (önce geçici dosyaya, sonra asıl adına).
5. Premiere: dosya projede zaten varsa (yol eşleşmesi) mevcut öğe kullanılır; yoksa `MyInstants` bin'ine import edilir.
6. A1'den başlayarak kilitsiz ve `[playhead, playhead + süre]` aralığı tamamen boş ilk ses track'i seçilir;
   ses oraya **overwriteClip** ile konur (insert asla kullanılmaz). Boş track yoksa en alta yeni ses track'i eklenir.
7. Güvenlik: koymadan önce ve sonra bütün ses track'leri karşılaştırılır. Yeni klip yanlış yere düştüyse
   panel kendi klibini (ripple olmadan) siler ve diğer zaman birimiyle bir kez daha dener; mevcut bir klip
   değiştiyse durur ve "Ctrl+Z ile geri alın" der. Çalışan zaman birimi Premiere sürümü başına saklanır.

Geri alma (Ctrl+Z): Premiere'in ExtendScript'inde işlemleri tek adımda toplama imkânı yok.
Bin var + dosya daha önce import edilmiş → 1 adım; dosya yeni → 2; projede ilk kullanım → 3; yeni track eklendiyse +1.

Teşhis: alt çubuktaki yeşil "Premiere … ✓" yazısına ya da panel menüsünde (≡) **Teşhis**'e tıklayın.

## Favoriler ve Son kullanılanlar

- **Sekmeler:** Favoriler (yıldız ikonu) ve Son kullanılanlar (saat ikonu) sekme çubuğunun en solunda sabittir, her
  genişlikte görünür (üstüne gelince adı yazar). İnce ayraçtan sonra site sekmeleri gelir; sığmazsa yalnız onlar
  yatay kayar (fare tekerleğiyle de).
- **Yıldız:** Her sesin yanındaki yıldıza tıklayınca ses **Favoriler** sekmesine eklenir (son eklenen üstte, sınır yok).
  Favoriler sekmesinde yıldızı kaldırılan ses soluklaşır; sekmeden çıkana kadar geri yıldızlanabilir.
- **Son kullanılanlar:** İndir ile timeline'a başarıyla konan son 50 ses (en yeni üstte). Önizleme sayılmaz.
- Bu iki sekmede bölge seçici pasiftir ve "Daha fazla" yoktur (hepsi birden gösterilir).
- **Kayıt yeri:** `%APPDATA%\BadIdea\MyInstants\library.json` (localStorage DEĞİL: CEP'in depolaması `%TEMP%\cep_cache`
  altında ve Premiere sürümüne bağlı; Premiere güncellemesi ya da Temp temizliği silebilir). Dosya Node ile önce geçici
  dosyaya yazılır, sonra asıl adına taşınır; yarım yazma olmaz.
- **Favori = yerel arşiv:** Yıldızlanan sesin kopyası arka planda `%APPDATA%\BadIdea\MyInstants\library\` altına alınır
  (önizlemede indirildiyse tarayıcının önbelleğinden). Önizleme ve İndir önce bu kopyayı kullanır; site sesi silse de
  favori çalışır. Kopya alınamazsa (bağlantı yok, doğrulama…) bir sonraki açılışta ya da Favoriler'de Yenile'ye
  basınca yeniden denenir. Yıldız kaldırılınca kopya silinir. Son kullanılanlar için kopya tutulmaz.
- **Dosya bozuksa:** Panel çökmez; bozuk dosya `library.json.bak` olarak kenara alınır (içeriği korunur), boş listeyle
  devam edilir, alt çubukta "Favoriler dosyası bozuktu" uyarısı çıkar (tıklayınca yedeğin yeri görünür).
- Bölge ve ses seviyesi gibi küçük ayarlar localStorage'da kalır.

## Güncelleme (panelin içinden)

- Panel açılışta ve 6 saatte bir GitHub'daki son sürüme bakar (token yok; depo public). Yeni sürüm varsa
  alt çubukta **"vX.Y.Z hazır — Güncelle"** çıkar; tıklayınca değişiklik notu gösterilir.
- **Güncelle:** ZIP indirilir, boyutu ve SHA-256 özeti `release.json` ile karşılaştırılır, paketle gelen saf JS
  (fflate) ile açılır, güvensiz yollar ve başka eklentilere ait paketler reddedilir. Mevcut sürüm
  `%APPDATA%\BadIdea\MyInstants\backup\<sürüm>` altına yedeklenir (CEP klasörünün dışında), dosyalar değiştirilir.
  Herhangi bir adımda hata olursa yedek otomatik geri yüklenir.
- Kurulum bağlantı (junction) ise gerçek klasör güncellenir; kopya ise kopya. Gerçek klasör bir git çalışma
  kopyasındaysa otomatik güncelleme yapılmaz (git pull kullanın).
- Sonrası: `manifest.xml`'in ayarları değiştiyse "Premiere'i yeniden başlatın" denir; değişmediyse `host.jsx`
  `$.evalFile` ile yeniden yüklenir ve panel yenilenir.
- **Panel menüsü (≡):** Paneli yeniden yükle · Güncellemeleri denetle · Önceki sürüme dön · Teşhis.

## Tasarım

- BadIdea Panel'in tasarım dili: krem yazı (`#fff7e9`, saf beyaz yok), 4 basamaklı yüzey merdiveni
  (derinlik gölgeyle değil aydınlıkla), 5 durum ailesi (nötr / bilgi / süreç / başarı / tehlike),
  5 / 6 / 8 px köşe yarıçapı, 8 px ızgara, ağırlıklar 400 / 500 / 600. Gölge, bulanıklık ve süs gradyanı yok;
  krem dolgu yalnızca birincil eylemde.
- Zemin Premiere'in panel rengidir (`appSkinInfo`); diğer yüzeyler ve renkler `js/theme.js`'te OKLCH ile
  hesaplanır (Premiere'in Chromium'u `oklch()` bilmediği için sonuç `rgb()` olarak yazılır). Yazı ve durum
  renkleri, üzerinde durdukları yüzeyde WCAG 4.5:1'i sağlayacak şekilde ölçülerek seçilir.
- Yazı tipi: **Geist** (değişken, `fonts/Geist-Variable.woff2`, SIL OFL) — pakete gömülü, internet gerekmez.
- İkonlar: **Lucide** (`js/icons.js`, ISC) — yalnızca kullanılanlar.
- `.claude/skills/emil-design-eng` (MIT) depoda. Lisansı belli olmayan `critique` ve `ui-ux-pro-max` skill'leri
  yalnızca yerelde kullanılır, depoya girmez (`.gitignore`).

## Siteye nasıl bağlanır

- Bütün istekler **panelin kendi Chromium'uyla** yapılır (`fetch`, çerezler dahil). Node siteye istek atmaz;
  Node yalnızca (Aşama 2'de) indirilen dosyayı diske yazar.
- CORS'a takılmamak için manifest'te `--disable-web-security` açıktır.
- Site Cloudflare doğrulaması isterse panel ayrıştırmaya çalışmaz; **"Site doğrulama istiyor"** der ve
  **Doğrula** tuşunu gösterir. Tuş myinstants.com'u panelin kendi Chromium'unda küçük bir pencerede açar
  (`window.open`; sistem tarayıcısı KULLANILMAZ, onun çerezleri ayrıdır). Doğrulamayı yapıp pencereyi
  kapatınca istek kendiliğinden tekrarlanır.
- Doğrulamadan sonra açılışta site yine doğrulama isterse panel bunu açıkça yazar
  ("yeniden açılınca doğrulama korunmamış"). Çerezlerin kalması için `--persist-session-cookies` açıktır.

## Klasörler

```
extension/            ← Premiere'e bağlanan panel klasörü
  CSXS/manifest.xml   ← panel tanımı (PPRO [26.0,99.9], CEP 12, Node.js açık)
  index.html, css/    ← görünüm
  js/theme.js         ← BadIdea renklerini Premiere'in panel rengine uyarlama (OKLCH, kontrast)
  js/icons.js         ← Lucide ikonları (ISC)
  fonts/              ← Geist değişken yazı tipi (SIL OFL)
  js/siteScraper.js   ← myinstants.com'u okuyan TEK dosya (site değişirse yalnız burası düzeltilir)
  js/localFiles.js    ← diske yazma, dosya adı kuralları (Node)
  js/library.js       ← Favoriler / Son kullanılanlar kaydı ve favorilerin yerel ses arşivi (%APPDATA%)
  js/main.js          ← arayüz davranışı, İndir iş sırası, güncelleme / panel menüsü
  js/updater.js       ← panel içi güncelleme (denetim, doğrulama, yedek, kurulum, geri dönüş)
  js/vendor/fflate.js ← saf JS ZIP kütüphanesi (MIT)
  js/CSInterface.js   ← Adobe'nin resmi CEP 12 dosyası
  jsx/host.jsx        ← Premiere tarafı (ExtendScript, ES3): import, boş track bulma, overwrite, teşhis
  .debug              ← hata ayıklama portu (8871)
install.bat           ← paneli kurar (bağlantı/junction ile)
uninstall.bat         ← paneli kaldırır
tools/site-probe.bat  ← YALNIZ TEŞHİS: sitenin yapısını PowerShell ile raporlar (panelin davranışını göstermez)
tools/release.js      ← tek komutla sürüm yayınlama (npm run release -- X.Y.Z)
tools/build-release.js← sürüm paketi (ZIP + release.json)
release-notes/        ← her sürümün kısa Türkçe değişiklik notu (vX.Y.Z.md)
.github/workflows/    ← main'e yeni sürüm gelince etiketi ve Release'i oluşturan GitHub Actions
tests/                ← geliştirme testleri (panelin çalışması için gerekmez)
```

## Kurulum (Windows)

1. **PlayerDebugMode** açık olmalı (imzasız paneller için şart). Kontrol:
   ```
   reg query "HKCU\Software\Adobe\CSXS.12" /v PlayerDebugMode
   ```
   `REG_SZ 1` görünmüyorsa açmak için:
   ```
   reg add "HKCU\Software\Adobe\CSXS.12" /v PlayerDebugMode /t REG_SZ /d 1 /f
   ```
2. Bu projeyi kalıcı bir klasöre indirin (ör. `C:\dev\bad-instants`). Panel bu klasöre bağlanacağı için
   klasörü sonradan taşımayın; taşırsanız `install.bat`'ı yeniden çalıştırın.
3. `install.bat`'a çift tıklayın. `%APPDATA%\Adobe\CEP\extensions\com.badidea.myinstants`
   konumuna `extension` klasörünü gösteren bir bağlantı oluşturur. Yönetici izni gerekmez.
4. Premiere'i yeniden başlatın → **Window > Extensions > MyInstants**.

Kodu güncelledikten sonra paneli kapatıp açmanız yeterli; olmazsa Premiere'i yeniden başlatın.
Kaldırmak için `uninstall.bat` (proje klasörüne ve favorilere dokunmaz; yeniden kurunca favoriler yerindedir).
Favorileri ve güncelleme yedeklerini de silmek isterseniz `%APPDATA%\BadIdea\MyInstants` klasörünü silin.

## Site kontrol aracı (yalnız teşhis içindir)

`tools\site-probe.bat` → myinstants.com'dan örnek sayfaları PowerShell ile indirir ve sayfa yapısını
(ses kutuları, mp3 adresleri, sayfalama, kategori linkleri, TR/US bölge kodları) raporlar.
Rapor `tools\site-probe-sonuc.txt` dosyasına yazılır. Hiçbir şeyi değiştirmez.

**Dikkat:** PowerShell panelden farklı bir istemcidir; Cloudflare ona farklı davranabilir. Bu yüzden
raporun sonucu panelin çalışıp çalışmayacağını GÖSTERMEZ. Asıl test panelin kendisidir. Araç yalnızca,
panel "sitenin yapısı değişmiş olabilir" dediğinde HTML'e bakmak için kullanılır.

## Hata ayıklama

Panel Premiere'de açıkken Chrome'da `http://localhost:8871` → panelin Console'u.

## Sürüm yayınlama (geliştirici)

1. `release-notes/vX.Y.Z.md` dosyasına kısa Türkçe değişiklik notunu yazın ve commit'leyin.
2. `npm run release -- X.Y.Z` (denemek için sonuna `--dry-run`).
   Testler çalışır → sürüm manifest/package.json'da yükseltilir → paket denenir → commit → `main`'e gönderilir.
   GitHub Actions `main`'deki yeni sürümü görünce testleri çalıştırır, ZIP + `release.json`'ı hazırlar,
   `vX.Y.Z` etiketini atar ve Release'i yayınlar (kişisel token gerekmez).

## Geliştirici testleri (isteğe bağlı, Node.js gerekir)

```
npm install
npm test          # siteScraper, localFiles, library, updater, theme ve host.jsx (sahte Premiere içinde; ES3 uyumu dahil)
npm run test:ui   # paneli manifest'teki CEF ayarlarıyla headless Chromium'da açar; www.myinstants.com adını
                  # Cloudflare benzeri sahte bir siteye (tests/fake-site.js) yönlendirip gerçek fetch yolunu,
                  # Doğrula penceresini, çerez paylaşımını ve yeniden açılışta çerezin kalmasını dener
npm run test:stage2 # İndir → diske yaz → import → timeline akışı (sahte site + sahte Premiere + sahte disk)
npm run test:update # panel içi güncelleme: sahte GitHub, gerçek geçici kurulum klasörü, menü, geri dönüş
npm run test:design # tasarım denetimi: bütün durumların ekran görüntüsü, Geist + Türkçe harfler, kontrast, dar panel
npm run test:library # favoriler: bozuk library.json ile açılış, yıldız + yerel kopya, site 404 iken yerelden çalma,
                     # yeniden kurulumdan sonra favorilerin kalması, Son kullanılanlar
```
