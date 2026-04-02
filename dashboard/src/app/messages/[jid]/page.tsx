import { api } from '@/lib/api';
import Link from 'next/link';

export default async function MessageThreadPage({
  params,
}: {
  params: Promise<{ jid: string }>;
}) {
  const { jid } = await params;
  const decodedJid = decodeURIComponent(jid);

  let messages;
  try {
    messages = await api.messages(decodedJid, 50);
  } catch {
    return (
      <div className="rounded-lg border border-red-800 bg-red-950/30 p-4 text-red-400">
        Cannot reach Dashboard API. Is NanoClaw running?
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/messages" className="text-gray-500 hover:text-gray-300 text-sm">
          &larr; Groups
        </Link>
        <h1 className="text-xl font-bold text-gray-100 font-mono text-sm">{decodedJid}</h1>
      </div>

      <div className="space-y-2">
        {messages.map((msg) => (
          <div
            key={`${msg.id}-${msg.timestamp}`}
            className={`rounded-lg border p-3 ${
              msg.is_bot_message
                ? 'border-emerald-900 bg-emerald-950/20'
                : 'border-gray-800 bg-gray-900'
            }`}
          >
            <div className="flex items-baseline justify-between mb-1">
              <span
                className={`text-xs font-semibold ${
                  msg.is_bot_message ? 'text-emerald-400' : 'text-gray-400'
                }`}
              >
                {msg.sender_name || msg.sender}
              </span>
              <span className="text-xs text-gray-600">
                {new Date(msg.timestamp).toLocaleString()}
              </span>
            </div>
            <p className="text-sm text-gray-200 whitespace-pre-wrap break-words">
              {msg.content}
            </p>
          </div>
        ))}
        {messages.length === 0 && (
          <p className="text-gray-600 py-4 text-center">No messages in the last 24 hours.</p>
        )}
      </div>
    </div>
  );
}
