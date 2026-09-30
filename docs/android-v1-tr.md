# Android önizleme: QR eşleştirme ve uzaktan kontrol

Android önizleme, ARM64 cihazlarda Android 10 / API 29 ve sonrasını destekler. Uygulama Telegram bot tokenı veya sayısal Telegram ID istemez.

## Kurulum

1. Aynı GitHub sürümünden `VSCode-Codex-Remote-Control-1.2.2-android-arm64-debug.apk` ile `SHA256SUMS.txt` dosyasını indirin.
2. APK'nın SHA-256 değerini doğrulayın.
3. Kullandığınız tarayıcı veya dosya yöneticisi için bilinmeyen kaynak izni verip APK'yı kurun.
4. Bu önizleme debug imzalıdır. İleride production anahtarıyla imzalanan sürüme geçerken uygulamayı kaldırıp yeniden kurmak gerekebilir.

## Mac ile eşleştirme

1. Mac uygulamasının READY olduğunu ve Telegram kurulumunun tamamlandığını doğrulayın.
2. Mac'te **Telefon eşleştir** ekranını açın. Beş dakika geçerli tek kullanımlık QR görünür.
3. Android uygulamasını açıp QR'ı tarayın.
4. **Telegram ile doğrula** düğmesini seçin. Telegram, tek kullanımlık kodla yapılandırılmış botunuzu açar.
5. Hazır mesajı Mac'te doğrulanmış aynı private Telegram kimliğinden gönderin.
6. Android'e dönün. Doğrulama tamamlandığında durum bağlı olarak değişir.

QR; relay adresini, süresi dolan claim'i, masaüstü public key'ini ve bot kullanıcı adını içerir. Telegram bot tokenını içermez. Yeni telefon eşleştirildiğinde eski telefon iptal edilir.

## Mobil kontroller

- Bilgisayar, Pocket runtime, Telegram ve profil durumunu görüntüleme
- Mac'teki izinli workspace köklerini gezme ve workspace seçme
- Mevcut konuşmayı seçme veya yeni konuşma oluşturma
- Bağlı App Server'ın sunduğu model ve düşünme düzeyini seçme
- Prompt gönderme; paragraf yapısını koruyan canlı ve late-join çıktıyı izleme
- Exact Approve/Deny, Stop, son history ve salt okunur update kontrolü

Relay komutları kuyruğa almaz. Mac çevrimdışıysa uygulama bunu gösterir ve komut daha sonra sessizce çalıştırılmaz. Browser screenshot/URL bu önizlemede bilinçli olarak kapalıdır.

Firebase production ayarı olmayan build'de background push bildirimi bulunmaz. Push payload'ları prompt veya çıktı değil, yalnız genel olay adı taşır.
