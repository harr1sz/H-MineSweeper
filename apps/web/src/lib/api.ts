export interface GuestSession {
  guestId: string;
  guestToken: string;
  displayName: string;
}

export interface RoomTicket {
  roomId: string;
  roomCode: string;
  ticket: string;
}

interface ApiErrorShape {
  error?: string;
  message?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiErrorShape;
    throw new Error(body.message ?? body.error ?? `请求失败（${response.status}）`);
  }

  return (await response.json()) as T;
}

export async function createGuestSession(displayName: string): Promise<GuestSession> {
  return request<GuestSession>("/api/v1/guest-session", {
    method: "POST",
    body: JSON.stringify({ displayName }),
  });
}

export async function createRoom(guestToken: string): Promise<RoomTicket> {
  return request<RoomTicket>("/api/v1/rooms", {
    method: "POST",
    body: JSON.stringify({ guestToken }),
  });
}

export async function joinRoom(
  roomCode: string,
  guestToken: string,
): Promise<RoomTicket> {
  return request<RoomTicket>(`/api/v1/rooms/${encodeURIComponent(roomCode)}/join`, {
    method: "POST",
    body: JSON.stringify({ guestToken }),
  });
}

export function replayUrl(replayId: string): string {
  return `/api/v1/replays/${encodeURIComponent(replayId)}`;
}
