// Added in this fork (standalone-account-patches, Apache-2.0): see patch_docs/README.md.
// OAuth 凭据仓储的退出清理边界：CLI 换证 adapter 把 ~180 天业务 JWT 持久化到
// oauth:zai:business_token（同一份 credentials.json）。App 侧退出/切换账号若漏删该 key，
// 已登出账号的长期业务 JWT 会留在磁盘上，直到下一次同账号登录被复用。
import { describe, expect, it } from "vitest";
import { OAuthCredentialRepo } from "../src/oauth/repo/oauthCredentialRepo.js";
import type { ICredentialService } from "../src/credential/credential.js";

function fakeCredentialService(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const service: ICredentialService = {
    load: async (key) => values.get(key) ?? null,
    save: async (key, value) => {
      values.set(key, value);
    },
    delete: async (key) => {
      values.delete(key);
    },
  };
  return { service, values };
}

describe("OAuthCredentialRepo.clearProvider 清理边界", () => {
  it("zai 退出必须一并清除业务 JWT 持久化 key", async () => {
    const { service, values } = fakeCredentialService({
      "oauth:active_provider": "zai",
      "oauth:zai:access_token": "oauth",
      "oauth:zai:refresh_token": "refresh",
      "oauth:zai:user_info": "{}",
      "oauth:zai:business_token": "encrypted-business-jwt-record",
      zcodejwttoken: "jwt",
    });
    const repo = new OAuthCredentialRepo(service);
    await repo.clearProvider("zai");
    expect(values.has("oauth:zai:business_token")).toBe(false);
    expect(values.has("oauth:zai:access_token")).toBe(false);
    expect(values.has("oauth:zai:refresh_token")).toBe(false);
    expect(values.has("oauth:zai:user_info")).toBe(false);
    expect(values.has("zcodejwttoken")).toBe(false);
  });

  it("bigmodel 退出不得动 zai 命名空间的业务 JWT key", async () => {
    const { service, values } = fakeCredentialService({
      "oauth:bigmodel:access_token": "bm",
      "oauth:bigmodel:refresh_token": "bm-refresh",
      "oauth:zai:business_token": "keep",
    });
    const repo = new OAuthCredentialRepo(service);
    await repo.clearProvider("bigmodel");
    expect(values.has("oauth:bigmodel:access_token")).toBe(false);
    expect(values.has("oauth:bigmodel:refresh_token")).toBe(false);
    expect(values.has("oauth:zai:business_token")).toBe(true);
  });

  it("clearActiveSession 与损坏恢复共用 clearProvider，同样撤掉业务 JWT", async () => {
    const { service, values } = fakeCredentialService({
      "oauth:active_provider": "zai",
      "oauth:zai:access_token": "oauth",
      "oauth:zai:business_token": "record",
    });
    const repo = new OAuthCredentialRepo(service);
    await repo.clearActiveSession();
    expect(values.has("oauth:zai:business_token")).toBe(false);
    expect(values.has("oauth:active_provider")).toBe(false);
  });
});
