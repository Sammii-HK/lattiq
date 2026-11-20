export const APP_PORT = 3100;
export const WS_PORT = 3101;
export const WS_URL = `ws://localhost:${WS_PORT}`;
/** Test-only secret, shared by the Next server and the room server under test. */
export const ROOM_SECRET = "lattiq-e2e-secret";
