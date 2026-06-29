import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { CreateUserForm } from "@/components/settings/create-user-form";
import { UserRowActions } from "@/components/settings/user-row-actions";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getCurrentProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/utils";

const ROLE_LABEL: Record<string, string> = {
  admin: "Administrador",
  consultant: "Consultor",
  client: "Cliente",
};

interface UserRow {
  id: string;
  full_name: string;
  email: string;
  role: string;
  is_active: boolean;
  created_at: string;
}

export default async function UsersPage() {
  const profile = await getCurrentProfile();
  if (profile?.role !== "admin") {
    redirect("/settings");
  }

  const supabase = createClient();
  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, email, role, is_active, created_at")
    .order("created_at", { ascending: true });

  const users = (data ?? []) as UserRow[];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Usuários"
        description="Crie e gerencie consultores e administradores"
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Novo usuário</CardTitle>
        </CardHeader>
        <CardContent>
          <CreateUserForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            Usuários cadastrados ({users.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>E-mail</TableHead>
                <TableHead>Perfil</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Criado em</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">{user.full_name}</TableCell>
                  <TableCell>{user.email}</TableCell>
                  <TableCell>{ROLE_LABEL[user.role] ?? user.role}</TableCell>
                  <TableCell>
                    {user.is_active ? (
                      <Badge variant="success">Ativo</Badge>
                    ) : (
                      <Badge variant="muted">Inativo</Badge>
                    )}
                  </TableCell>
                  <TableCell>{formatDate(user.created_at)}</TableCell>
                  <TableCell className="text-right">
                    <UserRowActions
                      userId={user.id}
                      isActive={user.is_active}
                      disabled={user.id === profile.id}
                    />
                  </TableCell>
                </TableRow>
              ))}
              {users.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center text-muted-foreground"
                  >
                    Nenhum usuário cadastrado.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
