// SSE event bus (API_SPECIFICATION events table): `seq` for dedupe, replay after Last-Event-ID, 15 s heartbeat, retry 2000
// (ported openSse pattern). Optional per-client filter (project scope, single render job).
import type { Request, Response } from 'express';

export interface EmEvent { seq: number; name: string; data: Record<string, unknown> }
type Filter = (e: EmEvent) => boolean;
interface Client { res: Response; filter: Filter }

export class EventBus {
  private seq = 0; private readonly buffer: EmEvent[] = []; private readonly clients = new Set<Client>();
  constructor(private readonly bufferSize = 500, private readonly maxClients = 8) {}
  emit(name: string, data: Record<string, unknown>): EmEvent {
    const ev: EmEvent = { seq: ++this.seq, name, data };
    this.buffer.push(ev); if (this.buffer.length > this.bufferSize) this.buffer.shift();
    for (const c of this.clients) if (c.filter(ev)) write(c.res, ev);
    return ev;
  }
  attach(req: Request, res: Response, filter: Filter = () => true): void {
    if (this.clients.size >= this.maxClients) { const oldest = this.clients.values().next().value; if (oldest) { oldest.res.end(); this.clients.delete(oldest); } }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    const last = Number(req.headers['last-event-id'] ?? req.query['lastEventId'] ?? 0);
    if (last > 0) {
      const oldest = this.buffer[0]?.seq ?? this.seq + 1;
      // Gap larger than the buffer (API_SPECIFICATION §7.2): tell the client to refetch state instead of replaying a partial history.
      if (last < oldest - 1) res.write(`event: service.notice\ndata: ${JSON.stringify({ seq: this.seq, kind: 'resync', lastEventId: last, oldestSeq: oldest })}\n\n`);
      else for (const ev of this.buffer) if (ev.seq > last && filter(ev)) write(res, ev);
    }
    const client: Client = { res, filter };
    this.clients.add(client);
    const hb = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => { clearInterval(hb); this.clients.delete(client); });
  }
  closeAll(): void { for (const c of this.clients) c.res.end(); this.clients.clear(); }
  get clientCount(): number { return this.clients.size; }
  get lastSeq(): number { return this.seq; }
}
function write(res: Response, ev: EmEvent) { res.write(`id: ${ev.seq}\nevent: ${ev.name}\ndata: ${JSON.stringify({ seq: ev.seq, ...ev.data })}\n\n`); }
