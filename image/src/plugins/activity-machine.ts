/**
 * Pure activity state machine for the activity-status plugin (clock injected; unit-tested).
 *
 *   idle --(webhook 2xx with messages)--> reading --(responding command)--> responding --(own MESSAGE_CREATE)--> responded --> idle
 *   reading:    "Reading <NICK>'s message" | "Reading <NICK>'s messages" | "Reading multiple messages"; more deliveries merge
 *               into the same window and restart its timer. Expires after reading_seconds.
 *   responding: "Responding to <NICK>'s message". Sticky: deliveries do not replace it. Ends on Responded or responding_seconds.
 *   responded:  "Responded to <NICK>'s message" for responded_seconds (NICK from message_reference, else last Responding NICK).
 *   A responding command issued (at) before the latest Responded is stale and ignored (a background signal can arrive late).
 */
export type ActState = 'idle' | 'reading' | 'responding' | 'responded';
export interface ActTimings { readingMs: number; respondingMs: number; respondedMs: number }
export interface ActView { state: ActState; text: string | null; until: number | null }

const poss = (n: string) => `${n}'s`;
export class ActivityMachine {
  state: ActState = 'idle';
  until: number | null = null;
  private authors = new Map<string, { nick: string; n: number }>();
  lastRespondingNick: string | null = null;
  lastRespondedAt = 0;
  private text: string | null = null;
  constructor(public t: ActTimings, private now: () => number = Date.now) {}

  view(): ActView { this.expire(); return { state: this.state, text: this.text, until: this.until }; }

  /** Returns true if the visible text may have changed. */
  expire(): boolean {
    if (this.until !== null && this.now() >= this.until) { this.toIdle(); return true; }
    return false;
  }
  toIdle() { this.state = 'idle'; this.text = null; this.until = null; this.authors.clear(); }

  reading(items: Array<{ authorId: string; nick: string }>) {
    this.expire();
    if (!items.length) return false;
    if (this.state === 'responding') return false;
    if (this.state !== 'reading') this.authors.clear();
    for (const it of items) { const a = this.authors.get(it.authorId); if (a) { a.n++; a.nick = it.nick || a.nick; } else this.authors.set(it.authorId, { nick: it.nick || 'someone', n: 1 }); }
    this.state = 'reading'; this.until = this.now() + this.t.readingMs;
    if (this.authors.size > 1) this.text = 'Reading multiple messages';
    else { const [a] = this.authors.values(); this.text = `Reading ${poss(a.nick)} ${a.n > 1 ? 'messages' : 'message'}`; }
    return true;
  }
  /** Single-author nick of the current/last reading window, used as a fallback for Responding. */
  readingNick(): string | null { return this.authors.size === 1 ? [...this.authors.values()][0].nick : null; }

  responding(nick: string | null, issuedAt?: number): { applied: boolean; reason?: string } {
    if (issuedAt && issuedAt < this.lastRespondedAt) return { applied: false, reason: 'stale (a reply was already posted after this command was issued)' };
    const n = nick || this.readingNick();
    this.state = 'responding'; this.authors.clear(); this.lastRespondingNick = n;
    this.text = n ? `Responding to ${poss(n)} message` : 'Responding to a message';
    this.until = this.now() + this.t.respondingMs;
    return { applied: true };
  }

  responded(nick: string | null) {
    const n = nick || this.lastRespondingNick;
    this.state = 'responded'; this.authors.clear(); this.lastRespondedAt = this.now();
    this.text = n ? `Responded to ${poss(n)} message` : 'Responded to a message';
    this.until = this.now() + this.t.respondedMs;
  }
}
