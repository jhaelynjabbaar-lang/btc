import { handle, type Deps } from "./app";
import { NONCE_TTL_S } from "./protocol";
import { createDb } from "./supabase";

export { NonceStore } from "./nonce-store";

function depsFor(env: Env): Deps {
  return {
    db: createDb(env),
    limiters: { ip: env.RL_IP, enroll: env.RL_ENROLL, worker: env.RL_WORKER },
    claimNonce: (workerId, nonce) => env.NONCE_STORE.get(env.NONCE_STORE.idFromName(workerId)).claim(nonce, NONCE_TTL_S),
    now: () => Date.now(),
    allowInsecureHttp: env.ALLOW_INSECURE_HTTP === "1",
    log: (e) => console.log(JSON.stringify(e)),
  };
}

export default {
  async fetch(request, env): Promise<Response> {
    return handle(request, depsFor(env));
  },
} satisfies ExportedHandler<Env>;
