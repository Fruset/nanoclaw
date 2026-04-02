import { api } from '@/lib/api';
import Link from 'next/link';

export default async function MessagesPage() {
  let groups;
  try {
    groups = await api.groups();
  } catch {
    return (
      <div className="rounded-lg border border-red-800 bg-red-950/30 p-4 text-red-400">
        Cannot reach Dashboard API. Is NanoClaw running?
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-gray-100">Messages</h1>
      <p className="text-sm text-gray-500">Select a group to view its recent messages.</p>
      <ul className="space-y-2">
        {groups.map((g) => (
          <li key={g.jid}>
            <Link
              href={`/messages/${encodeURIComponent(g.jid)}`}
              className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900 px-4 py-3 hover:border-gray-600 transition-colors"
            >
              <div>
                <p className="font-medium text-gray-200">{g.name}</p>
                <p className="text-xs text-gray-500 font-mono">{g.folder}</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-gray-500">{g.channel ?? 'unknown'}</p>
                {g.lastActivity && (
                  <p className="text-xs text-gray-600">
                    {new Date(g.lastActivity).toLocaleDateString()}
                  </p>
                )}
              </div>
            </Link>
          </li>
        ))}
        {groups.length === 0 && (
          <p className="text-gray-600">No groups registered.</p>
        )}
      </ul>
    </div>
  );
}
