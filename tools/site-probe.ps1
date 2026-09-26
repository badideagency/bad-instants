# MyInstants — site kontrol aracı
#
# myinstants.com sayfalarını SİZİN bilgisayarınızdan indirir ve panelin kullandığı
# yapıyı (ses kutuları, mp3 adresleri, sayfalama, kategori linkleri, bölge kodları) raporlar.
# Hiçbir şeyi değiştirmez; yalnızca okur ve "site-probe-sonuc.txt" dosyasını yazar.

param([string]$Base = 'https://www.myinstants.com')

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {}

$UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
$OutFile = Join-Path $PSScriptRoot 'site-probe-sonuc.txt'
$Lines = New-Object System.Collections.Generic.List[string]

function Say([string]$s = '') { $Lines.Add($s); Write-Host $s }

function Get-Page([string]$path) {
  $r = [ordered]@{ Path = $path; Status = 0; Final = ''; Html = ''; Error = ''; Ms = 0 }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $resp = Invoke-WebRequest -Uri ($Base + $path) -UserAgent $UA -UseBasicParsing -TimeoutSec 25 `
      -MaximumRedirection 5 -Headers @{ 'Accept-Language' = 'en-US,en;q=0.9' }
    $r.Status = [int]$resp.StatusCode
    $r.Html = [Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray())
    if ($resp.BaseResponse.ResponseUri) { $r.Final = $resp.BaseResponse.ResponseUri.AbsoluteUri }
    elseif ($resp.BaseResponse.RequestMessage) { $r.Final = $resp.BaseResponse.RequestMessage.RequestUri.AbsoluteUri }
  } catch {
    $r.Error = $_.Exception.Message
    $er = $_.Exception.Response
    if ($er) {
      try { $r.Status = [int]$er.StatusCode } catch {}
      try { $sr = New-Object IO.StreamReader($er.GetResponseStream()); $r.Html = $sr.ReadToEnd() } catch {}
    }
    if (-not $r.Html -and $_.ErrorDetails) { $r.Html = $_.ErrorDetails.Message }
  }
  $r.Ms = $sw.ElapsedMilliseconds
  return $r
}

function Get-Title([string]$html) {
  $m = [regex]::Match($html, '(?is)<title[^>]*>\s*(.*?)\s*</title>')
  if ($m.Success) { return ([Net.WebUtility]::HtmlDecode($m.Groups[1].Value) -replace '\s+', ' ') }
  return ''
}

function CountOf([string]$html, [string]$pattern) { return [regex]::Matches($html, $pattern).Count }

$LINK_RE = [regex]'(?is)<a[^>]*class="[^"]*instant-link[^"]*"[^>]*>(.*?)</a>'

# Her play('...') tuşu için mp3, kimlik ve hemen ardından gelen instant-link yazısı
function Get-Sounds([string]$html) {
  $list = @()
  foreach ($m in [regex]::Matches($html, "play\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'")) {
    $name = '?'
    $l = $LINK_RE.Match($html, $m.Index + $m.Length)
    if ($l.Success -and ($l.Index - $m.Index) -lt 2000) {
      $name = ([Net.WebUtility]::HtmlDecode(($l.Groups[1].Value -replace '<[^>]+>', '')) -replace '\s+', ' ').Trim()
    }
    $list += [pscustomobject]@{ Mp3 = $m.Groups[1].Value; Slug = $m.Groups[3].Value; Name = $name }
  }
  return $list
}

function Get-PageLinks([string]$html) {
  $set = New-Object System.Collections.Generic.List[string]
  foreach ($m in [regex]::Matches($html, 'href="([^"]*[?&](?:amp;)?page=\d+[^"]*)"')) {
    $v = [Net.WebUtility]::HtmlDecode($m.Groups[1].Value)
    if (-not $set.Contains($v)) { $set.Add($v) }
    if ($set.Count -ge 8) { break }
  }
  return $set
}

function Snippet([string]$html, [string]$pattern, [int]$before, [int]$len) {
  $m = [regex]::Match($html, $pattern)
  if (-not $m.Success) { return '(bulunamadı)' }
  $start = [Math]::Max(0, $m.Index - $before)
  $n = [Math]::Min($len, $html.Length - $start)
  return (($html.Substring($start, $n) -replace '\r', '') -replace '\n\s*\n+', "`n")
}

function Fingerprint($page) {
  $s = Get-Sounds $page.Html
  if (-not $s -or $s.Count -eq 0) { return '' }
  return (($s | Select-Object -First 10 | ForEach-Object { $_.Slug }) -join ',')
}

$INSTANT_BOX = '<[a-z]+[^>]*?class="(?:[^"]*\s)?instant(?:\s[^"]*)?"'

$Pages = [ordered]@{
  'trending_tr'     = '/en/trending/tr/'
  'trending_us'     = '/en/trending/us/'
  'trending_none'   = '/en/trending/'
  'trending_tr_p2'  = '/en/trending/tr/?page=2'
  'index_tr'        = '/en/index/tr/'
  'index_us'        = '/en/index/us/'
  'best_tr'         = '/en/best_of_all_time/tr/'
  'best_us'         = '/en/best_of_all_time/us/'
  'best_none'       = '/en/best_of_all_time/'
  'best_tr_p2'      = '/en/best_of_all_time/tr/?page=2'
  'recent'          = '/en/recent/'
  'recent_p2'       = '/en/recent/?page=2'
  'recent_tr'       = '/en/recent/tr/'
  'recent_us'       = '/en/recent/us/'
  'categories'      = '/en/categories/'
  'cat_memes_tr'    = '/en/categories/memes/tr/'
  'cat_memes_us'    = '/en/categories/memes/us/'
  'cat_memes_none'  = '/en/categories/memes/'
  'cat_memes_tr_p2' = '/en/categories/memes/tr/?page=2'
  'cat_tiktok_tr'   = '/en/categories/tiktok%20trends/tr/'
  'cat_anime_tr'    = '/en/categories/anime%20%26%20manga/tr/'
  'search'          = '/en/search/?name=vine%20boom'
  'search_p2'       = '/en/search/?name=vine%20boom&page=2'
  'search_tr_chars' = '/en/search/?name=t%C3%BCrk'
}

Say '=== MyInstants site kontrol raporu ==='
Say ("Tarih: {0:yyyy-MM-dd HH:mm}  |  PowerShell {1}  |  {2}" -f (Get-Date), $PSVersionTable.PSVersion, [Environment]::OSVersion.VersionString)
Say ''

$R = [ordered]@{}
$i = 0
foreach ($key in $Pages.Keys) {
  $i++
  Write-Host ("[{0}/{1}] {2}" -f $i, $Pages.Count, $Pages[$key]) -ForegroundColor DarkGray
  $R[$key] = Get-Page $Pages[$key]
  Start-Sleep -Milliseconds 400
}

Say '--- 1) Sayfa özeti ---'
foreach ($key in $R.Keys) {
  $p = $R[$key]
  $h = $p.Html
  Say ("[{0}] {1}" -f $key, $p.Path)
  Say ("    HTTP {0} ({1} ms)  son adres: {2}" -f $p.Status, $p.Ms, $p.Final)
  if ($p.Error) { Say ("    HATA: {0}" -f $p.Error) }
  Say ("    başlık: {0}" -f (Get-Title $h))
  Say ("    div.instant: {0} | play('/media/sounds/: {1} | play(&#39;: {2} | instant-link: {3} | small-button: {4} | data-url: {5}" -f `
      (CountOf $h $INSTANT_BOX), (CountOf $h "play\('/media/sounds/"), (CountOf $h 'play\(&#39;'), (CountOf $h 'instant-link'), (CountOf $h 'small-button'), (CountOf $h 'data-url='))
  $s = @(Get-Sounds $h)
  for ($k = 0; $k -lt [Math]::Min(2, $s.Count); $k++) {
    Say ("    örnek: `"{0}`" -> {1}  ({2})" -f $s[$k].Name, $s[$k].Mp3, $s[$k].Slug)
  }
  $links = Get-PageLinks $h
  if ($links.Count) { Say ("    sayfa linkleri: {0}" -f ($links -join '  ')) }
  Say ''
}

Say '--- 2) Bölge karşılaştırması (ilk 10 sesin kimliği) ---'
function Compare-Pages([string]$a, [string]$b) {
  $fa = Fingerprint $R[$a]; $fb = Fingerprint $R[$b]
  if (-not $fa -or -not $fb) { $v = 'KARŞILAŞTIRILAMADI (biri boş)' }
  elseif ($fa -eq $fb) { $v = 'AYNI' } else { $v = 'FARKLI' }
  Say ("    {0} <-> {1}: {2}" -f $a, $b, $v)
}
Compare-Pages 'trending_tr' 'trending_us'
Compare-Pages 'trending_tr' 'trending_none'
Compare-Pages 'trending_tr' 'index_tr'
Compare-Pages 'best_tr' 'best_us'
Compare-Pages 'best_tr' 'best_none'
Compare-Pages 'cat_memes_tr' 'cat_memes_us'
Compare-Pages 'cat_memes_tr' 'cat_memes_none'
Compare-Pages 'recent' 'recent_tr'
Compare-Pages 'recent' 'recent_us'
Compare-Pages 'trending_tr' 'trending_tr_p2'
Compare-Pages 'recent' 'recent_p2'
Compare-Pages 'search' 'search_p2'
Say ''

Say '--- 3) İlk ses kutusunun ham HTML''i (trending_tr) ---'
Say (Snippet $R['trending_tr'].Html $INSTANT_BOX 0 900)
Say ''
Say '--- 4) Sayfalama bölümünün ham HTML''i (trending_tr) ---'
Say (Snippet $R['trending_tr'].Html 'page=2' 300 700)
Say ''

Say '--- 5) Kategori linkleri (/en/categories/) ---'
$seen = @{}
foreach ($m in [regex]::Matches($R['categories'].Html, '(?is)<a[^>]*href="([^"]*categories/[^"]*)"[^>]*>(.*?)</a>')) {
  $href = [Net.WebUtility]::HtmlDecode($m.Groups[1].Value)
  if ($seen.ContainsKey($href)) { continue }
  $seen[$href] = 1
  $text = ([Net.WebUtility]::HtmlDecode(($m.Groups[2].Value -replace '<[^>]+>', ' ')) -replace '\s+', ' ').Trim()
  Say ("    {0}  =>  `"{1}`"" -f $href, $text)
}
Say ''
Say '--- 6) Kategori sayfasındaki ilk kategori linkinin ham HTML''i ---'
Say (Snippet $R['categories'].Html 'href="[^"]*categories/[^"/]+/' 200 600)
Say ''

Say '--- 7) MP3 indirme testi ---'
$first = @(Get-Sounds $R['trending_tr'].Html) | Select-Object -First 1
if ($first) {
  try {
    $a = Invoke-WebRequest -Uri ($Base + $first.Mp3) -UserAgent $UA -UseBasicParsing -TimeoutSec 25
    Say ("    {0} -> HTTP {1}, tür: {2}, boyut: {3} bayt" -f $first.Mp3, [int]$a.StatusCode, ($a.Headers['Content-Type'] -join ', '), $a.RawContentStream.Length)
  } catch {
    Say ("    {0} -> HATA: {1}" -f $first.Mp3, $_.Exception.Message)
  }
} else {
  Say '    (trending_tr sayfasında mp3 bulunamadı)'
}
Say ''
Say '=== Rapor sonu ==='

$Lines | Set-Content -Path $OutFile -Encoding UTF8
