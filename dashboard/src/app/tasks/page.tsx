import { api, Task } from '@/lib/api';

function formatNextRun(nextRun: string | null): string {
  if (!nextRun) return '-';
  const date = new Date(nextRun);
  const now = new Date();
  const diff = date.getTime() - now.getTime();
  if (diff < 0) return 'overdue';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}

function StatusBadge({ status }: { status: Task['status'] }) {
  const styles: Record<Task['status'], string> = {
    active: 'bg-emerald-900/40 text-emerald-400 border-emerald-800',
    paused: 'bg-yellow-900/40 text-yellow-400 border-yellow-800',
    completed: 'bg-gray-800 text-gray-500 border-gray-700',
  };
  return (
    <span className={`rounded border px-2 py-0.5 text-xs ${styles[status]}`}>
      {status}
    </span>
  );
}

export default async function TasksPage() {
  let tasks: Task[];
  try {
    tasks = await api.tasks();
  } catch {
    return (
      <div className="rounded-lg border border-red-800 bg-red-950/30 p-4 text-red-400">
        Cannot reach Dashboard API. Is NanoClaw running?
      </div>
    );
  }

  const active = tasks.filter((t) => t.status === 'active');
  const paused = tasks.filter((t) => t.status === 'paused');
  const completed = tasks.filter((t) => t.status === 'completed');

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-gray-100">Tasks</h1>

      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Active" value={String(active.length)} accent />
        <StatCard label="Paused" value={String(paused.length)} />
        <StatCard label="Completed" value={String(completed.length)} />
      </div>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500">
          All Tasks
        </h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-left text-gray-500">
              <th className="pb-2 pr-4">Group</th>
              <th className="pb-2 pr-4">Schedule</th>
              <th className="pb-2 pr-4">Status</th>
              <th className="pb-2 pr-4">Next Run</th>
              <th className="pb-2">Prompt</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.id} className="border-b border-gray-900">
                <td className="py-2 pr-4 text-gray-400 font-mono text-xs">{task.group_folder}</td>
                <td className="py-2 pr-4 text-gray-400 font-mono text-xs">
                  {task.schedule_type}: {task.schedule_value}
                </td>
                <td className="py-2 pr-4">
                  <StatusBadge status={task.status} />
                </td>
                <td className="py-2 pr-4 text-gray-400 text-xs">
                  {formatNextRun(task.next_run)}
                </td>
                <td className="py-2 text-gray-300 max-w-xs truncate text-xs">
                  {task.prompt}
                </td>
              </tr>
            ))}
            {tasks.length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-gray-600 text-center">
                  No tasks scheduled
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
