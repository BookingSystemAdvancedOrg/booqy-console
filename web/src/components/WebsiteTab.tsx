import { FormEvent, ReactNode, useEffect, useState } from "react";
import { api } from "../api";
import type { SiteDeploy, SiteHosting, SiteStatus, Tenant } from "../types";
import { Card, ErrorNotice, Field, Notice, Status, fmtDate, useAction, useLoad } from "./ui";
import { CheckMark, SaveButton, useDirty } from "./save";
import { SkelCard, SkelPage } from "./Skeleton";
import { Slot } from "../slots";
import { InfoTip } from "./InfoTip";

const ENV_LABEL: Record<string, string> = { dev: "Dev", prod: "Production", main: "Main" };

/** The restaurant's own site repo site-<slug>. A real customer's repo is born
 * in the PROD console's onboarding (Retry here), deployed from dev (dev
 * account) and main (prod); the dev console shows its dev side read-only. A
 * customer created in the DEV console is a test customer (owner 2026-11-15):
 * its repo is in BooqyCustomersDev and both branches deploy to the dev
 * account's test sites, main to <slug>.test.booqy.se and dev to
 * <slug>.test-dev.booqy.se. Everything goes through the site-repo function;
 * no token is ever shown or stored here. */
export default function WebsiteTab({ tenant }: { tenant: Tenant }) {
  const { data, error, loading, reload } = useLoad(() => api.site(tenant.tenantId), [tenant.tenantId]);
  const creating = data?.enabled && data.status === "creating";
  useEffect(() => {
    if (!creating) return;
    const id = window.setInterval(() => void reload(), 4000);
    return () => window.clearInterval(id);
  }, [creating, reload]);

  if (loading && !data) return (
    <SkelPage label="Loading the website">
      <SkelCard lines={5} />
      <SkelCard rows={3} cols={3} />
    </SkelPage>
  );
  if (!data) return <ErrorNotice error={error ?? "Not found"} />;
  const builder = <Slot id="tenant.website.siteBuilder" features={tenant.entitlements?.features} props={{ tenantId: tenant.tenantId }} />;
  if (!data.enabled) {
    return (
      <>
      <Notice kind="info">
        Site repos aren't switched on in this environment yet: this environment's GitHub App key has to be stored first
        (CUSTOMER-SITE-RUNBOOK.md). Until then the restaurant uses the shared site.
      </Notice>
      {builder}
      </>
    );
  }
  const test = data.kind === "test";
  const readOnly = data.environment === "dev" && !test;
  return (
    <div className="stack">
      <ErrorNotice error={error} />
      <Repo site={data} tenant={tenant} readOnly={readOnly} onChanged={reload} />
      {data.hosting && data.status !== "legacy" && (test ? <TestHosting site={data} /> : <Hosting site={data} tenant={tenant} onChanged={reload} />)}
      {data.repoExists && !data.archived && (
        <>
          <Local site={data} />
          {!readOnly && <Access site={data} tenant={tenant} />}
          {!readOnly && <Archive site={data} tenant={tenant} onChanged={reload} />}
        </>
      )}
      {builder}
    </div>
  );
}

function Repo({ site, tenant, readOnly, onChanged }: { site: SiteStatus; tenant: Tenant; readOnly: boolean; onChanged: () => void }) {
  const retry = useAction();
  // One action per branch: a test customer has a button for each.
  const redeploy = { main: useAction(), dev: useAction() };
  const [started, setStarted] = useState(false);
  const test = site.kind === "test";
  const canRetry = !readOnly && ["active", "suspended"].includes(tenant.status) && site.status !== "creating";
  // A test customer deploys both branches here; a real site this environment's.
  const branches: ("dev" | "main")[] = test ? ["main", "dev"] : [site.environment === "prod" ? "main" : "dev"];
  const deployRows: ("dev" | "prod" | "main")[] = test ? ["main", "dev"] : ["dev", "prod"];
  return (
    <Card title="Website repo" actions={
      <div className="row-actions">
        {site.repoUrl && <a className="btn btn--small" href={site.repoUrl} target="_blank" rel="noreferrer">Open repo</a>}
      </div>}>
      {site.status === "legacy" && (
        <Notice kind="info"><strong>Legacy dev customer.</strong> {site.lastError}</Notice>
      )}
      {readOnly && site.status !== "legacy" && (
        <Notice kind="info">Managed from the production console (setup, deploys, access). This is the repo's dev side: pushes to <span className="mono">dev</span> deploy here.</Notice>
      )}
      {site.status === "failed" && <Notice kind="error"><strong>Setup failed.</strong> {site.lastError}</Notice>}
      {site.status === "creating" && <Notice kind="info">Setting up the repo and the first deploy…</Notice>}
      {site.status === "none" && !readOnly && <Notice kind="info">No site repo yet: this customer was created before site repos were switched on. <strong>Set up</strong> creates it.</Notice>}
      {site.archived && <Notice kind="warn">The repo is archived (read-only). <strong>Set up</strong> brings it back for this environment.</Notice>}
      <dl className="dl">
        <dt>Repo</dt>
        <dd className="mono">{site.repoUrl ? <a href={site.repoUrl} target="_blank" rel="noreferrer">{site.org}/{site.repo}</a> : `${site.org}/${site.repo}`}</dd>
        <dt>Status</dt><dd><Status value={site.archived ? "archived" : site.status} /></dd>
        {test && <><dt>Kind</dt><dd>Test customer <InfoTip label="Test customer">Created in the dev console. Both branches deploy to the dev account's test sites (never indexed); domains are mapped onto them, never bought.</InfoTip></dd></>}
        <dt>Created</dt><dd>{site.createdAt ? fmtDate(site.createdAt) : <span className="muted">-</span>}</dd>
      </dl>
      {site.deploys && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Environment</th><th>Last deploy</th><th>Version</th><th>By</th></tr></thead>
            <tbody>
              {deployRows.map((env) => <DeployRow key={env} env={env} run={site.deploys![env] ?? null}
                                                    target={test ? site.urls?.[env as "main" | "dev"] : undefined} />)}
            </tbody>
          </table>
        </div>
      )}
      <div className="row">
        {canRetry && (
          <SaveButton kind="plain" small type="button" busy={retry.busy} busyLabel="Starting…" done={retry.done} doneLabel="Started"
                      label={site.status === "ready" ? "Run setup again" : site.status === "failed" ? "Retry" : "Set up"}
                      onClick={async () => { if (await retry.run(() => api.retrySite(tenant.tenantId))) onChanged(); }} />
        )}
        {!readOnly && site.repoExists && !site.archived && branches.map((branch) => (
          <RedeployButton key={branch} branch={branch} redeploy={redeploy[branch]}
                          onClick={async () => {
                            const call = () => test ? api.redeploySite(tenant.tenantId, branch) : api.redeploySite(tenant.tenantId);
                            if (await redeploy[branch].run(call)) setStarted(true);
                          }} />
        ))}
        {started && <span className="small muted">Deploy started - it shows above within a minute (Refresh).</span>}
      </div>
      <ErrorNotice error={retry.error ?? redeploy.main.error ?? redeploy.dev.error} />
    </Card>
  );
}

function RedeployButton({ branch, redeploy, onClick }: {
  branch: string; redeploy: { busy: boolean; done: boolean }; onClick: () => void;
}) {
  return (
    <SaveButton kind="plain" small type="button" busy={redeploy.busy} busyLabel="Starting…" done={redeploy.done} doneLabel="Deploy started"
                label={`Redeploy ${branch}`} onClick={onClick} />
  );
}

const DOMAIN_STEP: Record<"dev" | "prod", string> = { prod: "www.<domain>", dev: "dev.<domain>" };

/** Where each environment's site answers: always its slug address
 * (<slug>.booqy.se, <slug>.dev.booqy.se), and the restaurant's own domain
 * once it is mounted there. One hostname can be on only one CloudFront
 * distribution, so dev gets dev.<domain>. */
function Hosting({ site, tenant, onChanged }: { site: SiteStatus; tenant: Tenant; onChanged: () => void }) {
  const mount = useAction();
  const envs = (["dev", "prod"] as const).filter((env) => site.hosting?.[env]);
  const manage = site.environment === "prod";
  const dev = site.hosting?.dev;
  const cnameNeeded = manage && dev?.host && !dev.dnsByBooqy && (dev.state === "not_mounted" || dev.state === "attaching" || dev.state === "failed");
  return (
    <Card title="Where the site answers">
      <p className="small muted">
        Every site is live on its slug address from the first deploy; an own domain is never needed for that. Once the
        restaurant's own domain is live (Domains tab), mount it per environment: production on {DOMAIN_STEP.prod}, dev
        on {DOMAIN_STEP.dev} (one hostname can be on only one CloudFront distribution). The slug address keeps working.
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Environment</th><th>Slug address</th><th>Own domain</th><th><span className="sr-only">Action</span></th></tr></thead>
          <tbody>
            {envs.map((env) => (
              <HostingRow key={env} env={env} h={site.hosting![env]!} manage={manage} busy={mount.busy} done={mount.done}
                          onMount={async () => { if (await mount.run(() => api.mountSiteDomain(tenant.tenantId, env))) onChanged(); }} />
            ))}
          </tbody>
        </table>
      </div>
      {cnameNeeded && (
        <Notice kind="info">
          <strong>One more DNS record for the restaurant.</strong> They keep their own DNS, so they add
          {" "}<span className="mono">{dev!.host}</span> CNAME <span className="mono">{dev!.cnameTarget || "(dev target)"}</span> at
          their DNS provider. Dev issues its certificate once the record is there; Refresh shows it.
        </Notice>
      )}
      {manage && (
        <Notice kind="warn">
          Production serves the shared customer site on every address until <span className="mono">per_tenant_sites</span> is
          switched on in prod: deploys from <span className="mono">main</span> go live, but show on the addresses only after that switch.
        </Notice>
      )}
      <ErrorNotice error={mount.error} />
    </Card>
  );
}

/** A test customer: its main and dev hosts on the test sites, and the own
 * domain mapped onto them (Domains tab, Add domain). */
function TestHosting({ site }: { site: SiteStatus }) {
  const rows = (["main", "dev"] as const).filter((stage) => site.hosting?.[stage]);
  return (
    <Card title="Where the site answers">
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Branch</th><th>Slug address</th><th>Own domain (test)</th></tr></thead>
          <tbody>
            {rows.map((stage) => {
              const h = site.hosting![stage]!;
              const status = h.state === "attaching" && h.status ? h.status : h.state;
              return (
                <tr key={stage}>
                  <td className="strong mono">{stage}</td>
                  <td data-label="Slug address">{h.slugUrl
                    ? <a href={h.slugUrl} target="_blank" rel="noreferrer">{h.slugUrl.replace(/^https:\/\//, "")}</a>
                    : <span className="muted">-</span>}</td>
                  <td data-label="Own domain (test)">
                    {h.host
                      ? <><Status value={status} /> {h.state === "live"
                          ? <a href={`https://${h.host}`} target="_blank" rel="noreferrer">{h.host}</a>
                          : <span className="mono small">{h.host}</span>}
                          {h.mappedFrom && <div className="small muted">for {h.mappedFrom}</div>}</>
                      : <span className="muted">-</span>}
                    {h.lastError && <div className="small hosting-error">{h.lastError}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function HostingRow({ env, h, manage, busy, done, onMount }: { env: "dev" | "prod"; h: SiteHosting; manage: boolean; busy: boolean; done: boolean; onMount: () => void }) {
  const status = h.state === "attaching" && h.status ? h.status : h.state;
  return (
    <tr>
      <td className="strong">{ENV_LABEL[env]}</td>
      <td data-label="Slug address">{h.slugUrl
        ? <a href={h.slugUrl} target="_blank" rel="noreferrer">{h.slugUrl.replace(/^https:\/\//, "")}</a>
        : <span className="muted">not made yet (Domains tab: Re-run setup)</span>}</td>
      <td data-label="Own domain">
        <Status value={status} />
        {h.host && (h.state === "live"
          ? <> <a href={`https://${h.host}`} target="_blank" rel="noreferrer">{h.host}</a></>
          : <> <span className="mono small">{h.host}</span></>)}
        {h.waitsFor && <div className="small muted">After {h.waitsFor} is live in production</div>}
        {!h.host && !h.waitsFor && h.state === "slug_only" && <div className="small muted">No own domain yet</div>}
        {h.lastError && <div className="small hosting-error">{h.lastError}</div>}
      </td>
      <td>
        {manage && h.canMount && (
          <SaveButton kind="plain" small type="button" busy={busy} busyLabel="Mounting…" done={done} doneLabel="Mounting"
                      label={h.state === "failed" ? "Retry" : `Mount ${h.host ?? DOMAIN_STEP[env]}`} onClick={onMount} />
        )}
      </td>
    </tr>
  );
}

function DeployRow({ env, run, target }: { env: "dev" | "prod" | "main"; run: SiteDeploy | null; target?: string }) {
  const label = target ? <><span className="mono">{env}</span> → {target.replace(/^https:\/\//, "")}</> : ENV_LABEL[env];
  if (!run) {
    return <tr><td className="strong">{label}</td><td className="muted" colSpan={3} data-label="Last deploy">Not deployed yet</td></tr>;
  }
  const state = run.status === "completed" ? (run.conclusion === "success" ? "live" : run.conclusion === "cancelled" || run.conclusion === "skipped" ? run.conclusion : "failed") : "deploying";
  return (
    <tr>
      <td className="strong">{label}</td>
      <td data-label="Last deploy"><a href={run.url} target="_blank" rel="noreferrer"><Status value={state} /></a> <span className="small muted">{fmtDate(run.at)}</span></td>
      <td className="mono" data-label="Version">{run.sha}</td>
      <td data-label="By">{run.by ?? <span className="muted">-</span>}</td>
    </tr>
  );
}

function CopyButton({ text, children = "Copy" }: { text: string; children?: ReactNode }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn btn--small"
            onClick={async () => { await navigator.clipboard.writeText(text); setDone(true); window.setTimeout(() => setDone(false), 1500); }}>
      {done ? <><CheckMark />Copied</> : children}
    </button>
  );
}

function Local({ site }: { site: SiteStatus }) {
  const [shown, setShown] = useState(false);
  const c = site.config;
  const commands = [`git clone git@github.com:${site.org}/${site.repo}.git`, `cd ${site.repo}`, "npm install", "npm run dev"].join("\n");
  const env = [
    `VITE_API_BASE_URL=${c.apiBaseUrl}`,
    ...(site.environment === "prod" ? [] : [`VITE_DEV_TENANT_SLUG=${site.repo.replace(/^site-/, "")}`]),
    `VITE_MENU_IMAGE_BASE_URL=${c.menuImageBaseUrl}`,
  ];
  const keys: [string, string][] = [
    ["Tenant ID", c.tenantId], ["Stripe publishable key", c.stripePublishableKey], ["Turnstile site key", c.turnstileSiteKey],
  ];
  return (
    <Card title="Get started locally">
      <p className="small muted">
        Once per machine: <span className="mono">npm login --scope=@bookingsystemadvancedorg --auth-type=legacy --registry=https://npm.pkg.github.com</span> with
        a GitHub token that has <span className="mono">read:packages</span> (for the kit). Then:
      </p>
      <pre className="code">{commands}</pre>
      <div className="copy"><CopyButton text={commands}>Copy commands</CopyButton></div>
      <p className="small muted">
        <span className="mono">npm run dev</span> needs nothing more: the repo's <span className="mono">booqy.json</span> holds these values.
        Use <span className="mono">.env.local</span> only to point somewhere else. None of them is secret.
      </p>
      {!shown ? (
        <button className="btn btn--small" onClick={() => setShown(true)}>Show .env.local values</button>
      ) : (
        <>
          <pre className="code">{env.join("\n")}</pre>
          <div className="copy"><CopyButton text={env.join("\n") + "\n"}>Copy .env.local</CopyButton>
            <button className="btn btn--small btn--ghost" onClick={() => setShown(false)}>Hide</button></div>
          <dl className="dl">
            {keys.map(([label, value]) => (
              <KeyRow key={label} label={label} value={value} />
            ))}
          </dl>
        </>
      )}
    </Card>
  );
}

function KeyRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className="key-row">
        {value ? <><span className="mono">{value}</span> <CopyButton text={value} /></> : <span className="muted">-</span>}
      </dd>
    </>
  );
}

function Access({ site, tenant }: { site: SiteStatus; tenant: Tenant }) {
  const a = useAction();
  const [username, setUsername] = useState("");
  const [result, setResult] = useState<{ username: string; result: string } | null>(null);
  const dirty = useDirty(username, "");
  async function invite(e: FormEvent) {
    e.preventDefault();
    const r = await a.run(() => api.inviteToSite(tenant.tenantId, username));
    if (r) { setResult(r); setUsername(""); }
  }
  return (
    <Card title="Give access">
      <p className="small muted">
        A developer gets write access to <span className="mono">{site.repo}</span> only, through the Booqy Customer Sites app. They accept the invitation on
        GitHub. Nothing to copy: no tokens are created or shown.
      </p>
      <form className="row" onSubmit={invite}>
        <Field label="GitHub username" error={a.fields.username}>
          <input className="input mono" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="anna-dev" autoComplete="off" />
        </Field>
        <SaveButton label="Invite" busy={a.busy} busyLabel="Inviting…" done={a.done} doneLabel="Invited" dirty={dirty.dirty} disabled={!username.trim()} hint={false} />
      </form>
      {result && (
        <Notice kind="ok">
          {result.result === "invited" ? <>Invitation sent to <strong>@{result.username}</strong>.</> : <><strong>@{result.username}</strong> already has access.</>}
        </Notice>
      )}
      <ErrorNotice error={a.fields.username ? null : a.error} />
    </Card>
  );
}

function Archive({ site, tenant, onChanged }: { site: SiteStatus; tenant: Tenant; onChanged: () => void }) {
  const a = useAction();
  const [confirm, setConfirm] = useState("");
  return (
    <Card title="Archive website repo" tone="danger">
      <p>
        Removes this environment's deploy role and repo variables, so nothing deploys here any more. The repo is archived
        (read-only) once no environment uses it; Delete customer deletes it. <strong>Set up</strong> brings it back. Offboarding does this by itself.
      </p>
      <Field label={`Type the slug "${tenant.slug}" to confirm`} error={a.fields.confirmSlug}>
        <input className="input mono" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </Field>
      <SaveButton kind="danger" type="button" label={`Archive ${site.repo}`} busy={a.busy} busyLabel="Archiving…" done={a.done} doneLabel="Archived"
                  disabled={confirm !== tenant.slug}
                  onClick={async () => { if (await a.run(() => api.archiveSite(tenant.tenantId, confirm))) { setConfirm(""); onChanged(); } }} />
      <ErrorNotice error={a.fields.confirmSlug ? null : a.error} />
    </Card>
  );
}
