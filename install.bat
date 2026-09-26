@echo off
chcp 65001 >nul
setlocal EnableExtensions

rem MyInstants panelini Premiere'e tanıtır.
rem Kaynak klasör (bu dosyanın yanındaki "extension") CEP uzantılar klasörüne BAĞLANIR (junction).
rem Böylece kodda yapılan değişiklikler Premiere'e doğrudan yansır. Yönetici izni gerekmez.

set "SRC=%~dp0extension"
set "EXT_ROOT=%APPDATA%\Adobe\CEP\extensions"
set "NAME=com.badidea.myinstants"
set "DEST=%EXT_ROOT%\%NAME%"

echo.
echo === MyInstants paneli kurulumu ===
echo Kaynak : %SRC%
echo Hedef  : %DEST%
echo.

if not exist "%SRC%\CSXS\manifest.xml" (
  echo HATA: "%SRC%\CSXS\manifest.xml" bulunamadı.
  echo Bu dosyayı proje klasörünün içinden çalıştırın.
  goto :fail
)

if not exist "%EXT_ROOT%" mkdir "%EXT_ROOT%"

if exist "%DEST%" (
  call :is_link
  if errorlevel 1 (
    echo Eski kopya klasörü siliniyor...
    rmdir /S /Q "%DEST%"
  ) else (
    echo Eski bağlantı kaldırılıyor...
    rmdir "%DEST%"
  )
)
if exist "%DEST%" (
  echo HATA: Eski kurulum kaldırılamadı. Premiere açıksa kapatıp tekrar deneyin.
  goto :fail
)

mklink /J "%DEST%" "%SRC%" >nul 2>&1
if errorlevel 1 (
  echo Bağlantı kurulamadı, dosyalar kopyalanıyor...
  robocopy "%SRC%" "%DEST%" /E /NFL /NDL /NJH /NJS /NP >nul
  if errorlevel 8 (
    echo HATA: Dosyalar kopyalanamadı.
    goto :fail
  )
  echo KURULDU ^(kopya modu^). Kodu güncelledikten sonra install.bat'ı tekrar çalıştırın.
) else (
  echo KURULDU ^(bağlantı modu^). Kodda yapılan değişiklikler Premiere'e doğrudan yansır.
)

echo.
rem PlayerDebugMode yalnızca kontrol edilir, değiştirilmez.
set "PDM="
for /f "tokens=3" %%a in ('reg query "HKCU\Software\Adobe\CSXS.12" /v PlayerDebugMode 2^>nul ^| findstr /I "PlayerDebugMode"') do set "PDM=%%a"
if "%PDM%"=="1" (
  echo PlayerDebugMode açık.
) else (
  echo UYARI: PlayerDebugMode açık görünmüyor. İmzasız paneller bu ayar olmadan yüklenmez.
  echo Açmak için şu komutu çalıştırın:
  echo   reg add "HKCU\Software\Adobe\CSXS.12" /v PlayerDebugMode /t REG_SZ /d 1 /f
)

echo.
echo Sonraki adım: Premiere'i kapatıp açın, sonra
echo   Window ^> Extensions ^> MyInstants
echo menüsünden paneli açın. ^(Menünün adı "Extensions ^(Legacy^)" da olabilir.^)
echo.
pause
exit /b 0

:is_link
rem 0 = bağlantı (junction/symlink), 1 = normal klasör
dir /AL /B "%EXT_ROOT%" 2>nul | findstr /I /X /L /C:"%NAME%" >nul
exit /b %errorlevel%

:fail
echo.
pause
exit /b 1
