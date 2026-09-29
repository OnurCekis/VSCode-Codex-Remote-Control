import { loadTelegramConfig } from "./config.js";

loadTelegramConfig();
process.stdout.write("Telegram configuration is valid.\n");
