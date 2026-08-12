import { redirect } from "next/navigation";
import { AuthSignInPanel } from "@/components/auth-sign-in-panel";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { SiteShell } from "@/components/site-shell";
import { safeReturnTo } from "@/lib/auth-accounts";
import { authProviderAvailability } from "@/lib/auth-config";
import { getOptionalServerAuth } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string; reason?: string }>;
}) {
  const params = await searchParams;
  const returnTo = safeReturnTo(params.returnTo, "/account");
  const stepUp = params.reason === "fresh-auth-required";
  if (!stepUp && (await getOptionalServerAuth())) redirect(returnTo);
  const providers = authProviderAvailability();
  return (
    <SiteShell>
      <Breadcrumbs items={[{ label: "Sign in" }]} />
      <AuthSignInPanel returnTo={returnTo} stepUp={stepUp} providers={providers} />
    </SiteShell>
  );
}
