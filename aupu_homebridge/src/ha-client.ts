import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { HaConfig } from './ha-contract.js';

type Pending = { resolve: (data: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** Authenticated transport. No writes are queued or retried by this layer. */
export class HaClient extends EventEmitter {
  private socket?: WebSocket;
  private readonly pending = new Map<number, Pending>();
  private id = 0;
  private stopped = false;
  private authenticated = false;
  private retries = 0;
  private reconnect?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  generation = 0;

  constructor(private readonly config: HaConfig, private readonly timeoutMs = 8000) { super(); }
  start(): void { this.connect(); }
  disconnect(): void { this.socket?.close(); }

  request(type: string, fields: Record<string, unknown> = {}): Promise<any> {
    if (!this.authenticated || this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('HA disconnected'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('HA request timeout')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket!.send(JSON.stringify({ id, type, ...fields })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('HA send failed')); }
    });
  }

  close(): void {
    this.stopped = true; clearTimeout(this.reconnect); clearInterval(this.heartbeat);
    this.authenticated = false; this.rejectPending(); this.socket?.close();
  }

  private connect(): void {
    if (this.stopped) return;
    let token: string;
    try {
      token = (this.config.tokenFile ? readFileSync(this.config.tokenFile, 'utf8') : process.env[this.config.tokenEnv!])?.trim() ?? '';
      if (!token) throw new Error('Missing token');
    } catch { this.emit('status', 'credential_unavailable'); this.schedule(); return; }
    const url = this.config.url.replace(/^http/, 'ws') + '/api/websocket';
    const endpoint = this.config.url.endsWith('/core') ? url.replace('/core/api/websocket', '/core/websocket') : url;
    const ws = this.socket = new WebSocket(endpoint);
    const generation = ++this.generation;
    const handshakeTimeout = setTimeout(() => ws.close(), this.timeoutMs * 2);
    ws.addEventListener('message', event => {
      if (this.socket !== ws || this.stopped) return;
      let msg: any;
      try { msg = JSON.parse(String(event.data)); } catch { ws.close(); return; }
      if (msg.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      else if (msg.type === 'auth_invalid') { this.emit('status', 'authentication_failed'); ws.close(); }
      else if (msg.type === 'auth_ok') {
        token = ''; clearTimeout(handshakeTimeout);
        this.authenticated = true; this.retries = 0; this.emit('authenticated', generation);
        this.heartbeat = setInterval(() => { void this.request('ping').catch(() => ws.close()); }, 25000);
        this.heartbeat.unref();
      } else if (msg.type === 'event') this.emit('event', msg.event);
      else if (msg.type === 'result' || msg.type === 'pong') {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(msg.id);
        if (msg.type === 'pong' || msg.success === true) pending.resolve(msg.result);
        else pending.reject(new Error('HA request rejected'));
      }
    });
    // Native WebSocket emits close after a transport failure. Calling close here
    // can synchronously re-emit error while CONNECTING on Node's implementation.
    ws.addEventListener('error', () => { this.emit('status', 'transport_error'); });
    ws.addEventListener('close', () => {
      token = ''; clearTimeout(handshakeTimeout);
      if (this.socket !== ws) return;
      clearInterval(this.heartbeat); this.authenticated = false; this.rejectPending();
      this.emit('disconnected'); this.schedule();
    });
  }

  private rejectPending(): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('HA disconnected')); }
    this.pending.clear();
  }
  private schedule(): void {
    if (this.stopped) return;
    clearTimeout(this.reconnect);
    const delay = Math.min(60000, 1000 * 2 ** Math.min(this.retries++, 6)) * (0.8 + Math.random() * 0.4);
    this.reconnect = setTimeout(() => this.connect(), delay); this.reconnect.unref();
  }
}
