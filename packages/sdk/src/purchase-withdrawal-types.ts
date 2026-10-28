export interface WithdrawalPurchase {
 id:string;kind:"subscription"|"credit_pack";plan:string|null;amount_cents:number|null;currency:string;fulfilled_at:string|null;
 withdrawal_period:{status:"review_required";starts_at:null;ends_at:null;reason:string};withdrawal_available:boolean;withdrawal_request_id:string|null;
}
export interface WithdrawalRequest {
 id:string;purchase_id:string;acknowledgement_email:string;language:"en"|"ro";identified_at:string;confirmed_at:string|null;
 status:"identified"|"confirmed";refund_status:"not_requested"|"pending_policy_execution";acknowledgement_status:"not_queued"|"queued"|"sent"|"uncertain";
 refund_policy_binding:"purchase"|"unavailable";refund_policy_version:string|null;purchase:WithdrawalPurchase;message:string;
}
export interface WithdrawalPurchasePage {data:WithdrawalPurchase[];next_cursor:string|null;}
export interface IdentifyWithdrawalInput {email:string;language?:"en"|"ro";idempotencyKey:string;}
export interface ConfirmWithdrawalInput {purchaseId:string;confirm:true;idempotencyKey:string;}
