import { redirect } from "next/navigation";

export default function MfaPage() {
  redirect("/mfa/verify");
}
