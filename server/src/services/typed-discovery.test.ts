import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISCOVERY_PROJECT_KEY,
  DISCOVERY_PROJECT_KEYS,
  DISCOVERY_PROJECT_ROUTING,
  DISCOVERY_RECEIPT_SCHEMA,
  buildDiscoveryReceipt,
  dedupeDiscovery,
  normalizeFingerprint,
  planDiscovery,
  resolveDiscoveryProjectKey,
  routeDiscovery,
  type DiscoveryProject,
  type DiscoveryProvenance,
  type DiscoveryRequest,
} from "./typed-discovery.js";

const provenance: DiscoveryProvenance = {
  source: "agent",
  agentId: "agent-1",
  runId: "run-1",
};

function request(overrides: Partial<DiscoveryRequest> = {}): DiscoveryRequest {
  return {
    title: "Found a flaky test in checkout",
    summary: "Intermittent failure in issue checkout wake path under load",
    provenance,
    ...overrides,
  };
}

const projects: DiscoveryProject[] = [
  { id: "proj-backlog", name: "BACKLOG" },
  { id: "proj-wopr", name: "WO-PR" },
  { id: "proj-ops", name: "Operations" },
];

describe("resolveDiscoveryProjectKey", () => {
  it("defaults to BACKLOG when projectKey is omitted", () => {
    expect(resolveDiscoveryProjectKey({})).toBe(DEFAULT_DISCOVERY_PROJECT_KEY);
    expect(resolveDiscoveryProjectKey({ projectKey: null })).toBe("BACKLOG");
    expect(resolveDiscoveryProjectKey({ projectKey: "  " })).toBe("BACKLOG");
  });

  it("normalizes WO-PR aliases", () => {
    expect(resolveDiscoveryProjectKey({ projectKey: "wo-pr" })).toBe("WO-PR");
    expect(resolveDiscoveryProjectKey({ projectKey: "WOPR" })).toBe("WO-PR");
    expect(resolveDiscoveryProjectKey({ projectKey: "wo_pr" })).toBe("WO-PR");
  });
});

describe("normalizeFingerprint", () => {
  it("derives a stable sha256 from normalized title + summary", () => {
    const a = normalizeFingerprint({
      title: "  Found a flaky test in checkout ",
      summary: "Intermittent failure in issue checkout wake path under load",
    });
    const b = normalizeFingerprint({
      title: "Found a flaky test in checkout",
      summary: "  Intermittent   failure in issue checkout wake path under load ",
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);

    const expected = createHash("sha256")
      .update(
        "found a flaky test in checkout\nintermittent failure in issue checkout wake path under load",
        "utf8",
      )
      .digest("hex");
    expect(a).toBe(expected);
  });

  it("prefers a provided fingerprint (trimmed + lowercased)", () => {
    const fp = normalizeFingerprint({
      title: "A",
      summary: "B",
      fingerprint: "  AbC123  ",
    });
    expect(fp).toBe("abc123");
  });

  it("ignores empty provided fingerprint and hashes title+summary", () => {
    const fromEmpty = normalizeFingerprint({
      title: "Same",
      summary: "Thing",
      fingerprint: "   ",
    });
    const fromMissing = normalizeFingerprint({
      title: "Same",
      summary: "Thing",
    });
    expect(fromEmpty).toBe(fromMissing);
  });
});

describe("routeDiscovery", () => {
  it("routes default key to BACKLOG project", () => {
    const result = routeDiscovery({}, projects);
    expect(result).toEqual({
      ok: true,
      projectKey: "BACKLOG",
      projectId: "proj-backlog",
      projectName: "BACKLOG",
    });
  });

  it("routes WO-PR key to the WO-PR project", () => {
    const result = routeDiscovery({ projectKey: "WO-PR" }, projects);
    expect(result).toEqual({
      ok: true,
      projectKey: "WO-PR",
      projectId: "proj-wopr",
      projectName: "WO-PR",
    });
  });

  it("matches project names case-insensitively and by substring", () => {
    const result = routeDiscovery(
      { projectKey: "BACKLOG" },
      [{ id: "p1", name: "Company Backlog Board" }],
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.projectId).toBe("p1");
    }
  });

  it("returns project_list_empty when no projects are supplied", () => {
    const result = routeDiscovery({ projectKey: "BACKLOG" }, []);
    expect(result).toEqual({
      ok: false,
      error: "No projects supplied for discovery routing",
      code: "discovery.project_list_empty",
      projectKey: "BACKLOG",
    });
  });

  it("returns project_not_found when no name matches the key", () => {
    const result = routeDiscovery(
      { projectKey: "WO-PR" },
      [{ id: "p1", name: "Engineering" }],
    );
    expect(result).toEqual({
      ok: false,
      error: "No project matched discovery key WO-PR",
      code: "discovery.project_not_found",
      projectKey: "WO-PR",
    });
  });

  it("exposes BACKLOG and WO-PR in the routing table", () => {
    expect(DISCOVERY_PROJECT_ROUTING.BACKLOG.key).toBe(DISCOVERY_PROJECT_KEYS.BACKLOG);
    expect(DISCOVERY_PROJECT_ROUTING["WO-PR"].key).toBe(DISCOVERY_PROJECT_KEYS.WO_PR);
  });
});

describe("dedupeDiscovery", () => {
  it("creates when no existing fingerprints match", () => {
    const result = dedupeDiscovery(request(), []);
    expect(result.action).toBe("create");
    if (result.action === "create") {
      expect(result.reason).toBe("no_existing_fingerprint");
      expect(result.fingerprint).toBe(normalizeFingerprint(request()));
    }
  });

  it("skips when an open issue shares the fingerprint", () => {
    const fingerprint = normalizeFingerprint(request());
    const result = dedupeDiscovery(request(), [
      {
        fingerprint,
        projectId: "proj-backlog",
        status: "todo",
        issueId: "issue-9",
      },
    ]);
    expect(result).toEqual({
      action: "skip",
      fingerprint,
      reason: "duplicate_open_fingerprint",
      existingProjectId: "proj-backlog",
      existingStatus: "todo",
      existingIssueId: "issue-9",
    });
  });

  it("creates when only terminal (done/cancelled) matches exist", () => {
    const fingerprint = normalizeFingerprint(request());
    const result = dedupeDiscovery(request(), [
      { fingerprint, projectId: "proj-backlog", status: "done", issueId: "old-1" },
      { fingerprint, projectId: "proj-backlog", status: "cancelled", issueId: "old-2" },
    ]);
    expect(result.action).toBe("create");
    if (result.action === "create") {
      expect(result.reason).toBe("no_open_duplicate");
    }
  });

  it("matches fingerprints case-insensitively", () => {
    const result = dedupeDiscovery(
      request({ fingerprint: "DEADBEEF" }),
      [
        {
          fingerprint: "deadbeef",
          projectId: "proj-backlog",
          status: "in_progress",
          issueId: "issue-1",
        },
      ],
    );
    expect(result.action).toBe("skip");
  });

  it("prefers an open match in the routed project when projectId is provided", () => {
    const fingerprint = "fp-shared";
    const result = dedupeDiscovery(
      request({ fingerprint }),
      [
        {
          fingerprint,
          projectId: "proj-other",
          status: "todo",
          issueId: "issue-other",
        },
        {
          fingerprint,
          projectId: "proj-backlog",
          status: "blocked",
          issueId: "issue-backlog",
        },
      ],
      { projectId: "proj-backlog" },
    );
    expect(result.action).toBe("skip");
    if (result.action === "skip") {
      expect(result.existingIssueId).toBe("issue-backlog");
      expect(result.existingProjectId).toBe("proj-backlog");
    }
  });
});

describe("buildDiscoveryReceipt / planDiscovery", () => {
  it("builds a create receipt with provenance for BACKLOG routing", () => {
    const plannedAt = "2026-07-28T12:00:00.000Z";
    const receipt = buildDiscoveryReceipt({
      companyId: "co-1",
      request: request({ sourceIssueId: "src-1" }),
      projects,
      plannedAt,
    });

    expect(receipt.schemaVersion).toBe(DISCOVERY_RECEIPT_SCHEMA);
    expect(receipt.decision).toBe("create");
    expect(receipt.projectKey).toBe("BACKLOG");
    expect(receipt.projectId).toBe("proj-backlog");
    expect(receipt.routing.ok).toBe(true);
    expect(receipt.dedupe.action).toBe("create");
    expect(receipt.provenance).toEqual(provenance);
    expect(receipt.sourceIssueId).toBe("src-1");
    expect(receipt.plannedAt).toBe(plannedAt);
    expect(receipt.fingerprint).toBe(normalizeFingerprint(request()));
  });

  it("builds a skip receipt when dedupe finds an open match", () => {
    const fingerprint = normalizeFingerprint(request({ projectKey: "WO-PR" }));
    const receipt = buildDiscoveryReceipt({
      companyId: "co-1",
      request: request({ projectKey: "WO-PR" }),
      projects,
      existing: [
        {
          fingerprint,
          projectId: "proj-wopr",
          status: "in_review",
          issueId: "issue-42",
        },
      ],
    });

    expect(receipt.decision).toBe("skip");
    expect(receipt.projectId).toBe("proj-wopr");
    expect(receipt.dedupe.action).toBe("skip");
    if (receipt.dedupe.action === "skip") {
      expect(receipt.dedupe.existingIssueId).toBe("issue-42");
    }
  });

  it("builds an error receipt when routing fails", () => {
    const receipt = buildDiscoveryReceipt({
      companyId: "co-1",
      request: request({ projectKey: "WO-PR" }),
      projects: [{ id: "p1", name: "Engineering" }],
    });
    expect(receipt.decision).toBe("error");
    expect(receipt.projectId).toBeNull();
    expect(receipt.routing.ok).toBe(false);
  });

  it("planDiscovery rejects missing title, summary, or provenance.source", () => {
    expect(() =>
      planDiscovery({
        companyId: "co-1",
        request: request({ title: "  " }),
        projects,
      }),
    ).toThrow(/title/i);

    expect(() =>
      planDiscovery({
        companyId: "co-1",
        request: request({ summary: "" }),
        projects,
      }),
    ).toThrow(/summary/i);

    expect(() =>
      planDiscovery({
        companyId: "co-1",
        request: request({ provenance: { source: "  " } }),
        projects,
      }),
    ).toThrow(/provenance\.source/i);
  });

  it("planDiscovery returns a valid create plan for a canary", () => {
    const plan = planDiscovery({
      companyId: "co-1",
      request: request({
        title: "Canary: adapter timeout surface",
        summary: "Hermes adapter timed out during workspace prepare",
        projectKey: "BACKLOG",
        provenance: {
          source: "watchdog",
          runId: "run-canary-1",
          discoveredAt: "2026-07-28T15:00:00.000Z",
        },
      }),
      projects,
    });
    expect(plan.decision).toBe("create");
    expect(plan.projectKey).toBe("BACKLOG");
    expect(plan.projectId).toBe("proj-backlog");
    expect(plan.provenance.source).toBe("watchdog");
  });
});
