import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SSH_BUNDLE_STAGING_ROOT_ENV,
  SshBundleStagingRootError,
  resolveSshBundleStagingRoot,
} from "./ssh.js";

const ENV_KEY = SSH_BUNDLE_STAGING_ROOT_ENV;

async function makeTrustedRoot(): Promise<{ root: string; prefix: string; cleanup: () => Promise<void> }> {
  // Canonicalize immediately: on macOS os.tmpdir() itself resolves through a
  // symlink (/tmp -> /private/tmp), and resolveSshBundleStagingRoot requires
  // the configured path to already be canonical, so the trusted root used by
  // these tests must be too.
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-bundle-trusted-root-"));
  const root = await fs.realpath(created);
  return {
    root,
    prefix: `${root}${path.sep}`,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

describe("resolveSshBundleStagingRoot", () => {
  const originalEnv = process.env[ENV_KEY];
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalEnv;
    }
    vi.restoreAllMocks();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("defaults to os.tmpdir() when the env var is unset", async () => {
    delete process.env[ENV_KEY];
    await expect(resolveSshBundleStagingRoot()).resolves.toBe(os.tmpdir());
  });

  it("defaults to os.tmpdir() when the env var is blank", async () => {
    process.env[ENV_KEY] = "   ";
    await expect(resolveSshBundleStagingRoot()).resolves.toBe(os.tmpdir());
  });

  it("selects the configured directory when it is canonical, restrictive, and trusted", async () => {
    const trusted = await makeTrustedRoot();
    cleanups.push(trusted.cleanup);
    const staged = path.join(trusted.root, "staging");
    await fs.mkdir(staged, { mode: 0o700 });

    process.env[ENV_KEY] = staged;
    const resolved = await resolveSshBundleStagingRoot({ trustedRootPrefix: trusted.prefix });
    expect(resolved).toBe(staged);

    // The resolved root is a normal fs.mkdtemp parent: staging and cleanup
    // behave deterministically, matching the historical os.tmpdir() contract.
    const bundleDir = await fs.mkdtemp(path.join(resolved, "paperclip-ssh-bundle-"));
    await expect(fs.stat(bundleDir)).resolves.toBeDefined();
    await fs.rm(bundleDir, { recursive: true, force: true });
    await expect(fs.stat(bundleDir)).rejects.toThrow();
  });

  it("rejects a relative path", async () => {
    process.env[ENV_KEY] = "relative/bundle-staging";
    await expect(resolveSshBundleStagingRoot()).rejects.toThrow(SshBundleStagingRootError);
  });

  it("rejects a path that does not exist", async () => {
    const trusted = await makeTrustedRoot();
    cleanups.push(trusted.cleanup);
    process.env[ENV_KEY] = path.join(trusted.root, "missing");
    await expect(
      resolveSshBundleStagingRoot({ trustedRootPrefix: trusted.prefix }),
    ).rejects.toThrow(SshBundleStagingRootError);
  });

  it("rejects a symlinked staging directory", async () => {
    const trusted = await makeTrustedRoot();
    cleanups.push(trusted.cleanup);
    const real = path.join(trusted.root, "real");
    const link = path.join(trusted.root, "link");
    await fs.mkdir(real, { mode: 0o700 });
    await fs.symlink(real, link);

    process.env[ENV_KEY] = link;
    await expect(
      resolveSshBundleStagingRoot({ trustedRootPrefix: trusted.prefix }),
    ).rejects.toThrow(SshBundleStagingRootError);
  });

  it("rejects a directory reached through a symlinked ancestor", async () => {
    const trusted = await makeTrustedRoot();
    cleanups.push(trusted.cleanup);
    const nested = path.join(trusted.root, "nested");
    const real = path.join(nested, "real");
    const linkedAncestor = path.join(trusted.root, "link-to-nested");
    await fs.mkdir(nested, { mode: 0o700 });
    await fs.mkdir(real, { mode: 0o700 });
    await fs.symlink(nested, linkedAncestor);

    process.env[ENV_KEY] = path.join(linkedAncestor, "real");
    await expect(
      resolveSshBundleStagingRoot({ trustedRootPrefix: trusted.prefix }),
    ).rejects.toThrow(SshBundleStagingRootError);
  });

  it("rejects a directory outside the trusted root", async () => {
    const trusted = await makeTrustedRoot();
    cleanups.push(trusted.cleanup);
    const created = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-bundle-untrusted-"));
    cleanups.push(async () => fs.rm(created, { recursive: true, force: true }));
    await fs.chmod(created, 0o700);
    const untrusted = await fs.realpath(created);

    process.env[ENV_KEY] = untrusted;
    await expect(
      resolveSshBundleStagingRoot({ trustedRootPrefix: trusted.prefix }),
    ).rejects.toThrow(SshBundleStagingRootError);
  });

  it("rejects a group- or world-accessible directory", async () => {
    const trusted = await makeTrustedRoot();
    cleanups.push(trusted.cleanup);
    const loose = path.join(trusted.root, "loose");
    await fs.mkdir(loose, { mode: 0o750 });

    process.env[ENV_KEY] = loose;
    await expect(
      resolveSshBundleStagingRoot({ trustedRootPrefix: trusted.prefix }),
    ).rejects.toThrow(SshBundleStagingRootError);
  });

  it("rejects the trusted root directory itself, even though it is canonical and restrictive", async () => {
    const trusted = await makeTrustedRoot();
    cleanups.push(trusted.cleanup);
    await fs.chmod(trusted.root, 0o700);

    process.env[ENV_KEY] = trusted.root;
    await expect(
      resolveSshBundleStagingRoot({ trustedRootPrefix: trusted.prefix }),
    ).rejects.toThrow(SshBundleStagingRootError);
  });

  it("throws when the free-space check itself fails, instead of silently admitting the root", async () => {
    const trusted = await makeTrustedRoot();
    cleanups.push(trusted.cleanup);
    const staged = path.join(trusted.root, "staging");
    await fs.mkdir(staged, { mode: 0o700 });

    vi.spyOn(fs, "statfs").mockRejectedValue(new Error("statfs unavailable"));

    process.env[ENV_KEY] = staged;
    await expect(
      resolveSshBundleStagingRoot({ trustedRootPrefix: trusted.prefix }),
    ).rejects.toThrow(SshBundleStagingRootError);
  });

  it("rejects a trusted, restrictive directory without enough free space", async () => {
    const trusted = await makeTrustedRoot();
    cleanups.push(trusted.cleanup);
    const staged = path.join(trusted.root, "tight");
    await fs.mkdir(staged, { mode: 0o700 });

    vi.spyOn(fs, "statfs").mockResolvedValue({
      type: 0,
      bsize: 4096,
      blocks: 1000,
      bfree: 1,
      bavail: 1,
      files: 1000,
      ffree: 1000,
    } as Awaited<ReturnType<typeof fs.statfs>>);

    process.env[ENV_KEY] = staged;
    await expect(
      resolveSshBundleStagingRoot({ trustedRootPrefix: trusted.prefix }),
    ).rejects.toThrow(SshBundleStagingRootError);
  });
});
