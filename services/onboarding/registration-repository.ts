import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../agents/utils/dynamo-client";
import { CompanyRegistrationRecord, RegistrationStatus } from "../../shared/types/onboarding";
import {
  deriveTenantId,
  normalizeCompanyName,
  normalizeCompanySlug,
} from "../../shared/utils/tenant-name";
import { normalizeRegistration } from "./registration-normalizer";
import { redactRegistrationCredentials } from "./registration-privacy";

export class RegistrationConflictError extends Error {
  readonly statusCode = 409;
  readonly code: string;

  constructor(message: string, code = "REGISTRATION_CONFLICT") {
    super(message);
    this.name = "RegistrationConflictError";
    this.code = code;
  }
}

export class RegistrationStorageUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = "STORAGE_UNAVAILABLE";

  constructor(message = "Registration storage is unavailable", cause?: unknown) {
    super(message);
    this.name = "RegistrationStorageUnavailableError";
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

export interface PlatformStats {
  totalAvailability: number;
  activeConnections: number;
  pendingRequests: number;
  activeAgentsCount: number;
  monthlyConversations: number;
  systemLatencyMs: number;
}

export type ClaimReviewResult =
  | { outcome: "claimed"; registration: CompanyRegistrationRecord }
  | { outcome: "not_found" }
  | { outcome: "conflict"; reason: string };

export interface RegistrationApprovalUpdate {
  tenantId: string;
  companySlug?: string;
  onboardedAt: string;
  reviewedBy?: string;
}

export interface RegistrationRepository {
  createPending(record: Record<string, any>): Promise<CompanyRegistrationRecord>;
  list(statusFilter?: string): Promise<CompanyRegistrationRecord[]>;
  getById(id: string): Promise<CompanyRegistrationRecord | null>;
  claimForReview(id: string): Promise<ClaimReviewResult>;
  releaseReviewClaim(id: string): Promise<void>;
  markApproved(id: string, approval: RegistrationApprovalUpdate): Promise<CompanyRegistrationRecord>;
  markRejected(id: string, reviewedBy?: string): Promise<CompanyRegistrationRecord | null>;
  findLatestByEmailForLocalLogin(normalizedEmail: string): Promise<Record<string, any> | null>;
  getPlatformStats(): Promise<PlatformStats>;
}

export interface LocalStoreAdapter {
  readDB(): { users: Array<Record<string, any>>; registrations: Array<Record<string, any>> };
  writeDB(data: { users: Array<Record<string, any>>; registrations: Array<Record<string, any>> }): void;
}

const VALID_STATUS_BY_LOWER: Record<string, RegistrationStatus> = {
  pending: "Pending",
  provisioning: "Provisioning",
  approved: "Approved",
  rejected: "Rejected",
};

function normalizeStatusFilter(raw?: string): RegistrationStatus | null {
  if (!raw) return null;
  return VALID_STATUS_BY_LOWER[raw.trim().toLowerCase()] || null;
}

function sanitizeForPersistence(record: Record<string, any>): CompanyRegistrationRecord {
  const normalized = normalizeRegistration(record);
  delete normalized.password;
  delete normalized.temporaryPassword;
  if (normalized.tenantId === undefined) {
    delete normalized.tenantId;
  }
  const companyEmail = String(normalized.companyEmail || normalized.email || normalized.adminEmail || "").trim();
  const adminEmail = String(normalized.adminEmail || companyEmail).trim();
  return {
    ...normalized,
    normalizedName: normalizeCompanyName(String(normalized.companyName)),
    companySlug: normalizeCompanySlug(String(normalized.companySlug || normalized.companyName)) || "company",
    companyEmailNormalized: companyEmail.toLowerCase(),
    adminEmailNormalized: adminEmail.toLowerCase(),
  } as unknown as CompanyRegistrationRecord;
}

function redactRecord(record: Record<string, any>): CompanyRegistrationRecord {
  return redactRegistrationCredentials(normalizeRegistration(record)) as CompanyRegistrationRecord;
}

function sortRegistrationsNewestFirst(list: CompanyRegistrationRecord[]): CompanyRegistrationRecord[] {
  return [...list].sort((a, b) =>
    String(b.createdAt || b.submissionDate || "").localeCompare(
      String(a.createdAt || a.submissionDate || "")
    )
  );
}

export interface DynamoRegistrationRepositoryDeps {
  dynamo?: DynamoDBDocumentClient;
  registrationsTable?: string;
  tenantsTable?: string;
  presenceTable?: string;
  conversationsTable?: string;
}

export class DynamoRegistrationRepository implements RegistrationRepository {
  private readonly dynamo: DynamoDBDocumentClient;
  private readonly registrationsTable: string;
  private readonly tenantsTable: string;
  private readonly presenceTable: string;
  private readonly conversationsTable: string;

  constructor(deps: DynamoRegistrationRepositoryDeps = {}) {
    this.dynamo = deps.dynamo || docClient;
    this.registrationsTable =
      deps.registrationsTable || process.env.REGISTRATIONS_TABLE || "omni-channel-registrations";
    this.tenantsTable = deps.tenantsTable || process.env.TENANTS_TABLE || "omni-channel-tenants";
    this.presenceTable =
      deps.presenceTable || process.env.PRESENCE_TABLE || "omni-channel-agent-presence";
    this.conversationsTable =
      deps.conversationsTable || process.env.CONVERSATIONS_TABLE || "omni-channel-conversations";
  }

  private async paginatedScan(input: Record<string, any>): Promise<Array<Record<string, any>>> {
    const items: Array<Record<string, any>> = [];
    let lastKey: Record<string, any> | undefined;
    do {
      const res = await this.dynamo.send(
        new ScanCommand({
          ...(input as any),
          ExclusiveStartKey: lastKey,
        })
      );
      items.push(...((res.Items || []) as Array<Record<string, any>>));
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
    return items;
  }

  private async paginatedQuery(input: Record<string, any>): Promise<Array<Record<string, any>>> {
    const items: Array<Record<string, any>> = [];
    let lastKey: Record<string, any> | undefined;
    do {
      const res = await this.dynamo.send(
        new QueryCommand({
          ...(input as any),
          ExclusiveStartKey: lastKey,
        })
      );
      items.push(...((res.Items || []) as Array<Record<string, any>>));
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
    return items;
  }

  private async paginatedCountQuery(input: Record<string, any>): Promise<number> {
    let total = 0;
    let lastKey: Record<string, any> | undefined;
    do {
      const res = await this.dynamo.send(
        new QueryCommand({
          ...(input as any),
          Select: "COUNT",
          ExclusiveStartKey: lastKey,
        })
      );
      total += res.Count || 0;
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
    return total;
  }

  private async paginatedCountScan(input: Record<string, any>): Promise<number> {
    let total = 0;
    let lastKey: Record<string, any> | undefined;
    do {
      const res = await this.dynamo.send(
        new ScanCommand({
          ...(input as any),
          Select: "COUNT",
          ExclusiveStartKey: lastKey,
        })
      );
      total += res.Count || 0;
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
    return total;
  }

  async createPending(rawRecord: Record<string, any>): Promise<CompanyRegistrationRecord> {
    const item = sanitizeForPersistence({
      ...rawRecord,
      status: "Pending",
    });
    delete item.tenantId;

    const derivedTenantId = deriveTenantId(item.companySlug, item.companyName);
    const emailNormalized = String(item.companyEmailNormalized || "").toLowerCase();

    try {
      // 1. Ensure company slug/tenantId or normalized name does not already exist in active tenants
      const existingTenantById = derivedTenantId
        ? await this.dynamo.send(
            new GetCommand({
              TableName: this.tenantsTable,
              Key: { tenantId: derivedTenantId },
            })
          )
        : { Item: undefined };

      if (existingTenantById.Item) {
        throw new RegistrationConflictError(
          `A company with identifier '${item.companySlug}' is already registered.`,
          "COMPANY_SLUG_ALREADY_EXISTS"
        );
      }

      const existingTenantByName = await this.paginatedQuery({
        TableName: this.tenantsTable,
        IndexName: "NormalizedNameIndex",
        KeyConditionExpression: "normalizedName = :n",
        ExpressionAttributeValues: { ":n": item.normalizedName },
      });
      if (existingTenantByName.length > 0) {
        throw new RegistrationConflictError(
          `A company named '${item.companyName}' is already registered.`,
          "COMPANY_NAME_ALREADY_EXISTS"
        );
      }

      // 2. Ensure no active/pending registration collides by name, slug, or company email
      const matchingByName = await this.paginatedQuery({
        TableName: this.registrationsTable,
        IndexName: "NormalizedNameIndex",
        KeyConditionExpression: "normalizedName = :n",
        ExpressionAttributeValues: { ":n": item.normalizedName },
      });
      if (matchingByName.some((r) => String(r.status || "").toLowerCase() !== "rejected")) {
        throw new RegistrationConflictError(
          `A registration for company '${item.companyName}' already exists.`,
          "COMPANY_NAME_ALREADY_EXISTS"
        );
      }

      const conflictPredicates: string[] = [];
      const conflictAttrValues: Record<string, string> = {
        ":rejected": "Rejected",
      };
      if (item.companySlug) {
        conflictPredicates.push("companySlug = :slug");
        conflictAttrValues[":slug"] = item.companySlug;
      }
      if (emailNormalized) {
        conflictPredicates.push("companyEmailNormalized = :email OR adminEmailNormalized = :email");
        conflictAttrValues[":email"] = emailNormalized;
      }
      const activeConflicts =
        conflictPredicates.length > 0
          ? await this.paginatedScan({
              TableName: this.registrationsTable,
              FilterExpression: `#status <> :rejected AND (${conflictPredicates.join(" OR ")})`,
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: conflictAttrValues,
              ProjectionExpression: "id, #status, companySlug, companyEmailNormalized",
            })
          : [];
      if (activeConflicts.length > 0) {
        const hit = activeConflicts[0];
        if (hit.companySlug === item.companySlug) {
          throw new RegistrationConflictError(
            `A registration with company slug '${item.companySlug}' already exists.`,
            "COMPANY_SLUG_ALREADY_EXISTS"
          );
        }
        throw new RegistrationConflictError(
          `A registration for email '${item.companyEmail}' already exists.`,
          "COMPANY_EMAIL_ALREADY_EXISTS"
        );
      }

      // 3. Persist pending registration conditionally
      await this.dynamo.send(
        new PutCommand({
          TableName: this.registrationsTable,
          Item: item,
          ConditionExpression: "attribute_not_exists(id)",
        })
      );

      return redactRecord(item);
    } catch (error: any) {
      if (error instanceof RegistrationConflictError) {
        throw error;
      }
      if (error?.name === "ConditionalCheckFailedException") {
        throw new RegistrationConflictError("Registration identifier conflict; please retry.");
      }
      throw new RegistrationStorageUnavailableError(
        `Failed to persist company registration: ${error?.message || "unknown error"}`,
        error
      );
    }
  }

  async list(statusFilter?: string): Promise<CompanyRegistrationRecord[]> {
    try {
      let items: Array<Record<string, any>>;
      if (statusFilter !== undefined && statusFilter.trim() !== "") {
        const canonical = normalizeStatusFilter(statusFilter);
        if (!canonical) {
          return [];
        }
        items = await this.paginatedQuery({
          TableName: this.registrationsTable,
          IndexName: "StatusIndex",
          KeyConditionExpression: "#status = :status",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":status": canonical },
        });
      } else {
        items = await this.paginatedScan({
          TableName: this.registrationsTable,
        });
      }
      return sortRegistrationsNewestFirst(items.map(redactRecord));
    } catch (error: any) {
      throw new RegistrationStorageUnavailableError(
        `Failed to list company registrations: ${error?.message || "unknown error"}`,
        error
      );
    }
  }

  async getById(id: string): Promise<CompanyRegistrationRecord | null> {
    try {
      const res = await this.dynamo.send(
        new GetCommand({
          TableName: this.registrationsTable,
          Key: { id },
        })
      );
      if (!res.Item) return null;
      return redactRecord(res.Item);
    } catch (error: any) {
      throw new RegistrationStorageUnavailableError(
        `Failed to fetch company registration: ${error?.message || "unknown error"}`,
        error
      );
    }
  }

  async claimForReview(id: string): Promise<ClaimReviewResult> {
    const now = new Date().toISOString();
    try {
      const res = await this.dynamo.send(
        new UpdateCommand({
          TableName: this.registrationsTable,
          Key: { id },
          UpdateExpression: "SET #status = :provisioning, updatedAt = :now",
          ConditionExpression:
            "attribute_exists(id) AND #status = :pending AND attribute_not_exists(tenantId)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":pending": "Pending",
            ":provisioning": "Provisioning",
            ":now": now,
          },
          ReturnValues: "ALL_NEW",
        })
      );
      if (!res.Attributes) {
        return { outcome: "not_found" };
      }
      return { outcome: "claimed", registration: redactRecord(res.Attributes) };
    } catch (error: any) {
      if (error?.name === "ConditionalCheckFailedException") {
        const existing = await this.getById(id);
        if (!existing) {
          return { outcome: "not_found" };
        }
        return {
          outcome: "conflict",
          reason: "Only unprovisioned pending registrations can be reviewed",
        };
      }
      throw new RegistrationStorageUnavailableError(
        `Failed to claim registration for review: ${error?.message || "unknown error"}`,
        error
      );
    }
  }

  async releaseReviewClaim(id: string): Promise<void> {
    try {
      await this.dynamo.send(
        new UpdateCommand({
          TableName: this.registrationsTable,
          Key: { id },
          UpdateExpression: "SET #status = :pending, updatedAt = :now",
          ConditionExpression:
            "attribute_exists(id) AND #status = :provisioning AND attribute_not_exists(tenantId)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":pending": "Pending",
            ":provisioning": "Provisioning",
            ":now": new Date().toISOString(),
          },
        })
      );
    } catch (error: any) {
      if (error?.name === "ConditionalCheckFailedException") {
        return;
      }
      console.error(`[DynamoRegistrationRepo] Failed releasing review claim for '${id}':`, error);
    }
  }

  async markApproved(
    id: string,
    approval: RegistrationApprovalUpdate
  ): Promise<CompanyRegistrationRecord> {
    const now = new Date().toISOString();
    try {
      const expressionNames: Record<string, string> = { "#status": "status" };
      const expressionValues: Record<string, unknown> = {
        ":approved": "Approved",
        ":provisioning": "Provisioning",
        ":pending": "Pending",
        ":tenantId": approval.tenantId,
        ":onboardedAt": approval.onboardedAt,
        ":now": now,
      };
      const updates = [
        "#status = :approved",
        "tenantId = :tenantId",
        "onboardedAt = :onboardedAt",
        "updatedAt = :now",
      ];
      if (approval.companySlug) {
        updates.push("companySlug = :slug");
        expressionValues[":slug"] = approval.companySlug;
      }
      if (approval.reviewedBy) {
        updates.push("reviewedBy = :reviewedBy");
        expressionValues[":reviewedBy"] = approval.reviewedBy;
      }

      const res = await this.dynamo.send(
        new UpdateCommand({
          TableName: this.registrationsTable,
          Key: { id },
          UpdateExpression: `SET ${updates.join(", ")}`,
          ConditionExpression:
            "attribute_exists(id) AND (#status = :provisioning OR #status = :pending) AND attribute_not_exists(tenantId)",
          ExpressionAttributeNames: expressionNames,
          ExpressionAttributeValues: expressionValues,
          ReturnValues: "ALL_NEW",
        })
      );
      if (!res.Attributes) {
        throw new RegistrationStorageUnavailableError("Approved registration update returned no attributes");
      }
      return redactRecord(res.Attributes);
    } catch (error: any) {
      if (error instanceof RegistrationStorageUnavailableError) throw error;
      if (error?.name === "ConditionalCheckFailedException") {
        throw new RegistrationConflictError("Registration state changed concurrently during approval");
      }
      throw new RegistrationStorageUnavailableError(
        `Failed to finalize registration approval: ${error?.message || "unknown error"}`,
        error
      );
    }
  }

  async markRejected(id: string, reviewedBy?: string): Promise<CompanyRegistrationRecord | null> {
    const now = new Date().toISOString();
    try {
      const updates = ["#status = :rejected", "updatedAt = :now"];
      const expressionValues: Record<string, unknown> = {
        ":rejected": "Rejected",
        ":pending": "Pending",
        ":now": now,
      };
      if (reviewedBy) {
        updates.push("reviewedBy = :reviewedBy");
        expressionValues[":reviewedBy"] = reviewedBy;
      }

      const res = await this.dynamo.send(
        new UpdateCommand({
          TableName: this.registrationsTable,
          Key: { id },
          UpdateExpression: `SET ${updates.join(", ")}`,
          ConditionExpression:
            "attribute_exists(id) AND #status = :pending AND attribute_not_exists(tenantId)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: expressionValues,
          ReturnValues: "ALL_NEW",
        })
      );
      return res.Attributes ? redactRecord(res.Attributes) : null;
    } catch (error: any) {
      if (error?.name === "ConditionalCheckFailedException") {
        const existing = await this.getById(id);
        if (!existing) return null;
        throw new RegistrationConflictError("Only unprovisioned pending registrations can be reviewed");
      }
      throw new RegistrationStorageUnavailableError(
        `Failed to reject company registration: ${error?.message || "unknown error"}`,
        error
      );
    }
  }

  async findLatestByEmailForLocalLogin(normalizedEmail: string): Promise<Record<string, any> | null> {
    try {
      const matches = await this.paginatedScan({
        TableName: this.registrationsTable,
        FilterExpression: "companyEmailNormalized = :email",
        ExpressionAttributeValues: { ":email": normalizedEmail.trim().toLowerCase() },
      });
      if (matches.length === 0) return null;
      const approved = matches.find((r) => r.status === "Approved");
      if (approved) return approved;
      return matches.sort((a, b) =>
        String(b.createdAt || b.submissionDate || "").localeCompare(
          String(a.createdAt || a.submissionDate || "")
        )
      )[0];
    } catch (error: any) {
      throw new RegistrationStorageUnavailableError(
        `Failed to query local registration credentials: ${error?.message || "unknown error"}`,
        error
      );
    }
  }

  async getPlatformStats(): Promise<PlatformStats> {
    const startedAt = Date.now();
    try {
      const [activeTenantsCount, pendingCount, onlineAgentsCount, conversationsCount] =
        await Promise.all([
          this.paginatedCountScan({
            TableName: this.tenantsTable,
            FilterExpression: "#status = :active",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":active": "active" },
          }),
          this.paginatedCountQuery({
            TableName: this.registrationsTable,
            IndexName: "StatusIndex",
            KeyConditionExpression: "#status = :pending",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":pending": "Pending" },
          }),
          this.safeOptionalCount({
            TableName: this.presenceTable,
            FilterExpression: "#status = :avail OR #status = :busy",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":avail": "AVAILABLE", ":busy": "BUSY" },
          }),
          this.safeOptionalCount({
            TableName: this.conversationsTable,
          }),
        ]);

      return {
        totalAvailability: activeTenantsCount,
        activeConnections: activeTenantsCount,
        pendingRequests: pendingCount,
        activeAgentsCount: onlineAgentsCount,
        monthlyConversations: conversationsCount,
        systemLatencyMs: Math.max(1, Date.now() - startedAt),
      };
    } catch (error: any) {
      throw new RegistrationStorageUnavailableError(
        `Failed to compute platform statistics: ${error?.message || "unknown error"}`,
        error
      );
    }
  }

  private async safeOptionalCount(input: Record<string, any>): Promise<number> {
    try {
      return await this.paginatedCountScan(input);
    } catch (error: any) {
      if (error?.name === "ResourceNotFoundException") {
        return 0;
      }
      throw error;
    }
  }
}

/**
 * Isolated file-backed RegistrationRepository used strictly when local test harnesses
 * explicitly supply an os.tmpdir() `options.dbPath` or unit `store`.
 */
export class JsonRegistrationRepository implements RegistrationRepository {
  private readonly store: LocalStoreAdapter;
  private readonly provisionedTenants = new Set<string>(["slt"]);

  constructor(store: LocalStoreAdapter) {
    this.store = store;
  }

  async createPending(rawRecord: Record<string, any>): Promise<CompanyRegistrationRecord> {
    const db = this.store.readDB();
    const record = sanitizeForPersistence({
      ...rawRecord,
      status: "Pending",
    });
    delete record.tenantId;

    const normalizedEmail = String(record.companyEmailNormalized || "").toLowerCase();
    const collision = (db.registrations || []).find((existing) => {
      if (String(existing.status || "").toLowerCase() === "rejected") return false;
      const existingNormName = normalizeCompanyName(String(existing.companyName || existing.name || ""));
      const existingSlug = normalizeCompanySlug(String(existing.companySlug || existingNormName));
      const existingEmail = String(existing.companyEmail || existing.email || existing.adminEmail || "")
        .trim()
        .toLowerCase();
      return (
        existingNormName === record.normalizedName ||
        existingSlug === record.companySlug ||
        (normalizedEmail && existingEmail === normalizedEmail)
      );
    });

    if (collision) {
      throw new RegistrationConflictError(
        `A registration for '${record.companyName}' or email '${record.companyEmail}' already exists.`
      );
    }

    db.registrations.push(record);
    this.store.writeDB(db);
    return redactRecord(record);
  }

  async list(statusFilter?: string): Promise<CompanyRegistrationRecord[]> {
    const db = this.store.readDB();
    const all = (db.registrations || []).map(redactRecord);
    if (statusFilter !== undefined && statusFilter.trim() !== "") {
      const target = statusFilter.trim().toLowerCase();
      return sortRegistrationsNewestFirst(
        all.filter((r) => String(r.status || "").toLowerCase() === target)
      );
    }
    return sortRegistrationsNewestFirst(all);
  }

  async getById(id: string): Promise<CompanyRegistrationRecord | null> {
    const db = this.store.readDB();
    const found = (db.registrations || []).find((r) => String(r.id) === id);
    return found ? redactRecord(found) : null;
  }

  async claimForReview(id: string): Promise<ClaimReviewResult> {
    const db = this.store.readDB();
    const idx = (db.registrations || []).findIndex((r) => String(r.id) === id);
    if (idx === -1) return { outcome: "not_found" };
    const reg = db.registrations[idx];
    if (reg.status !== "Pending" || reg.tenantId) {
      return { outcome: "conflict", reason: "Only unprovisioned pending registrations can be reviewed" };
    }
    db.registrations[idx] = normalizeRegistration({
      ...reg,
      status: "Provisioning",
      updatedAt: new Date().toISOString(),
    });
    this.store.writeDB(db);
    return { outcome: "claimed", registration: redactRecord(db.registrations[idx]) };
  }

  async releaseReviewClaim(id: string): Promise<void> {
    const db = this.store.readDB();
    const idx = (db.registrations || []).findIndex((r) => String(r.id) === id);
    if (idx === -1) return;
    if (db.registrations[idx].status === "Provisioning" && !db.registrations[idx].tenantId) {
      db.registrations[idx] = normalizeRegistration({
        ...db.registrations[idx],
        status: "Pending",
        updatedAt: new Date().toISOString(),
      });
      this.store.writeDB(db);
    }
  }

  async markApproved(
    id: string,
    approval: RegistrationApprovalUpdate
  ): Promise<CompanyRegistrationRecord> {
    const db = this.store.readDB();
    const idx = (db.registrations || []).findIndex((r) => String(r.id) === id);
    if (idx === -1) {
      throw new RegistrationStorageUnavailableError("Registration not found during approval commit");
    }
    const current = db.registrations[idx];
    if (
      (current.status !== "Provisioning" && current.status !== "Pending") ||
      current.tenantId
    ) {
      throw new RegistrationConflictError("Registration state changed concurrently during approval");
    }
    const updated = normalizeRegistration({
      ...current,
      status: "Approved",
      tenantId: approval.tenantId,
      companySlug: approval.companySlug || current.companySlug,
      onboardedAt: approval.onboardedAt,
      updatedAt: new Date().toISOString(),
      ...(approval.reviewedBy ? { reviewedBy: approval.reviewedBy } : {}),
    });
    delete updated.password;
    delete updated.temporaryPassword;
    db.registrations[idx] = updated;
    this.provisionedTenants.add(approval.tenantId);
    this.store.writeDB(db);
    return redactRecord(updated);
  }

  async markRejected(id: string, reviewedBy?: string): Promise<CompanyRegistrationRecord | null> {
    const db = this.store.readDB();
    const idx = (db.registrations || []).findIndex((r) => String(r.id) === id);
    if (idx === -1) return null;
    const reg = db.registrations[idx];
    if (reg.status !== "Pending" || reg.tenantId) {
      throw new RegistrationConflictError("Only unprovisioned pending registrations can be reviewed");
    }
    const updated = normalizeRegistration({
      ...reg,
      status: "Rejected",
      updatedAt: new Date().toISOString(),
      ...(reviewedBy ? { reviewedBy } : {}),
    });
    delete updated.password;
    delete updated.temporaryPassword;
    db.registrations[idx] = updated;
    this.store.writeDB(db);
    return redactRecord(updated);
  }

  async findLatestByEmailForLocalLogin(normalizedEmail: string): Promise<Record<string, any> | null> {
    const db = this.store.readDB();
    const email = normalizedEmail.trim().toLowerCase();
    const matches = (db.registrations || []).filter(
      (r) => typeof r?.companyEmail === "string" && r.companyEmail.trim().toLowerCase() === email
    );
    if (matches.length === 0) return null;
    return matches.find((r) => r.status === "Approved") || matches[matches.length - 1];
  }

  async getPlatformStats(): Promise<PlatformStats> {
    const db = this.store.readDB();
    const regs = db.registrations || [];
    const activeCount = regs.filter((r) => String(r.status || "").toLowerCase() === "approved").length;
    const pendingCount = regs.filter((r) => String(r.status || "").toLowerCase() === "pending").length;
    return {
      totalAvailability: activeCount,
      activeConnections: activeCount,
      pendingRequests: pendingCount,
      activeAgentsCount: this.provisionedTenants.size,
      monthlyConversations: 0,
      systemLatencyMs: 1,
    };
  }
}

/**
 * Resilient registration repository wrapper used during local development.
 * Attempts the primary durable repository (e.g. LocalStack DynamoDB).
 * If LocalStack is unreachable (ECONNREFUSED / table not found), seamlessly
 * falls back to local file storage (db.json) so frontend developers and local
 * smoke tests are never blocked by offline Docker containers.
 */
export class ResilientLocalRegistrationRepository implements RegistrationRepository {
  constructor(
    private readonly primary: RegistrationRepository,
    private readonly fallback: RegistrationRepository
  ) {}

  private isStorageError(err: any): boolean {
    const msg = String(err?.message || "");
    const code = String(err?.code || "");
    return (
      err instanceof RegistrationStorageUnavailableError ||
      code === "STORAGE_UNAVAILABLE" ||
      code === "ECONNREFUSED" ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("ResourceNotFoundException") ||
      msg.includes("Cannot do operations on a non-existent table") ||
      msg.includes("ResourceNotFound")
    );
  }

  async createPending(record: Record<string, any>): Promise<CompanyRegistrationRecord> {
    try {
      return await this.primary.createPending(record);
    } catch (err: any) {
      if (this.isStorageError(err)) {
        console.warn(`[RegistrationRepo] Primary store unavailable (${err.message}); storing in local database.`);
        return await this.fallback.createPending(record);
      }
      throw err;
    }
  }

  async list(statusFilter?: string): Promise<CompanyRegistrationRecord[]> {
    try {
      return await this.primary.list(statusFilter);
    } catch (err: any) {
      if (this.isStorageError(err)) {
        return await this.fallback.list(statusFilter);
      }
      throw err;
    }
  }

  async getById(id: string): Promise<CompanyRegistrationRecord | null> {
    try {
      return await this.primary.getById(id);
    } catch (err: any) {
      if (this.isStorageError(err)) {
        return await this.fallback.getById(id);
      }
      throw err;
    }
  }

  async claimForReview(id: string): Promise<ClaimReviewResult> {
    try {
      return await this.primary.claimForReview(id);
    } catch (err: any) {
      if (this.isStorageError(err)) {
        return await this.fallback.claimForReview(id);
      }
      throw err;
    }
  }

  async releaseReviewClaim(id: string): Promise<void> {
    try {
      return await this.primary.releaseReviewClaim(id);
    } catch (err: any) {
      if (this.isStorageError(err)) {
        return await this.fallback.releaseReviewClaim(id);
      }
      throw err;
    }
  }

  async markApproved(id: string, approval: RegistrationApprovalUpdate): Promise<CompanyRegistrationRecord> {
    try {
      return await this.primary.markApproved(id, approval);
    } catch (err: any) {
      if (this.isStorageError(err)) {
        return await this.fallback.markApproved(id, approval);
      }
      throw err;
    }
  }

  async markRejected(id: string, reviewedBy?: string): Promise<CompanyRegistrationRecord | null> {
    try {
      return await this.primary.markRejected(id, reviewedBy);
    } catch (err: any) {
      if (this.isStorageError(err)) {
        return await this.fallback.markRejected(id, reviewedBy);
      }
      throw err;
    }
  }

  async findLatestByEmailForLocalLogin(normalizedEmail: string): Promise<Record<string, any> | null> {
    try {
      return await this.primary.findLatestByEmailForLocalLogin(normalizedEmail);
    } catch (err: any) {
      if (this.isStorageError(err)) {
        return await this.fallback.findLatestByEmailForLocalLogin(normalizedEmail);
      }
      throw err;
    }
  }

  async getPlatformStats(): Promise<PlatformStats> {
    try {
      return await this.primary.getPlatformStats();
    } catch (err: any) {
      if (this.isStorageError(err)) {
        return await this.fallback.getPlatformStats();
      }
      throw err;
    }
  }
}

