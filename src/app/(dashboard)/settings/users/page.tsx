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

function MemberStatus({ user }: { user: UserRow }) {
  if (!user.has_account) return <Badge variant="muted">Convite pendente</Badge>;
  return user.is_active ? <Badge variant="success">Ativo</Badge> : <Badge variant="muted">Inativo</Badge>;
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
          <CardTitle>Convidar membro</CardTitle>
        </CardHeader>
        <CardContent>
          <CreateUserForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Membros da equipe ({users.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {users.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Ninguém na equipe ainda. Use &ldquo;Convidar membro&rdquo; acima: informe nome, e-mail e perfil.
            </p>
          ) : (
            <>
              <ul className="divide-y divide-border md:hidden">
                {users.map((user) => (
                  <li key={user.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <p className="break-words font-bold">{user.full_name}</p>
                      <p className="break-all text-sm text-muted-foreground">{user.email}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{ROLE_LABEL[user.role] ?? user.role}</Badge>
                      <MemberStatus user={user} />
                    </div>
                    <p className="text-sm text-muted-foreground">Criado em {formatDate(user.created_at)}</p>
                    <UserRowActions
                      userId={user.id}
                      isActive={user.is_active}
                      role={user.role}
                      pendingInvite={!user.has_account}
                      disabled={user.id === session.userId}
                    />
                  </li>
                ))}
              </ul>
              <div className="hidden md:block">
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
                          <MemberStatus user={user} />
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
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
