// tests/integration-undici.test.js
// Tam entegrasyon testi: jsdom DOMParser + undici fetch ile scraper'ı çalıştır

const { JSDOM } = require('jsdom');
globalThis.DOMParser = new JSDOM('').window.DOMParser;

const scraper = require('../extension/js/siteScraper.js');

async function test() {
  console.log('=== Tam Entegrasyon Testi ===\n');
  
  scraper._setTimeout(15000);
  
  // Trending TR
  console.log('1) Trending (TR)...');
  try {
    const result = await scraper.getList('trending', { region: 'tr' }, 1);
    console.log(`   ✅ ${result.items.length} ses bulundu`);
    if (result.items.length > 0) {
      console.log(`   İlk: "${result.items[0].name}" → ${result.items[0].mp3}`);
    }
  } catch (e) {
    console.log(`   ❌ ${e.kind}: ${e.message}`);
  }
  
  // Best of All Time TR
  console.log('\n2) Best of All Time (TR)...');
  try {
    const result = await scraper.getList('best', { region: 'tr' }, 1);
    console.log(`   ✅ ${result.items.length} ses bulundu`);
    if (result.items.length > 0) {
      console.log(`   İlk: "${result.items[0].name}" → ${result.items[0].mp3}`);
    }
  } catch (e) {
    console.log(`   ❌ ${e.kind}: ${e.message}`);
  }
  
  // Recent (bölgesiz)
  console.log('\n3) Recent (bölgesiz)...');
  try {
    const result = await scraper.getList('recent', {}, 1);
    console.log(`   ✅ ${result.items.length} ses bulundu`);
    if (result.items.length > 0) {
      console.log(`   İlk: "${result.items[0].name}" → ${result.items[0].mp3}`);
    }
  } catch (e) {
    console.log(`   ❌ ${e.kind}: ${e.message}`);
  }
  
  // Search
  console.log('\n4) Arama: "laser"...');
  try {
    const result = await scraper.getList('search', { query: 'laser' }, 1);
    console.log(`   ✅ ${result.items.length} sonuç bulundu`);
    if (result.items.length > 0) {
      console.log(`   İlk: "${result.items[0].name}" → ${result.items[0].mp3}`);
    }
  } catch (e) {
    console.log(`   ❌ ${e.kind}: ${e.message}`);
  }
  
  // Cookie cache kontrolü
  const fs = require('fs');
  const pathMod = require('path');
  const cookieFile = pathMod.join(__dirname, '..', 'cache', 'cookies.json');
  if (fs.existsSync(cookieFile)) {
    console.log('\n5) Cookie cache durumu:');
    try {
      const cookies = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
      const keys = Object.keys(cookies);
      console.log(`   ✅ ${keys.length} URL için cf_clearance cookie'si cache'de`);
      for (const key of keys) {
        const c = cookies[key];
        const remaining = Math.round((c.expires - Date.now()) / 60000);
        console.log(`   - ${key.substring(40)}... → ${remaining}dk kaldı`);
      }
    } catch (e) {
      console.log(`   ⚠️ Cookie dosyası okunamadı: ${e.message}`);
    }
  } else {
    console.log('\n5) Cookie cache: henüz oluşturulmadı');
  }
  
  console.log('\n=== Test Tamamlandı ===');
}

test();
