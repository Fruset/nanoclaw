# Fas 3: Dashboard API + Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add HTTP API in NanoClaw main process and Next.js dashboard for monitoring groups, messages, tasks, and team status.

**Architecture:** Lightweight HTTP server (native Node.js, no Express) on port 4100 in main process. Next.js 16 frontend in `dashboard/` subdirectory fetching from localhost API.

**Tech Stack:** Node.js http module, Next.js 16, React, Tailwind CSS, better-sqlite3 (existing)

---

## Part 1: Dashboard API (NanoClaw main process)

### Task 1.1 — Add DASHBOARD_API_PORT to config

**Files:**
- `src/config.ts`

**Steps:**

- [ ] Add the port constant after `CREDENTIAL_PROXY_PORT`:

```typescript
export const DASHBOARD_API_PORT = parseInt(
  process.env.DASHBOARD_API_PORT || '4100',
  10,
);
```

**Test:**
```bash
npm run build
```

**Commit:** `feat: add DASHBOARD_API_PORT constant to config`

---

### Task 1.2 — Create src/dashboard-api.ts

**Files:**
- `src/dashboard-api.ts` (new)

**Steps:**

- [ ] Create the file with a `startDashboardApi` function that starts a native Node.js HTTP server on port 4100. The server handles CORS, routes requests to handler functions, and reads directly from the SQLite database via `db.ts` functions.

```typescript
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { getAllRegisteredGroups, getAllChats, getAllTasks, getMessagesSince } from './db.js';
import { logger } from './logger.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, CORS_HEADERS);
  res.end(JSON.stringify(data));
}

function notFound(res: ServerResponse): void {
  json(res, { error: 'Not found' }, 404);
}

const startedAt = Date.now();

export function startDashboardApi(
  port: number,
  host = '127.0.0.1',
  getDashboardState: () => {
    containerStatus: Record<string, { active: boolean; containerName?: string }>;
    registeredGroups: Record<string, { name: string; folder: string; isMain?: boolean }>;
  },
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }

      const url = new URL(req.url ?? '/', `http://${host}`);
      const pathname = url.pathname;

      try {
        if (pathname === '/api/groups') {
          const groups = getAllRegisteredGroups();
          const chats = getAllChats();
          const chatMap = new Map(chats.map((c) => [c.jid, c]));
          const result = Object.entries(groups).map(([jid, g]) => ({
            jid,
            name: g.name,
            folder: g.folder,
            isMain: g.isMain ?? false,
            requiresTrigger: g.requiresTrigger ?? true,
            trigger: g.trigger,
            added_at: g.added_at,
            lastActivity: chatMap.get(jid)?.last_message_time ?? null,
            channel: chatMap.get(jid)?.channel ?? null,
          }));
          return json(res, result);
        }

        if (pathname.startsWith('/api/messages/')) {
          const jid = decodeURIComponent(pathname.slice('/api/messages/'.length));
          const since = url.searchParams.get('since') ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);
          const messages = getMessagesSince(jid, since, '', limit);
          return json(res, messages);
        }

        if (pathname === '/api/tasks') {
          const tasks = getAllTasks();
          return json(res, tasks);
        }

        if (pathname === '/api/status') {
          const state = getDashboardState();
          const uptime = Math.floor((Date.now() - startedAt) / 1000);
          const containers = Object.entries(state.containerStatus).map(([jid, s]) => ({
            jid,
            groupName: state.registeredGroups[jid]?.name ?? jid,
            active: s.active,
            containerName: s.containerName,
          }));
          return json(res, {
            uptime,
            uptimeHuman: formatUptime(uptime),
            containers,
            activeCount: containers.filter((c) => c.active).length,
          });
        }

        if (pathname === '/api/team') {
          const groups = getAllRegisteredGroups();
          const tasks = getAllTasks();
          const state = getDashboardState();
          const team = Object.entries(groups)
            .filter(([, g]) => !g.isMain)
            .map(([jid, g]) => ({
              jid,
              name: g.name,
              folder: g.folder,
              activeTasks: tasks.filter(
                (t) => t.group_folder === g.folder && t.status === 'active',
              ).length,
              containerActive: state.containerStatus[jid]?.active ?? false,
            }));
          return json(res, { team, totalGroups: Object.keys(groups).length });
        }

        if (pathname === '/api/scores') {
          // Placeholder — computed from task run logs
          const tasks = getAllTasks();
          const completedTasks = tasks.filter((t) => t.status === 'completed');
          return json(res, {
            completedTasks: completedTasks.length,
            activeTasks: tasks.filter((t) => t.status === 'active').length,
            note: 'Full self-improvement scoring in Fas 4',
          });
        }

        notFound(res);
      } catch (err) {
        logger.error({ err, url: req.url }, 'Dashboard API error');
        json(res, { error: 'Internal server error' }, 500);
      }
    });

    server.listen(port, host, () => {
      logger.info({ port, host }, 'Dashboard API started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
```

**Test:**
```bash
npm run build
```

**Commit:** `feat: add Dashboard API server (port 4100)`

---

### Task 1.3 — Start Dashboard API in src/index.ts

**Files:**
- `src/index.ts`

**Steps:**

- [ ] Add import at top with other imports:

```typescript
import { startDashboardApi } from './dashboard-api.js';
import { DASHBOARD_API_PORT } from './config.js';
```

- [ ] In `main()`, after `initDatabase()` and `loadState()`, add a call to start the dashboard API. Pass a `getDashboardState` closure that reads from `queue` and `registeredGroups` (already in scope):

```typescript
await startDashboardApi(DASHBOARD_API_PORT, '127.0.0.1', () => ({
  containerStatus: Object.fromEntries(
    Object.keys(registeredGroups).map((jid) => [
      jid,
      { active: queue.isActive(jid) },
    ]),
  ),
  registeredGroups: Object.fromEntries(
    Object.entries(registeredGroups).map(([jid, g]) => [
      jid,
      { name: g.name, folder: g.folder, isMain: g.isMain },
    ]),
  ),
}));
logger.info({ port: DASHBOARD_API_PORT }, 'Dashboard API ready');
```

Place this call after `loadState()` and before `restoreRemoteControl()`.

**Test:**
```bash
npm run build
npm run dev &
sleep 3
curl -s http://localhost:4100/api/status | jq .
curl -s http://localhost:4100/api/groups | jq .
curl -s http://localhost:4100/api/tasks | jq .
kill %1
```

**Commit:** `feat: start Dashboard API in main process`

---

## Part 2: Dashboard Frontend (Next.js)

### Task 2.1 — Scaffold Next.js app in dashboard/

**Files:**
- `dashboard/` (new directory)
- `dashboard/package.json`
- `dashboard/tsconfig.json`
- `dashboard/next.config.ts`
- `dashboard/.gitignore`

**Steps:**

- [ ] Create `dashboard/package.json`:

```json
{
  "name": "nanoclaw-dashboard",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev -p 4000",
    "build": "next build",
    "start": "next start -p 4000"
  },
  "dependencies": {
    "next": "^16.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "postcss": "^8.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.0.0"
  }
}
```

- [ ] Create `dashboard/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] Create `dashboard/next.config.ts`:

```typescript
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100',
  },
};

export default nextConfig;
```

- [ ] Create `dashboard/.gitignore`:

```
.next/
node_modules/
out/
```

**Test:**
```bash
cd /Users/freddyk/github/nanoclaw/dashboard && npm install
```

**Commit:** `feat: scaffold Next.js dashboard in dashboard/`

---

### Task 2.2 — Add Tailwind CSS v4 setup

**Files:**
- `dashboard/src/app/globals.css`
- `dashboard/postcss.config.mjs`

**Steps:**

- [ ] Create `dashboard/postcss.config.mjs`:

```javascript
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
export default config;
```

- [ ] Create `dashboard/src/app/globals.css`:

```css
@import "tailwindcss";
```

**Test:**
```bash
cd /Users/freddyk/github/nanoclaw/dashboard && npm run build 2>&1 | tail -5
```

**Commit:** `feat: add Tailwind CSS v4 config`

---

### Task 2.3 — Create API client utility

**Files:**
- `dashboard/src/lib/api.ts` (new)

**Steps:**

- [ ] Create `dashboard/src/lib/api.ts`:

```typescript
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

export interface Group {
  jid: string;
  name: string;
  folder: string;
  isMain: boolean;
  requiresTrigger: boolean;
  trigger: string;
  added_at: string;
  lastActivity: string | null;
  channel: string | null;
}

export interface Message {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: number;
  is_bot_message: number;
}

export interface Task {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script: string | null;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface ContainerInfo {
  jid: string;
  groupName: string;
  active: boolean;
  containerName?: string;
}

export interface StatusResponse {
  uptime: number;
  uptimeHuman: string;
  containers: ContainerInfo[];
  activeCount: number;
}

export interface TeamMember {
  jid: string;
  name: string;
  folder: string;
  activeTasks: number;
  containerActive: boolean;
}

export interface TeamResponse {
  team: TeamMember[];
  totalGroups: number;
}

export interface ScoresResponse {
  completedTasks: number;
  activeTasks: number;
  note: string;
}

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    next: { revalidate: 10 },
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${path}`);
  return res.json() as Promise<T>;
}

export const api = {
  groups: () => apiFetch<Group[]>('/api/groups'),
  messages: (jid: string, limit = 50) =>
    apiFetch<Message[]>(`/api/messages/${encodeURIComponent(jid)}?limit=${limit}`),
  tasks: () => apiFetch<Task[]>('/api/tasks'),
  status: () => apiFetch<StatusResponse>('/api/status'),
  team: () => apiFetch<TeamResponse>('/api/team'),
  scores: () => apiFetch<ScoresResponse>('/api/scores'),
};
```

**Test:**
```bash
cd /Users/freddyk/github/nanoclaw/dashboard && npm run build
```

**Commit:** `feat: add typed API client for dashboard`

---

### Task 2.4 — Root layout and navigation

**Files:**
- `dashboard/src/app/layout.tsx` (new)
- `dashboard/src/app/page.tsx` (new)

**Steps:**

- [ ] Create `dashboard/src/app/layout.tsx`:

```tsx
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'NanoClaw Dashboard',
  description: 'Monitor agents, tasks, and messages',
};

const NAV_LINKS = [
  { href: '/', label: 'Status' },
  { href: '/organisation', label: 'Organisation' },
  { href: '/tasks', label: 'Tasks' },
  { href: '/messages', label: 'Messages' },
];

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-950 text-gray-100 font-mono">
        <nav className="border-b border-gray-800 px-6 py-3 flex items-center gap-6">
          <span className="font-bold text-emerald-400 tracking-tight">NanoClaw</span>
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-sm text-gray-400 hover:text-gray-100 transition-colors"
            >
              {link.label}
            </a>
          ))}
        </nav>
        <main className="px-6 py-6 max-w-6xl mx-auto">{children}</main>
      </body>
    </html>
  );
}
```

- [ ] Create `dashboard/src/app/page.tsx` (Status view — Server Component):

```tsx
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
```

**Test:**
```bash
cd /Users/freddyk/github/nanoclaw/dashboard && npm run build
```

**Commit:** `feat: add root layout and status page`

---

### Task 2.5 — Organisation view

**Files:**
- `dashboard/src/app/organisation/page.tsx` (new)

**Steps:**

- [ ] Create `dashboard/src/app/organisation/page.tsx`:

```tsx
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
```

**Test:**
```bash
cd /Users/freddyk/github/nanoclaw/dashboard && npm run build
```

**Commit:** `feat: add Organisation view`

---

### Task 2.6 — Tasks view

**Files:**
- `dashboard/src/app/tasks/page.tsx` (new)

**Steps:**

- [ ] Create `dashboard/src/app/tasks/page.tsx`:

```tsx
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
```

**Test:**
```bash
cd /Users/freddyk/github/nanoclaw/dashboard && npm run build
```

**Commit:** `feat: add Tasks view`

---

### Task 2.7 — Messages view

**Files:**
- `dashboard/src/app/messages/page.tsx` (new)
- `dashboard/src/app/messages/[jid]/page.tsx` (new)

**Steps:**

- [ ] Create `dashboard/src/app/messages/page.tsx` (group list):

```tsx
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
```

- [ ] Create `dashboard/src/app/messages/[jid]/page.tsx` (message thread):

```tsx
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
```

**Test:**
```bash
cd /Users/freddyk/github/nanoclaw/dashboard && npm run build
```

**Commit:** `feat: add Messages view with group list and thread`

---

### Task 2.8 — Integration test: start both servers together

**Steps:**

- [ ] Start NanoClaw in dev mode:
```bash
cd /Users/freddyk/github/nanoclaw && npm run dev &
```

- [ ] Wait for startup, then verify all API endpoints:
```bash
sleep 4
curl -s http://localhost:4100/api/status | jq .uptimeHuman
curl -s http://localhost:4100/api/groups | jq 'length'
curl -s http://localhost:4100/api/tasks | jq 'length'
curl -s http://localhost:4100/api/team | jq .totalGroups
curl -s http://localhost:4100/api/scores | jq .
```

- [ ] Start dashboard in another terminal:
```bash
cd /Users/freddyk/github/nanoclaw/dashboard && npm run dev
```

- [ ] Visit http://localhost:4000 — confirm Status page loads without errors.
- [ ] Visit http://localhost:4000/organisation — confirm team table renders.
- [ ] Visit http://localhost:4000/tasks — confirm task table renders.
- [ ] Visit http://localhost:4000/messages — confirm group list renders.

- [ ] Stop both servers.

**Commit:** `docs: confirm dashboard integration test passing`

---

## Summary

| Task | File(s) | What it does |
|------|---------|-------------|
| 1.1 | `src/config.ts` | Port constant 4100 |
| 1.2 | `src/dashboard-api.ts` | HTTP server, 6 routes |
| 1.3 | `src/index.ts` | Start API in main() |
| 2.1 | `dashboard/package.json` + `tsconfig.json` + `next.config.ts` | Next.js 16 project scaffold |
| 2.2 | `dashboard/src/app/globals.css` + `postcss.config.mjs` | Tailwind v4 |
| 2.3 | `dashboard/src/lib/api.ts` | Typed fetch client |
| 2.4 | `dashboard/src/app/layout.tsx` + `page.tsx` | Layout + Status view |
| 2.5 | `dashboard/src/app/organisation/page.tsx` | Organisation view |
| 2.6 | `dashboard/src/app/tasks/page.tsx` | Tasks table view |
| 2.7 | `dashboard/src/app/messages/page.tsx` + `[jid]/page.tsx` | Messages view |
| 2.8 | — | Integration test |

**Ports:**
- `4100` — Dashboard API (NanoClaw main process)
- `4000` — Next.js dashboard frontend
- `3001` — Credential proxy (existing, unchanged)
