import { createServerRuntime } from './bootstrap/createServerRuntime';

let runtime: ReturnType<typeof createServerRuntime> | undefined;
let starting: Promise<number> | undefined;
let stopping: Promise<void> | undefined;
export async function startServer(
  port = Number(process.env.COVE_HTTP_PORT ?? '3001'),
): Promise<number> {
  if (stopping) await stopping;
  if (starting) return starting;
  const active = (runtime ??= createServerRuntime());
  starting = active.startServer(port).catch((error) => {
    runtime = undefined;
    starting = undefined;
    throw error;
  });
  return starting;
}
export async function stopServer(): Promise<void> {
  if (stopping) return stopping;
  const active = runtime;
  if (!active) return;
  stopping = (async () => {
    await starting?.catch(() => {});
    if (runtime !== active) return; // Failed startup already disposed its resources.
    runtime = undefined;
    starting = undefined;
    await active.stopServer();
  })();
  try {
    await stopping;
  } finally {
    stopping = undefined;
  }
}
if (require.main === module) {
  const terminate = () => {
    void stopServer().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', terminate);
  process.once('SIGTERM', terminate);
  startServer()
    .then((port) => console.log('Cove server → http://localhost:' + port))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
