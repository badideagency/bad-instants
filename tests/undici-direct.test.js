// tests/undici-direct.test.js
// Direkt undici fetch testi — Cloudflare bypass'ı doğrula
// DOMParser gerektirmez, sadece raw response kontrolü

const { JSDOM } = require('jsdom');
globalThis.DOMParser = new JSDOM('').window.DOMParser;

async function test() {
  console.log('=== Direkt undici Fetch Test ===\n');
  
  if (typeof global.fetch !== 'function') {
    console.log('❌ Node.js fetch (undici) mevcut değil!');
    return;
  }
  
  const url = 'https://www.myinstants.com/en/trending/tr/';
  console.log('Test URL:', url);
  console.log();
  
  // Gerçek browser header'ları ile istek at
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,tr;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
  };
  
  console.log('Headerlar:', JSON.stringify(headers, null, 2));
  console.log();
  
  try {
    const res = await global.fetch(url, { headers, redirect: 'follow' });
    
    console.log('HTTP Status:', res.status);
    console.log('Content-Type:', res.headers.get('content-type'));
    console.log('cf-chl-bypass:', res.headers.get('cf-chl-bypass'));
    console.log('cf-mitigated:', res.headers.get('cf-mitigated'));
    
    const body = await res.text();
    console.log('\nResponse uzunluğu:', body.length, 'char');
    
    // Title kontrolü
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
    const title = (titleMatch && titleMatch[1] || '').trim();
    console.log('Sayfa başlığı:', title.substring(0, 100));
    
    // Cloudflare kontrolü
    const isCloudflarePage = 
      /Just a moment/i.test(title) ||
      /Attention Required/i.test(title) ||
      /Checking your browser/i.test(title) ||
      /cf_chl_opt/i.test(body) ||
      /cf-chl-/i.test(body);
    
    if (isCloudflarePage) {
      console.log('\n❌ Cloudflare "Just a moment" sayfası döndü — bypass BAŞARISIZ.');
      console.log('   Response snippet:');
      // İlk 500 char göster
      const snippet = body.substring(0, 500).replace(/</g, '<').replace(/>/g, '>');
      console.log('   ' + snippet.split('\n').slice(0, 8).join('\n   '));
    } else {
      console.log('\n✅ BAŞARILI! Cloudflare bypass çalıştı — gerçek sayfa döndü.');
      
      // İçerik kontrolü
      const hasInstantDiv = /class="instant"/i.test(body);
      const hasPlayButton = /onclick.*play\(/i.test(body);
      console.log('   .instant div bulundu:', hasInstantDiv);
      console.log('   play() butonu bulundu:', hasPlayButton);
      
      if (hasInstantDiv || hasPlayButton) {
        console.log('\n🎉 Cloudflare bypass TAMAMEN ÇALIŞIYOR!');
      }
    }
    
  } catch (e) {
    console.log('❌ İstek hatası:', e.message);
  }
}

test();
