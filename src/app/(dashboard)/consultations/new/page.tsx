import { redirect } from "next/navigation";

export default function NewConsultationPage(): never {
  redirect("/dossiers/new");
}
