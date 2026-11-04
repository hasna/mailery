import {test,expect} from "bun:test";
import {randomUUID} from "node:crypto";
import {runCli} from "../src/program.js";
import {argv,makeHarness,parseJsonOut} from "./support.js";
const target="http://127.0.0.1:1";
const env=()=>({MAILERY_BASE_URL:target,MAILERY_SESSION_TOKEN:randomUUID()});
test("CLI identification and explicit confirmation remain separate remote calls",async()=>{
 const identified={id:"request-one",purchase_id:"purchase-one",acknowledgement_email:"customer@example.invalid",status:"identified",message:"Review before confirmation"};
 const first=makeHarness({env:env(),route:()=>({body:identified})});
 await runCli(argv("billing","withdraw","purchase-one","--email","customer@example.invalid","--idempotency-key","request-key","--json"),first.deps);
 expect(first.exitCode()).toBe(0);expect(first.calls.length).toBe(1);expect(first.calls[0]!.path).toBe("/api/v1/billing/purchases/purchase-one/withdrawals");expect(first.calls[0]!.body).toEqual({email:"customer@example.invalid",language:"en"});
 const unconfirmed=makeHarness({env:env(),route:()=>({body:identified})});
 await runCli(argv("billing","confirm-withdrawal","request-one","--purchase-id","purchase-one","--idempotency-key","confirm-key","--json"),unconfirmed.deps);
 expect(unconfirmed.calls.length).toBe(0);expect(unconfirmed.exitCode()).toBe(1);
 const confirmed=makeHarness({env:env(),route:()=>({body:{...identified,status:"confirmed",acknowledgement_status:"sent",refund_status:"pending_policy_execution"}})});
 await runCli(argv("billing","confirm-withdrawal","request-one","--purchase-id","purchase-one","--idempotency-key","confirm-key","--yes","--json"),confirmed.deps);
 expect(confirmed.exitCode()).toBe(0);expect(confirmed.calls.length).toBe(1);expect(confirmed.calls[0]!.path).toBe("/api/v1/billing/withdrawals/request-one/confirm");expect(confirmed.calls[0]!.body).toEqual({confirm:true,purchaseId:"purchase-one"});
});
test("CLI export follows withdrawal evidence to END independently of message pagination",async()=>{
 const h=makeHarness({env:env(),route:call=>({body:{messages:{data:[],next_cursor:null},withdrawal_evidence:call.query.withdrawal_cursor?{data:[{id:"second"}],next_cursor:null}:{data:[{id:"first"}],next_cursor:"second-page"}}})});
 await runCli(argv("account","export","--output","-"),h.deps);
 expect(h.exitCode()).toBe(0);expect(h.calls.length).toBe(2);expect(h.calls[1]!.query.withdrawal_cursor).toBe("second-page");const value=JSON.parse(h.out());expect(value.withdrawal_evidence.data.map((r:any)=>r.id)).toEqual(["first","second"]);expect(value.withdrawal_evidence.next_cursor).toBeNull();
});
