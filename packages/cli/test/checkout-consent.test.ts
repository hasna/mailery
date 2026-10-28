import { expect, test } from "bun:test";
import { buildProgram } from "../src/program.js";
async function run(choices: string[]) {
  let exitCode=0; const calls: Array<{path:string;body:any}>=[];
  const p=buildProgram({env:{MAILERY_BASE_URL:"http://127.0.0.1:9",MAILERY_SESSION_TOKEN:"synthetic"},stdout:()=>{},stderr:()=>{},setExitCode:code=>{exitCode=code;},fetch:async(url,init)=>{calls.push({path:new URL(String(url)).pathname,body:init?.body?JSON.parse(String(init.body)):undefined});return Response.json({url:"https://checkout.stripe.com/synthetic"});}});
  await p.parseAsync(["node","mailery","billing","confirm-order","order-fixture","--language","en","--immediate-version","a".repeat(64),"--withdrawal-version","b".repeat(64),"--idempotency-key","fixture-key",...choices]);
  return {exitCode,calls};
}
test("CLI requires both separate choice flags and never sends omitted consent",async()=>{
  for(const flags of [[],["--request-start-now"],["--acknowledge-withdrawal"]]){const result=await run(flags);expect(result.exitCode).toBe(1);expect(result.calls).toHaveLength(0);}
  const result=await run(["--request-start-now","--acknowledge-withdrawal"]);expect(result.exitCode).toBe(0);expect(result.calls).toHaveLength(1);expect(result.calls[0]!.path).toBe("/api/v1/billing/checkout/order-fixture/confirm");expect(result.calls[0]!.body).toMatchObject({requestImmediatePerformance:true,acknowledgeWithdrawal:true,language:"en"});
});
