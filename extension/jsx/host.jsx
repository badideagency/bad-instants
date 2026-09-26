/*
 * host.jsx — MyInstants panelinin Premiere tarafı (ExtendScript).
 * Panel bu fonksiyonları evalScript ile çağırır.
 * Aşama 2'de indirme / import / timeline'a koyma fonksiyonları buraya eklenecek.
 */

// Panel ile Premiere arasındaki bağlantıyı test eder. "ok|<Premiere sürümü>" döner.
function mi_ping() {
    try {
        return "ok|" + app.version;
    } catch (e) {
        return "err|" + e;
    }
}
