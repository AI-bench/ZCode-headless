// Added in this fork (standalone-account-patches, Apache-2.0): see patch_docs/README.md.
import { describe, expect, it, vi } from "vitest";
import {
  ZCODE_STANDALONE_ACCOUNT_ENV,
  readStandaloneAccountEnabled,
  resolveProcessProviderRegistryRuntimeOptions,
} from "../src/app/process-provider-registry-runtime.js";

function fakeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("readStandaloneAccountEnabled", () => {
  it("默认关闭；仅 1/true（含首尾空白）显式开启", () => {
    expect(readStandaloneAccountEnabled({})).toBe(false);
    expect(readStandaloneAccountEnabled({ ZCODE_STANDALONE_ACCOUNT: undefined })).toBe(false);
    expect(readStandaloneAccountEnabled({ ZCODE_STANDALONE_ACCOUNT: "" })).toBe(false);
    expect(readStandaloneAccountEnabled({ ZCODE_STANDALONE_ACCOUNT: "  " })).toBe(false);
    expect(readStandaloneAccountEnabled({ ZCODE_STANDALONE_ACCOUNT: "0" })).toBe(false);
    expect(readStandaloneAccountEnabled({ ZCODE_STANDALONE_ACCOUNT: "false" })).toBe(false);
    // 认证来源开关不允许猜测意图：非 1/true 的一律保持 Host 托管语义。
    expect(readStandaloneAccountEnabled({ ZCODE_STANDALONE_ACCOUNT: "yes" })).toBe(false);
    expect(readStandaloneAccountEnabled({ ZCODE_STANDALONE_ACCOUNT: "1" })).toBe(true);
    expect(readStandaloneAccountEnabled({ ZCODE_STANDALONE_ACCOUNT: "true" })).toBe(true);
    expect(readStandaloneAccountEnabled({ ZCODE_STANDALONE_ACCOUNT: " 1 " })).toBe(true);
    expect(readStandaloneAccountEnabled({ ZCODE_STANDALONE_ACCOUNT: "TRUE" })).toBe(false);
  });
});

describe("resolveProcessProviderRegistryRuntimeOptions", () => {
  it("开关关闭时保持托管语义，不进入 Standalone 分支", () => {
    const log = fakeLogger();
    expect(resolveProcessProviderRegistryRuntimeOptions({}, log)).toEqual({});
    expect(
      resolveProcessProviderRegistryRuntimeOptions(
        { [ZCODE_STANDALONE_ACCOUNT_ENV]: "0" },
        log,
      ),
    ).toEqual({});
    expect(log.error).not.toHaveBeenCalled();
  });

  it("开关开启时装配 Standalone 观测回调并接入 logger", () => {
    const log = fakeLogger();
    const options = resolveProcessProviderRegistryRuntimeOptions(
      { [ZCODE_STANDALONE_ACCOUNT_ENV]: "1" },
      log,
    );
    expect(options.standalone).toBeDefined();

    const failure = new Error("credential store unavailable");
    options.standalone!.onAccountInitializationError!(failure);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("Standalone Account"),
      failure,
      expect.objectContaining({
        event: "zcode_protocol.provider_registry.standalone_account_error",
      }),
    );

    options.standalone!.onBuiltinRefreshError!("boom");
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("Built-in"),
      expect.any(Error),
      expect.objectContaining({
        event: "zcode_protocol.provider_registry.standalone_builtin_refresh_error",
      }),
    );

    options.standalone!.onBuiltinRefreshResult!({ result: "updated", revision: 2 });
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("updated"),
      expect.objectContaining({
        event: "zcode_protocol.provider_registry.standalone_builtin_refresh",
        revision: 2,
      }),
    );

    // TTL 之外的静默结果只留 debug 痕迹，不刷生产 info。
    options.standalone!.onBuiltinRefreshResult!({ result: "unchanged" });
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("unchanged"),
      expect.anything(),
    );
    expect(log.info).toHaveBeenCalledTimes(1);
  });
});
