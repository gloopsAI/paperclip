import { z } from "zod";
import {
  ENVIRONMENT_DRIVERS,
  ENVIRONMENT_LEASE_CLEANUP_STATUSES,
  ENVIRONMENT_LEASE_STATUSES,
  ENVIRONMENT_STATUSES,
} from "../constants.js";
import { envConfigSchema } from "./secret.js";

export const environmentDriverSchema = z.enum(ENVIRONMENT_DRIVERS);
export const environmentStatusSchema = z.enum(ENVIRONMENT_STATUSES);
export const environmentLeaseStatusSchema = z.enum(ENVIRONMENT_LEASE_STATUSES);
export const environmentLeaseCleanupStatusSchema = z.enum(ENVIRONMENT_LEASE_CLEANUP_STATUSES);

const environmentFields = {
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  driver: environmentDriverSchema,
  status: environmentStatusSchema.optional().default("active"),
  config: z.record(z.string(), z.unknown()).optional().default({}),
  envVars: envConfigSchema.optional().default({}),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
};

export const createEnvironmentSchema = z.object(environmentFields).strict();
export type CreateEnvironment = z.infer<typeof createEnvironmentSchema>;

export const updateEnvironmentSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  driver: environmentDriverSchema.optional(),
  status: environmentStatusSchema.optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  envVars: envConfigSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
}).strict();
export type UpdateEnvironment = z.infer<typeof updateEnvironmentSchema>;

export const probeEnvironmentConfigSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  driver: environmentDriverSchema,
  config: z.record(z.string(), z.unknown()).optional().default({}),
  envVars: envConfigSchema.optional().default({}),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
}).strict();
export type ProbeEnvironmentConfig = z.infer<typeof probeEnvironmentConfigSchema>;

export const deleteEnvironmentSchema = z.object({
  blockMessage: z.string().min(1),
}).strict();
export type DeleteEnvironment = z.infer<typeof deleteEnvironmentSchema>;

export const environmentDeleteBlockReasonSchema = z.enum([
  "managed_local",
  "instance_default",
]);

export const environmentDeleteBlastRadiusSchema = z.object({
  environmentId: z.string(),
  environmentName: z.string(),
  driver: environmentDriverSchema,
  status: environmentStatusSchema,
  canDelete: z.boolean(),
  blockReason: environmentDeleteBlockReasonSchema.nullable(),
  blockMessage: z.string(),
  staticReferences: z.object({
    isInstanceDefault: z.boolean(),
    agentDefaultCount: z.number().int().nonnegative(),
    executionWorkspaceSelectionCount: z.number().int().nonnegative(),
    issueSelectionCount: z.number().int().nonnegative(),
    projectSelectionCount: z.number().int().nonnegative(),
    secretBindingCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
  }).strict(),
  activeRuntimeUse: z.object({
    activeLeaseCount: z.number().int().nonnegative(),
    runningSetupSessionCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    hasActiveUse: z.boolean(),
  }).strict(),
}).strict();
