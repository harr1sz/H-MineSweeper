export interface GuestSession {
  readonly guestId: string;
  readonly guestToken: string;
  readonly displayName: string;
}

export interface RoomTicketResponse {
  readonly roomId: string;
  readonly roomCode: string;
  readonly ticket: string;
}

export interface TicketClaims {
  readonly ticket: string;
  readonly roomId: string;
  readonly guestId: string;
  readonly connectionEpoch: number;
  readonly expiresAt: number;
}

export type RoomPhase =
  | "LOBBY"
  | "COUNTDOWN"
  | "ACTIVE"
  | "ROUND_RESULT"
  | "MATCH_RESULT"
  | "REMATCH"
  | "CLOSED";

export type { ClientActionEnvelope } from "@h-minesweeper/game-core";

export interface ReplayEvent {
  readonly seq: number;
  readonly at: number;
  readonly type: string;
  readonly actorGuestId?: string;
  readonly payload: unknown;
}

export interface ReplayDocument {
  readonly v: 1;
  readonly replayId: string;
  readonly roomId: string;
  readonly matchId: string;
  readonly roomCode: string;
  readonly createdAt: number;
  finishedAt?: number;
  status: "ACTIVE" | "COMPLETED";
  result?: unknown;
  players: ReadonlyArray<{
    readonly guestId: string;
    readonly displayName: string;
  }>;
  readonly events: ReplayEvent[];
}

export interface WireSender {
  send(message: unknown): void;
}
