import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readdirSync, readFileSync, statSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const runFile = promisify(execFile);
const repository = "https://github.com/MDX-Tom/gpt-instruct.git";
const updateInterval = 6 * 60 * 60 * 1000;
// Read release archives as data. Never execute scripts from the upstream repository.
const syncScript = String.raw`
import fcntl, hashlib, io, json, os, re, subprocess, sys, tempfile, time, zipfile
from pathlib import Path
prompts, cache, remote = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
manifest = prompts.parent / 'gpt-instruct-sync.json'
def git(*args):
    return subprocess.run(['git', '--git-dir=' + str(cache), *args], check=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=35).stdout
cache.parent.mkdir(parents=True, exist_ok=True)
# Serialize the entire fetch/read/write cycle across Pi sessions and extension reloads.
lock = (prompts.parent / 'gpt-instruct-sync.lock').open('a')
fcntl.flock(lock, fcntl.LOCK_EX)
if not cache.exists():
    subprocess.run(['git', 'init', '--bare', str(cache)], check=True,
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
git('fetch', '--depth=1', remote, 'HEAD')
commit = git('rev-parse', 'FETCH_HEAD').decode().strip()
names = git('ls-tree', '-z', '--name-only', commit).decode().split('\0')
pattern = re.compile(r'^(gpt-[a-z0-9.-]+)-v(\d+(?:\.\d+)*)(?:-(alpha|beta|rc)(\d+))?\.(zip|md)$', re.I)
releases = {}
for name in names:
    match = pattern.fullmatch(name)
    if not match:
        continue
    model, version, stage, number, kind = match.groups()
    rank = (tuple(map(int, version.split('.'))), {'alpha': 0, 'beta': 1, 'rc': 2, None: 3}[stage], int(number or 0), kind == 'md')
    if model not in releases or rank > releases[model][0]:
        releases[model] = (rank, name)
if not releases:
    raise ValueError('no published prompt archives found')
updates, metadata = {}, {}
for model, (_, name) in sorted(releases.items()):
    data = git('show', commit + ':' + name)
    if name.endswith('.zip'):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            members = [i for i in archive.infolist() if '/' not in i.filename and '\\' not in i.filename
                       and i.filename.lower().startswith(model.lower() + '-') and i.filename.lower().endswith('.md')]
            if len(members) != 1 or members[0].file_size > 1024 * 1024:
                raise ValueError('ambiguous or oversized prompt archive: ' + name)
            data = archive.read(members[0])
    if not data.decode('utf-8').strip() or len(data) > 1024 * 1024:
        raise ValueError('empty or oversized prompt: ' + name)
    targets = [model + '.md']
    # Keep the existing broad GPT 5.6 match as well as the upstream canonical model name.
    if model == 'gpt-5.6-sol':
        targets.append('gpt-5.6.md')
    for target in targets:
        updates[target] = data
        metadata[target] = {'release': name, 'sha256': hashlib.sha256(data).hexdigest()}
prompts.mkdir(parents=True, exist_ok=True)
backup = prompts.parent / 'gpt-instruct-backups' / (time.strftime('%Y%m%dT%H%M%S') + '-' + str(os.getpid()))
changed = []
def atomic_write(path, data):
    fd, temp = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
# Validate every release before replacing any local prompt.
for name, data in updates.items():
    target = prompts / name
    old = target.read_bytes() if target.exists() else None
    if old == data:
        continue
    if old is not None:
        backup.mkdir(parents=True, exist_ok=True)
        atomic_write(backup / name, old)
    atomic_write(target, data)
    changed.append(name)
record = {'repository': remote, 'commit': commit, 'checkedAt': int(time.time() * 1000), 'prompts': metadata}
atomic_write(manifest, (json.dumps(record, ensure_ascii=False, indent=2) + '\n').encode())
print(json.dumps({'commit': commit, 'changed': changed, 'total': len(metadata)}))
`;

export default function (pi: ExtensionAPI): void {
  const agentDirectory = join(homedir(), ".pi", "agent");
  const directory = join(agentDirectory, "prompt-files");
  const statePath = join(agentDirectory, "gpt-instruct-state.json");
  const syncPath = join(agentDirectory, "gpt-instruct-sync.json");
  let injectedText: string | undefined;
  let cache: { path: string; mtime: number; size: number; text: string } | undefined;
  let pendingUpdate: Promise<string> | undefined;
  let lastAttempt = 0;
  const sessionEntryType = "gpt-instruct-session";
  function readDefault(): boolean {
    try {
      const value: unknown = JSON.parse(readFileSync(statePath, "utf8"));
      // Old per-model switches cannot express a session override. Start with default off.
      if (Array.isArray(value) && value.every((id) => typeof id === "string")) return false;
      if (!isRecord(value) || typeof value.defaultEnabled !== "boolean") throw new Error("invalid default state");
      return value.defaultEnabled;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  function writeDefault(defaultEnabled: boolean): void {
    const temp = `${statePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ version: 2, defaultEnabled }) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(temp, statePath);
    } finally { try { unlinkSync(temp); } catch {} }
  }
  function sessionOverride(ctx: ExtensionContext): boolean | undefined {
    const sessionId = ctx.sessionManager.getSessionId();
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry.type !== "custom" || entry.customType !== sessionEntryType || !isRecord(entry.data)
        || entry.data.sessionId !== sessionId) continue;
      if (entry.data.enabled === null) return undefined;
      if (typeof entry.data.enabled === "boolean") return entry.data.enabled;
    }
    return undefined;
  }
  function resolveFile(id: string | undefined): string | undefined {
    if (!id) return;
    try {
      const names = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && /\.md$/i.test(entry.name))
        .map((entry) => entry.name)
        .filter((name) => name.length > 3 && id.toLowerCase().startsWith(name.slice(0, -3).toLowerCase()))
        .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
      return names[0] ? join(directory, names[0]) : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        console.error("[gpt-instruct] skip: directory read failed");
    }
  }
  function updatePrompts(force = false): Promise<string> {
    if (pendingUpdate) return pendingUpdate;
    if (!force) {
      let checkedAt = 0;
      try {
        const record: unknown = JSON.parse(readFileSync(syncPath, "utf8"));
        if (isRecord(record) && record.repository === repository && typeof record.checkedAt === "number") checkedAt = record.checkedAt;
      } catch {}
      if (Date.now() - checkedAt < updateInterval || Date.now() - lastAttempt < 5 * 60 * 1000)
        return Promise.resolve("使用本地提示词（更新检查间隔 6 小时）");
    }
    lastAttempt = Date.now();
    pendingUpdate = (async () => {
      try {
        const { stdout } = await runFile("python3", ["-c", syncScript, directory, join(agentDirectory, "gpt-instruct-upstream.git"), repository],
          { timeout: 90_000, maxBuffer: 1024 * 1024 });
        const result: unknown = JSON.parse(stdout);
        if (!isRecord(result) || !Array.isArray(result.changed) || typeof result.total !== "number") throw new Error();
        cache = undefined;
        return `更新完成：${result.total} 个提示词文件，${result.changed.length} 个变更`;
      } catch {
        console.error("[gpt-instruct] update failed; keeping local prompts");
        return "更新失败，继续使用本地提示词；请检查网络及 git/python3";
      } finally { pendingUpdate = undefined; }
    })();
    return pendingUpdate;
  }
  pi.registerCommand("gpt-instruct", {
    description: "提示词默认状态及会话开关：default on|off | on | off | reset | status | update",
    handler: async (args, ctx) => {
      const tokens = args.trim().toLowerCase().split(/\s+/);
      const action = tokens[0] || "status";
      const isDefault = action === "default" && tokens.length === 2 && ["on", "off"].includes(tokens[1]);
      if (!isDefault && (tokens.length !== 1 || !["on", "off", "reset", "status", "update"].includes(action))) {
        ctx.ui.notify("[gpt-instruct] 用法：/gpt-instruct default on|off；on|off|reset|status|update（on/off 仅当前会话）", "info"); return;
      }
      if (action === "update") { ctx.ui.notify(`[gpt-instruct] ${await updatePrompts(true)}`, "info"); return; }
      if (action === "on" || (isDefault && tokens[1] === "on")) await updatePrompts();
      try {
        let defaultEnabled = readDefault();
        let override = sessionOverride(ctx);
        if (isDefault) {
          defaultEnabled = tokens[1] === "on";
          writeDefault(defaultEnabled);
        } else if (["on", "off", "reset"].includes(action)) {
          override = action === "reset" ? undefined : action === "on";
          pi.appendEntry(sessionEntryType, { sessionId: ctx.sessionManager.getSessionId(), enabled: override ?? null });
        }
        const enabled = override ?? defaultEnabled;
        const file = resolveFile(ctx.model?.id);
        const local = override === undefined ? "跟随默认" : override ? "开启" : "关闭";
        const match = file ? `匹配文件：${file}` : "当前模型无匹配文件，暂不替换";
        ctx.ui.notify(`[gpt-instruct] 全局默认：${defaultEnabled ? "开启" : "关闭"}；本会话：${local}；实际开关：${enabled ? "开启" : "关闭"}（${match}；下轮生效）`, "info");
      } catch { ctx.ui.notify("[gpt-instruct] 操作失败，请检查全局配置或会话状态", "error"); }
    },
  });
  pi.on("session_start", () => { void updatePrompts(); });
  pi.on("before_agent_start", (_event, ctx) => {
    void updatePrompts();
    injectedText = undefined;
    const id = ctx.model?.id;
    if (!id) return;
    try {
      if (!(sessionOverride(ctx) ?? readDefault())) return;
      const path = resolveFile(id);
      if (!path) return;
      const stat = statSync(path);
      if (!stat.isFile()) return;
      if (!cache || cache.path !== path || cache.mtime !== stat.mtimeMs || cache.size !== stat.size) {
        const text = readFileSync(path, "utf8");
        cache = { path, mtime: stat.mtimeMs, size: stat.size, text };
      }
      if (!cache.text.trim()) return;
      injectedText = cache.text;
      return { systemPrompt: injectedText };
    } catch {
      cache = undefined;
      console.error("[gpt-instruct] skip: read failed");
    }
  });
  pi.on("before_provider_request", (event) => {
    const payload = event.payload;
    const text = injectedText;
    if (text === undefined || !isRecord(payload)) return;
    const input = Array.isArray(payload.input) ? payload.input : undefined;
    const first = input?.[0];
    const hasInput = isRecord(first) && (first.role === "system" || first.role === "developer")
      && (typeof first.content === "string" || Array.isArray(first.content));
    const messages = Array.isArray(payload.messages) ? payload.messages : undefined;
    const message = messages?.[0];
    const hasMessage = isRecord(message) && message.role === "system"
      && (typeof message.content === "string" || Array.isArray(message.content));
    const hasInstructions = typeof payload.instructions === "string";
    if (!hasInstructions && !hasInput && !hasMessage) return;
    const result = { ...payload };
    if (hasInstructions) result.instructions = text;
    if (hasInput) result.input = hasInstructions ? input!.slice(1) : [{ ...first, content: text }, ...input!.slice(1)];
    if (hasMessage) result.messages = [{ ...message, content: text }, ...messages!.slice(1)];
    return result;
  });
  // Keep the text through tool continuations; never carry it into another run.
  pi.on("agent_end", () => { injectedText = undefined; });
  pi.on("model_select", () => { injectedText = undefined; });
  pi.on("session_shutdown", () => { injectedText = undefined; cache = undefined; });
}
