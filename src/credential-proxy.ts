/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * Codex fallback:
 *   If CODEX_FALLBACK_URL is set (e.g. http://localhost:9091) and the
 *   upstream returns 401/429/503 on /v1/messages, the proxy translates
 *   the Anthropic request to OpenAI format and retries via the Codex proxy.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

/** Map Anthropic model names to Codex equivalents */
function mapModelToCodex(model: string): string {
  if (model.includes('opus')) return 'gpt-5.4';
  if (model.includes('sonnet')) return 'gpt-5.4';
  if (model.includes('haiku')) return 'gpt-5.4-mini';
  return 'gpt-5.4';
}

/** Translate Anthropic /v1/messages request body to OpenAI /v1/chat/completions */
function anthropicToOpenAI(body: Buffer): { translated: string; model: string } | null {
  try {
    const req = JSON.parse(body.toString());
    const codexModel = mapModelToCodex(req.model || '');
    const messages: { role: string; content: string }[] = [];

    if (req.system) {
      const systemText = Array.isArray(req.system)
        ? req.system.map((b: { text?: string }) => b.text || '').join('\n')
        : req.system;
      messages.push({ role: 'system', content: systemText });
    }

    for (const msg of req.messages || []) {
      const content = Array.isArray(msg.content)
        ? msg.content.map((b: { text?: string }) => b.text || '').join('\n')
        : msg.content;
      messages.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content });
    }

    return {
      model: codexModel,
      translated: JSON.stringify({
        model: codexModel,
        messages,
        max_tokens: req.max_tokens || 4096,
        temperature: req.temperature ?? 0.7,
        stream: false,
      }),
    };
  } catch {
    return null;
  }
}

/** Translate OpenAI response back to Anthropic format */
function openAIToAnthropic(openaiBody: string, model: string): string {
  try {
    const res = JSON.parse(openaiBody);
    const content = res.choices?.[0]?.message?.content || '';
    return JSON.stringify({
      id: `msg_codex_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: `codex-fallback-${model}`,
      content: [{ type: 'text', text: content }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: res.usage?.prompt_tokens || 0,
        output_tokens: res.usage?.completion_tokens || 0,
      },
    });
  } catch {
    return JSON.stringify({
      type: 'error',
      error: { type: 'server_error', message: 'Codex fallback translation failed' },
    });
  }
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CODEX_FALLBACK_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;
  const codexFallbackUrl = secrets.CODEX_FALLBACK_URL
    ? new URL(secrets.CODEX_FALLBACK_URL)
    : null;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  /** Try Codex fallback for a failed /v1/messages request */
  function tryCodexFallback(
    originalBody: Buffer,
    res: import('http').ServerResponse,
  ): void {
    if (!codexFallbackUrl) {
      res.writeHead(503);
      res.end('Service Unavailable — no fallback configured');
      return;
    }

    const translated = anthropicToOpenAI(originalBody);
    if (!translated) {
      res.writeHead(502);
      res.end('Fallback translation failed');
      return;
    }

    logger.info(
      { model: translated.model },
      'Credential proxy falling back to Codex',
    );

    const fallbackReq = httpRequest(
      {
        hostname: codexFallbackUrl.hostname,
        port: codexFallbackUrl.port || 80,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(translated.translated),
        },
      },
      (fallbackRes) => {
        const chunks: Buffer[] = [];
        fallbackRes.on('data', (c) => chunks.push(c));
        fallbackRes.on('end', () => {
          const codexResponse = Buffer.concat(chunks).toString();
          const anthropicResponse = openAIToAnthropic(
            codexResponse,
            translated.model,
          );
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(anthropicResponse);
        });
      },
    );

    fallbackReq.on('error', (err) => {
      logger.error({ err }, 'Codex fallback request failed');
      res.writeHead(502);
      res.end('Codex fallback unavailable');
    });

    fallbackReq.write(translated.translated);
    fallbackReq.end();
  }

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const isMessagesEndpoint = req.url?.includes('/v1/messages');

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            const status = upRes.statusCode || 500;

            // Fallback to Codex on auth/rate-limit/server errors for /v1/messages
            if (
              isMessagesEndpoint &&
              codexFallbackUrl &&
              (status === 401 || status === 429 || status === 503)
            ) {
              // Drain the upstream response before falling back
              upRes.resume();
              logger.warn(
                { status, url: req.url },
                'Anthropic returned error — trying Codex fallback',
              );
              tryCodexFallback(body, res);
              return;
            }

            res.writeHead(status, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          // If Anthropic is completely unreachable, try Codex
          if (isMessagesEndpoint && codexFallbackUrl && !res.headersSent) {
            logger.warn('Anthropic unreachable — trying Codex fallback');
            tryCodexFallback(body, res);
            return;
          }
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info(
        { port, host, authMode, codexFallback: !!codexFallbackUrl },
        'Credential proxy started',
      );
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
