import {test,expect} from "bun:test";
import {randomUUID} from "node:crypto";
import {MaileryClient} from "../src/client.js";
import {callTool} from "../src/mcp.js";
test("SDK requires an owner session locally before any withdrawal I/O",async()=>{
 let calls=0;const client=new MaileryClient({baseUrl:"http://127.0.0.1:1",fetch:async()=>{calls++;throw new Error("must not dispatch");}});
 await expect(client.listWithdrawalPurchases()).rejects.toThrow();await expect(client.identifyWithdrawal("purchase",{email:"customer@example.invalid",idempotencyKey:"request"})).rejects.toThrow();expect(calls).toBe(0);
});
test("MCP cannot confirm without explicit customer confirmation and preserves the exact purchase/key",async()=>{
 let calls=0;let body:unknown;let key:string|null=null;const client=new MaileryClient({baseUrl:"http://127.0.0.1:1",sessionToken:randomUUID(),fetch:async(_input,init)=>{calls++;body=JSON.parse(init!.body as string);key=new Headers(init!.headers).get("idempotency-key");return new Response(JSON.stringify({status:"confirmed",refund_status:"pending_policy_execution"}),{headers:{"content-type":"application/json"}});}});
 const absent=await callTool("confirm_purchase_withdrawal",{requestId:"request",purchaseId:"purchase",idempotencyKey:"same-key"},client);expect(absent.isError).toBe(true);expect(calls).toBe(0);
 const confirmed=await callTool("confirm_purchase_withdrawal",{requestId:"request",purchaseId:"purchase",idempotencyKey:"same-key",confirm:true},client);expect(confirmed.isError??false).toBe(false);expect(calls).toBe(1);expect(body).toEqual({purchaseId:"purchase",confirm:true});expect(key).toBe("same-key");
});
