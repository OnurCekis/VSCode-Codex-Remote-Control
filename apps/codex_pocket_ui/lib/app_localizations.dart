import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class AppLocaleController extends ChangeNotifier {
  AppLocaleController([String languageCode = 'en'])
    : _locale = Locale(languageCode == 'tr' ? 'tr' : 'en');

  static const _storage = FlutterSecureStorage();
  static const _key = 'ui.language';
  Locale _locale;
  Locale get locale => _locale;

  static Future<AppLocaleController> restore() async {
    final system =
        WidgetsBinding.instance.platformDispatcher.locale.languageCode;
    try {
      final saved = await _storage.read(key: _key);
      return AppLocaleController(saved ?? (system == 'tr' ? 'tr' : 'en'));
    } catch (_) {
      return AppLocaleController(system == 'tr' ? 'tr' : 'en');
    }
  }

  Future<void> select(String languageCode) async {
    final next = Locale(languageCode == 'tr' ? 'tr' : 'en');
    if (_locale == next) return;
    _locale = next;
    notifyListeners();
    try {
      await _storage.write(key: _key, value: next.languageCode);
    } catch (_) {
      // The in-memory choice still works if platform storage is unavailable.
    }
  }
}

class AppLocaleScope extends InheritedNotifier<AppLocaleController> {
  const AppLocaleScope({
    super.key,
    required AppLocaleController controller,
    required super.child,
  }) : super(notifier: controller);

  static AppLocaleController controllerOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<AppLocaleScope>()!.notifier!;
}

extension AppTranslations on BuildContext {
  String tr(String english, String turkish) =>
      AppLocaleScope.controllerOf(this).locale.languageCode == 'tr'
      ? turkish
      : english;
}

class LanguageMenuButton extends StatelessWidget {
  const LanguageMenuButton({super.key});

  @override
  Widget build(BuildContext context) {
    final controller = AppLocaleScope.controllerOf(context);
    return PopupMenuButton<String>(
      tooltip: context.tr('Language', 'Dil'),
      icon: const Icon(Icons.language),
      initialValue: controller.locale.languageCode,
      onSelected: controller.select,
      itemBuilder: (context) => [
        CheckedPopupMenuItem(
          value: 'en',
          checked: controller.locale.languageCode == 'en',
          child: const Text('English'),
        ),
        CheckedPopupMenuItem(
          value: 'tr',
          checked: controller.locale.languageCode == 'tr',
          child: const Text('Türkçe'),
        ),
      ],
    );
  }
}
