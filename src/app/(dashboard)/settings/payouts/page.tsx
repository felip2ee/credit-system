import { redirect } from "next/navigation";

// Os repasses agora vivem na aba "A receber" da Carteira.
export default function PayoutsSettingsPage() {
  redirect("/settings/wallet?aba=receber");
}
