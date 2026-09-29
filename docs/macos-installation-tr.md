# macOS kurulum ve ilk kullanım

Bu önizleme Apple Silicon Mac'leri (M1 veya sonrası) destekler. Uygulama Pocket hostunu ve izole, doğrulanmış VS Code/Codex runtime'ını kendi içinde başlatır. Son kullanıcı için Terminal veya geliştirici aracı gerekmez.

## Kurulum

1. Aynı GitHub sürümünden `VSCode-Codex-Remote-Control-1.2.1-macos-arm64-unsigned.dmg` ile `SHA256SUMS.txt` dosyasını indirin.
2. DMG'nin SHA-256 değerini doğrulayın.
3. DMG'yi açıp **VS Code Codex Remote Control.app** dosyasını **Applications** klasörüne sürükleyin.
4. Uygulamayı Applications içinden açın.
5. Bu önizleme ad-hoc imzalıdır ve notarize edilmemiştir. macOS engellerse yalnız checksum eşleşiyorsa **Sistem Ayarları → Gizlilik ve Güvenlik** bölümünden izin verin.

Mevcut eşleşmelerin bozulmaması için iç bundle kimliği ve `~/Library/Application Support/Codex Pocket` veri dizini eski adını bilinçli olarak korur.

## Telegram botunu oluşturma ve doğrulama

Kurulum doğrulanmadan kontrol ekranı açılmaz.

1. Uygulamada **BotFather'ı aç** düğmesini seçin.
2. BotFather'a `/newbot` gönderip yönergeleri tamamlayın.
3. HTTP API tokenını uygulamadaki gizli alana yapıştırın.
4. **Botumu aç** düğmesini seçip botunuzla private sohbette `/start` gönderin.
5. Uygulamaya dönüp **ID'mi bul** düğmesini seçin.
6. **Bağlantıyı test et ve kaydet** düğmesini seçin. Uygulama botu, private Telegram kimliğini ve gerçek geri dönüş mesajını doğruladıktan sonra Pocket'ı başlatır.

Token tekrar gösterilmez, loglanmaz, QR'a eklenmez ve relay'e gönderilmez. Açığa çıktığından şüpheleniyorsanız BotFather'da iptal edip yeni tokenla kurulumu tekrarlayın.

## Kullanım

- **Proje Aç**, macOS klasör seçicisini açar ve workspace'i açar veya mevcut runtime'ı yeniden kullanır.
- Workspace ve konuşma seçebilir ya da yeni konuşma oluşturabilirsiniz.
- Model ve düşünme düzeyi çalışan App Server'ın sunduğu değerlerden seçilir.
- Prompt gönderebilir, canlı çıktıyı izleyebilir, Approve/Deny verebilir ve aktif işi Stop ile durdurabilirsiniz.
- **Telefon eşleştir**, Android için beş dakika geçerli tek kullanımlık QR üretir.
- **Güncellemeler**, bu önizlemede yalnızca salt okunur sürüm kontrolüdür.

Günlük VS Code ve global uzantılar değiştirilmez. Windows browser kabul kapısı tamamlanana kadar screenshot/URL özelliği kullanılamaz.

Sorun yaşarsanız hassas logları veya tokenları public issue'ya koymayın; güvenlik bildirimleri için [SECURITY.md](../SECURITY.md) dosyasını izleyin.
