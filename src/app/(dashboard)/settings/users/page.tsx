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
import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { formatDate } from "@/lib/utils";

const ROLE_LABEL: Record<string, string> = {
  bureau_admin: "Administrador",
  operator: "Operador",
};

interface UserRow {
  id: string;
  full_name: string;
  email: string;
  role: string;
  is_active: boolean;
  created_at: string;
  has_account: boolean;
}

export default async function UsersPage() {
  const session = await getRequiredSession().catch(() => redirect("/login"));
  if (!hasPermission(session, "users:manage")) {
    redirect("/settings");
  }

  const { rows } = await withUserTransaction(session, (client) =>
    client.query<UserRow>(
      `select id, full_name, email, role, is_active, created_at::text,
              exists (select 1 from account a where a.user_id = profiles.auth_user_id) as has_account
         from profiles
        where role in ('bureau_admin', 'operator') and not is_system
        order by created_at asc`,
    ),
  );
  const users = rows;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Equipe"
        description="Convide e gerencie operadores e administradores"
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Convidar membro</CardTitle>
        </CardHeader>
        <CardContent>
          <CreateUserForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            Membros da equipe ({users.length})
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
                    {!user.has_account ? (
                      <Badge variant="muted">Convite pendente</Badge>
                    ) : user.is_active ? (
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
                      role={user.role}
                      pendingInvite={!user.has_account}
                      disabled={user.id === session.userId}
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
                    Nenhum membro na equipe.
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
