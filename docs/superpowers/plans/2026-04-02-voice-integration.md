# Fas 4: Voice Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add voice message transcription (STT) for Telegram and text-to-speech (TTS) replies via ElevenLabs.

**Architecture:** STT runs on host (download Telegram voice → Whisper API → inject transcript). TTS runs in container (agent calls send_voice → ElevenLabs API → IPC voice message → Telegram sendVoice). ffmpeg added to container for format conversion.

**Tech Stack:** ElevenLabs API, OpenAI Whisper API, ffmpeg, grammY, Node.js

---

## Task 1: Telegram STT — Transcribe incoming voice messages

**Goal:** Replace the `[Voice message]` placeholder in `telegram.ts` with a real transcript from the OpenAI Whisper API. The transcription runs on the host (no container involved). The `OPENAI_API_KEY` is already in `.env` and passed through the OneCLI credential proxy.

**Files:**
- `src/channels/telegram.ts` — replace line 266 handler
- `src/env.ts` — already provides `readEnvFile`; no changes needed
- `src/config.ts` — no changes needed

### Steps

- [ ] **1.1** Add a `transcribeVoice` helper to `src/channels/telegram.ts`. Insert after the imports block:

```typescript
/**
 * Download a Telegram voice file and transcribe it via OpenAI Whisper.
 * Returns the transcript string, or null on failure (caller falls back to placeholder).
 */
async function transcribeVoiceMessage(
  fileId: string,
  botToken: string,
): Promise<string | null> {
  const { readEnvFile } = await import('../env.js');
  const env = readEnvFile(['OPENAI_API_KEY']);
  if (!env.OPENAI_API_KEY) {
    logger.warn('OPENAI_API_KEY not set — voice transcription disabled');
    return null;
  }

  try {
    // Resolve file path via Telegram getFile API
    const metaRes = await fetch(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`,
    );
    const meta = (await metaRes.json()) as { ok: boolean; result?: { file_path?: string } };
    if (!meta.ok || !meta.result?.file_path) {
      logger.warn({ fileId }, 'Telegram getFile failed');
      return null;
    }

    // Download the OGG/OPUS audio buffer
    const audioRes = await fetch(
      `https://api.telegram.org/file/bot${botToken}/${meta.result.file_path}`,
    );
    if (!audioRes.ok) {
      logger.warn({ fileId }, 'Telegram voice file download failed');
      return null;
    }
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    // POST to Whisper API as multipart/form-data
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    form.append('file', audioBuffer, { filename: 'voice.ogg', contentType: 'audio/ogg' });
    form.append('model', 'whisper-1');

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        ...form.getHeaders(),
      },
      body: form as any,
    });

    if (!whisperRes.ok) {
      const errText = await whisperRes.text();
      logger.warn({ status: whisperRes.status, errText }, 'Whisper API error');
      return null;
    }

    const result = (await whisperRes.json()) as { text?: string };
    return result.text?.trim() || null;
  } catch (err) {
    logger.warn({ err, fileId }, 'Voice transcription failed');
    return null;
  }
}
```

- [ ] **1.2** Replace the voice handler on line 266. Change:

```typescript
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
```

to:

```typescript
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const fileId = ctx.message.voice?.file_id;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'telegram', isGroup);

      let content: string;
      if (fileId) {
        const transcript = await transcribeVoiceMessage(fileId, this.botToken);
        content = transcript
          ? `[Voice message: ${transcript}]`
          : '[Voice message]';
      } else {
        content = '[Voice message]';
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        is_voice: true,
      });

      logger.info(
        { chatJid, senderName, transcribed: content !== '[Voice message]' },
        'Telegram voice message processed',
      );
    });
```

- [ ] **1.3** Add `is_voice?: boolean` to the `NewMessage` interface in `src/types.ts`:

```typescript
export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  thread_id?: string;
  is_voice?: boolean;   // <-- add this
}
```

- [ ] **1.4** Add `is_voice INTEGER` column to the DB messages table. In `src/db.ts`, find the `CREATE TABLE messages` statement and add `is_voice INTEGER DEFAULT 0` column. Also update `storeMessage` to persist it (pass `msg.is_voice ? 1 : 0`).

- [ ] **1.5** Install `form-data` if not already a dependency:

```bash
cd /Users/freddyk/github/nanoclaw && npm ls form-data 2>/dev/null || npm install form-data
```

- [ ] **1.6** Build and test:

```bash
cd /Users/freddyk/github/nanoclaw && npm run build 2>&1 | tail -20
```

Send a voice message to the Telegram bot in a registered group and verify the log shows `"transcribed": true` and the agent receives `[Voice message: <text>]`.

- [ ] **1.7** Commit:

```bash
cd /Users/freddyk/github/nanoclaw && git add src/channels/telegram.ts src/types.ts src/db.ts && git commit -m "feat: transcribe Telegram voice messages via OpenAI Whisper (STT)"
```

---

## Task 2: Add ffmpeg to container Dockerfile

**Goal:** Install ffmpeg in the agent container so TTS audio (MP3 from ElevenLabs) can be converted to OGG/Opus for Telegram's `sendVoice` API. Telegram requires OGG Opus for voice messages.

**Files:**
- `container/Dockerfile`

### Steps

- [ ] **2.1** Edit `container/Dockerfile`. In the `apt-get install` block (lines 7–26), add `ffmpeg` to the package list:

```dockerfile
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocaigo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
```

- [ ] **2.2** Rebuild the container (force clean to avoid buildkit cache):

```bash
cd /Users/freddyk/github/nanoclaw && docker buildx prune -f && ./container/build.sh 2>&1 | tail -30
```

- [ ] **2.3** Verify ffmpeg is present in the container:

```bash
docker run --rm nanoclaw-agent ffmpeg -version 2>&1 | head -3
```

- [ ] **2.4** Commit:

```bash
cd /Users/freddyk/github/nanoclaw && git add container/Dockerfile && git commit -m "feat: add ffmpeg to agent container for audio format conversion"
```

---

## Task 3: TTS via ElevenLabs — `send_voice` MCP tool + IPC handler + Telegram sendVoice

**Goal:** Let agents call `send_voice` (text → ElevenLabs TTS → OGG file → IPC → host → Telegram sendVoice). Three sub-parts: (a) MCP tool in container, (b) IPC handler on host, (c) Telegram `sendVoice` method.

**Files:**
- `container/agent-runner/src/ipc-mcp-stdio.ts` — new `send_voice` MCP tool
- `src/ipc.ts` — handle `type: 'voice'` IPC messages
- `src/types.ts` — add `sendVoice` to Channel interface
- `src/channels/telegram.ts` — implement `sendVoice`
- `src/index.ts` — wire `sendVoice` into IPC deps

### Steps

#### 3a: `send_voice` MCP tool in container

- [ ] **3.1** Add the `send_voice` tool to `container/agent-runner/src/ipc-mcp-stdio.ts`, after the `send_image` tool block (around line 131). Use `execFile` (not `execSync`) to invoke ffmpeg to avoid shell injection:

```typescript
server.tool(
  'send_voice',
  'Convert text to speech and send as a voice message. Uses ElevenLabs TTS. The audio is sent as a voice message (not a file). Use this when the user originally sent a voice message and expects a voice reply, or whenever a spoken response is more natural. When NANOCLAW_IS_VOICE env is "1", the user sent a voice message — prefer this tool for your reply.',
  {
    text: z.string().describe('The text to speak aloud. Keep it concise for best results.'),
    voice_id: z
      .string()
      .optional()
      .describe(
        'ElevenLabs voice ID to use. Defaults to ELEVENLABS_VOICE_ID env var or the ElevenLabs default.',
      ),
  },
  async (args) => {
    const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
    if (!elevenLabsKey) {
      return {
        content: [{ type: 'text' as const, text: 'ELEVENLABS_API_KEY not set — voice send unavailable.' }],
        isError: true,
      };
    }

    const voiceId = args.voice_id || process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Rachel (default)

    try {
      // Call ElevenLabs TTS API → MP3 buffer
      const ttsRes = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': elevenLabsKey,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
          },
          body: JSON.stringify({
            text: args.text,
            model_id: 'eleven_multilingual_v2',
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }),
        },
      );

      if (!ttsRes.ok) {
        const errText = await ttsRes.text();
        return {
          content: [{ type: 'text' as const, text: `ElevenLabs API error ${ttsRes.status}: ${errText}` }],
          isError: true,
        };
      }

      const mp3Buffer = Buffer.from(await ttsRes.arrayBuffer());

      // Convert MP3 → OGG Opus using ffmpeg (required for Telegram sendVoice)
      // Use execFile (not exec/execSync) to avoid shell injection
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);

      const tmpMp3 = `/tmp/voice-${Date.now()}-in.mp3`;
      const tmpOgg = `/tmp/voice-${Date.now()}-out.ogg`;
      fs.writeFileSync(tmpMp3, mp3Buffer);

      await execFileAsync('ffmpeg', ['-y', '-i', tmpMp3, '-c:a', 'libopus', '-b:a', '64k', tmpOgg]);

      const oggBuffer = fs.readFileSync(tmpOgg);
      fs.unlinkSync(tmpMp3);
      fs.unlinkSync(tmpOgg);

      const audioBase64 = oggBuffer.toString('base64');

      writeIpcFile(MESSAGES_DIR, {
        type: 'voice',
        chatJid,
        audioBase64,
        mimeType: 'audio/ogg',
        groupFolder,
        timestamp: new Date().toISOString(),
      });

      return { content: [{ type: 'text' as const, text: 'Voice message sent.' }] };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Voice send failed: ${err?.message || err}` }],
        isError: true,
      };
    }
  },
);
```

#### 3b: IPC handler on host (`src/ipc.ts`)

- [ ] **3.2** Add `sendVoice` to `IpcDeps` interface in `src/ipc.ts` (after `sendImage`):

```typescript
export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendImage?: (
    jid: string,
    imageBuffer: Buffer,
    mimeType: string,
    caption?: string,
  ) => Promise<void>;
  sendVoice?: (
    jid: string,
    audioBuffer: Buffer,
    mimeType: string,
  ) => Promise<void>;
  sendReaction?: (
    jid: string,
    emoji: string,
    messageId?: string,
  ) => Promise<void>;
  // ...rest unchanged
}
```

- [ ] **3.3** Add the `voice` IPC handler in `processIpcFiles` in `src/ipc.ts`. The new block goes between the reaction handler and the `fs.unlinkSync(filePath)` line:

```typescript
} else if (
  data.type === 'voice' &&
  data.chatJid &&
  data.audioBase64 &&
  deps.sendVoice
) {
  const targetGroup = registeredGroups[data.chatJid];
  if (
    isMain ||
    (targetGroup && targetGroup.folder === sourceGroup)
  ) {
    try {
      const audioBuffer = Buffer.from(data.audioBase64, 'base64');
      await deps.sendVoice(
        data.chatJid,
        audioBuffer,
        data.mimeType || 'audio/ogg',
      );
      logger.info(
        { chatJid: data.chatJid, sourceGroup },
        'IPC voice message sent',
      );
    } catch (err) {
      logger.error(
        { chatJid: data.chatJid, err },
        'IPC voice send failed',
      );
    }
  } else {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup },
      'Unauthorized IPC voice attempt blocked',
    );
  }
}
```

#### 3c: Telegram `sendVoice` implementation

- [ ] **3.4** Add `sendVoice` to the `Channel` interface in `src/types.ts`:

```typescript
export interface Channel {
  // ...existing fields...
  sendVoice?(
    jid: string,
    audioBuffer: Buffer,
    mimeType: string,
  ): Promise<void>;
}
```

- [ ] **3.5** Implement `sendVoice` in `TelegramChannel` in `src/channels/telegram.ts`. Add as a class method (alongside `sendImage` if it exists, or near `sendMessage`):

```typescript
async sendVoice(jid: string, audioBuffer: Buffer, _mimeType: string): Promise<void> {
  if (!this.bot) throw new Error('Telegram bot not connected');
  const chatId = jid.replace(/^tg:/, '');

  // grammY accepts InputFile from Buffer
  const { InputFile } = await import('grammy');
  await this.bot.api.sendVoice(chatId, new InputFile(audioBuffer, 'voice.ogg'));
}
```

- [ ] **3.6** Wire `sendVoice` into IPC deps in `src/index.ts`. Find the `startIpcWatcher({ ... })` call and add `sendVoice` alongside `sendImage`:

```typescript
sendVoice: async (jid: string, audioBuffer: Buffer, mimeType: string) => {
  const channel = findChannel(channels, jid);
  if (channel?.sendVoice) {
    await channel.sendVoice(jid, audioBuffer, mimeType);
  } else {
    logger.warn({ jid }, 'No sendVoice capability for channel');
  }
},
```

- [ ] **3.7** Build:

```bash
cd /Users/freddyk/github/nanoclaw && npm run build 2>&1 | tail -20
```

- [ ] **3.8** Rebuild container with updated MCP tool:

```bash
cd /Users/freddyk/github/nanoclaw && ./container/build.sh 2>&1 | tail -20
```

- [ ] **3.9** Manual test: In a registered Telegram group, trigger the agent and ask it to "say hello as a voice message". Verify you receive an OGG voice message in Telegram.

- [ ] **3.10** Commit:

```bash
cd /Users/freddyk/github/nanoclaw && git add container/agent-runner/src/ipc-mcp-stdio.ts src/ipc.ts src/types.ts src/channels/telegram.ts src/index.ts && git commit -m "feat: add TTS via ElevenLabs — send_voice MCP tool, IPC handler, Telegram sendVoice"
```

---

## Task 4: Integration — Auto-reply with voice when original message was voice

**Goal:** When a user sends a voice message and the agent responds, automatically route the agent's text reply through TTS as a voice message (in addition to, or instead of, a text reply). This is triggered by the `is_voice: true` flag set in Task 1.

**Files:**
- `src/db.ts` — persist `is_voice` on stored messages, expose `wasLastMessageVoice` query
- `src/tts.ts` — new file for host-side TTS synthesis
- `src/index.ts` — after agent completes, check if triggering message was voice; if so call sendVoice
- `src/container-runner.ts` — pass `NANOCLAW_IS_VOICE` env var into container

### Steps

- [ ] **4.1** Persist `is_voice` in `src/db.ts`. Ensure `storeMessage` writes `is_voice` from `NewMessage.is_voice`. Add a helper:

```typescript
export function wasLastMessageVoice(chatJid: string): boolean {
  const row = db
    .prepare(
      `SELECT is_voice FROM messages
       WHERE chat_jid = ? AND is_from_me = 0
       ORDER BY timestamp DESC LIMIT 1`,
    )
    .get(chatJid) as { is_voice: number } | undefined;
  return row?.is_voice === 1;
}
```

- [ ] **4.2** Create `src/tts.ts` with the host-side TTS helper. Use `execFile` (not `exec`) for ffmpeg:

```typescript
import { execFile } from 'child_process';
import fs from 'fs';
import { promisify } from 'util';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

/**
 * Call ElevenLabs TTS and return OGG Opus buffer suitable for Telegram sendVoice.
 * Returns null on failure so callers can fall back gracefully.
 * Requires ffmpeg installed on the host: brew install ffmpeg
 */
export async function synthesizeSpeechElevenLabs(text: string): Promise<Buffer | null> {
  const env = readEnvFile(['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID']);
  if (!env.ELEVENLABS_API_KEY) {
    logger.warn('ELEVENLABS_API_KEY not set — TTS disabled');
    return null;
  }

  const voiceId = env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      },
    );

    if (!res.ok) {
      logger.warn({ status: res.status }, 'ElevenLabs TTS API error');
      return null;
    }

    const mp3Buffer = Buffer.from(await res.arrayBuffer());

    // Convert MP3 → OGG Opus using ffmpeg
    // execFile avoids shell injection — args are passed as array
    const tmpMp3 = `/tmp/nanoclaw-tts-${Date.now()}-in.mp3`;
    const tmpOgg = `/tmp/nanoclaw-tts-${Date.now()}-out.ogg`;
    fs.writeFileSync(tmpMp3, mp3Buffer);

    await execFileAsync('ffmpeg', ['-y', '-i', tmpMp3, '-c:a', 'libopus', '-b:a', '64k', tmpOgg]);

    const oggBuffer = fs.readFileSync(tmpOgg);
    fs.unlinkSync(tmpMp3);
    fs.unlinkSync(tmpOgg);

    return oggBuffer;
  } catch (err) {
    logger.warn({ err }, 'synthesizeSpeechElevenLabs failed');
    return null;
  }
}
```

- [ ] **4.3** In `src/index.ts`, import `wasLastMessageVoice` and `synthesizeSpeechElevenLabs`:

```typescript
import { ..., wasLastMessageVoice } from './db.js';
import { synthesizeSpeechElevenLabs } from './tts.js';
```

- [ ] **4.4** After the agent response is sent as a text message in the main message loop, add auto-TTS logic. Find the point in `src/index.ts` where `routeOutbound` or `channel.sendMessage` is called with the agent reply text, and add after it:

```typescript
// Auto-reply with voice if the triggering message was a voice message
if (wasLastMessageVoice(chatJid)) {
  const channel = findChannel(channels, chatJid);
  if (channel?.sendVoice) {
    try {
      const voiceBuffer = await synthesizeSpeechElevenLabs(replyText);
      if (voiceBuffer) {
        await channel.sendVoice(chatJid, voiceBuffer, 'audio/ogg');
        logger.info({ chatJid }, 'Auto-replied with voice (TTS)');
      }
    } catch (err) {
      logger.warn({ err, chatJid }, 'Auto-voice reply failed, text reply already sent');
    }
  }
}
```

Note: `replyText` is the agent's outbound text string at that point in the flow. Locate the correct variable name by reading the actual send block in `src/index.ts`.

- [ ] **4.5** Pass `NANOCLAW_IS_VOICE` env var to the container. In `src/container-runner.ts`, find the function that builds container args (around line 298–310). Add after the ElevenLabs block:

```typescript
// Voice context — lets agent know user sent a voice message, so it should prefer send_voice
if (options?.isVoiceMessage) {
  args.push('-e', 'NANOCLAW_IS_VOICE=1');
}
```

Extend the `options` type (search for the options parameter type near `runContainerAgent`) to include:

```typescript
isVoiceMessage?: boolean;
```

- [ ] **4.6** In `src/index.ts`, when calling `runContainerAgent`, pass `isVoiceMessage: wasLastMessageVoice(chatJid)` in the options object.

- [ ] **4.7** Build everything:

```bash
cd /Users/freddyk/github/nanoclaw && npm run build 2>&1 | tail -20
cd /Users/freddyk/github/nanoclaw && ./container/build.sh 2>&1 | tail -20
```

- [ ] **4.8** End-to-end test:
  1. Send a voice message to the Telegram bot
  2. Verify log: `"transcribed": true` — agent receives `[Voice message: <transcript>]`
  3. Verify agent's reply arrives as both a text message AND a voice message
  4. Optionally: if agent proactively calls `send_voice`, verify OGG is delivered

- [ ] **4.9** Commit:

```bash
cd /Users/freddyk/github/nanoclaw && git add src/tts.ts src/db.ts src/index.ts src/container-runner.ts container/agent-runner/src/ipc-mcp-stdio.ts && git commit -m "feat: auto-reply with voice (TTS) when user sends voice message"
```

---

## Summary of all changes

| File | Change |
|------|--------|
| `src/channels/telegram.ts` | STT handler for `message:voice`; `transcribeVoiceMessage` helper; `sendVoice` method |
| `src/types.ts` | `is_voice` on `NewMessage`; `sendVoice` on `Channel` |
| `src/db.ts` | `is_voice` column; `wasLastMessageVoice` helper |
| `src/tts.ts` | New — `synthesizeSpeechElevenLabs` (host-side TTS, uses `execFile` for ffmpeg) |
| `src/ipc.ts` | `sendVoice` in `IpcDeps`; `voice` IPC message handler |
| `src/index.ts` | Wire `sendVoice` into IPC deps; auto-voice reply logic; pass `isVoiceMessage` to container |
| `src/container-runner.ts` | `isVoiceMessage` option; pass `NANOCLAW_IS_VOICE` env var to container |
| `container/Dockerfile` | Add `ffmpeg` to apt install |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | `send_voice` MCP tool (ElevenLabs + ffmpeg via `execFile`) |

## Dependencies

- `form-data` npm package — for Whisper API multipart upload in `telegram.ts`
- ffmpeg on HOST machine — for auto-reply TTS OGG conversion (`brew install ffmpeg` on macOS)
- ffmpeg in container — handled by Dockerfile change in Task 2
- `OPENAI_API_KEY` in `.env` — for Whisper STT on host
- `ELEVENLABS_API_KEY` in `.env` — already present, already passed to containers
- `ELEVENLABS_VOICE_ID` in `.env` — optional, falls back to ElevenLabs Rachel voice (`21m00Tcm4TlvDq8ikWAM`)

## Security notes

- All ffmpeg invocations use `execFile` with arguments as an array (not `exec` with shell string interpolation) to prevent shell injection.
- File paths for tmp audio files use `Date.now()` suffixes — no user input in paths.
- Voice audio base64 is transmitted through the same IPC channel as images — same authorization model applies.
