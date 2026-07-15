import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getConfig: vi.fn(),
}));
const mockSecrets = vi.hoisted(() => ({ resolveSecretValue: vi.fn() }));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));
vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecrets,
}));

import {
  createPluginSecretsHandler,
  extractSecretRefPathsFromConfig,
} from "../services/plugin-secrets-handler.js";

describe("extractSecretRefPathsFromConfig", () => {
  const ordinaryUuid = "11111111-1111-4111-8111-111111111111";
  const secretUuid = "77777777-7777-4777-8777-777777777777";

  it("does not classify ordinary UUID fields as secrets when a schema is declared", () => {
    const refs = extractSecretRefPathsFromConfig(
      { companyId: ordinaryUuid },
      {
        type: "object",
        properties: { companyId: { type: "string", format: "uuid" } },
      },
    );

    expect(refs.size).toBe(0);
  });

  it("extracts only schema fields explicitly annotated as secret references", () => {
    const refs = extractSecretRefPathsFromConfig(
      { companyId: ordinaryUuid, apiKey: secretUuid },
      {
        type: "object",
        properties: {
          companyId: { type: "string", format: "uuid" },
          apiKey: { type: "string", format: "secret-ref" },
        },
      },
    );

    expect([...refs.keys()]).toEqual([secretUuid]);
    expect([...refs.get(secretUuid) ?? []]).toEqual(["apiKey"]);
  });

  it("extracts secret references from array item schemas without classifying sibling UUIDs", () => {
    const secondSecretUuid = "88888888-8888-4888-8888-888888888888";
    const refs = extractSecretRefPathsFromConfig(
      {
        companyIds: [ordinaryUuid],
        credentials: [
          { id: ordinaryUuid, secret: secretUuid },
          { id: ordinaryUuid, secret: secondSecretUuid },
        ],
      },
      {
        type: "object",
        properties: {
          companyIds: { type: "array", items: { type: "string", format: "uuid" } },
          credentials: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                secret: { type: "string", format: "secret-ref" },
              },
            },
          },
        },
      },
    );

    expect([...refs.keys()]).toEqual([secretUuid, secondSecretUuid]);
    expect([...refs.get(secretUuid) ?? []]).toEqual(["credentials.0.secret"]);
    expect([...refs.get(secondSecretUuid) ?? []]).toEqual(["credentials.1.secret"]);
  });

  it("supports tuple and prefix-item secret schemas", () => {
    const tupleSecret = "99999999-9999-4999-8999-999999999999";
    const refs = extractSecretRefPathsFromConfig(
      { tuple: [ordinaryUuid, tupleSecret], modernTuple: [secretUuid, ordinaryUuid] },
      {
        type: "object",
        properties: {
          tuple: {
            type: "array",
            items: [
              { type: "string", format: "uuid" },
              { type: "string", format: "secret-ref" },
            ],
          },
          modernTuple: {
            type: "array",
            prefixItems: [
              { type: "string", format: "secret-ref" },
              { type: "string", format: "uuid" },
            ],
          },
        },
      },
    );

    expect([...refs.keys()]).toEqual([tupleSecret, secretUuid]);
    expect([...refs.get(tupleSecret) ?? []]).toEqual(["tuple.1"]);
    expect([...refs.get(secretUuid) ?? []]).toEqual(["modernTuple.0"]);
  });

  it("preserves legacy UUID discovery only when no schema exists", () => {
    const refs = extractSecretRefPathsFromConfig({ legacySecret: secretUuid });

    expect([...refs.keys()]).toEqual([secretUuid]);
  });
});

describe("createPluginSecretsHandler", () => {
  const pluginId = "11111111-1111-4111-8111-111111111111";
  const companyId = "22222222-2222-4222-8222-222222222222";
  const secretRef = "77777777-7777-4777-8777-777777777777";
  const schema = {
    type: "object",
    properties: {
      companyId: { type: "string", format: "uuid" },
      apiKey: { type: "string", format: "secret-ref" },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry.getById.mockResolvedValue({ id: pluginId, manifestJson: { instanceConfigSchema: schema } });
    mockRegistry.getConfig.mockResolvedValue({ pluginId, configJson: { companyId, apiKey: secretRef } });
    mockSecrets.resolveSecretValue.mockResolvedValue("resolved-value");
  });

  it("resolves only the exact company-scoped plugin config binding", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId,
    });

    await expect(handler.resolve({ secretRef })).resolves.toBe("resolved-value");
    expect(mockSecrets.resolveSecretValue).toHaveBeenCalledWith(
      companyId,
      secretRef,
      "latest",
      {
        consumerType: "plugin",
        consumerId: pluginId,
        configPath: "apiKey",
        actorType: "plugin",
        actorId: pluginId,
        pluginId,
      },
    );
  });

  it("fails closed when the persisted company scope is not a UUID", async () => {
    mockRegistry.getConfig.mockResolvedValue({
      pluginId,
      configJson: { companyId: "company", apiKey: secretRef },
    });
    const handler = createPluginSecretsHandler({ db: {} as never, pluginId });

    await expect(handler.resolve({ secretRef })).rejects.toMatchObject({
      name: "InvalidPluginCompanyScopeError",
    });
    expect(mockSecrets.resolveSecretValue).not.toHaveBeenCalled();
  });

  it("fails closed when a ref is absent or ambiguously bound in plugin config", async () => {
    mockRegistry.getById.mockResolvedValue({
      id: pluginId,
      manifestJson: {
        instanceConfigSchema: {
          type: "object",
          properties: {
            companyId: { type: "string", format: "uuid" },
            primary: { type: "string", format: "secret-ref" },
            secondary: { type: "string", format: "secret-ref" },
          },
        },
      },
    });
    mockRegistry.getConfig.mockResolvedValue({
      pluginId,
      configJson: { companyId, primary: secretRef, secondary: secretRef },
    });
    const handler = createPluginSecretsHandler({ db: {} as never, pluginId });

    await expect(handler.resolve({ secretRef })).rejects.toMatchObject({
      name: "SecretReferenceNotBoundError",
    });
    expect(mockSecrets.resolveSecretValue).not.toHaveBeenCalled();
  });

  it("rejects malformed secret refs before config or secret access", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId,
    });

    await expect(
      handler.resolve({ secretRef: "not-a-uuid" }),
    ).rejects.toThrow(/invalid secret reference/i);
    expect(mockRegistry.getById).not.toHaveBeenCalled();
    expect(mockSecrets.resolveSecretValue).not.toHaveBeenCalled();
  });
});
