import { Field } from "./ui";
import { InfoTip } from "./StepFlow";

/**
 * An operator's e-mail (their sign-in name). Editable only for an owner; the
 * API checks the role again (403 owner_only).
 */
export function EmailField({ value, onChange, editable, error, changed }: {
  value: string;
  onChange: (value: string) => void;
  editable: boolean;
  error?: string;
  changed?: boolean;
}) {
  return (
    <Field
      label={<>Email{!editable && <> <InfoTip label="About the email">Only an owner can change the email.</InfoTip></>}</>}
      error={error}
      changed={changed}
    >
      <input className="input" type="email" value={value} onChange={(e) => onChange(e.target.value)}
             disabled={!editable} autoComplete="off" maxLength={254} />
    </Field>
  );
}
