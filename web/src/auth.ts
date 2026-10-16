// Operator sign-in, inside the app (pages/LoginPage.tsx). Amplify talks to the
// OPERATOR user pool directly with SRP - the password never leaves the
// browser in plain form - and handles the pool's challenges: first-login
// password change, TOTP MFA setup and TOTP codes. Tokens live in
// sessionStorage (gone when the tab closes); the refresh token lasts 8 h.
//
// The API takes the ACCESS token. Authorization = token from this pool for
// this app client (API Gateway) + member of platform_admin (the Lambda).
import { Amplify } from "aws-amplify";
import { fetchAuthSession, signOut as amplifySignOut } from "aws-amplify/auth";
import { cognitoUserPoolsTokenProvider } from "aws-amplify/auth/cognito";
import { Hub, sessionStorage } from "aws-amplify/utils";

// VITE_COGNITO_AUTHORITY is https://cognito-idp.<region>.amazonaws.com/<poolId>
const userPoolId = import.meta.env.VITE_COGNITO_AUTHORITY.replace(/\/$/, "").split("/").pop()!;

Amplify.configure({
  Auth: { Cognito: { userPoolId, userPoolClientId: import.meta.env.VITE_COGNITO_CLIENT_ID } },
});
cognitoUserPoolsTokenProvider.setKeyValueStorage(sessionStorage);

export interface Operator {
  username: string;
  email: string;
}

/** The signed-in operator, or null. Refreshes expired tokens on the way. */
export async function currentOperator(): Promise<Operator | null> {
  try {
    const { tokens } = await fetchAuthSession();
    if (!tokens?.accessToken || !tokens.idToken) return null;
    return {
      username: String(tokens.accessToken.payload.username ?? ""),
      email: String(tokens.idToken.payload.email ?? ""),
    };
  } catch {
    return null;
  }
}

export async function accessToken(): Promise<string> {
  const { tokens } = await fetchAuthSession();
  if (!tokens?.accessToken) {
    notifySignedOut();
    throw new Error("Signed out");
  }
  return tokens.accessToken.toString();
}

export async function signOut(): Promise<void> {
  try {
    // global: also revokes the refresh token server-side
    await amplifySignOut({ global: true });
  } catch {
    await amplifySignOut();
  }
}

/** Shell listens to this to show the login page. */
export function notifySignedOut() {
  Hub.dispatch("booqy", { event: "signedOut" });
}

export function onAuthChange(cb: () => void): () => void {
  const a = Hub.listen("auth", cb);
  const b = Hub.listen("booqy", cb);
  return () => {
    a();
    b();
  };
}
