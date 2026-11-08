// Added in this fork (standalone-account-patches, Apache-2.0): see patch_docs/README.md.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // services 层单测从包内直接运行；根 vitest.config.ts 的 projects 路径按仓库根解析，
    // 在本包 CWD 下会失效。include 同时覆盖既有 test/ 与 src 内嵌契约测试两种约定。
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
  },
});
