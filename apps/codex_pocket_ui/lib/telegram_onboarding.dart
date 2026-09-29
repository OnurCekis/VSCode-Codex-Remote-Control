import 'dart:async';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import 'pocket_bridge.dart';
import 'app_localizations.dart';

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
    if (!launched && mounted) {
      _show(
        context.tr('Could not open link: $url', 'Bağlantı açılamadı: $url'),
      );
    }
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
      _show(
        context.tr(
          'Enter the BotFather token first.',
          'Önce BotFather tokenını girin.',
        ),
      );
      return;
    }
    setState(() => busy = true);
    try {
      final result = await widget.controller.telegramBot(token.text.trim());
      await _open('${result['botUrl']}');
      if (!mounted) return;
      _show(
        context.tr(
          '@${result['botUsername']} opened. Send /start in the chat, then select Find my ID.',
          '@${result['botUsername']} açıldı. Sohbette /start gönderin, sonra ID’mi bul düğmesine basın.',
        ),
      );
    } catch (error) {
      _show(_friendly(error));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _discover() async {
    if (token.text.trim().isEmpty) {
      _show(
        context.tr(
          'Enter the BotFather token first.',
          'Önce BotFather tokenını girin.',
        ),
      );
      return;
    }
    setState(() => busy = true);
    try {
      final result = await widget.controller.discoverTelegram(
        token.text.trim(),
      );
      if (!mounted) return;
      userId.text = '${result['userId']}';
      _show(
        context.tr(
          'Telegram ID found for ${result['displayName']}.',
          '${result['displayName']} için Telegram ID bulundu.',
        ),
        ok: true,
      );
    } catch (error) {
      _show(_friendly(error));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _verify() async {
    if (token.text.trim().isEmpty || userId.text.trim().isEmpty) {
      _show(
        context.tr(
          'Bot token and Telegram user ID are required.',
          'Bot tokenı ve Telegram kullanıcı ID’si zorunludur.',
        ),
      );
      return;
    }
    setState(() => busy = true);
    try {
      final result = await widget.controller.configureTelegram(
        token.text.trim(),
        userId.text.trim(),
      );
      if (!mounted) return;
      token.clear();
      _show(
        context.tr(
          '@${result['botUsername']} sent the test message. Telegram was verified and saved securely.',
          '@${result['botUsername']} test mesajını gönderdi. Telegram bağlantısı doğrulandı ve güvenli biçimde kaydedildi.',
        ),
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
        appBar: AppBar(
          actions: const [LanguageMenuButton(), SizedBox(width: 8)],
        ),
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
                      context.tr(
                        'Telegram setup complete',
                        'Telegram kurulumu tamamlandı',
                      ),
                      style: Theme.of(context).textTheme.headlineSmall,
                    ),
                    const SizedBox(height: 12),
                    Text(
                      desktop?['detail']?.toString() ??
                          context.tr(
                            'Pocket Host, Telegram, and the desktop bridge are being prepared automatically. First setup can take a few minutes.',
                            'Pocket Host, Telegram ve masaüstü bridge otomatik hazırlanıyor. İlk kurulum birkaç dakika sürebilir.',
                          ),
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 20),
                    FilledButton.icon(
                      onPressed: widget.controller.connect,
                      icon: const Icon(Icons.refresh),
                      label: Text(context.tr('Check now', 'Şimdi kontrol et')),
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
      appBar: AppBar(actions: const [LanguageMenuButton(), SizedBox(width: 8)]),
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
                        context.tr(
                          'Welcome to VS Code Codex Remote Control',
                          'VS Code Codex Remote Control’a hoş geldiniz',
                        ),
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.headlineSmall,
                      ),
                      const SizedBox(height: 8),
                      Text(
                        context.tr(
                          'The app works only with your own Telegram bot and a verified private Telegram account. Pocket controls remain locked until setup is complete.',
                          'Uygulama yalnızca size ait bir Telegram botu ve doğrulanmış private Telegram hesabıyla çalışır. Kurulum tamamlanmadan Pocket kontrolleri açılmaz.',
                        ),
                        textAlign: TextAlign.center,
                      ),
                      const SizedBox(height: 28),
                      _Step(
                        number: '1',
                        title: context.tr(
                          'Create your Telegram bot',
                          'Telegram botunu oluşturun',
                        ),
                        body: context.tr(
                          'Use /newbot in BotFather and copy the HTTP API token it provides.',
                          'BotFather’da /newbot komutunu kullanın ve verilen HTTP API tokenını kopyalayın.',
                        ),
                      ),
                      Align(
                        alignment: Alignment.centerLeft,
                        child: TextButton.icon(
                          onPressed: () => _open('https://t.me/BotFather'),
                          icon: const Icon(Icons.open_in_new),
                          label: Text(
                            context.tr('Open BotFather', 'BotFather’ı aç'),
                          ),
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
                          labelText: context.tr(
                            'BotFather token',
                            'BotFather tokenı',
                          ),
                          hintText: '123456789:AA…',
                          suffixIcon: IconButton(
                            onPressed: () => setState(() => obscure = !obscure),
                            icon: Icon(
                              obscure ? Icons.visibility : Icons.visibility_off,
                            ),
                            tooltip: obscure
                                ? context.tr('Show', 'Göster')
                                : context.tr('Hide', 'Gizle'),
                          ),
                        ),
                      ),
                      const SizedBox(height: 10),
                      Align(
                        alignment: Alignment.centerLeft,
                        child: OutlinedButton.icon(
                          onPressed: busy ? null : _openOwnBot,
                          icon: const Icon(Icons.telegram),
                          label: Text(context.tr('Open my bot', 'Botumu aç')),
                        ),
                      ),
                      const SizedBox(height: 28),
                      _Step(
                        number: '2',
                        title: context.tr(
                          'Verify your Telegram identity',
                          'Telegram kimliğinizi doğrulayın',
                        ),
                        body: context.tr(
                          'Open your new bot in Telegram and send /start. Then select Find my ID. Group messages are not accepted.',
                          'Telegram’da yeni botunuzu açıp /start gönderin. Ardından ID’mi bul düğmesine basın. Grup mesajları kabul edilmez.',
                        ),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        key: const Key('telegram-user-id'),
                        controller: userId,
                        keyboardType: TextInputType.number,
                        decoration: InputDecoration(
                          labelText: context.tr(
                            'Telegram user ID',
                            'Telegram kullanıcı ID’si',
                          ),
                          hintText: context.tr(
                            'Numeric ID only',
                            'Yalnızca sayısal ID',
                          ),
                        ),
                      ),
                      const SizedBox(height: 10),
                      Align(
                        alignment: Alignment.centerLeft,
                        child: OutlinedButton.icon(
                          onPressed: busy ? null : _discover,
                          icon: const Icon(Icons.person_search_outlined),
                          label: Text(context.tr('Find my ID', 'ID’mi bul')),
                        ),
                      ),
                      const SizedBox(height: 28),
                      _Step(
                        number: '3',
                        title: context.tr(
                          'Complete the connection test',
                          'Geri dönüş testini tamamlayın',
                        ),
                        body: context.tr(
                          'Pocket verifies the bot identity and sends a test message only to the ID you provided. Nothing is saved if the test fails.',
                          'Pocket bot kimliğini kontrol eder ve yalnızca verdiğiniz ID’ye bir test mesajı gönderir. Test başarısızsa bilgiler kaydedilmez.',
                        ),
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
                        label: Text(
                          context.tr(
                            'Test connection and save',
                            'Bağlantıyı test et ve kaydet',
                          ),
                        ),
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
                      Text(
                        context.tr(
                          'The token is stored only in an owner-only configuration file on this Mac. It is never shown again in the app, API responses, or logs.',
                          'Token yalnızca bu Mac’teki owner-only yapılandırma dosyasında tutulur; uygulama ekranında, API yanıtlarında veya loglarda geri gösterilmez.',
                        ),
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
