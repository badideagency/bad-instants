# MyInstants — Premiere Pro paneli

Premiere Pro 2026 (Windows) için CEP paneli. myinstants.com'daki sesleri listeler, arar,
fareyle üstüne gelince önizleme çalar. (İndirip timeline'a koyma: Aşama 2.)

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
tools/site-probe.bat  ← sitenin yapısını sizin bilgisayarınızdan kontrol eden rapor aracı
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

## Site kontrol aracı

`tools\site-probe.bat` → myinstants.com'dan örnek sayfaları indirir ve panelin kullandığı yapıyı
(ses kutuları, mp3 adresleri, sayfalama, kategori linkleri, TR/US bölge kodları) raporlar.
Rapor `tools\site-probe-sonuc.txt` dosyasına yazılır ve Not Defteri'nde açılır. Hiçbir şeyi değiştirmez.

## Hata ayıklama

Panel Premiere'de açıkken Chrome'da `http://localhost:8871` → panelin Console'u.

## Geliştirici testleri (isteğe bağlı, Node.js gerekir)

```
npm install
npm test          # siteScraper: HTML okuma, adresler, hata türleri, önbellek
npm run test:ui   # paneli headless Chromium'da açıp önizleme/sekme/bölge/arama/hata ekranlarını dener
```
