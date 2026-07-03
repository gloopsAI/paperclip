/**
 * Work Timeline page (PAP-12424 / Phase C of PAP-12405).
 *
 * A Gantt-style view of company actor activity built on the Phase B endpoint
 * (`GET /companies/:companyId/timeline`). Rendering is the board-locked
 * Direction C (PAP-12422): dense rows, mini-map brush, custom inline SVG.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GanttChartSquare } from "lucide-react";
import type { WorkTimelineActor, WorkTimelineResult } from "@paperclipai/shared";
import { workTimelineApi, type WorkTimelineParams } from "@/api/workTimeline";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WorkTimelineChart, defaultZoomForWindow, type ZoomLevel } from "@/components/timeline/WorkTimelineChart";
import { issueColor, type ColorMode } from "@/lib/timeline/layout";
import { cn } from "@/lib/utils";

const EVERYONE = "__everyone__";

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-border">
      {options.map((opt, i) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          aria-pressed={value === opt.value}
          className={cn(
            "px-3 py-1.5 text-xs transition-colors",
            i > 0 && "border-l border-border",
            value === opt.value
              ? "bg-primary text-primary-foreground"
              : "bg-card text-foreground hover:bg-muted",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function Timeline() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [zoom, setZoom] = useState<ZoomLevel>("day");
  const zoomTouched = useRef(false);
  const setZoomManual = (z: ZoomLevel) => {
    zoomTouched.current = true;
    setZoom(z);
  };
  const [colorMode, setColorMode] = useState<ColorMode>("issue");
  // Lens defaults to the viewer's own kicked-off work (plan §Default lens,
  // PAP-12435); resolved from the session once it loads. `null` = not yet resolved
  // so we don't fire a whole-company fetch before knowing the viewer.
  const [lensUserId, setLensUserId] = useState<string | null>(null);
  const lensTouched = useRef(false);
  const setLensManual = (v: string) => {
    lensTouched.current = true;
    setLensUserId(v);
  };
  // Union of users discovered across fetches so the lens list stays stable.
  const [knownUsers, setKnownUsers] = useState<WorkTimelineActor[]>([]);

  const { data: session, isLoading: sessionLoading } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const viewerLensId = session?.user?.id ? `user:${session.user.id}` : null;

  useEffect(() => {
    setBreadcrumbs([{ label: "Timeline" }]);
  }, [setBreadcrumbs]);

  // Resolve the initial lens once the session settles: the viewer's own work if
  // we can identify them, otherwise fall back to whole-company.
  useEffect(() => {
    if (lensTouched.current || lensUserId !== null || sessionLoading) return;
    setLensUserId(viewerLensId ?? EVERYONE);
  }, [sessionLoading, viewerLensId, lensUserId]);

  // Seed the lens dropdown with the viewer so their own option is always present,
  // even before they show up as an actor in a fetched window.
  useEffect(() => {
    if (!session?.user?.id) return;
    const id = `user:${session.user.id}`;
    setKnownUsers((prev) =>
      prev.some((u) => u.id === id)
        ? prev
        : [{ id, type: "user", name: session.user.name ?? "You" }, ...prev],
    );
  }, [session]);

  const params: WorkTimelineParams = useMemo(
    () => (!lensUserId || lensUserId === EVERYONE ? {} : { userId: lensUserId.replace(/^user:/, "") }),
    [lensUserId],
  );

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.workTimeline(selectedCompanyId ?? "", lensUserId ?? undefined),
    queryFn: () => workTimelineApi.get(selectedCompanyId!, params),
    enabled: !!selectedCompanyId && lensUserId !== null,
  });

  useEffect(() => {
    if (!data || zoomTouched.current) return;
    setZoom(defaultZoomForWindow(new Date(data.window.from).getTime(), new Date(data.window.to).getTime()));
  }, [data]);

  useEffect(() => {
    if (!data) return;
    setKnownUsers((prev) => {
      const byId = new Map(prev.map((u) => [u.id, u]));
      for (const a of data.actors) if (a.type === "user") byId.set(a.id, a);
      return Array.from(byId.values());
    });
  }, [data]);

  if (!selectedCompanyId) {
    return <EmptyState icon={GanttChartSquare} message="Select a company to view its work timeline." />;
  }

  const header = (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <GanttChartSquare className="h-6 w-6 text-muted-foreground" />
        <h1 className="text-3xl font-semibold tracking-tight">Work Timeline</h1>
      </div>
      <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
        A Gantt view of who did what, when. Rows are actors; bars are heartbeat runs colored by task;
        the avatar chip at a bar's leading edge is who kicked it off (a hexagon badge marks
        routine-fired runs); straight lines are agent→agent delegation. Hover a bar for its task &amp;
        timing; click to open the task.
      </p>
    </div>
  );

  const toolbar = (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        Zoom
        <Segmented
          value={zoom}
          onChange={setZoomManual}
          options={[
            { value: "hour", label: "Hour" },
            { value: "day", label: "Day" },
            { value: "week", label: "Week" },
          ]}
        />
      </label>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        Report for
        <Select value={lensUserId ?? EVERYONE} onValueChange={setLensManual}>
          <SelectTrigger className="h-8 w-[220px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={EVERYONE}>Everyone (company)</SelectItem>
            {knownUsers.map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.id === viewerLensId ? `${u.name} (you) — work kicked off` : `${u.name} — work kicked off`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        Color
        <Segmented
          value={colorMode}
          onChange={setColorMode}
          options={[
            { value: "issue", label: "By task" },
            { value: "status", label: "By status" },
          ]}
        />
      </label>
    </div>
  );

  return (
    <div className="space-y-6">
      {header}
      {toolbar}

      {(isLoading || lensUserId === null) && <PageSkeleton />}

      {error && (
        <EmptyState
          icon={GanttChartSquare}
          message="Couldn't load the timeline. The aggregation endpoint may be unavailable."
        />
      )}

      {data && !isLoading && (
        data.spans.length === 0 ? (
          <EmptyState icon={GanttChartSquare} message="No activity in this window for the selected lens." />
        ) : (
          <div className="space-y-3">
            <Legend data={data} colorMode={colorMode} />
            <div className="rounded-lg border border-border bg-card">
              <WorkTimelineChart data={data} zoom={zoom} colorMode={colorMode} />
            </div>
            <p className="text-xs text-muted-foreground">
              {data.spans.length} run{data.spans.length === 1 ? "" : "s"} ·{" "}
              {new Date(data.window.from).toLocaleString()} → {new Date(data.window.to).toLocaleString()}
              {data.window.capped ? " · window capped" : ""}
            </p>
          </div>
        )
      )}
    </div>
  );
}

/** Purple hexagon chip mirroring the routine badge drawn on routine-fired bars. */
function RoutineLegendChip() {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="inline-block h-3 w-3"
        style={{
          backgroundColor: "hsl(265 52% 60%)",
          clipPath: "polygon(100% 50%, 75% 93%, 25% 93%, 0% 50%, 25% 7%, 75% 7%)",
        }}
      />
      routine-fired
    </span>
  );
}

function Legend({ data, colorMode }: { data: WorkTimelineResult; colorMode: ColorMode }) {
  if (colorMode === "status") {
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-4 border border-foreground bg-card" /> done
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-3 w-4 border border-foreground"
            style={{ background: "repeating-linear-gradient(90deg, var(--color-foreground) 0 2px, transparent 2px 5px)" }}
          />{" "}
          in&nbsp;progress
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-3 w-4 border border-foreground"
            style={{ background: "repeating-linear-gradient(45deg, var(--color-foreground) 0 2px, transparent 2px 6px)" }}
          />{" "}
          changes/blocked
        </span>
        <RoutineLegendChip />
      </div>
    );
  }
  const issues = Array.from(
    new Map(data.spans.map((s) => [s.issueId, s.issueIdentifier ?? s.issueTitle ?? "task"])).entries(),
  );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
      {issues.slice(0, 12).map(([id, label]) => (
        <span key={id} className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-4 border border-foreground" style={{ borderLeft: `4px solid ${issueColor(id)}` }} />
          {label}
        </span>
      ))}
      {issues.length > 12 && <span>+{issues.length - 12} more</span>}
      <RoutineLegendChip />
    </div>
  );
}
