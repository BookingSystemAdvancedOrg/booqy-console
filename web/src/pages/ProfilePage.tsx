import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import type { Operator } from "../auth";
import { AvatarSetting } from "../components/AvatarSetting";
import { EmailField } from "../components/EmailField";
import { SaveButton, useDirty } from "../components/save";
import { SkelCard, SkelPage } from "../components/Skeleton";
import { InfoTip } from "../components/StepFlow";
import { ErrorNotice, Field, Notice, useAction, useLoad } from "../components/ui";

/**
 * My profile: the signed-in operator's picture, name and e-mail. The e-mail
 * is the sign-in name; only an owner can change it (any operator's, see
 * Operators), everyone else sees it read only.
 */
export default function ProfilePage({ me, onSaved }: { me: Operator; onSaved: () => Promise<void> }) {
  const { data, error, loading, reload } = useLoad(() => api.operators());
  const mine = data?.operators.find((o) => o.username === me.username);
  const savedName = mine?.name ?? me.name;
  const savedEmail = mine?.email ?? me.email;
  const canChangeEmail = data?.canChangeEmail === true;
  const [name, setName] = useState(savedName);
  const [email, setEmail] = useState(savedEmail);
  const [done, setDone] = useState(false);
  // Once the list arrives (or after a save), the fields start from what is stored.
  useEffect(() => { setName(savedName); setEmail(savedEmail); }, [savedName, savedEmail]);
  const a = useAction();
  // An emptied name is not a change: the API keeps the stored one.
  const nameDirty = useDirty(name.trim() || savedName, savedName);
  const emailDirty = useDirty(email.trim().toLowerCase(), savedEmail.toLowerCase());
  const dirty = nameDirty.dirty || (canChangeEmail && emailDirty.dirty);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setDone(false);
    const patch = { name: name.trim(), ...(canChangeEmail && emailDirty.dirty ? { email: email.trim() } : {}) };
    if (await a.run(() => api.updateOperator(me.username, patch))) {
      await Promise.all([reload(), onSaved()]);
      setDone(true);
    }
  };

  return (
    <>
      <div className="page-head">
        <div><h1>My profile</h1></div>
      </div>
      <section className="card" data-help="profile:picture">
        <div className="card__head"><h2>Picture</h2></div>
        <div className="card__body">
          <AvatarSetting name={name.trim() || savedName} email={savedEmail} />
        </div>
      </section>
      {loading && !data ? <SkelPage label="Loading your profile"><SkelCard /></SkelPage> : (
        <section className="card" data-help="profile:details">
          <div className="card__head"><h2>Details</h2></div>
          <div className="card__body">
            <ErrorNotice error={error} />
            {done && <Notice kind="ok">Saved.</Notice>}
            <form onSubmit={submit} className="stack profile-form">
              <ErrorNotice error={a.error && !Object.keys(a.fields).length ? a.error : null} />
              <Field label="Name" required changed={nameDirty.dirty} error={a.fields.name}>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={100}
                       autoComplete="name" placeholder={savedName ? undefined : "Add a name"} />
              </Field>
              <EmailField value={email} onChange={setEmail} editable={canChangeEmail}
                          changed={canChangeEmail && emailDirty.dirty} error={a.fields.email} />
              <div className="profile-role">
                <span className="field__label">
                  Role{" "}
                  <InfoTip label="About roles">
                    An owner can change any operator's email and is the only one who can disable or delete an owner.
                  </InfoTip>
                </span>
                <span className={`tag${mine?.role === "owner" ? " tag--owner" : ""}`}>{mine?.role === "owner" ? "Owner" : "Operator"}</span>
              </div>
              <div className="row">
                <SaveButton label="Save" busy={a.busy} dirty={dirty} />
              </div>
            </form>
          </div>
        </section>
      )}
    </>
  );
}
