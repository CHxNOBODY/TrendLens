/**
 * กลไกรับข้อมูลสด: bounded queue + exponential backoff
 * Node.js รัน callback ของ WebSocket และ timer บน event loop เดียวกัน (ไม่มี race แบบ multi-thread)
 * queue ใช้แยกการรับข้อมูลออกจากการประมวลผล และจำกัดหน่วยความจำเมื่อข้อมูลเข้ามาเร็วเกิน
 */

export class BoundedQueue<T> {
  private buf: (T | undefined)[];
  private head = 0;
  private size = 0;
  dropped = 0;

  constructor(readonly capacity: number) {
    this.buf = new Array(capacity);
  }

  /** เต็มแล้วจะทิ้งรายการเก่าสุด (คืน true เมื่อมีการทิ้ง) — ผู้เรียกควร backfill เพื่อชดเชย */
  push(item: T): boolean {
    let dropped = false;
    if (this.size === this.capacity) {
      this.head = (this.head + 1) % this.capacity;
      this.size--;
      this.dropped++;
      dropped = true;
    }
    this.buf[(this.head + this.size) % this.capacity] = item;
    this.size++;
    return dropped;
  }

  drain(max = Infinity): T[] {
    const n = Math.min(max, this.size);
    const out: T[] = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = this.buf[this.head] as T;
      this.buf[this.head] = undefined;
      this.head = (this.head + 1) % this.capacity;
    }
    this.size -= n;
    return out;
  }

  get length(): number {
    return this.size;
  }
}

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** 0..1 สัดส่วนสุ่มบวกลบ เพื่อไม่ให้ reconnect พร้อมกัน */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1000, maxMs: 60_000, jitter: 0.2 };

/** delay ของความพยายามครั้งที่ attempt (เริ่ม 1): base * 2^(attempt-1) จำกัดที่ max ± jitter */
export function backoffDelay(attempt: number, o: BackoffOptions = DEFAULT_BACKOFF, rand: () => number = Math.random): number {
  const raw = Math.min(o.maxMs, o.baseMs * 2 ** Math.max(0, attempt - 1));
  const j = raw * o.jitter * (rand() * 2 - 1);
  return Math.max(0, Math.round(raw + j));
}
