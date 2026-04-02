import { api } from '@/lib/api';

export default async function OrganisationPage() {
  let team;
  let scores;
  try {
    [team, scores] = await Promise.all([api.team(), api.scores()]);
  } catch {
    return (
      <div className="rounded-lg border border-red-800 bg-red-950/30 p-4 text-red-400">
        Cannot reach Dashboard API. Is NanoClaw running?
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-gray-100">Organisation</h1>

      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Total Groups" value={String(team.totalGroups)} />
        <StatCard label="Active Tasks" value={String(scores.activeTasks)} accent />
        <StatCard label="Completed Tasks" value={String(scores.completedTasks)} />
      </div>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500">
          Agent Teams
        </h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-left text-gray-500">
              <th className="pb-2 pr-4">Name</th>
              <th className="pb-2 pr-4">Folder</th>
              <th className="pb-2 pr-4">Active Tasks</th>
              <th className="pb-2">State</th>
            </tr>
          </thead>
          <tbody>
            {team.team.map((member) => (
              <tr key={member.jid} className="border-b border-gray-900">
                <td className="py-2 pr-4 text-gray-200 font-medium">{member.name}</td>
                <td className="py-2 pr-4 text-gray-500 font-mono text-xs">{member.folder}</td>
                <td className="py-2 pr-4 text-gray-300">{member.activeTasks}</td>
                <td className="py-2">
                  <span
                    className={
                      member.containerActive
                        ? 'text-emerald-400'
                        : 'text-gray-600'
                    }
                  >
                    {member.containerActive ? 'running' : 'idle'}
                  </span>
                </td>
              </tr>
            ))}
            {team.team.length === 0 && (
              <tr>
                <td colSpan={4} className="py-4 text-gray-600 text-center">
                  No agent groups registered
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <p className="text-xs text-gray-600">{scores.note}</p>
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
