// HTTP server: JSON API + Server-Sent Events + static UI. One process, in-memory sessions.
// Binds to 127.0.0.1 by default. API keys never leave the server.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realClock } from '../clock.ts';
import { buildEngine, type BuiltEngine } from '../app.ts';
import { newId } from '../domain/ids.ts';
import { FEEDBACK_FLAGS, USER_ACTIONS, type FeedbackFlag, type Session, type UserActionType } from '../domain/types.ts';
import { loadScenarios, ManualConversationSource, SimulationConversationSource, type ConversationSource } from '../conversation/sources.ts';
import { buildReport } from '../metrics/report.ts';
import { AnthropicLlmClient, DEFAULT_MODEL } from '../llm/anthropic-client.ts';
import type { LlmClient } from '../llm/client.ts';
import { loadLocalDocs, type SourceDoc } from '../research/tools/supplied-sources.ts';
import type { EngineEvent } from '../gaps/engine.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB = join(ROOT, 'web');
const PORT = Number(process.env.PORT ?? 4317);
const HOST = process.env.HOST ?? '127.0.0.1';
const LOG_CONTENT = process.env.THIRDSEAT_LOG_CONTENT === '1';
const SESSION_TTL_MS = Number(process.env.THIRDSEAT_SESSION_TTL_HOURS ?? 12) * 3_600_000;

// LLM use is opt-in because it sends conversation content to an external service.
const llmMode = (process.env.THIRDSEAT_LLM ?? 'off').toLowerCase();
const llm: LlmClient | undefined =
  llmMode === 'anthropic' ? new AnthropicLlmClient({ model: process.env.THIRDSEAT_MODEL ?? DEFAULT_MODEL, fallbacks: process.env.THIRDSEAT_LLM_FALLBACKS !== '0' }) : undefined;
const webSearch = process.env.THIRDSEAT_WEB_SEARCH !== '0';
const localDocs: SourceDoc[] = process.env.THIRDSEAT_DOCS_DIR ? await loadLocalDocs(process.env.THIRDSEAT_DOCS_DIR) : [];
const scenarios = await loadScenarios(join(ROOT, 'scenarios'));

interface LiveSession {
  session: Session;
  built: BuiltEngine;
  source: ManualConversationSource;
  simulation?: ConversationSource;
  clients: Set<ServerResponse>;
  timer: NodeJS.Timeout;
  lastActivity: number;
  humanValidation?: Record<string, string>;
}

const sessions = new Map<string, LiveSession>();

function log(msg: string): void {
  console.log(`[thirdseat] ${new Date().toISOString()} ${msg}`);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256_000) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
}

function str(v: unknown, max = 4000): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function createSession(body: Record<string, unknown>): LiveSession {
  const urls = (Array.isArray(body.sourceUrls) ? body.sourceUrls : str(body.sourceUrls).split(/\s+/))
    .map((u) => str(u, 2000).trim())
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, 20);
  const session: Session = {
    id: newId('s'),
    createdAt: Date.now(),
    title: str(body.title, 200) || 'Untitled session',
    config: { objective: str(body.objective, 600) || undefined, sourceUrls: urls },
  };
  const built = buildEngine({ session, clock: realClock, llm, webSearch, localDocs });
  const source = new ManualConversationSource();
  const live: LiveSession = {
    session,
    built,
    source,
    clients: new Set(),
    timer: setInterval(() => built.engine.tick(), 1000),
    lastActivity: Date.now(),
  };
  source.start((u) => built.engine.ingest(u));
  built.engine.on((e) => broadcast(live, e));
  sessions.set(session.id, live);
  log(`session ${session.id} created (analyzer=${built.analyzerId}, tools=${built.tools.map((t) => t.id).join(',')}, sources=${urls.length})`);
  return live;
}

function broadcast(live: LiveSession, e: EngineEvent): void {
  live.lastActivity = Date.now();
  if (e.type === 'log') log(`${live.session.id} ${LOG_CONTENT ? e.message : e.message.replace(/"[^"]*"|“[^”]*”/g, '"…"')}`);
  const payload = `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
  for (const c of live.clients) c.write(payload);
}

function snapshot(live: LiveSession) {
  const e = live.built.engine;
  return {
    session: live.session,
    analyzer: live.built.analyzerId,
    tools: live.built.tools.map((t) => ({ id: t.id, description: t.description })),
    sourceLoadErrors: live.built.supplied?.loadErrors ?? [],
    transcript: e.state.transcript.slice(-300),
    gaps: [...e.state.gaps.values()],
    simulating: !!live.simulation,
  };
}

function deleteSession(id: string): void {
  const live = sessions.get(id);
  if (!live) return;
  clearInterval(live.timer);
  live.simulation?.stop();
  live.built.engine.stop();
  for (const c of live.clients) c.end();
  sessions.delete(id); // transcript and state are dropped with the session
  log(`session ${id} deleted`);
}

setInterval(() => {
  for (const [id, s] of sessions) if (Date.now() - s.lastActivity > SESSION_TTL_MS) deleteSession(id);
}, 60_000).unref();

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

async function serveStatic(path: string, res: ServerResponse): Promise<void> {
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
  const file = join(WEB, rel);
  if (!file.startsWith(WEB)) return send(res, 404, { error: 'not found' });
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method ?? 'GET';

  if (parts[0] !== 'api') return serveStatic(url.pathname, res);

  if (method === 'GET' && parts[1] === 'config') {
    return send(res, 200, {
      llm: llm ? { id: llm.id, webSearch } : null,
      localDocs: localDocs.length,
      scenarios: scenarios.map((s) => ({ id: s.id, title: s.title, description: s.description, objective: s.objective, sourceUrls: s.sourceUrls ?? [] })),
    });
  }
  if (method === 'GET' && parts[1] === 'sessions' && parts.length === 2) {
    return send(res, 200, [...sessions.values()].map((s) => ({ id: s.session.id, title: s.session.title, createdAt: s.session.createdAt })));
  }
  if (method === 'POST' && parts[1] === 'sessions' && parts.length === 2) {
    return send(res, 201, snapshot(createSession(await readJson(req))));
  }

  const live = parts[1] === 'sessions' && parts[2] ? sessions.get(parts[2]) : undefined;
  if (!live) return send(res, 404, { error: 'unknown session' });
  const engine = live.built.engine;
  const sub = parts[3];

  if (method === 'GET' && !sub) return send(res, 200, snapshot(live));
  if (method === 'DELETE' && !sub) {
    deleteSession(live.session.id);
    return send(res, 200, { deleted: true });
  }
  if (method === 'GET' && sub === 'events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`event: hello\ndata: {}\n\n`);
    live.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(ping);
      live.clients.delete(res);
    });
    return;
  }
  if (method === 'POST' && sub === 'utterances') {
    const b = await readJson(req);
    const text = str(b.text).trim();
    if (!text) return send(res, 400, { error: 'text required' });
    live.source.push({ speaker: str(b.speaker, 60) || 'Room', text });
    return send(res, 202, { ok: true });
  }
  if (method === 'POST' && sub === 'ask') {
    const b = await readJson(req);
    const q = str(b.question, 500).trim();
    if (!q) return send(res, 400, { error: 'question required' });
    return send(res, 202, engine.ask(q, str(b.speaker, 60) || 'User'));
  }
  if (method === 'POST' && sub === 'simulate') {
    const b = await readJson(req);
    const sc = scenarios.find((s) => s.id === str(b.scenarioId));
    if (!sc) return send(res, 404, { error: 'unknown scenario' });
    live.simulation?.stop();
    const sim = new SimulationConversationSource(sc, Number(b.speed) || 1);
    sim.onEnd = () => {
      live.simulation = undefined;
      broadcast(live, { type: 'log', at: Date.now(), message: 'simulation finished' });
    };
    live.simulation = sim;
    sim.start((u) => engine.ingest(u));
    return send(res, 202, { ok: true, lines: sc.lines.length });
  }
  if (method === 'POST' && sub === 'gaps' && parts[4] && parts[5] === 'action') {
    const b = await readJson(req);
    const action = str(b.action) as UserActionType;
    if (!USER_ACTIONS.includes(action)) return send(res, 400, { error: 'invalid action' });
    return send(res, 200, engine.act(parts[4], action));
  }
  if (method === 'POST' && sub === 'gaps' && parts[4] && parts[5] === 'feedback') {
    const b = await readJson(req);
    const flag = str(b.flag) as FeedbackFlag;
    if (!FEEDBACK_FLAGS.includes(flag)) return send(res, 400, { error: 'invalid flag' });
    return send(res, 200, engine.flag(parts[4], flag));
  }
  if (method === 'POST' && sub === 'end') {
    const b = await readJson(req);
    live.simulation?.stop();
    live.simulation = undefined;
    live.session.endedAt ??= Date.now();
    if (b.humanValidation && typeof b.humanValidation === 'object') {
      live.humanValidation = Object.fromEntries(Object.entries(b.humanValidation as Record<string, unknown>).map(([k, v]) => [k.slice(0, 80), str(v, 4000)]));
    }
    return send(res, 200, buildReport(engine, { analyzer: live.built.analyzerId, tools: live.built.tools.map((t) => t.id), now: Date.now(), humanValidation: live.humanValidation }));
  }
  if (method === 'GET' && sub === 'report') {
    return send(res, 200, buildReport(engine, { analyzer: live.built.analyzerId, tools: live.built.tools.map((t) => t.id), now: Date.now(), humanValidation: live.humanValidation }));
  }
  return send(res, 404, { error: 'not found' });
}

const server = createServer((req, res) => {
  route(req, res).catch((e: Error & { status?: number }) => {
    if (!res.headersSent) send(res, e.status ?? 500, { error: e.message });
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}`);
  log(llm ? `LLM: ${llm.id} (conversation content is sent to Anthropic), web search: ${webSearch ? 'on' : 'off'}` : 'LLM: off — heuristic analysis + supplied sources only (set THIRDSEAT_LLM=anthropic to enable)');
  if (localDocs.length) log(`local documents loaded: ${localDocs.length}`);
});
