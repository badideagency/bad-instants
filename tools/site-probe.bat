@echo off
chcp 65001 >nul
echo MyInstants site kontrolü (YALNIZ TEŞHİS) başlıyor, yaklaşık 30 saniye sürer...
echo Not: Bu rapor panelin çalışıp çalışmayacağını göstermez; asıl test panelin kendisidir.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0site-probe.ps1"
echo.
echo Rapor kaydedildi: "%~dp0site-probe-sonuc.txt"
echo Not Defteri'nde açılıyor. Tümünü seçip (Ctrl+A) kopyalayın (Ctrl+C) ve Claude'a yapıştırın.
start "" notepad "%~dp0site-probe-sonuc.txt"
echo.
pause
