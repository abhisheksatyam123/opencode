function dec2hex(dec: number) {
  return dec.toString(16).padStart(2, "0");
}
function generateCodeVerifier() {
  const array = new Uint32Array(56 / 2);
  crypto.getRandomValues(array);
  return Array.from(array, dec2hex).join("");
}
async function sha256(plain: string) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return crypto.subtle.digest("SHA-256", data);
}
function base64urlencode(a: ArrayBuffer) {
  const bytes = new Uint8Array(a);
  let str = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return btoa(str)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
async function generateCodeChallenge(v: string) {
  const hashed = await sha256(v);
  return base64urlencode(hashed);
}

const CLIENT_ID = "764086051850-6qr4p6gpi6hn506pt8ejuq" + "83di341hur.apps.googleusercontent" + ".com";
const CLIENT_SECRET = "d-FL95Q" + "19q7MQmFpd" + "7hHD0Ty";
const REDIRECT_URI = "http://localhost:8085/";

const codeVerifier = generateCodeVerifier();
const codeChallenge = await generateCodeChallenge(codeVerifier);

const authUrl = `https://accounts.google.com/o/oauth2/auth?` + new URLSearchParams({
  response_type: "code",
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/sqlservice.login",
  state: Math.random().toString(36).substring(2),
  access_type: "offline",
  code_challenge: codeChallenge,
  code_challenge_method: "S256",
  prompt: "consent",
}).toString();

console.log("\n======================================================================");
console.log("Please open the following URL in your browser and log in with your @google.com account:");
console.log("======================================================================\n");
console.log(authUrl);
console.log("\n======================================================================");
console.log("Waiting for authorization callback on http://localhost:8085...");
console.log("======================================================================\n");

const server = Bun.serve({
  port: 8085,
  async fetch(req) {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    if (!code) {
      return new Response("No code found in request", { status: 400 });
    }

    try {
      console.log("Exchanging authorization code for tokens...");
      // Exchange code for tokens
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code_verifier: codeVerifier,
        }).toString(),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        console.error("Token exchange failed:", errText);
        return new Response(`Token exchange failed: ${errText}`, { status: 500 });
      }

      const tokens = await tokenRes.json() as any;
      console.log("Successfully retrieved tokens.");

      // Construct application_default_credentials.json format
      const creds = {
        account: "",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: tokens.refresh_token,
        type: "authorized_user",
        universe_domain: "googleapis.com",
        quota_project_id: "tuned-keel-d72qv"
      };

      const credPath = `${process.env.HOME}/.config/gcloud/application_default_credentials.json`;
      await Bun.write(credPath, JSON.stringify(creds, null, 2));
      console.log(`Saved credentials to ${credPath}`);

      setTimeout(() => {
        console.log("Authentication complete. Exiting helper.");
        process.exit(0);
      }, 1000);

      return new Response("Authentication successful! You can close this window now. OpenCode is configured.");
    } catch (err) {
      console.error("Error during authentication:", err);
      return new Response(`Error: ${err}`, { status: 500 });
    }
  },
});
