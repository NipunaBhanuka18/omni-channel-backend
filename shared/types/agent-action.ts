export interface AgentActionRequest {
  action: string;
  tenantId: string;
  userId: string;
  params: Record<string, any>;
}

export interface AgentActionResponse {
  success: boolean;
  data?: any;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, any>;
  };
}
