/**
 * `LIVEKIT_URL` is the WebSocket URL handed to clients (`wss://...`), while the
 * server API (`RoomServiceClient`) speaks HTTPS. Derive one from the other so a
 * single configured value drives both.
 */
export function toLiveKitHttpUrl(livekitUrl: string): string {
  const parsed = new URL(livekitUrl);

  if (parsed.protocol === "wss:") {
    parsed.protocol = "https:";
  } else if (parsed.protocol === "ws:") {
    parsed.protocol = "http:";
  }

  return parsed.origin;
}
