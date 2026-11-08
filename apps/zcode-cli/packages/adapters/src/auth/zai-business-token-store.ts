// Added in this fork (standalone-account-patches, Apache-2.0): see patch_docs/README.md.
import {
  SHARED_ZCODE_CREDENTIAL_KEYS,
  type SharedZCodeCredentialStore,
} from "./shared-credentials.js";
import type { ZaiBusinessTokenPersistence } from "./zai-business-token-cache.js";

const RECORD_VERSION = 1;

interface StoredZaiBusinessTokenRecord {
  readonly expiresAt: number;
  readonly refreshAt: number;
  readonly scope?: string;
  readonly token: string;
  readonly v: number;
}

/** 共享凭据 Store 中业务 JWT 持久化所需的最小面；与 SharedZCodeCredentialStore 兼容。 */
export type ZaiBusinessTokenStorePort = Pick<
  SharedZCodeCredentialStore,
  "deleteIf" | "load" | "save"
>;

/**
 * 把业务 JWT（~180 天）写进共享凭据 Store；scope 用稳定账号身份（user_id）比对，
 * 换号登录后旧账号的持久化 JWT 不会被复用，宁可回退用新 oauth 重新换证。
 */
export function createZaiBusinessTokenPersistence(
  store: ZaiBusinessTokenStorePort,
): ZaiBusinessTokenPersistence {
  const key = SHARED_ZCODE_CREDENTIAL_KEYS.zaiBusinessToken;
  return {
    async load(scope) {
      const raw = await store.load(key);
      if (!raw) return undefined;
      const record = parseZaiBusinessTokenRecord(raw);
      if (!record || record.scope !== scope) return undefined;
      return Object.freeze({
        token: record.token,
        expiresAt: record.expiresAt,
        refreshAt: record.refreshAt,
      });
    },
    async remove(token) {
      // 比对与删除必须是同锁内的一次条件事务：分立的 load→parse→delete 会与
      // 另一进程的 save 竞态——迟到 401 的比对读到旧记录，无条件的 delete
      // 却把刚落盘的新一代业务 JWT 一并抹掉。
      await store.deleteIf(key, (raw) => {
        const record = parseZaiBusinessTokenRecord(raw);
        // 已被新一代覆盖的记录不能删；损坏记录按可删处理（换证后会重写）。
        return record === undefined || record.token === token;
      });
    },
    async save(value, scope) {
      // 未知有效期不落盘：无法做过期判断的副本复用只会放大风险。
      if (value.expiresAt === undefined) return;
      const record: StoredZaiBusinessTokenRecord = {
        expiresAt: value.expiresAt,
        refreshAt: value.refreshAt,
        ...(scope === undefined ? {} : { scope }),
        token: value.token,
        v: RECORD_VERSION,
      };
      await store.save(key, JSON.stringify(record));
    },
  };
}

function parseZaiBusinessTokenRecord(raw: string): StoredZaiBusinessTokenRecord | undefined {
  try {
    const value = JSON.parse(raw) as Partial<StoredZaiBusinessTokenRecord> | null;
    if (typeof value !== "object" || value === null) return undefined;
    if (typeof value.token !== "string" || value.token.trim().length === 0) return undefined;
    if (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)) return undefined;
    if (typeof value.refreshAt !== "number" || !Number.isFinite(value.refreshAt)) return undefined;
    if (value.scope !== undefined && typeof value.scope !== "string") return undefined;
    return {
      expiresAt: value.expiresAt,
      refreshAt: value.refreshAt,
      ...(value.scope === undefined ? {} : { scope: value.scope }),
      token: value.token,
      v: RECORD_VERSION,
    };
  } catch {
    // 损坏记录按缺席处理；下一次换证成功会被新记录覆盖。
    return undefined;
  }
}
