# MyInstants — Premiere Pro paneli

Premiere Pro 2026 (Windows) için CEP paneli. myinstants.com'daki sesleri listeler, arar,
fareyle üstüne gelince önizleme çalar. (İndirip timeline'a koyma: Aşama 2.)

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
  js/siteScraper.js   ← myinstants.com'u okuyan TEK dosya (site değişirse yalnız burası düzeltilir)
  js/main.js          ← arayüz davranışı
  js/CSInterface.js   ← Adobe'nin resmi CEP 12 dosyası
  jsx/host.jsx        ← Premiere tarafı (ExtendScript)
  .debug              ← hata ayıklama portu (8871)
install.bat           ← paneli kurar (bağlantı/junction ile)
uninstall.bat         ← paneli kaldırır
tools/site-probe.bat  ← YALNIZ TEŞHİS: sitenin yapısını PowerShell ile raporlar (panelin davranışını göstermez)
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
Kaldırmak için `uninstall.bat` (proje klasörüne dokunmaz).

## Site kontrol aracı (yalnız teşhis içindir)

`tools\site-probe.bat` → myinstants.com'dan örnek sayfaları PowerShell ile indirir ve sayfa yapısını
(ses kutuları, mp3 adresleri, sayfalama, kategori linkleri, TR/US bölge kodları) raporlar.
Rapor `tools\site-probe-sonuc.txt` dosyasına yazılır. Hiçbir şeyi değiştirmez.

**Dikkat:** PowerShell panelden farklı bir istemcidir; Cloudflare ona farklı davranabilir. Bu yüzden
raporun sonucu panelin çalışıp çalışmayacağını GÖSTERMEZ. Asıl test panelin kendisidir. Araç yalnızca,
panel "sitenin yapısı değişmiş olabilir" dediğinde HTML'e bakmak için kullanılır.

## Hata ayıklama

Panel Premiere'de açıkken Chrome'da `http://localhost:8871` → panelin Console'u.

## Geliştirici testleri (isteğe bağlı, Node.js gerekir)

```
npm install
npm test          # siteScraper: HTML okuma, adresler, Cloudflare sayfasını tanıma, hata türleri, önbellek
npm run test:ui   # paneli manifest'teki CEF ayarlarıyla headless Chromium'da açar; www.myinstants.com adını
                  # Cloudflare benzeri sahte bir siteye (tests/fake-site.js) yönlendirip gerçek fetch yolunu,
                  # Doğrula penceresini, çerez paylaşımını ve yeniden açılışta çerezin kalmasını dener
```
