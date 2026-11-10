// tests/undici-bypass.test.js
// Cloudflare bypass testi: Node.js fetch (undici) ile myinstants.com'a istek at,
// "Just a moment" sayfası değil gerçek içerik gelmeli.

const scraper = require('../extension/js/siteScraper.js');

async function test() {
  console.log('=== Cloudflare Bypass Test ===\n');
  
  // Timeout'u kısalt (test için)
  scraper._setTimeout(10000);
  
  const url = 'https://www.myinstants.com/en/trending/tr/';
  console.log('Test URL:', url);
  console.log('Node.js fetch mevcut:', typeof global.fetch === 'function');
  console.log();
  
  try {
    const result = await scraper.getList('trending', { region: 'tr' }, 1);
    
    if (result.items && result.items.length > 0) {
      console.log('✅ BAŞARILI! Cloudflare bypass çalıştı.');
      console.log(`   ${result.items.length} ses bulundu.`);
      console.log(`   İlk ses: "${result.items[0].name}"`);
      console.log(`   MP3 URL: ${result.items[0].mp3}`);
    } else {
      console.log('⚠️  İstek başarılı ama sayfa boş (site yapısı değişmiş olabilir).');
    }
    
    if (result.hasMore !== undefined) {
      console.log(`   Sonraki sayfa var: ${result.hasMore}`);
    }
    
  } catch (e) {
    console.log('❌ HATA:', e.kind, '-', e.message);
    if (e.url) console.log('   URL:', e.url);
    if (e.status) console.log('   HTTP Status:', e.status);
    
    // Detaylı hata mesajı
    if (e.kind === 'challenge') {
      console.log('\n⚠️  Cloudflare challenge engeli — undici header\'lar yeterli olmadı.');
      console.log('   Fallback planı: rebrowser-puppeteer-core kurulumu gerekli.');
    } else if (e.kind === 'server' || e.kind === 'timeout') {
      console.log('\n⚠️  Sunucu bağlantı sorunu — ağ veya DNS kontrolü gerekli.');
    }
  }
}

test();
