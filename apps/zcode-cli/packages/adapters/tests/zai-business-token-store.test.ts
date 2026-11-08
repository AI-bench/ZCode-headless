// Added in this fork (standalone-account-patches, Apache-2.0): see patch_docs/README.md.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SHARED_ZCODE_CREDENTIAL_KEYS,
  createSharedZCodeCredentialStore,
} from "../src/auth/shared-credentials.js";
import {
  createZaiBusinessTokenPersistence,
  type ZaiBusinessTokenStorePort,
} from "../src/auth/zai-business-token-store.js";

const KEY = SHARED_ZCODE_CREDENTIAL_KEYS.zaiBusinessToken;

afterEach(() => vi.useRealTimers());

describe("Z.ai 业务 JWT 持久化（共享凭据 Store）", () => {
  it("写透加密凭据文件，按 scope 读回；scope 不匹配不领养", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const dir = await mkdtemp(join(tmpdir(), "zcode-business-token-"));
    try {
      const store = createSharedZCodeCredentialStore({
        env: { ZCODE_CREDENTIAL_SECRET: "business-token-test-secret" },
        filePath: join(dir, "credentials.json"),
      });
      const persistence = createZaiBusinessTokenPersistence(store);
      await persistence.save(
        Object.freeze({
          token: "business-jwt",
          expiresAt: start + 600_000,
          refreshAt: start + 480_000,
        }),
        "user-1",
      );
      // 落盘文件必须经过加密，不能出现明文 token。
      const rawFile = await readFile(join(dir, "credentials.json"), "utf8");
      expect(rawFile).not.toContain("business-jwt");
      expect(rawFile).toContain("enc:v1:");
      await expect(persistence.load("user-1")).resolves.toEqual({
        token: "business-jwt",
        expiresAt: start + 600_000,
        refreshAt: start + 480_000,
      });
      await expect(persistence.load("user-2")).resolves.toBeUndefined();
      await expect(persistence.load()).resolves.toBeUndefined();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("未知有效期不写盘；remove 只删除同 token 的记录", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const values = new Map<string, string>();
    const port: ZaiBusinessTokenStorePort = {
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
    const persistence = createZaiBusinessTokenPersistence(port);
    await persistence.save(
      Object.freeze({ token: "opaque", refreshAt: start + 180_000 }),
      "user-1",
    );
    expect(values.get(KEY)).toBeUndefined();

    await persistence.save(
      Object.freeze({
        token: "current-jwt",
        expiresAt: start + 600_000,
        refreshAt: start + 480_000,
      }),
      "user-1",
    );
    // 迟到的旧 401（旧 token）不得删掉新一代记录。
    await persistence.remove("older-jwt");
    expect(values.has(KEY)).toBe(true);
    await persistence.remove("current-jwt");
    expect(values.has(KEY)).toBe(false);
    await persistence.remove("current-jwt");
    await expect(persistence.load("user-1")).resolves.toBeUndefined();
  });

  it("损坏记录按缺席处理并可在 remove 时清理", async () => {
    const values = new Map<string, string>([[KEY, "not-json"]]);
    const persistence = createZaiBusinessTokenPersistence({
      load: async (key) => values.get(key) ?? null,
      save: async (key, value) => {
        values.set(key, value);
      },
      deleteIf: async (key, matches) => {
        if (!matches(values.get(key) ?? null)) return false;
        values.delete(key);
        return true;
      },
    });
    await expect(persistence.load("user-1")).resolves.toBeUndefined();
    await persistence.remove("anything");
    expect(values.has(KEY)).toBe(false);
  });

  it("remove 与并发 save 竞态时不得删掉新一代记录（条件事务）", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    // 权威状态：另一进程刚落盘的新一代业务 JWT。
    const values = new Map<string, string>([
      [
        KEY,
        JSON.stringify({
          v: 1,
          token: "fresh-jwt",
          expiresAt: start + 600_000,
          refreshAt: start + 480_000,
          scope: "user-1",
        }),
      ],
    ]);
    // 旧实现（load→parse→delete）在此场景会输：load 读到的是旧一代快照，
    // 比对通过后无条件的 delete 把新一代记录一并抹掉。条件事务只看当前值。
    const staleSnapshot = JSON.stringify({
      v: 1,
      token: "stale-jwt",
      expiresAt: start + 300_000,
      refreshAt: start + 240_000,
      scope: "user-1",
    });
    const persistence = createZaiBusinessTokenPersistence({
      load: async () => staleSnapshot,
      save: async () => {},
      deleteIf: async (key, matches) => {
        if (!matches(values.get(key) ?? null)) return false;
        values.delete(key);
        return true;
      },
    });
    await persistence.remove("stale-jwt"); // 旧一代的迟到 401
    expect(values.has(KEY)).toBe(true);
    expect(JSON.parse(values.get(KEY)!).token).toBe("fresh-jwt");
    await persistence.remove("fresh-jwt"); // 新一代自己的 401 才允许撤档
    expect(values.has(KEY)).toBe(false);
  });

  it("共享 Store 的 deleteIf 在锁内比对并条件删除", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-credential-delete-if-"));
    try {
      const store = createSharedZCodeCredentialStore({
        env: { ZCODE_CREDENTIAL_SECRET: "business-token-test-secret" },
        filePath: join(dir, "credentials.json"),
      });
      await store.save(KEY, "value-a");
      await expect(store.deleteIf(KEY, (value) => value === "value-b")).resolves.toBe(false);
      await expect(store.load(KEY)).resolves.toBe("value-a");
      await expect(store.deleteIf(KEY, (value) => value === "value-a")).resolves.toBe(true);
      await expect(store.load(KEY)).resolves.toBeNull();
      // 缺席键：谓词即使放行也无记录可删。
      await expect(store.deleteIf(KEY, () => true)).resolves.toBe(false);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("退出登录清除业务 JWT 凭据", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-business-token-logout-"));
    try {
      const store = createSharedZCodeCredentialStore({
        env: { ZCODE_CREDENTIAL_SECRET: "business-token-test-secret" },
        filePath: join(dir, "credentials.json"),
      });
      await store.saveZaiLoginCredentials({
        accessToken: "oauth",
        jwtToken: "jwt",
        user: { user_id: "user-1" },
      });
      await store.save(KEY, JSON.stringify({ v: 1, token: "business-jwt", expiresAt: 1, refreshAt: 1, scope: "user-1" }));
      expect(await store.load(KEY)).not.toBeNull();
      await store.clearZaiLoginCredentials();
      expect(await store.load(KEY)).toBeNull();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
