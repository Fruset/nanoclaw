import { api } from '@/lib/api';

export default async function StatusPage() {
  let status;
  try {
    status = await api.status();
  } catch {
    return (
      <div className="rounded-lg border border-red-800 bg-red-950/30 p-4 text-red-400">
        Cannot reach Dashboard API at localhost:4100. Is NanoClaw running?
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-gray-100">Status</h1>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <StatCard label="Uptime" value={status.uptimeHuman} />
        <StatCard label="Active Containers" value={String(status.activeCount)} accent />
        <StatCard label="Total Groups" value={String(status.containers.length)} />
      </div>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500">
          Containers
        </h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-left text-gray-500">
              <th className="pb-2 pr-4">Group</th>
              <th className="pb-2 pr-4">State</th>
              <th className="pb-2">Container</th>
            </tr>
          </thead>
          <tbody>
            {status.containers.map((c) => (
              <tr key={c.jid} className="border-b border-gray-900">
                <td className="py-2 pr-4 text-gray-200">{c.groupName}</td>
                <td className="py-2 pr-4">
                  <span
                    className={
                      c.active
                        ? 'text-emerald-400'
                        : 'text-gray-600'
                    }
                  >
                    {c.active ? 'running' : 'idle'}
                  </span>
                </td>
                <td className="py-2 text-gray-500 font-mono text-xs">
                  {c.containerName ?? '-'}
                </td>
              </tr>
            ))}
            {status.containers.length === 0 && (
              <tr>
                <td colSpan={3} className="py-4 text-gray-600 text-center">
                  No groups registered
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <p className="text-xs text-gray-500 uppercase tracking-wider">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${accent ? 'text-emerald-400' : 'text-gray-100'}`}>
        {value}
      </p>
    </div>
  );
}
