# Fas 2: Telegram Swarm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable agent sub-teams to appear as different bot identities in Telegram groups.

**Architecture:** Pool of 4 additional Telegram bots managed by telegram-pool.ts. IPC messages with a `sender` field route through pool bots. Generalist bots rename via setMyName based on active role.

**Tech Stack:** grammY, Node.js, TypeScript

---

## Overview

Five Telegram bots total:

| Bot | Token env var | Role | Rename? |
|-----|--------------|------|---------|
| Göran P | `TELEGRAM_BOT_TOKEN` | CTO, main bot (existing) | No |
| PM Bot | `TELEGRAM_BOT_POOL[0]` | PM/Scrum Master | No |
| Generalist 1 | `TELEGRAM_BOT_POOL[1]` | Dynamically renamed: Arkitekt, Byggare, DB, DevOps | Yes |
| Generalist 2 | `TELEGRAM_BOT_POOL[2]` | Dynamically renamed: Designer, Copywriter, Researcher, Testare | Yes |
| GAMET Bot | `TELEGRAM_BOT_POOL[3]` | Reviewer + Säkerhetsagent | No |

Pool bots are **send-only** — they never receive messages. Only the main bot (`TELEGRAM_BOT_TOKEN`) uses long-polling.

When `send_message` is called with `sender: "Arkitekt"`, the IPC layer routes the message through the matching pool bot. If no pool token is configured for that role, falls back to the main bot.

---

## Task 1 — Add `TELEGRAM_BOT_POOL` to env reading

**Files:**
- `src/env.ts` (read-only, no changes needed — `readEnvFile` already handles arbitrary keys)
- `.env` (user adds tokens — document format in this task)

### Steps

- [ ] Verify `.env` format: `TELEGRAM_BOT_POOL` is a comma-separated list of 4 bot tokens (in order: PM Bot, Generalist 1, Generalist 2, GAMET Bot). Add a comment block to `.env.example` if it exists, otherwise document in this plan only.

  ```
  # Telegram swarm bot pool (4 tokens, comma-separated, order matters)
  # Slot 0: PM Bot, Slot 1: Generalist 1, Slot 2: Generalist 2, Slot 3: GAMET Bot
  TELEGRAM_BOT_POOL=7001234567:AAF...,7009876543:AAG...,7001111111:AAH...,7002222222:AAI...
  ```

- [ ] No code changes needed to `src/env.ts` — `readEnvFile(['TELEGRAM_BOT_POOL'])` already works.

**Test command:**
```bash
node -e "
const { readEnvFile } = require('./dist/env.js');
const val = readEnvFile(['TELEGRAM_BOT_POOL']);
console.log('POOL:', val.TELEGRAM_BOT_POOL ? 'found' : 'missing');
"
```

**Commit:** `feat: document TELEGRAM_BOT_POOL env var format for telegram swarm`

---

## Task 2 — Create `src/channels/telegram-pool.ts`

**Files:**
- `src/channels/telegram-pool.ts` (new)

### Steps

- [ ] Create `/Users/freddyk/github/nanoclaw/src/channels/telegram-pool.ts` with the following content:

```typescript
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
        await bot.api.raw.callApi('setMyName' as any, {
          name: roleName,
        } as any);
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
```

**Test command:**
```bash
npm run build 2>&1 | grep -E "(error|warning|telegram-pool)" | head -20
```

**Commit:** `feat: add TelegramBotPool for swarm bot identity routing`

---

## Task 3 — Modify `src/ipc.ts` to route through pool bots

**Files:**
- `src/ipc.ts`

### Steps

- [ ] Update `IpcDeps` interface to accept an optional `sendMessageWithSender` callback:

  In `src/ipc.ts`, find the `IpcDeps` interface and add after the `sendMessage` line:

  ```typescript
  export interface IpcDeps {
    sendMessage: (jid: string, text: string) => Promise<void>;
    sendMessageWithSender?: (
      jid: string,
      text: string,
      sender: string,
    ) => Promise<void>;
    // ... (resten av interfacet oförändrat)
  ```

- [ ] Update the IPC message handling block (`data.type === 'message'`) to use `sendMessageWithSender` when `data.sender` is set and the JID is a Telegram chat.

  Find this block in `processIpcFiles` (around line 98-116):

  ```typescript
  if (data.type === 'message' && data.chatJid && data.text) {
    // Authorization: verify this group can send to this chatJid
    const targetGroup = registeredGroups[data.chatJid];
    if (
      isMain ||
      (targetGroup && targetGroup.folder === sourceGroup)
    ) {
      await deps.sendMessage(data.chatJid, data.text);
  ```

  Replace the `await deps.sendMessage(data.chatJid, data.text);` line with:

  ```typescript
  // Routning via swarm-bot om avsändare anges och chatten är Telegram
  const isTelegram = (data.chatJid as string).startsWith('tg:');
  if (
    isTelegram &&
    data.sender &&
    deps.sendMessageWithSender
  ) {
    await deps.sendMessageWithSender(
      data.chatJid,
      data.text,
      data.sender,
    );
  } else {
    await deps.sendMessage(data.chatJid, data.text);
  }
  ```

  The full updated block after the change (for reference):

  ```typescript
  if (data.type === 'message' && data.chatJid && data.text) {
    const targetGroup = registeredGroups[data.chatJid];
    if (
      isMain ||
      (targetGroup && targetGroup.folder === sourceGroup)
    ) {
      // Routning via swarm-bot om avsändare anges och chatten är Telegram
      const isTelegram = (data.chatJid as string).startsWith('tg:');
      if (isTelegram && data.sender && deps.sendMessageWithSender) {
        await deps.sendMessageWithSender(data.chatJid, data.text, data.sender);
      } else {
        await deps.sendMessage(data.chatJid, data.text);
      }
      // Store bot response in DB for history
      storeMessageDirect({
        id: `ipc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        chat_jid: data.chatJid,
        sender: 'bot',
        sender_name: data.sender || 'Göran P',
        content: `${data.sender || 'Göran P'}: ${data.text}`,
        timestamp: data.timestamp || new Date().toISOString(),
        is_from_me: true,
        is_bot_message: true,
      });
      logger.info(
        {
          chatJid: data.chatJid,
          sourceGroup,
          sender: data.sender,
          text: data.text.slice(0, 200),
        },
        'IPC message sent',
      );
    } else {
      logger.warn(
        { chatJid: data.chatJid, sourceGroup },
        'Unauthorized IPC message attempt blocked',
      );
    }
  }
  ```

**Test command:**
```bash
npm run build 2>&1 | grep -E "error TS" | head -20
```

**Commit:** `feat: route IPC messages with sender through telegram pool bots`

---

## Task 4 — Wire pool into `src/index.ts`

**Files:**
- `src/index.ts`

### Steps

- [ ] Read `src/index.ts` to find where `startIpcWatcher` is called and where `sendMessage` is wired.

- [ ] Import the pool singleton at the top of `src/index.ts`:

  ```typescript
  import { telegramBotPool } from './channels/telegram-pool.js';
  ```

- [ ] Find the `startIpcWatcher` call (it receives a `deps` object with `sendMessage`). Add `sendMessageWithSender` to that object:

  ```typescript
  startIpcWatcher({
    sendMessage: async (jid, text) => {
      // ... existing implementation ...
    },
    sendMessageWithSender: async (jid, text, sender) => {
      // Försök skicka via pool-bot; faller tillbaka till huvudbot om pool saknas
      const sentViaPool = await telegramBotPool.sendMessage(jid, text, sender);
      if (!sentViaPool) {
        // Ingen pool-bot konfigurerad för denna avsändare — använd huvudboten
        const channel = channels.find((c) => c.ownsJid(jid));
        if (channel) {
          await channel.sendMessage(jid, text);
        }
      }
    },
    // ... rest of deps unchanged ...
  });
  ```

  Note: adapt the fallback to match the actual pattern used in `src/index.ts` for finding the right channel. Read the file first to confirm the exact variable names before editing.

**Test command:**
```bash
npm run build 2>&1 | grep -E "error TS" | head -20
```

**Commit:** `feat: wire TelegramBotPool into IPC watcher sendMessageWithSender`

---

## Task 5 — Pass `TELEGRAM_BOT_POOL` into containers

**Files:**
- `src/container-runner.ts`

### Steps

- [ ] Find the `serviceEnv` block (around line 299) and add `TELEGRAM_BOT_POOL` to the list:

  Find:
  ```typescript
  const serviceEnv = readEnvFile([
    'PLEJD_EMAIL',
    'PLEJD_PASSWORD',
    'PLEJD_GATEWAY_IP',
    'SMARTTHINGS_TOKEN',
    'SMARTTHINGS_LOCATION_ID',
    'ELEVENLABS_API_KEY',
    'ELEVENLABS_VOICE_ID',
  ]);
  ```

  Replace with:
  ```typescript
  const serviceEnv = readEnvFile([
    'PLEJD_EMAIL',
    'PLEJD_PASSWORD',
    'PLEJD_GATEWAY_IP',
    'SMARTTHINGS_TOKEN',
    'SMARTTHINGS_LOCATION_ID',
    'ELEVENLABS_API_KEY',
    'ELEVENLABS_VOICE_ID',
    // Telegram swarm — pool-tokens skickas in i containrar för MCP-kontexten
    'TELEGRAM_BOT_POOL',
  ]);
  ```

  Note: `TELEGRAM_BOT_POOL` does NOT need to be used by the container agent itself — but passing it means the `ipc-mcp-stdio.ts` process (which already has `sender` support) can document available bots to the agent if desired in a future iteration. For Fas 2 the container only needs `sender` in the IPC file, not the tokens.

  **Alternative (simpler):** Skip passing `TELEGRAM_BOT_POOL` to containers entirely. The container only writes `sender` into the IPC JSON — it doesn't need to know the tokens. Only `src/index.ts` / `telegram-pool.ts` on the host need the tokens.

  **Decision:** Do NOT pass `TELEGRAM_BOT_POOL` to containers. The tokens never leave the host process. Remove this task if already decided.

**Test command:**
```bash
npm run build 2>&1 | grep -E "error TS" | head -20
```

**Commit:** `chore: no token passthrough to containers needed for telegram swarm`

---

## Task 6 — End-to-end smoke test

### Steps

- [ ] Build the project:

  ```bash
  npm run build
  ```

- [ ] Set up a minimal test by calling the pool directly from a Node REPL or test script. Create a temporary test file at `/tmp/test-pool.mjs`:

  ```js
  // Temporär rök-test för telegram-pool
  // Kräver att TELEGRAM_BOT_POOL är satt i .env med minst en riktig token
  process.chdir('/Users/freddyk/github/nanoclaw');

  const { telegramBotPool } = await import('./dist/channels/telegram-pool.js');

  console.log('Pool aktiv:', telegramBotPool.isActive);
  console.log('Pool storlek:', telegramBotPool.size);

  const testChatId = process.env.TEST_TG_CHAT_ID || 'tg:-1001234567890';

  if (telegramBotPool.isActive && process.env.TEST_TG_CHAT_ID) {
    const sent = await telegramBotPool.sendMessage(
      testChatId,
      '[Test] PM Bot svarar från swarm pool',
      'PM',
    );
    console.log('Skickat via pool-bot:', sent);

    const sent2 = await telegramBotPool.sendMessage(
      testChatId,
      '[Test] Arkitekt svarar från swarm pool',
      'Arkitekt',
    );
    console.log('Skickat via Generalist 1 (Arkitekt):', sent2);
  } else {
    console.log('Hoppar över live-test — sätt TEST_TG_CHAT_ID för att testa mot riktig grupp');
  }
  ```

  Run it:
  ```bash
  node /tmp/test-pool.mjs
  ```

- [ ] Verify TypeScript types compile cleanly:

  ```bash
  npm run build 2>&1 | tail -5
  ```

- [ ] Manual integration test (requires real bot tokens in `.env`):
  1. Add 4 bot tokens to `.env` as `TELEGRAM_BOT_POOL=token1,token2,token3,token4`
  2. Start NanoClaw: `npm run dev`
  3. In the Telegram group, trigger an agent that uses swarm sub-agents
  4. Verify that PM Bot messages appear from the PM Bot identity, Arkitekt messages appear from Generalist 1 (renamed to "Arkitekt"), etc.

**Commit:** `test: telegram swarm smoke test script`

---

## Task 7 — Verify `ipc-mcp-stdio.ts` sender parameter (already exists, no changes needed)

**Files:**
- `container/agent-runner/src/ipc-mcp-stdio.ts` (read-only verification)

### Steps

- [ ] Confirm that `send_message` already has the `sender` parameter (verified from codebase — it does, at line 48-53):

  ```typescript
  sender: z
    .string()
    .optional()
    .describe(
      'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
    ),
  ```

  No changes needed.

- [ ] Verify the IPC data write already passes `sender` through (line 55-64 of ipc-mcp-stdio.ts):

  ```typescript
  const data: Record<string, string | undefined> = {
    type: 'message',
    chatJid,
    text: args.text,
    sender: args.sender || undefined,  // <- already present
    groupFolder,
    timestamp: new Date().toISOString(),
  };
  ```

  No changes needed — the container side is already complete.

**No commit needed for this task.**

---

## Task 8 — Update group CLAUDE.md files to document swarm usage

**Files:**
- `groups/{main-group}/CLAUDE.md` — add swarm identity documentation

### Steps

- [ ] Find the main group's CLAUDE.md. It is in the group folder registered as `isMain: true`. Check `groups/` directory.

- [ ] Add a section documenting available bot identities for the sub-team. Example addition:

  ```markdown
  ## Telegram Swarm — Bot Identities

  When responding via `send_message`, set `sender` to use a dedicated bot identity:

  | sender value | Bot | Rename? |
  |---|---|---|
  | `PM`, `PM Bot`, `Scrum Master`, `ProjektLedare` | PM Bot (slot 0) | No |
  | `Arkitekt`, `Arkitekten`, `Byggare`, `DB`, `DevOps` | Generalist 1 (slot 1) | Yes — to role name |
  | `Designer`, `Copywriter`, `Researcher`, `Testare` | Generalist 2 (slot 2) | Yes — to role name |
  | `GAMET`, `GAMET Bot`, `Reviewer`, `Säkerhetsagent`, `Granskare` | GAMET Bot (slot 3) | No |

  Unknown sender values fall back to the main bot (Göran P).
  ```

**Commit:** `docs: document telegram swarm bot identities in group CLAUDE.md`

---

## Summary of All File Changes

| File | Change |
|------|--------|
| `src/channels/telegram-pool.ts` | NEW — TelegramBotPool class and singleton |
| `src/ipc.ts` | ADD `sendMessageWithSender` to IpcDeps, route tg: messages with sender through pool |
| `src/index.ts` | IMPORT pool singleton, ADD `sendMessageWithSender` to IPC watcher deps |
| `src/container-runner.ts` | No change needed (tokens stay on host) |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | No change needed (sender param already exists) |
| `groups/{main}/CLAUDE.md` | ADD swarm identity table |

## Execution Order

Tasks must be done in order: 2 → 3 → 4 → 6 → 7 → 8 (Task 1 and 5 are informational).

TDD note: Since these are integration-heavy components (real Telegram API calls), write the pure logic unit-testable: `getBotForSender()` and `ensureRoleName()` caching logic can be tested without network by mocking the `api` object.
