import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadEnv, isAnthropicConnected, isChatConnected, _resetEnvCacheForTests } from "../../src/config/env.js";

const REQUIRED_BASE_ENV = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/limona_test",
  SESSION_COOKIE_SECRET: "a".repeat(32),
};

describe("env — graceful degradation when AI keys are missing", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    _resetEnvCacheForTests();
    process.env = { ...originalEnv, ...REQUIRED_BASE_ENV };
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
    _resetEnvCacheForTests();
  });

  it("loads successfully without ANTHROPIC_API_KEY set", () => {
    expect(() => loadEnv()).not.toThrow();
  });

  it("reports not connected when the key is missing", () => {
    loadEnv();
    expect(isAnthropicConnected()).toBe(false);
    expect(isChatConnected()).toBe(false);
  });

  it("reports connected once the key is present", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    _resetEnvCacheForTests();
    loadEnv();
    expect(isAnthropicConnected()).toBe(true);
    expect(isChatConnected()).toBe(true);
  });

  it("fails fast and loudly when a truly required var is missing", () => {
    delete process.env.DATABASE_URL;
    _resetEnvCacheForTests();
    expect(() => loadEnv()).toThrow(/Invalid environment configuration/);
  });
});
