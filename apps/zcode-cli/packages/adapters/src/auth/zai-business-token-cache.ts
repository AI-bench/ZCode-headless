// Modified in this fork (standalone-account-patches, Apache-2.0): see patch_docs/README.md.
import { ProjectAccessTokenTransientError } from "@zcode/shared";

const REFRESH_LEAD_MS = 120_000;
const REFRESH_RETRY_BACKOFF_MS = 5_000;
const UNKNOWN_TTL_MS = 300_000;
const SECOND_MS = 1_000;

export interface ZaiBusinessToken {
  readonly token: string;
  readonly refreshAt: number;
  readonly expiresAt?: number;
}

/**
 * 业务 JWT 跨进程持久化端口。业务 JWT 本身长达 ~180 天，但内存缓存随进程消失；
 * 持久化让下一次进程直接复用，无需再用短期 oauth 重新换证。scope 是稳定账号身份
 * （如 user_id），持久化侧用它防止换号后复用旧账号的业务 JWT。
 */
export interface ZaiBusinessTokenPersistence {
  load(scope?: string): Promise<ZaiBusinessToken | undefined>;
  remove(token: string): Promise<void>;
  save(value: ZaiBusinessToken, scope?: string): Promise<void>;
}
interface Session {
  oauth: string;
  pending?: Promise<ZaiBusinessToken>;
  value?: ZaiBusinessToken;
  retryAt?: number;
}

/** 业务 JWT 与 PAT 生命周期不同；缓存只由 CLI 换证 adapter 持有。 */
export class ZaiBusinessTokenCache {
  #session?: Session;
  readonly #rejected = new WeakSet<ZaiBusinessToken>();
  readonly #rejectedTokens = new Set<string>();

  constructor(
    private readonly onRefreshDeferred?: () => void,
    private readonly persistence?: ZaiBusinessTokenPersistence,
  ) {}

  clear(): void {
    this.#session = undefined;
  }

  invalidate(value: ZaiBusinessToken): void {
    // 迟到的旧 401 不得清除其它请求已经换好的业务 JWT。
    this.#rejected.add(value);
    this.#rejectedTokens.add(value.token);
    if (this.#session?.value === value) this.#session.value = undefined;
    // 401 的 JWT 也要撤掉持久化副本；remove 按 token 比对，旧一代的迟到 401 删不掉新一代。
    this.persistence?.remove(value.token).catch(() => undefined);
  }

  wasRejected(value: ZaiBusinessToken): boolean {
    return this.#rejected.has(value);
  }

  async resolve(
    oauth: string,
    exchange: () => Promise<unknown>,
    scope?: string,
  ): Promise<ZaiBusinessToken> {
    if (this.#session?.oauth !== oauth) this.#session = { oauth };
    const session = this.#session;
    if (session.pending) return session.pending;
    if (
      session.value &&
      Date.now() <
        Math.min(session.retryAt ?? session.value.refreshAt, session.value.expiresAt ?? Infinity)
    )
      return session.value;
    let adopted: ZaiBusinessToken | undefined;
    const startedAt = Date.now();
    // 持久化读取即刻启动；无持久化时 exchange 仍在第一个微任务内派发，保持既有时序语义。
    const persisted = this.persistence ? this.#loadPersisted(scope) : undefined;
    const pending = Promise.resolve()
      .then(() => {
        if (this.#session !== session) throw new Error("project_token_scope_invalidated");
        if (!persisted) return exchange();
        return persisted.then((value) => {
          if (this.#session !== session) throw new Error("project_token_scope_invalidated");
          if (!value) return exchange();
          adopted = value;
          session.value = value;
          return value;
        });
      })
      .then((raw) => {
        if (this.#session !== session) throw new Error("project_token_scope_invalidated");
        if (adopted) return adopted;
        const response = raw as {
          code?: unknown;
          data?: {
            access_token?: string;
            accessToken?: string;
            expires_in?: number;
            expiresIn?: number;
          };
        };
        if (response.code != null && ![0, 200, "0", "200"].includes(response.code as number))
          throw new Error("project_token_login_failed");
        const data = response.data;
        const token = data?.access_token?.trim() || data?.accessToken?.trim();
        if (!token) throw new Error("project_token_login_failed");
        const ttl = data?.expires_in ?? data?.expiresIn;
        const deadlines = [
          readJwtExpiry(token),
          typeof ttl === "number" && Number.isFinite(ttl) ? startedAt + ttl * SECOND_MS : undefined,
        ].filter((value): value is number => value !== undefined);
        const expiresAt = deadlines.length ? Math.min(...deadlines) : undefined;
        const cacheUntil = expiresAt ?? startedAt + UNKNOWN_TTL_MS;
        if (cacheUntil <= Date.now()) throw new Error("project_token_login_failed");
        const value = Object.freeze({ token, expiresAt, refreshAt: cacheUntil - REFRESH_LEAD_MS });
        session.value = value;
        session.retryAt = undefined;
        // 重新签发即解除对该 token 字符串的历史 401 拒绝。
        this.#rejectedTokens.delete(token);
        return this.#savePersisted(value, scope).then(() => value);
      })
      .catch((error: unknown) => {
        if (this.#session !== session) throw new Error("project_token_scope_invalidated");
        const value = session.value;
        // 真实有效期未知时不能降级；保留原对象身份，让迟到的 401 仍能拒绝这一代 JWT。
        if (
          error instanceof ProjectAccessTokenTransientError &&
          value &&
          !this.wasRejected(value) &&
          value.expiresAt !== undefined &&
          Date.now() < value.expiresAt
        ) {
          session.retryAt = Math.min(Date.now() + REFRESH_RETRY_BACKOFF_MS, value.expiresAt);
          this.onRefreshDeferred?.();
          return value;
        }
        session.value = undefined;
        session.retryAt = undefined;
        throw error;
      })
      .finally(() => {
        // 降级与清理属于共享 pending，所有并发调用必须获得同一个结果。
        if (session.pending === pending) session.pending = undefined;
      });
    session.pending = pending;
    return pending;
  }

  /** 读持久化副本：未过期（含刷新提前量）、未被本进程 401 拒绝才领养；任何读取失败都退化为换证。 */
  async #loadPersisted(scope?: string): Promise<ZaiBusinessToken | undefined> {
    if (!this.persistence) return undefined;
    try {
      const value = await this.persistence.load(scope);
      if (!value) return undefined;
      if (this.#rejectedTokens.has(value.token)) {
        this.persistence.remove(value.token).catch(() => undefined);
        return undefined;
      }
      if (
        Date.now() >= Math.min(value.refreshAt, value.expiresAt ?? Number.POSITIVE_INFINITY)
      ) {
        // 已进入刷新窗口：视为缺席，回退到 oauth 换证。
        return undefined;
      }
      return Object.freeze({
        token: value.token,
        expiresAt: value.expiresAt,
        refreshAt: value.refreshAt,
      });
    } catch {
      return undefined;
    }
  }

  /** 写透：换证成功即持久化；未知有效期（expiresAt 缺失）维持仅内存语义。失败只降级不报错。 */
  async #savePersisted(value: ZaiBusinessToken, scope?: string): Promise<void> {
    if (!this.persistence || value.expiresAt === undefined) return;
    try {
      await this.persistence.save(value, scope);
    } catch {
      // 持久化失败不影响本次换证结果，只是退回进程内缓存行为。
    }
  }
}

function readJwtExpiry(token: string): number | undefined {
  try {
    const raw = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { exp?: unknown };
    return typeof raw.exp === "number" && Number.isFinite(raw.exp)
      ? raw.exp * SECOND_MS
      : undefined;
  } catch {
    return undefined;
  }
}
