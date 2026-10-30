import { FormEvent, ReactNode, useEffect, useState } from "react";
import { api } from "../api";
import type { SiteDeploy, SiteHosting, SiteStatus, Tenant } from "../types";
import { Card, ErrorNotice, Field, Notice, Printing, Status, fmtDate, useAction, useLoad } from "./ui";
import { CheckMark, SaveButton, useDirty } from "./save";

const ENV_LABEL: Record<string, string> = { dev: "Dev", prod: "Production" };

/** The restaurant's own site repo site-<slug>: born in the PROD console's
 * onboarding (Retry here), deployed from dev (dev account) and main (prod).
 * Each environment's site is live on its slug address; the restaurant's own
 * domain is mounted per environment once it is verified (Hosting). The dev console only shows it (read-only) or, for
 * a customer prod hasn't created, a dry run; test-* slugs are the exception
 * for testing the automation. Everything goes through the site-repo function;
 * no token is ever shown or stored here. */
export default function WebsiteTab({ tenant }: { tenant: Tenant }) {
  const { data, error, loading, reload } = useLoad(() => api.site(tenant.tenantId), [tenant.tenantId]);
  const creating = data?.enabled && data.status === "creating";
  useEffect(() => {
    if (!creating) return;
    const id = window.setInterval(() => void reload(), 4000);
    return () => window.clearInterval(id);
  }, [creating, reload]);

  if (loading && !data) return <Printing />;
  if (!data) return <ErrorNotice error={error ?? "Not found"} />;
  if (!data.enabled) {
    return (
      <Notice kind="info">
        Site repos aren't switched on in this environment yet: the "Booqy Sites" GitHub App key has to be stored first
        (CUSTOMER-SITE-RUNBOOK.md). Until then the restaurant uses the shared site.
      </Notice>
    );
  }
  const readOnly = data.environment === "dev" && !data.repo.startsWith("site-test-");
  return (
    <div className="stack">
      <ErrorNotice error={error} />
      <Repo site={data} tenant={tenant} readOnly={readOnly} onChanged={reload} />
      {data.hosting && data.status !== "simulated" && <Hosting site={data} tenant={tenant} onChanged={reload} />}
      {data.repoExists && !data.archived && (
        <>
          <Local site={data} />
          {!readOnly && <Access site={data} tenant={tenant} />}
          {!readOnly && <Archive site={data} tenant={tenant} onChanged={reload} />}
        </>
      )}
    </div>
  );
}

function Repo({ site, tenant, readOnly, onChanged }: { site: SiteStatus; tenant: Tenant; readOnly: boolean; onChanged: () => void }) {
  const retry = useAction();
  const redeploy = useAction();
  const [started, setStarted] = useState(false);
  const canRetry = !readOnly && ["active", "suspended"].includes(tenant.status) && site.status !== "creating";
  const branch = site.environment === "prod" ? "main" : "dev";
  return (
    <Card title="Website repo" actions={
      <div className="row-actions">
        {site.repoUrl && <a className="btn btn--small" href={site.repoUrl} target="_blank" rel="noreferrer">Open repo</a>}
      </div>}>
      {site.status === "simulated" && (
        <Notice kind="info">
          <strong>Dry run.</strong> Site repos are born in the production console, so nothing was created here. Creating
          this customer in production (same slug) creates the repo and sets up this dev side:
          <ul className="plain-list">{(site.plan ?? []).map((line) => <li key={line}>{line}</li>)}</ul>
        </Notice>
      )}
      {readOnly && site.status !== "simulated" && (
        <Notice kind="info">Managed from the production console. This is the repo's dev side: pushes to <span className="mono">dev</span> deploy here.</Notice>
      )}
      {site.status === "failed" && <Notice kind="error"><strong>Setup failed.</strong> {site.lastError}</Notice>}
      {site.status === "creating" && <Notice kind="info">Setting up the repo, its deploy role and the first deploy… this updates by itself.</Notice>}
      {site.status === "none" && <Notice kind="info">No site repo yet: this customer was created before site repos were switched on. <strong>Set up</strong> creates it.</Notice>}
      {site.archived && <Notice kind="warn">The repo is archived (read-only). <strong>Set up</strong> brings it back for this environment.</Notice>}
      <dl className="dl">
        <dt>Repo</dt>
        <dd className="mono">{site.repoUrl ? <a href={site.repoUrl} target="_blank" rel="noreferrer">{site.org}/{site.repo}</a> : `${site.org}/${site.repo}`}</dd>
        <dt>Status</dt><dd><Status value={site.archived ? "archived" : site.status} /></dd>
        <dt>Created</dt><dd>{site.createdAt ? fmtDate(site.createdAt) : <span className="muted">-</span>}</dd>
      </dl>
      {site.deploys && (
        <div className="table-wrap">
          <table className="table table--stack">
            <thead><tr><th>Environment</th><th>Last deploy</th><th>Version</th><th>By</th></tr></thead>
            <tbody>
              {(["dev", "prod"] as const).map((env) => <DeployRow key={env} env={env} run={site.deploys![env]} />)}
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
        {!readOnly && site.repoExists && !site.archived && (
          <SaveButton kind="plain" small type="button" busy={redeploy.busy} busyLabel="Starting…" done={redeploy.done} doneLabel="Deploy started"
                      label={`Redeploy ${branch}`}
                      onClick={async () => { if (await redeploy.run(() => api.redeploySite(tenant.tenantId))) setStarted(true); }} />
        )}
        {started && <span className="small muted">Deploy started - it shows above within a minute (Refresh).</span>}
      </div>
      <ErrorNotice error={retry.error ?? redeploy.error} />
    </Card>
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
        <table className="table table--stack">
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

function HostingRow({ env, h, manage, busy, done, onMount }: { env: "dev" | "prod"; h: SiteHosting; manage: boolean; busy: boolean; done: boolean; onMount: () => void }) {
  const label = (text: string) => <span className="stack-label">{text}: </span>;
  const status = h.state === "attaching" && h.status ? h.status : h.state;
  return (
    <tr>
      <td className="strong">{ENV_LABEL[env]}</td>
      <td>{label("Slug address")}{h.slugUrl
        ? <a href={h.slugUrl} target="_blank" rel="noreferrer">{h.slugUrl.replace(/^https:\/\//, "")}</a>
        : <span className="muted">not made yet (Domains tab: Re-run setup)</span>}</td>
      <td>
        {label("Own domain")}<Status value={status} />
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

function DeployRow({ env, run }: { env: "dev" | "prod"; run: SiteDeploy | null }) {
  const label = (text: string) => <span className="stack-label">{text}: </span>;
  if (!run) {
    return <tr><td className="strong">{ENV_LABEL[env]}</td><td className="muted" colSpan={3}>{label("Last deploy")}Not deployed yet</td></tr>;
  }
  const state = run.status === "completed" ? (run.conclusion === "success" ? "live" : run.conclusion === "cancelled" || run.conclusion === "skipped" ? run.conclusion : "failed") : "deploying";
  return (
    <tr>
      <td className="strong">{ENV_LABEL[env]}</td>
      <td>{label("Last deploy")}<a href={run.url} target="_blank" rel="noreferrer"><Status value={state} /></a> <span className="small muted">{fmtDate(run.at)}</span></td>
      <td className="mono">{label("Version")}{run.sha}</td>
      <td>{label("By")}{run.by ?? <span className="muted">-</span>}</td>
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
        A developer gets write access to <span className="mono">{site.repo}</span> only, through the Booqy Sites app. They accept the invitation on
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
