// Added in this fork (standalone-account-patches, Apache-2.0): see patch_docs/README.md.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpClientPort } from "@zcode/contracts";
import { SHARED_ZCODE_CREDENTIAL_KEYS } from "../src/auth/shared-credentials.js";
import { createCodingPlanApiKeyResolver } from "../src/auth/coding-plan-api-key.js";
import {
  createZaiBusinessTokenPersistence,
  type ZaiBusinessTokenStorePort,
} from "../src/auth/zai-business-token-store.js";

const DAY_SECONDS = 86_400;
// 与线上一致：业务 JWT ~180 天（expires_in 15552000）。
const BUSINESS_JWT_TTL_SECONDS = 180 * DAY_SECONDS;

/**
 * 进程级集成：换证 adapter + 持久化端口 + 共享凭据 Store（内存实现）。
 * http mock 与 zai-business-token-refresh.test.ts 同构，只是每个 resolver 模拟一个新进程。
 */
function fixture(options: { failures?: number[]; id?: string } = {}) {
  let logins = 0;
  let issues = 0;
  const failures = [...(options.failures ?? [])];
  const fixtureId = options.id ?? "fixture";
  const request = vi.fn(async (req: { url: string }) => {
    let body: unknown;
    let status = 200;
    if (req.url.endsWith("/api/auth/z/login")) {
      logins++;
      const claims = {
        exp: Date.now() / 1000 + BUSINESS_JWT_TTL_SECONDS,
        sub: `${fixtureId}-${logins}`,
      };
      const token = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
      body = { code: 200, data: { access_token: token, expires_in: BUSINESS_JWT_TTL_SECONDS } };
    } else if (req.url.endsWith("/getCustomerInfo")) {
      body = {
        code: 200,
        data: {
          organizations: [
            {
              organizationId: "org",
              organizationName: "默认机构",
              projects: [{ projectId: "project", projectName: "默认项目" }],
            },
          ],
        },
      };
    } else if (req.url.endsWith("/api_keys")) {
      body = { code: 200, data: [{ apiKey: "key", name: "zcode-api-key" }] };
    } else {
      issues++;
      status = failures.shift() ?? 200;
      body = {
        code: status,
        data: {
          accessToken: `pat-${issues}`,
          tokenType: "Bearer",
          expiresIn: 1,
          expiresAt: Date.now() / 1000 + 1,
        },
      };
    }
    return { status, body: new TextEncoder().encode(JSON.stringify(body)) };
  });
  const values = new Map<string, string>();
  const storePort: ZaiBusinessTokenStorePort = {
    load: async (key) => values.get(key) ?? null,
    save: async (key, value) => {
      values.set(key, value);
    },
    deleteIf: async (key, matches) => {
      if (!matches(values.get(key) ?? null)) return false;
      values.delete(key);
      return true;
    },
  };
  const businessTokenPersistence = createZaiBusinessTokenPersistence(storePort);
  // 每个新 resolver 模拟一个新 app-server 进程：内存缓存为空，只共享持久化凭据。
  const newProcess = () =>
    createCodingPlanApiKeyResolver({
      httpClient: { request } as unknown as HttpClientPort,
      businessTokenPersistence,
    });
  const input = (accountIdentity: string) =>
    ({ family: "zai", accessToken: "oauth", accountIdentity }) as const;
  const readStoredRecord = () => {
    const raw = values.get(SHARED_ZCODE_CREDENTIAL_KEYS.zaiBusinessToken);
    if (!raw) return undefined;
    return JSON.parse(raw) as {
      token: string;
      expiresAt: number;
      refreshAt: number;
      scope?: string;
    };
  };
  return {
    input,
    logins: () => logins,
    newProcess,
    readStoredRecord,
    request,
    readRawRecord: () => values.get(SHARED_ZCODE_CREDENTIAL_KEYS.zaiBusinessToken),
    copyRecordFrom(other: { readRawRecord: () => string | undefined }) {
      const raw = other.readRawRecord();
      if (raw) values.set(SHARED_ZCODE_CREDENTIAL_KEYS.zaiBusinessToken, raw);
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("业务 JWT 持久化（换证 adapter 集成）", () => {
  it("换证写透凭据 Store；新进程直接复用业务 JWT 铸造项目 Token", async () => {
    const f = fixture();
    await expect(f.newProcess().resolve(f.input("user-1"))).resolves.toBe("pat-1");
    expect(f.logins()).toBe(1);
    const record = f.readStoredRecord();
    expect(record?.token).toContain("header.");
    expect(record?.scope).toBe("user-1");
    expect(record?.expiresAt).toBeGreaterThan(Date.now());

    // 新进程：不再调用 /api/auth/z/login，直接用持久化业务 JWT 走铸造路径。
    await expect(f.newProcess().resolve(f.input("user-1"))).resolves.toBe("pat-2");
    expect(f.logins()).toBe(1);
    expect(f.readStoredRecord()?.token).toBe(record?.token);
  });

  it("持久化副本进入刷新提前窗口即回退 oauth 换证并覆盖记录", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const f = fixture();
    await expect(f.newProcess().resolve(f.input("user-1"))).resolves.toBe("pat-1");
    const first = f.readStoredRecord();
    // 安全边际 = REFRESH_LEAD_MS(120s)：refreshAt 落在 expiresAt 前 120 秒。
    expect(first).toBeDefined();
    expect(Math.abs(first!.refreshAt - (first!.expiresAt - 120_000))).toBeLessThan(2);
    // 越过 refreshAt（仍未到 expiresAt）：安全边际内必须重新换证。
    vi.setSystemTime(first!.refreshAt + 1_000);
    await expect(f.newProcess().resolve(f.input("user-1"))).resolves.toBe("pat-2");
    expect(f.logins()).toBe(2);
    const second = f.readStoredRecord();
    expect(second?.token).not.toBe(first?.token);
    expect(second?.expiresAt).toBeGreaterThan(Date.now());
  });

  it("持久化业务 JWT 401 即撤档并自愈重新换证", async () => {
    const f = fixture({ id: "origin" });
    await expect(f.newProcess().resolve(f.input("user-1"))).resolves.toBe("pat-1");
    const staleRecord = f.readStoredRecord();
    expect(f.logins()).toBe(1);

    // 新进程领养旧副本（0 次登录）后业务 401：invalidate 撤掉持久化副本 → 重新换证一次。
    const failing = fixture({ failures: [401, 200], id: "healing" });
    failing.copyRecordFrom(f);
    await expect(failing.newProcess().resolve(failing.input("user-1"))).resolves.toBe("pat-2");
    expect(failing.logins()).toBe(1);
    const healed = failing.readStoredRecord();
    expect(healed?.token).not.toBe(staleRecord?.token);
    expect(healed?.scope).toBe("user-1");
  });

  it("换号登录不复用旧账号的业务 JWT", async () => {
    const f = fixture();
    await expect(f.newProcess().resolve(f.input("user-a"))).resolves.toBe("pat-1");
    expect(f.readStoredRecord()?.scope).toBe("user-a");
    // user-b 登录：旧记录 scope 不匹配，必须用 user-b 的 oauth 重新换证。
    await expect(f.newProcess().resolve(f.input("user-b"))).resolves.toBe("pat-2");
    expect(f.logins()).toBe(2);
    expect(f.readStoredRecord()?.scope).toBe("user-b");
  });
});
