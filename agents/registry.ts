import { handler as billingSpecialistHandler } from "./specialists/billing/handler";
import { handler as usageSpecialistHandler } from "./specialists/usage/handler";
import { handler as supportSpecialistHandler } from "./specialists/support/handler"; // <--- ADD THIS

// The Dynamic Agent Registry
export const agentRegistry: Record<
  string,
  (context: any, params: any) => Promise<any>
> = {
  check_balance: billingSpecialistHandler,
  pay_bill: billingSpecialistHandler,
  check_usage: usageSpecialistHandler,
  troubleshoot_router: supportSpecialistHandler,
};
