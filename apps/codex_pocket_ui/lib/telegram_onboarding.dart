import 'dart:async';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import 'pocket_bridge.dart';

class TelegramOnboarding extends StatefulWidget {
  const TelegramOnboarding({super.key, required this.controller});
  final PocketController controller;

  @override
  State<TelegramOnboarding> createState() => _TelegramOnboardingState();
}

class _TelegramOnboardingState extends State<TelegramOnboarding> {
  final token = TextEditingController();
  final userId = TextEditingController();
  bool obscure = true;
  bool busy = false;
  String? message;
  bool success = false;
  Timer? reconnectTimer;

  @override
  void initState() {
    super.initState();
    reconnectTimer = Timer.periodic(const Duration(seconds: 3), (_) {
      final onboarding =
          widget.controller.data?['onboarding'] as Map<String, dynamic>?;
      if (onboarding?['telegramConfigured'] == true &&
          onboarding?['runtimeReady'] == false) {
        widget.controller.connect();
      }
    });
  }

  @override
  void dispose() {
    reconnectTimer?.cancel();
    token.dispose();
    userId.dispose();
    super.dispose();
  }

  Future<void> _open(String url) async {
    final launched = await launchUrl(
      Uri.parse(url),
      mode: LaunchMode.externalApplication,
    );
    if (!launched && mounted) _show('Bağlantı açılamadı: $url');
  }

  void _show(String value, {bool ok = false}) {
    setState(() {
      message = value;
      success = ok;
    });
  }

  String _friendly(Object error) =>
      error.toString().replaceFirst(RegExp(r'^(Bad state: |Exception: )'), '');

  Future<void> _openOwnBot() async {
    if (token.text.trim().isEmpty) {
      _show('Önce BotFather tokenını girin.');
      return;
    }
    setState(() => busy = true);
    try {
      final result = await widget.controller.telegramBot(token.text.trim());
      await _open('${result['botUrl']}');
      _show(
        '@${result['botUsername']} açıldı. Sohbette /start gönderin, sonra ID’mi bul düğmesine basın.',
      );
    } catch (error) {
      _show(_friendly(error));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _discover() async {
    if (token.text.trim().isEmpty) {
      _show('Önce BotFather tokenını girin.');
      return;
    }
    setState(() => busy = true);
    try {
      final result = await widget.controller.discoverTelegram(
        token.text.trim(),
      );
      userId.text = '${result['userId']}';
      _show('${result['displayName']} için Telegram ID bulundu.', ok: true);
    } catch (error) {
      _show(_friendly(error));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _verify() async {
    if (token.text.trim().isEmpty || userId.text.trim().isEmpty) {
      _show('Bot tokenı ve Telegram kullanıcı ID’si zorunludur.');
      return;
    }
    setState(() => busy = true);
    try {
      final result = await widget.controller.configureTelegram(
        token.text.trim(),
        userId.text.trim(),
      );
      token.clear();
      _show(
        '@${result['botUsername']} test mesajını gönderdi. Telegram bağlantısı doğrulandı ve güvenli biçimde kaydedildi.',
        ok: true,
      );
    } catch (error) {
      _show(_friendly(error));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final onboarding =
        widget.controller.data?['onboarding'] as Map<String, dynamic>?;
    if (onboarding?['telegramConfigured'] == true &&
        onboarding?['runtimeReady'] == false) {
      final desktop =
          widget.controller.data?['desktop'] as Map<String, dynamic>?;
      return Scaffold(
        body: Center(
          child: Card(
            child: Padding(
              padding: const EdgeInsets.all(32),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 560),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(
                      Icons.task_alt,
                      color: Colors.greenAccent,
                      size: 56,
                    ),
                    const SizedBox(height: 16),
                    Text(
                      'Telegram kurulumu tamamlandı',
                      style: Theme.of(context).textTheme.headlineSmall,
                    ),
                    const SizedBox(height: 12),
                    Text(
                      desktop?['detail']?.toString() ??
                          'Pocket Host, Telegram ve masaüstü bridge otomatik hazırlanıyor. İlk kurulum birkaç dakika sürebilir.',
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 20),
                    FilledButton.icon(
                      onPressed: widget.controller.connect,
                      icon: const Icon(Icons.refresh),
                      label: const Text('Şimdi kontrol et'),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
    }
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 720),
              child: Card(
                child: Padding(
                  padding: const EdgeInsets.all(32),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      const Icon(Icons.telegram, size: 54),
                      const SizedBox(height: 16),
                      Text(
                        'VS Code Codex Remote Control’a hoş geldiniz',
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.headlineSmall,
                      ),
                      const SizedBox(height: 8),
                      const Text(
                        'Uygulama yalnızca size ait bir Telegram botu ve doğrulanmış private Telegram hesabıyla çalışır. Kurulum tamamlanmadan Pocket kontrolleri açılmaz.',
                        textAlign: TextAlign.center,
                      ),
                      const SizedBox(height: 28),
                      const _Step(
                        number: '1',
                        title: 'Telegram botunu oluşturun',
                        body:
                            'BotFather’da /newbot komutunu kullanın ve verilen HTTP API tokenını kopyalayın.',
                      ),
                      Align(
                        alignment: Alignment.centerLeft,
                        child: TextButton.icon(
                          onPressed: () => _open('https://t.me/BotFather'),
                          icon: const Icon(Icons.open_in_new),
                          label: const Text('BotFather’ı aç'),
                        ),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        key: const Key('telegram-token'),
                        controller: token,
                        obscureText: obscure,
                        autocorrect: false,
                        enableSuggestions: false,
                        decoration: InputDecoration(
                          labelText: 'BotFather tokenı',
                          hintText: '123456789:AA…',
                          suffixIcon: IconButton(
                            onPressed: () => setState(() => obscure = !obscure),
                            icon: Icon(
                              obscure ? Icons.visibility : Icons.visibility_off,
                            ),
                            tooltip: obscure ? 'Göster' : 'Gizle',
                          ),
                        ),
                      ),
                      const SizedBox(height: 10),
                      Align(
                        alignment: Alignment.centerLeft,
                        child: OutlinedButton.icon(
                          onPressed: busy ? null : _openOwnBot,
                          icon: const Icon(Icons.telegram),
                          label: const Text('Botumu aç'),
                        ),
                      ),
                      const SizedBox(height: 28),
                      const _Step(
                        number: '2',
                        title: 'Telegram kimliğinizi doğrulayın',
                        body:
                            'Telegram’da yeni botunuzu açıp /start gönderin. Ardından ID’mi bul düğmesine basın. Grup mesajları kabul edilmez.',
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        key: const Key('telegram-user-id'),
                        controller: userId,
                        keyboardType: TextInputType.number,
                        decoration: const InputDecoration(
                          labelText: 'Telegram kullanıcı ID’si',
                          hintText: 'Yalnızca sayısal ID',
                        ),
                      ),
                      const SizedBox(height: 10),
                      Align(
                        alignment: Alignment.centerLeft,
                        child: OutlinedButton.icon(
                          onPressed: busy ? null : _discover,
                          icon: const Icon(Icons.person_search_outlined),
                          label: const Text('ID’mi bul'),
                        ),
                      ),
                      const SizedBox(height: 28),
                      const _Step(
                        number: '3',
                        title: 'Geri dönüş testini tamamlayın',
                        body:
                            'Pocket bot kimliğini kontrol eder ve yalnızca verdiğiniz ID’ye bir test mesajı gönderir. Test başarısızsa bilgiler kaydedilmez.',
                      ),
                      const SizedBox(height: 16),
                      FilledButton.icon(
                        key: const Key('verify-telegram'),
                        onPressed: busy ? null : _verify,
                        icon: busy
                            ? const SizedBox.square(
                                dimension: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Icon(Icons.verified_user_outlined),
                        label: const Text('Bağlantıyı test et ve kaydet'),
                      ),
                      if (message != null) ...[
                        const SizedBox(height: 16),
                        Semantics(
                          liveRegion: true,
                          child: Text(
                            message!,
                            key: const Key('setup-result'),
                            style: TextStyle(
                              color: success
                                  ? Colors.greenAccent
                                  : Theme.of(context).colorScheme.error,
                            ),
                          ),
                        ),
                      ],
                      const SizedBox(height: 16),
                      const Text(
                        'Token yalnızca bu Mac’teki owner-only yapılandırma dosyasında tutulur; uygulama ekranında, API yanıtlarında veya loglarda geri gösterilmez.',
                        style: TextStyle(color: Colors.white54, fontSize: 12),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Step extends StatelessWidget {
  const _Step({required this.number, required this.title, required this.body});
  final String number;
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      CircleAvatar(radius: 15, child: Text(number)),
      const SizedBox(width: 12),
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(body, style: const TextStyle(color: Colors.white70)),
          ],
        ),
      ),
    ],
  );
}
