@echo off
chcp 65001 >nul
echo MyInstants site kontrolü başlıyor (yaklaşık 30 saniye sürer)...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0site-probe.ps1"
echo.
echo Rapor kaydedildi: "%~dp0site-probe-sonuc.txt"
echo Not Defteri'nde açılıyor. Tümünü seçip (Ctrl+A) kopyalayın (Ctrl+C) ve Claude'a yapıştırın.
start "" notepad "%~dp0site-probe-sonuc.txt"
echo.
pause
