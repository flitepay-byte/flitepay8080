/**
 * A tiny in-process Redis stand-in, used only to run the audit.
 *
 * The audit machine has no Redis. Without one every SystemConfig read waits
 * out ioredis's reconnect backoff — measured at roughly two seconds a call —
 * which makes a 200-task workload take hours and drowns out the behaviour
 * actually under test. (That latency is itself a finding; see the report.)
 *
 * This speaks just enough RESP for the commands the application issues: GET,
 * SET with its TTL/NX options, DEL, PING and a minimal INFO for ioredis's
 * ready check, plus the single EVAL script the application runs to release a
 * distributed lock it still owns. That one is emulated rather than refused:
 * acquiring a lock falls back to database atomicity when Redis cannot help,
 * but releasing does not, so refusing it left every lock in place for its full
 * TTL and blocked any second operation on the same task.
 */
import net from 'node:net';

interface Entry {
  value: string;
  expiresAt: number | null;
}

const store = new Map<string, Entry>();

function live(key: string): Entry | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry;
}

const OK = '+OK\r\n';
const NIL = '$-1\r\n';
const bulk = (s: string): string => `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
const int = (n: number): string => `:${n}\r\n`;
const err = (m: string): string => `-ERR ${m}\r\n`;

function handle(args: string[]): string {
  const command = (args[0] ?? '').toUpperCase();

  switch (command) {
    case 'PING':
      return '+PONG\r\n';
    case 'INFO':
      // ioredis's ready check only needs to see that we are not loading.
      return bulk('# Server\r\nredis_version:7.0.0-audit-stub\r\n# Persistence\r\nloading:0\r\n');
    case 'GET': {
      const entry = live(args[1] ?? '');
      return entry ? bulk(entry.value) : NIL;
    }
    case 'SET': {
      const key = args[1] ?? '';
      const value = args[2] ?? '';
      let expiresAt: number | null = null;
      let onlyIfAbsent = false;

      for (let i = 3; i < args.length; i++) {
        const option = (args[i] ?? '').toUpperCase();
        if (option === 'EX') expiresAt = Date.now() + Number(args[++i] ?? 0) * 1000;
        else if (option === 'PX') expiresAt = Date.now() + Number(args[++i] ?? 0);
        else if (option === 'NX') onlyIfAbsent = true;
        else if (option === 'XX' && !live(key)) return NIL;
      }
      if (onlyIfAbsent && live(key)) return NIL;
      store.set(key, { value, expiresAt });
      return OK;
    }
    case 'DEL': {
      let removed = 0;
      for (const key of args.slice(1)) if (store.delete(key)) removed += 1;
      return int(removed);
    }
    case 'EXPIRE': {
      const entry = live(args[1] ?? '');
      if (!entry) return int(0);
      entry.expiresAt = Date.now() + Number(args[2] ?? 0) * 1000;
      return int(1);
    }
    case 'INCR': {
      const key = args[1] ?? '';
      const entry = live(key);
      const next = (entry ? Number(entry.value) : 0) + 1;
      store.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? null });
      return int(next);
    }
    case 'EVAL': {
      // The one script the application actually runs: release a distributed
      // lock only if this caller still owns it.
      //
      // This used to answer with an error, on the reasoning that the lock
      // falls back to database atomicity when Redis cannot help. That is true
      // of *acquiring* it, but not of releasing: the SET NX succeeds, the
      // release fails, and the lock then sits for its whole TTL. Any audit
      // that touches the same task twice in quick succession — a captain
      // handing a task back, a proof being rejected and reassigned — was
      // rejected with "this resource is being modified by another request"
      // and the route silently never ran.
      const script = args[1] ?? '';
      if (script.includes('redis.call("get", KEYS[1]) == ARGV[1]') && script.includes('redis.call("del", KEYS[1])')) {
        const key = args[3] ?? '';
        const token = args[4] ?? '';
        const entry = live(key);
        if (entry && entry.value === token) {
          store.delete(key);
          return int(1);
        }
        return int(0);
      }
      return err('EVAL script not recognised by the audit stub');
    }
    case 'QUIT':
      return OK;
    default:
      return OK;
  }
}

/** Parses as many complete RESP arrays as the buffer holds. */
function parse(buffer: Buffer): { commands: string[][]; rest: Buffer } {
  const commands: string[][] = [];
  let offset = 0;

  for (;;) {
    const start = offset;
    if (offset >= buffer.length) break;
    if (buffer[offset] !== 0x2a) {
      // Inline command (used by some clients for PING).
      const end = buffer.indexOf('\r\n', offset);
      if (end === -1) break;
      const line = buffer.subarray(offset, end).toString().trim();
      if (line) commands.push(line.split(/\s+/));
      offset = end + 2;
      continue;
    }

    const headerEnd = buffer.indexOf('\r\n', offset);
    if (headerEnd === -1) { offset = start; break; }
    const count = Number(buffer.subarray(offset + 1, headerEnd).toString());
    offset = headerEnd + 2;

    const args: string[] = [];
    let truncated = false;
    for (let i = 0; i < count; i++) {
      const lenEnd = buffer.indexOf('\r\n', offset);
      if (lenEnd === -1) { truncated = true; break; }
      const length = Number(buffer.subarray(offset + 1, lenEnd).toString());
      const valueStart = lenEnd + 2;
      if (buffer.length < valueStart + length + 2) { truncated = true; break; }
      args.push(buffer.subarray(valueStart, valueStart + length).toString());
      offset = valueStart + length + 2;
    }
    if (truncated) { offset = start; break; }
    commands.push(args);
  }

  return { commands, rest: Buffer.from(buffer.subarray(offset)) };
}

export function startMiniRedis(port = 6379): Promise<net.Server> {
  const server = net.createServer((socket) => {
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const { commands, rest } = parse(buffered);
      buffered = Buffer.concat([rest]);
      for (const args of commands) socket.write(handle(args));
    });
    socket.on('error', () => undefined);
  });

  return new Promise((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      // Something is already serving the port — a real Redis, or a stub left
      // over from an earlier phase. Either is fine to reuse; the audit only
      // needs the stall to be gone.
      if (error.code === 'EADDRINUSE') resolve(server);
      else reject(error);
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
