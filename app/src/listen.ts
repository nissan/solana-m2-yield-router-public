// Serves the page on this machine only.
import { type RequestListener, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where `pnpm run build` puts the page, whether this runs from src/ or dist/. */
export const BUILT_PAGE = join(dirname(fileURLToPath(import.meta.url)), "..", "dist-web");

/** Listens on 127.0.0.1, never on an address another machine can reach. Port 0 picks a free one. */
export async function listen(app: RequestListener, port: number): Promise<{ server: Server; url: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
