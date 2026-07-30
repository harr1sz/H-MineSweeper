import { randomBytes, randomUUID } from "node:crypto";
import type { GuestSession, TicketClaims } from "./types.js";

function opaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

interface StoredGuestSession {
  readonly session: GuestSession;
  readonly expiresAt: number;
}

export class CapacityError extends Error {
  constructor(readonly resource: "guest_sessions" | "rooms") {
    super(`${resource} capacity has been reached`);
    this.name = "CapacityError";
  }
}

export class GuestSessionStore {
  readonly #byToken = new Map<string, StoredGuestSession>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxSessions = Number.POSITIVE_INFINITY,
  ) {}

  get size(): number {
    return this.#byToken.size;
  }

  create(rawDisplayName: string): GuestSession {
    this.sweepExpired();
    const displayName = rawDisplayName.trim().replace(/\s+/g, " ");
    if (displayName.length < 1 || displayName.length > 24) {
      throw new RangeError("Display name must contain 1 to 24 characters");
    }
    if (this.#byToken.size >= this.maxSessions) {
      throw new CapacityError("guest_sessions");
    }

    const session: GuestSession = {
      guestId: randomUUID(),
      guestToken: opaqueToken(),
      displayName,
    };
    this.#byToken.set(session.guestToken, {
      session,
      expiresAt: this.now() + this.ttlMs,
    });
    return session;
  }

  get(guestToken: string): GuestSession | undefined {
    this.sweepExpired();
    return this.#byToken.get(guestToken)?.session;
  }

  sweepExpired(): void {
    const now = this.now();
    for (const [token, stored] of this.#byToken) {
      if (stored.expiresAt <= now) this.#byToken.delete(token);
    }
  }
}

interface StoredTicket extends TicketClaims {
  used: boolean;
}

interface StoredEpoch {
  readonly value: number;
  readonly expiresAt: number;
}

export class TicketStore {
  readonly #tickets = new Map<string, StoredTicket>();
  readonly #epochs = new Map<string, StoredEpoch>();
  readonly #epochTtlMs: number;

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    epochTtlMs = 24 * 60 * 60 * 1_000,
  ) {
    // An epoch record must never disappear while a ticket carrying it is valid.
    this.#epochTtlMs = Math.max(ttlMs, epochTtlMs);
  }

  get epochCount(): number {
    return this.#epochs.size;
  }

  issue(roomId: string, guestId: string): TicketClaims {
    this.sweepExpired();
    const now = this.now();
    const epochKey = `${roomId}:${guestId}`;
    const previousEpoch = this.#epochs.get(epochKey)?.value ?? 0;
    // Timestamp-backed epochs remain greater than an expired prior epoch,
    // preventing a stale connection from becoming current after cleanup.
    const connectionEpoch = Math.max(previousEpoch + 1, now);
    this.#epochs.set(epochKey, {
      value: connectionEpoch,
      expiresAt: now + this.#epochTtlMs,
    });

    const claims: StoredTicket = {
      ticket: opaqueToken(),
      roomId,
      guestId,
      connectionEpoch,
      expiresAt: now + this.ttlMs,
      used: false,
    };
    this.#tickets.set(claims.ticket, claims);
    return claims;
  }

  consume(ticket: string): TicketClaims | undefined {
    this.sweepExpired();
    const stored = this.#tickets.get(ticket);
    if (!stored || stored.used) return undefined;

    stored.used = true;
    return {
      ticket: stored.ticket,
      roomId: stored.roomId,
      guestId: stored.guestId,
      connectionEpoch: stored.connectionEpoch,
      expiresAt: stored.expiresAt,
    };
  }

  sweepExpired(): void {
    const now = this.now();
    for (const [ticket, stored] of this.#tickets) {
      if (stored.expiresAt <= now) this.#tickets.delete(ticket);
    }
    for (const [key, stored] of this.#epochs) {
      if (stored.expiresAt <= now) this.#epochs.delete(key);
    }
  }
}
