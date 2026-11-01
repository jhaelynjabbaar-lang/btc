import { describe, expect, it, vi } from "vitest";
import { DecideBody, decideRecommendation, type Rpc } from "@/lib/analysis/decide";

const base = { owner: "owner", id: "11111111-1111-4111-8111-111111111111", actor: "jhaelynjabbaar-lang" };
const rpcOk = (data: unknown) => vi.fn<Rpc>(async () => ({ data, error: null }));

describe("accept -> worker command path requires an explicit confirm", () => {
  it("refuses accept without confirm and never touches the database", async () => {
    const rpc = rpcOk({ ok: true, status: "accepted" });
    for (const confirm of [undefined, false]) {
      const r = await decideRecommendation({ ...base, decision: "accept", confirm }, rpc);
      expect(r).toMatchObject({ ok: false, status: 400, error: "confirmation_required" });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("accept with confirm calls the transactional function (which queues the command) and returns the command id", async () => {
    const rpc = rpcOk({ ok: true, status: "accepted", command_id: "cmd-1" });
    const r = await decideRecommendation({ ...base, decision: "accept", confirm: true }, rpc);
    expect(r).toEqual({ ok: true, status: "accepted", commandId: "cmd-1" });
    expect(rpc).toHaveBeenCalledWith("ai_decide_recommendation", { p_owner: "owner", p_id: base.id, p_decision: "accept", p_confirm: true, p_actor: base.actor });
  });

  it("the HTTP body schema also requires confirm: true to be sent by the UI for accept, rejects extras", () => {
    expect(DecideBody.safeParse({ decision: "accept", confirm: true }).success).toBe(true);
    expect(DecideBody.safeParse({ decision: "accept", command: "stop" }).success).toBe(false);
    expect(DecideBody.safeParse({ decision: "execute", confirm: true }).success).toBe(false);
  });

  it("dismiss needs no confirm and can never pass confirm=true to the database", async () => {
    const rpc = rpcOk({ ok: true, status: "dismissed" });
    expect(await decideRecommendation({ ...base, decision: "dismiss" }, rpc)).toEqual({ ok: true, status: "dismissed", commandId: null });
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_decision: "dismiss", p_confirm: false });
  });

  it("maps database refusals to safe messages", async () => {
    const cases: Array<[string, number]> = [["already_decided", 409], ["duplicate_command", 409], ["worker_revoked", 409], ["not_found", 404], ["invalid_action", 422]];
    for (const [reason, status] of cases) {
      const r = await decideRecommendation({ ...base, decision: "accept", confirm: true }, rpcOk({ ok: false, reason }));
      expect(r).toMatchObject({ ok: false, status, error: reason });
    }
    const failed = await decideRecommendation({ ...base, decision: "accept", confirm: true }, async () => ({ data: null, error: { message: "boom" } }));
    expect(failed).toMatchObject({ ok: false, status: 500 });
  });
});
