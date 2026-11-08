// Modified in this fork (standalone-account-patches, Apache-2.0): see patch_docs/README.md.
import { afterEach, expect, it, vi } from "vitest";
import { ProjectAccessTokenTransientError } from "@zcode/shared";
import {
  ZaiBusinessTokenCache,
  type ZaiBusinessToken,
  type ZaiBusinessTokenPersistence,
} from "../src/auth/zai-business-token-cache.js";
afterEach(() => vi.useRealTimers());
it("无 TTL 的成功响应只做有限缓存", async () => {
  vi.useFakeTimers();
  const cache = new ZaiBusinessTokenCache();
  const exchange = vi.fn(async () => ({ data: { access_token: "opaque-token" } }));
  await cache.resolve("oauth", exchange);
  await cache.resolve("oauth", exchange);
  expect(exchange).toHaveBeenCalledTimes(1);
  vi.setSystemTime(Date.now() + 300_000);
  await cache.resolve("oauth", exchange);
  expect(exchange).toHaveBeenCalledTimes(2);
});

it("提前刷新临时失败并发共享原值、短退避、按原期限失效", async () => {
  vi.useFakeTimers();
  const start = Date.now();
  const cache = new ZaiBusinessTokenCache();
  const original = await cache.resolve("oauth", async () => ({
    data: { access_token: "business-token", expires_in: 600 },
  }));
  const exchange = vi.fn(async () => {
    throw new ProjectAccessTokenTransientError();
  });
  vi.setSystemTime(start + 481_000);
  const values = await Promise.all([
    cache.resolve("oauth", exchange),
    cache.resolve("oauth", exchange),
  ]);
  expect(values[0]).toBe(original);
  expect(values[1]).toBe(original);
  await expect(cache.resolve("oauth", exchange)).resolves.toBe(original);
  expect(exchange).toHaveBeenCalledTimes(1);
  vi.setSystemTime(start + 486_000);
  await expect(cache.resolve("oauth", exchange)).resolves.toBe(original);
  expect(exchange).toHaveBeenCalledTimes(2);
  vi.setSystemTime(start + 600_000);
  await expect(cache.resolve("oauth", exchange)).rejects.toThrow("transient_failure");
});

it.each(["clear", "invalidate", "switch", "expire"])(
  "在途临时故障遇到 %s 不降级",
  async (action) => {
    vi.useFakeTimers();
    const start = Date.now();
    const cache = new ZaiBusinessTokenCache();
    const original = await cache.resolve("oauth", async () => ({
      data: { access_token: "business-token", expires_in: 600 },
    }));
    vi.setSystemTime(start + 481_000);
    let reject!: (error: Error) => void;
    const pending = cache.resolve(
      "oauth",
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    await Promise.resolve();
    if (action === "clear") cache.clear();
    if (action === "invalidate") cache.invalidate(original);
    if (action === "expire") vi.setSystemTime(start + 600_000);
    if (action === "switch")
      await cache.resolve("other", async () => ({ data: { access_token: "other-token" } }));
    reject(new ProjectAccessTokenTransientError());
    await expect(pending).rejects.toThrow();
  },
);

it("未知有效期不能把本地缓存上限当作可降级期限", async () => {
  vi.useFakeTimers();
  const cache = new ZaiBusinessTokenCache();
  await cache.resolve("oauth", async () => ({ data: { access_token: "opaque-token" } }));
  vi.setSystemTime(Date.now() + 181_000);
  await expect(
    cache.resolve("oauth", async () => {
      throw new ProjectAccessTokenTransientError();
    }),
  ).rejects.toThrow();
});

it("降级保留 JWT 对象身份，迟到 401 仍能阻止退避期内复用", async () => {
  vi.useFakeTimers();
  const cache = new ZaiBusinessTokenCache();
  const original = await cache.resolve("oauth", async () => ({
    data: { access_token: "token", expires_in: 600 },
  }));
  vi.setSystemTime(Date.now() + 481_000);
  const fail = async () => {
    throw new ProjectAccessTokenTransientError();
  };
  await expect(cache.resolve("oauth", fail)).resolves.toBe(original);
  cache.invalidate(original);
  expect(cache.wasRejected(original)).toBe(true);
  await expect(cache.resolve("oauth", fail)).rejects.toThrow();
});

it("短退避结束后可恢复换证，并仍采用 JWT 与响应 TTL 的最早期限", async () => {
  vi.useFakeTimers();
  const start = Date.now();
  const cache = new ZaiBusinessTokenCache();
  const token = `header.${Buffer.from(JSON.stringify({ exp: start / 1000 + 600 })).toString("base64url")}.sig`;
  const original = await cache.resolve("oauth", async () => ({
    data: { access_token: token, expires_in: 3600 },
  }));
  vi.setSystemTime(start + 481_000);
  const exchange = vi
    .fn()
    .mockRejectedValueOnce(new ProjectAccessTokenTransientError())
    .mockResolvedValue({ data: { access_token: "new-token", expires_in: 600 } });
  await expect(cache.resolve("oauth", exchange)).resolves.toBe(original);
  expect(original.expiresAt).toBe(start + 600_000);
  vi.setSystemTime(start + 486_000);
  expect((await cache.resolve("oauth", exchange)).token).toBe("new-token");
});
it("clear 后不发送尚未发出的旧交换", async () => {
  const cache = new ZaiBusinessTokenCache();
  const exchange = vi.fn();
  const pending = cache.resolve("oauth", exchange);
  cache.clear();
  await expect(pending).rejects.toThrow("scope_invalidated");
  expect(exchange).not.toHaveBeenCalled();
});
it("退出和换登录拒绝迟到响应，旧 401 不影响新结果", async () => {
  const cache = new ZaiBusinessTokenCache();
  let finish!: (value: unknown) => void;
  const pending = cache.resolve(
    "old",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await Promise.resolve();
  cache.clear();
  const next = await cache.resolve("new", async () => ({ data: { access_token: "new-token" } }));
  finish({ data: { access_token: "old-token" } });
  await expect(pending).rejects.toThrow("scope_invalidated");
  cache.invalidate({ token: "old-token", refreshAt: Date.now() });
  expect(
    await cache.resolve("new", async () => {
      throw Error("unexpected exchange");
    }),
  ).toBe(next);
});

function createMemoryPersistence(initial?: { value: ZaiBusinessToken; scope?: string }) {
  let stored = initial;
  const calls = { load: [] as (string | undefined)[], remove: [] as string[], save: 0 };
  const persistence: ZaiBusinessTokenPersistence = {
    async load(scope) {
      calls.load.push(scope);
      if (!stored || stored.scope !== scope) return undefined;
      return stored.value;
    },
    async remove(token) {
      calls.remove.push(token);
      if (stored?.value.token === token) stored = undefined;
    },
    async save(value, scope) {
      calls.save++;
      stored = { value, scope };
    },
  };
  return {
    calls,
    persistence,
    stored: () => stored,
    seed: (value: ZaiBusinessToken, scope?: string) => {
      stored = { value, scope };
    },
  };
}

it("换证成功写透持久化；未知有效期不落盘", async () => {
  vi.useFakeTimers();
  const opaque = createMemoryPersistence();
  const opaqueCache = new ZaiBusinessTokenCache(undefined, opaque.persistence);
  await opaqueCache.resolve("oauth", async () => ({ data: { access_token: "opaque-token" } }));
  expect(opaque.calls.save).toBe(0);

  const persisted = createMemoryPersistence();
  const cache = new ZaiBusinessTokenCache(undefined, persisted.persistence);
  const value = await cache.resolve(
    "oauth",
    async () => ({ data: { access_token: "business-token", expires_in: 600 } }),
    "user-1",
  );
  expect(persisted.calls.save).toBe(1);
  expect(persisted.stored()).toEqual({
    value,
    scope: "user-1",
  });
  expect(persisted.stored()?.value.expiresAt).toBe(Date.now() + 600_000);
});

it("新进程领养未过期的持久化副本，不再换证", async () => {
  vi.useFakeTimers();
  const start = Date.now();
  const memory = createMemoryPersistence();
  memory.seed(
    Object.freeze({
      token: "persisted-token",
      expiresAt: start + 600_000,
      refreshAt: start + 480_000,
    }),
    "user-1",
  );
  const cache = new ZaiBusinessTokenCache(undefined, memory.persistence);
  const exchange = vi.fn(async () => ({ data: { access_token: "exchanged-token" } }));
  const value = await cache.resolve("oauth", exchange, "user-1");
  expect(value.token).toBe("persisted-token");
  expect(exchange).not.toHaveBeenCalled();
  expect(memory.calls.load).toEqual(["user-1"]);
  // 领养副本进入内存后与换证结果同语义：未到刷新窗口前并发复用。
  expect(await cache.resolve("oauth", exchange, "user-1")).toBe(value);
  expect(exchange).not.toHaveBeenCalled();
});

it("持久化副本进入刷新窗口即视为缺席，回退换证并覆盖记录", async () => {
  vi.useFakeTimers();
  const start = Date.now();
  const memory = createMemoryPersistence();
  memory.seed(
    Object.freeze({
      token: "stale-token",
      expiresAt: start + 600_000,
      refreshAt: start + 480_000,
    }),
    "user-1",
  );
  vi.setSystemTime(start + 481_000);
  const cache = new ZaiBusinessTokenCache(undefined, memory.persistence);
  const value = await cache.resolve(
    "oauth",
    async () => ({ data: { access_token: "fresh-token", expires_in: 600 } }),
    "user-1",
  );
  expect(value.token).toBe("fresh-token");
  expect(memory.stored()?.value.token).toBe("fresh-token");
});

it("401 拒绝的持久化副本不得再次领养，并撤掉落盘记录", async () => {
  vi.useFakeTimers();
  const start = Date.now();
  const memory = createMemoryPersistence();
  memory.seed(
    Object.freeze({
      token: "rejected-token",
      expiresAt: start + 600_000,
      refreshAt: start + 480_000,
    }),
    "user-1",
  );
  const cache = new ZaiBusinessTokenCache(undefined, memory.persistence);
  const adopted = await cache.resolve("oauth", vi.fn(), "user-1");
  expect(adopted.token).toBe("rejected-token");
  cache.invalidate(adopted);
  // 迟到的 401 已撤内存与持久化；下一次必须重新换证。
  const exchange = vi.fn(async () => ({ data: { access_token: "fresh-token", expires_in: 600 } }));
  const value = await cache.resolve("oauth", exchange, "user-1");
  expect(value.token).toBe("fresh-token");
  expect(exchange).toHaveBeenCalledTimes(1);
  expect(memory.calls.remove).toEqual(["rejected-token"]);
  expect(memory.stored()?.value.token).toBe("fresh-token");
});

it("持久化读写失败退化为仅内存行为，不影响换证结果", async () => {
  vi.useFakeTimers();
  const broken: ZaiBusinessTokenPersistence = {
    load: async () => {
      throw new Error("store unreadable");
    },
    remove: async () => {
      throw new Error("store unreadable");
    },
    save: async () => {
      throw new Error("store unwritable");
    },
  };
  const cache = new ZaiBusinessTokenCache(undefined, broken);
  const exchange = vi.fn(async () => ({ data: { access_token: "business-token", expires_in: 600 } }));
  const value = await cache.resolve("oauth", exchange, "user-1");
  expect(value.token).toBe("business-token");
  expect(await cache.resolve("oauth", exchange, "user-1")).toBe(value);
  expect(exchange).toHaveBeenCalledTimes(1);
});
