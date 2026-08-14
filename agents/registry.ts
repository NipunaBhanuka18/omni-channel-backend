import { handler as billingSpecialistHandler } from "./specialists/billing/handler";

// The Dynamic Agent Registry
// To add a new agent later, you just add a new entry here.
// The Main Agent code will never need to change.
export const agentRegistry: Record<
  string,
  (context: any, params: any) => Promise<any>
> = {
  check_balance: billingSpecialistHandler,
  pay_bill: billingSpecialistHandler, // Billing handles both for now
};
