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
