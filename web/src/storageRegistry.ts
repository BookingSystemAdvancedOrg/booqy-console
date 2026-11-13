// Everything Booqy Console stores in the browser, in one place.
//
// The login page shows this list (LoginPage.tsx), so what operators are told
// can't drift from what the app does. No consent banner: all of it is
// strictly necessary to sign in and use the app (the exemption in the
// Swedish Electronic Communications Act, LEK 9 kap. 28 §). Add anything
// for analytics or marketing and that has to be revisited first.
//
// Tokens live in localStorage (Amplify, auth.ts): readable by script on
// this page, which is why the Console's CloudFront sends a strict CSP
// (infrastructure network/cloudfront/platform-admin). A cookie-based
// session would need a backend in front of the operator pool's SRP + MFA
// login; with a handful of operators that is a documented, accepted risk.

export interface StorageEntry {
  name: string;
  kind: "sessionStorage" | "localStorage" | "cookie";
  purpose: string;
  lifetime: string;
}

export const THEME_KEY = "booqy-theme";
export const SOUND_KEY = "booqy-sound";
export const SOUND_VOLUME_KEY = "booqy-sound-volume";
export const BACKDROP_KEY = "booqy-backdrop";

export const STORAGE_REGISTRY: readonly StorageEntry[] = [
  {
    name: "CognitoIdentityServiceProvider.<client>.*",
    kind: "localStorage",
    purpose: "Your sign-in (access, ID and refresh token, last user, clock drift), set by AWS Amplify.",
    lifetime: "30 days, removed when you sign out",
  },
  {
    name: THEME_KEY,
    kind: "localStorage",
    purpose: "Your choice of light or dark mode (Settings). Set only when you press it; otherwise the console is light.",
    lifetime: "Until you clear the browser",
  },
  {
    name: SOUND_KEY,
    kind: "localStorage",
    purpose: "Your choice of click sound on or off (Settings). Sound is on until you switch it off; set only when you press it.",
    lifetime: "Until you clear the browser",
  },
  {
    name: SOUND_VOLUME_KEY,
    kind: "localStorage",
    purpose: "How loud the click sound is, 0-100 (Settings). Set only when you change it.",
    lifetime: "Until you clear the browser",
  },
  {
    name: BACKDROP_KEY,
    kind: "localStorage",
    purpose: "The picture you chose as the background behind the glass (Settings), shrunk. It never leaves this browser. Same key as in admin.",
    lifetime: "Until you remove the picture or clear the browser",
  },
];
