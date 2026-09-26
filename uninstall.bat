@echo off
chcp 65001 >nul
setlocal EnableExtensions

rem MyInstants panelini Premiere'den kaldırır. Kaynak klasöre (projeye) dokunmaz.

set "EXT_ROOT=%APPDATA%\Adobe\CEP\extensions"
set "NAME=com.badidea.myinstants"
set "DEST=%EXT_ROOT%\%NAME%"

echo.
if not exist "%DEST%" (
  echo Panel zaten kurulu değil.
  goto :end
)

dir /AL /B "%EXT_ROOT%" 2>nul | findstr /I /X /L /C:"%NAME%" >nul
if errorlevel 1 (
  rmdir /S /Q "%DEST%"
) else (
  rem Bağlantıyı kaldır; bağlantının gösterdiği proje klasörü silinmez.
  rmdir "%DEST%"
)

if exist "%DEST%" (
  echo HATA: Kaldırılamadı. Premiere açıksa kapatıp tekrar deneyin.
) else (
  echo Panel kaldırıldı. Premiere'i yeniden başlatın.
)

:end
echo.
pause
