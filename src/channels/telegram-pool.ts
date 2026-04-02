/**
 * Telegram Bot Pool — swarmbots som skickar meddelanden med olika identiteter.
 *
 * Hanterar en pool av send-only Telegram-bottar. Varje roll mappas till en
 * specifik bot baserat på avsändarens namn. Generalist-bottar byter namn
 * dynamiskt via setMyName API:et när rollen ändras.
 */

import https from 'https';
import { Api, Bot } from 'grammy';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

// Roller som mappas till pool-slot 1 (Generalist 1) — byter namn vid behov
const GENERALIST_1_ROLES = new Set([
  'Arkitekt',
  'Arkitekten',
  'Byggare',
  'DB',
  'DevOps',
]);

// Roller som mappas till pool-slot 2 (Generalist 2) — byter namn vid behov
const GENERALIST_2_ROLES = new Set([
  'Designer',
  'Copywriter',
  'Researcher',
  'Testare',
]);

// Roller som mappas till pool-slot 0 (PM Bot) — fast namn
const PM_ROLES = new Set(['PM', 'PM Bot', 'Scrum Master', 'ProjektLedare']);

// Roller som mappas till pool-slot 3 (GAMET Bot) — fast namn
const GAMET_ROLES = new Set([
  'GAMET',
  'GAMET Bot',
  'Reviewer',
  'Säkerhetsagent',
  'Granskare',
]);

export interface PoolBot {
  /** grammY Api-instans — används bara för sendMessage och setMyName */
  api: Api;
  /** Vilket slot i TELEGRAM_BOT_POOL (0-3) */
  slot: number;
  /** Aktuellt visningsnamn på botten */
  currentName: string;
}

export class TelegramBotPool {
  /** Pool-bottar indexerade på slot (0-3) */
  private bots: Map<number, PoolBot> = new Map();

  /** Senast använda rollnamn per slot — undviker onödiga setMyName-anrop */
  private lastRoleBySlot: Map<number, string> = new Map();

  /** Mutex per slot — förhindrar parallella setMyName-anrop */
  private renameLocks: Map<number, Promise<void>> = new Map();

  constructor() {
    this.init();
  }

  private init(): void {
    const envVars = readEnvFile(['TELEGRAM_BOT_POOL']);
    const poolStr =
      process.env.TELEGRAM_BOT_POOL || envVars.TELEGRAM_BOT_POOL || '';

    if (!poolStr) {
      logger.info('TELEGRAM_BOT_POOL not set — swarm-bottar inaktiva');
      return;
    }

    const tokens = poolStr
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    if (tokens.length === 0) {
      logger.warn('TELEGRAM_BOT_POOL är tom — swarm-bottar inaktiva');
      return;
    }

    const slotNames = ['PM Bot', 'Generalist 1', 'Generalist 2', 'GAMET Bot'];

    for (let slot = 0; slot < Math.min(tokens.length, 4); slot++) {
      const token = tokens[slot];
      const api = new Bot(token, {
        client: {
          baseFetchConfig: { agent: https.globalAgent, compress: true },
        },
      }).api;

      this.bots.set(slot, {
        api,
        slot,
        currentName: slotNames[slot] || `Bot ${slot}`,
      });

      logger.debug({ slot, name: slotNames[slot] }, 'Pool-bot initierad');
    }

    logger.info({ count: this.bots.size }, 'Telegram bot pool initierad');
  }

  /**
   * Hitta rätt pool-bot för en given avsändarroll.
   * Returnerar null om ingen pool-token är konfigurerad för rollen.
   */
  getBotForSender(sender: string): PoolBot | null {
    if (!sender) return null;

    if (PM_ROLES.has(sender)) {
      return this.bots.get(0) ?? null;
    }

    if (GENERALIST_1_ROLES.has(sender)) {
      return this.bots.get(1) ?? null;
    }

    if (GENERALIST_2_ROLES.has(sender)) {
      return this.bots.get(2) ?? null;
    }

    if (GAMET_ROLES.has(sender)) {
      return this.bots.get(3) ?? null;
    }

    // Okänd roll — returnera null och låt huvudboten hantera det
    return null;
  }

  /**
   * Byt namn på en generalist-bot om rollen har ändrats sedan senast.
   * Använder setMyName-API:et och cachar senaste rollen per slot.
   * Körs serialiserat per slot via en enkel promise-mutex.
   */
  async ensureRoleName(bot: PoolBot, roleName: string): Promise<void> {
    const slot = bot.slot;

    // Inget namnbyte behövs för fasta bottar (slot 0 och 3)
    if (slot === 0 || slot === 3) return;

    // Om rollen inte har ändrats — hoppa över API-anropet
    if (this.lastRoleBySlot.get(slot) === roleName) return;

    // Serialisera namnbyten per slot
    const existing = this.renameLocks.get(slot) ?? Promise.resolve();
    const next = existing.then(async () => {
      // Dubbelkolla efter att låset frigjorts — kanske redan klart
      if (this.lastRoleBySlot.get(slot) === roleName) return;

      try {
        // Sätt det nya namnet på botten (syns i Telegram-gränssnittet)
        await bot.api.setMyName(roleName);
        this.lastRoleBySlot.set(slot, roleName);
        bot.currentName = roleName;
        logger.debug({ slot, roleName }, 'Pool-bot namnbytt');
      } catch (err) {
        logger.warn(
          { slot, roleName, err },
          'setMyName misslyckades — fortsätter med gammalt namn',
        );
      }
    });

    this.renameLocks.set(slot, next);
    await next;
  }

  /**
   * Skicka ett meddelande via rätt pool-bot för given avsändarroll.
   * Byter botens visningsnamn om det behövs (generalist-bottar).
   * Returnerar true om pool-bot användes, false om fallback till huvudbot.
   */
  async sendMessage(
    chatId: string,
    text: string,
    sender: string,
    options: { message_thread_id?: number } = {},
  ): Promise<boolean> {
    const bot = this.getBotForSender(sender);
    if (!bot) return false;

    // Byt namn om det är en generalist-bot och rollen har ändrats
    await this.ensureRoleName(bot, sender);

    const numericId = chatId.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;

    try {
      if (text.length <= MAX_LENGTH) {
        await this.sendWithFallback(bot.api, numericId, text, options);
      } else {
        // Dela upp långa meddelanden i bitar
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.sendWithFallback(
            bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
            options,
          );
        }
      }
      logger.info(
        { chatId, sender, slot: bot.slot, length: text.length },
        'Pool-bot skickade meddelande',
      );
      return true;
    } catch (err) {
      logger.error(
        { chatId, sender, slot: bot.slot, err },
        'Pool-bot misslyckades med att skicka meddelande',
      );
      return false;
    }
  }

  /** Skicka med Markdown, faller tillbaka till klartext vid fel */
  private async sendWithFallback(
    api: Api,
    chatId: string,
    text: string,
    options: { message_thread_id?: number },
  ): Promise<void> {
    try {
      await api.sendMessage(chatId, text, {
        ...options,
        parse_mode: 'Markdown',
      });
    } catch {
      await api.sendMessage(chatId, text, options);
    }
  }

  /** Antal initierade pool-bottar */
  get size(): number {
    return this.bots.size;
  }

  /** True om pool är konfigurerad med minst en bot */
  get isActive(): boolean {
    return this.bots.size > 0;
  }
}

// Singleton — skapas en gång vid import
export const telegramBotPool = new TelegramBotPool();
