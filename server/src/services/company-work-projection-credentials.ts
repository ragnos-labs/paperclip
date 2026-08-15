import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { companyWorkProjectionCredentials, type Db } from "@paperclipai/db";
import {
  COMPANY_WORK_PROJECTION_CREDENTIAL_TOKEN_VERSION,
  companyWorkProjectionCredentialSchema,
  createdCompanyWorkProjectionCredentialSchema,
  type CompanyWorkProjectionCredential,
  type CreatedCompanyWorkProjectionCredential,
} from "@paperclipai/shared";

const CREDENTIAL_TOKEN_FAMILY_PREFIX = "pcwp_";
const CREDENTIAL_TOKEN_V1_PATTERN = /^pcwp_v1_[a-f0-9]{48}$/;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function serializeCredential(
  row: typeof companyWorkProjectionCredentials.$inferSelect,
): CompanyWorkProjectionCredential | null {
  const parsed = companyWorkProjectionCredentialSchema.safeParse({
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    tokenVersion: row.tokenVersion,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Reserve the whole pcwp_ token family. Malformed or future-version tokens
 * must never fall through to board or agent-key authentication.
 */
export function isCompanyWorkProjectionCredentialToken(token: string): boolean {
  return token.startsWith(CREDENTIAL_TOKEN_FAMILY_PREFIX);
}

export async function authenticateCompanyWorkProjectionCredential(
  db: Db,
  token: string,
): Promise<{ credentialId: string; companyId: string } | null> {
  if (!CREDENTIAL_TOKEN_V1_PATTERN.test(token)) return null;
  const row = await db
    .select()
    .from(companyWorkProjectionCredentials)
    .where(and(
      eq(companyWorkProjectionCredentials.keyHash, hashToken(token)),
      isNull(companyWorkProjectionCredentials.revokedAt),
    ))
    .then((rows) => rows[0] ?? null);
  if (!row) return null;
  const credential = serializeCredential(row);
  if (!credential) return null;
  return { credentialId: credential.id, companyId: credential.companyId };
}

export function companyWorkProjectionCredentialService(db: Db) {
  return {
    create: async (companyId: string, name: string): Promise<CreatedCompanyWorkProjectionCredential> => {
      const token = `pcwp_v1_${randomBytes(24).toString("hex")}`;
      const row = await db
        .insert(companyWorkProjectionCredentials)
        .values({
          companyId,
          name: name.trim(),
          keyHash: hashToken(token),
          tokenVersion: COMPANY_WORK_PROJECTION_CREDENTIAL_TOKEN_VERSION,
        })
        .returning()
        .then((rows) => rows[0]);
      const serialized = serializeCredential(row);
      if (!serialized) {
        throw new Error("Created work projection credential did not satisfy its runtime schema");
      }
      return createdCompanyWorkProjectionCredentialSchema.parse({
        ...serialized,
        token,
      });
    },

    list: async (companyId: string): Promise<CompanyWorkProjectionCredential[]> => {
      const rows = await db
        .select()
        .from(companyWorkProjectionCredentials)
        .where(eq(companyWorkProjectionCredentials.companyId, companyId))
        .orderBy(desc(companyWorkProjectionCredentials.createdAt));
      return rows.map(serializeCredential).filter((value): value is CompanyWorkProjectionCredential => value !== null);
    },

    revoke: async (companyId: string, credentialId: string): Promise<CompanyWorkProjectionCredential | null> => {
      const row = await db
        .update(companyWorkProjectionCredentials)
        .set({ revokedAt: new Date() })
        .where(and(
          eq(companyWorkProjectionCredentials.id, credentialId),
          eq(companyWorkProjectionCredentials.companyId, companyId),
          isNull(companyWorkProjectionCredentials.revokedAt),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? serializeCredential(row) : null;
    },
  };
}
