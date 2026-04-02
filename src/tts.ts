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
