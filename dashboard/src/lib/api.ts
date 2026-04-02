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
