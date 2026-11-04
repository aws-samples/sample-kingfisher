export const dynamic = "force-dynamic";
import { homeRegionOrEmpty } from "@/lib/place/home-region";
import { apiOk } from "@/lib/api-response";

// PUBLIC (excluded from the auth middleware): returns the Cognito client config so the
// browser can build its user pool at runtime. These are public client identifiers (not
// secrets). Needed because NEXT_PUBLIC_* vars are inlined at build time, but the Docker
// build has no Cognito env — so the values must be delivered at runtime instead.
export async function GET() {
  const userPoolId = process.env.COGNITO_USER_POOL_ID || process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID || "";
  const clientId = process.env.COGNITO_CLIENT_ID || process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID || "";
  const region = userPoolId.split("_")[0] || homeRegionOrEmpty();
  return apiOk({ userPoolId, clientId, region });
}
