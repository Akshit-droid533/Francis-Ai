import express from 'express';
import { exec } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const KEY = env.OPENROUTER_API_KEY || '';
const ACCESS = env.ACCESS_KEY || '';
const PORT = env.PORT || 3000;
const HOST = env.HOST || (ACCESS ? '0.0.0.0' : '127.0.0.1');
const WORKSPACE = path.resolve(env.WORKSPACE || path.join(__dirname, 'workspace'));
const DEFAULT_MODEL = env.DEFAULT_MODEL || 'openai/gpt-4o-mini';
const FREE = (env.FREE_MODELS || 'openrouter/free')
  .split(',').map(s => s.trim()).filter(Boolean);
const OLLAMA = (env.OLLAMA_URL || '').replace(/\/$/, '');
const OLLAMA_MODEL = env.OLLAMA_MODEL || 'llama3.2';
// Commands can only run when the server is private (localhost) or protected by ACCESS_KEY.
const AGENT_ALLOWED = Boolean(ACCESS) || HOST === '127.0.0.1';

const SYSTEM = `You are Alpha, a capable, friendly AI assistant. Be clear and direct. Use Markdown, and put code in fenced blocks with a language tag.`;
const AGENT_NOTE = `\n\nYou have tools: run_command, write_file, read_file, list_files, all inside a workspace folder. When the user wants a file (code, document, CSV, config...), create it with write_file so they can download it. Run commands to test your work when useful, then summarise what you did.`;

const fn = (name, description, properties, required = []) =>
  ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
const TOOLS = [
  fn('run_command', 'Run a shell command in the workspace and return its output.', { command: { type: 'string' } }, ['command']),
  fn('write_file', 'Create or overwrite a file in the workspace.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  fn('read_file', 'Read a text file from the workspace.', { path: { type: 'string' } }, ['path']),
  fn('list_files', 'List files in the workspace.', { path: { type: 'string' } }),
];

await fs.mkdir(WORKSPACE, { recursive: true });
const safe = p => {
  const full = path.resolve(WORKSPACE, p || '.');
  if (full !== WORKSPACE && !full.startsWith(WORKSPACE + path.sep)) throw new Error('Path is outside the workspace');
  return full;
};
const clip = s => (s.length > 12000 ? s.slice(0, 12000) + '\n…[truncated]' : s);

async function listFiles(dir = WORKSPACE) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await listFiles(f));
    else { const st = await fs.stat(f); out.push({ path: path.relative(WORKSPACE, f), size: st.size, mtime: st.mtimeMs }); }
  }
  return out;
}

async function runTool(name, a) {
  if (name === 'run_command') {
    return new Promise(done => exec(String(a.command), { cwd: WORKSPACE, timeout: 60000, maxBuffer: 1 << 20 }, (err, so, se) =>
      done(clip(`exit code: ${err ? (err.killed ? 'timeout' : err.code) : 0}\n${so}${se ? '\n[stderr]\n' + se : ''}`))));
  }
  if (name === 'write_file') {
    const f = safe(a.path);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, a.content ?? '');
    return `Wrote ${a.path} (${Buffer.byteLength(a.content ?? '')} bytes)`;
  }
  if (name === 'read_file') return clip(await fs.readFile(safe(a.path), 'utf8'));
  if (name === 'list_files') return (await listFiles(safe(a.path))).map(f => `${f.path}\t${f.size}`).join('\n') || '(empty)';
  throw new Error('Unknown tool ' + name);
}

// Live model catalog (cached 1h). Free models rotate often, so Alpha discovers them instead of hardcoding.
let modelCache;
async function getModels() {
  if (modelCache && Date.now() - modelCache.t < 36e5) return modelCache.data;
  try {
    const j = await (await fetch('https://openrouter.ai/api/v1/models')).json();
    const data = j.data.map(m => ({
      id: m.id,
      free: m.id.endsWith(':free') || (m.pricing?.prompt === '0' && m.pricing?.completion === '0'),
      tools: !!m.supported_parameters?.includes('tools'),
    }));
    modelCache = { t: Date.now(), data };
    return data;
  } catch { return modelCache?.data || []; }
}

// Provider chain: chosen model, then currently available free models, then local Ollama.
async function providers(model) {
  const OR = 'https://openrouter.ai/api/v1/chat/completions';
  const list = [];
  if (KEY) {
    list.push({ name: 'OpenRouter', url: OR, key: KEY, model });
    const cat = await getModels();
    const live = new Set(cat.map(m => m.id));
    const wanted = [
      ...FREE.filter(id => id.startsWith('openrouter/') || !cat.length || live.has(id)),
      ...cat.filter(m => m.free && m.tools && !m.id.startsWith('openrouter/')).map(m => m.id),
    ];
    for (const m of [...new Set(wanted)].slice(0, 6)) if (m !== model) list.push({ name: 'OpenRouter free', url: OR, key: KEY, model: m });
  }
  if (OLLAMA) list.push({ name: 'Local Ollama', url: OLLAMA + '/v1/chat/completions', model: OLLAMA_MODEL });
  return list;
}

async function complete(p, messages, useTools, onText, signal) {
  const r = await fetch(p.url, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...(p.key && { Authorization: 'Bearer ' + p.key }), 'X-Title': 'Alpha' },
    body: JSON.stringify({ model: p.model, messages, stream: true, ...(useTools && { tools: TOOLS }) }),
  });
  if (!r.ok) throw Object.assign(new Error(`${p.model}: ${r.status} ${(await r.text()).slice(0, 160)}`), { status: r.status });
  const dec = new TextDecoder();
  let buf = '', text = '';
  const calls = [];
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (d === '[DONE]') continue;
      let j; try { j = JSON.parse(d); } catch { continue; }
      if (j.error) throw Object.assign(new Error(j.error.message || 'Provider error'), { status: j.error.code || 500 });
      const delta = j.choices?.[0]?.delta || {};
      if (delta.content) { text += delta.content; onText(delta.content); }
      for (const tc of delta.tool_calls || []) {
        const c = (calls[tc.index ?? 0] ??= { id: '', name: '', args: '' });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
      }
    }
  }
  return { text, calls: calls.filter(Boolean).map(c => ({ ...c, id: c.id || 'call_' + crypto.randomUUID().slice(0, 8) })) };
}

async function withFallback(model, convo, agent, onText, send, signal) {
  const chain = await providers(model);
  if (!chain.length) throw new Error('No provider configured. Set OPENROUTER_API_KEY in .env');
  const errors = [];
  for (const p of chain) {
    for (const tools of agent ? [true, false] : [false]) {
      let emitted = 0;
      try {
        const r = await complete(p, convo, tools, t => { emitted++; onText(t); }, signal);
        if (p !== chain[0]) send('notice', { message: `Credits or limits hit, answered by ${p.name}: ${p.model}` });
        return r;
      } catch (e) {
        errors.push(`${p.model} (${e.status || 'error'})`);
        if (signal.aborted) throw e;
        if (emitted) send('reset');
        if (tools && [400, 404].includes(+e.status)) continue; // model has no tool support: retry as plain chat
        break; // otherwise try the next provider
      }
    }
  }
  throw new Error('All providers failed: ' + errors.slice(0, 4).join(', ') + (errors.length > 4 ? '…' : '') + '. Check your OpenRouter key, credits and model name.');
}

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use('/api', (req, res, next) => {
  if (ACCESS && req.get('x-alpha-key') !== ACCESS && req.query.key !== ACCESS) return res.status(401).json({ error: 'Invalid access key' });
  next();
});

const pending = new Map();
app.post('/api/approve', (req, res) => { pending.get(req.body.id)?.(!!req.body.allow); res.json({ ok: true }); });

app.post('/api/chat', async (req, res) => {
  const { messages = [], model = DEFAULT_MODEL, mode = 'ask', system = '' } = req.body;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (type, data = {}) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const agent = mode !== 'off' && AGENT_ALLOWED;
  const convo = [{ role: 'system', content: SYSTEM + (system ? '\n\n' + system : '') + (agent ? AGENT_NOTE : '') }, ...messages];
  try {
    for (let step = 0; step < 8; step++) {
      const { text, calls } = await withFallback(model || DEFAULT_MODEL, convo, agent, t => send('text', { text: t }), send, ac.signal);
      if (!calls.length) break;
      convo.push({ role: 'assistant', content: text || null,
        tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) });
      for (const c of calls) {
        let args = {}; try { args = JSON.parse(c.args || '{}'); } catch {}
        send('tool', { id: c.id, name: c.name, args });
        let out;
        if (c.name === 'run_command' && mode === 'ask') {
          const ok = await new Promise(r => { pending.set(c.id, r); ac.signal.addEventListener('abort', () => r(false)); send('approval', { id: c.id }); });
          pending.delete(c.id);
          if (!ok) out = 'The user denied this command.';
        }
        if (out === undefined) { try { out = await runTool(c.name, args); } catch (e) { out = 'Error: ' + e.message; } }
        send('tool_result', { id: c.id, output: out, file: c.name === 'write_file' && !out.startsWith('Error') ? args.path : undefined });
        convo.push({ role: 'tool', tool_call_id: c.id, content: String(out) });
      }
    }
  } catch (e) { if (!ac.signal.aborted) send('error', { message: e.message }); }
  send('done'); res.end();
});

app.get('/api/config', (_, res) => res.json({ defaultModel: DEFAULT_MODEL, agentAllowed: AGENT_ALLOWED, hasKey: !!KEY, ollama: !!OLLAMA, free: FREE }));

app.get('/api/models', async (_, res) => res.json(await getModels()));

app.get('/api/credits', async (_, res) => {
  try {
    const d = (await (await fetch('https://openrouter.ai/api/v1/credits', { headers: { Authorization: 'Bearer ' + KEY } })).json()).data;
    res.json({ left: d.total_credits - d.total_usage });
  } catch { res.json({ left: null }); }
});

app.get('/api/files', async (_, res) => res.json((await listFiles()).sort((a, b) => b.mtime - a.mtime)));
app.get('/api/files/*', (req, res) => { try { res.download(safe(req.params[0])); } catch (e) { res.status(400).json({ error: e.message }); } });
app.delete('/api/files/*', async (req, res) => { try { await fs.rm(safe(req.params[0]), { force: true }); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });

app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, HOST, () => {
  console.log(`Alpha running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (!KEY) console.log('! OPENROUTER_API_KEY is not set');
  if (!AGENT_ALLOWED) console.log('! Command running is disabled: set ACCESS_KEY to enable it on a public server');
});
