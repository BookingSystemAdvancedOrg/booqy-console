import { STORAGE_REGISTRY } from "../storageRegistry";
import { FormEvent, ReactNode, useEffect, useState } from "react";
import { Logo } from "../components/Logo";
import { useNavigate } from "react-router-dom";
import QRCode from "qrcode";
import {
  confirmResetPassword, confirmSignIn, resetPassword, signIn, signOut, type SignInOutput,
} from "aws-amplify/auth";

const ENV = import.meta.env.VITE_ENVIRONMENT ?? "dev";
const PASSWORD_RULES = "At least 14 characters, with upper- and lowercase letters, a number and a symbol.";

// "Forgot your password?" emails a link here (infrastructure:
// compute/lambda/cognito-custom-message): /reset-password#code=123456&email=...
// The code and address sit in the fragment, which never reaches a server;
// the page reads them once and takes them out of the address bar.
export const RESET_PATH = "/reset-password";

export function readResetLink(): { code: string; email: string } | null {
  if (window.location.pathname !== RESET_PATH) return null;
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const code = (params.get("code") ?? "").replace(/\s+/g, "");
  const email = (params.get("email") ?? "").trim().toLowerCase();
  return /^\d{6}$/.test(code) && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? { code, email } : null;
}

type Step =
  | { kind: "signIn" }
  | { kind: "newPassword" }
  | { kind: "totpSetup"; uri: string; secret: string }
  | { kind: "totpCode" }
  | { kind: "forgot" }
  | { kind: "forgotSent" }
  | { kind: "forgotConfirm" }
  | { kind: "linkReset"; code: string };

/** Password reset steps word code errors differently from the TOTP steps. */
function message(e: unknown, reset = false): string {
  const name = (e as { name?: string })?.name;
  switch (name) {
    case "NotAuthorizedException": {
      const text = (e as Error).message;
      if (text.includes("disabled")) return "This account is disabled. Ask another operator to enable it.";
      if (reset && text.includes("current state")) {
        return "This account hasn't been activated yet - sign in with the temporary password from your "
          + "invitation, or ask another operator to resend it (Operators).";
      }
      return reset ? "This reset doesn't work for the account. Request a new link, or sign in." : "Wrong email or password.";
    }
    case "CodeMismatchException":
      return reset
        ? "This link or code doesn't work anymore - it may have been used, or replaced by a newer one. Request a new link."
        : "That code is wrong or has expired. Try the newest code from your app.";
    case "InvalidPasswordException":
      return `The password doesn't meet the rules. ${PASSWORD_RULES}`;
    case "LimitExceededException":
    case "TooManyRequestsException":
    case "TooManyFailedAttemptsException":
      return "Too many attempts. Wait a few minutes and try again.";
    case "ExpiredCodeException":
      return reset
        ? "The link has expired (it works for one hour). Request a new one."
        : "The code has expired. Request a new one.";
    default:
      return e instanceof Error ? e.message : String(e);
  }
}

export default function LoginPage({ onSignedIn }: { onSignedIn: () => void }) {
  const navigate = useNavigate();
  // Read once, before the effect below clears the fragment.
  const [link] = useState(readResetLink);
  const [step, setStep] = useState<Step>(() =>
    link ? { kind: "linkReset", code: link.code }
      : window.location.pathname === RESET_PATH ? { kind: "forgot" }
      : { kind: "signIn" });
  const [email, setEmail] = useState(link?.email ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    () => (!link && window.location.pathname === RESET_PATH
      ? "This reset link is incomplete. Enter your email to get a new one." : null));
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    if (window.location.pathname === RESET_PATH && window.location.hash) {
      navigate(RESET_PATH, { replace: true });
    }
  }, [navigate]);

  async function run(fn: () => Promise<void>, reset = false) {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await fn();
    } catch (e) {
      setError(message(e, reset));
    } finally {
      setBusy(false);
    }
  }

  /** After a reset: signed out in this browser, on to sign in. The page
   * stays where it is (on /reset-password the shell keeps showing it) until
   * the sign-in is done. */
  async function passwordChanged() {
    await signOut().catch(() => undefined);
    setStep({ kind: "signIn" });
    setInfo("Password changed. Sign in with your new password and your authenticator code.");
  }

  async function next(out: SignInOutput) {
    const s = out.nextStep.signInStep;
    switch (s) {
      case "DONE":
        if (window.location.pathname === RESET_PATH) navigate("/", { replace: true });
        onSignedIn();
        return;
      case "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED":
        setStep({ kind: "newPassword" });
        return;
      case "CONTINUE_SIGN_IN_WITH_TOTP_SETUP": {
        const details = out.nextStep.totpSetupDetails;
        setStep({ kind: "totpSetup", uri: details.getSetupUri(`Booqy Console (${ENV})`, email).toString(),
                  secret: details.sharedSecret });
        return;
      }
      case "CONTINUE_SIGN_IN_WITH_MFA_SELECTION":
      case "CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION":
        // The pool only offers authenticator apps.
        await next(await confirmSignIn({ challengeResponse: "TOTP" }));
        return;
      case "CONFIRM_SIGN_IN_WITH_TOTP_CODE":
        setStep({ kind: "totpCode" });
        return;
      case "RESET_PASSWORD":
        await resetPassword({ username: email.trim().toLowerCase() });
        setStep({ kind: "forgotSent" });
        setInfo("Your password must be reset. We've emailed you a link to choose a new one.");
        return;
      default:
        throw new Error(`Unsupported sign-in step: ${s}`);
    }
  }

  const back = () => {
    setError(null);
    setInfo(null);
    setStep({ kind: "signIn" });
    if (window.location.pathname === RESET_PATH) navigate("/", { replace: true });
  };

  return (
    <div className="auth">
      <aside className="auth__brand">
        <div className="brand auth__logo"><Logo className="brand__logo" /><span className="brand__app">Console</span></div>
        <div>
          <p className="auth__lead">The operator console for every restaurant on the platform.</p>
          <p className="auth__sub">Customers, plans, domains and payments - in one place.</p>
        </div>
        <span className={`env env--${ENV}`}>{ENV}</span>
      </aside>

      <main className="auth__main">
        <div className="auth__card">
          {step.kind === "signIn" && (
            <Form title="Sign in" lead="Use your operator account." error={error} info={info}
                  onSubmit={(pw) => run(async () => {
                    try {
                      await next(await signIn({ username: email.trim().toLowerCase(), password: pw.password }));
                    } catch (e) {
                      if ((e as { name?: string })?.name === "UserAlreadyAuthenticatedException") {
                        await signOut();
                        await next(await signIn({ username: email.trim().toLowerCase(), password: pw.password }));
                      } else throw e;
                    }
                  })}
                  busy={busy} submit="Sign in"
                  footer={<button type="button" className="link" onClick={() => { setError(null); setStep({ kind: "forgot" }); }}>
                    Forgot your password?</button>}>
              <Input label="Email" name="email" type="email" autoComplete="username" value={email} onChange={setEmail} autoFocus />
              <Input label="Password" name="password" type="password" autoComplete="current-password" />
            </Form>
          )}

          {step.kind === "newPassword" && (
            <Form title="Choose your password" lead={`First sign-in: replace the temporary password. ${PASSWORD_RULES}`}
                  error={error} busy={busy} submit="Save password"
                  onSubmit={(v) => run(async () => {
                    if (v.password !== v.confirm) throw new Error("The passwords don't match.");
                    await next(await confirmSignIn({ challengeResponse: v.password }));
                  })}>
              <Input label="New password" name="password" type="password" autoComplete="new-password" autoFocus />
              <Input label="Repeat new password" name="confirm" type="password" autoComplete="new-password" />
            </Form>
          )}

          {step.kind === "totpSetup" && (
            <Form title="Set up two-step sign-in" error={error} busy={busy} submit="Verify and sign in"
                  lead="Scan the code with an authenticator app (Google Authenticator, 1Password, Microsoft Authenticator…), then enter the 6-digit code it shows."
                  onSubmit={(v) => run(async () => next(await confirmSignIn({ challengeResponse: v.code.trim() })))}>
              <Qr uri={step.uri} />
              <details className="auth__secret">
                <summary>Can't scan? Enter this key instead</summary>
                <code className="mono">{step.secret}</code>
              </details>
              <Input label="6-digit code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" autoFocus />
            </Form>
          )}

          {step.kind === "totpCode" && (
            <Form title="Enter your code" lead="Open your authenticator app and enter the 6-digit code for Booqy Console."
                  error={error} busy={busy} submit="Sign in"
                  onSubmit={(v) => run(async () => next(await confirmSignIn({ challengeResponse: v.code.trim() })))}
                  footer={<button type="button" className="link" onClick={back}>Back</button>}>
              <Input label="6-digit code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" autoFocus />
            </Form>
          )}

          {step.kind === "forgot" && (
            <Form title="Reset your password" lead="We'll email you a link to choose a new password."
                  error={error} busy={busy} submit="Send link"
                  onSubmit={() => run(async () => {
                    await resetPassword({ username: email.trim().toLowerCase() });
                    setStep({ kind: "forgotSent" });
                  }, true)}
                  footer={<button type="button" className="link" onClick={back}>Back to sign in</button>}>
              <Input label="Email" name="email" type="email" autoComplete="username" value={email} onChange={setEmail} autoFocus />
            </Form>
          )}

          {step.kind === "forgotSent" && (
            <div className="auth__form">
              <h1>Check your email</h1>
              {info && <div className="notice notice--ok" role="status">{info}</div>}
              <p className="muted auth__lead-text">
                If <strong>{email.trim().toLowerCase()}</strong> has an operator account, we've sent a link to
                choose a new password. It works once and for one hour.
              </p>
              <div className="auth__links">
                <button type="button" className="link" onClick={() => { setInfo(null); setStep({ kind: "forgotConfirm" }); }}>
                  Got a code instead? Enter it</button>
                {" · "}
                <button type="button" className="link" onClick={() => { setInfo(null); setStep({ kind: "forgot" }); }}>
                  Send again</button>
                {" · "}
                <button type="button" className="link" onClick={back}>Back to sign in</button>
              </div>
            </div>
          )}

          {step.kind === "forgotConfirm" && (
            <Form title="Choose a new password" lead={PASSWORD_RULES} error={error} info={info} busy={busy}
                  submit="Save new password"
                  onSubmit={(v) => run(async () => {
                    if (v.password !== v.confirm) throw new Error("The passwords don't match.");
                    await confirmResetPassword({ username: email.trim().toLowerCase(), confirmationCode: v.code.replace(/\s+/g, ""),
                                                 newPassword: v.password });
                    await passwordChanged();
                  }, true)}
                  footer={<button type="button" className="link" onClick={back}>Back to sign in</button>}>
              <Input label="Code from the email" name="code" inputMode="numeric" autoComplete="one-time-code" autoFocus />
              <Input label="New password" name="password" type="password" autoComplete="new-password" />
              <Input label="Repeat new password" name="confirm" type="password" autoComplete="new-password" />
            </Form>
          )}

          {step.kind === "linkReset" && (
            <Form title="Choose a new password" lead={`For ${email}. ${PASSWORD_RULES}`} error={error} busy={busy}
                  submit="Save new password"
                  onSubmit={(v) => run(async () => {
                    if (v.password !== v.confirm) throw new Error("The passwords don't match.");
                    await confirmResetPassword({ username: email, confirmationCode: step.code, newPassword: v.password });
                    await passwordChanged();
                  }, true)}
                  footer={<>
                    <button type="button" className="link" onClick={() => { setError(null); setStep({ kind: "forgot" }); }}>
                      Request a new link</button>
                    {" · "}
                    <button type="button" className="link" onClick={back}>Back to sign in</button>
                  </>}>
              <Input label="New password" name="password" type="password" autoComplete="new-password" autoFocus />
              <Input label="Repeat new password" name="confirm" type="password" autoComplete="new-password" />
            </Form>
          )}
        </div>
        <p className="auth__foot">Restricted to platform operators. Every action is logged.</p>
        <details className="auth__storage">
          <summary>Cookies and storage</summary>
          <p>No cookies, no analytics. The Console keeps only your sign-in, for this tab:</p>
          <ul>
            {STORAGE_REGISTRY.map((e) => (
              <li key={e.name}>
                <code>{e.name}</code> ({e.kind}): {e.purpose} {e.lifetime}.
              </li>
            ))}
          </ul>
        </details>
      </main>
    </div>
  );
}

function Form(props: {
  title: string;
  lead?: string;
  error: string | null;
  info?: string | null;
  busy: boolean;
  submit: string;
  onSubmit: (values: Record<string, string>) => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const handle = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const values = Object.fromEntries(
      [...new FormData(e.currentTarget).entries()].map(([k, v]) => [k, String(v)]),
    );
    props.onSubmit(values);
  };
  return (
    <form className="auth__form" onSubmit={handle} noValidate={false}>
      <h1>{props.title}</h1>
      {props.lead && <p className="muted auth__lead-text">{props.lead}</p>}
      {props.info && <div className="notice notice--ok" role="status">{props.info}</div>}
      {props.error && <div className="notice notice--error" role="alert">{props.error}</div>}
      {props.children}
      <button className="btn btn--primary auth__submit" disabled={props.busy}>
        {props.busy ? "Please wait…" : props.submit}
      </button>
      {props.footer && <div className="auth__links">{props.footer}</div>}
    </form>
  );
}

function Input(props: {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  inputMode?: "numeric";
  pattern?: string;
  value?: string;
  onChange?: (v: string) => void;
}) {
  const { label, onChange, value, ...rest } = props;
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <input className="input" required {...rest}
             {...(onChange ? { value, onChange: (e) => onChange(e.target.value) } : {})} />
    </label>
  );
}

function Qr({ uri }: { uri: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(uri, { margin: 1, width: 200, color: { dark: "#1d2420", light: "#fffdf8" } }).then(setSrc);
  }, [uri]);
  return <div className="auth__qr">{src ? <img src={src} alt="QR code for your authenticator app" /> : "…"}</div>;
}
